// GET /healthz (công khai, AD-19): 200 khi DB truy cập được, heartbeat worker ≤ 2 phút và đĩa ≤ 85%;
// ngược lại 503. Không đo được đĩa → `disk: 'unknown'`, không làm 503.
import { statfs } from 'node:fs/promises'
import type { FastifyInstance } from 'fastify'
import type { Sql } from '../platform/db/index.ts'

export const HEARTBEAT_MAX_AGE_SECONDS = 120
export const HEALTH_DB_TIMEOUT_MS = 2_000
/** Tỉ lệ đĩa đã dùng (0..1) vượt ngưỡng này → `disk: 'full'`. */
export const DISK_FULL_RATIO = 0.85

export interface HealthStatus {
  ok: boolean
  db: 'ok' | 'down'
  worker: 'ok' | 'stale' | 'unknown'
  disk: 'ok' | 'full' | 'unknown'
}

/** Trả tỉ lệ đã dùng (0..1) của hệ tệp chứa `path`. */
export type DiskUsageProbe = (path: string) => Promise<number>

/** Đo bằng `statfs` (Node 24): phần không còn cho tiến trình thường dùng được (`bavail`). */
export const measureDiskUsage: DiskUsageProbe = async (path) => {
  const s = await statfs(path)
  if (!(s.blocks > 0)) throw new Error('statfs trả blocks = 0')
  return 1 - s.bavail / s.blocks
}

export interface HealthOptions {
  timeoutMs?: number
  /** Thư mục nằm trên đĩa cần theo dõi (production: volume media, cùng đĩa với Postgres). */
  diskPath?: string
  diskUsage?: DiskUsageProbe
}

class HealthTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): { result: Promise<T>; clear: () => void } {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HealthTimeout()), timeoutMs)
  })
  return { result: Promise.race([promise, timeout]), clear: () => clearTimeout(timer) }
}

async function checkDb(sql: Sql, timeoutMs: number): Promise<Pick<HealthStatus, 'db' | 'worker'>> {
  // So tuổi heartbeat bằng đồng hồ của DB để không lệch giờ giữa api và worker.
  const query = sql<{ fresh: boolean }[]>`
    select coalesce(max(beat_at) >= now() - make_interval(secs => ${HEARTBEAT_MAX_AGE_SECONDS}), false) as fresh
    from worker_heartbeats`
  const { result, clear } = withTimeout(query.execute(), timeoutMs)
  try {
    const rows = await result
    const fresh = rows[0]?.fresh === true
    return { db: 'ok', worker: fresh ? 'ok' : 'stale' }
  } catch (err) {
    if (err instanceof HealthTimeout) {
      // cancel() có thể reject (vd chưa có kết nối) — không để thành unhandledRejection.
      Promise.resolve(query.cancel()).catch(() => {})
    }
    return { db: 'down', worker: 'unknown' }
  } finally {
    clear()
  }
}

async function checkDisk(path: string, probe: DiskUsageProbe, timeoutMs: number): Promise<HealthStatus['disk']> {
  const { result, clear } = withTimeout(probe(path), timeoutMs)
  try {
    const used = await result
    if (!Number.isFinite(used)) return 'unknown'
    return used > DISK_FULL_RATIO ? 'full' : 'ok'
  } catch {
    return 'unknown'
  } finally {
    clear()
  }
}

export async function checkHealth(sql: Sql, options: HealthOptions = {}): Promise<HealthStatus> {
  const timeoutMs = options.timeoutMs ?? HEALTH_DB_TIMEOUT_MS
  const [dbStatus, disk] = await Promise.all([
    checkDb(sql, timeoutMs),
    checkDisk(options.diskPath ?? '/', options.diskUsage ?? measureDiskUsage, timeoutMs),
  ])
  const ok = dbStatus.db === 'ok' && dbStatus.worker === 'ok' && disk !== 'full'
  return { ok, ...dbStatus, disk }
}

export function registerHealthz(app: FastifyInstance, sql: Sql, options: HealthOptions = {}): void {
  app.get('/healthz', { logLevel: 'warn' }, async (_req, reply) => {
    const status = await checkHealth(sql, options)
    return reply.code(status.ok ? 200 : 503).send(status)
  })
}
