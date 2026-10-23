// Hộp thư (Story 4.3, AD-9, AD-11, AD-18): DTO hội thoại, tin, đính kèm cho REST. Module `inbox` là chủ duy nhất
// của khách/hội thoại/tin; web chỉ đọc qua các schema này và refetch khi có hint realtime (AD-3).
// Story 4.3: DM (Messenger, Instagram Direct). Story 4.4: bình luận Facebook/Instagram và trả lời Threads (`channel=comment`,
// bài được bình luận, tin bị sửa/xoá/ẩn, người trả lời khác trong cùng luồng). Story 4.6: tab lọc/đếm ở server, lệnh
// Tiếp quản / bật lại AI / Đánh dấu xong. Story 4.7: gửi tin / gửi lại (mode theo kênh, giới hạn chữ theo nền tảng, mã lỗi
// gửi tin của tin `failed`). Story 4.8: Gợi ý bằng AI (bản nháp + cụm vi phạm hậu kiểm).
import { z } from 'zod'
import { AiViolation } from './ai.ts'
import {
  ContactStage,
  ConversationChannel,
  ConversationState,
  MessageDelivery,
  MessageDirection,
  MessageOrigin,
  MessageStatus,
  StateChangeReason,
  type Platform,
} from './enums.ts'
import type { ErrorCode } from './errors.ts'

const IsoDateTime = z.iso.datetime({ offset: false })
const Id = z.string().min(1)

/** Loại đính kèm theo `attachments[].type` của Meta; loại lạ → `file`. */
export const ATTACHMENT_KINDS = ['image', 'audio', 'video', 'file'] as const
export const AttachmentKind = z.enum(ATTACHMENT_KINDS)
export type AttachmentKind = z.infer<typeof AttachmentKind>

/**
 * Vòng đời đính kèm của khách: `pending` (đã ghi lúc ingest, job `inbox.fetch_attachment` đang tải về kho riêng
 * tư) → `stored` (đọc được qua `GET /api/v1/attachments/:id`) hoặc `failed` (`errorCode` nói vì sao).
 */
export const ATTACHMENT_STATUSES = ['pending', 'stored', 'failed'] as const
export const AttachmentStatus = z.enum(ATTACHMENT_STATUSES)
export type AttachmentStatus = z.infer<typeof AttachmentStatus>

/** Mã lỗi chẩn đoán của đính kèm `failed` (không thuộc `ErrorCode` của API). */
export const ATTACHMENT_ERRORS = [
  /** Kho riêng tư chưa cấu hình (`CLOUDINARY_URL` trống). */
  'MEDIA_NOT_CONFIGURED',
  /** Định dạng không lưu được (không trong danh sách cho phép). */
  'UNSUPPORTED_TYPE',
  /** Quá giới hạn kích thước. */
  'TOO_LARGE',
  /** URL không thuộc CDN của Meta hoặc hỏng. */
  'INVALID_URL',
  /** Hết lượt thử (CDN/kho lỗi tạm kéo dài, link đã hết hạn…). */
  'FETCH_FAILED',
] as const
export const AttachmentError = z.enum(ATTACHMENT_ERRORS)
export type AttachmentError = z.infer<typeof AttachmentError>

export const AttachmentDto = z.object({
  id: Id,
  kind: AttachmentKind,
  status: AttachmentStatus,
  /** MIME đã lưu; `null` khi chưa tải xong hoặc lỗi. */
  mime: z.string().nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  errorCode: AttachmentError.nullable(),
})
export type AttachmentDto = z.infer<typeof AttachmentDto>

/**
 * Tin bị gỡ trên nền tảng (Story 4.4): `deleted` (khách xoá bình luận) · `hidden` (trang ẩn bình luận). Nội dung vẫn
 * giữ để chủ shop biết khách đã viết gì; FE hiện nhãn.
 */
