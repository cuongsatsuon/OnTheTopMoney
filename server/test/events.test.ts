// Ma trận Story 1.4 — đường phát sự kiện (platform/events): publish trong transaction + NOTIFY khi commit.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { REALTIME_HINT_MAX_BYTES, realtimeHint } from '@ottm/shared'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { ZodError } from 'zod'
import { assertBossDbSupported, createDb, newId, type Db, type DbHandle } from '../src/platform/db/index.ts'
import {
  RealtimeHintTooLargeError,
  createEventPublisher,
  isEventEnvelope,
  parseEventEnvelope,
  type EventPublisher,
} from '../src/platform/events/index.ts'
import { BOSS_SCHEMA, createBoss, ensureQueues } from '../src/platform/jobs/index.ts'
import { listenRealtime, sleep, waitFor } from './helpers/realtime.ts'

const SINK = 'testonly.event_sink'

let handle: DbHandle
let boss: PgBoss
let events: EventPublisher
let realtime: Awaited<ReturnType<typeof listenRealtime>>

beforeAll(async () => {
  handle = createDb(inject('databaseUrl'), { max: 3 })
  boss = createBoss(inject('databaseUrl'), 'ottm-test-events', { background: false })
  boss.on('error', () => {})
  await boss.start()
  await ensureQueues(boss)
  await boss.createQueue(SINK)
  for (const e of ['page.expiring', 'job.failed', 'conversation.state_changed']) await boss.subscribe(e, SINK)
  events = createEventPublisher(boss)
  realtime = await listenRealtime(handle.sql)
})
afterAll(async () => {
  await realtime.stop()
  for (const e of ['page.expiring', 'job.failed', 'conversation.state_changed']) await boss.unsubscribe(e, SINK)
  await boss.deleteQueue(SINK)
  // Job do các test này sinh ở queue thật (events.notifications) — không để worker test khác nhận.
  await boss.deleteAllJobs('events.notifications')
  await boss.stop({ graceful: false })
  await handle.close()
})
beforeEach(async () => {
  await boss.deleteAllJobs(SINK)
  realtime.messages.length = 0
})
async function sinkJobs(): Promise<unknown[]> {
  const rows = await handle.sql.unsafe<{ data: unknown }[]>(`select data from ${BOSS_SCHEMA}.job where name = $1`, [SINK])
  return rows.map((r) => r.data)
}

