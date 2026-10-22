import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import { measureDiskUsage, type DiskUsageProbe } from '../src/app/healthz.ts'
import { createDb, type DbHandle } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { blackholeServer, freePort } from './helpers/net.ts'

const logger = createLogger({ level: 'silent' })

describe('GET /healthz', () => {
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

  const halfFull: DiskUsageProbe = async () => 0.5

  async function get(sql = handle.sql, diskUsage: DiskUsageProbe = halfFull) {
    const app = buildApp({ sql, db: handle.db, logger, health: { diskPath: '/data/media', diskUsage } })
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' })
      return { status: res.statusCode, body: res.json() }
    } finally {
      await app.close()
    }
  }

  it('200 khi DB lên và heartbeat ≤ 2 phút', async () => {
    await handle.sql`insert into worker_heartbeats (hostname, pid, beat_at) values ('t', 1, now() - interval '30 seconds')`
    expect(await get()).toEqual({ status: 200, body: { ok: true, db: 'ok', worker: 'ok', disk: 'ok' } })
  })

  it('503 worker stale khi heartbeat cũ hơn 2 phút', async () => {
    await handle.sql`insert into worker_heartbeats (hostname, pid, beat_at) values ('t', 1, now() - interval '3 minutes')`
    const res = await get()
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ ok: false, db: 'ok', worker: 'stale' })
  })

  it('503 worker stale khi chưa có heartbeat nào', async () => {
    const res = await get()
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ ok: false, worker: 'stale' })
  })

  it('503 db down khi không kết nối được Postgres', async () => {
    const down = createDb(`postgres://postgres:postgres@127.0.0.1:${await freePort()}/x`, { max: 1 })
    try {
      const res = await get(down.sql)
      expect(res.status).toBe(503)
      expect(res.body).toMatchObject({ ok: false, db: 'down' })
    } finally {
      await down.close().catch(() => {})
    }
  })

  it('503 db down trong ≤ 2 giây khi Postgres treo', async () => {
    const hole = await blackholeServer()
    const hung = createDb(`postgres://postgres:postgres@127.0.0.1:${hole.port}/x`, { max: 1, connectTimeoutSeconds: 30 })
    try {
      const started = Date.now()
      const res = await get(hung.sql)
      const elapsed = Date.now() - started
      expect(res.status).toBe(503)
      expect(res.body).toMatchObject({ ok: false, db: 'down' })
      expect(elapsed).toBeLessThan(2_500)
    } finally {
      await hung.sql.end({ timeout: 0 }).catch(() => {})
      await hole.close()
    }
  })

  describe('đĩa', () => {
    beforeEach(async () => {
      await handle.sql`insert into worker_heartbeats (hostname, pid, beat_at) values ('t', 1, now())`
    })

    it('503 disk full khi đĩa dùng > 85%, vẫn báo db và worker', async () => {
      const res = await get(handle.sql, async () => 0.86)
      expect(res).toEqual({ status: 503, body: { ok: false, db: 'ok', worker: 'ok', disk: 'full' } })
    })

    it('đúng 85% vẫn là ok', async () => {
      expect(await get(handle.sql, async () => 0.85)).toMatchObject({ status: 200, body: { disk: 'ok' } })
    })

    it('đo đĩa trên đúng HEALTH_DISK_PATH', async () => {
      const seen: string[] = []
      await get(handle.sql, async (path) => {
        seen.push(path)
        return 0.1
      })
      expect(seen).toEqual(['/data/media'])
    })

    it('lỗi đọc đĩa → disk unknown, không làm 503', async () => {
      const res = await get(handle.sql, async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      expect(res).toEqual({ status: 200, body: { ok: true, db: 'ok', worker: 'ok', disk: 'unknown' } })
    })

    it('kết quả đo không phải số hữu hạn → disk unknown', async () => {
      expect(await get(handle.sql, async () => Number.NaN)).toMatchObject({ status: 200, body: { disk: 'unknown' } })
    })

    it('đo đĩa treo → disk unknown trong ≤ 2 giây', async () => {
      const started = Date.now()
      const res = await get(handle.sql, () => new Promise<number>(() => {}))
      expect(res).toMatchObject({ status: 200, body: { disk: 'unknown' } })
      expect(Date.now() - started).toBeLessThan(2_500)
    })

    it('DB lỗi và đĩa đầy → báo cả hai', async () => {
      const down = createDb(`postgres://postgres:postgres@127.0.0.1:${await freePort()}/x`, { max: 1 })
      try {
        const res = await get(down.sql, async () => 0.99)
        expect(res).toEqual({ status: 503, body: { ok: false, db: 'down', worker: 'unknown', disk: 'full' } })
      } finally {
        await down.close().catch(() => {})
      }
    })
  })
})

describe('measureDiskUsage', () => {
  it('trả tỉ lệ trong [0, 1] cho thư mục có thật', async () => {
    const used = await measureDiskUsage(process.cwd())
    expect(used).toBeGreaterThanOrEqual(0)
    expect(used).toBeLessThanOrEqual(1)
  })

  it('thư mục không tồn tại → reject (healthz đổi thành unknown)', async () => {
    await expect(measureDiskUsage('/khong-ton-tai-ottm')).rejects.toThrow()
  })
})
