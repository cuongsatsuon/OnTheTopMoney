import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ME_QUERY_KEY } from './api'
import {
  BACKOFF_MAX_MS,
  WATCHDOG_MS,
  backoffDelay,
  browserEventSource,
  createRealtimeClient,
  entityMatches,
  hintInvalidates,
  type EventSourceLike,
  type RealtimeStatus,
  type SessionCheck,
} from './realtime'

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  onerror: ((event: Event) => void) | null = null
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close() {
    this.closed = true
  }
  emit(type: string, data: unknown = {}) {
    for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify(data) } as MessageEvent<string>)
  }
  fail() {
    this.onerror?.(new Event('error'))
  }
  static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]!
  }
}

function setup(checkSession: SessionCheck = async () => 'ok') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const statuses: RealtimeStatus[] = []
  const check = vi.fn(checkSession)
  const client = createRealtimeClient({
    queryClient,
    createEventSource: (url) => new FakeEventSource(url),
    onStatus: (s) => statuses.push(s),
    checkSession: check,
  })
  return { queryClient, client, statuses, check }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.instances = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('backoffDelay', () => {
  it('1 → 2 → 4 … ≤ 30 giây', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((a) => backoffDelay(a))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
    expect(backoffDelay(1000)).toBe(BACKOFF_MAX_MS)
  })
})

describe('entityMatches', () => {
  it('khớp tên thực thể hoặc dạng số nhiều của khoá REST', () => {
    expect(entityMatches('notifications', 'notification')).toBe(true)
    expect(entityMatches('notification', 'notification')).toBe(true)
    expect(entityMatches('settings', 'settings')).toBe(true)
    expect(entityMatches('pages', 'notification')).toBe(false)
    expect(entityMatches('auth', 'a')).toBe(false)
  })
})

describe('hintInvalidates', () => {
  it('openai_key.invalidated → làm cũ [settings]; settings.updated → làm cũ cả [ai_budget]', () => {
    expect(hintInvalidates('settings', 'openai_key')).toBe(true)
    expect(hintInvalidates('ai_budget', 'settings')).toBe(true)
    expect(hintInvalidates('settings', 'settings')).toBe(true)
    expect(hintInvalidates('ai_budget', 'ai_budget')).toBe(true)
    expect(hintInvalidates('ai_budget', 'notification')).toBe(false)
    expect(hintInvalidates('notifications', 'openai_key')).toBe(false)
  })
})