export const MESSAGE_REMOVALS = ['deleted', 'hidden'] as const
export const MessageRemoval = z.enum(MESSAGE_REMOVALS)
export type MessageRemoval = z.infer<typeof MessageRemoval>

/** Người viết tin inbound (khách). Trong luồng bình luận, người khác trả lời là một khách khác với khách của hội thoại. */
export const MessageSender = z.object({
  contactId: Id,
  name: z.string().nullable(),
})
export type MessageSender = z.infer<typeof MessageSender>

/**
 * Mã lỗi của tin outbound `failed` (AD-10) — tập con của `ErrorCode`: `canSend` từ chối sớm, hoặc job `inbox.send`
 * ánh xạ lỗi Meta. `SEND_UNKNOWN`: kẹt `sending` quá 15 phút (có thể đã tới khách, không tự gửi lại).
 */
export const SEND_ERROR_CODES = [
  'OUTSIDE_24H',
  'PRIVATE_REPLY_USED',
  'PRIVATE_REPLY_INVALID',
  'RECIPIENT_UNAVAILABLE',
  'PAGE_DISCONNECTED',
  'PAGE_REMOVED',
  'RATE_LIMITED',
  'SEND_REJECTED',
  'SEND_FAILED',
  'SEND_UNKNOWN',
] as const satisfies readonly ErrorCode[]
export const SendErrorCode = z.enum(SEND_ERROR_CODES)
export type SendErrorCode = z.infer<typeof SendErrorCode>

export const isSendErrorCode = (code: unknown): code is SendErrorCode => typeof code === 'string' && (SEND_ERROR_CODES as readonly string[]).includes(code)

export const MessageDto = z.object({
  id: Id,
  conversationId: Id,
  /** `null` chỉ với tin `system`. */
  direction: MessageDirection.nullable(),
  origin: MessageOrigin,
  /** Nội dung chữ; `null` khi tin chỉ có đính kèm, tin hệ thống, hoặc tin Meta không hiển thị được. */
  text: z.string().nullable(),
  /** Tin `system`: lý do chuyển trạng thái (FE ánh xạ sang câu tiếng Việt). */
  reasonCode: StateChangeReason.nullable(),
  /** Tin outbound (Story 4.7); `null` với tin khách và tin hệ thống. */
  status: MessageStatus.nullable(),
  /** Tin outbound: cách gửi (`dm` · `public_reply` · `private_reply` — nhắn riêng người bình luận). */
  delivery: MessageDelivery.nullable(),
  /** Tin outbound `failed`: vì sao không gửi được (FE ánh xạ sang câu + gợi ý). */
  errorCode: SendErrorCode.nullable(),
  /** Thời điểm theo nền tảng — thứ tự hiển thị (AD-11). Tin hệ thống: lúc chuyển trạng thái. */
  platformTimestamp: IsoDateTime,
  attachments: z.array(AttachmentDto),
  /** Lần sửa gần nhất trên nền tảng (Story 4.4); `null` khi chưa sửa. */
  editedAt: IsoDateTime.nullable(),
  /** Tin đã bị xoá/ẩn trên nền tảng; `null` khi còn hiện. */
  removal: MessageRemoval.nullable(),
  /** Khách viết tin (chỉ tin inbound có định danh); `null` với tin outbound/hệ thống. */
  sender: MessageSender.nullable(),
})
export type MessageDto = z.infer<typeof MessageDto>

/** Khách của hội thoại. `name` trống khi chưa lấy được tên từ Meta — FE hiện nhãn dự phòng. */
export const ConversationContact = z.object({
  id: Id,
  name: z.string().nullable(),
  stage: ContactStage,
  /** Trang khách đã nhắn (dẫn xuất từ định danh theo trang, AD-11). */
  pageIds: z.array(Id),
})
export type ConversationContact = z.infer<typeof ConversationContact>

/** Tin mới nhất không phải `system` — để xem trước ở danh sách. */
export const ConversationPreview = z.object({
  text: z.string().nullable(),
  origin: MessageOrigin,
  attachmentCount: z.number().int().nonnegative(),
  at: IsoDateTime,
})
export type ConversationPreview = z.infer<typeof ConversationPreview>

