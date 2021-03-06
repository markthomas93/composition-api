import Vue from 'vue'
import { getCurrentInstance, onBeforeMount } from '@vue/composition-api'

import { globalContext, globalNuxt, isFullStatic } from './globals'
import type { NuxtApp } from '@nuxt/types/app'

type ComponentInstance = NonNullable<ReturnType<typeof getCurrentInstance>>

function normalizeError(err: any) {
  let message
  if (!(err.message || typeof err === 'string')) {
    try {
      message = JSON.stringify(err, null, 2)
    } catch (e) {
      message = `[${err.constructor.name}]`
    }
  } else {
    message = err.message || err
  }
  return {
    ...err,
    message,
    statusCode:
      err.statusCode ||
      err.status ||
      (err.response && err.response.status) ||
      500,
  }
}

interface Fetch {
  (context: ComponentInstance): void | Promise<void>
}

const fetches = new WeakMap<ComponentInstance, Fetch[]>()
const fetchPromises = new Map<Fetch, Promise<any>>()

const isSsrHydration = (vm: ComponentInstance) =>
  (vm.$vnode?.elm as any)?.dataset?.fetchKey
const nuxtState = process.client && (window as any)[globalContext]

interface AugmentedComponentInstance extends ComponentInstance {
  _fetchKey?: number
  _data?: any
  _hydrated?: boolean
  _fetchDelay?: number
  _fetchOnServer?: boolean
}

interface AugmentedNuxtApp extends NuxtApp {
  isPreview?: boolean
  _payloadFetchIndex?: number
  _pagePayload?: any
}

function registerCallback(vm: ComponentInstance, callback: Fetch) {
  const callbacks = fetches.get(vm) || []
  fetches.set(vm, [...callbacks, callback])
}

async function callFetches(this: AugmentedComponentInstance) {
  const fetchesToCall = fetches.get(this)
  if (!fetchesToCall) return
  ;(this[globalNuxt] as any).nbFetching++

  this.$fetchState.pending = true
  this.$fetchState.error = null
  this._hydrated = false

  let error = null
  const startTime = Date.now()

  try {
    await Promise.all(
      fetchesToCall.map(fetch => {
        if (fetchPromises.has(fetch)) return fetchPromises.get(fetch)
        const promise = Promise.resolve(fetch(this)).finally(() =>
          fetchPromises.delete(fetch)
        )
        fetchPromises.set(fetch, promise)
        return promise
      })
    )
  } catch (err) {
    error = normalizeError(err)
  }

  const delayLeft = (this._fetchDelay || 0) - (Date.now() - startTime)
  if (delayLeft > 0) {
    await new Promise(resolve => setTimeout(resolve, delayLeft))
  }

  this.$fetchState.error = error
  this.$fetchState.pending = false
  this.$fetchState.timestamp = Date.now()

  this.$nextTick(() => (this[globalNuxt] as any).nbFetching--)
}

const loadFullStatic = (vm: AugmentedComponentInstance) => {
  // Check if component has been fetched on server
  const { fetchOnServer } = vm.$options
  const fetchedOnServer =
    typeof fetchOnServer === 'function'
      ? fetchOnServer.call(vm) !== false
      : fetchOnServer !== false

  const nuxt = vm.$nuxt as AugmentedNuxtApp
  if (!fetchedOnServer || nuxt.isPreview || !nuxt._pagePayload) {
    return
  }
  vm._hydrated = true
  nuxt._payloadFetchIndex = (nuxt._payloadFetchIndex || 0) + 1
  vm._fetchKey = nuxt._payloadFetchIndex
  const data = nuxt._pagePayload.fetch[vm._fetchKey]

  // If fetch error
  if (data && data._error) {
    vm.$fetchState.error = data._error
    return
  }

  // Merge data
  for (const key in data) {
    Vue.set(vm.$data, key, data[key])
  }
}

/**
 * Versions of Nuxt newer than v2.12 support a [custom hook called `fetch`](https://nuxtjs.org/api/pages-fetch/) that allows server-side and client-side asynchronous data-fetching.

 * @param callback The async function you want to run.
 * @example

  ```ts
  import { defineComponent, ref, useFetch } from 'nuxt-composition-api'
  import axios from 'axios'

  export default defineComponent({
    setup() {
      const name = ref('')

      const { fetch, fetchState } = useFetch(async () => {
        name.value = await axios.get('https://myapi.com/name')
      })

      // Manually trigger a refetch
      fetch()

      // Access fetch error, pending and timestamp
      fetchState

      return { name }
    },
  })
  ```
 */
export const useFetch = (callback: Fetch) => {
  const vm = getCurrentInstance() as AugmentedComponentInstance | undefined
  if (!vm) throw new Error('This must be called within a setup function.')

  registerCallback(vm, callback)

  if (process.server) {
    vm.$options.fetch = callFetches.bind(vm)
    return
  }

  function result() {
    return {
      fetch: vm!.$fetch,
      fetchState: vm!.$fetchState,
      $fetch: vm!.$fetch,
      $fetchState: vm!.$fetchState,
    }
  }

  vm._fetchDelay =
    typeof vm.$options.fetchDelay === 'number' ? vm.$options.fetchDelay : 200

  vm.$fetchState =
    vm.$fetchState ||
    Vue.observable({
      error: null,
      pending: false,
      timestamp: 0,
    })

  vm.$fetch = callFetches.bind(vm)

  onBeforeMount(() => !vm._hydrated && callFetches.call(vm))

  if (!isSsrHydration(vm)) {
    if (isFullStatic) onBeforeMount(() => loadFullStatic(vm))
    return result()
  }

  // Hydrate component
  vm._hydrated = true
  vm._fetchKey = +(vm.$vnode.elm as any)?.dataset.fetchKey
  const data = nuxtState.fetch[vm._fetchKey]

  // If fetch error
  if (data && data._error) {
    vm.$fetchState.error = data._error
    return result()
  }

  onBeforeMount(() => {
    // Merge data
    for (const key in data) {
      try {
        if (key in vm && typeof vm[key as keyof typeof vm] === 'function') {
          continue
        }
        Vue.set(vm, key, data[key])
      } catch (e) {
        if (process.env.NODE_ENV === 'development')
          // eslint-disable-next-line
          console.warn(`Could not hydrate ${key}.`)
      }
    }
  })

  return result()
}
