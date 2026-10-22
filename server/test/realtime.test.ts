// Ma trận Story 1.4 — kênh SSE `GET /api/v1/stream` và RealtimeHub (LISTEN realtime).
import { Writable } from 'node:stream'
import { ErrorResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import type { PgBoss } from 'pg-boss'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { SESSION_COOKIE } from '../src/app/auth/index.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import { createEventPublisher, type EventPublisher } from '../src/platform/events/index.ts'
import { createBoss } from '../src/platform/jobs/index.ts'
import { createLogger, type Logger } from '../src/platform/log/index.ts'
import { createRealtimeHub, type RealtimeHub } from '../src/platform/realtime/index.ts'
import { createSession, deleteSession } from '../src/modules/settings/index.ts'
import { sleep, waitFor } from './helpers/realtime.ts'

const APP_NAME = 'ottm-test-realtime'

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3, applicationName: APP_NAME })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-realtime-boss', { background: false })
  boss.on('error', () => {})
  await boss.start()
  events = createEventPublisher(boss)
})
afterAll(async () => {
  await boss.stop({ graceful: false })
  await handle.close()
})

function capture() {
  const lines: Record<string, unknown>[] = []
  const sink = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).trim().split('\n')) if (line) lines.push(JSON.parse(line) as Record<string, unknown>)
      cb()
    },
  })
  return { logger: createLogger({ level: 'info' }, sink), lines }
}

interface Stream {
  status: number
  headers: Headers
  text: () => string
  /** Các frame SSE đã nhận dạng `{event, data}`. */
  frames: () => { event: string; data: unknown }[]
  /** Server đã đóng stream. */
  ended: () => boolean
  close: () => void
}

