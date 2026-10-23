// Hộp thư (Story 4.3, AD-9, AD-11, AD-18): DTO hội thoại, tin, đính kèm cho REST. Module `inbox` là chủ duy nhất
// của khách/hội thoại/tin; web chỉ đọc qua các schema này và refetch khi có hint realtime (AD-3).
// Story 4.3: DM (Messenger, Instagram Direct). Story 4.4: bình luận Facebook/Instagram và trả lời Threads (`channel=comment`,
// bài được bình luận, tin bị sửa/xoá/ẩn, người trả lời khác trong cùng luồng).
import { z } from 'zod'
import {
  ContactStage,
  ConversationChannel,
  ConversationState,
  MessageDirection,
  MessageOrigin,
  MessageStatus,
  StateChangeReason,
} from './enums.ts'

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

/** `GET /api/v1/conversations?scope=&cursor=&limit=` — tin mới nhất trước. `scope` kiểm bằng `ScopeParam` ở server. */
export const ConversationsQuery = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(INBOX_PAGE_SIZE),
})
export type ConversationsQuery = z.input<typeof ConversationsQuery>

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
