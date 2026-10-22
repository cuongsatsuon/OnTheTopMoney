// Handler job `webhook.route` (AD-4, AD-24). Chuẩn hoá + ĐẶT TRẠNG THÁI mục, KHÔNG xử lý nghiệp vụ trong
// request (đã trả 200 ở POST). Story 4.1: inbox CHƯA có (Story 4.3/4.4) nên chỉ đặt `status`:
// - sự kiện thử (`test`) → `ignored` (chỉ nhật ký);
// - trang không có trong DB / đã gỡ → `ignored` (lưu, không route);
// - mục nhận diện được loại sẽ ingest ở story sau → `routed` (ghi chú; KHÔNG gọi inbox vì chưa có);
// - loại khác (reaction, delivery, read, không rõ) → `ignored`.
// Idempotent theo khoá mục: tính lại trạng thái xác định nên chạy lại cho cùng kết quả.
import type { Platform, WebhookProduct } from '@ottm/shared'
import { eq } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { findPageByPlatformAccountId } from '../pages/index.ts'
import { webhookEvents } from './schema.ts'

export interface RouteJobData {
  eventId: string
}

export function parseRouteJobData(data: unknown): RouteJobData {
  const id = (data as { eventId?: unknown } | null)?.eventId
  if (typeof id !== 'string' || id === '') throw new Error('webhook.route: thiếu eventId')
  return { eventId: id }
}

/** Mã lỗi chẩn đoán ghi vào `webhook_events.error_code` khi job hết lượt retry. */
export const WEBHOOK_ROUTE_FAILED = 'WEBHOOK_ROUTE_FAILED'

/**
 * Loại mục sẽ được ingest vào Hộp thư ở story sau (nay tạm `routed`, KHÔNG gọi inbox). Loại ngoài danh sách
 * này (reaction, delivery, read, loại không rõ) chỉ lưu (`ignored`).
 */
const ROUTABLE_FIELDS: ReadonlySet<string> = new Set([
  'messages',
  'message_echoes',
  'messaging_postbacks',
  'comments',
  'feed',
  'mentions',
  'replies',
])

export type RouteResult = 'missing' | 'ignored_test' | 'ignored_no_page' | 'ignored' | 'routed'

export interface RouteDeps {
  db: DbExecutor
}

/** Nền tảng khả dĩ của một mục theo sản phẩm webhook — để không route chéo (meta ≠ threads). */
export function platformsForProduct(product: WebhookProduct): readonly Platform[] {
  return product === 'threads' ? ['threads'] : ['facebook', 'instagram']
}

export async function routeWebhookEvent(deps: RouteDeps, data: RouteJobData): Promise<RouteResult> {
  const [event] = await deps.db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.id, data.eventId))
  if (!event) return 'missing'

  if (event.test) {
    await setStatus(deps.db, event.id, 'ignored', null)
    return 'ignored_test'
  }

  // Trang chưa kết nối / đã gỡ → lưu, không route (AD-4). Lọc theo nền tảng của sản phẩm (không route chéo).
  const page = event.platformPageId
    ? await findPageByPlatformAccountId(deps.db, event.platformPageId, platformsForProduct(event.product as WebhookProduct))
    : null
  if (!page) {
    await setStatus(deps.db, event.id, 'ignored', null)
    return 'ignored_no_page'
  }

  const status: RouteResult = ROUTABLE_FIELDS.has(event.field) ? 'routed' : 'ignored'
  await setStatus(deps.db, event.id, status, page.id)
  return status
}

async function setStatus(db: DbExecutor, id: string, status: 'routed' | 'ignored', pageId: string | null): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ status, pageId, errorCode: null, routedAt: new Date() })
    .where(eq(webhookEvents.id, id))
}

/**
 * Handler job `webhook.route` cho worker (tách khỏi worker/main.ts để unit-test nhánh catch). Chỉ lần thử
 * CUỐI mới ghi mục `failed` (lỗi xác định không tự khỏi); lần chưa cuối → ném lại để pg-boss retry, KHÔNG
 * ghi `failed`. `route`/`markFailed` tiêm vào để test không cần DB.
 */
export interface RouteJobHandlerDeps {
  route: (data: RouteJobData) => Promise<unknown>
  markFailed: (eventId: string, errorCode: string) => Promise<void>
}

export async function handleRouteJob(
  deps: RouteJobHandlerDeps,
  job: { data: unknown; retryCount: number; retryLimit: number },
): Promise<void> {
  const data = parseRouteJobData(job.data)
  try {
    await deps.route(data)
  } catch (err) {
    if (job.retryCount >= job.retryLimit) await deps.markFailed(data.eventId, WEBHOOK_ROUTE_FAILED).catch(() => {})
    throw err
  }
}