/** Bài được bình luận (hội thoại `comment`). `text` = caption lấy một lần lúc ingest; `null` khi chưa/không lấy được. */
export const ConversationPost = z.object({
  /** Id bài dạng chuẩn AD-6 (FB `{pageId}_{postId}`, IG/Threads media id). */
  platformPostId: z.string().min(1),
  text: z.string().nullable(),
})
export type ConversationPost = z.infer<typeof ConversationPost>

export const ConversationDto = z.object({
  id: Id,
  pageId: Id,
  channel: ConversationChannel,
  state: ConversationState,
  aiEnabled: z.boolean(),
  /** Lý do của lần chuyển trạng thái gần nhất; `null` khi chưa chuyển lần nào. */
  stateReason: StateChangeReason.nullable(),
  /** Khách đang chờ trả lời từ lúc này (AD-9); `null` khi không chờ. */
  waitingSince: IsoDateTime.nullable(),
  lastMessageAt: IsoDateTime,
  lastCustomerMessageAt: IsoDateTime.nullable(),
  /** Điều kiện tab "Cần xử lý" (AD-9): `handoff`, hoặc `human` mà tin không phải `system` mới nhất là của khách. */
  needsAttention: z.boolean(),
  contact: ConversationContact,
  preview: ConversationPreview.nullable(),
  /** Hội thoại `comment`: bài được bình luận; `null` với DM. */
  post: ConversationPost.nullable(),
})
export type ConversationDto = z.infer<typeof ConversationDto>

export const INBOX_PAGE_SIZE = 50

/**
 * Tab Hộp thư (Story 4.6, AD-9): `all` = mọi trạng thái (gồm `triage`) · `needs_human` = "Cần xử lý" (`handoff`, hoặc
 * `human` mà tin không phải `system` mới nhất là của khách — cùng điều kiện với badge sidebar) · `ai` = "AI đang trả
 * lời" · `done` = "Đã xong". Server lọc và đếm; web không lọc lại trên trang đã tải.
 */
export const INBOX_TABS = ['all', 'needs_human', 'ai', 'done'] as const
export const InboxTab = z.enum(INBOX_TABS)
export type InboxTab = z.infer<typeof InboxTab>

/**
 * `GET /api/v1/conversations?scope=&tab=&cursor=&limit=` — `needs_human`: chờ lâu nhất trước (theo `waitingSince`);
 * tab khác: tin mới nhất trước. `scope` kiểm bằng `ScopeParam` ở server.
 */
export const ConversationsQuery = z.object({
  tab: InboxTab.default('all'),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(INBOX_PAGE_SIZE),
})
export type ConversationsQuery = z.input<typeof ConversationsQuery>

/** `GET /api/v1/conversations/count?scope=&tab=` — số hội thoại của tab (badge "Cần xử lý": `tab=needs_human`). */
export const ConversationCountQuery = z.object({
  tab: InboxTab.default('all'),
})
export type ConversationCountQuery = z.input<typeof ConversationCountQuery>

export const ConversationCountResponse = z.object({
  count: z.number().int().nonnegative(),
})
export type ConversationCountResponse = z.infer<typeof ConversationCountResponse>

/**
 * Lệnh của chủ shop trên một hội thoại (Story 4.6, AD-9) — `POST /api/v1/conversations/:id/<lệnh>`, trả
 * `ConversationDto` sau khi đổi: `takeover` (Tiếp quản: → `human`, tắt AI) · `enable-ai` (bật lại AI: → `ai`) ·
 * `done` (Đánh dấu xong). Đã ở trạng thái đích → không đổi gì; trạng thái nguồn không hợp lệ → 409.
 */
