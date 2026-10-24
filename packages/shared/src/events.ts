// Danh mục sự kiện miền (AD-3). Tên `<entity>.<pastVerb>`; payload luôn có `id`,
// `pageId` nếu có. `realtime=true` → platform/realtime chuyển thành NOTIFY cho SSE.
// Đây là khung khởi điểm: story sở hữu sự kiện bổ sung khoá payload khi dựng consumer.
import { z } from 'zod'
import { ErrorCode } from './errors.ts'
import {
  ConfigOwnerType,
  ConversationState,
  DeletionScope,
  KnowledgeStatus,
  PauseReason,
  StateChangeReason,
  WebhookProduct,
} from './enums.ts'

const Id = z.string().min(1)

/** Khoá bắt buộc của mọi payload. */
export const BasePayload = z.object({
  id: Id,
  pageId: Id.optional(),
  /** Phiên bản thực thể, để consumer idempotent theo `(event, id, version)`. */
  version: z.number().int().nonnegative().optional(),
})

export interface EventDef<P extends z.ZodType = z.ZodType> {
  payload: P
  realtime: boolean
}

function event<S extends z.ZodRawShape>(realtime: boolean, extra: S) {
  return { payload: BasePayload.extend(extra), realtime } satisfies EventDef
}

export const EVENTS = {
  'conversation.state_changed': event(true, {
    pageId: Id,
    from: ConversationState,
    to: ConversationState,
    reasonCode: StateChangeReason,
  }),
  // Story 4.4: hội thoại đổi phần hiển thị không phải trạng thái (caption bài được bình luận lấy xong).
  'conversation.updated': event(true, { pageId: Id }),
  // Story 5.4: lượt AI trả lời bắt đầu/kết thúc gõ (`aiTyping` của `ConversationDto`) — web chỉ làm cũ hội thoại + tin.
  'conversation.ai_typing': event(true, { pageId: Id }),
  'message.received': event(true, { pageId: Id, conversationId: Id }),
  'message.sent': event(true, { pageId: Id, conversationId: Id }),
  'message.failed': event(true, { pageId: Id, conversationId: Id, errorCode: ErrorCode }),
  // Story 4.3: tin đã có đổi phần hiển thị (đính kèm tải xong/lỗi); Story 4.4: bình luận bị sửa/xoá/ẩn/bỏ ẩn.
  'message.updated': event(true, { pageId: Id, conversationId: Id }),
  // Story 4.3: thông tin khách đổi (tên lấy từ Meta); Story 4.9: hồ sơ (thẻ, giai đoạn, ghi chú, SĐT, tóm tắt AI). `id` = contactId.
  'contact.updated': event(true, {}),
  // Story 4.9: khách `id` đã được gộp vào khách `intoId` (đã xoá) — web làm cũ danh sách, đóng hồ sơ cũ.
  'contact.merged': event(true, { intoId: Id }),
  'post_target.published': event(true, { pageId: Id, campaignId: Id.nullable() }),
  'post_target.failed': event(true, { pageId: Id, campaignId: Id.nullable(), errorCode: ErrorCode }),
  'post_target.cancelled': event(true, { pageId: Id, campaignId: Id.nullable() }),
  // Story 7.2: nội dung / trạng thái slot đổi ngoài request của chủ shop (AI sinh xong caption / ảnh) hoặc do Sửa / Tạo lại
  // — web làm cũ xem trước chiến dịch + Lịch.
  'post_target.updated': event(true, { pageId: Id, campaignId: Id.nullable() }),
  // Story 7.3: chiến dịch vừa bắt đầu (cả lịch slot vừa được tạo) — web làm cũ danh sách chiến dịch + Lịch nội dung.
  'campaign.started': event(true, {}),
  // Story 7.6: `pausedAt` = lúc chiến dịch vào `paused` (giữ nguyên khi lý do hệ thống đè `MANUAL`) — thông báo chống trùng
  // theo `(id, reason, pausedAt)`: dừng lại lần sau vẫn báo, giao lại không nhân đôi.
  'campaign.paused': event(true, { reason: PauseReason, pausedAt: z.iso.datetime() }),
  'campaign.resumed': event(true, {}),
  'campaign.completed': event(true, {}),
  // Story 7.5: chiến dịch đã xoá (bài chưa đăng đã huỷ hàng loạt, không phát `post_target.cancelled` từng bài) — web làm
  // cũ danh sách chiến dịch + Lịch nội dung.
  'campaign.deleted': event(true, {}),
  'page.connected': event(true, {}),
  'page.reconnected': event(true, {}),
  // Story 7.6: `disconnectedAt` = lúc chuyển `disconnected` (thông báo `page_disconnected` chống trùng theo mốc này).
  'page.disconnected': event(true, { reason: z.string().optional(), disconnectedAt: z.iso.datetime().optional() }),
  'page.expiring': event(true, { expiresAt: z.iso.datetime() }),
  'page.removed': event(true, {}),
  'page.group_changed': event(true, { fromGroupId: Id.nullable(), toGroupId: Id.nullable() }),
  // Story 2.5: `id` = groupId đã xoá; `memberPageIds` = các trang vừa bị gỡ khỏi nhóm (Epic 3 giữ cấu hình).
  'group.deleted': event(true, { groupId: Id, memberPageIds: z.array(Id) }),
  // Story 6.3: ô ảnh AI đã có file (`created`) hoặc không tạo được (`failed`, `IMAGE_REJECTED`/`IMAGE_FAILED`).
  'media_asset.created': event(true, {}),
  'media_asset.failed': event(true, { errorCode: ErrorCode }),
  // Story 5.2: job trích văn bản kết thúc một mục kho kiến thức. `pageId` có khi chủ là trang.
  'knowledge_item.processed': event(true, { ownerType: ConfigOwnerType, ownerId: Id, status: KnowledgeStatus }),
  'ai_budget.threshold_reached': event(true, { level: z.union([z.literal(80), z.literal(100)]) }),
  'ai_budget.restored': event(true, {}),
  'openai_key.invalidated': event(true, {}),
  'settings.updated': event(true, { keys: z.array(z.string()) }),
  'webhook.stalled': event(true, { product: WebhookProduct }),
  'webhook.recovered': event(true, { product: WebhookProduct }),
  // Story 1.4: module `notifications` vừa tạo một thông báo — web refetch danh sách + hiện toast.
  'notification.created': event(true, {}),
  'job.failed': event(false, { queue: z.string(), jobId: Id }),
  'privacy.purge_requested': event(false, {
    scope: DeletionScope,
    targetId: Id.nullable(),
    conversationIds: z.array(Id).optional(),
  }),
  'privacy.purge_part_completed': event(false, { module: z.string() }),
  'privacy.purge_completed': event(false, {}),
} as const satisfies Record<string, EventDef>

