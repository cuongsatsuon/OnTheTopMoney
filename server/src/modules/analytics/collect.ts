// Job thu số liệu một trang (Story 8.1, AD-17, AD-6, AD-5, AD-2): `analytics.collect_posts` (bài 30 ngày gần nhất) và
// `analytics.collect_page` (số liệu trang theo ngày). Cron rải job theo trang (`cron.ts`).
// - Trang đã gỡ / mất kết nối / Threads chưa cấu hình → bỏ qua, không gọi Meta.
// - Kiểm quyền insight (`connections.grantedScopes`) TRƯỚC khi gọi: thiếu → `permissions_missing`, không gọi Meta, không
//   đổi trạng thái kết nối trang.
// - Token qua `connections.getAccessToken` ngay trước khi gọi (không cache); mọi lời gọi hạng `background` — adapter giữ
//   lời gọi khi usage ≥75% (trả `RATE_LIMITED` chưa gửi) nên gửi tin (`interactive`) không bị ảnh hưởng.
// - `RATE_LIMITED` → enqueue lại đúng job `startAfter` (không tính lượt retry); dữ liệu đã ghi giữ nguyên. `TOKEN_INVALID`
//   → `markDisconnected` trang giữ token. Lỗi của một bài chỉ bỏ bài đó; lỗi mức trang dừng lượt.
// - Ghi bằng upsert theo khoá ngày (`schema.ts`) → cron / retry chạy lại không nhân đôi số.
// Không log token, caption hay URL có query.
import { INSIGHTS_SCOPES, type MetricSyncKind, type MetricSyncStatus, type Platform } from '@ottm/shared'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { SecretCipher } from '../../adapters/crypto/index.ts'
import type { MetaClient, MetaFailure } from '../../adapters/meta/index.ts'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { getAccessToken, grantedScopes, markDisconnected, tokenOwnerPageId } from '../connections/index.ts'
import { listMetricTargets } from '../content/index.ts'
import { getPage, getPlatformAccountId } from '../pages/index.ts'
import { PAGE_METRIC_MAP, POST_METRIC_MAP, parseInsightDaily, parseInsightTotals, standardize, type RawMetrics } from './metric-map.ts'
import { metricSyncStates, pageDailyMetrics, postMetrics } from './schema.ts'

const DAY_MS = 86_400_000
/** Asia/Ho_Chi_Minh: UTC+7, không có giờ mùa hè. */
const VN_OFFSET_MS = 7 * 3_600_000

/** Bài đăng trong chừng này ngày gần nhất được kéo số liệu (AD-17). */
export const POST_METRICS_WINDOW_DAYS = 30
/** Số liệu trang: kéo lại chừng này ngày trước hôm nay — Meta chốt số muộn, lượt sau ghi đè [ASSUMPTION]. */
export const PAGE_METRICS_LOOKBACK_DAYS = 3
/** Lỗi tạm liên tiếp ở chừng này bài → coi như Meta đang lỗi, dừng lượt (retry job). */
export const POST_TRANSIENT_STOP = 3
/** Hoãn vì `RATE_LIMITED` tối đa chừng này kể từ lần hoãn đầu; quá → bỏ lượt, cron sau chạy lại [ASSUMPTION]. */
export const METRICS_DEFER_MAX_MS = 3 * 3_600_000
/** `RATE_LIMITED` không kèm thời gian chờ → chờ chừng này. */
const DEFAULT_DEFER_MS = 60_000

export interface AnalyticsDeps {
  db: Db
  events: EventPublisher
  jobs: JobSender
  cipher: SecretCipher | null
  graph: MetaClient
  /** `undefined` khi chưa cấu hình app Threads → trang Threads bị bỏ qua. */
  threads?: MetaClient | undefined
  log?: { warn(obj: Record<string, unknown>, msg: string): void; info?(obj: Record<string, unknown>, msg: string): void } | undefined
  now?: () => Date
}

export interface CollectJobData {
  pageId: string
  /** ISO — lần hoãn `RATE_LIMITED` đầu tiên của lượt này (giới hạn tổng thời gian hoãn). */
  deferredSince?: string
}

