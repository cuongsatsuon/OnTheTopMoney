// Sức khoẻ webhook (Story 4.2, AD-4). Cron `webhooks.health` (5 phút, giờ VN) tính riêng cho `meta` và `threads`:
// - `lastEventAt` = `max(received_at)` của `webhook_events` không phải `test`;
// - chưa từng có sự kiện → `waiting_first`;
// - `stalled` khi ĐỒNG THỜI: (a) sản phẩm có trang `active` (meta: facebook/instagram; threads: threads),
//   (b) giờ VN hiện tại trong 08:00–22:00, (c) `now − max(lastEventAt, 08:00 hôm nay giờ VN) > 30 phút`;
// - còn lại → `ok`.
// Sang `stalled` → phát `webhook.stalled` MỘT lần; rời `stalled` → `webhook.recovered`. Ghi và phát trong cùng
// transaction (AD-3). Không tạo thông báo (story này chỉ có banner Hộp thư).
import { WEBHOOK_PRODUCTS, type WebhookHealthResponse, type WebhookHealthStatus, type WebhookProduct } from '@ottm/shared'
import { and, eq, max } from 'drizzle-orm'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { listSubscriptionErrors } from '../connections/index.ts'
import { listPages } from '../pages/index.ts'
import { platformsForProduct } from './route-job.ts'
import { webhookEvents, webhookHealth } from './schema.ts'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Asia/Ho_Chi_Minh: UTC+7, không có giờ mùa hè. */
const VN_OFFSET_MS = 7 * HOUR_MS
/** Khung giờ theo dõi (giờ VN) [ASSUMPTION của epic]: từ 08:00 (gồm) tới 22:00 (không gồm). */
export const HEALTH_WINDOW_START_HOUR = 8
export const HEALTH_WINDOW_END_HOUR = 22
/** Im lặng quá chừng này (trong khung giờ, có trang active) → `stalled`. */
export const STALL_AFTER_MS = 30 * MINUTE_MS
/**
 * Dòng cron cũ hơn chừng này (3 chu kỳ 5 phút) → worker / cron coi như đã chết: API tính lại trạng thái tại chỗ thay vì
 * giữ mãi `ok` cũ (Story 8.5 — Tổng quan cảnh báo webhook; việc hoãn từ 4.2). Sự kiện `webhook.stalled` vẫn chỉ cron phát.
 */
export const HEALTH_STALE_AFTER_MS = 15 * MINUTE_MS

/** Mốc 00:00 giờ VN của ngày chứa `now` (dạng epoch ms). */
function vnDayStart(now: Date): number {
  const shifted = now.getTime() + VN_OFFSET_MS
  return Math.floor(shifted / DAY_MS) * DAY_MS - VN_OFFSET_MS
}

export interface HealthInput {
  now: Date
  /** Sự kiện thật gần nhất của sản phẩm; `null` khi chưa từng có. */
  lastEventAt: Date | null
  /** Sản phẩm có ít nhất một trang `active`. */
  hasActivePages: boolean
}

/** Hàm thuần: trạng thái sức khoẻ của một sản phẩm tại `now`. */
export function computeHealthStatus(input: HealthInput): WebhookHealthStatus {
  if (!input.lastEventAt) return 'waiting_first'
  if (!input.hasActivePages) return 'ok'
  const dayStart = vnDayStart(input.now)
  const open = dayStart + HEALTH_WINDOW_START_HOUR * HOUR_MS
  const close = dayStart + HEALTH_WINDOW_END_HOUR * HOUR_MS
  const t = input.now.getTime()
  if (t < open || t >= close) return 'ok'
  // Im lặng qua đêm không tính: đếm từ 08:00 hôm nay nếu sự kiện cuối trước đó.
  const since = Math.max(input.lastEventAt.getTime(), open)
  return t - since > STALL_AFTER_MS ? 'stalled' : 'ok'
}

const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)))

/** `max(received_at)` của sự kiện thật (không phải `test`) của một sản phẩm. */
async function lastEventAtOf(db: DbExecutor, product: WebhookProduct): Promise<Date | null> {
  const [row] = await db
    .select({ last: max(webhookEvents.receivedAt) })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.product, product), eq(webhookEvents.test, false)))
  return toDate(row?.last)
}

