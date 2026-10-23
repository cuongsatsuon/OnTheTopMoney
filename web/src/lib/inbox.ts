// Hộp thư phía web (Story 4.3, AD-3, AD-9, AD-18): đọc hội thoại / tin / đính kèm qua REST; realtime chỉ làm cũ cache
// rồi refetch (`message.*`, `contact.*`, `conversation.*` → khoá gốc `['conversations', …]` và `['messages', …]`,
// xem `lib/realtime.ts`). Không có nghiệp vụ ở client. Helper thuần (nhãn, thời gian, lý do, tab) tách để test.
// Story 4.4: hội thoại bình luận (FB/IG) và trả lời Threads — nhãn kênh, dòng bài, nhãn sửa/xoá/ẩn, người viết tin.
// Story 4.6: tab lọc + badge đếm ở server (`tab=`, `/conversations/count`), lệnh Tiếp quản / bật lại AI / Đánh dấu
// xong (`useConversationAction`), thao tác hiện theo trạng thái và ghi chú "AI chuyển cho bạn" (UX-DR5).
import {
  ListConversationsResponse,
  ConversationCountResponse,
  ConversationDto,
  ListMessagesResponse,
  formatScope,
  type AttachmentError,
  type ConversationAction,
  type ConversationChannel,
  type ConversationState,
  type InboxTab,
  type ConversationPost,
  type ConversationPreview,
  type MessageDto,
  type MessageOrigin,
  type MessageRemoval,
  type Platform,
  type Scope,
  type StateChangeReason,
} from '@ottm/shared'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, apiUrl } from './api'

export const CONVERSATIONS_KEY = ['conversations'] as const
export const conversationsListKey = (scope: string | null, tab: InboxTab) => ['conversations', 'list', scope, tab] as const
/** Số đếm của tab (badge sidebar + số ở tab "Cần xử lý"). Gốc `conversations` → hint `conversation.*`/`message.*` làm cũ. */
export const conversationsCountKey = (scope: string | null, tab: InboxTab) => ['conversations', 'count', scope, tab] as const
export const conversationKey = (id: string) => ['conversations', 'detail', id] as const
export const messagesKey = (conversationId: string) => ['messages', conversationId] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Phạm vi → chuỗi query của server. Phạm vi trỏ tới trang/nhóm của kho mẫu (id không phải uuid, chưa có trên
 * server) → `null`: không có hội thoại thật nào thuộc phạm vi đó.
 */
export function serverScope(scope: Scope): string | null {
  if (scope.kind === 'all') return 'all'
  return UUID_RE.test(scope.id) ? formatScope(scope) : null
}

const EMPTY_LIST: ListConversationsResponse = { items: [], nextCursor: null }

