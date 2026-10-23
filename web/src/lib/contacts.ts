// Khách hàng phía web (Story 4.9, AD-3, AD-11, AD-18): danh sách theo phạm vi + lọc, hồ sơ (thẻ, giai đoạn, ghi chú, SĐT,
// tên), lịch sử nhiều trang, gộp khách, tóm tắt AI. Đọc/ghi qua REST; realtime chỉ làm cũ cache (`contact.*`,
// `message.*`, `conversation.*` → gốc `['contacts', …]`, xem `lib/realtime.ts`). Helper thuần tách để test.
import {
  BulkUpdateContactsResponse,
  CONTACT_STAGES,
  CONTACT_TAG_MAX_LENGTH,
  CONTACT_TAGS_MAX,
  ContactDetailDto,
  ContactFacetsResponse,
  ContactPhone,
  ListContactHistoryResponse,
  ListContactsResponse,
  dedupeTags,
  type BulkUpdateContactsBody,
  type ContactDto,
  type ContactHistoryItem,
  type ContactStage,
  type ConversationChannel,
  type Scope,
  type UpdateContactBody,
} from '@ottm/shared'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './api'
import { errorMessage } from './error-messages'
import { CONVERSATIONS_KEY, serverScope } from './inbox'

export const CONTACTS_KEY = ['contacts'] as const

export interface ContactFilters {
  stage: ContactStage | null
  tag: string | null
  q: string
}

export const contactsListKey = (scope: string | null, f: ContactFilters) => ['contacts', 'list', scope, f.stage, f.tag, f.q.trim()] as const
export const contactsFacetsKey = (scope: string | null) => ['contacts', 'facets', scope] as const
export const contactKey = (id: string) => ['contacts', 'detail', id] as const
export const contactHistoryKey = (id: string) => ['contacts', 'history', id] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Chuỗi query của danh sách khách (phạm vi đã đổi sang dạng server, bộ lọc trống thì bỏ). */
export function contactsQueryString(scope: string, f: ContactFilters, cursor: string | null): string {
  const qs = new URLSearchParams({ scope })
  if (f.stage) qs.set('stage', f.stage)
  if (f.tag) qs.set('tag', f.tag)
  if (f.q.trim()) qs.set('q', f.q.trim())
  if (cursor) qs.set('cursor', cursor)
  return qs.toString()
}

const EMPTY_LIST: ListContactsResponse = { items: [], nextCursor: null }
const EMPTY_FACETS: ContactFacetsResponse = { total: 0, stages: { new: 0, consulting: 0, ordered: 0, loyal: 0, complaint: 0 }, tags: [] }

/** Khách theo phạm vi + bộ lọc (server lọc); "Xem thêm" bằng `fetchNextPage`. */
export function useContacts(scope: Scope, f: ContactFilters) {
  const param = serverScope(scope)
  return useInfiniteQuery({
    queryKey: contactsListKey(param, f),
    queryFn: ({ signal, pageParam }) =>
      param === null ? Promise.resolve(EMPTY_LIST) : apiFetch(`/contacts?${contactsQueryString(param, f, pageParam)}`, { schema: ListContactsResponse, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
}

/** Số khách theo giai đoạn + thẻ đang dùng trong phạm vi. */
export function useContactFacets(scope: Scope) {
  const param = serverScope(scope)
  return useQuery({
    queryKey: contactsFacetsKey(param),
    queryFn: ({ signal }) =>
      param === null ? Promise.resolve(EMPTY_FACETS) : apiFetch(`/contacts/facets?${new URLSearchParams({ scope: param })}`, { schema: ContactFacetsResponse, signal }),
  })
}

/** Chi tiết một khách (hồ sơ + hội thoại + gợi ý gộp). */
export function useContact(id: string | null) {
  return useQuery({
    queryKey: contactKey(id ?? ''),
    queryFn: ({ signal }) => apiFetch(`/contacts/${id}`, { schema: ContactDetailDto, signal }),
    enabled: id !== null && UUID_RE.test(id),
    retry: false,
  })
}

/** Lịch sử nhắn tin của khách trên mọi trang: trang mới nhất trước; "Tải tin cũ hơn" bằng `fetchNextPage`. */
export function useContactHistory(id: string | null) {
  return useInfiniteQuery({
    queryKey: contactHistoryKey(id ?? ''),
    queryFn: ({ signal, pageParam }) => {
      const qs = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''
      return apiFetch(`/contacts/${id}/messages${qs}`, { schema: ListContactHistoryResponse, signal })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: id !== null && UUID_RE.test(id),
  })
}

/** Sau khi ghi: chi tiết mới vào cache, làm cũ danh sách khách và Hộp thư (panel/tên/giai đoạn hiện ở hội thoại). */
function useAfterWrite() {
  const queryClient = useQueryClient()
  return (detail?: ContactDetailDto) => {
    if (detail) queryClient.setQueryData(contactKey(detail.id), detail)
    void queryClient.invalidateQueries({ queryKey: CONTACTS_KEY })
    void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY })
  }
}

export function useUpdateContact() {
  const after = useAfterWrite()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateContactBody }) => apiFetch(`/contacts/${id}`, { method: 'PATCH', body: patch, schema: ContactDetailDto }),
    onSuccess: (d) => after(d),
  })
}

