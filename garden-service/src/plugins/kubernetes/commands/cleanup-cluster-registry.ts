/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import { PluginCommand } from "../../../types/plugin/command"
import { KubernetesPluginContext, KubernetesProvider } from "../config"
import { KubeApi } from "../api"
import { KubernetesPod, KubernetesDeployment, KubernetesResource } from "../types"
import { flatten, uniq, difference } from "lodash"
import { V1Container } from "@kubernetes/client-node"
import { queryRegistry } from "../container/util"
import { splitFirst, splitLast } from "../../../util/util"
import { LogEntry } from "../../../logger/log-entry"
import * as Bluebird from "bluebird"
import { CLUSTER_REGISTRY_DEPLOYMENT_NAME } from "../constants"
import { systemNamespace } from "../system"
import { PluginError } from "../../../exceptions"
import { apply } from "../kubectl"
import { waitForResources } from "../status/status"
import { execInDeployment } from "../container/run"
import { dedent } from "../../../util/string"
import { execInBuilder, getBuilderPodName } from "../container/build"

export const cleanupClusterRegistry: PluginCommand = {
  name: "cleanup-cluster-registry",
  description: "Clean up unused images in the in-cluster registry and cache.",

  handler: async ({ ctx, log }) => {
    const result = {}

    const k8sCtx = ctx as KubernetesPluginContext
    const provider = k8sCtx.provider

    if (provider.config.buildMode === "local-docker") {
      throw new PluginError(`Cannot run cluster cleanup with buildMode=local-docker`, {
        provider,
      })
    }

    const api = await KubeApi.factory(log, provider.config.context)

    // Scan through all Pods in cluster
    const imagesInUse = await getImagesInUse(api, provider, log)

    // Get images in registry
    const images = await getImagesInRegistry(k8sCtx, log)

    // Delete images no longer in use
    const diff = difference(images, imagesInUse)
    await deleteImagesFromRegistry(k8sCtx, log, diff)

    // Run garbage collection
    await runRegistryGarbageCollection(k8sCtx, api, log)

    if (provider.config.buildMode === "cluster-docker") {
      await deleteImagesFromDaemon(provider, log, imagesInUse)
    }

    log.info({ msg: chalk.green("\nDone!"), status: "success" })

    return { result }
  },
}

async function getImagesInUse(api: KubeApi, provider: KubernetesProvider, log: LogEntry) {
  log = log.info({ msg: chalk.white(`Scanning all Pods in the cluster...`), status: "active" })

  const pods: KubernetesPod[] = []
  let _continue: string | undefined

  while (true) {
    const page = await api.core.listPodForAllNamespaces(_continue)
    pods.push(...page.items)

    if (page.metadata._continue) {
      _continue = page.metadata._continue
    } else {
      break
    }
  }

  // Collect all image names
  const containers: V1Container[] = flatten(pods.map(p => p.spec.containers))
  const allImageNames = uniq(containers.map(c => c.image!))

  const registryPrefix = provider.config.deploymentRegistry!.hostname + "/"
  const registryImageNames = allImageNames
    .filter(name => name.startsWith(registryPrefix))
    // Remove the hostname part of the image name
    .map(name => splitFirst(name, "/")[1])

  log.info(
    `Found ${allImageNames.length} images in use in cluster, ` +
    `${registryImageNames.length} referencing the in-cluster registry.`,
  )
  log.setSuccess()

  return registryImageNames
}

async function getImagesInRegistry(ctx: KubernetesPluginContext, log: LogEntry) {
  log = log.info({
    msg: chalk.white(`Listing all images in cluster registry...`),
    status: "active",
  })

  const repositories: string[] = []
  let nextUrl = "_catalog"

  while (nextUrl) {
    const res = await queryRegistry(ctx, log, nextUrl)
    repositories.push(...res.data.repositories)

    // Paginate
    const linkHeader = res.headers["Link"]
    if (linkHeader) {
      nextUrl = linkHeader.match(/<(.*)>/)[1]
    } else {
      nextUrl = ""
    }
  }

  const images: string[] = []

  for (const repo of repositories) {
    nextUrl = `${repo}/tags/list`

    while (nextUrl) {
      const res = await queryRegistry(ctx, log, nextUrl)

      images.push(...res.data.tags.map((tag: string) => `${repo}:${tag}`))

      // Paginate
      const linkHeader = res.headers["link"]
      if (linkHeader) {
        nextUrl = linkHeader.match(/<(.*)>/)[1]
      } else {
        nextUrl = ""
      }
    }
  }

  log.info(`Found ${images.length} images in the registry.`)
  log.setSuccess()

  return images
}

