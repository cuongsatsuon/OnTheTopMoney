// Handler job `webhook.route` (AD-4, AD-24). Chuẩn hoá + ĐẶT TRẠNG THÁI mục, KHÔNG xử lý nghiệp vụ trong
// request (đã trả 200 ở POST):
// - sự kiện thử (`test`) → `ignored` (chỉ nhật ký);
// - trang không có trong DB / đã gỡ → `ignored` (lưu, không route, không tạo gì trong `inbox`);
// - Story 4.3: mục `messages` của Fanpage/IG → chuẩn hoá qua `adapters/meta` → `inbox.ingest` → `routed`. Tin thu hồi,
//   mục thiếu id → `ignored`;
// - Story 4.4: FB `feed`, IG `comments`, Threads `replies` → chuẩn hoá bình luận → bình luận mới `inbox.ingestComment`;
//   sửa `inbox.updateMessageText`; xoá/ẩn `inbox.markMessageRemoved`; bỏ ẩn `inbox.markMessageUnhidden`. Không tìm thấy
//   tin để sửa/xoá, mục không phải bình luận → `ignored`;
// - Story 4.5: tin/bình luận của chính trang (`message_echoes`, `is_echo`, tác giả = trang) → `inbox.ingestEcho` (luồng chưa
//   có hội thoại → `ignored`); "đã nhận / đã xem" (`message_deliveries|message_reads`) → `inbox.markOutboundReceipt`
//   (không có hội thoại / tin nào → `ignored`);
// - loại khác (postback, reaction, mentions, không rõ) → `ignored`.
// - Story 9.3: payload thô đã dọn theo hạn → `missing`; tin / bình luận mới của khách đang chờ xoá → bỏ payload thô ngay
//   khi đặt trạng thái (luồng xoá 9.2 đã quét `webhook_events` ở giai đoạn 1, mục tới sau đó không ai xoá).
// Idempotent theo khoá mục: ingest chống trùng theo `(page_id, platform_message_id)`, sửa/xoá lặp lại không đổi gì.
import type { Platform, WebhookProduct } from '@ottm/shared'
import { eq } from 'drizzle-orm'
import {
  normalizeFeedChange,
  normalizeInstagramComment,
  normalizeMessagingItem,
  normalizeMessagingReceipt,
  normalizeThreadsReply,
  type CommentPageRef,
  type NormalizedComment,
} from '../../adapters/meta/index.ts'
import type { Db } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import {
  echoFromComment,
  echoFromDm,
  ingestComment,
  ingestDm,
  ingestEcho,
  isSenderPendingDeletion,
  markMessageRemoved,
  markMessageUnhidden,
  markOutboundReceipt,
  updateMessageText,
  type EchoResult,
} from '../inbox/index.ts'
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
  /** Enqueue job đính kèm / hồ sơ khách / thử khớp echo trong transaction ingest. */
  jobs: JobSender
  /** Id app Meta/Threads của máy chủ (`META_APP_ID`…) — phân biệt echo của app mình với Business Suite (Story 4.5). */
  appIds?: readonly string[] | undefined
  now?: () => Date
}

/** Tin của trang vào luồng chưa có hội thoại → chỉ lưu; còn lại (khớp, chèn, chờ thử lại, trùng) → đã route. */
const echoStatus = (r: EchoResult): 'ignored' | 'routed' => (r.status === 'no_conversation' ? 'ignored' : 'routed')

/** Field mục `messaging` mang tin (của khách hoặc của trang) / "đã nhận, đã xem". */
const MESSAGE_FIELDS: ReadonlySet<string> = new Set(['messages', 'message_echoes'])
const RECEIPT_FIELDS: ReadonlySet<string> = new Set(['message_deliveries', 'message_reads'])

/** Nền tảng khả dĩ của một mục theo sản phẩm webhook — để không route chéo (meta ≠ threads). */
export function platformsForProduct(product: WebhookProduct): readonly Platform[] {
  return product === 'threads' ? ['threads'] : ['facebook', 'instagram']
}

export async function routeWebhookEvent(deps: RouteDeps, data: RouteJobData): Promise<RouteResult> {
  const [event] = await deps.db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.id, data.eventId))
  // Story 9.3: payload thô đã dọn theo hạn → không còn gì để route; giữ nguyên trạng thái.
  if (!event || event.payload === null) return 'missing'

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

  const inbox = { db: deps.db, events: deps.events, jobs: deps.jobs, appIds: deps.appIds, now: deps.now }

  // Story 4.3: tin nhắn Messenger / IG Direct → `inbox.ingest`; Story 4.5: tin của chính trang → `inbox.ingestEcho`.
  // Threads không có DM.
  // Story 9.3: tin của khách đang chờ xoá (tới sau khi phần `webhooks` của luồng xoá đã chạy) → bỏ payload thô ngay.
  let dropPayload = false
  if (MESSAGE_FIELDS.has(event.field)) {
    let status: RouteResult = 'ignored'
    if (page.platform !== 'threads' && event.platformPageId) {
      const dm = normalizeMessagingItem(event.payload, event.platformPageId, deps.now?.() ?? new Date())
      if (dm.kind === 'dm') {
        dropPayload = await pendingDeletion(deps.db, await ingestDm(inbox, { pageId: page.id, message: dm }))
        status = 'routed'
      } else if (dm.kind === 'echo') {
        status = echoStatus(await ingestEcho(inbox, { pageId: page.id, echo: echoFromDm(dm) }))
      }
    }
    await setStatus(deps.db, event.id, status, page.id, dropPayload)
    return status
  }

  // Story 4.5: đã nhận / đã xem của tin trang gửi (Messenger `delivery`/`read`, IG `messaging_seen`).
  if (RECEIPT_FIELDS.has(event.field)) {
    let status: RouteResult = 'ignored'
    if (page.platform !== 'threads' && event.platformPageId) {
      const receipt = normalizeMessagingReceipt(event.payload, event.platformPageId)
      if (receipt.kind === 'receipt' && (await markOutboundReceipt(inbox, { pageId: page.id, receipt })).status !== 'missing') status = 'routed'
    }
    await setStatus(deps.db, event.id, status, page.id)
    return status
  }

  // Story 4.4: bình luận FB/IG, trả lời Threads. Thời điểm dự phòng = lúc nhận webhook (ổn định qua các lần retry).
  const normalize = COMMENT_FIELDS[event.product as WebhookProduct][event.field]
  let status: RouteResult = 'ignored'
  if (normalize && event.platformPageId) {
    const comment = normalize(event.payload, { platformAccountId: event.platformPageId, handle: page.handle }, event.receivedAt)
    const ref = (commentId: string) => ({ pageId: page.id, platformMessageId: commentId })
    switch (comment.kind) {
      case 'comment':
        dropPayload = await pendingDeletion(deps.db, await ingestComment(inbox, { pageId: page.id, comment }))
        status = 'routed'
        break
      case 'page_comment':
        status = echoStatus(await ingestEcho(inbox, { pageId: page.id, echo: echoFromComment(comment) }))
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
  await setStatus(deps.db, event.id, status, page.id, dropPayload)
  return status
}

/** Tin vừa ingest (mới hoặc trùng) của khách đang chờ xoá. */
async function pendingDeletion(db: Db, result: { messageId: string }): Promise<boolean> {
  return isSenderPendingDeletion(db, result.messageId)
}

async function setStatus(db: Db, id: string, status: 'routed' | 'ignored', pageId: string | null, dropPayload = false): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ status, pageId, errorCode: null, routedAt: new Date(), ...(dropPayload ? { payload: null } : {}) })
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
