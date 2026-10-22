// adapters/meta/rate — parse header usage, ngưỡng theo hạng, chặn và hết hạn chặn.
import { describe, expect, it } from 'vitest'
import {
  BLOCKED_BUCKET,
  GRAPH_APP_SCOPE,
  THREADS_APP_SCOPE,
  USAGE_TTL_MS,
  createMemoryRateStore,
  createRateLimiter,
  decideBudget,
  parseUsageHeaders,
  type RateBucketState,
} from '../src/adapters/meta/rate.ts'

const headers = (h: Record<string, string>) => new Headers(h)
const T0 = new Date('2026-10-22T03:00:00.000Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

describe('parseUsageHeaders', () => {
  it('X-App-Usage: max của call_count, total_cputime, total_time', () => {
    expect(parseUsageHeaders(headers({ 'x-app-usage': '{"call_count":28,"total_time":61,"total_cputime":5}' }))).toEqual({
      appUsagePct: 61,
      buc: [],
    })
  })

  it('X-Business-Use-Case-Usage: theo id đối tượng, max mọi số đo và mọi type; regain tính bằng phút', () => {
    const buc = {
      '111': [
        { type: 'pages', call_count: 10, total_cputime: 80, total_time: 20, estimated_time_to_regain_access: 0 },
        { type: 'messenger', call_count: 30, total_cputime: 1, total_time: 2, estimated_time_to_regain_access: 5 },
      ],
      '222': [{ type: 'instagram', call_count: 3, total_cputime: 4, total_time: 92 }],
    }
    expect(parseUsageHeaders(headers({ 'x-business-use-case-usage': JSON.stringify(buc) }))).toEqual({
      buc: [
        { objectId: '111', usagePct: 80, regainMs: 5 * 60_000 },
        { objectId: '222', usagePct: 92, regainMs: 0 },
      ],
    })
  })

  it.each([
    ['không có header', {}],
    ['JSON hỏng', { 'x-app-usage': '{oops', 'x-business-use-case-usage': 'nope' }],
    ['sai kiểu', { 'x-app-usage': '[1,2]', 'x-business-use-case-usage': '{"1":"x","2":[null, 5]}' }],
    ['số âm / chuỗi', { 'x-app-usage': '{"call_count":-5,"total_time":"90"}' }],
  ])('header hỏng (%s) → bỏ qua, không lỗi', (_n, h) => {
    expect(parseUsageHeaders(headers(h as Record<string, string>))).toEqual({ buc: [] })
  })
})

const state = (s: Partial<RateBucketState>): RateBucketState => ({
  bucket: 'buc:1',
  usagePct: 0,
  blockedUntil: null,
  updatedAt: T0,
  ...s,
})

describe('decideBudget — ngưỡng theo hạng', () => {
  it('usage 80%: background bị từ chối, publish và interactive được gửi', () => {
    const states = [state({ usagePct: 80 })]
    expect(decideBudget(states, 'background', at(1000), () => 0.5)).toEqual({ ok: false, reason: 'usage', retryAfterMs: USAGE_TTL_MS - 1000 })
    expect(decideBudget(states, 'publish', at(1000))).toEqual({ ok: true })
    expect(decideBudget(states, 'interactive', at(1000))).toEqual({ ok: true })
  })

  it('usage 92%: publish và background bị từ chối, interactive được gửi', () => {
    const states = [state({ usagePct: 92 })]
    expect(decideBudget(states, 'publish', T0).ok).toBe(false)
    expect(decideBudget(states, 'background', T0).ok).toBe(false)
    expect(decideBudget(states, 'interactive', T0)).toEqual({ ok: true })
  })

  it('đúng ngưỡng: background dừng ở 75, publish dừng ở 90', () => {
    expect(decideBudget([state({ usagePct: 74.9 })], 'background', T0)).toEqual({ ok: true })
    expect(decideBudget([state({ usagePct: 75 })], 'background', T0).ok).toBe(false)
    expect(decideBudget([state({ usagePct: 89.9 })], 'publish', T0)).toEqual({ ok: true })
    expect(decideBudget([state({ usagePct: 90 })], 'publish', T0).ok).toBe(false)
  })

  it('hold theo usage giãn ngẫu nhiên ±20% (job bị giữ không cùng retry một lúc)', () => {
    const states = [state({ usagePct: 80 })]
    const base = USAGE_TTL_MS
    expect(decideBudget(states, 'background', T0, () => 0)).toMatchObject({ retryAfterMs: Math.round(base * 0.8) })
    expect(decideBudget(states, 'background', T0, () => 0.999999)).toMatchObject({ retryAfterMs: Math.round(base * (0.8 + 0.4 * 0.999999)) })
    for (let i = 0; i < 50; i++) {
      const d = decideBudget(states, 'background', T0)
      expect(d.ok ? 0 : d.retryAfterMs).toBeGreaterThanOrEqual(base * 0.8)
      expect(d.ok ? 0 : d.retryAfterMs).toBeLessThanOrEqual(base * 1.2)
    }
  })

  it('hold vì bị chặn không có jitter', () => {
    expect(decideBudget([state({ blockedUntil: at(60_000) })], 'interactive', T0, () => 0)).toEqual({ ok: false, reason: 'blocked', retryAfterMs: 60_000 })
  })

  it('usage cũ quá USAGE_TTL_MS bị bỏ qua (cho một lời gọi đo lại)', () => {
    expect(decideBudget([state({ usagePct: 99 })], 'background', at(USAGE_TTL_MS + 1))).toEqual({ ok: true })
  })

  it('đang bị chặn: mọi hạng (kể cả interactive) bị từ chối với retryAfterMs tính từ blocked_until', () => {
    const states = [state({ usagePct: 10, blockedUntil: at(5 * 60_000) })]
    for (const tier of ['interactive', 'publish', 'background'] as const) {
      expect(decideBudget(states, tier, at(60_000))).toEqual({ ok: false, reason: 'blocked', retryAfterMs: 4 * 60_000 })
    }
  })

  it('hết hạn chặn: mọi hạng được gửi lại (usage của bucket bị chặn không còn tính)', () => {
    const states = [state({ usagePct: 100, blockedUntil: at(60_000) })]
    for (const tier of ['interactive', 'publish', 'background'] as const) {
      expect(decideBudget(states, tier, at(60_001))).toEqual({ ok: true })
    }
  })
})

describe('createRateLimiter + store bộ nhớ', () => {
  it('usage app vào scope app của client; BUC vào scope page:<objectId>; app usage áp cho mọi scope cùng client', async () => {
    const store = createMemoryRateStore()
    const limiter = createRateLimiter(store)
    expect(limiter.appScope).toBe(GRAPH_APP_SCOPE)
    const regain = await limiter.recordUsage(
      'page:1',
      { appUsagePct: 80, buc: [{ objectId: '1', usagePct: 20, regainMs: 0 }] },
      T0,
    )
    expect(regain).toBe(0)
    expect(await store.get(GRAPH_APP_SCOPE)).toEqual([{ bucket: 'app', usagePct: 80, blockedUntil: null, updatedAt: T0 }])
    expect(await store.get('page:1')).toEqual([{ bucket: 'buc', usagePct: 20, blockedUntil: null, updatedAt: T0 }])
    expect((await limiter.checkBudget('page:2', 'background', T0)).ok).toBe(false)
    expect((await limiter.checkBudget('page:2', 'publish', T0)).ok).toBe(true)
  })

  it('BUC của id khác trong phản hồi được ghi cho chính id đó: page:111 không bị giữ, page:222 thấy', async () => {
    const store = createMemoryRateStore()
    const limiter = createRateLimiter(store)
    const regain = await limiter.recordUsage('page:111', { buc: [{ objectId: '222', usagePct: 100, regainMs: 60_000 }] }, T0)
    expect(regain).toBe(0) // không phải scope của lời gọi
    expect(await store.get('page:111')).toEqual([])
    expect(await store.get('page:222')).toEqual([{ bucket: 'buc', usagePct: 100, blockedUntil: at(60_000), updatedAt: T0 }])
    expect(await limiter.checkBudget('page:111', 'interactive', T0)).toEqual({ ok: true })
    expect(await limiter.checkBudget('page:222', 'interactive', T0)).toEqual({ ok: false, reason: 'blocked', retryAfterMs: 60_000 })
  })

  it('Graph và Threads có scope app riêng: chặn/usage của Threads không giữ lời gọi Graph', async () => {
    const store = createMemoryRateStore()
    const graph = createRateLimiter(store, { appScope: GRAPH_APP_SCOPE })
    const threads = createRateLimiter(store, { appScope: THREADS_APP_SCOPE })
    await threads.recordBlock(THREADS_APP_SCOPE, 60_000, T0)
    await threads.recordUsage('threads:1', { appUsagePct: 99, buc: [] }, T0)
    expect((await threads.checkBudget('threads:1', 'interactive', T0)).ok).toBe(false)
    expect(await graph.checkBudget('page:1', 'background', T0)).toEqual({ ok: true })
  })

  it('header estimated_time_to_regain_access → blocked_until = now + phút', async () => {
    const store = createMemoryRateStore()
    const limiter = createRateLimiter(store)
    expect(await limiter.recordUsage('page:1', { buc: [{ objectId: '1', usagePct: 100, regainMs: 5 * 60_000 }] }, T0)).toBe(5 * 60_000)
    expect((await store.get('page:1'))[0]?.blockedUntil).toEqual(at(5 * 60_000))
    expect(await limiter.checkBudget('page:1', 'interactive', T0)).toEqual({ ok: false, reason: 'blocked', retryAfterMs: 5 * 60_000 })
    expect(await limiter.checkBudget('page:9', 'interactive', T0)).toEqual({ ok: true })
  })

  it('recordBlock ghi bucket blocked', async () => {
    const store = createMemoryRateStore()
    await createRateLimiter(store).recordBlock('page:1', 30_000, T0)
    expect(await store.get('page:1')).toEqual([{ bucket: BLOCKED_BUCKET, usagePct: 100, blockedUntil: at(30_000), updatedAt: T0 }])
  })

  it('store bộ nhớ không ghi đè bằng bản cũ hơn (cùng luật với store DB)', async () => {
    const store = createMemoryRateStore()
    await store.record('page:1', state({ bucket: 'buc', usagePct: 10, updatedAt: T0 }))
    await store.record('page:1', state({ bucket: 'buc', usagePct: 50, blockedUntil: at(9_000), updatedAt: at(1000) }))
    await store.record('page:1', state({ bucket: 'buc', usagePct: 99, updatedAt: at(-1000) }))
    expect(await store.get('page:1')).toEqual([{ bucket: 'buc', usagePct: 50, blockedUntil: at(9_000), updatedAt: at(1000) }])
  })
})
