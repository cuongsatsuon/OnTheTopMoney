// Tạo pg-boss và đồng bộ queue/cron từ registry (chỉ worker gọi `ensureQueues`).
import { sql } from 'drizzle-orm'
import { PgBoss, type Job, type JobWithMetadata } from 'pg-boss'
import type { DbExecutor } from '../db/index.ts'
import { isEventEnvelope, type EventPublisher } from '../events/index.ts'
import type { Logger } from '../log/index.ts'
import { QUEUES, validateRegistry, type QueueName, type QueueRegistry } from './queues.ts'

export const BOSS_SCHEMA = 'pgboss'
/** Queue nội bộ của pg-boss (vd `__pgboss__send-it` cho cron) — không thuộc registry. */
export const BOSS_INTERNAL_PREFIX = '__pgboss__'

export interface CreateBossOptions {
  /**
   * `false` cho tiến trình chỉ phát sự kiện/enqueue (api): không chạy bảo trì và cron của pg-boss —
   * việc đó thuộc worker.
   */
  background?: boolean
  max?: number
}

export function createBoss(databaseUrl: string, applicationName: string, options: CreateBossOptions = {}): PgBoss {
  const background = options.background ?? true
  return new PgBoss({
    connectionString: databaseUrl,
    schema: BOSS_SCHEMA,
    application_name: applicationName,
    max: options.max ?? 5,
    ...(background ? {} : { supervise: false, schedule: false }),
  })
}

/**
 * Tạo queue còn thiếu, cập nhật retry/expire của queue đã có, đặt cron, gỡ cron không còn khai báo.
 * Không xoá queue lạ (có thể còn job) — chỉ trả về để log cảnh báo.
 */
export async function ensureQueues(
  boss: PgBoss,
  registry: QueueRegistry = QUEUES,
): Promise<{ unknownQueues: string[] }> {
  validateRegistry(registry)
  for (const [name, def] of Object.entries(registry)) {
    const options = {
      retryLimit: def.retryLimit,
      retryDelay: def.retryDelay ?? 0,
      retryBackoff: def.retryBackoff ?? false,
      expireInSeconds: def.expireInSeconds ?? 900,
    }
    const existing = await boss.getQueue(name)
    if (!existing) {
      await boss.createQueue(name, { policy: def.policy, ...options })
    } else {
      if (existing.policy !== def.policy) {
        throw new Error(
          `queue "${name}" đang có policy "${existing.policy}" khác registry "${def.policy}"; cần migration tay`,
        )
      }
      await boss.updateQueue(name, options)
    }
    if (def.cron) {
      await boss.schedule(name, def.cron.expression, null, { tz: def.cron.tz })
    }
  }
  for (const schedule of await boss.getSchedules()) {
    if (!registry[schedule.name]?.cron) await boss.unschedule(schedule.name, schedule.key)
  }
  await syncSubscriptions(boss, registry)
  const names = new Set(Object.keys(registry))
  const unknownQueues = (await boss.getQueues()).map((q) => q.name).filter((n) => !names.has(n) && !n.startsWith(BOSS_INTERNAL_PREFIX))
  return { unknownQueues }
}

/**
 * Subscription sự kiện → queue theo `subscribes` của registry: thêm cái thiếu, gỡ cái registry
 * không còn khai báo (chỉ với queue thuộc registry; queue lạ để nguyên).
 */
async function syncSubscriptions(boss: PgBoss, registry: QueueRegistry): Promise<void> {
  const { rows } = await boss
    .getDb()
    .executeSql(`select event, name from ${BOSS_SCHEMA}.subscription`)
  const existing = rows as { event: string; name: string }[]
  for (const [name, def] of Object.entries(registry)) {
    const wanted = new Set<string>(def.subscribes ?? [])
    for (const event of wanted) await boss.subscribe(event, name)
    for (const row of existing) {
      if (row.name === name && !wanted.has(row.event)) await boss.unsubscribe(row.event, name)
    }
  }
}

export type JobHandler = (job: Job<unknown>) => Promise<void>

export interface StartWorkersOptions {
  /** Phát `job.failed {queue, jobId}` khi handler ném lỗi ở lần thử cuối (AD-24). */
  failures?: { events: EventPublisher; db: DbExecutor }
}

/** Lần thử đang chạy là lần cuối: hết lượt retry sau lần này. */
export function isFinalAttempt(job: Pick<JobWithMetadata, 'retryCount' | 'retryLimit'>): boolean {
  return job.retryCount >= job.retryLimit
}

/** Đăng ký consumer theo concurrency của registry; queue khai báo mà thiếu handler → lỗi khởi động. */
export async function startWorkers(
  boss: PgBoss,
  handlers: Record<string, JobHandler>,
  log: Logger,
  registry: QueueRegistry = QUEUES,
  options: StartWorkersOptions = {},
): Promise<void> {
  for (const name of Object.keys(handlers)) {
    if (!Object.hasOwn(registry, name)) throw new Error(`handler cho queue "${name}" không có trong registry`)
  }
  for (const name of Object.keys(registry)) {
    if (!handlers[name]) throw new Error(`queue "${name}" chưa có handler trong worker`)
  }
  for (const [name, def] of Object.entries(registry)) {
    const handler = handlers[name]!
    const workOptions = {
      localConcurrency: def.concurrency,
      batchSize: 1,
      includeMetadata: true,
      ...(def.pollingIntervalSeconds !== undefined ? { pollingIntervalSeconds: def.pollingIntervalSeconds } : {}),
    } as const
    await boss.work(name, workOptions, async (jobs: JobWithMetadata<unknown>[]) => {
      for (const job of jobs) {
        const jobLog = log.child({ jobId: job.id, queue: name })
        try {
          await handler(job)
        } catch (err) {
          const final = isFinalAttempt(job)
          jobLog.error({ err, retryCount: job.retryCount, retryLimit: job.retryLimit, final }, 'job lỗi')
          if (final) await reportExhausted(name, job, options, jobLog)
          throw err
        }
      }
    })
  }
}

async function reportExhausted(
  queue: string,
  job: JobWithMetadata<unknown>,
  options: StartWorkersOptions,
  log: Logger,
): Promise<void> {
  if (!options.failures) return
  // Job đang xử lý chính sự kiện `job.failed` mà hỏng → không phát tiếp (chặn vòng lặp).
  if (isEventEnvelope(job.data) && job.data.event === 'job.failed') {
    log.error('consumer của job.failed hết retry — không phát job.failed mới')
    return
  }
  try {
    const { events, db } = options.failures
    await events.publishEvent(db, 'job.failed', { id: job.id, queue, jobId: job.id })
  } catch (err) {
    // Không che lỗi gốc của job.
    log.error({ err }, 'không phát được job.failed')
  }
}

/**
 * Còn job "sống" (chờ, chờ retry, đang chạy) của queue `name` mà `data` chứa `match` (jsonb `@>`) không — cho cron vá
 * job bị mất (Story 6.4 `content.requeue`). Chỉ tầng jobs biết bảng của pg-boss.
 */
export async function hasLiveJob(db: DbExecutor, name: QueueName, match: Record<string, string | number>): Promise<boolean> {
  const rows = await db.execute(sql`
    select 1 from ${sql.raw(BOSS_SCHEMA)}.job
    where name = ${name} and state in ('created', 'retry', 'active') and data @> ${JSON.stringify(match)}::jsonb
    limit 1`)
  return rows.length > 0
}