/** Hội thoại theo phạm vi và tab (server lọc); "Xem thêm" bằng `fetchNextPage`. */
export function useConversations(scope: Scope, tab: InboxTab = 'all', options: { enabled?: boolean } = {}) {
  const param = serverScope(scope)
  return useInfiniteQuery({
    queryKey: conversationsListKey(param, tab),
    queryFn: ({ signal, pageParam }) => {
      if (param === null) return Promise.resolve(EMPTY_LIST)
      const qs = new URLSearchParams({ scope: param, tab })
      if (pageParam) qs.set('cursor', pageParam)
      return apiFetch(`/conversations?${qs}`, { schema: ListConversationsResponse, signal })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled ?? true,
  })
}

/** Số hội thoại "Cần xử lý" trong phạm vi — đếm ở server, đúng điều kiện tab (AD-9). Đang tải / lỗi → 0. */
export function useNeedsHumanCount(scope: Scope, options: { enabled?: boolean } = {}): number {
  const param = serverScope(scope)
  const query = useQuery({
    queryKey: conversationsCountKey(param, 'needs_human'),
    queryFn: ({ signal }) => {
      if (param === null) return Promise.resolve({ count: 0 })
      const qs = new URLSearchParams({ scope: param, tab: 'needs_human' })
      return apiFetch(`/conversations/count?${qs}`, { schema: ConversationCountResponse, signal })
    },
    enabled: options.enabled ?? true,
  })
  return query.data?.count ?? 0
}

/** Một hội thoại (mở bằng `?c=` khi nó không nằm trong trang danh sách đang tải). */
export function useConversation(id: string | null) {
  return useQuery({
    queryKey: conversationKey(id ?? ''),
    queryFn: ({ signal }) => apiFetch(`/conversations/${id}`, { schema: ConversationDto, signal }),
    enabled: id !== null && UUID_RE.test(id),
  })
}

/** Tin của hội thoại: trang mới nhất trước; "Tải tin cũ hơn" bằng `fetchNextPage`. */
export function useMessages(conversationId: string | null) {
  return useInfiniteQuery({
    queryKey: messagesKey(conversationId ?? ''),
    queryFn: ({ signal, pageParam }) => {
      const qs = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''
      return apiFetch(`/conversations/${conversationId}/messages${qs}`, { schema: ListMessagesResponse, signal })
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: conversationId !== null,
  })
}

/** Gộp các trang tin (mỗi trang cũ→mới, trang sau cũ hơn) thành một dòng thời gian cũ → mới. */
export function flattenMessages<T>(pages: readonly { items: readonly T[] }[] | undefined): T[] {
  if (!pages) return []
  return [...pages].reverse().flatMap((p) => p.items)
}

/**
 * Tiếp quản / bật lại AI / Đánh dấu xong (Story 4.6). Thành công → ghi đè chi tiết hội thoại và làm cũ danh sách, số
 * đếm, tin (tin `system` mới) — hint realtime `conversation.state_changed` cũng làm vậy ở các tab trình duyệt khác.
 */
export function useConversationAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: ConversationAction }) =>
      apiFetch(`/conversations/${id}/${action}`, { method: 'POST', schema: ConversationDto }),
    onSuccess: (conv) => {
      queryClient.setQueryData(conversationKey(conv.id), conv)
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY })
      void queryClient.invalidateQueries({ queryKey: messagesKey(conv.id) })
    },
  })
}

/* ---------- Helper thuần ---------- */

export interface ConversationControls {
  /** Nút "Tiếp quản" (và phím `T`). */
  takeover: boolean
  /** Công tắc "AI tự trả lời": bật = AI đang trả lời; tắt = Tiếp quản; bật lại = `enable-ai`. */
  aiSwitch: { checked: boolean; disabled: boolean }
  /** Nút "Đánh dấu xong". */
  markDone: boolean
}

/**
 * Thao tác dùng được theo trạng thái (AD-9, khớp luật server): Tiếp quản khi `triage|ai|handoff`; công tắc AI ở
 * `human|handoff|ai` (`triage` chốc lát, `done` chỉ mở lại bằng tin khách); Đánh dấu xong khi chưa `done`.
 */
export function conversationControls(state: ConversationState): ConversationControls {
  return {
    takeover: state === 'triage' || state === 'ai' || state === 'handoff',
    aiSwitch: { checked: state === 'ai', disabled: state === 'triage' || state === 'done' },
    markDone: state !== 'done',
  }
}

/** Lệnh khi gạt công tắc AI: bật → `enable-ai`; tắt → Tiếp quản. */
export const aiSwitchAction = (next: boolean): ConversationAction => (next ? 'enable-ai' : 'takeover')

/**
 * Ghi chú vàng của hội thoại `handoff` (UX-DR5): lý do theo `REASON_TEXT` + thời gian khách chờ tính từ
 * `waitingSince`. Không phải `handoff` hoặc chưa có lý do → `null`.
 */
export function handoffNote(conv: Pick<ConversationDto, 'state' | 'stateReason' | 'waitingSince'>, now: Date): string | null {
  if (conv.state !== 'handoff' || !conv.stateReason) return null
  const waiting = conv.waitingSince ? ` · khách chờ ${durationLabel(conv.waitingSince, now)}` : ''
  return `${REASON_TEXT[conv.stateReason]}${waiting}`
}

/** Nhãn tab Hộp thư. */
export const INBOX_TAB_LABEL: Record<InboxTab, string> = {
  all: 'Tất cả',
  needs_human: 'Cần xử lý',
  ai: 'AI đang trả lời',
  done: 'Đã xong',
}

export const CHANNEL_LABEL: Record<Platform, string> = { facebook: 'Messenger', instagram: 'Instagram', threads: 'Threads' }

/** Nhãn kênh của hội thoại: DM theo nền tảng; bình luận → "Bình luận Facebook/Instagram", Threads → "Trả lời Threads". */
export function channelLabel(platform: Platform, channel: ConversationChannel): string {
  if (channel === 'dm') return CHANNEL_LABEL[platform]
  return platform === 'threads' ? 'Trả lời Threads' : `Bình luận ${platform === 'facebook' ? 'Facebook' : 'Instagram'}`
}