describe('publishEvent', () => {
  it('sự kiện realtime + commit → NOTIFY {type,entity,id,pageId} (không mang nội dung) và job cho subscriber', async () => {
    const id = newId()
    const payload = { id, pageId: id, expiresAt: '2026-11-01T00:00:00.000Z' }
    await handle.db.transaction(async (tx) => {
      await events.publishEvent(tx, 'page.expiring', payload)
    })
    const [msg] = await waitFor(() => (realtime.messages.length ? realtime.messages : null))
    expect(msg).toEqual({ type: 'page.expiring', entity: 'page', id, pageId: id })
    expect(msg).toEqual(realtimeHint('page.expiring', payload))

    const jobs = await sinkJobs()
    expect(jobs).toEqual([{ event: 'page.expiring', payload }])
    expect(isEventEnvelope(jobs[0])).toBe(true)
    expect(parseEventEnvelope(jobs[0])).toEqual({ event: 'page.expiring', payload })
  })

  it('NOTIFY chỉ tới khi commit, không tới lúc transaction còn mở', async () => {
    const id = newId()
    await handle.db.transaction(async (tx) => {
      await events.publishEvent(tx, 'page.expiring', { id, expiresAt: '2026-11-01T00:00:00.000Z' })
      await sleep(300)
      expect(realtime.messages).toEqual([])
    })
    await waitFor(() => realtime.messages.length === 1)
    expect(realtime.messages[0]).toEqual({ type: 'page.expiring', entity: 'page', id })
  })

  it('transaction rollback → không NOTIFY, không job', async () => {
    const rollback = new Error('rollback')
    await expect(
      handle.db.transaction(async (tx) => {
        await events.publishEvent(tx, 'page.expiring', { id: newId(), expiresAt: '2026-11-01T00:00:00.000Z' })
        throw rollback
      }),
    ).rejects.toBe(rollback)
    await sleep(300)
    expect(realtime.messages).toEqual([])
    expect(await sinkJobs()).toEqual([])
  })

  it('sự kiện không realtime (job.failed) → không NOTIFY, consumer queue vẫn nhận', async () => {
    const jobId = newId()
    await handle.db.transaction((tx) => events.publishEvent(tx, 'job.failed', { id: jobId, queue: 'x.y', jobId }))
    expect(await waitFor(async () => ((await sinkJobs()).length ? sinkJobs() : null))).toEqual([
      { event: 'job.failed', payload: { id: jobId, queue: 'x.y', jobId } },
    ])
    await sleep(200)
    expect(realtime.messages).toEqual([])
  })

  it(`payload realtime > ${REALTIME_HINT_MAX_BYTES} byte → từ chối khi phát, không ghi gì`, async () => {
    const huge = 'x'.repeat(REALTIME_HINT_MAX_BYTES)
    await expect(
      handle.db.transaction((tx) => events.publishEvent(tx, 'page.expiring', { id: huge, expiresAt: '2026-11-01T00:00:00.000Z' })),
    ).rejects.toBeInstanceOf(RealtimeHintTooLargeError)
    await sleep(200)
    expect(realtime.messages).toEqual([])
    expect(await sinkJobs()).toEqual([])
  })

  it('payload sai schema → ZodError, không ghi gì', async () => {
    await expect(
      handle.db.transaction((tx) =>
        events.publishEvent(tx, 'conversation.state_changed', { id: newId(), to: 'handoff' } as never),
      ),
    ).rejects.toBeInstanceOf(ZodError)
    expect(await sinkJobs()).toEqual([])
  })

  it('tên ngoài danh mục → từ chối', async () => {
    await expect(handle.db.transaction((tx) => events.publishEvent(tx, 'nope.happened' as never, { id: 'a' } as never))).rejects.toThrow(
      /không có trong/,
    )
  })
})

describe('npm run emit-event (dev)', () => {
  const serverDir = fileURLToPath(new URL('..', import.meta.url))
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('npm', ['run', '--silent', 'emit-event', '--', ...args], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: inject('databaseUrl'), NODE_ENV: 'test', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    })

  it('phát sự kiện trong danh mục qua publishEvent (NOTIFY + job), tự sinh id khi thiếu', async () => {
    const res = run(['conversation.state_changed', JSON.stringify({ pageId: 'p1', from: 'ai', to: 'handoff', reasonCode: 'KEYWORD' })])
    expect(res.status).toBe(0)
    const msg = await waitFor(() => realtime.messages.find((m) => m.type === 'conversation.state_changed'))
    expect(msg).toMatchObject({ entity: 'conversation', pageId: 'p1' })
    expect(typeof msg.id).toBe('string')
    expect(await sinkJobs()).toHaveLength(1)
  })

  it('sự kiện lạ / payload sai → exit ≠ 0, không phát', async () => {
    expect(run(['nope.happened', '{}']).status).not.toBe(0)
    const bad = run(['conversation.state_changed', '{"to":"handoff"}'])
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toContain('Payload sai')
    expect(await sinkJobs()).toEqual([])
  })

  it('NODE_ENV=production → bị chặn', () => {
    const res = run(['page.removed', '{}'], { NODE_ENV: 'production' })
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('production')
  })
})

describe('assertBossDbSupported (kiểm lúc khởi động api/worker)', () => {
  it('Drizzle postgres-js thật → qua', async () => {
    await expect(assertBossDbSupported(handle.db)).resolves.toBeUndefined()
  })

  it('transaction không lộ client postgres.js (vd Drizzle đổi cấu trúc) → ném lỗi ngay', async () => {
    const fake = { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ _: { session: {} } }) } as unknown as Db
    await expect(assertBossDbSupported(fake)).rejects.toThrow(/không phải Drizzle postgres-js/)
  })
})
