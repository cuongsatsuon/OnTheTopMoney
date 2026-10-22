// modules/connections — store `meta_rate_state` (upsert + chặn ghi đè bằng bản cũ hơn) và `createMetaClients`
// dựng client từ cấu hình (phiên bản pin, appsecret_proof, Threads chỉ khi cấu hình đủ).
import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { FAKE_CODE, FAKE_THREADS_CODE, createMetaClients, createRateStore } from '../src/modules/connections/index.ts'
import { FAKE_APP_ID, FAKE_APP_SECRET, FAKE_THREADS_APP_ID, FAKE_THREADS_APP_SECRET } from '../src/modules/connections/fake-meta.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'

let handle: DbHandle
const T0 = new Date('2026-10-22T03:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

beforeAll(() => {
  handle = createDb(inject('databaseUrl'), { max: 2 })
})
afterAll(async () => {
  await handle.close()
})
beforeEach(async () => {
  await handle.sql`delete from meta_rate_state`
})

describe('createRateStore (DB)', () => {
  it('upsert theo (scope, bucket): bản mới hơn ghi đè (kể cả blockedUntil), bản cũ hơn bị bỏ qua', async () => {
    const store = createRateStore(handle.db)
    await store.record('page:1', { bucket: 'buc', usagePct: 10, blockedUntil: null, updatedAt: T0 })
    expect(await store.get('page:1')).toEqual([{ bucket: 'buc', usagePct: 10, blockedUntil: null, updatedAt: T0 }])

    await store.record('page:1', { bucket: 'buc', usagePct: 95, blockedUntil: at(60_000), updatedAt: at(1000) })
    expect(await store.get('page:1')).toEqual([{ bucket: 'buc', usagePct: 95, blockedUntil: at(60_000), updatedAt: at(1000) }])

    await store.record('page:1', { bucket: 'buc', usagePct: 5, blockedUntil: null, updatedAt: at(-1000) })
    expect(await store.get('page:1')).toEqual([{ bucket: 'buc', usagePct: 95, blockedUntil: at(60_000), updatedAt: at(1000) }])

    // Bucket / scope khác là dòng riêng.
    await store.record('page:1', { bucket: 'blocked', usagePct: 100, blockedUntil: at(5000), updatedAt: T0 })
    await store.record('page:2', { bucket: 'buc', usagePct: 1, blockedUntil: null, updatedAt: T0 })
    expect((await store.get('page:1')).map((r) => r.bucket).sort()).toEqual(['blocked', 'buc'])
    expect(await store.get('page:3')).toEqual([])
  })
})

describe('createMetaClients', () => {
  const TOKEN = 'EAAB-S3CR3T'
  const urls: URL[] = []
  const fakeFetch = (async (input: string | URL | Request) => {
    urls.push(new URL(String(input)))
    return new Response('{"id":"1"}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  beforeEach(() => {
    urls.length = 0
  })

  it('graph pin META_GRAPH_VERSION và ký appsecret_proof bằng META_APP_SECRET; chưa cấu hình Threads → không có threads', async () => {
    const clients = createMetaClients({
      config: { META_GRAPH_VERSION: 'v27.0', META_APP_SECRET: 'meta-secret' },
      db: handle.db,
      fetch: fakeFetch,
    })
    expect(clients.threads).toBeUndefined()
    expect(clients.graph.baseUrl).toBe('https://graph.facebook.com/v27.0')
    expect(await clients.graph.get('/me', { token: TOKEN, tier: 'interactive', scope: 'page:1' })).toEqual({ ok: true, data: { id: '1' } })
    expect(urls[0]?.origin + urls[0]!.pathname).toBe('https://graph.facebook.com/v27.0/me')
    expect(urls[0]?.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', 'meta-secret').update(TOKEN).digest('hex'))
  })

  it('Threads cấu hình đủ → client threads ký bằng THREADS_APP_SECRET; dùng chung store meta_rate_state', async () => {
    const clients = createMetaClients({
      config: { META_GRAPH_VERSION: 'v26.0', THREADS_APP_ID: '42', THREADS_APP_SECRET: 'threads-secret' },
      db: handle.db,
      fetch: async (input) => {
        urls.push(new URL(String(input)))
        return new Response('{}', { status: 200, headers: { 'x-app-usage': '{"call_count":12}' } })
      },
    })
    expect(clients.threads?.baseUrl).toBe('https://graph.threads.com/v1.0')
    await clients.threads!.get('/me', { token: TOKEN, tier: 'interactive', scope: 'threads:1' })
    expect(urls[0]?.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', 'threads-secret').update(TOKEN).digest('hex'))
    // Graph không có META_APP_SECRET → không gửi proof.
    await clients.graph.get('/me', { token: TOKEN, tier: 'interactive', scope: 'page:1' })
    expect(urls[1]?.searchParams.has('appsecret_proof')).toBe(false)
    const rows = await handle.sql<{ scope: string }[]>`select scope from meta_rate_state order by scope`
    expect(rows.map((r) => r.scope)).toEqual(['app:graph', 'app:threads'])
  })

  it('META_FAKE → graph và Threads là bản giả: đổi code giả thành token, không gọi mạng', async () => {
    let fetched = 0
    const clients = createMetaClients({
      config: { META_GRAPH_VERSION: 'v26.0', META_FAKE: true, THREADS_APP_ID: '42', THREADS_APP_SECRET: 'threads-secret' },
      db: handle.db,
      fetch: (async () => {
        fetched += 1
        return new Response('{}')
      }) as typeof fetch,
    })
    expect(clients.threads).toBeDefined()
    const th = await clients.threads!.post<{ access_token: string }>('/oauth/access_token', {
      tier: 'interactive',
      scope: 'oauth:threads',
      unversioned: true,
      form: { client_id: FAKE_THREADS_APP_ID, client_secret: FAKE_THREADS_APP_SECRET, grant_type: 'authorization_code', code: FAKE_THREADS_CODE.full },
    })
    expect(th.ok && th.data.access_token).toMatch(/^FAKE_TH_SHORT_full_/)
    const res = await clients.graph.get<{ access_token: string }>('/oauth/access_token', {
      tier: 'interactive',
      scope: 'oauth:facebook',
      params: { client_id: FAKE_APP_ID, client_secret: FAKE_APP_SECRET, code: FAKE_CODE.full },
    })
    expect(res.ok && res.data.access_token).toMatch(/^FAKE_SHORT_full_/)
    expect(fetched).toBe(0)
    expect(await handle.sql`select 1 from meta_rate_state`).toHaveLength(0)
  })
})