export type CollectOutcome =
  | { status: 'collected'; saved: number; skipped: number }
  | { status: 'deferred'; startAfter: Date }
  /** Hoãn quá `METRICS_DEFER_MAX_MS` → bỏ lượt. */
  | { status: 'gave_up' }
  /** Trang đã gỡ / mất kết nối / chưa cấu hình Threads — không gọi Meta. */
  | { status: 'skipped' }
  | { status: Exclude<MetricSyncStatus, 'ok'> }

export class MetricsRetryableError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`analytics: ${kind}`)
    this.name = 'MetricsRetryableError'
    this.kind = kind
  }
}

export function parseCollectJobData(data: unknown): CollectJobData {
  const d = data as { pageId?: unknown; deferredSince?: unknown } | null
  if (typeof d?.pageId !== 'string' || d.pageId === '') throw new Error('analytics: thiếu pageId')
  return typeof d.deferredSince === 'string' ? { pageId: d.pageId, deferredSince: d.deferredSince } : { pageId: d.pageId }
}

/** Ngày VN (`YYYY-MM-DD`) của một thời điểm, lùi `daysBack` ngày. */
export const vnDateOf = (at: Date, daysBack = 0): string => new Date(at.getTime() + VN_OFFSET_MS - daysBack * DAY_MS).toISOString().slice(0, 10)
/** Đầu ngày VN `YYYY-MM-DD` (UTC). */
const vnDayStart = (day: string): Date => new Date(Date.parse(`${day}T00:00:00.000Z`) - VN_OFFSET_MS)
const unix = (at: Date) => Math.floor(at.getTime() / 1000)

// ---------------------------------------------------------------------------------------------------------
// Ghi
// ---------------------------------------------------------------------------------------------------------

async function writeState(
  db: DbExecutor,
  pageId: string,
  kind: MetricSyncKind,
  status: MetricSyncStatus,
  now: Date,
  missingScopes: readonly string[] = [],
): Promise<void> {
  const succeededAt = status === 'ok' ? now : null
  await db
    .insert(metricSyncStates)
    .values({ pageId, kind, status, missingScopes: [...missingScopes], attemptedAt: now, succeededAt })
    .onConflictDoUpdate({
      target: [metricSyncStates.pageId, metricSyncStates.kind],
      set: {
        status,
        missingScopes: [...missingScopes],
        attemptedAt: now,
        succeededAt: status === 'ok' ? now : sql`${metricSyncStates.succeededAt}`,
      },
    })
}

/**
 * Ghi đè dòng cùng khoá nhưng KHÔNG xoá số tốt bằng `null`: lượt sau thiếu metric (vd lời gọi phụ follows của IG bị từ
 * chối, Meta bỏ trường) giữ giá trị cũ; `raw` gộp, metric mới đè metric cũ.
 */
const keep = (col: AnyPgColumn) => sql`coalesce(excluded.${sql.identifier(col.name)}, ${col})`
const mergeRaw = (col: AnyPgColumn) => sql`${col} || excluded.${sql.identifier(col.name)}`

async function upsertPostMetric(db: DbExecutor, row: typeof postMetrics.$inferInsert): Promise<void> {
  await db
    .insert(postMetrics)
    .values(row)
    .onConflictDoUpdate({
      target: [postMetrics.postTargetId, postMetrics.metricDate],
      set: {
        views: keep(postMetrics.views),
        reach: keep(postMetrics.reach),
        engagement: keep(postMetrics.engagement),
        raw: mergeRaw(postMetrics.raw),
        fetchedAt: row.fetchedAt,
      },
      // Phản hồi của lượt cũ tới muộn không ghi đè số mới hơn.
      setWhere: sql`excluded.fetched_at >= ${postMetrics.fetchedAt}`,
    })
}

/** Target đã có dòng ngày `metricDate` ghi từ mốc `since` (thời điểm hỏng → rỗng). */
async function fetchedSince(db: DbExecutor, pageId: string, metricDate: string, since: Date): Promise<Set<string>> {
  if (Number.isNaN(since.getTime())) return new Set()
  const rows = await db
    .select({ id: postMetrics.postTargetId })
    .from(postMetrics)
    .where(and(eq(postMetrics.pageId, pageId), eq(postMetrics.metricDate, metricDate), gte(postMetrics.fetchedAt, since)))
  return new Set(rows.map((r) => r.id))
}