async function openStream(base: string, token: string): Promise<Stream> {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/v1/stream`, { headers: { cookie: `${SESSION_COOKIE}=${token}` }, signal: controller.signal })
  let buf = ''
  let ended = false
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          ended = true
          break
        }
        buf += decoder.decode(value, { stream: true })
      }
    } catch {
      /* đóng */
    }
  })()
  const frames = () =>
    buf
      .split('\n\n')
      .filter((block) => block.includes('event: '))
      .map((block) => {
        const event = /^event: (.*)$/m.exec(block)![1]!
        const data = /^data: (.*)$/m.exec(block)?.[1]
        return { event, data: data === undefined ? undefined : (JSON.parse(data) as unknown) }
      })
  return { status: res.status, headers: res.headers, text: () => buf, frames, ended: () => ended, close: () => controller.abort() }
}

describe('GET /api/v1/stream', () => {
  let app: FastifyInstance
  let hub: RealtimeHub
  let base: string
  let streams: Stream[]
  let log: ReturnType<typeof capture>

  async function start(options: { pingIntervalMs?: number; probeIntervalMs?: number; logger?: Logger } = {}) {
    log = capture()
    const logger = options.logger ?? log.logger
    hub = createRealtimeHub({
      sql: handle.sql,
      log: logger,
      ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
      ...(options.probeIntervalMs ? { probeIntervalMs: options.probeIntervalMs, probeTimeoutMs: 300 } : {}),
    })
    await hub.start()
    app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), realtime: hub, events })
    base = await app.listen({ port: 0, host: '127.0.0.1' })
  }

  async function connect(token?: string): Promise<Stream> {
    token ??= (await createSession(handle.db)).token
    const s = await openStream(base, token)
    streams.push(s)
    await waitFor(() => s.frames().some((f) => f.event === 'ready'))
    return s
  }

  beforeEach(() => {
    streams = []
  })
  afterEach(async () => {
    for (const s of streams) s.close()
    await app?.close()
  })

  it('chưa đăng nhập → 401 JSON UNAUTHENTICATED', async () => {
    await start()
    const res = await app.inject({ method: 'GET', url: '/api/v1/stream' })
    expect(res.statusCode).toBe(401)
    expect(ErrorResponse.parse(res.json()).error.code).toBe('UNAUTHENTICATED')
    const bad = await app.inject({ method: 'GET', url: '/api/v1/stream', headers: { cookie: `${SESSION_COOKIE}=sai` } })
    expect(bad.statusCode).toBe(401)
  })

  it('có phiên → text/event-stream, X-Accel-Buffering: no, retry: 3000, event: ready đầu tiên', async () => {
    await start()
    const s = await connect()
    expect(s.status).toBe(200)
    expect(s.headers.get('content-type')).toMatch(/^text\/event-stream/)
    expect(s.headers.get('x-accel-buffering')).toBe('no')
    expect(s.headers.get('cache-control')).toMatch(/no-cache/)
    expect(s.text().startsWith('retry: 3000\n\nevent: ready\n')).toBe(true)
    expect(hub.clientCount).toBe(1)
  })

  it('sự kiện realtime đã commit → mọi SSE đang mở nhận event + data {type,entity,id,pageId} ≤ 3 giây', async () => {
    await start()
    const [a, b] = [await connect(), await connect()]
    const id = newId()
    const startedAt = Date.now()
    await handle.db.transaction((tx) =>
      events.publishEvent(tx, 'page.expiring', { id, pageId: id, expiresAt: '2026-11-01T00:00:00.000Z' }),
    )
    for (const s of [a, b]) {
      const frame = await waitFor(() => s.frames().find((f) => f.event === 'page.expiring'), 3_000)
      expect(frame.data).toEqual({ type: 'page.expiring', entity: 'page', id, pageId: id })
    }
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(a.text()).toContain(`event: page.expiring\ndata: {"type":"page.expiring","entity":"page","id":"${id}","pageId":"${id}"}\n\n`)
  })

  it('rollback → không SSE nào nhận', async () => {
    await start()
    const s = await connect()
    await handle.db
      .transaction(async (tx) => {
        await events.publishEvent(tx, 'page.expiring', { id: newId(), expiresAt: '2026-11-01T00:00:00.000Z' })
        throw new Error('rollback')
      })
      .catch(() => {})
    await sleep(300)
    expect(s.frames().map((f) => f.event)).toEqual(['ready'])
  })

  it('ping định kỳ (event: ping) để client biết kết nối còn sống', async () => {
    await start({ pingIntervalMs: 100 })
    const s = await connect()
    await waitFor(() => s.frames().filter((f) => f.event === 'ping').length >= 2, 2_000)
  })

  it('client đóng kết nối → hub gỡ client', async () => {
    await start()
    const s = await connect()
    expect(hub.clientCount).toBe(1)
    s.close()
    await waitFor(() => hub.clientCount === 0)
  })

  it('phiên bị xoá (đăng xuất) / hết hạn khi stream đang mở → server đóng stream ở nhịp ping kế', async () => {
    await start({ pingIntervalMs: 100 })
    const a = await createSession(handle.db)
    const b = await createSession(handle.db)
    const loggedOut = await connect(a.token)
    const expired = await connect(b.token)
    const alive = await connect()
    await deleteSession(handle.db, a.token)
    await handle.sql`update sessions set expires_at = now() - interval '1 second' where id = ${b.session.id}`
    await waitFor(() => loggedOut.ended() && expired.ended(), 3_000)
    await sleep(300)
    expect(alive.ended()).toBe(false)
    expect(hub.clientCount).toBe(1)
  })

  it('hub đã đóng → client mới bị đóng ngay (shutdown không treo)', async () => {
    await start()
    await hub.close()
    const res = { end: vi.fn(), on: vi.fn() }
    hub.addClient(res as never)
    expect(res.end).toHaveBeenCalledTimes(1)
    expect(hub.clientCount).toBe(0)
  })

  it('app.close() đóng các stream đang mở (không treo)', async () => {
    await start()
    await connect()
    await app.close()
    expect(hub.clientCount).toBe(0)
  })

  it('LISTEN rớt → hub tự nối lại, log warn, gửi resync; sự kiện sau đó vẫn tới client', async () => {
    await start()
    const s = await connect()
    const killed = await handle.sql<{ ok: boolean }[]>`
      select pg_terminate_backend(pid) as ok from pg_stat_activity
      where application_name = ${APP_NAME} and query ilike 'listen%' and pid <> pg_backend_pid()`
    expect(killed.length).toBe(1)
    await waitFor(() => s.frames().some((f) => f.event === 'resync'), 5_000)
    expect(log.lines).toContainEqual(expect.objectContaining({ level: 40, msg: 'LISTEN realtime đã nối lại — gửi resync cho client' }))
    const id = newId()
    await handle.db.transaction((tx) => events.publishEvent(tx, 'page.removed', { id, pageId: id }))
    await waitFor(() => s.frames().some((f) => f.event === 'page.removed'), 3_000)
    // Không nhân đôi do listener cũ còn sót.
    await sleep(200)
    expect(s.frames().filter((f) => f.event === 'page.removed')).toHaveLength(1)
  })

  it('gói dò không quay lại (LISTEN chết im lặng) → đăng ký LISTEN mới và resync', async () => {
    // Bọc sql: listener của lần đăng ký ĐẦU bị "điếc" theo cờ — như kết nối chết mà không ai báo.
    let deaf = false
    let calls = 0
    const sql = new Proxy(handle.sql, {
      get(target, prop) {
        if (prop !== 'listen') return Reflect.get(target, prop)
        return (channel: string, fn: (x: string) => void, onlisten?: () => void) => {
          const first = ++calls === 1
          return target.listen(channel, (x) => (first && deaf ? undefined : fn(x)), onlisten)
        }
      },
    })
    log = capture()
    hub = createRealtimeHub({ sql, log: log.logger, probeIntervalMs: 150, probeTimeoutMs: 300 })
    await hub.start()
    app = buildApp({ sql: handle.sql, db: handle.db, logger: createLogger({ level: 'silent' }), realtime: hub, events })
    base = await app.listen({ port: 0, host: '127.0.0.1' })
    const s = await connect()
    deaf = true
    await waitFor(() => s.frames().some((f) => f.event === 'resync'), 5_000)
    expect(calls).toBe(2)
    expect(log.lines).toContainEqual(expect.objectContaining({ level: 40, msg: 'LISTEN realtime không nhận gói dò — đăng ký lại' }))
    deaf = false // listener cũ (nếu còn) bị gỡ hoặc bỏ qua theo generation — không phát trùng
    const id = newId()
    await handle.db.transaction((tx) => events.publishEvent(tx, 'page.removed', { id, pageId: id }))
    await waitFor(() => s.frames().some((f) => f.event === 'page.removed'), 3_000)
    await sleep(200)
    expect(s.frames().filter((f) => f.event === 'page.removed')).toHaveLength(1)
  })
})
