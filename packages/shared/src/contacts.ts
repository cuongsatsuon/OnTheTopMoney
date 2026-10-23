// Khách hàng (Story 4.9, AD-11, AD-18): DTO, query và body của `/api/v1/contacts`. Module `inbox` là chủ duy nhất của
// khách; `pageIds` và `handledBy` là trường dẫn xuất, ghép ở `server/src/app/read-models/contacts.ts`.
// - Danh sách theo phạm vi: khách thuộc phạm vi khi có định danh trên trang của phạm vi. Lọc giai đoạn / thẻ / chữ.
// - Hồ sơ sửa được: tên, SĐT, ghi chú, thẻ tự do, giai đoạn (`ContactStage`, FE hiện nhãn tiếng Việt).
// - Lịch sử: tin của mọi hội thoại của khách, mỗi tin ghi rõ trang. Gộp khách chỉ bằng tay (`inbox.mergeContacts`).
// - Tóm tắt bằng AI: job `inbox.contact_summary` (`feature=contact_summary`), FE gắn nhãn "AI tạo".
import { z } from 'zod'
import { ContactStage, ConversationChannel, ConversationState } from './enums.ts'
import { ErrorCode } from './errors.ts'
import { ConversationPreview, INBOX_PAGE_SIZE, MessageDto } from './inbox.ts'

const IsoDateTime = z.iso.datetime({ offset: false })
const Id = z.string().min(1)

/** Giới hạn hồ sơ khách. */
export const CONTACT_NAME_MAX = 200
export const CONTACT_PHONE_MAX = 20
export const CONTACT_NOTE_MAX = 5000
export const CONTACT_TAG_MAX_LENGTH = 40
export const CONTACT_TAGS_MAX = 50

/** Thẻ tự do: cắt khoảng trắng hai đầu, 1–40 ký tự. */
export const ContactTag = z.string().trim().min(1).max(CONTACT_TAG_MAX_LENGTH)