/** Độ dài tối đa trích caption bài ở đầu khung chat. */
const POST_EXCERPT_MAX = 120

/** Dòng bài được bình luận ở đầu khung chat; caption chưa có → câu chung. */
export function postLine(post: ConversationPost, platform: Platform | undefined): string {
  const prefix = platform === 'threads' ? 'Trả lời bài Threads' : 'Bình luận trên bài'
  const text = post.text?.replace(/\s+/g, ' ').trim()
  if (!text) return `${prefix} (chưa lấy được nội dung bài)`
  return `${prefix}: “${text.length > POST_EXCERPT_MAX ? `${text.slice(0, POST_EXCERPT_MAX - 1).trimEnd()}…` : text}”`
}

/** Nhãn tin bị gỡ trên nền tảng (nội dung vẫn hiện, mờ). */
export const REMOVAL_TEXT: Record<MessageRemoval, string> = {
  deleted: 'Khách đã xoá',
  hidden: 'Đã ẩn',
}

/**
 * Tên người viết tin của khách: luồng bình luận có thể có người khác trả lời (khách khác của hội thoại) → tên của
 * người đó; còn lại là khách của hội thoại.
 */
export function senderLabel(
  msg: Pick<MessageDto, 'sender'>,
  conv: { contact: { id: string; name: string | null } },
  platform: Platform | undefined,
): string {
  const sender = msg.sender && msg.sender.contactId !== conv.contact.id ? { id: msg.sender.contactId, name: msg.sender.name } : conv.contact
  return contactLabel(sender, platform)
}

/** Ghi chú ở chỗ ô soạn tin (gửi tin là Story 4.7). */
export function composerNote(platform: Platform | undefined, channel: ConversationChannel): string {
  if (channel === 'comment') {
    const where = platform === 'threads' ? 'Threads' : platform === 'instagram' ? 'Instagram' : 'Facebook'
    return platform === 'threads'
      ? `Trả lời công khai từ Hộp thư sắp có. Tạm thời trả lời khách trên ${where}.`
      : `Trả lời công khai và Nhắn riêng từ Hộp thư sắp có. Tạm thời trả lời khách trên ${where}.`
  }
  return 'Gửi tin và “Gợi ý bằng AI” từ Hộp thư sắp có. Tạm thời trả lời khách trên Messenger/Instagram.'
}

/** Tên hiển thị của khách; chưa lấy được tên từ Meta → "Khách Messenger · 3F2A" (4 ký tự cuối id, để phân biệt). */
export function contactLabel(contact: { id: string; name: string | null }, platform: Platform | undefined): string {
  if (contact.name) return contact.name
  const tail = contact.id.replace(/-/g, '').slice(-4).toUpperCase()
  return `Khách ${platform ? CHANNEL_LABEL[platform] : ''}`.trim() + ` · ${tail}`
}

const OUTBOUND_PREFIX: Partial<Record<MessageOrigin, string>> = {
  app_human: 'Bạn: ',
  external_human: 'Bạn: ',
  app_unmatched: 'Bạn: ',
  app_ai: 'AI: ',
}

/** Dòng xem trước ở danh sách. */
export function previewText(preview: ConversationPreview | null): string {
  if (!preview) return 'Chưa có tin nhắn'
  const body = preview.text?.trim()
    ? preview.text.trim()
    : preview.attachmentCount > 0
      ? preview.attachmentCount === 1
        ? 'Đã gửi một tệp đính kèm'
        : `Đã gửi ${preview.attachmentCount} tệp đính kèm`
      : 'Tin nhắn không hiển thị được trong app'
  return `${OUTBOUND_PREFIX[preview.origin] ?? ''}${body}`
}