describe('createRealtimeClient — Hộp thư (Story 4.3)', () => {
  it('message.received → làm cũ cả khung chat [messages, id] và danh sách [conversations, …]; contact.updated → danh sách', async () => {
    const { client, queryClient } = setup()
    const list = queryClient.getQueryCache().build(queryClient, { queryKey: ['conversations', 'list', 'all'], queryFn: async () => 'l' })
    const chat = queryClient.getQueryCache().build(queryClient, { queryKey: ['messages', 'c1'], queryFn: async () => 'm' })
    const pagesQ = queryClient.getQueryCache().build(queryClient, { queryKey: ['pages'], queryFn: async () => 'p' })
    await Promise.all([list.fetch(), chat.fetch(), pagesQ.fetch()])
    client.start()
    FakeEventSource.last.emit('ready')
    FakeEventSource.last.emit('message.received', { type: 'message.received', entity: 'message', id: 'm1', pageId: 'p1' })
    expect(queryClient.getQueryState(['conversations', 'list', 'all'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['messages', 'c1'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['pages'])?.isInvalidated).toBe(false)
    client.stop()
    expect(hintInvalidates('conversations', 'contact')).toBe(true)
    expect(hintInvalidates('conversations', 'conversation')).toBe(true)
    // conversation.state_changed ghi kèm tin `system` (lý do chuyển) → khung chat cũng phải tải lại.
    expect(hintInvalidates('messages', 'conversation')).toBe(true)
  })

  it('conversation.state_changed (Tiếp quản ở tab khác) → làm cũ danh sách theo tab, badge, chi tiết và khung chat (Story 4.6)', async () => {
    const { client, queryClient } = setup()
    const keys = [
      ['conversations', 'list', 'all', 'needs_human'],
      ['conversations', 'count', 'all', 'needs_human'],
      ['conversations', 'detail', 'c1'],
      ['messages', 'c1'],
    ]
    const queries = keys.map((queryKey) => queryClient.getQueryCache().build(queryClient, { queryKey, queryFn: async () => 'x' }))
    await Promise.all(queries.map((q) => q.fetch()))
    client.start()
    FakeEventSource.last.emit('ready')
    FakeEventSource.last.emit('conversation.state_changed', { type: 'conversation.state_changed', entity: 'conversation', id: 'c1', pageId: 'p1' })
    for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true)
    client.stop()
  })
})

describe('createRealtimeClient', () => {
  it('openai_key.invalidated → vô hiệu hoá query [settings, …]', async () => {
    const { client, queryClient } = setup()
    const q = queryClient.getQueryCache().build(queryClient, { queryKey: ['settings', 'openai'], queryFn: async () => 's' })
    const budget = queryClient.getQueryCache().build(queryClient, { queryKey: ['ai_budget'], queryFn: async () => 'b' })
    await Promise.all([q.fetch(), budget.fetch()])
    client.start()
    FakeEventSource.last.emit('ready')
    FakeEventSource.last.emit('openai_key.invalidated', { type: 'openai_key.invalidated', entity: 'openai_key', id: 'openai_api_key' })
    expect(queryClient.getQueryState(['settings', 'openai'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['ai_budget'])?.isInvalidated).toBe(false)
    FakeEventSource.last.emit('settings.updated', { type: 'settings.updated', entity: 'settings', id: 'openai' })
    expect(queryClient.getQueryState(['ai_budget'])?.isInvalidated).toBe(true)
    client.stop()
  })

  it('nối /api/v1/stream; event: ready → open', () => {
    const { client, statuses } = setup()
    client.start()
    expect(FakeEventSource.last.url).toBe('/api/v1/stream')
    expect(client.status).toBe('connecting')
    FakeEventSource.last.emit('ready')
    expect(client.status).toBe('open')
    expect(statuses).toEqual(['open'])
    client.stop()
    expect(FakeEventSource.last.closed).toBe(true)
  })

  it('gợi ý realtime → vô hiệu hoá đúng nhóm query theo entity, báo listener', async () => {
    const { client, queryClient } = setup()
    const notifFn = vi.fn(async () => 'n')
    const pagesFn = vi.fn(async () => 'p')
    const observers = [
      queryClient.getQueryCache().build(queryClient, { queryKey: ['notifications', 'list'], queryFn: notifFn }),
      queryClient.getQueryCache().build(queryClient, { queryKey: ['pages'], queryFn: pagesFn }),
    ]
    await Promise.all(observers.map((q) => q.fetch()))
    const seen = vi.fn()
    client.subscribe(seen)
    client.start()
    FakeEventSource.last.emit('ready')
    const hint = { type: 'notification.created', entity: 'notification', id: 'n1' }
    FakeEventSource.last.emit('notification.created', hint)
    expect(queryClient.getQueryState(['notifications', 'list'])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(['pages'])?.isInvalidated).toBe(false)
    expect(seen).toHaveBeenCalledWith(hint)
    client.stop()
  })

  it('payload sai định dạng → bỏ qua', () => {
    const { client } = setup()
    const seen = vi.fn()
    client.subscribe(seen)
    client.start()
    FakeEventSource.last.emit('page.expiring', { type: 'page.expiring' })
    expect(seen).not.toHaveBeenCalled()
    client.stop()
  })

  it('25 giây không nhận gì → reconnecting, nối lại với backoff 1→2→4 giây', () => {
    const { client } = setup()
    client.start()
    const first = FakeEventSource.last
    first.emit('ready')
    vi.advanceTimersByTime(WATCHDOG_MS - 1)
    expect(client.status).toBe('open')
    vi.advanceTimersByTime(1)
    expect(client.status).toBe('reconnecting')
    expect(first.closed).toBe(true)

    // lần nối 1 sau 1 giây
    expect(FakeEventSource.instances).toHaveLength(1)
    vi.advanceTimersByTime(999)
    expect(FakeEventSource.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances).toHaveLength(2)
    // lỗi ngay → lần 2 sau 2 giây
    FakeEventSource.last.fail()
    vi.advanceTimersByTime(1999)
    expect(FakeEventSource.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeEventSource.instances).toHaveLength(3)
    // lỗi → lần 3 sau 4 giây
    FakeEventSource.last.fail()
    vi.advanceTimersByTime(4000)
    expect(FakeEventSource.instances).toHaveLength(4)
    client.stop()
  })

  it('ping giữ kết nối sống (watchdog đặt lại theo mọi sự kiện)', () => {
    const { client } = setup()
    client.start()
    FakeEventSource.last.emit('ready')
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000)
      FakeEventSource.last.emit('ping')
    }
    expect(client.status).toBe('open')
    expect(FakeEventSource.instances).toHaveLength(1)
    client.stop()
  })

  it('lần ready đầu tiên → refetch query đang mở (bù sự kiện giữa lần tải REST đầu và lúc stream mở)', () => {
    const { client, queryClient } = setup()
    const refetch = vi.spyOn(queryClient, 'refetchQueries')
    client.start()
    expect(refetch).not.toHaveBeenCalled()
    FakeEventSource.last.emit('ready')
    expect(refetch).toHaveBeenCalledWith({ type: 'active' })
    client.stop()
  })

  it('lỗi kết nối + /auth/me trả 401 → dừng hẳn (không nối lại), me = null để về đăng nhập', async () => {
    const { client, queryClient, check } = setup(async () => 'unauthenticated')
    queryClient.setQueryData(ME_QUERY_KEY, { authenticated: true })
    client.start()
    FakeEventSource.last.emit('ready')
    FakeEventSource.last.fail()
    await vi.advanceTimersByTimeAsync(0) // cho probe phiên chạy xong
    expect(check).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(ME_QUERY_KEY)).toBeNull()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('lỗi kết nối nhưng phiên còn (hoặc không rõ) → vẫn nối lại, giữ me', async () => {
    const { client, queryClient, check } = setup(async () => 'unknown')
    queryClient.setQueryData(ME_QUERY_KEY, { authenticated: true })
    client.start()
    FakeEventSource.last.fail()
    await vi.advanceTimersByTimeAsync(1000)
    expect(check).toHaveBeenCalled()
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(queryClient.getQueryData(ME_QUERY_KEY)).toEqual({ authenticated: true })
    client.stop()
  })

  it('nối lại được → open, refetch mọi query đang mở, backoff đặt lại từ 1 giây', () => {
    const { client, queryClient } = setup()
    const refetch = vi.spyOn(queryClient, 'refetchQueries')
    client.start()
    FakeEventSource.last.emit('ready')
    expect(refetch).toHaveBeenCalledTimes(1) // lần đầu cũng tải bù (sự kiện trước lúc stream mở)
    refetch.mockClear()
    FakeEventSource.last.fail()
    expect(client.status).toBe('reconnecting')
    vi.advanceTimersByTime(1000)
    FakeEventSource.last.fail()
    vi.advanceTimersByTime(2000)
    FakeEventSource.last.emit('ready')
    expect(client.status).toBe('open')
    expect(refetch).toHaveBeenCalledWith({ type: 'active' })
    // mất lần nữa → lại bắt đầu từ 1 giây
    FakeEventSource.last.fail()
    const count = FakeEventSource.instances.length
    vi.advanceTimersByTime(1000)
    expect(FakeEventSource.instances).toHaveLength(count + 1)
    client.stop()
  })

  it('event: resync (LISTEN của server vừa nối lại) → refetch query đang mở', () => {
    const { client, queryClient } = setup()
    const refetch = vi.spyOn(queryClient, 'refetchQueries')
    client.start()
    FakeEventSource.last.emit('ready')
    FakeEventSource.last.emit('resync')
    expect(refetch).toHaveBeenCalledWith({ type: 'active' })
    client.stop()
  })

  it('stop() huỷ lịch nối lại', () => {
    const { client } = setup()
    client.start()
    FakeEventSource.last.fail()
    client.stop()
    vi.advanceTimersByTime(60_000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

describe('browserEventSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('mở EventSource với withCredentials (cookie phiên đi kèm khi api ở origin khác)', () => {
    const calls: { url: string; init: EventSourceInit | undefined }[] = []
    class StubEventSource {
      onerror = null
      constructor(url: string, init?: EventSourceInit) {
        calls.push({ url, init })
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal('EventSource', StubEventSource)
    browserEventSource('https://api.example.com/api/v1/stream')
    expect(calls).toEqual([{ url: 'https://api.example.com/api/v1/stream', init: { withCredentials: true } }])
  })
})
