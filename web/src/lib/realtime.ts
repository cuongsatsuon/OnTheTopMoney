// Kênh realtime phía web (AD-3): nối SSE `/api/v1/stream`, vô hiệu hoá cache theo thực thể và
// refetch qua REST — KHÔNG render payload. Mất kết nối (25 giây im lặng hoặc lỗi mạng) → trạng thái
// `reconnecting` (dải xám "Đang kết nối lại…"), nối lại có backoff 1→2→4…≤30 giây. Mỗi lần `ready`
// (kể cả lần đầu — sự kiện giữa lần tải REST đầu và lúc stream mở đã lỡ) → refetch mọi query đang mở.
// Mất kết nối → hỏi `/auth/me`: phiên hết (401) thì dừng hẳn và đặt `me = null` để về màn đăng nhập.
import { EVENT_NAMES, RealtimeHint } from '@ottm/shared'
import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE, ME_QUERY_KEY, apiFetch, isApiError } from './api'

export const STREAM_URL = `${API_BASE}/stream`
/** Không nhận gì (kể cả ping 10 giây của server) trong khoảng này → coi như mất kết nối. */
export const WATCHDOG_MS = 25_000
export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_MAX_MS = 30_000

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting'

/** Chờ trước lần nối lại thứ `attempt` (0-based): 1, 2, 4, 8, 16, 30, 30… giây. */
export function backoffDelay(attempt: number, base = BACKOFF_BASE_MS, max = BACKOFF_MAX_MS): number {
  return Math.min(max, base * 2 ** Math.min(attempt, 30))
}

/**
 * Khoá query bắt đầu bằng tên thực thể: `entity` của sự kiện (số ít, vd `notification`) khớp khoá
 * gốc đúng tên đó hoặc dạng số nhiều của tài nguyên REST (`['notifications', …]`).
 */
export function entityMatches(root: unknown, entity: string): boolean {
  return root === entity || root === `${entity}s`
}

/**
 * Thực thể mà sự kiện của một thực thể khác cũng làm cũ:
 * - `openai_key` (`openai_key.invalidated`: OpenAI trả 401 lúc chạy) → trạng thái khoá ở `['settings', …]`;
 * - `settings` (đổi hạn mức / tỉ giá / cảnh báo 80%) → tổng chi phí AI `['ai_budget']`;
 * - `message` (tin mới / đính kèm tải xong) và `contact` (tên khách) → danh sách hội thoại `['conversations', …]`
 *   (xem trước, thứ tự, tên hiển thị) — Story 4.3;
 * - `conversation` (`conversation.state_changed`) → tin của hội thoại `['messages', …]` (tin `system` nêu lý do
 *   chuyển trạng thái được ghi cùng lúc).
 * - Story 4.9: `message`, `conversation` → khách `['contacts', …]` (tin mới nhất, "Xử lý bởi", lịch sử); `contact`
 *   (sửa hồ sơ, gộp khách `contact.merged`) → cả tin `['messages', …]` (tên người viết trong luồng bình luận).
 * - Story 4.10: `page` (kết nối lại đổi tên, gỡ), `group` (xoá nhóm), `contact` → kết quả ⌘K `['search', …]`.
 * - Story 5.7: `page`, `openai_key`, `settings`, `message` → trạng thái Màn chào `['onboarding']` (bước xong, tin AI đã
 *   gửi); `message` → sức khoẻ webhook `['webhooks', …]` ("Nhận tin gần nhất: vừa xong" ngay khi tin về, không chờ
 *   lần hỏi lại mỗi phút).
 */
export const ENTITY_ALSO_INVALIDATES: Readonly<Record<string, readonly string[]>> = {
  openai_key: ['settings', 'onboarding'],
  settings: ['ai_budget', 'onboarding'],
  message: ['conversation', 'contact', 'onboarding', 'webhook'],
  contact: ['conversation', 'message', 'search'],
  page: ['search', 'onboarding'],
  group: ['search'],
  conversation: ['message', 'contact'],
}

/**
 * Sự kiện làm cũ hẹp hơn thực thể của nó. Story 5.4: `conversation.ai_typing` (AI bắt đầu / thôi gõ, mỗi lượt hai lần)
 * chỉ làm cũ hội thoại (`aiTyping`) + tin (tin AI vừa ghi), không kéo theo khách hàng như `conversation.state_changed`.
 */
export const TYPE_INVALIDATES: Readonly<Record<string, readonly string[]>> = {
  'conversation.ai_typing': ['conversation', 'message'],
}

/**
 * Query có khoá gốc `root` bị gợi ý của `entity` làm cũ? (chính thực thể đó hoặc thực thể kèm theo). Có `type` nằm trong
 * `TYPE_INVALIDATES` → dùng danh sách riêng của sự kiện đó.
 */
export function hintInvalidates(root: unknown, entity: string, type?: string): boolean {
  const own = type !== undefined ? TYPE_INVALIDATES[type] : undefined
  return (own ?? [entity, ...(ENTITY_ALSO_INVALIDATES[entity] ?? [])]).some((e) => entityMatches(root, e))
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
  onerror: ((event: Event) => void) | null
}
export type EventSourceFactory = (url: string) => EventSourceLike

export type HintListener = (hint: RealtimeHint) => void

/** `unauthenticated` khi server trả 401; lỗi khác (mạng, 5xx) → `unknown` (cứ nối lại). */
export type SessionCheck = () => Promise<'ok' | 'unauthenticated' | 'unknown'>