export type EventName = keyof typeof EVENTS
export type EventPayload<N extends EventName> = z.infer<(typeof EVENTS)[N]['payload']>

export const EVENT_NAMES = Object.keys(EVENTS) as EventName[]

export function isEventName(name: string): name is EventName {
  return Object.hasOwn(EVENTS, name)
}

export function parseEventPayload<N extends EventName>(name: N, data: unknown): EventPayload<N> {
  return EVENTS[name].payload.parse(data) as EventPayload<N>
}

/** Giới hạn byte (UTF-8) của payload NOTIFY realtime (AD-3). */
export const REALTIME_HINT_MAX_BYTES = 1024

/**
 * Gợi ý realtime gửi qua NOTIFY → SSE. Chỉ để client vô hiệu hoá cache rồi refetch REST,
 * không mang nội dung thực thể (AD-3).
 */
export const RealtimeHint = z.object({
  type: z.string().min(1),
  /** Phần trước dấu chấm của tên sự kiện, vd `post_target` của `post_target.failed`. */
  entity: z.string().min(1),
  id: Id,
  pageId: Id.optional(),
})
export type RealtimeHint = z.infer<typeof RealtimeHint>

/** Tên thực thể của một sự kiện: phần trước dấu chấm đầu tiên. */
export function eventEntity(name: string): string {
  const dot = name.indexOf('.')
  return dot === -1 ? name : name.slice(0, dot)
}

/** Dựng `{type, entity, id, pageId}` từ payload đã kiểm (bỏ mọi khoá khác). */
export function realtimeHint<N extends EventName>(name: N, payload: EventPayload<N>): RealtimeHint {
  const { id, pageId } = payload as { id: string; pageId?: string }
  return { type: name, entity: eventEntity(name), id, ...(pageId !== undefined ? { pageId } : {}) }
}