async function upsertPageMetric(db: DbExecutor, row: typeof pageDailyMetrics.$inferInsert): Promise<void> {
  await db
    .insert(pageDailyMetrics)
    .values(row)
    .onConflictDoUpdate({
      target: [pageDailyMetrics.pageId, pageDailyMetrics.date],
      set: {
        views: keep(pageDailyMetrics.views),
        reach: keep(pageDailyMetrics.reach),
        engagement: keep(pageDailyMetrics.engagement),
        followersDelta: keep(pageDailyMetrics.followersDelta),
        raw: mergeRaw(pageDailyMetrics.raw),
        fetchedAt: row.fetchedAt,
      },
      setWhere: sql`excluded.fetched_at >= ${pageDailyMetrics.fetchedAt}`,
    })
}

// ---------------------------------------------------------------------------------------------------------
// Chuẩn bị lời gọi
// ---------------------------------------------------------------------------------------------------------

interface CallContext {
  pageId: string
  platform: Platform
  client: MetaClient
  token: string
  scope: string
  /** Id tài khoản nền tảng (Page / IG user / Threads user). */
  accountId: string
}

type Prepared = { ok: true; ctx: CallContext } | { ok: false; outcome: CollectOutcome }

async function prepare(deps: AnalyticsDeps, pageId: string, kind: MetricSyncKind, now: Date): Promise<Prepared> {
  const skipped: Prepared = { ok: false, outcome: { status: 'skipped' } }
  const page = await getPage(deps.db, pageId)
  if (!page || page.connectionStatus === 'disconnected') return skipped
  const client = page.platform === 'threads' ? deps.threads : deps.graph
  if (!client) return skipped

  const granted = new Set(await grantedScopes(deps.db, page.id))
  const missing = INSIGHTS_SCOPES[page.platform].filter((s) => !granted.has(s))
  if (missing.length > 0) {
    await writeState(deps.db, page.id, kind, 'permissions_missing', now, missing)
    deps.log?.info?.({ pageId, kind, missing }, 'analytics: trang thiếu quyền thống kê — không thu')
    return { ok: false, outcome: { status: 'permissions_missing' } }
  }

  let token: string
  try {
    token = await getAccessToken({ db: deps.db, cipher: deps.cipher }, page.id)
  } catch (err) {
    if (err instanceof AppError && (err.code === 'PAGE_REMOVED' || err.code === 'PAGE_DISCONNECTED')) return skipped
    throw err
  }
  const accountId = (await getPlatformAccountId(deps.db, page.id)) ?? page.id
  const scope = page.platform === 'threads' ? `threads:${page.id}` : `page:${accountId}`
  return { ok: true, ctx: { pageId: page.id, platform: page.platform, client, token, scope, accountId } }
}

/** `TOKEN_INVALID` → trang GIỮ token (IG → Fanpage nguồn) `disconnected`. Lỗi khi đánh dấu chỉ log. */
async function reportTokenInvalid(deps: AnalyticsDeps, pageId: string): Promise<void> {
  try {
    await markDisconnected({ db: deps.db, events: deps.events }, await tokenOwnerPageId(deps.db, pageId))
  } catch (err) {
    deps.log?.warn({ pageId, err }, 'analytics: không đánh dấu được trang mất kết nối sau TOKEN_INVALID')
  }
}

/** `RATE_LIMITED`: enqueue lại đúng job `startAfter` (không tính lượt retry); hoãn quá lâu → bỏ lượt. */
async function defer(
  deps: AnalyticsDeps,
  queue: 'analytics.collect_posts' | 'analytics.collect_page',
  data: CollectJobData,
  failure: MetaFailure,
  runStart: Date,
): Promise<CollectOutcome> {
  const retryAfterMs = Math.max(1000, failure.retryAfterMs ?? DEFAULT_DEFER_MS)
  // Lần hoãn đầu = lúc lượt bắt đầu (job hoãn bỏ qua bài đã ghi từ mốc này). `startAfter` tính từ lúc BỊ chặn — lượt
  // bài có thể đã chạy nhiều phút, tính từ `runStart` thì job mới chạy ngay, không chờ đủ `retryAfterMs`.
  const since = data.deferredSince ? Date.parse(data.deferredSince) : runStart.getTime()
  const startAfter = new Date((deps.now?.() ?? new Date()).getTime() + retryAfterMs)
  if (startAfter.getTime() - since > METRICS_DEFER_MAX_MS) {
    deps.log?.warn({ pageId: data.pageId, queue }, 'analytics: Meta giới hạn quá lâu — bỏ lượt thu này')
    return { status: 'gave_up' }
  }
  await deps.jobs.send(queue, { pageId: data.pageId, deferredSince: new Date(since).toISOString() }, { startAfter })
  return { status: 'deferred', startAfter }
}