async function deleteImagesFromRegistry(ctx: KubernetesPluginContext, log: LogEntry, images: string[]) {
  log = log.info({
    msg: chalk.white(`Flagging ${images.length} unused images as deleted in cluster registry...`),
    status: "active",
  })

  await Bluebird.map(images, async (image) => {
    // Get the digest for the image
    const [name, tag] = splitLast(image, ":")
    const res = await queryRegistry(
      ctx, log,
      `${name}/manifests/${tag}`,
      { method: "HEAD", headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" } },
    )
    const digest = res.headers["docker-content-digest"]

    // Issue the delete request
    await queryRegistry(ctx, log, `${name}/manifests/${digest}`, { method: "DELETE" })
  })

  log.info(`Flagged ${images.length} images as deleted in the registry.`)
  log.setSuccess()

  return images
}

async function runRegistryGarbageCollection(ctx: KubernetesPluginContext, api: KubeApi, log: LogEntry) {
  log = log.info({
    msg: chalk.white(`Running garbage collection in cluster registry...`),
    status: "active",
  })

  const provider = ctx.provider

  // Restart the registry in read-only mode
  // -> Get the original deployment
  log.info("Fetching original Deployment")

  let registryDeployment = await api.apps.readNamespacedDeployment(
    CLUSTER_REGISTRY_DEPLOYMENT_NAME, systemNamespace,
  )

  // -> Modify with read only env var and apply
  log.info("Re-starting in read-only mode...")

  const modifiedDeployment: KubernetesDeployment = sanitizeResource(registryDeployment)

  modifiedDeployment.spec.template.spec.containers[0].env.push({
    name: "REGISTRY_STORAGE_MAINTENANCE",
    // This needs to be YAML because of issue https://github.com/docker/distribution/issues/1736
    value: dedent`
      uploadpurging:
        enabled: false
      readonly:
        enabled: true
    `,
  })
  delete modifiedDeployment.status

  await apply({ log, context: provider.config.context, manifests: [modifiedDeployment], namespace: systemNamespace })

  // -> Wait for registry to be up again
  await waitForResources({ ctx, provider, log, serviceName: "docker-registry", resources: [modifiedDeployment] })

  // Run garbage collection
  log.info("Running garbage collection...")
  await execInDeployment({
    provider,
    log,
    namespace: systemNamespace,
    deploymentName: CLUSTER_REGISTRY_DEPLOYMENT_NAME,
    command: ["/bin/registry", "garbage-collect", "/etc/docker/registry/config.yml"],
    interactive: false,
  })

  // Restart the registry again as normal
  log.info("Restarting without read-only mode...")

  // -> Re-apply the original deployment
  registryDeployment = await api.apps.readNamespacedDeployment(
    CLUSTER_REGISTRY_DEPLOYMENT_NAME, systemNamespace,
  )
  const writableRegistry = sanitizeResource(registryDeployment)
  // -> Remove the maintenance flag
  writableRegistry.spec.template.spec.containers[0].env = writableRegistry.spec.template.spec.containers[0].env
    .filter(e => e.name !== "REGISTRY_STORAGE_MAINTENANCE")

  await apply({
    log,
    context: provider.config.context,
    manifests: [writableRegistry],
    namespace: systemNamespace,
  })

  // -> Wait for registry to be up again
  await waitForResources({ ctx, provider, log, serviceName: "docker-registry", resources: [modifiedDeployment] })

  log.info(`Completed registry garbage collection.`)
  log.setSuccess()
}

function sanitizeResource<T extends KubernetesResource>(resource: T): T {
  // Cloning and clearing out status + any undefined values
  const output = JSON.parse(JSON.stringify(resource))
  output.status && delete output.status
  return output
}

async function deleteImagesFromDaemon(provider: KubernetesProvider, log: LogEntry, imagesInUse: string[]) {
  log = log.info({
    msg: chalk.white(`Cleaning images from Docker daemon...`),
    status: "active",
  })

  log.info("Getting list of images from daemon...")
  const podName = await getBuilderPodName(provider, log)

  const listArgs = ["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"]
  const res = await execInBuilder({ provider, log, args: listArgs, podName, timeout: 300 })
  const imagesInDaemon = res.stdout
    .split("\n")
    .filter(Boolean)
    // Not sure why we see some of these
    .filter(i => !i.includes("<none>"))
    .map(i => i.trim())

  log.info(`${imagesInDaemon.length} tagged images in daemon.`)

  const host = provider.config.deploymentRegistry!.hostname
  const imagesWithHost = imagesInUse.map(name => `${host}/${name}`)
  const imagesToDelete = difference(imagesInDaemon, imagesWithHost)

  // Delete all the images
  if (imagesToDelete.length === 0) {
    log.info(`Nothing to clean up.`)
  } else {
    log.info(`Cleaning up ${imagesToDelete.length} images...`)
    const args = ["docker", "rmi", ...imagesToDelete]
    await execInBuilder({ provider, log, args, podName, timeout: 300 })
  }

  // Run a prune operation
  log.info(`Pruning with \`docker image prune -f\`...`)
  await execInBuilder({ provider, log, args: ["docker", "image", "prune", "-f"], podName, timeout: 300 })

  log.setSuccess()
}
