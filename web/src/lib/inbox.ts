// Hộp thư phía web (Story 4.3, AD-3, AD-9, AD-18): đọc hội thoại / tin / đính kèm qua REST; realtime chỉ làm cũ cache
// rồi refetch (`message.*`, `contact.*`, `conversation.*` → khoá gốc `['conversations', …]` và `['messages', …]`,
// xem `lib/realtime.ts`). Không có nghiệp vụ ở client. Helper thuần (nhãn, thời gian, lý do, tab) tách để test.
// Story 4.4: hội thoại bình luận (FB/IG) và trả lời Threads — nhãn kênh, dòng bài, nhãn sửa/xoá/ẩn, người viết tin.
// Story 4.6: tab lọc + badge đếm ở server (`tab=`, `/conversations/count`), lệnh Tiếp quản / bật lại AI / Đánh dấu
// xong (`useConversationAction`), thao tác hiện theo trạng thái và ghi chú "AI chuyển cho bạn" (UX-DR5).
// Story 4.7: gửi / gửi lại tin (`useSendMessage`, `useResendMessage`), cách gửi theo kênh, nhãn trạng thái gửi, câu lỗi
// theo mã gửi tin (bong bóng "Gửi tin lỗi"). Server từ chối gửi (409 mã gửi tin) → tin đã lưu `failed`: chỉ làm cũ tin.
// Story 4.8: Gợi ý bằng AI (`useSuggestReply`, huỷ bằng `signal`), khoá nút theo nguồn (khoá OpenAI, hạn mức, hồ sơ, mã
// lỗi server — `suggestLock`), cụm vi phạm còn trong chữ (`remainingViolations`).
import {
  ListConversationsResponse,
  ConversationCountResponse,
  ConversationDto,
  ListMessagesResponse,
  MessageDto,
  SuggestReplyResponse,
  formatScope,
  isSendErrorCode,
  sendModesFor,
  sendTextLimit,
  type AiViolation,
  type AttachmentError,
  type ConversationAction,
  type ConversationChannel,
  type ConversationState,
  type InboxTab,
  type ConversationPost,
  type ConversationPreview,
  type MessageDelivery,
  type MessageOrigin,
  type MessageStatus,
  type MessageRemoval,
  type Platform,
  type Scope,
  type SendErrorCode,
  type StateChangeReason,
} from '@ottm/shared'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { apiFetch, apiUrl, isApiError } from './api'
import { errorMessageOf } from './error-messages'
import { AI_LOCK_HINTS, type AiLock } from './openai'

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

/**
 * Server đã từ chối gửi nhưng LƯU tin `failed` (409 với mã gửi tin, AD-10): bong bóng lỗi hiện lý do + "Gửi lại", không
 * cần toast.
 */
export function isSendRefusal(err: unknown): boolean {
  return isApiError(err) && err.status === 409 && isSendErrorCode(err.code)
}

/** Sau gửi / gửi lại (thành công hay bị từ chối): tin mới / bong bóng lỗi, danh sách + badge (trạng thái có thể đổi). */
function invalidateAfterSend(queryClient: ReturnType<typeof useQueryClient>, conversationId: string) {
  void queryClient.invalidateQueries({ queryKey: messagesKey(conversationId) })
  void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY })
}

/** Gửi tin của chủ shop (`POST /conversations/:id/messages`). */
export function useSendMessage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ conversationId, text, mode }: { conversationId: string; text: string; mode: MessageDelivery }) =>
      apiFetch(`/conversations/${conversationId}/messages`, { method: 'POST', body: { text, mode }, schema: MessageDto }),
    onSettled: (_data, err, vars) => {
      if (!err || isSendRefusal(err)) invalidateAfterSend(queryClient, vars.conversationId)
    },
  })
}

/** "Gửi lại" tin lỗi (`POST /messages/:id/resend`). */
export function useResendMessage() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ messageId }: { messageId: string; conversationId: string }) =>
      apiFetch(`/messages/${messageId}/resend`, { method: 'POST', schema: MessageDto }),
    onSettled: (_data, err, vars) => {
      if (!err || isSendRefusal(err)) invalidateAfterSend(queryClient, vars.conversationId)
    },
  })
}

/**
 * "Gợi ý bằng AI" (Story 4.8): `POST /conversations/:id/suggest {mode}` → bản nháp (KHÔNG gửi). `signal` để nút "Dừng"
 * huỷ request thật (server truyền AbortSignal sang OpenAI). Không cache: mỗi lần bấm là một bản nháp mới.
 */