const isTransient = (kind: MetaFailure['kind']) => kind === 'TRANSIENT' || kind === 'ABORTED'

// ---------------------------------------------------------------------------------------------------------
// Bài
// ---------------------------------------------------------------------------------------------------------

export async function collectPostMetrics(deps: AnalyticsDeps, data: CollectJobData, opts: { finalAttempt: boolean }): Promise<CollectOutcome> {
  const now = deps.now?.() ?? new Date()
  const prepared = await prepare(deps, data.pageId, 'posts', now)
  if (!prepared.ok) return prepared.outcome
  const { ctx } = prepared
  const spec = POST_METRIC_MAP[ctx.platform]
  const targets = await listMetricTargets(deps.db, { pageId: ctx.pageId, since: new Date(now.getTime() - POST_METRICS_WINDOW_DAYS * DAY_MS) })
  const metricDate = vnDateOf(now)
  // Job hoãn vì `RATE_LIMITED`: bỏ bài đã ghi trong lượt này (từ lần hoãn đầu) — chạy lại từ đầu sẽ gọi lại đúng những
  // bài đó, đẩy usage lên lại và có thể không bao giờ tới các bài phía sau.
  const done = data.deferredSince ? await fetchedSince(deps.db, ctx.pageId, metricDate, new Date(data.deferredSince)) : new Set<string>()

  let saved = 0
  let skipped = 0
  let denied = 0
  let transientRun = 0
  const todo = targets.filter((t) => !done.has(t.targetId))
  for (const target of todo) {
    const req = spec.request(target.platformPostId)
    const res = await ctx.client.get(req.path, { token: ctx.token, tier: 'background', scope: ctx.scope, params: req.params })
    if (res.ok) {
      transientRun = 0
      const raw = spec.parse(res.data)
      await upsertPostMetric(deps.db, { postTargetId: target.targetId, pageId: ctx.pageId, metricDate, ...standardize(spec.rules, raw), raw, fetchedAt: now })
      saved++
      continue
    }
    if (res.kind === 'RATE_LIMITED') return defer(deps, 'analytics.collect_posts', data, res, now)
    if (res.kind === 'TOKEN_INVALID') {
      await reportTokenInvalid(deps, ctx.pageId)
      await writeState(deps.db, ctx.pageId, 'posts', 'disconnected', now)
      return { status: 'disconnected' }
    }
    skipped++
    if (res.kind === 'PERMISSION_DENIED') denied++
    if (isTransient(res.kind)) {
      if (++transientRun >= POST_TRANSIENT_STOP) {
        if (opts.finalAttempt) {
          await writeState(deps.db, ctx.pageId, 'posts', 'failed', now)
          return { status: 'failed' }
        }
        throw new MetricsRetryableError(res.kind)
      }
    } else {
      transientRun = 0
    }
    deps.log?.warn({ pageId: ctx.pageId, targetId: target.targetId, kind: res.kind, code: res.code }, 'analytics: bỏ số liệu một bài')
  }

  if (todo.length > 0 && denied === todo.length) {
    await writeState(deps.db, ctx.pageId, 'posts', 'permission_denied', now)
    return { status: 'permission_denied' }
  }
  await writeState(deps.db, ctx.pageId, 'posts', 'ok', now)
  return { status: 'collected', saved, skipped }
}

// ---------------------------------------------------------------------------------------------------------
// Trang
// ---------------------------------------------------------------------------------------------------------

type PageCall = { ok: true; data: unknown } | { ok: false; outcome: CollectOutcome } | { ok: false; skip: true }

