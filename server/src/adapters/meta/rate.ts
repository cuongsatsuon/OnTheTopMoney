// Ngân sách tần suất Meta (AD-6): đọc header usage sau MỖI phản hồi, lưu qua port `RateStore`
// (module `connections` cài bằng bảng `meta_rate_state`), và kiểm trước MỖI lời gọi theo hạng ưu tiên.
//
// - `X-App-Usage` (mức app): `{call_count, total_cputime, total_time}` → lưu ở scope app CỦA CLIENT
//   (`app:graph` hoặc `app:threads` — hai app Meta riêng, không chặn lẫn nhau), bucket `app`.
// - `X-Business-Use-Case-Usage` (theo id đối tượng): `{"<id>": [{type, call_count, total_cputime, total_time,
//   estimated_time_to_regain_access}]}` → lưu ở scope `page:<id>` (của chính đối tượng đó, không phải scope lời
//   gọi), bucket `buc`; usage = max của ba số đo (và của mọi `type` cùng id); `estimated_time_to_regain_access`
//   tính bằng PHÚT, > 0 → `blocked_until`.
// - Lỗi RATE_LIMITED từ Meta → bucket `blocked` (của scope lời gọi, hoặc scope app với mã mức app).
//
// Ngưỡng: `background` dừng khi usage ≥ 75%, `publish` khi ≥ 90%, `interactive` chỉ dừng khi đang bị chặn thật.

export const RATE_TIERS = ['interactive', 'publish', 'background'] as const
export type RateTier = (typeof RATE_TIERS)[number]

/** Usage (%) từ đó lời gọi của hạng bị từ chối trước khi gửi. `interactive` không dừng theo usage. */
export const TIER_THRESHOLD_PCT: Readonly<Record<RateTier, number>> = {
  interactive: Number.POSITIVE_INFINITY,
  publish: 90,
  background: 75,
}

/** Scope mức app (`X-App-Usage`, chặn mức app) — mỗi app Meta một scope. */
export const GRAPH_APP_SCOPE = 'app:graph'
export const THREADS_APP_SCOPE = 'app:threads'
export const APP_BUCKET = 'app'
/** Bucket ghi usage/chặn từ `X-Business-Use-Case-Usage`, ở scope `page:<objectId>`. */
export const BUC_BUCKET = 'buc'
/** Bucket ghi chặn do lỗi RATE_LIMITED của Meta (không phải từ header). */
export const BLOCKED_BUCKET = 'blocked'
export const bucScope = (objectId: string): string => `page:${objectId}`
/** Hold theo usage được giãn ngẫu nhiên ±20% để job bị giữ không cùng retry một lúc. */
export const USAGE_HOLD_JITTER = 0.2

/**
 * Usage ghi cách đây quá lâu thì bỏ qua [ASSUMPTION]: Meta tính usage trên cửa sổ trượt 1 giờ, không có lời gọi
 * nào thì số cũ không bao giờ được cập nhật. Sau 5 phút cho một lời gọi đi qua để đo lại.
 */
export const USAGE_TTL_MS = 5 * 60_000
/** Bị Meta trả RATE_LIMITED mà header không nói bao lâu thì chặn chừng này [ASSUMPTION]. */
export const DEFAULT_BLOCK_MS = 5 * 60_000

export interface RateBucketState {
  bucket: string
  /** 0–100 (có thể > 100 khi Meta đã chặn). */
  usagePct: number
  blockedUntil: Date | null
  updatedAt: Date
}

/** Port lưu trạng thái tần suất — adapter không biết DB. */
export interface RateStore {
  get(scope: string): Promise<RateBucketState[]>
  record(scope: string, state: RateBucketState): Promise<void>
}

export interface BucUsage {
  objectId: string
  usagePct: number
  /** 0 = không bị chặn. */
  regainMs: number
}

export interface ParsedUsage {
  /** `X-App-Usage`; không có hoặc hỏng → undefined. */
  appUsagePct?: number
  buc: BucUsage[]
}

type HeaderSource = { get(name: string): string | null }

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

function maxMetric(o: Record<string, unknown>): number | undefined {
  const values = [num(o.call_count), num(o.total_cputime), num(o.total_time)].filter((v): v is number => v !== undefined)
  return values.length ? Math.max(...values) : undefined
}

function parseJsonObject(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const v: unknown = JSON.parse(raw)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Đọc hai header usage. Header hỏng → bỏ qua phần đó, không ném lỗi. */
export function parseUsageHeaders(headers: HeaderSource): ParsedUsage {
  const result: ParsedUsage = { buc: [] }
  const app = parseJsonObject(headers.get('x-app-usage'))
  const appPct = app ? maxMetric(app) : undefined
  if (appPct !== undefined) result.appUsagePct = appPct

  const buc = parseJsonObject(headers.get('x-business-use-case-usage'))
  for (const [objectId, entries] of Object.entries(buc ?? {})) {
    if (!objectId || !Array.isArray(entries)) continue
    let usagePct: number | undefined
    let regainMinutes = 0
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      const m = maxMetric(e)
      if (m !== undefined) usagePct = Math.max(usagePct ?? 0, m)
      regainMinutes = Math.max(regainMinutes, num(e.estimated_time_to_regain_access) ?? 0)
    }
    if (usagePct === undefined && regainMinutes === 0) continue
    result.buc.push({ objectId, usagePct: usagePct ?? 0, regainMs: regainMinutes * 60_000 })
  }
  return result
}

