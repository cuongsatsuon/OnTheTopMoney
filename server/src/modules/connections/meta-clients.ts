// Dựng client Meta từ cấu hình (AD-6): Graph pin `META_GRAPH_VERSION`, ký `appsecret_proof` bằng `META_APP_SECRET`;
// Threads chỉ khi đã đặt cặp `THREADS_APP_ID`/`THREADS_APP_SECRET`. Cả hai dùng chung store `meta_rate_state`
// (mỗi client một scope app riêng). Chỉ `connections` dựng client; module khác nhận client qua deps.
// `META_FAKE=1` → Graph và Threads đều là fake (`fake-meta.ts`, qua `adapters/meta/fake.ts`), không gọi mạng.
import { createGraphClient, createThreadsClient, type MetaClient, type MetaLogger } from '../../adapters/meta/index.ts'
import type { Config } from '../../platform/config/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'
import { createFakeMetaGraph, createFakeThreads } from './fake-meta.ts'
import { createRateStore } from './rate-store.ts'

export type MetaClientsConfig = Pick<Config, 'META_GRAPH_VERSION' | 'META_APP_SECRET' | 'THREADS_APP_ID' | 'THREADS_APP_SECRET'> &
  Partial<Pick<Config, 'META_FAKE'>>

export interface MetaClients {
  graph: MetaClient
  /** `undefined` khi chưa cấu hình Threads app. */
  threads?: MetaClient
}

export interface CreateMetaClientsDeps {
  config: MetaClientsConfig
  db: DbExecutor
  log?: MetaLogger
  /** Test: trỏ về server giả / fetch giả. */
  baseUrls?: { graph?: string; threads?: string }
  fetch?: typeof fetch
  now?: () => Date
}

export function createMetaClients(deps: CreateMetaClientsDeps): MetaClients {
  // Dev `META_FAKE=1` (config cấm ở production): Graph + Threads giả cho luồng OAuth, không gọi mạng.
  if (deps.config.META_FAKE) return { graph: createFakeMetaGraph(deps.now), threads: createFakeThreads(deps.now) }
  const rateStore = createRateStore(deps.db)
  const common = { rateStore, log: deps.log, fetch: deps.fetch, now: deps.now }
  const graph = createGraphClient({
    ...common,
    baseUrl: deps.baseUrls?.graph,
    version: deps.config.META_GRAPH_VERSION,
    appSecret: deps.config.META_APP_SECRET,
  })
  const { THREADS_APP_ID, THREADS_APP_SECRET } = deps.config
  const threads =
    THREADS_APP_ID && THREADS_APP_SECRET
      ? createThreadsClient({ ...common, baseUrl: deps.baseUrls?.threads, appSecret: THREADS_APP_SECRET })
      : undefined
  return threads ? { graph, threads } : { graph }
}