export const CONVERSATION_ACTIONS = ['takeover', 'enable-ai', 'done'] as const
export const ConversationAction = z.enum(CONVERSATION_ACTIONS)
export type ConversationAction = z.infer<typeof ConversationAction>

export const ListConversationsResponse = z.object({
  items: z.array(ConversationDto),
  nextCursor: z.string().nullable(),
})
export type ListConversationsResponse = z.infer<typeof ListConversationsResponse>

/**
 * `GET /api/v1/conversations/:id/messages?cursor=&limit=` — trang tin MỚI NHẤT, `items` theo thứ tự hiển thị
 * (cũ → mới). `nextCursor` trỏ về các tin cũ hơn; `null` khi đã hết.
 */
export const MessagesQuery = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(INBOX_PAGE_SIZE),
})
export type MessagesQuery = z.input<typeof MessagesQuery>

export const ListMessagesResponse = z.object({
  items: z.array(MessageDto),
  nextCursor: z.string().nullable(),
})
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>

// ---------------------------------------------------------------------------------------------------------
// Gửi tin (Story 4.7, AD-10)
// ---------------------------------------------------------------------------------------------------------

/**
 * Cách gửi hợp lệ theo kênh (AD-10): DM → `dm`; bình luận FB/IG → trả lời công khai hoặc nhắn riêng; Threads chỉ trả lời
 * công khai. Phần tử đầu là mặc định.
 */
export function sendModesFor(platform: Platform, channel: ConversationChannel): readonly MessageDelivery[] {
  if (channel === 'dm') return ['dm']
  return platform === 'threads' ? ['public_reply'] : ['public_reply', 'private_reply']
}

/** Giới hạn ký tự lớn nhất của mọi nền tảng (Messenger 2000). */
export const SEND_TEXT_MAX = 2000

/** Giới hạn ký tự theo nền tảng/cách gửi: Threads 500, tin nhắn Instagram 1000, còn lại 2000. */
export function sendTextLimit(platform: Platform, delivery: MessageDelivery): number {
  if (platform === 'threads') return 500
  if (platform === 'instagram' && delivery !== 'public_reply') return 1000
  return SEND_TEXT_MAX
}

/**
 * `POST /api/v1/conversations/:id/messages` — gửi tin của chủ shop. `mode` bỏ trống → mặc định của kênh. 201 trả
 * `MessageDto` (`pending`); `canSend` từ chối → 409 với mã gửi tin, tin vẫn lưu `failed` (`details.messageId`).
 * Gửi lại: `POST /api/v1/messages/:id/resend` (tin `failed`) → 200 `MessageDto` hoặc 409 như trên.
 */
export const SendMessageBody = z.object({
  text: z.string().trim().min(1).max(SEND_TEXT_MAX),
  mode: MessageDelivery.optional(),
})
export type SendMessageBody = z.input<typeof SendMessageBody>

// ---------------------------------------------------------------------------------------------------------
// Gợi ý bằng AI (Story 4.8, AD-7, AD-21)
// ---------------------------------------------------------------------------------------------------------

/**
 * `POST /api/v1/conversations/:id/suggest` — bản nháp trả lời theo hồ sơ hiệu lực của trang và các tin gần nhất. `mode`
 * bỏ trống → mặc định của kênh (như gửi tin). Chạy trong request (không job); nút "Dừng" = client huỷ request.
 */
export const SuggestReplyBody = z.object({
  mode: MessageDelivery.optional(),
})
export type SuggestReplyBody = z.input<typeof SuggestReplyBody>

/**
 * Bản nháp AI (KHÔNG gửi) — FE điền vào ô soạn. `violations` rỗng = sạch; có = vẫn vi phạm `ai.checkOutput` sau khi
 * sinh lại một lần → FE đánh dấu cụm vi phạm để chủ shop sửa trước khi gửi.
 */
export const SuggestReplyResponse = z.object({
  draft: z.string(),
  violations: z.array(AiViolation),
})
export type SuggestReplyResponse = z.infer<typeof SuggestReplyResponse>