export function useSuggestReply() {
  return useMutation({
    mutationFn: ({ conversationId, mode, signal }: { conversationId: string; mode: MessageDelivery; signal?: AbortSignal }) =>
      apiFetch(`/conversations/${conversationId}/suggest`, { method: 'POST', body: { mode }, schema: SuggestReplyResponse, ...(signal ? { signal } : {}) }),
  })
}

/* ---------- Helper thuần ---------- */

/** Mã lỗi server làm khoá nút "Gợi ý bằng AI" (UX-DR2, AD-8): thiếu/khoá hỏng, hết hạn mức, trang chưa có hồ sơ. */
export const SUGGEST_LOCK_CODES = ['OPENAI_KEY_MISSING', 'OPENAI_KEY_INVALID', 'AI_BUDGET_EXCEEDED', 'CONFIG_MISSING'] as const
export type SuggestLockCode = (typeof SUGGEST_LOCK_CODES)[number]

/** Mã khoá trong lỗi API (`null` = lỗi khác: toast, nút vẫn bấm lại được). */
export function suggestLockCodeOf(err: unknown): SuggestLockCode | null {
  return isApiError(err) && (SUGGEST_LOCK_CODES as readonly string[]).includes(err.code) ? (err.code as SuggestLockCode) : null
}

/** Câu toast khi gợi ý lỗi: trang chưa có hồ sơ → nói rõ (câu chung của `CONFIG_MISSING` quá mơ hồ ở đây). */
export function suggestErrorMessage(err: unknown): string {
  return suggestLockCodeOf(err) === 'CONFIG_MISSING' ? 'Trang chưa có hồ sơ thương hiệu. Tạo hồ sơ để AI viết đúng giọng shop.' : errorMessageOf(err)
}

export const SUGGEST_HINTS = {
  budget: 'Đã dùng hết hạn mức AI tháng này',
  config: 'Trang chưa có hồ sơ thương hiệu',
} as const

export interface SuggestLock {
  locked: boolean
  /** Câu tooltip; `null` = không hiện (đang tải trạng thái khoá). */
  hint: string | null
  /** Liên kết kèm tooltip; `null` = mặc định (Cài đặt). */
  link: { to: string; label: string } | null
}

/**
 * Khoá nút "Gợi ý bằng AI" theo thứ tự: khoá OpenAI (trạng thái server, AiLock) → hạn mức `blocked` → trang chưa có
 * hồ sơ hiệu lực → mã lỗi lần gọi trước. Ô soạn và nút Gửi không bị ảnh hưởng.
 */
export function suggestLock(input: { key: AiLock; budgetBlocked: boolean; configMissing: boolean; serverCode: SuggestLockCode | null; pageId: string }): SuggestLock {
  const configLink = { to: `/trang-nhom/trang/${input.pageId}`, label: 'Tạo hồ sơ' }
  if (input.key.locked) return { locked: true, hint: input.key.hint, link: null }
  if (input.budgetBlocked) return { locked: true, hint: SUGGEST_HINTS.budget, link: null }
  if (input.configMissing) return { locked: true, hint: SUGGEST_HINTS.config, link: configLink }
  switch (input.serverCode) {
    case 'OPENAI_KEY_MISSING':
      return { locked: true, hint: AI_LOCK_HINTS.missing, link: null }
    case 'OPENAI_KEY_INVALID':
      return { locked: true, hint: AI_LOCK_HINTS.invalid, link: null }
    case 'AI_BUDGET_EXCEEDED':
      return { locked: true, hint: SUGGEST_HINTS.budget, link: null }
    case 'CONFIG_MISSING':
      return { locked: true, hint: SUGGEST_HINTS.config, link: configLink }
    case null:
      return { locked: false, hint: null, link: null }
  }
}

/**
 * Cụm vi phạm của bản nháp còn nằm trong chữ đang soạn (chủ shop sửa dần): từ cấm / URL lạ còn xuất hiện (không phân
 * biệt hoa thường), `too_long` ("N/Max") còn khi chữ vẫn dài hơn Max.
 */
export function remainingViolations(text: string, violations: readonly AiViolation[]): AiViolation[] {
  const lower = text.toLowerCase()
  return violations.filter((v) => {
    if (v.kind !== 'too_long') return v.text !== '' && lower.includes(v.text.toLowerCase())
    const max = Number(v.text.split('/')[1])
    return Number.isFinite(max) && [...text.trim()].length > max
  })
}

/** Nhãn nút chọn cách gửi ở ô soạn. */
export const SEND_MODE_LABEL: Record<MessageDelivery, string> = {
  dm: 'Gửi tin',
  public_reply: 'Trả lời công khai',
  private_reply: 'Nhắn riêng',
}

