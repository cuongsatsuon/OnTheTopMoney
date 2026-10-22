// Entrypoint `worker`: node src/worker/main.ts — pg-boss job, cron, consumer sự kiện.
import type { JobWithMetadata } from 'pg-boss'
import { getConfig } from '../platform/config/index.ts'
import { createLogger } from '../platform/log/index.ts'
import { assertBossDbSupported, createDb, newId } from '../platform/db/index.ts'
import { createEventPublisher, parseEventEnvelope } from '../platform/events/index.ts'
import { QUEUES, createBoss, ensureQueues, isCriticalQueue, startWorkers } from '../platform/jobs/index.ts'
import { createSecretCipher } from '../adapters/crypto/index.ts'
import { gcReservations, handleAiEvent } from '../modules/ai/index.ts'
import { cleanupExpiredOAuth, createMetaClients, runTokenCheck } from '../modules/connections/index.ts'
import { handleEvent } from '../modules/notifications/index.ts'
import { handleProfilesEvent } from '../modules/profiles/index.ts'
import { handleRouteJob, markEventFailed, routeWebhookEvent } from '../modules/webhooks/index.ts'
import { HEARTBEAT_INTERVAL_MS, writeHeartbeat } from './heartbeat.ts'

const config = getConfig()
const logger = createLogger({ level: config.LOG_LEVEL, name: 'worker' })
const instanceId = newId()
const dbHandle = createDb(config.DATABASE_URL, { applicationName: 'ottm-worker', max: 5 })
const boss = createBoss(config.DATABASE_URL, 'ottm-worker-boss')
boss.on('error', (err) => logger.error({ err }, 'pg-boss lỗi'))
const events = createEventPublisher(boss)
// Làm mới / mã hoá token Meta trong cron `connections.token_check` (AD-5, AD-12). Dev không đặt khoá → null.
const cipher =
  config.APP_ENCRYPTION_KEYS && config.APP_ENCRYPTION_ACTIVE_KEY
    ? createSecretCipher({ keys: config.APP_ENCRYPTION_KEYS, activeKeyId: config.APP_ENCRYPTION_ACTIVE_KEY })
    : null
// Client Threads (fake khi `META_FAKE=1`; undefined khi chưa cấu hình app Threads) để làm mới token Threads.
const { threads } = createMetaClients({ config, db: dbHandle.db, log: logger.child({ component: 'meta' }) })

let heartbeatTimer: NodeJS.Timeout | undefined
let closing = false
async function shutdown(signal: string, code = 0): Promise<void> {
  if (closing) return
  closing = true
  logger.info({ signal }, 'worker đang dừng')
  clearInterval(heartbeatTimer)
  await boss.stop({ graceful: true, timeout: 10_000 }).catch((err: unknown) => logger.error({ err }, 'lỗi khi dừng pg-boss'))
  await dbHandle.close().catch(() => {})
  process.exit(code)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await assertBossDbSupported(dbHandle.db)
  await boss.start()
  const { unknownQueues } = await ensureQueues(boss)
  if (unknownQueues.length > 0) {
    logger.warn({ unknownQueues }, 'pg-boss có queue không khai báo trong platform/jobs/queues.ts')
  }
  await startWorkers(
    boss,
    {
      'platform.heartbeat': () => writeHeartbeat(dbHandle.db, instanceId),
      'events.notifications': async (job) => {
        const result = await handleEvent(
          { db: dbHandle.db, events, isCriticalQueue: (queue) => isCriticalQueue(queue) },
          parseEventEnvelope(job.data),
        )
        logger.debug({ jobId: job.id, result }, 'events.notifications')
      },
      'events.ai': async (job) => {
        const result = await handleAiEvent({ db: dbHandle.db, events }, job.data)
        logger.debug({ jobId: job.id, result }, 'events.ai')
      },
      'events.profiles': async (job) => {
        // Giống `events.ai`/`events.notifications`: `handleProfilesEvent` tự kiểm (isEventEnvelope + guard),
        // dữ liệu hỏng → 'ignored' (không ném ZodError đốt lượt retry). Idempotent nên retry an toàn.
        const result = await handleProfilesEvent({ db: dbHandle.db }, job.data)
        logger.debug({ jobId: job.id, result }, 'events.profiles')
      },
      'ai.reservations_gc': async () => {
        const removed = await gcReservations(dbHandle.db)
        if (removed > 0) logger.warn({ removed }, 'ai: đã dọn chỗ giữ chi phí bị bỏ rơi')
      },
      'connections.oauth_gc': async () => {
        const removed = await cleanupExpiredOAuth(dbHandle.db)
        if (removed > 0) logger.info({ removed }, 'connections: đã dọn state/kết quả OAuth hết hạn')
      },
      'connections.token_check': async () => {
        const { refreshed, expiring } = await runTokenCheck({
          db: dbHandle.db,
          events,
          cipher,
          threads,
          log: logger.child({ component: 'token_check' }),
        })
        logger.info({ refreshed, expiring }, 'connections: kiểm hạn token xong')
      },
      // Module `webhooks` (Story 4.1, AD-4): chuẩn hoá + đặt `status` cho một mục. Logic nhánh catch (lần thử
      // cuối → ghi `failed`) nằm trong `handleRouteJob` (đã unit-test). startWorkers chạy includeMetadata nên
      // job có retryCount/retryLimit lúc chạy.
      'webhook.route': (job) =>
        handleRouteJob(
          {
            route: (data) => routeWebhookEvent({ db: dbHandle.db }, data),
            markFailed: (eventId, errorCode) => markEventFailed(dbHandle.db, eventId, errorCode),
          },
          job as JobWithMetadata<unknown>,
        ),
    },
    logger,
    QUEUES,
    { failures: { events, db: dbHandle.db } },
  )
  // Heartbeat ngay khi khởi động, rồi mỗi 30 giây (spec); cron 1 phút của pg-boss vẫn ghi song song.
  await writeHeartbeat(dbHandle.db, instanceId)
  heartbeatTimer = setInterval(() => {
    writeHeartbeat(dbHandle.db, instanceId).catch((err: unknown) => logger.error({ err }, 'ghi heartbeat lỗi'))
  }, HEARTBEAT_INTERVAL_MS)
  logger.info({ instanceId }, 'worker đã chạy')
} catch (err) {
  logger.fatal({ err }, 'worker không khởi động được')
  await shutdown('startup-failure', 1)
}