const defaultSessionCheck: SessionCheck = async () => {
  try {
    await apiFetch('/auth/me')
    return 'ok'
  } catch (err) {
    return isApiError(err) && err.status === 401 ? 'unauthenticated' : 'unknown'
  }
}

export interface RealtimeClientOptions {
  queryClient: QueryClient
  url?: string
  createEventSource?: EventSourceFactory
  onStatus?: (status: RealtimeStatus) => void
  /** Hỏi phiên khi mất kết nối (EventSource không cho biết status 401). */
  checkSession?: SessionCheck
  watchdogMs?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
}

export interface RealtimeClient {
  start(): void
  stop(): void
  readonly status: RealtimeStatus
  /** Nghe gợi ý realtime (sau khi cache đã được vô hiệu hoá). Trả hàm huỷ. */
  subscribe(listener: HintListener): () => void
}

/** EventSource của trình duyệt; `withCredentials` để cookie phiên đi kèm khi api ở origin khác (CORS). */
export const browserEventSource: EventSourceFactory = (url) =>
  new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike

export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  const { queryClient } = options
  const url = options.url ?? STREAM_URL
  const createEventSource = options.createEventSource ?? browserEventSource
  const watchdogMs = options.watchdogMs ?? WATCHDOG_MS
  const base = options.backoffBaseMs ?? BACKOFF_BASE_MS
  const max = options.backoffMaxMs ?? BACKOFF_MAX_MS
  const checkSession = options.checkSession ?? defaultSessionCheck

  const listeners = new Set<HintListener>()
  let source: EventSourceLike | null = null
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let status: RealtimeStatus = 'connecting'
  let stopped = true
  let checking = false

  const setStatus = (next: RealtimeStatus) => {
    if (next === status) return
    status = next
    options.onStatus?.(next)
  }

  const refetchActive = () => void queryClient.refetchQueries({ type: 'active' })

  const handleHint = (raw: string) => {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
    const parsed = RealtimeHint.safeParse(data)
    if (!parsed.success) return
    const hint = parsed.data
    void queryClient.invalidateQueries({ predicate: (q) => hintInvalidates(q.queryKey[0], hint.entity, hint.type) })
    for (const listener of listeners) listener(hint)
  }

  const teardown = () => {
    clearTimeout(watchdog)
    if (source) {
      source.onerror = null
      source.close()
      source = null
    }
  }

  const stopClient = () => {
    stopped = true
    clearTimeout(retry)
    teardown()
  }

  /** Phiên đã hết → dừng nối lại; `RequireAuth` thấy `me = null` sẽ chuyển về đăng nhập. */
  const probeSession = () => {
    if (checking) return
    checking = true
    checkSession()
      .then((result) => {
        if (result !== 'unauthenticated' || stopped) return
        stopClient()
        queryClient.setQueryData(ME_QUERY_KEY, null)
      })
      .catch(() => {})
      .finally(() => {
        checking = false
      })
  }

  const lost = () => {
    if (stopped) return
    teardown()
    setStatus('reconnecting')
    clearTimeout(retry)
    retry = setTimeout(connect, backoffDelay(attempt, base, max))
    attempt += 1
    probeSession()
  }

  const armWatchdog = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(lost, watchdogMs)
  }

  function connect() {
    if (stopped) return
    teardown()
    const es = createEventSource(url)
    source = es
    armWatchdog()
    const on = (type: string, fn: (event: MessageEvent<string>) => void) =>
      es.addEventListener(type, (event) => {
        if (source !== es) return // sự kiện muộn của kết nối đã bỏ
        armWatchdog()
        fn(event)
      })
    on('ready', () => {
      attempt = 0
      setStatus('open')
      // Sự kiện trước lúc stream mở (lần đầu) hoặc trong lúc mất kết nối đã lỡ → tải bù query đang mở.
      refetchActive()
    })
    on('ping', () => {})
    on('resync', refetchActive)
    for (const name of EVENT_NAMES) on(name, (event) => handleHint(event.data))
    // Không để EventSource tự nối lại theo `retry` của server: dùng backoff riêng.
    es.onerror = () => {
      if (source === es) lost()
    }
  }

  return {
    get status() {
      return status
    },
    start() {
      if (!stopped) return
      stopped = false
      attempt = 0
      status = 'connecting'
      connect()
    },
    stop: stopClient,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export interface RealtimeState {
  status: RealtimeStatus
  subscribe(listener: HintListener): () => void
}

export const RealtimeContext = createContext<RealtimeState | null>(null)

/** Mở kết nối realtime cho vùng đã đăng nhập (dùng một lần, trong `RealtimeProvider`). */
export function useRealtime(): RealtimeState {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<RealtimeStatus>('connecting')
  const [client] = useState(() => createRealtimeClient({ queryClient, onStatus: setStatus }))
  useEffect(() => {
    client.start()
    return () => client.stop()
  }, [client])
  return useMemo(() => ({ status, subscribe: client.subscribe }), [status, client])
}

/** Trạng thái kết nối; ngoài `RealtimeProvider` coi như đang mở. */
export function useRealtimeStatus(): RealtimeStatus {
  return useContext(RealtimeContext)?.status ?? 'open'
}

/** Gọi `handler` mỗi khi có gợi ý realtime loại `type` (vd `notification.created`). */
export function useRealtimeEvent(type: string, handler: HintListener): void {
  const subscribe = useContext(RealtimeContext)?.subscribe
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    if (!subscribe) return
    return subscribe((hint) => {
      if (hint.type === type) ref.current(hint)
    })
  }, [subscribe, type])
}