/** Cách gửi + giới hạn ký tự của ô soạn theo nền tảng/kênh (trang chưa tải → coi như Facebook). */
export function composerModes(platform: Platform | undefined, channel: ConversationChannel): readonly MessageDelivery[] {
  return sendModesFor(platform ?? 'facebook', channel)
}

export function composerLimit(platform: Platform | undefined, mode: MessageDelivery): number {
  return sendTextLimit(platform ?? 'facebook', mode)
}

/** Gợi ý trong ô soạn theo cách gửi. */
export function composerPlaceholder(mode: MessageDelivery): string {
  if (mode === 'public_reply') return 'Viết trả lời công khai dưới bình luận… (⌘↵ để gửi)'
  if (mode === 'private_reply') return 'Nhắn riêng cho người bình luận qua Messenger/Instagram… (⌘↵ để gửi)'
  return 'Nhập tin nhắn… (⌘↵ để gửi)'
}

/** `⌘↵` (macOS) / `Ctrl+↵` gửi tin. Đang gõ bộ gõ (IME) thì không. */
export function isSendShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; isComposing?: boolean }): boolean {
  return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing
}

/** Lý do tin không gửi được (bong bóng "Gửi tin lỗi", EXPERIENCE.md › State Patterns). */
export const SEND_ERROR_TEXT: Record<SendErrorCode, string> = {
  OUTSIDE_24H: 'Quá 24 giờ kể từ tin cuối của khách — Meta không cho gửi tin thường',
  PRIVATE_REPLY_USED: 'Bình luận này đã được nhắn riêng một lần — Meta chỉ cho nhắn riêng một lần mỗi bình luận',
  PRIVATE_REPLY_INVALID: 'Không nhắn riêng được bình luận này (quá 7 ngày, đã bị xoá hoặc không hỗ trợ)',
  RECIPIENT_UNAVAILABLE: 'Không gửi được tới khách — khách có thể đã chặn trang hoặc không nhận tin',
  PAGE_DISCONNECTED: 'Trang mất kết nối',
  PAGE_REMOVED: 'Trang đã bị gỡ khỏi app',
  RATE_LIMITED: 'Gửi quá nhanh, thử lại sau ít phút',
  SEND_REJECTED: 'Meta không nhận tin này (bình luận có thể đã bị xoá hoặc nội dung bị chặn)',
  SEND_FAILED: 'Gửi chưa được do lỗi kết nối tới Meta',
  SEND_UNKNOWN: 'Chưa rõ tin đã tới khách hay chưa — kiểm tra trên Messenger/Instagram trước khi gửi lại',
}

/** Gợi ý cách xử lý tiếp theo mã lỗi (dòng phụ dưới lý do); không có → `null`. */
export function sendErrorHint(code: SendErrorCode, channel: ConversationChannel): string | null {
  switch (code) {
    case 'OUTSIDE_24H':
      return channel === 'dm' ? 'Trả lời khách qua bình luận trên bài của trang hoặc gọi điện.' : null
    case 'PAGE_DISCONNECTED':
      return 'Kết nối lại trang ở Trang & Nhóm rồi gửi lại.'
    case 'PRIVATE_REPLY_USED':
    case 'PRIVATE_REPLY_INVALID':
      return 'Trả lời công khai dưới bình luận thay thế.'
    default:
      return null
  }
}

/** Nhãn trạng thái dưới bong bóng tin của chủ shop / AI; `failed` hiện lý do riêng → `null`. */
export function outboundStatusLabel(status: MessageStatus | null): string | null {
  switch (status) {
    case 'pending':
    case 'sending':
      return 'Đang gửi…'
    case 'sent':
      return 'Đã gửi'
    case 'delivered':
      return 'Đã nhận'
    case 'read':
      return 'Đã xem'
    default:
      return null
  }
}

/**
 * Người gửi dưới bong bóng tin không phải AI (Story 4.5): trả lời từ Meta Business Suite / app Facebook (echo ngoài app)
 * ghi rõ "ngoài app"; tin của app (kể cả echo chưa khớp được tin nào) là "Bạn".
 */
export const outboundAuthorLabel = (origin: MessageOrigin): string => (origin === 'external_human' ? 'Bạn · ngoài app' : 'Bạn')

/** "Gửi lại" chỉ cho tin của chủ shop đang lỗi (server cũng kiểm). */
export const canResend = (msg: Pick<MessageDto, 'origin' | 'status'>): boolean => msg.origin === 'app_human' && msg.status === 'failed'

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

/** Đồng hồ cho nhãn "x phút" (cập nhật mỗi 30 giây) — Hộp thư, Khách hàng. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}
