/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { useReducer, useEffect } from "react"
import React from "react"
import { groupBy } from "lodash"
import produce from "immer"

import {
  fetchConfig,
  FetchLogsParam,
  FetchTaskResultParam,
  FetchTestResultParam,
  fetchLogs,
  fetchStatus,
} from "../api/api"
import { ServiceLogEntry } from "garden-cli/src/types/plugin/service/getServiceLogs"
import { GraphOutput } from "garden-cli/src/commands/get/get-graph"
import { AxiosError } from "axios"
import { SupportedEventName } from "./events"
import { ServiceStatus } from "garden-cli/src/types/service"
import { ModuleConfig } from "garden-cli/src/config/module"
import { Omit, PickFromUnion } from "garden-cli/src/util/util"
import { ServiceConfig } from "garden-cli/src/config/service"
import { RunStatus, StatusCommandResult } from "garden-cli/src/commands/get/get-status"
import { ConfigDump } from "garden-cli/src/garden"
import { TaskConfig } from "garden-cli/src/config/task"
import { TaskResultOutput } from "garden-cli/src/commands/get/get-task-result"
import { TestResultOutput } from "garden-cli/src/commands/get/get-test-result"
import { TestConfig } from "garden-cli/src/config/test"

export type TaskState = PickFromUnion<
  SupportedEventName, "taskComplete" | "taskError" | "taskPending" | "taskProcessing"
>

export interface TestEntity {
  config: TestConfig,
  status: RunStatus,
  result: TestResultOutput,
  taskState: TaskState,
}

export interface TaskEntity {
  config: TaskConfig,
  status: RunStatus,
  result: TaskResultOutput,
  taskState: TaskState,
}

export type ModuleEntity = Omit<Partial<ModuleConfig>, "serviceConfigs" | "testConfigs" | "taskConfigs"> & {
  services: string[],
  tasks: string[],
  tests: string[],
  taskState: TaskState,
}

export interface ServiceEntity {
  config: ServiceConfig,
  status: ServiceStatus,
  taskState: TaskState,
}

interface RequestState {
  loading: boolean,
  error?: AxiosError,
}

interface Store {
  projectRoot?: string,
  entities: {
    modules?: { [moduleName: string]: ModuleEntity }
    services?: { [serviceName: string]: ServiceEntity }
    tasks?: { [taskId: string]: TaskEntity }
    tests?: { [serviceId: string]: TestEntity }
    logs?: { [serviceName: string]: ServiceLogEntry[] }
    wstest?: any
    graph?: GraphOutput,
  },
  // TODO: Add all the requests
  requestStates: {
    fetchConfig: RequestState
    fetchStatus: RequestState
    fetchGraph: RequestState,
    fetchLogs: RequestState,
  },
}

type Context = {
  store: Store;
  actions: Actions;
}

type RequestKey = keyof Store["requestStates"]
const requestKeys: RequestKey[] = [
  "fetchConfig",
  "fetchStatus",
  "fetchLogs",
  "fetchGraph",
  "fetchStatus",
]

interface ActionBase {
  type: "fetchStart" | "fetchSuccess" | "fetchFailure" | "wsMessageReceived"
}

interface ActionStart extends ActionBase {
  requestKey: RequestKey
  type: "fetchStart"
}

interface ActionSuccess extends ActionBase {
  requestKey: RequestKey
  type: "fetchSuccess"
  store: Store
}

interface ActionError extends ActionBase {
  requestKey: RequestKey
  type: "fetchFailure"
  error: AxiosError
}

interface WsMessageReceived extends ActionBase {
  type: "wsMessageReceived"
}

type Action = ActionStart | ActionError | ActionSuccess | WsMessageReceived

export type LoadLogs = (param: FetchLogsParam, force?: boolean) => void
export type LoadTaskResult = (param: FetchTaskResultParam, force?: boolean) => void
export type LoadTestResult = (param: FetchTestResultParam, force?: boolean) => void

type Loader = (force?: boolean) => void
interface Actions {
  loadLogs: LoadLogs
  loadConfig: Loader
  loadStatus: Loader
}

const initialRequestState = requestKeys.reduce((acc, key) => {
  acc[key] = { loading: false }
  return acc
}, {} as { [K in RequestKey]: RequestState })

const initialState: Store = {
  entities: {},
  requestStates: initialRequestState,
}

/**
 * The reducer for the useApi hook. Sets the state for a given slice of the store on fetch events.
 */
function reducer(store: Store, action: Action): Store {
  switch (action.type) {
    case "fetchStart":
      return produce(store, storeDraft => {
        storeDraft.requestStates[action.requestKey].loading = true
      })
    case "fetchSuccess":
      return produce(action.store, storeDraft => {
        storeDraft.requestStates[action.requestKey].loading = false
      })
    case "fetchFailure":
      return produce(store, storeDraft => {
        storeDraft.requestStates[action.requestKey].loading = false
        storeDraft.requestStates[action.requestKey].error = action.error
      })
    case "wsMessageReceived":
      // Note: We have to do the processing here instead of passing the store as in the cases above.
      // This is because the ws functionality is wrapped in a useEffect() call and therefore will have
      // a stale version of the store available when it is actually called.
      //
      // We could consider to never pass the store in action.store but rather pass the processor function.
      // Something like: action.processer = processLogs. Then the reducer would call that with they response.
      // Something like: newStore = action.processor(action.res) or similiar. Not sure what's most clean.
      return produce(store, storeDraft => {
        // Here we're just updating the state with some pseudo value for testing purposes.
        if (storeDraft.entities.services) {
          const firstService = Object.keys(storeDraft.entities.services)[0]
          storeDraft.entities.services[firstService] =
            storeDraft.entities.services[firstService] || { status: { state: "deploying" } }
        }
        // if (storeDraft.entities.logs) {
        //   const firstLog = Object.keys(storeDraft.entities.logs)[0]
        //   storeDraft.entities.logs[firstLog] = []
        // }
      })
  }
}

