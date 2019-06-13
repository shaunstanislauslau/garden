/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { useReducer } from "react"
import React from "react"
import produce from "immer"

import {
  fetchConfig,
  fetchLogs,
  fetchStatus,
  fetchGraph,
  FetchLogsParam,
  FetchTaskResultParam,
  FetchTestResultParam,
  fetchTaskResult,
  fetchTestResult,
} from "../api/api"
import { ServiceLogEntry } from "garden-cli/src/types/plugin/service/getServiceLogs"
import { ConfigDump } from "garden-cli/src/garden"
import { GraphOutput } from "garden-cli/src/commands/get/get-graph"
import { TaskResultOutput } from "garden-cli/src/commands/get/get-task-result"
import { StatusCommandResult, RunState } from "garden-cli/src/commands/get/get-status"
import { TestResultOutput } from "garden-cli/src/commands/get/get-test-result"
import { AxiosError } from "axios"
import { RenderedNode, ConfigGraph } from "garden-cli/src/config-graph"
import { SupportedEventName } from "./events"
import { ServiceState, ServiceIngress } from "garden-cli/src/types/service"
import { ModuleConfig, moduleConfigSchema } from "garden-cli/src/config/module"
import { Omit, PickFromUnion } from "garden-cli/src/util/util"
import { ServiceConfig } from "garden-cli/src/config/service"

interface StoreCommon {
  error?: AxiosError
  loading: boolean
}

export type EntityTaskState = PickFromUnion<
  SupportedEventName, "taskComplete" | "taskError" | "taskPending" | "taskProcessing"
>

export interface RenderedNodeWithStatus extends RenderedNode {
  status?: SupportedEventName
}
export interface GraphOutputWithNodeStatus extends GraphOutput {
  nodes: RenderedNodeWithStatus[],
}

export interface Entity {
  name: string
  state?: ServiceState | RunState
  isLoading: boolean
  dependencies: string[]
}

export interface Test extends Entity {
  startedAt?: Date
  completedAt?: Date
  duration?: string
  state?: RunState
}

export interface Task extends Entity {
  startedAt?: Date
  completedAt?: Date
  duration?: string
  state?: RunState
}

type ModuleEntity = Omit<Partial<ModuleConfig>, "serviceConfigs" | "testConfigs" | "taskConfigs"> & {
  services: string[],
  tasks: string[],
  tests: string[],
  taskNodeState?: EntityTaskState, // TODO Rename
}

interface ServiceEntity {
  config: ServiceConfig,
  state?: ServiceState,
  taskNodeState?: EntityTaskState,
}

interface RequestState {
  isLoading: boolean,
  error: AxiosError,
}

interface Store {
  data: {
    modules: { [id: string]: ModuleEntity }
    services: { [id: string]: ServiceEntity }
    tasks: { [id: string]: Task }
    tests: { [id: string]: Test }
    logs: { [id: string]: ServiceLogEntry[] }, // The id is the service name
  },
  requestState: {
    getConfig: RequestState
    getLogs: RequestState
    getStatus: RequestState,
  },
}

type Context = {
  store: Store;
  actions: Actions;
}

type RequestKeys = "fetchConfig" | "fetchLogs" | "fetchStatus"

interface ActionBase {
  requestKey: RequestKeys
  type: "fetchStart" | "fetchSuccess" | "fetchFailure"
}

interface ActionStart extends ActionBase {
  type: "fetchStart"
}

interface ActionSuccess extends ActionBase {
  type: "fetchSuccess"
  store: Store
}

interface ActionError extends ActionBase {
  type: "fetchFailure"
  error: AxiosError
}

type Action = ActionStart | ActionError | ActionSuccess

export type LoadLogs = (param: FetchLogsParam, force?: boolean) => void
export type LoadTaskResult = (param: FetchTaskResultParam, force?: boolean) => void
export type LoadTestResult = (param: FetchTestResultParam, force?: boolean) => void

type Loader = (force?: boolean) => void
interface Actions {
  loadLogs: LoadLogs
  loadConfig: Loader
  loadStatus: Loader
  loadGraph: Loader
  loadTaskResult: LoadTaskResult
  loadTestResult: LoadTestResult
}

/**
 * The reducer for the useApi hook. Sets the state for a given slice of the store on fetch events.
 */
function normalizedReducer(store: Store, action: Action) {
  switch (action.type) {
    case "fetchStart":
      return produce(store, storeDraft => {
        storeDraft.requestState[action.requestKey].isLoading = true
        return storeDraft
      })
    case "fetchSuccess":
      return produce(action.store, storeDraft => {
        storeDraft.requestState[action.requestKey].isLoading = false
        return storeDraft
      })
    // return updateSlice(store, action.key, { loading: false, data: action.data, error: undefined })
    case "fetchFailure":
      return {} as Store
    //   return updateSlice(store, action.key, { loading: false, error: action.error })
  }
}

const initialState: Store = {} as Store

function useNormalizedStore() {
  const [store, dispatch] = useReducer(normalizedReducer, initialState)

  const loadConfig: Loader = async (force: boolean = false) => {
    dispatch({ requestKey: "fetchConfig", type: "fetchStart" })

    const res = await fetchConfig()
    let modules = {}
    let services = {}
    for (const cfg of res.moduleConfigs) {
      const module: ModuleEntity = {
        name: cfg.name,
        type: cfg.type,
        path: cfg.path,
        repositoryUrl: cfg.repositoryUrl,
        description: cfg.description,
        services: cfg.serviceConfigs.map(service => service.name),
        tests: cfg.serviceConfigs.map(test => test.name),
        tasks: cfg.taskConfigs.map(task => task.name),
      }
      modules[cfg.name] = module
      for (const serviceConfig of cfg.serviceConfigs) {
        services[serviceConfig.name] = serviceConfig
      }
    }

    const newStore = produce(store, storeDraft => {
      storeDraft.data.modules = modules
      storeDraft.data.services = services
      return storeDraft
    })

    dispatch({ store: newStore, type: "fetchSuccess", requestKey: "fetchConfig" })
  }

  return {
    store,
    actions: {
      loadConfig,
    },
  }
}

// We type cast the initial value to avoid having to check whether the context exists in every context consumer.
// Context is only undefined if the provider is missing which we assume is not the case.
export const DataContext = React.createContext<Context>({} as Context)

/**
 * This component manages the "rest" API data state (not the websockets) for the entire application.
 * We use the new React Hooks API to pass store data and actions down the component tree.
 */
// export const DataProvider: React.FC = ({ children }) => {
//   const storeAndActions = useApi()
//   return (
//     <DataContext.Provider value={storeAndActions}>
//       {children}
//     </DataContext.Provider>
//   )
// }
