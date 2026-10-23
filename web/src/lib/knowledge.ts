// Kho kiến thức (Story 5.2) phía web: mục "Kho kiến thức" của form AI trả lời (`/ai-tra-loi`, tab "AI trả lời" của
// Chi tiết trang/nhóm) với nhóm/trang thật. Thay đổi kho áp ngay (không chờ "Lưu cấu hình"). Tải file gửi NGUYÊN bytes
// (`Content-Type` theo đuôi file, tên ở header `X-File-Name`). Dòng đang xử lý tự cập nhật khi server phát
// `knowledge_item.processed` (khoá gốc `knowledge_items` khớp thực thể `knowledge_item` của realtime).
// Phần thuần (chữ hiển thị từng dòng, kiểm file trước khi gửi, mức dùng token) tách khỏi hook để test được.
import {
  AddKnowledgeFaqRequest,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_FILE_NAME_HEADER,
  KNOWLEDGE_FILE_TYPES,
  KnowledgeItemDto,
  KnowledgeListResponse,
  type KnowledgeError,
  type KnowledgeFileMime,
} from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, isApiError } from './api'
import { errorMessageOf } from './error-messages'

export interface KnowledgeOwner {
  ownerType: 'group' | 'page'
  ownerId: string
}

/* ---------- Phần thuần ---------- */

/** Đuôi file (không phân biệt hoa thường) → MIME gửi lên; loại không nhận → `null`. Server kiểm lại bằng magic bytes. */
export function knowledgeMimeOf(fileName: string): KnowledgeFileMime | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return KNOWLEDGE_FILE_TYPES.find((t) => t.ext === ext)?.mime ?? null
}

/** `accept` của ô chọn file. */
export const KNOWLEDGE_FILE_ACCEPT = KNOWLEDGE_FILE_TYPES.map((t) => `.${t.ext}`).join(',')
export const KNOWLEDGE_FILE_HINT = 'PDF, DOCX hoặc TXT · tối đa 10 MB'

/** Kiểm sớm trước khi gửi (cùng luật đuôi/kích thước của server) → câu lỗi, hoặc `null` khi gửi được. */
export function knowledgeFileIssue(file: { name: string; size: number }): string | null {
  if (!knowledgeMimeOf(file.name)) return 'Chỉ nhận file PDF, DOCX hoặc TXT.'
  if (file.size === 0) return 'File đang trống.'
  if (file.size > KNOWLEDGE_FILE_MAX_BYTES) return 'File tối đa 10 MB. Chia nhỏ hoặc rút gọn rồi tải lại.'
  return null
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
}

export const formatTokens = (n: number): string => `~${n.toLocaleString('vi-VN')} token`

/** Lý do mục không dùng được (câu ngắn, động từ đi đầu khi có việc cần làm). */
export const KNOWLEDGE_ERROR_TEXT: Record<KnowledgeError, string> = {
  UNREADABLE: 'Không đọc được file. Kiểm tra file rồi tải lại.',
  NO_TEXT: 'File không có chữ (có thể là ảnh scan). Tải bản có chữ hoặc nhập câu hỏi thường gặp.',
  PASSWORD_PROTECTED: 'File có mật khẩu. Bỏ mật khẩu rồi tải lại.',
  EXTRACT_TIMEOUT: 'Đọc file quá lâu. Chia nhỏ file rồi tải lại.',
  FILE_UNAVAILABLE: 'Không lấy được file từ kho lưu trữ. Tải lại file.',
  KNOWLEDGE_TOO_LARGE: 'Vượt giới hạn kho kiến thức. Rút gọn file hoặc xoá bớt mục khác rồi tải lại.',
}

export type KnowledgeTone = 'normal' | 'busy' | 'danger' | 'warning'

