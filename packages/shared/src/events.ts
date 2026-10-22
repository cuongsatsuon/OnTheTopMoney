// Danh mục sự kiện miền (AD-3). Tên `<entity>.<pastVerb>`; payload luôn có `id`,
// `pageId` nếu có. `realtime=true` → platform/realtime chuyển thành NOTIFY cho SSE.
// Đây là khung khởi điểm: story sở hữu sự kiện bổ sung khoá payload khi dựng consumer.
import { z } from 'zod'
import { ErrorCode } from './errors.ts'
import {
  ConversationState,
  DeletionScope,
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
  'message.received': event(true, { pageId: Id, conversationId: Id }),
  'message.sent': event(true, { pageId: Id, conversationId: Id }),
  'message.failed': event(true, { pageId: Id, conversationId: Id, errorCode: ErrorCode }),
  'post_target.published': event(true, { pageId: Id, campaignId: Id.nullable() }),
  'post_target.failed': event(true, { pageId: Id, campaignId: Id.nullable(), errorCode: ErrorCode }),
  'post_target.cancelled': event(true, { pageId: Id, campaignId: Id.nullable() }),
  'campaign.paused': event(true, { reason: PauseReason }),
  'campaign.resumed': event(true, {}),
  'campaign.completed': event(true, {}),
  'page.connected': event(true, {}),
  'page.reconnected': event(true, {}),
  'page.disconnected': event(true, { reason: z.string().optional() }),
  'page.expiring': event(true, { expiresAt: z.iso.datetime() }),
  'page.removed': event(true, {}),
  'page.group_changed': event(true, { fromGroupId: Id.nullable(), toGroupId: Id.nullable() }),
  // Story 2.5: `id` = groupId đã xoá; `memberPageIds` = các trang vừa bị gỡ khỏi nhóm (Epic 3 giữ cấu hình).
  'group.deleted': event(true, { groupId: Id, memberPageIds: z.array(Id) }),
  'media_asset.created': event(true, {}),
  'knowledge_item.processed': event(true, {}),
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
