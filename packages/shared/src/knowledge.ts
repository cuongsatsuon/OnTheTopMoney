// Kho kiến thức của cấu hình AI trả lời (Story 5.2, AD-14, AD-16, AD-24). Mỗi mục thuộc một chủ `(ownerType, ownerId)`
// như `autoreply_configs` và kế thừa Nhóm→Trang cùng cấu hình AI. FAQ `ready` ngay; file (pdf/docx/txt) lưu kho riêng
// tư rồi job `profiles.knowledge.extract` trích văn bản → `ready|failed|too_large`. Prompt (5.3/5.4) nhét toàn bộ
// văn bản `ready` + FAQ — không RAG ở v1 — nên tổng token bị giới hạn.
import { z } from 'zod'
import { ConfigOwnerType, KnowledgeStatus } from './enums.ts'

const IsoDateTime = z.iso.datetime({ offset: false })

/** Giới hạn tổng token `ready` (file + FAQ) của một chủ [ASSUMPTION AD-16]. Vượt → không lưu được cấu hình đang bật. */
export const KNOWLEDGE_MAX_TOKENS = 40_000
/** Số mục tối đa mỗi chủ. */
export const KNOWLEDGE_ITEMS_MAX = 100
/** Kích thước file tối đa (giới hạn file raw của gói Cloudinary Free — AD-14). */
export const KNOWLEDGE_FILE_MAX_BYTES = 10 * 1024 * 1024
export const KNOWLEDGE_QUESTION_MAX = 300
export const KNOWLEDGE_ANSWER_MAX = 4000
export const KNOWLEDGE_FILE_NAME_MAX = 255
/** Header mang tên file (percent-encoded) khi tải file lên — body là bytes của file. */
export const KNOWLEDGE_FILE_NAME_HEADER = 'x-file-name'

export const KNOWLEDGE_KINDS = ['faq', 'file'] as const
export const KnowledgeKind = z.enum(KNOWLEDGE_KINDS)
export type KnowledgeKind = z.infer<typeof KnowledgeKind>

/** Loại file nhận (kiểm bằng magic bytes ở server). Đuôi file chỉ để web chọn `Content-Type`. */
export const KNOWLEDGE_FILE_TYPES = [
  { mime: 'application/pdf', ext: 'pdf', label: 'PDF' },
  { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', label: 'DOCX' },
  { mime: 'text/plain', ext: 'txt', label: 'TXT' },
] as const
export const KNOWLEDGE_FILE_MIMES = KNOWLEDGE_FILE_TYPES.map((t) => t.mime) as [
  (typeof KNOWLEDGE_FILE_TYPES)[number]['mime'],
  ...(typeof KNOWLEDGE_FILE_TYPES)[number]['mime'][],
]
export const KnowledgeFileMime = z.enum(KNOWLEDGE_FILE_MIMES)
export type KnowledgeFileMime = z.infer<typeof KnowledgeFileMime>

/**
 * Lý do mục không dùng được (FE hiển thị câu tiếng Việt):
 * - `UNREADABLE`: file hỏng / không đọc được; `NO_TEXT`: không có chữ (PDF chỉ có ảnh scan);
 * - `PASSWORD_PROTECTED`: PDF có mật khẩu; `EXTRACT_TIMEOUT`: đọc quá lâu (bị dừng);
 * - `FILE_UNAVAILABLE`: không tải được file từ kho riêng tư;
 * - `KNOWLEDGE_TOO_LARGE` (status `too_large`): mục tự nó, hoặc cộng vào kho của cấu hình đang bật, vượt giới hạn.
 */
export const KNOWLEDGE_ERRORS = ['UNREADABLE', 'NO_TEXT', 'PASSWORD_PROTECTED', 'EXTRACT_TIMEOUT', 'FILE_UNAVAILABLE', 'KNOWLEDGE_TOO_LARGE'] as const
export const KnowledgeError = z.enum(KNOWLEDGE_ERRORS)
export type KnowledgeError = z.infer<typeof KnowledgeError>

/** Body `POST /api/v1/knowledge-items/:ownerType/:ownerId/faqs`. */
export const AddKnowledgeFaqRequest = z
  .object({
    question: z.string().trim().min(1, 'Nhập câu hỏi').max(KNOWLEDGE_QUESTION_MAX, `Câu hỏi tối đa ${KNOWLEDGE_QUESTION_MAX} ký tự`),
    answer: z.string().trim().min(1, 'Nhập câu trả lời').max(KNOWLEDGE_ANSWER_MAX, `Câu trả lời tối đa ${KNOWLEDGE_ANSWER_MAX} ký tự`),
  })
  .strict()
export type AddKnowledgeFaqRequest = z.infer<typeof AddKnowledgeFaqRequest>

/** Một mục kho (không trả văn bản đã trích). `title` = câu hỏi (FAQ) hoặc tên file. */
export const KnowledgeItemDto = z.object({
  id: z.uuid(),
  ownerType: ConfigOwnerType,
  ownerId: z.uuid(),
  kind: KnowledgeKind,
  title: z.string(),
  /** Câu trả lời của FAQ; `null` với file. */
  answer: z.string().nullable(),
  status: KnowledgeStatus,
  /** Token ước tính; `null` khi đang xử lý hoặc lỗi. Có cả ở `too_large` (để báo kích thước). */
  tokenCount: z.number().int().nonnegative().nullable(),
  errorCode: KnowledgeError.nullable(),
  fileMime: KnowledgeFileMime.nullable(),
  fileBytes: z.number().int().nonnegative().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type KnowledgeItemDto = z.infer<typeof KnowledgeItemDto>

/** `GET /api/v1/knowledge-items/:ownerType/:ownerId` — kho của chủ (cũ → mới) + tổng token `ready`. */
export const KnowledgeListResponse = z.object({
  items: z.array(KnowledgeItemDto),
  readyTokens: z.number().int().nonnegative(),
  maxTokens: z.number().int().positive(),
})
export type KnowledgeListResponse = z.infer<typeof KnowledgeListResponse>