/** Dòng phụ dưới tiêu đề của một mục + tông màu. */
export function knowledgeItemLine(item: KnowledgeItemDto): { text: string; tone: KnowledgeTone } {
  if (item.kind === 'faq') return { text: item.answer ?? '', tone: 'normal' }
  const type = KNOWLEDGE_FILE_TYPES.find((t) => t.mime === item.fileMime)?.label ?? 'File'
  const meta = [type, item.fileBytes !== null ? formatBytes(item.fileBytes) : null].filter(Boolean).join(' · ')
  switch (item.status) {
    case 'processing':
      return { text: `${meta} · AI đang đọc nội dung…`, tone: 'busy' }
    case 'ready':
      return { text: `${meta} · ${formatTokens(item.tokenCount ?? 0)}`, tone: 'normal' }
    case 'too_large':
      return { text: `${meta}${item.tokenCount !== null ? ` · ${formatTokens(item.tokenCount)}` : ''} · ${KNOWLEDGE_ERROR_TEXT.KNOWLEDGE_TOO_LARGE}`, tone: 'warning' }
    default:
      return { text: `${meta} · ${KNOWLEDGE_ERROR_TEXT[item.errorCode ?? 'UNREADABLE']}`, tone: 'danger' }
  }
}

/** Mức dùng kho: tổng token `ready` / giới hạn. `over` = không bật được AI cho tới khi rút gọn. */
export function knowledgeUsage(list: Pick<KnowledgeListResponse, 'readyTokens' | 'maxTokens'>): { text: string; over: boolean; ratio: number } {
  const over = list.readyTokens > list.maxTokens
  return {
    text: `Đang dùng ${formatTokens(list.readyTokens)} / ${list.maxTokens.toLocaleString('vi-VN')}`,
    over,
    ratio: Math.min(1, list.readyTokens / list.maxTokens),
  }
}

export const KNOWLEDGE_TOO_LARGE_MESSAGE = 'Kho kiến thức vượt giới hạn nên chưa bật được AI. Cần rút gọn kho kiến thức: xoá bớt mục hoặc tải bản ngắn hơn.'

/** Lỗi thêm/tải: câu riêng cho trang đang theo nhóm và kho vượt giới hạn; lỗi dưới ô (`details`) nếu có. */
export function knowledgeErrorMessage(err: unknown): string {
  if (isApiError(err)) {
    if (err.code === 'KNOWLEDGE_TOO_LARGE') return 'Thêm mục này sẽ làm kho kiến thức vượt giới hạn khi AI đang bật. Rút gọn hoặc xoá bớt mục khác trước.'
    if (err.code === 'VALIDATION_FAILED' && Array.isArray(err.details)) {
      const message = (err.details[0] as { message?: unknown } | undefined)?.message
      if (typeof message === 'string') return message.endsWith('.') ? message : `${message}.`
    }
  }
  return errorMessageOf(err)
}

/* ---------- Hook React Query ---------- */

/** Khoá gốc `knowledge_items` → realtime `knowledge_item.*` làm cũ tự động (`entityMatches` số nhiều). */
export const KNOWLEDGE_KEY = ['knowledge_items'] as const
export const knowledgeKey = (owner: KnowledgeOwner) => ['knowledge_items', owner.ownerType, owner.ownerId] as const
const basePath = (owner: KnowledgeOwner) => `/knowledge-items/${owner.ownerType}/${owner.ownerId}`

export function useKnowledge(owner: KnowledgeOwner, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: knowledgeKey(owner),
    queryFn: ({ signal }) => apiFetch(basePath(owner), { schema: KnowledgeListResponse, signal }),
    enabled: options.enabled ?? true,
    // Dự phòng khi mất realtime: còn mục đang đọc thì hỏi lại mỗi 10 giây.
    refetchInterval: (q) => (q.state.data?.items.some((i) => i.status === 'processing') ? 10_000 : false),
  })
}

export function useAddKnowledgeFaq(owner: KnowledgeOwner) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AddKnowledgeFaqRequest) => apiFetch(`${basePath(owner)}/faqs`, { method: 'POST', body, schema: KnowledgeItemDto }),
    onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeKey(owner) }),
  })
}

export function useUploadKnowledgeFile(owner: KnowledgeOwner) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (file: File) => {
      const mime = knowledgeMimeOf(file.name)
      if (!mime) throw new Error('loại file không hỗ trợ')
      return apiFetch(`${basePath(owner)}/files`, {
        method: 'POST',
        raw: { data: file, contentType: mime, headers: { [KNOWLEDGE_FILE_NAME_HEADER]: encodeURIComponent(file.name) } },
        schema: KnowledgeItemDto,
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeKey(owner) }),
  })
}

export function useDeleteKnowledgeItem(owner: KnowledgeOwner) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/knowledge-items/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeKey(owner) }),
  })
}
