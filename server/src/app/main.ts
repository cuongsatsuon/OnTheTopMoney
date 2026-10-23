// Entrypoint `api`: node src/app/main.ts
import { getConfig } from '../platform/config/index.ts'
import { createLogger } from '../platform/log/index.ts'
import { assertBossDbSupported, createDb } from '../platform/db/index.ts'
import { createEventPublisher } from '../platform/events/index.ts'
import { createBoss, createJobSender } from '../platform/jobs/index.ts'
import { createRealtimeHub } from '../platform/realtime/index.ts'
import { buildApp } from './app.ts'
import { aiOptionsFromConfig, connectionsOptionsFromConfig, mediaStoresFromConfig, webhooksOptionsFromConfig } from './deps.ts'

const config = getConfig()
const logger = createLogger({ level: config.LOG_LEVEL, name: 'api' })
const dbHandle = createDb(config.DATABASE_URL, { applicationName: 'ottm-api', connectTimeoutSeconds: 2 })
// pg-boss của api chỉ để phát sự kiện/enqueue trong transaction — bảo trì và cron thuộc worker.
const boss = createBoss(config.DATABASE_URL, 'ottm-api-boss', { background: false, max: 3 })
boss.on('error', (err) => logger.error({ err }, 'pg-boss lỗi'))
// Config đã bảo đảm: production luôn có cặp khoá chủ hợp lệ; dev do `npm run dev` tự sinh.
const ai = aiOptionsFromConfig(config)
if (!ai.cipher) logger.warn('APP_ENCRYPTION_KEYS chưa đặt — không lưu được khoá OpenAI (chạy `npm run dev` ở gốc để tự sinh khoá dev)')
if (config.META_FAKE) logger.warn('META_FAKE=1: mọi lời gọi Meta dùng dữ liệu giả, nút kết nối mở trang đồng ý giả (chỉ dev)')
else {
  if (!config.META_APP_ID || !config.META_APP_SECRET) logger.warn('META_APP_ID / META_APP_SECRET chưa đặt — kết nối Facebook trả META_NOT_CONFIGURED (dev: đặt META_FAKE=1 để thử)')
  if (!config.THREADS_APP_ID || !config.THREADS_APP_SECRET) logger.warn('THREADS_APP_ID / THREADS_APP_SECRET chưa đặt — kết nối Threads trả META_NOT_CONFIGURED (dev: đặt META_FAKE=1 để thử)')
}
const realtime = createRealtimeHub({ sql: dbHandle.sql, log: logger.child({ component: 'realtime' }) })
const app = buildApp({
  sql: dbHandle.sql,
  db: dbHandle.db,
  logger,
  http: {
    allowedOrigins: config.ALLOWED_ORIGINS,
    cookieSecure: config.COOKIE_SECURE,
    trustProxy: config.TRUST_PROXY,
  },
  health: { diskPath: config.HEALTH_DISK_PATH },
  events: createEventPublisher(boss),
  realtime,
  ai,
  connections: connectionsOptionsFromConfig(config, dbHandle.db, logger, boss),
  media: mediaStoresFromConfig(config),
  webhooks: webhooksOptionsFromConfig(config, boss),
  jobs: createJobSender(boss),
})
if (!config.META_VERIFY_TOKEN) logger.warn('META_VERIFY_TOKEN chưa đặt — GET /webhooks/* trả 403 (chưa xác minh được với Meta)')
// Thiếu app secret → không verify được chữ ký webhook → POST /webhooks/* luôn 401, Meta có thể tắt subscription.
if (!config.META_FAKE) {
  if (!config.META_APP_SECRET) logger.warn('META_APP_SECRET chưa đặt — POST /webhooks/meta trả 401 (không verify được chữ ký; Meta có thể tắt subscription)')
  if (!config.THREADS_APP_SECRET) logger.warn('THREADS_APP_SECRET chưa đặt — POST /webhooks/threads trả 401 (không verify được chữ ký)')
}
if (!config.CLOUDINARY_URL) logger.warn('CLOUDINARY_URL chưa đặt — tải logo hồ sơ thương hiệu trả MEDIA_NOT_CONFIGURED (phần chữ vẫn lưu được)')

let closing = false
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  logger.info({ signal }, 'api đang dừng')
  // app.close() đóng cả các stream SSE và LISTEN (hook preClose).
  await app.close().catch((err: unknown) => logger.error({ err }, 'lỗi khi đóng fastify'))
  await boss.stop({ graceful: false }).catch((err: unknown) => logger.error({ err }, 'lỗi khi dừng pg-boss'))
  await dbHandle.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await assertBossDbSupported(dbHandle.db)
  await boss.start()
  await realtime.start()
  await app.listen({ port: config.PORT, host: '0.0.0.0' })
} catch (err) {
  logger.fatal({ err }, 'api không khởi động được')
  await realtime.close().catch(() => {})
  await boss.stop({ graceful: false }).catch(() => {})
  await dbHandle.close().catch(() => {})
  process.exit(1)
}