export async function collectPageMetrics(deps: AnalyticsDeps, data: CollectJobData, opts: { finalAttempt: boolean }): Promise<CollectOutcome> {
  const now = deps.now?.() ?? new Date()
  const prepared = await prepare(deps, data.pageId, 'page', now)
  if (!prepared.ok) return prepared.outcome
  const { ctx } = prepared
  const spec = PAGE_METRIC_MAP[ctx.platform]

  /** Lỗi mức trang → kết quả lượt (dừng); lời gọi phụ bị từ chối → bỏ phần đó. */
  async function call(req: (typeof spec.requests)[number], window: { since: Date; until: Date }): Promise<PageCall> {
    const res = await ctx.client.get(req.path(ctx.accountId), {
      token: ctx.token,
      tier: 'background',
      scope: ctx.scope,
      params: { ...req.params, since: unix(window.since), until: unix(window.until) },
    })
    if (res.ok) return { ok: true, data: res.data }
    if (res.kind === 'RATE_LIMITED') return { ok: false, outcome: await defer(deps, 'analytics.collect_page', data, res, now) }
    if (res.kind === 'TOKEN_INVALID') {
      await reportTokenInvalid(deps, ctx.pageId)
      await writeState(deps.db, ctx.pageId, 'page', 'disconnected', now)
      return { ok: false, outcome: { status: 'disconnected' } }
    }
    if (isTransient(res.kind)) {
      if (!opts.finalAttempt) throw new MetricsRetryableError(res.kind)
      await writeState(deps.db, ctx.pageId, 'page', 'failed', now)
      return { ok: false, outcome: { status: 'failed' } }
    }
    deps.log?.warn({ pageId: ctx.pageId, kind: res.kind, code: res.code }, 'analytics: Meta từ chối số liệu trang')
    if (req.optional) return { ok: false, skip: true }
    const status = res.kind === 'PERMISSION_DENIED' ? 'permission_denied' : 'failed'
    await writeState(deps.db, ctx.pageId, 'page', status, now)
    return { ok: false, outcome: { status } }
  }

  const save = async (date: string, raw: RawMetrics) => {
    const v = standardize(spec.rules, raw)
    await upsertPageMetric(deps.db, {
      pageId: ctx.pageId,
      date,
      views: v.views,
      reach: v.reach,
      engagement: v.engagement,
      followersDelta: v.followers_delta,
      raw,
      fetchedAt: now,
    })
  }

  let saved = 0
  if (spec.mode === 'range') {
    // Một lời gọi cho cả khoảng: Meta trả mỗi ngày đã chốt một giá trị (theo lịch ngày của Meta).
    const window = { since: new Date(now.getTime() - (PAGE_METRICS_LOOKBACK_DAYS + 1) * DAY_MS), until: now }
    const byDay = new Map<string, RawMetrics>()
    for (const req of spec.requests) {
      const res = await call(req, window)
      if (!res.ok) {
        if ('outcome' in res) return res.outcome
        continue
      }
      for (const [day, raw] of parseInsightDaily(res.data)) byDay.set(day, { ...byDay.get(day), ...raw })
    }
    for (const [day, raw] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
      await save(day, raw)
      saved++
    }
  } else {
    // Mỗi ngày VN một cửa sổ, cũ nhất trước.
    for (let back = PAGE_METRICS_LOOKBACK_DAYS; back >= 1; back--) {
      const day = vnDateOf(now, back)
      const since = vnDayStart(day)
      const window = { since, until: new Date(since.getTime() + DAY_MS) }
      const raw: RawMetrics = {}
      for (const req of spec.requests) {
        const res = await call(req, window)
        if (!res.ok) {
          if ('outcome' in res) return res.outcome
          continue
        }
        Object.assign(raw, parseInsightTotals(res.data))
      }
      if (Object.keys(raw).length === 0) continue
      await save(day, raw)
      saved++
    }
  }
  await writeState(deps.db, ctx.pageId, 'page', 'ok', now)
  return { status: 'collected', saved, skipped: 0 }
}

// ---------------------------------------------------------------------------------------------------------
// Handler job
// ---------------------------------------------------------------------------------------------------------

type JobLike = { data: unknown; retryCount: number; retryLimit: number }

export function handleCollectPostsJob(deps: AnalyticsDeps, job: JobLike): Promise<CollectOutcome> {
  return collectPostMetrics(deps, parseCollectJobData(job.data), { finalAttempt: job.retryCount >= job.retryLimit })
}

export function handleCollectPageJob(deps: AnalyticsDeps, job: JobLike): Promise<CollectOutcome> {
  return collectPageMetrics(deps, parseCollectJobData(job.data), { finalAttempt: job.retryCount >= job.retryLimit })
}