// Process the get-config response and return a normalized store
function processConfig(store: Store, config: ConfigDump) {
  let modules = {}
  let services = {}
  for (const cfg of config.moduleConfigs) {
    const currentModule = store.entities.modules && store.entities.modules[cfg.name]
    const module: ModuleEntity = {
      name: cfg.name,
      type: cfg.type,
      path: cfg.path,
      repositoryUrl: cfg.repositoryUrl,
      description: cfg.description,
      services: cfg.serviceConfigs.map(service => service.name),
      tests: cfg.testConfigs.map(test => test.name),
      tasks: cfg.taskConfigs.map(task => task.name),
      taskState: currentModule && currentModule.taskState || "taskPending",
    }
    modules[cfg.name] = module
    for (const serviceConfig of cfg.serviceConfigs) {
      services[serviceConfig.name] = services[serviceConfig.name] || {}
      services[serviceConfig.name].config = serviceConfig
    }
  }

  return produce(store, storeDraft => {
    storeDraft.entities.modules = modules
    storeDraft.entities.services = services
    storeDraft.projectRoot = config.projectRoot
    return storeDraft
  })
}

// Process the logs response and return a normalized store
function processLogs(store: Store, logs: ServiceLogEntry[]) {
  return produce(store, storeDraft => {
    storeDraft.entities.logs = groupBy(logs, "serviceName")
  })
}

// Process the status response and return a normalized store
function processStatus(store: Store, status: StatusCommandResult) {
  debugger
  return produce(store, storeDraft => {
    storeDraft.entities.services = storeDraft.entities.services || {}
    storeDraft.entities.tests = storeDraft.entities.tests || {}
    storeDraft.entities.tasks = storeDraft.entities.tasks || {}
    
    for (const serviceName of Object.keys(status.services)) {
      storeDraft.entities.services[serviceName].status =
        status.services[serviceName]
    }
    for (const testName of Object.keys(status.tests)) {
      storeDraft.entities.tests[testName].status =
        status.tests[testName]
    }
    for (const taskName of Object.keys(status.tasks)) {
      storeDraft.entities.tasks[taskName].status =
        status.tasks[taskName]
    }
  })
}

export async function sleep(msec) {
  return new Promise(resolve => setTimeout(resolve, msec))
}

/**
 * This is an example of what the useApi hook could look like. It contains all the loader
 * functions as before and the ws connection. We could perhaps refactor this so that the functions bodies
 * are not inside the hook. In that case we'd need to pass the store and dispatch to the outer function.
 *
 * We could also consider having the ws logic in another hook. We'd also need to pass the store and
 * dispatch to that hook.
 */
function useApi(store: Store, dispatch: React.Dispatch<Action>) {
  const loadConfig: Loader = async (force: boolean = false) => {
    if (!force && store.entities.modules) {
      return
    }

    const requestKey = "fetchConfig"
    dispatch({ requestKey, type: "fetchStart" })

    let res: ConfigDump
    try {
      res = await fetchConfig()
    } catch (error) {
      dispatch({ requestKey, type: "fetchFailure", error })
      return
    }

    dispatch({ store: processConfig(store, res), type: "fetchSuccess", requestKey })
  }

  const loadLogs = async (serviceNames: string[], force: boolean = false) => {
    if (!force && store.entities.logs) {
      return
    }

    const requestKey = "fetchLogs"
    dispatch({ requestKey, type: "fetchStart" })

    let res: ServiceLogEntry[]
    try {
      res = await fetchLogs(serviceNames)
    } catch (error) {
      dispatch({ requestKey, type: "fetchFailure", error })
      return
    }

    dispatch({ store: processLogs(store, res), type: "fetchSuccess", requestKey })
  }

  const loadStatus = async (force: boolean = false) => {
    if (!force && store.entities.logs) {
      return
    }

    const requestKey = "fetchStatus"
    dispatch({ requestKey, type: "fetchStart" })

    let res: StatusCommandResult
    try {
      res = await fetchStatus()
    } catch (error) {
      dispatch({ requestKey, type: "fetchFailure", error })
      return
    }

    dispatch({ store: processStatus(store, res), type: "fetchSuccess", requestKey })
  }

  // For setting up the ws connection
  useEffect(() => {
    // This is just test code, replace with actual ws connection
    (async () => {
      setInterval(() => dispatch({ type: "wsMessageReceived" }), 5000)
    })().catch(() => { })
  }, [])

  return {
    store,
    actions: {
      loadConfig,
      loadStatus,
      loadLogs,
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
export const DataProvider: React.FC = ({ children }) => {
  const [store, dispatch] = useReducer(reducer, initialState)

  const storeAndActions = useApi(store, dispatch)
  console.log("data-normalized", storeAndActions)
  return (
    <DataContext.Provider value={storeAndActions}>
      {children}
    </DataContext.Provider>
  )
}
