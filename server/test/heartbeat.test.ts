import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import type { PgBoss } from 'pg-boss'
import { checkHealth } from '../src/app/healthz.ts'
import { createDb, newId, type DbHandle } from '../src/platform/db/index.ts'
import { startWorkers, type QueueRegistry } from '../src/platform/jobs/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { writeHeartbeat } from '../src/worker/heartbeat.ts'

describe('worker heartbeat', () => {
  let handle: DbHandle

  beforeAll(() => {
    handle = createDb(inject('databaseUrl'), { max: 2 })
  })
  afterAll(async () => {
    await handle.close()
  })
  beforeEach(async () => {
    await handle.sql`delete from worker_heartbeats`
  })

  it('upsert một dòng theo id phiên chạy, beat_at tiến lên; dọn dòng cũ > 1 ngày; healthz ok', async () => {
    await handle.sql`insert into worker_heartbeats (hostname, pid, beat_at) values ('old', 1, now() - interval '2 days')`
    const id = newId()

    await writeHeartbeat(handle.db, id)
    const [first] = await handle.sql<{ beat_at: string }[]>`select beat_at from worker_heartbeats where id = ${id}`
    await new Promise((r) => setTimeout(r, 20))
    await writeHeartbeat(handle.db, id)

    const rows = await handle.sql<{ id: string; beat_at: string }[]>`select id, beat_at from worker_heartbeats`
    expect(rows.map((r) => r.id)).toEqual([id]) // dòng 'old' đã bị xoá
    // client Drizzle/postgres.js trả timestamptz dạng chuỗi
    expect(new Date(rows[0]!.beat_at).getTime()).toBeGreaterThan(new Date(first!.beat_at).getTime())

    expect(await checkHealth(handle.sql, { diskUsage: async () => 0.5 })).toEqual({
      ok: true,
      db: 'ok',
      worker: 'ok',
      disk: 'ok',
    })
  })
})

describe('startWorkers', () => {
  const log = createLogger({ level: 'silent' })
  const registry: QueueRegistry = { 'testonly.job': { policy: 'standard', retryLimit: 0, concurrency: 1 } }
  const boss = { work: async () => 'w' } as unknown as PgBoss

  it('queue khai báo mà thiếu handler → lỗi khởi động', async () => {
    await expect(startWorkers(boss, {}, log, registry)).rejects.toThrow(/chưa có handler/)
  })

  it('handler cho queue không có trong registry → lỗi khởi động', async () => {
    await expect(
      startWorkers(boss, { 'testonly.job': async () => {}, 'testonly.other': async () => {} }, log, registry),
    ).rejects.toThrow(/không có trong registry/)
  })
})