export type BudgetDecision = { ok: true } | { ok: false; retryAfterMs: number; reason: 'blocked' | 'usage' }

/**
 * Quyết định từ trạng thái đã đọc (thuần — test không cần store). `random` ∈ [0, 1) cho jitter của hold theo
 * usage (0.5 = không giãn).
 */
export function decideBudget(
  states: readonly RateBucketState[],
  tier: RateTier,
  now: Date,
  random: () => number = Math.random,
): BudgetDecision {
  const t = now.getTime()
  let blockedUntil = 0
  for (const s of states) {
    const until = s.blockedUntil?.getTime() ?? 0
    if (until > t) blockedUntil = Math.max(blockedUntil, until)
  }
  if (blockedUntil > 0) return { ok: false, retryAfterMs: blockedUntil - t, reason: 'blocked' }

  const threshold = TIER_THRESHOLD_PCT[tier]
  let staleAt = 0
  for (const s of states) {
    // Bucket từng bị chặn và đã qua `blocked_until`: Meta đã cho gọi lại, usage cũ của nó không còn đúng.
    if (s.blockedUntil) continue
    const fresh = t - s.updatedAt.getTime() <= USAGE_TTL_MS
    if (fresh && s.usagePct >= threshold) staleAt = Math.max(staleAt, s.updatedAt.getTime() + USAGE_TTL_MS)
  }
  if (staleAt > 0) {
    const factor = 1 - USAGE_HOLD_JITTER + 2 * USAGE_HOLD_JITTER * random()
    return { ok: false, retryAfterMs: Math.max(1, Math.round((staleAt - t) * factor)), reason: 'usage' }
  }
  return { ok: true }
}

export interface RateLimiter {
  /** Scope app của client này (`app:graph` / `app:threads`). */
  readonly appScope: string
  /** Kiểm trước khi gửi: trạng thái của `scope` và của scope app. Store lỗi → ném (client đổi thành TRANSIENT). */
  checkBudget(scope: string, tier: RateTier, now: Date): Promise<BudgetDecision>
  /**
   * Ghi usage đọc từ header của một phản hồi. Trả thời gian chặn lâu nhất (ms) mà header báo cho chính `scope`
   * của lời gọi (BUC của id khác ghi cho id đó, không tính vào đây), 0 nếu không.
   */
  recordUsage(scope: string, usage: ParsedUsage, now: Date): Promise<number>
  /** Ghi chặn sau lỗi RATE_LIMITED. */
  recordBlock(scope: string, retryAfterMs: number, now: Date): Promise<void>
}

export interface RateLimiterOptions {
  /** Mặc định `app:graph`. */
  appScope?: string
  random?: () => number
}

export function createRateLimiter(store: RateStore, options: RateLimiterOptions = {}): RateLimiter {
  const appScope = options.appScope ?? GRAPH_APP_SCOPE
  const random = options.random ?? Math.random
  return {
    appScope,
    async checkBudget(scope, tier, now) {
      const states = [...(await store.get(scope)), ...(scope === appScope ? [] : await store.get(appScope))]
      return decideBudget(states, tier, now, random)
    },

    async recordUsage(scope, usage, now) {
      let maxRegain = 0
      if (usage.appUsagePct !== undefined) {
        await store.record(appScope, { bucket: APP_BUCKET, usagePct: usage.appUsagePct, blockedUntil: null, updatedAt: now })
      }
      for (const b of usage.buc) {
        const objectScope = bucScope(b.objectId)
        if (objectScope === scope) maxRegain = Math.max(maxRegain, b.regainMs)
        await store.record(objectScope, {
          bucket: BUC_BUCKET,
          usagePct: b.usagePct,
          blockedUntil: b.regainMs > 0 ? new Date(now.getTime() + b.regainMs) : null,
          updatedAt: now,
        })
      }
      return maxRegain
    },

    async recordBlock(scope, retryAfterMs, now) {
      await store.record(scope, {
        bucket: BLOCKED_BUCKET,
        usagePct: 100,
        blockedUntil: new Date(now.getTime() + retryAfterMs),
        updatedAt: now,
      })
    },
  }
}

/** Store trong bộ nhớ — cho test và cho chỗ chưa có DB. */
export function createMemoryRateStore(): RateStore & { readonly data: Map<string, Map<string, RateBucketState>> } {
  const data = new Map<string, Map<string, RateBucketState>>()
  return {
    data,
    async get(scope) {
      return [...(data.get(scope)?.values() ?? [])].map((s) => ({ ...s }))
    },
    async record(scope, state) {
      let m = data.get(scope)
      if (!m) data.set(scope, (m = new Map()))
      // Cùng luật với store DB: không ghi đè số mới hơn bằng phản hồi đến muộn.
      const current = m.get(state.bucket)
      if (current && current.updatedAt.getTime() > state.updatedAt.getTime()) return
      m.set(state.bucket, { ...state })
    },
  }
}