export function useBulkUpdateContacts() {
  const after = useAfterWrite()
  return useMutation({
    mutationFn: (body: BulkUpdateContactsBody) => apiFetch('/contacts/bulk', { method: 'POST', body, schema: BulkUpdateContactsResponse }),
    onSuccess: () => after(),
  })
}

/** Gộp `sourceId` VÀO `targetId` (giữ `targetId`). */
export function useMergeContacts() {
  const after = useAfterWrite()
  return useMutation({
    mutationFn: ({ targetId, sourceId }: { targetId: string; sourceId: string }) =>
      apiFetch(`/contacts/${targetId}/merge`, { method: 'POST', body: { sourceId }, schema: ContactDetailDto }),
    onSuccess: (d) => after(d),
  })
}

export function useSummarizeContact() {
  const after = useAfterWrite()
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/contacts/${id}/summarize`, { method: 'POST', schema: ContactDetailDto }),
    onSuccess: (d) => after(d),
  })
}

// ---------------------------------------------------------------------------------------------------------
// Helper thuần
// ---------------------------------------------------------------------------------------------------------

/** Nhãn tiếng Việt của giai đoạn (UX: Mới, Đang tư vấn, Chốt đơn, Khách quen, Khiếu nại). */
export const CONTACT_STAGE_LABEL: Record<ContactStage, string> = {
  new: 'Mới',
  consulting: 'Đang tư vấn',
  ordered: 'Chốt đơn',
  loyal: 'Khách quen',
  complaint: 'Khiếu nại',
}

export const STAGE_OPTIONS = CONTACT_STAGES.map((s) => ({ value: s, label: CONTACT_STAGE_LABEL[s] }))

/** Màu viên giai đoạn (nền + chấm). */
export const STAGE_STYLE: Record<ContactStage, { pill: string; dot: string }> = {
  new: { pill: 'bg-blue-50 text-blue-700', dot: 'bg-blue-500' },
  consulting: { pill: 'bg-cyan-50 text-cyan-800', dot: 'bg-cyan-500' },
  ordered: { pill: 'bg-green-50 text-green-700', dot: 'bg-green-500' },
  loyal: { pill: 'bg-primary-soft text-primary-hover', dot: 'bg-primary' },
  complaint: { pill: 'bg-red-50 text-red-700', dot: 'bg-red-500' },
}

/**
 * Thêm thẻ từ ô nhập: cắt khoảng trắng; rỗng / quá dài / đã có (không phân biệt hoa thường) / đủ số thẻ → `null` kèm
 * lý do để hiện cạnh ô nhập (rỗng thì không có lý do).
 */
export function addTag(tags: readonly string[], input: string): { tags: string[] } | { error: string | null } {
  const tag = input.trim()
  if (!tag) return { error: null }
  if ([...tag].length > CONTACT_TAG_MAX_LENGTH) return { error: `Thẻ tối đa ${CONTACT_TAG_MAX_LENGTH} ký tự` }
  const next = dedupeTags([...tags, tag])
  if (next.length === tags.length) return { error: 'Khách đã có thẻ này' }
  if (next.length > CONTACT_TAGS_MAX) return { error: `Tối đa ${CONTACT_TAGS_MAX} thẻ` }
  return { tags: next }
}

/** Lỗi SĐT theo đúng luật server (`ContactPhone`); `null` = hợp lệ (kể cả rỗng = xoá). */
export function phoneError(input: string): string | null {
  const r = ContactPhone.safeParse(input)
  return r.success ? null : (r.error.issues[0]?.message ?? 'Số điện thoại không hợp lệ')
}

/** Một đoạn lịch sử: các tin liền nhau của cùng một hội thoại (ghi rõ trang + kênh). */
export interface HistorySegment {
  conversationId: string
  pageId: string
  channel: ConversationChannel
  items: ContactHistoryItem[]
}

/** Lịch sử (cũ → mới) → các đoạn theo hội thoại, giữ thứ tự thời gian. */
export function historySegments(items: readonly ContactHistoryItem[]): HistorySegment[] {
  const out: HistorySegment[] = []
  for (const m of items) {
    const last = out.at(-1)
    if (last && last.conversationId === m.conversationId) last.items.push(m)
    else out.push({ conversationId: m.conversationId, pageId: m.pageId, channel: m.channel, items: [m] })
  }
  return out
}

/** Trạng thái tóm tắt AI để hiện cạnh nút: đang tóm tắt / lỗi (theo mã) / không có gì. */
export function summaryNote(c: Pick<ContactDto, 'aiSummaryStatus' | 'aiSummaryError'>): { tone: 'pending' | 'error'; text: string } | null {
  if (c.aiSummaryStatus === 'pending') return { tone: 'pending', text: 'AI đang tóm tắt…' }
  if (c.aiSummaryStatus === 'failed') {
    return { tone: 'error', text: c.aiSummaryError ? `Không tóm tắt được: ${errorMessage(c.aiSummaryError)}` : 'Không tóm tắt được, thử lại sau' }
  }
  return null
}

/** Câu xác nhận "Gộp khách": nguồn chuyển hết vào khách đang mở, không hoàn tác. */
export function mergeConfirmText(targetName: string, sourceName: string): string {
  return `Mọi trang, hội thoại, thẻ và ghi chú của "${sourceName}" sẽ chuyển sang "${targetName}", rồi "${sourceName}" bị xoá khỏi danh sách. Không hoàn tác được.`
}

const AVATAR_COLORS = ['#FDE68A', '#BFDBFE', '#FBCFE8', '#C7D2FE', '#A7F3D0', '#FED7AA', '#FECACA', '#DDD6FE']
/** Màu avatar ổn định theo id khách (Hộp thư và Khách hàng cùng màu). */
export function avatarColorOf(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!
}

/** Người viết một tin trong lịch sử khách: khách / người khác trong luồng bình luận / AI / chủ shop. */
export function historyAuthor(m: Pick<ContactHistoryItem, 'direction' | 'origin' | 'sender'>, contactId: string): { kind: 'customer' | 'other' | 'ai' | 'human'; label: string } {
  if (m.direction === 'inbound') {
    if (m.sender && m.sender.contactId !== contactId) return { kind: 'other', label: m.sender.name ?? 'Người khác' }
    return { kind: 'customer', label: 'Khách' }
  }
  if (m.origin === 'app_ai') return { kind: 'ai', label: 'AI trả lời' }
  return { kind: 'human', label: m.origin === 'external_human' ? 'Bạn · ngoài app' : 'Bạn' }
}

/** Chữ của một tin trong lịch sử: chữ tin, hoặc ghi chú đính kèm / không hiển thị được. */
export function historyText(m: Pick<ContactHistoryItem, 'text' | 'attachments'>): string {
  if (m.text?.trim()) return m.text.trim()
  if (m.attachments.length === 1) return 'Đã gửi một tệp đính kèm'
  if (m.attachments.length > 1) return `Đã gửi ${m.attachments.length} tệp đính kèm`
  return 'Tin nhắn không hiển thị được trong app'
}
