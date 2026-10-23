// Trung tâm thông báo (Story 1.4). Chỉ entrypoint gọi module này (AD-1); module khác báo qua sự kiện.
// - `handleEvent`: consumer queue `events.notifications` — sự kiện → thông báo theo cài đặt bật/tắt,
//   idempotent theo `(event, id, version)` (không có version → các trường ổn định của payload) bằng
//   `dedupe_key` unique; tạo xong phát `notification.created`.
// - `listNotifications`, `markNotificationsRead`: cho REST của api.
import {
  type EventName,
  type EventPayload,
  type ListNotificationsResponse,
  type MarkNotificationsReadRequest,
  type Notification,
  type NotificationType,
  type PauseReason,
  type StateChangeReason,
} from '@ottm/shared'
import { and, count, desc, eq, gt, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import type { EventEnvelope, EventPublisher } from '../../platform/events/index.ts'
import { getNotificationPrefs } from '../settings/index.ts'
import { notifications } from './schema.ts'

export interface NotificationDraft {
  type: NotificationType
  title: string
  body: string
  entity: string
  entityId: string
  pageId: string | null
}

export interface HandleEventDeps {
  db: Db
  events: EventPublisher
  /** Queue có `critical: true` trong registry (job hết retry ở đó → `system_error`). */
  isCriticalQueue: (queue: string) => boolean
}

const HANDOFF_REASON_TEXT: Partial<Record<StateChangeReason, string>> = {
  KEYWORD: 'Khách nhắc tới từ khoá cần bạn xử lý.',
  CUSTOMER_ASKED_HUMAN: 'Khách muốn nói chuyện với người thật.',
  AI_UNCERTAIN: 'AI chưa chắc câu trả lời.',
  AI_POLICY_BLOCKED: 'AI không được phép trả lời nội dung này.',
  NON_TEXT_MESSAGE: 'Khách gửi nội dung AI chưa đọc được.',
  OUTSIDE_HOURS: 'Tin tới ngoài giờ AI trả lời.',
  OUTSIDE_24H: 'Đã quá 24 giờ kể từ tin cuối của khách.',
  OTHER_COMMENTER: 'Có người khác bình luận trong luồng AI đang trả lời.',
  AI_BUDGET_EXCEEDED: 'Đã dùng hết hạn mức AI tháng này.',
  OPENAI_KEY_UNAVAILABLE: 'Khoá OpenAI chưa dùng được.',
  AI_PROVIDER_ERROR: 'AI đang gặp sự cố.',
  CONFIG_MISSING: 'AI còn thiếu cấu hình cho trang này.',
}

const PAUSE_REASON_TEXT: Record<Exclude<PauseReason, 'MANUAL'>, string> = {
  PAGE_DISCONNECTED: 'Trang trong chiến dịch mất kết nối. Kết nối lại rồi tiếp tục chiến dịch.',
  AI_BUDGET_EXCEEDED: 'Đã dùng hết hạn mức AI tháng này. Tăng hạn mức rồi tiếp tục chiến dịch.',
  PUBLISH_FAILURES: 'Nhiều bài đăng lỗi liên tiếp. Kiểm tra lịch nội dung rồi tiếp tục chiến dịch.',
  CONFIG_MISSING: 'Chiến dịch còn thiếu cấu hình. Hoàn tất cài đặt rồi tiếp tục.',
}

const VN_DATE = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

function payloadOf<N extends EventName>(envelope: EventEnvelope, name: N): EventPayload<N> | null {
  return envelope.event === name ? (envelope.payload as EventPayload<N>) : null
}

/** Sự kiện → bản nháp thông báo, hoặc null khi sự kiện này không cần báo. */
export function draftFor(envelope: EventEnvelope, isCriticalQueue: (queue: string) => boolean): NotificationDraft | null {
  const handoff = payloadOf(envelope, 'conversation.state_changed')
  if (handoff) {
    if (handoff.to !== 'handoff') return null
    const reason = HANDOFF_REASON_TEXT[handoff.reasonCode]
    return {
      type: 'ai_handoff',
      title: 'AI chuyển một hội thoại cho bạn',
      body: `${reason ? `${reason} ` : ''}Mở Hộp thư để trả lời khách.`,
      entity: 'conversation',
      entityId: handoff.id,
      pageId: handoff.pageId,
    }
  }
  const expiring = payloadOf(envelope, 'page.expiring')
  if (expiring) {
    return {
      type: 'token_expiring',
      title: 'Kết nối trang sắp hết hạn',
      body: `Hết hạn ngày ${VN_DATE.format(new Date(expiring.expiresAt))}. Kết nối lại để không gián đoạn.`,
      entity: 'page',
      entityId: expiring.id,
      pageId: expiring.pageId ?? expiring.id,
    }
  }
  const failed = payloadOf(envelope, 'post_target.failed')
  if (failed) {
    return {
      type: 'publish_failed',
      title: 'Một bài viết không đăng được',
      body: 'Mở Lịch nội dung để xem lỗi và đăng lại.',
      entity: 'post_target',
      entityId: failed.id,
      pageId: failed.pageId,
    }
  }
  const paused = payloadOf(envelope, 'campaign.paused')
  if (paused) {
    // Chủ shop tự tạm dừng thì không cần báo lại.
    if (paused.reason === 'MANUAL') return null
    return {
      type: 'campaign_paused',
      title: 'Chiến dịch đã tạm dừng',
      body: PAUSE_REASON_TEXT[paused.reason],
      entity: 'campaign',
      entityId: paused.id,
      pageId: paused.pageId ?? null,
    }
  }
  const jobFailed = payloadOf(envelope, 'job.failed')
  if (jobFailed) {
    if (!isCriticalQueue(jobFailed.queue)) return null
    return {
      type: 'system_error',
      title: 'Một việc chạy nền bị lỗi',
      body: `Việc "${jobFailed.queue}" (mã ${jobFailed.jobId}) đã thử lại hết số lần vẫn lỗi. Tìm mã này trong nhật ký worker để xem nguyên nhân.`,
      entity: 'job',
      entityId: jobFailed.jobId,
      pageId: null,
    }
  }
  return null
}

/**
 * Khoá chống trùng `(event, id, version)`. Không có version → các trường ổn định phân biệt lần xảy ra,
 * để phát lại cùng một sự kiện (vd `page.expiring` hằng ngày cho cùng hạn) chỉ tạo một thông báo.
 */
export function dedupeKey(envelope: EventEnvelope): string {
  const { id, version } = envelope.payload as { id: string; version?: number }
  return `${envelope.event}:${id}:${version !== undefined ? `v${version}` : stableFields(envelope).join(':')}`
}

function stableFields(envelope: EventEnvelope): string[] {
  const p = envelope.payload as Record<string, unknown>
  switch (envelope.event) {
    case 'page.expiring':
      return [String(p.expiresAt)]
    case 'conversation.state_changed':
      return [String(p.to), String(p.reasonCode)]
    case 'post_target.failed':
      return [String(p.errorCode)]
    case 'campaign.paused':
      return [String(p.reason)]
    case 'job.failed':
      return [String(p.queue), String(p.jobId)]
    default:
      return []
  }
}

export type HandleEventResult = 'created' | 'duplicate' | 'disabled' | 'ignored'

export async function handleEvent(deps: HandleEventDeps, envelope: EventEnvelope): Promise<HandleEventResult> {
  const draft = draftFor(envelope, deps.isCriticalQueue)
  if (!draft) return 'ignored'
  return deps.db.transaction(async (tx) => {
    const prefs = await getNotificationPrefs(tx)
    if (!prefs[draft.type]) return 'disabled'
    const [row] = await tx
      .insert(notifications)
      .values({ ...draft, dedupeKey: dedupeKey(envelope) })
      .onConflictDoNothing({ target: notifications.dedupeKey })
      .returning({ id: notifications.id })
    if (!row) return 'duplicate'
    await deps.events.publishEvent(tx, 'notification.created', {
      id: row.id,
      ...(draft.pageId ? { pageId: draft.pageId } : {}),
    })
    return 'created'
  })
}

type Row = typeof notifications.$inferSelect

function toNotification(row: Row): Notification {
  return {
    id: row.id,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    entity: row.entity,
    entityId: row.entityId,
    pageId: row.pageId,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function unreadCount(db: DbExecutor): Promise<number> {
  const [row] = await db.select({ n: count() }).from(notifications).where(isNull(notifications.readAt))
  return row?.n ?? 0
}

export async function listNotifications(
  db: Db,
  query: { since?: string | undefined; cursor?: string | undefined; limit: number },
): Promise<ListNotificationsResponse> {
  const where: SQL[] = []
  if (query.since) where.push(gt(notifications.createdAt, new Date(query.since)))
  if (query.cursor) where.push(lt(notifications.id, query.cursor))
  const rows = await db
    .select()
    .from(notifications)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(notifications.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  return {
    items: page.map(toNotification),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    unreadCount: await unreadCount(db),
  }
}

export async function markNotificationsRead(db: Db, request: MarkNotificationsReadRequest): Promise<number> {
  // id đã kiểm `z.uuid()` ở `MarkNotificationsReadRequest`.
  const ids = 'ids' in request ? request.ids : null
  await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(and(isNull(notifications.readAt), ids ? inArray(notifications.id, ids) : undefined))
  return unreadCount(db)
}

/** Dùng trong test/tiện ích: một thông báo theo id. */
export async function getNotification(db: DbExecutor, id: string): Promise<Notification | null> {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id))
  return row ? toNotification(row) : null
}