async function hasActivePagesFor(db: DbExecutor, product: WebhookProduct): Promise<boolean> {
  const platforms = platformsForProduct(product)
  return (await listPages(db)).some((p) => p.connectionStatus === 'active' && platforms.includes(p.platform))
}

export interface HealthCheckDeps {
  db: Db
  events: EventPublisher
  now?: () => Date
}

export interface ProductHealthResult {
  product: WebhookProduct
  status: WebhookHealthStatus
  previous: WebhookHealthStatus | null
  /** Sự kiện vừa phát (nếu có). */
  emitted: 'webhook.stalled' | 'webhook.recovered' | null
}

/** Handler của cron `webhooks.health`: mỗi sản phẩm một transaction (đọc → ghi `webhook_health` → phát sự kiện). */
export async function runHealthCheck(deps: HealthCheckDeps): Promise<ProductHealthResult[]> {
  const now = deps.now?.() ?? new Date()
  const results: ProductHealthResult[] = []
  for (const product of WEBHOOK_PRODUCTS) {
    results.push(
      await deps.db.transaction(async (tx) => {
        // Khoá dòng cũ (nếu có) để hai lần chạy chồng nhau không phát trùng.
        const [prev] = await tx.select().from(webhookHealth).where(eq(webhookHealth.product, product)).for('update')
        const lastEventAt = await lastEventAtOf(tx, product)
        const hasActivePages = await hasActivePagesFor(tx, product)
        const status = computeHealthStatus({ now, lastEventAt, hasActivePages })
        const previous = (prev?.status as WebhookHealthStatus | undefined) ?? null
        const changed = previous !== status
        const values = {
          status,
          lastEventAt,
          statusChangedAt: changed ? now : (prev?.statusChangedAt ?? now),
          checkedAt: now,
        }
        await tx
          .insert(webhookHealth)
          .values({ product, ...values })
          .onConflictDoUpdate({ target: webhookHealth.product, set: values })
        let emitted: ProductHealthResult['emitted'] = null
        if (status === 'stalled' && previous !== 'stalled') emitted = 'webhook.stalled'
        else if (previous === 'stalled' && status !== 'stalled') emitted = 'webhook.recovered'
        if (emitted) await deps.events.publishEvent(tx, emitted, { id: product, product })
        return { product, status, previous, emitted }
      }),
    )
  }
  return results
}

/**
 * `GET /api/v1/webhooks/health`: trạng thái do cron ghi (chưa có dòng / dòng cũ hơn `HEALTH_STALE_AFTER_MS` → tính tại
 * chỗ), `lastEventAt` đọc trực
 * tiếp để "Nhận tin gần nhất" không trễ theo chu kỳ cron; kèm trang (chưa gỡ) đăng ký webhook lỗi.
 */
export async function getWebhookHealth(db: Db, now: Date = new Date()): Promise<WebhookHealthResponse> {
  const rows = await db.select().from(webhookHealth)
  const byProduct = new Map(rows.map((r) => [r.product, r]))
  const products: WebhookHealthResponse['products'] = []
  for (const product of WEBHOOK_PRODUCTS) {
    const lastEventAt = await lastEventAtOf(db, product)
    const row = byProduct.get(product)
    const fresh = row && now.getTime() - row.checkedAt.getTime() <= HEALTH_STALE_AFTER_MS
    let status = fresh
      ? (row.status as WebhookHealthStatus)
      : computeHealthStatus({ now, lastEventAt, hasActivePages: await hasActivePagesFor(db, product) })
    // Tin đã về lại sau lần cron cuối → không giữ `stalled` thêm tới 5 phút (banner tắt ngay; sự kiện
    // `webhook.recovered` vẫn do cron phát).
    if (status === 'stalled' && lastEventAt && now.getTime() - lastEventAt.getTime() <= STALL_AFTER_MS) status = 'ok'
    products.push({ product, status, lastEventAt: lastEventAt ? lastEventAt.toISOString() : null })
  }
  return { products, pageSubscriptionErrors: await listSubscriptionErrors(db) }
}
