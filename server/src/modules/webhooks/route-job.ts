// Handler job `webhook.route` (AD-4, AD-24). Chuẩn hoá + ĐẶT TRẠNG THÁI mục, KHÔNG xử lý nghiệp vụ trong
// request (đã trả 200 ở POST):
// - sự kiện thử (`test`) → `ignored` (chỉ nhật ký);
// - trang không có trong DB / đã gỡ → `ignored` (lưu, không route, không tạo gì trong `inbox`);
// - Story 4.3: mục `messages` của Fanpage/IG → chuẩn hoá qua `adapters/meta` → `inbox.ingest` → `routed`. Echo
//   (Story 4.5), tin thu hồi, mục thiếu id, tin do chính trang gửi → `ignored`;
// - Story 4.4: FB `feed`, IG `comments`, Threads `replies` → chuẩn hoá bình luận → bình luận mới `inbox.ingestComment`;
//   sửa `inbox.updateMessageText`; xoá/ẩn `inbox.markMessageRemoved`; bỏ ẩn `inbox.markMessageUnhidden`. Không tìm thấy
//   tin để sửa/xoá, bình luận của chính trang, mục không phải bình luận → `ignored`;
// - loại khác (echo — Story 4.5, postback, reaction, delivery, read, mentions, không rõ) → `ignored`.
// Idempotent theo khoá mục: ingest chống trùng theo `(page_id, platform_message_id)`, sửa/xoá lặp lại không đổi gì.
import type { Platform, WebhookProduct } from '@ottm/shared'
import { eq } from 'drizzle-orm'
import {
  normalizeFeedChange,
  normalizeInstagramComment,
  normalizeMessagingItem,
  normalizeThreadsReply,
  type CommentPageRef,
  type NormalizedComment,
} from '../../adapters/meta/index.ts'
import type { Db } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { ingestComment, ingestDm, markMessageRemoved, markMessageUnhidden, updateMessageText } from '../inbox/index.ts'
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

/** Bộ chuẩn hoá bình luận theo field (Story 4.4). Field ngoài bảng → `ignored`. */
type CommentNormalizer = (change: unknown, page: CommentPageRef, fallbackTime: Date) => NormalizedComment
const COMMENT_FIELDS: Readonly<Record<'meta' | 'threads', Readonly<Record<string, CommentNormalizer>>>> = {
  meta: { feed: normalizeFeedChange, comments: normalizeInstagramComment },
  threads: { replies: normalizeThreadsReply },
}

export type RouteResult = 'missing' | 'ignored_test' | 'ignored_no_page' | 'ignored' | 'routed'

export interface RouteDeps {
  db: Db
  /** Phát `message.received` trong transaction ingest. */
  events: EventPublisher
  /** Enqueue job đính kèm / hồ sơ khách trong transaction ingest. */
  jobs: JobSender
  now?: () => Date
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

  // Story 4.3: tin nhắn Messenger / IG Direct → `inbox.ingest`. Threads không có DM.
  if (event.field === 'messages') {
    let status: RouteResult = 'ignored'
    if (page.platform !== 'threads' && event.platformPageId) {
      const dm = normalizeMessagingItem(event.payload, event.platformPageId, deps.now?.() ?? new Date())
      if (dm.kind === 'dm') {
        await ingestDm({ db: deps.db, events: deps.events, jobs: deps.jobs }, { pageId: page.id, message: dm })
        status = 'routed'
      }
    }
    await setStatus(deps.db, event.id, status, page.id)
    return status
  }

  // Story 4.4: bình luận FB/IG, trả lời Threads. Thời điểm dự phòng = lúc nhận webhook (ổn định qua các lần retry).
  const normalize = COMMENT_FIELDS[event.product as WebhookProduct][event.field]
  let status: RouteResult = 'ignored'
  if (normalize && event.platformPageId) {
    const comment = normalize(event.payload, { platformAccountId: event.platformPageId, handle: page.handle }, event.receivedAt)
    const inbox = { db: deps.db, events: deps.events, jobs: deps.jobs }
    const ref = (commentId: string) => ({ pageId: page.id, platformMessageId: commentId })
    switch (comment.kind) {
      case 'comment':
        await ingestComment(inbox, { pageId: page.id, comment })
        status = 'routed'
        break
      case 'edit':
        if ((await updateMessageText(inbox, { ...ref(comment.commentId), text: comment.text, editedAt: comment.timestamp })) !== 'missing') status = 'routed'
        break
      case 'remove':
        if ((await markMessageRemoved(inbox, { ...ref(comment.commentId), removal: comment.removal, at: comment.timestamp })) !== 'missing') status = 'routed'
        break
      case 'unhide':
        if ((await markMessageUnhidden(inbox, ref(comment.commentId))) !== 'missing') status = 'routed'
        break
      case 'skip':
        break
    }
  }
  await setStatus(deps.db, event.id, status, page.id)
  return status
}

async function setStatus(db: Db, id: string, status: 'routed' | 'ignored', pageId: string | null): Promise<void> {
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