/** Ghi chú hệ thống (viên thuốc vàng) theo lý do chuyển trạng thái. */
export const REASON_TEXT: Record<StateChangeReason, string> = {
  AI_OFF: 'AI trả lời chưa bật cho trang này — bạn trả lời khách nhé',
  CHANNEL_OFF: 'AI không trả lời kênh này — bạn trả lời khách nhé',
  CONFIG_MISSING: 'AI còn thiếu cấu hình cho trang này — bạn trả lời khách nhé',
  OUTSIDE_HOURS: 'Ngoài giờ AI trả lời — chuyển cho bạn',
  OPENAI_KEY_UNAVAILABLE: 'Khoá OpenAI chưa dùng được — chuyển cho bạn',
  AI_BUDGET_EXCEEDED: 'Đã hết hạn mức AI tháng này — chuyển cho bạn',
  AI_PROVIDER_ERROR: 'AI đang gặp sự cố — chuyển cho bạn',
  KEYWORD: 'Khách nhắc tới từ khoá cần bạn xử lý',
  CUSTOMER_ASKED_HUMAN: 'Khách muốn nói chuyện với người thật',
  AI_UNCERTAIN: 'AI chưa chắc câu trả lời — chuyển cho bạn',
  AI_POLICY_BLOCKED: 'AI không được phép trả lời nội dung này',
  NON_TEXT_MESSAGE: 'Khách gửi nội dung AI chưa đọc được',
  OUTSIDE_24H: 'Đã quá 24 giờ kể từ tin cuối của khách',
  HUMAN_REPLIED: 'Bạn đã trả lời — AI tạm dừng ở hội thoại này',
  TAKEOVER: 'Bạn đã tiếp quản — AI tạm dừng ở hội thoại này',
  AI_REENABLED: 'Đã bật lại AI cho hội thoại này',
  MARKED_DONE: 'Đã đánh dấu xong',
  GATE_OPEN: 'AI trả lời lại được — AI tiếp tục hội thoại',
}

export const ATTACHMENT_ERROR_TEXT: Record<AttachmentError, string> = {
  MEDIA_NOT_CONFIGURED: 'Máy chủ chưa cấu hình kho file nên chưa lưu được tệp này',
  UNSUPPORTED_TYPE: 'Định dạng tệp chưa hỗ trợ — xem trên Messenger/Instagram',
  TOO_LARGE: 'Tệp quá lớn để lưu — xem trên Messenger/Instagram',
  INVALID_URL: 'Không tải được tệp đính kèm',
  FETCH_FAILED: 'Không tải được tệp đính kèm — xem trên Messenger/Instagram',
}

/** URL tuyệt đối tới bytes của đính kèm (theo origin api — đúng cả chế độ tách). */
export function attachmentUrl(id: string): string {
  return apiUrl(`/attachments/${id}`)
}

/** Vị trí bong bóng: khách bên trái, hệ thống ở giữa, AI / người bên phải. */
export function bubbleKind(origin: MessageOrigin): 'customer' | 'system' | 'ai' | 'human' {
  if (origin === 'customer') return 'customer'
  if (origin === 'system') return 'system'
  if (origin === 'app_ai') return 'ai'
  return 'human'
}

const VN_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** Ngày giờ theo giờ VN, tự ghép (định dạng `vi-VN` của ICU khác nhau giữa trình duyệt/Node). */
function vnParts(d: Date): { day: string; month: string; year: string; hm: string } {
  const get = (type: Intl.DateTimeFormatPartTypes) => VN_PARTS.formatToParts(d).find((p) => p.type === type)?.value ?? ''
  return { day: get('day'), month: get('month'), year: get('year'), hm: `${get('hour')}:${get('minute')}` }
}
const dayKey = (d: Date) => {
  const p = vnParts(d)
  return `${p.year}-${p.month}-${p.day}`
}

/** Khoảng thời gian ngắn: "Vừa xong", "5 phút", "3 giờ", "2 ngày". */
export function durationLabel(fromIso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - Date.parse(fromIso))
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'Vừa xong'
  if (min < 60) return `${min} phút`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} giờ`
  return `${Math.floor(hours / 24)} ngày`
}

/** Mốc ở danh sách: trong ngày → giờ:phút; hôm qua → "Hôm qua"; cũ hơn → ngày/tháng (giờ VN). */
export function listTimeLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  const p = vnParts(d)
  if (dayKey(d) === dayKey(now)) return p.hm
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86_400_000))) return 'Hôm qua'
  return `${p.day}/${p.month}`
}

/** Mốc dưới bong bóng: trong ngày → "19:30"; ngày khác → "12/10 19:30". */
export function messageTimeLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  const p = vnParts(d)
  return dayKey(d) === dayKey(now) ? p.hm : `${p.day}/${p.month} ${p.hm}`
}