/** Bỏ thẻ trùng (không phân biệt hoa thường), giữ lần xuất hiện đầu. Dùng chung server (lưu) và web (thêm thẻ). */
export function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    const key = tag.toLocaleLowerCase('vi')
    if (!tag || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/** SĐT như chủ shop gõ: số, khoảng trắng, `+-.()`. Chuỗi rỗng → `null` (xoá). */
export const ContactPhone = z
  .string()
  .trim()
  .max(CONTACT_PHONE_MAX)
  .regex(/^[0-9+().\s-]*$/, 'Số điện thoại chỉ gồm chữ số, khoảng trắng và + - . ( )')
  .transform((v) => (v === '' ? null : v))

/** Ai đang xử lý khách: theo trạng thái hội thoại mới nhất (`ai` → AI, còn lại → chủ shop). */
export const CONTACT_HANDLERS = ['ai', 'human'] as const
export const ContactHandledBy = z.enum(CONTACT_HANDLERS)
export type ContactHandledBy = z.infer<typeof ContactHandledBy>

/**
 * Tóm tắt AI: `idle` (chưa yêu cầu / đã xong) · `pending` (job đang chạy, tối đa 10 phút) · `failed` (`aiSummaryError`
 * nói vì sao; `null` = job không chạy xong).
 */
export const AI_SUMMARY_STATUSES = ['idle', 'pending', 'failed'] as const
export const AiSummaryStatus = z.enum(AI_SUMMARY_STATUSES)
export type AiSummaryStatus = z.infer<typeof AiSummaryStatus>

/** Quá lâu không xong thì coi như lỗi (job mất) — cho bấm lại. */
export const AI_SUMMARY_PENDING_MS = 10 * 60_000

export const ContactAiSummary = z.object({
  text: z.string(),
  generatedAt: IsoDateTime,
})
export type ContactAiSummary = z.infer<typeof ContactAiSummary>

/** Hội thoại của khách (rút gọn) — hội thoại mới nhất ở danh sách, mọi hội thoại ở chi tiết. */
export const ContactConversation = z.object({
  id: Id,
  pageId: Id,
  channel: ConversationChannel,
  state: ConversationState,
  lastMessageAt: IsoDateTime,
  preview: ConversationPreview.nullable(),
})
export type ContactConversation = z.infer<typeof ContactConversation>

export const ContactDto = z.object({
  id: Id,
  /** `null` khi chưa lấy được tên từ Meta và chủ shop chưa đặt — FE hiện nhãn dự phòng. */
  name: z.string().nullable(),
  phone: z.string().nullable(),
  note: z.string().nullable(),
  tags: z.array(z.string()),
  stage: ContactStage,
  /** Trang (chưa gỡ) khách đã nhắn — dẫn xuất từ định danh (read-model). */
  pageIds: z.array(Id),
  /** Dẫn xuất từ hội thoại mới nhất (read-model); `null` khi chưa có hội thoại. */
  handledBy: ContactHandledBy.nullable(),
  /** Hội thoại mới nhất (danh sách: trong phạm vi; chi tiết: mọi trang); `null` khi chưa có. */
  latest: ContactConversation.nullable(),
  aiSummary: ContactAiSummary.nullable(),
  aiSummaryStatus: AiSummaryStatus,
  aiSummaryError: ErrorCode.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type ContactDto = z.infer<typeof ContactDto>

/** Lý do gợi ý gộp: nhắn riêng trả `recipient_id` đã thuộc khách khác (Meta xác nhận cùng người, AD-11). */
export const MERGE_SUGGESTION_REASONS = ['private_reply'] as const
export const MergeSuggestionReason = z.enum(MERGE_SUGGESTION_REASONS)
export type MergeSuggestionReason = z.infer<typeof MergeSuggestionReason>

export const ContactMergeSuggestion = z.object({
  contactId: Id,
  name: z.string().nullable(),
  reason: MergeSuggestionReason,
})
export type ContactMergeSuggestion = z.infer<typeof ContactMergeSuggestion>

export const ContactDetailDto = ContactDto.extend({
  /** Mọi hội thoại của khách trên trang chưa gỡ, mới nhất trước. */
  conversations: z.array(ContactConversation),
  mergeSuggestions: z.array(ContactMergeSuggestion),
})
export type ContactDetailDto = z.infer<typeof ContactDetailDto>

/** `GET /api/v1/contacts?scope=&stage=&tag=&q=&cursor=&limit=` — mới hoạt động nhất trước. `scope` kiểm ở server. */
export const ContactsQuery = z.object({
  stage: ContactStage.optional(),
  /** Khớp thẻ không phân biệt hoa thường. */
  tag: ContactTag.optional(),
  /** Tìm không dấu (Story 4.10): mỗi từ là chuỗi con của tên hoặc một thẻ; hoặc SĐT theo chữ số (≥3). */
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(INBOX_PAGE_SIZE),
})
export type ContactsQuery = z.input<typeof ContactsQuery>

export const ListContactsResponse = z.object({
  items: z.array(ContactDto),
  nextCursor: z.string().nullable(),
})
export type ListContactsResponse = z.infer<typeof ListContactsResponse>

/** `GET /api/v1/contacts/facets?scope=` — số khách theo giai đoạn + mọi thẻ đang dùng trong phạm vi. */
export const ContactFacetsResponse = z.object({
  total: z.number().int().nonnegative(),
  stages: z.record(ContactStage, z.number().int().nonnegative()),
  tags: z.array(z.string()),
})
export type ContactFacetsResponse = z.infer<typeof ContactFacetsResponse>

/** `PATCH /api/v1/contacts/:id` — trường bỏ trống giữ nguyên; ít nhất một trường. Trả `ContactDetailDto`. */
export const UpdateContactBody = z
  .object({
    name: z
      .string()
      .trim()
      .max(CONTACT_NAME_MAX)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
    phone: ContactPhone.nullable().optional(),
    note: z
      .string()
      .trim()
      .max(CONTACT_NOTE_MAX)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
    tags: z.array(ContactTag).max(CONTACT_TAGS_MAX).transform(dedupeTags).optional(),
    stage: ContactStage.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Cần ít nhất một trường' })
export type UpdateContactBody = z.input<typeof UpdateContactBody>

export const CONTACTS_BULK_MAX = 200

/** `POST /api/v1/contacts/bulk` — gắn MỘT thẻ hoặc đổi giai đoạn cho nhiều khách (đúng một thao tác). */
export const BulkUpdateContactsBody = z
  .object({
    ids: z.array(z.uuid()).min(1).max(CONTACTS_BULK_MAX),
    addTag: ContactTag.optional(),
    stage: ContactStage.optional(),
  })
  .refine((b) => (b.addTag === undefined) !== (b.stage === undefined), { message: 'Chọn đúng một thao tác: addTag hoặc stage' })
export type BulkUpdateContactsBody = z.input<typeof BulkUpdateContactsBody>

export const BulkUpdateContactsResponse = z.object({
  updated: z.number().int().nonnegative(),
})
export type BulkUpdateContactsResponse = z.infer<typeof BulkUpdateContactsResponse>

/**
 * `POST /api/v1/contacts/:id/merge {sourceId}` — gộp khách `sourceId` VÀO khách `:id` (giữ lại). Không hoàn tác được.
 * Trả `ContactDetailDto` của khách giữ lại.
 */
export const MergeContactsBody = z.object({
  sourceId: z.uuid(),
})
export type MergeContactsBody = z.input<typeof MergeContactsBody>

/** Một tin trong lịch sử khách: tin của hội thoại kèm trang + kênh để ghi rõ đoạn thuộc trang nào. */
export const ContactHistoryItem = MessageDto.extend({
  pageId: Id,
  channel: ConversationChannel,
})
export type ContactHistoryItem = z.infer<typeof ContactHistoryItem>

/**
 * `GET /api/v1/contacts/:id/messages?cursor=&limit=` — trang tin MỚI NHẤT của mọi hội thoại (không gồm tin `system`),
 * `items` cũ → mới; `nextCursor` trỏ về tin cũ hơn.
 */
export const ContactHistoryQuery = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(INBOX_PAGE_SIZE),
})
export type ContactHistoryQuery = z.input<typeof ContactHistoryQuery>

export const ListContactHistoryResponse = z.object({
  items: z.array(ContactHistoryItem),
  nextCursor: z.string().nullable(),
})
export type ListContactHistoryResponse = z.infer<typeof ListContactHistoryResponse>
