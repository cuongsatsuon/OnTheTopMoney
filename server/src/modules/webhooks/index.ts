// Module `webhooks` (AD-1, AD-4): cổng nhận webhook Meta/Threads. Public API chỉ export từ file này.
// Gọi: `pages` (base), `connections`, `inbox` (Story 4.3: `webhook.route` → `inbox.ingest`), `adapters/meta` — theo
// bảng mũi tên AD-1. Story 9.2: `handleWebhooksPurge` — xoá payload thô liên quan khi xoá dữ liệu theo yêu cầu.
// Story 9.3: `purgeExpiredPayloads` — dọn payload thô quá hạn (cron `privacy.retention`).
export const MODULE = 'webhooks'

export { handleWebhooksPurge, type WebhooksPurgeDeps } from './purge.ts'
export { purgeExpiredPayloads } from './retention.ts'

export {
  createTestEvent,
  ingestWebhook,
  listWebhookEvents,
  markEventFailed,
  parseWebhookBody,
  retryEvent,
  toDto,
  type IngestDeps,
  type IngestOutcome,
  type IngestWebhookInput,
  type RetryOutcome,
} from './service.ts'

export {
  parseMetaBody,
  parseThreadsBody,
  hashItem,
  type WebhookItem,
} from './parse.ts'

export {
  WEBHOOK_ROUTE_FAILED,
  handleRouteJob,
  parseRouteJobData,
  platformsForProduct,
  routeWebhookEvent,
  type RouteDeps,
  type RouteJobData,
  type RouteJobHandlerDeps,
  type RouteResult,
} from './route-job.ts'

// Story 4.2: sức khoẻ webhook (cron `webhooks.health` + API).
export {
  HEALTH_WINDOW_END_HOUR,
  HEALTH_STALE_AFTER_MS,
  HEALTH_WINDOW_START_HOUR,
  STALL_AFTER_MS,
  computeHealthStatus,
  getWebhookHealth,
  runHealthCheck,
  type HealthCheckDeps,
  type HealthInput,
  type ProductHealthResult,
} from './health.ts'

/** Chỉ để khai khoá ngoại / join tới `webhook_events` từ test; không truy vấn trực tiếp ngoài module. */
export { webhookEvents as webhookEventsTable } from './schema.ts'
