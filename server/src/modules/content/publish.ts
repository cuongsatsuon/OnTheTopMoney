// Job `publish.target` (Story 6.4, AD-13, AD-6, AD-14, AD-24): đăng một target lên trang của nó, ngoài mọi transaction.
// - Bỏ qua im lặng khi target không còn `scheduled` hoặc `schedule_version` lệch (đổi giờ / bỏ lịch / job chạy trùng).
// - Trang đã gỡ / mất kết nối, vi phạm luật nền tảng → `failed` với mã. Còn lại chiếm `scheduled → publishing` bằng
//   `UPDATE … WHERE status='scheduled' AND schedule_version=?` rồi mới gọi Meta (token lấy ngay trước khi gọi, hạng `publish`).
// - FB: `/{page}/photos` (có ảnh) hoặc `/{page}/feed`. IG / Threads: tạo container → hỏi trạng thái tới `FINISHED` →
//   publish. Ảnh IG ngoài khung 4:5–1,91:1 được đệm trắng khi giao (bản gốc giữ nguyên); IG / Threads rộng ≤1440 px.
// - CHỐNG ĐĂNG TRÙNG: chỉ trả target về `scheduled` (để retry chiếm lại) khi chắc Meta chưa tạo bài — lỗi ở bước tạo /
//   hỏi container, hoặc lỗi `notSent` của adapter. Bước tạo bài gặp hết giờ / đứt kết nối / 5xx → không retry:
//   IG / Threads hỏi lại container một lần (`PUBLISHED` → coi như đã đăng), còn lại `failed` `PUBLISH_UNKNOWN`.
// - Mọi lần vào `failed` phát `post_target.failed` đúng một lần (UPDATE có điều kiện trạng thái; `version` để thông
//   báo không bị gộp giữa hai lần lỗi của cùng target).
// Không log caption, URL có token hay token.
import { INSTAGRAM_ASPECT, PUBLISH_ISSUE_CODES, type ErrorCode, type Platform, type PostTargetStatus } from '@ottm/shared'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { SecretCipher } from '../../adapters/crypto/index.ts'
import { fitImageUrl } from '../../adapters/media/index.ts'
import {
  publishedRefFromFacebook,
  publishedRefFromInstagram,
  publishedRefFromThreads,
  type MetaClient,
  type MetaFailure,
  type PublishedRef,
} from '../../adapters/meta/index.ts'
import { bossDbFor, type Db, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { getAccessToken, markDisconnected, tokenOwnerPageId } from '../connections/index.ts'
import { getPage, getPlatformAccountId } from '../pages/index.ts'
import { assertPublishable } from './publishable.ts'
import { mediaAssets, postTargetMedia, postTargets } from './schema.ts'

/** Hoãn vì `RATE_LIMITED` tối đa tới chừng này sau giờ hẹn; quá → `failed` `PUBLISH_FAILED`. */
export const PUBLISH_RATE_DEFER_MAX_MS = 30 * 60_000
/** Hỏi trạng thái container: mỗi 3 giây, tối đa 20 lần (~60 giây) [ASSUMPTION]; chưa xong → lỗi tạm, retry tạo lại. */
export const CONTAINER_POLL_MS = 3_000
export const CONTAINER_POLL_MAX = 20
/** IG / Threads: rộng tối đa của ảnh giao đi (tài liệu Meta: 320–1440 px). */
export const PUBLISH_IMAGE_MAX_WIDTH = 1440

export interface PublishDeps {
  db: Db
  events: EventPublisher
  jobs: JobSender
  cipher: SecretCipher | null
  graph: MetaClient
  /** `undefined` khi chưa cấu hình app Threads → target Threads `failed` `PUBLISH_FAILED`. */
  threads?: MetaClient | undefined
  log?: { warn(obj: Record<string, unknown>, msg: string): void } | undefined
  now?: () => Date
  /** Chờ giữa hai lần hỏi container (test truyền hàm không chờ). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  pollIntervalMs?: number
  pollMax?: number
}

export type PublishOutcome =
  | 'published'
  | 'failed'
  /** `RATE_LIMITED`: target về `scheduled`, job mới chạy sau `blocked_until`. */
  | 'deferred'
  /** Không còn target / không `scheduled` / phiên bản lịch lệch — không gọi Meta. */
  | 'skipped'

export class PublishRetryableError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`publish.target: ${kind}`)
    this.name = 'PublishRetryableError'
    this.kind = kind
  }
}

export interface PublishJobData {
  targetId: string
  scheduleVersion: number
}

export function parsePublishJobData(data: unknown): PublishJobData {
  const d = data as { targetId?: unknown; scheduleVersion?: unknown } | null
  if (typeof d?.targetId !== 'string' || d.targetId === '' || !Number.isInteger(d.scheduleVersion)) {
    throw new Error('publish.target: thiếu targetId / scheduleVersion')
  }
  return { targetId: d.targetId, scheduleVersion: d.scheduleVersion as number }
}

type TargetRow = typeof postTargets.$inferSelect

const isPublishIssue = (code: string): code is ErrorCode => (PUBLISH_ISSUE_CODES as readonly string[]).includes(code)

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

// ---------------------------------------------------------------------------------------------------------
// Ghi trạng thái (UPDATE có điều kiện)
// ---------------------------------------------------------------------------------------------------------

/** `failed` + mã + `post_target.failed` khi target còn ở trạng thái `from` (và đúng phiên bản lịch nếu `scheduled`). */
async function markFailed(deps: PublishDeps, target: TargetRow, from: 'scheduled' | 'publishing', code: ErrorCode): Promise<PublishOutcome> {
  const failed = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(postTargets)
      .set({ status: 'failed' satisfies PostTargetStatus, errorCode: code, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(postTargets.id, target.id), eq(postTargets.status, from), eq(postTargets.scheduleVersion, target.scheduleVersion)))
      .returning({ version: postTargets.version })
    if (!row) return false
    await deps.events.publishEvent(tx, 'post_target.failed', { id: target.id, pageId: target.pageId, campaignId: target.campaignId, errorCode: code, version: row.version })
    return true
  })
  if (failed) deps.log?.warn({ targetId: target.id, pageId: target.pageId, errorCode: code }, 'content: đăng bài lỗi')
  return failed ? 'failed' : 'skipped'
}

/** Trả target về `scheduled` (giữ `schedule_version`) để lần retry / job hoãn chiếm lại. */
async function returnToScheduled(db: DbExecutor, target: TargetRow): Promise<void> {
  await db
    .update(postTargets)
    .set({ status: 'scheduled' satisfies PostTargetStatus, publishingAt: null, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(postTargets.id, target.id), eq(postTargets.status, 'publishing')))
}

async function markPublished(deps: PublishDeps, target: TargetRow, ref: PublishedRef | null): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(postTargets)
      .set({
        status: 'published' satisfies PostTargetStatus,
        publishedAt: deps.now?.() ?? new Date(),
        platformPostId: ref?.platformPostId ?? null,
        permalink: ref?.permalink ?? null,
        version: sql`${postTargets.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(postTargets.id, target.id), eq(postTargets.status, 'publishing')))
      .returning({ version: postTargets.version })
    if (!row) return false
    await deps.events.publishEvent(tx, 'post_target.published', { id: target.id, pageId: target.pageId, campaignId: target.campaignId, version: row.version })
    return true
  })
}

// ---------------------------------------------------------------------------------------------------------
// Gọi Meta
// ---------------------------------------------------------------------------------------------------------

interface PublishImage {
  url: string
  width: number
  height: number
}

interface CallContext {
  client: MetaClient
  token: string
  scope: string
  platform: Platform
  /** Id Page (FB) / IG user (IG) trên nền tảng; Threads dùng `me`. */
  accountId: string
  caption: string
  image: PublishImage | null
  signal?: AbortSignal | undefined
}

type Step =
  | { ok: true; ref: PublishedRef | null }
  /** Lỗi Meta. `stage: 'prepare'` = chưa có lời gọi nào tạo bài (container, hỏi trạng thái) → retry an toàn. */
  | { ok: false; stage: 'prepare' | 'publish'; failure: MetaFailure; containerId?: string }
  /** Lỗi đã rõ mã (container `ERROR`, hết hạn mức đăng Meta). */
  | { ok: false; code: ErrorCode }
  /** Container chưa xong sau ~60 giây → lỗi tạm (container cũ mồ côi, vô hại). */
  | { ok: false; pending: true }

const idOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

const base = (ctx: CallContext, withSignal: boolean) => ({
  token: ctx.token,
  tier: 'publish' as const,
  scope: ctx.scope,
  ...(withSignal && ctx.signal ? { signal: ctx.signal } : {}),
})

/**
 * Hạn mức đăng của Meta trong 24 giờ (gồm cả bài đăng ngoài app): `true` khi đã hết. Lỗi khi hỏi → `false` (lời gọi tạo
 * container sẽ tự gặp lỗi thật nếu có).
 */
async function quotaReached(ctx: CallContext, path: string): Promise<boolean> {
  const res = await ctx.client.get<{ data?: { quota_usage?: unknown; config?: { quota_total?: unknown } }[] }>(path, {
    ...base(ctx, true),
    params: { fields: 'quota_usage,config' },
  })
  const row = res.ok ? res.data?.data?.[0] : undefined
  const used = row?.quota_usage
  const total = row?.config?.quota_total
  return typeof used === 'number' && typeof total === 'number' && total > 0 && used >= total
}

/** Hỏi trạng thái container (`status_code` IG, `status` Threads) tới khi xong. */
async function waitContainer(deps: PublishDeps, ctx: CallContext, containerId: string): Promise<Step | 'FINISHED'> {
  const field = ctx.platform === 'threads' ? 'status' : 'status_code'
  const sleep = deps.sleep ?? defaultSleep
  const max = deps.pollMax ?? CONTAINER_POLL_MAX
  for (let i = 0; i < max; i++) {
    if (i > 0) await sleep(deps.pollIntervalMs ?? CONTAINER_POLL_MS, ctx.signal)
    const res = await ctx.client.get<Record<string, unknown>>(`/${containerId}`, { ...base(ctx, true), params: { fields: field } })
    if (!res.ok) return { ok: false, stage: 'prepare', failure: res }
    const status = res.data?.[field]
    if (status === 'FINISHED') return 'FINISHED'
    // `PUBLISHED` trước khi gọi publish: container lạ (không phải của lần này) — không dùng.
    if (status === 'ERROR' || status === 'EXPIRED' || status === 'PUBLISHED') return { ok: false, code: 'PUBLISH_REJECTED' }
  }
  return { ok: false, pending: true }
}

/** Sau khi bước publish không rõ kết quả: container đã `PUBLISHED`? (một lần hỏi, không signal). */
async function containerPublished(ctx: CallContext, containerId: string): Promise<boolean> {
  const field = ctx.platform === 'threads' ? 'status' : 'status_code'
  const res = await ctx.client.get<Record<string, unknown>>(`/${containerId}`, { ...base(ctx, false), params: { fields: field } })
  return res.ok && res.data?.[field] === 'PUBLISHED'
}

async function publishFacebook(ctx: CallContext): Promise<Step> {
  // Bước tạo bài duy nhất — KHÔNG truyền signal: huỷ giữa chừng thì không biết bài đã lên chưa.
  const message = ctx.caption.trim() ? ctx.caption : undefined
  const res = ctx.image
    ? await ctx.client.post<{ id?: unknown; post_id?: unknown }>(`/${ctx.accountId}/photos`, { ...base(ctx, false), form: { url: ctx.image.url, message } })
    : await ctx.client.post<{ id?: unknown }>(`/${ctx.accountId}/feed`, { ...base(ctx, false), form: { message } })
  if (!res.ok) return { ok: false, stage: 'publish', failure: res }
  return { ok: true, ref: publishedRefFromFacebook(ctx.accountId, res.data) }
}

/** IG / Threads: container → chờ `FINISHED` → publish. */
async function publishWithContainer(deps: PublishDeps, ctx: CallContext): Promise<Step> {
  const threads = ctx.platform === 'threads'
  if (await quotaReached(ctx, threads ? '/me/threads_publishing_limit' : `/${ctx.accountId}/content_publishing_limit`)) {
    return { ok: false, code: 'PUBLISH_LIMIT_REACHED' }
  }
  const caption = ctx.caption.trim() ? ctx.caption : undefined
  const image = ctx.image
    ? fitImageUrl(ctx.image.url, ctx.image, {
        ...(threads ? {} : { minAspect: INSTAGRAM_ASPECT.min, maxAspect: INSTAGRAM_ASPECT.max }),
        maxWidth: PUBLISH_IMAGE_MAX_WIDTH,
      })
    : null
  let form: Record<string, string | undefined>
  if (threads) form = image ? { media_type: 'IMAGE', image_url: image, text: caption } : { media_type: 'TEXT', text: caption }
  else if (image) form = { image_url: image, caption }
  else return { ok: false, code: 'MEDIA_REQUIRED' }

  const created = await ctx.client.post<{ id?: unknown }>(threads ? '/me/threads' : `/${ctx.accountId}/media`, { ...base(ctx, true), form })
  if (!created.ok) return { ok: false, stage: 'prepare', failure: created }
  const containerId = idOf(created.data?.id)
  if (!containerId) return { ok: false, stage: 'prepare', failure: { ok: false, kind: 'TRANSIENT' } }
  const ready = await waitContainer(deps, ctx, containerId)
  if (ready !== 'FINISHED') return ready

  // Bước tạo bài — KHÔNG truyền signal (xem `publishFacebook`).
  const published = await ctx.client.post<{ id?: unknown }>(threads ? '/me/threads_publish' : `/${ctx.accountId}/media_publish`, {
    ...base(ctx, false),
    form: { creation_id: containerId },
  })
  if (!published.ok) return { ok: false, stage: 'publish', failure: published, containerId }
  return { ok: true, ref: threads ? publishedRefFromThreads(published.data) : publishedRefFromInstagram(published.data) }
}

/** Permalink sau khi đăng (best-effort; lỗi thì bỏ qua — trạng thái đã ghi). */
async function fetchPermalink(ctx: CallContext, platformPostId: string): Promise<string | null> {
  const field = ctx.platform === 'facebook' ? 'permalink_url' : 'permalink'
  const res = await ctx.client.get<Record<string, unknown>>(`/${platformPostId}`, { ...base(ctx, true), params: { fields: field } })
  const link = res.ok ? res.data?.[field] : undefined
  return typeof link === 'string' && link.startsWith('https://') ? link : null
}

// ---------------------------------------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------------------------------------

/** Lỗi Meta dứt khoát (Meta đã trả lời là không) → mã đăng bài (AD-13). */
function definiteErrorOf(kind: MetaFailure['kind']): ErrorCode {
  switch (kind) {
    case 'TOKEN_INVALID':
    case 'PERMISSION_DENIED':
      return 'PAGE_DISCONNECTED'
    default:
      return 'PUBLISH_REJECTED'
  }
}

/** `TOKEN_INVALID` → trang GIỮ token (IG → Fanpage nguồn) `disconnected`. Lỗi khi đánh dấu chỉ log. */
async function reportTokenInvalid(deps: PublishDeps, pageId: string): Promise<void> {
  try {
    await markDisconnected({ db: deps.db, events: deps.events }, await tokenOwnerPageId(deps.db, pageId))
  } catch (err) {
    deps.log?.warn({ pageId, err }, 'content: không đánh dấu được trang mất kết nối sau TOKEN_INVALID')
  }
}

async function firstImage(db: Db, targetId: string): Promise<PublishImage | null> {
  const [row] = await db
    .select({ url: mediaAssets.url, width: mediaAssets.width, height: mediaAssets.height })
    .from(postTargetMedia)
    .innerJoin(mediaAssets, eq(mediaAssets.id, postTargetMedia.mediaAssetId))
    .where(and(eq(postTargetMedia.postTargetId, targetId), eq(mediaAssets.status, 'ready')))
    .orderBy(asc(postTargetMedia.position))
    .limit(1)
  return row?.url ? { url: row.url, width: row.width ?? 0, height: row.height ?? 0 } : null
}

export interface PublishOptions {
  /** Lần thử cuối của job: lỗi tạm thành `failed` `PUBLISH_FAILED` thay vì ném. */
  finalAttempt: boolean
  /** `job.signal`: chỉ huỷ bước chuẩn bị (container, hỏi trạng thái), không bao giờ huỷ bước tạo bài. */
  signal?: AbortSignal | undefined
}

/** Handler job `publish.target` cho một target. */
export async function publishTarget(deps: PublishDeps, data: PublishJobData, opts: PublishOptions): Promise<PublishOutcome> {
  const now = deps.now?.() ?? new Date()
  const [target] = await deps.db.select().from(postTargets).where(eq(postTargets.id, data.targetId))
  // `held` (AD-13, AD-15: bài xem trước / chiến dịch tạm dừng) → bỏ qua im lặng; chỉ `releaseCampaignTargets` enqueue lại.
  if (!target || target.status !== 'scheduled' || target.scheduleVersion !== data.scheduleVersion || target.held) return 'skipped'

  const page = await getPage(deps.db, target.pageId)
  if (!page) return markFailed(deps, target, 'scheduled', 'PAGE_REMOVED')
  if (page.connectionStatus === 'disconnected') return markFailed(deps, target, 'scheduled', 'PAGE_DISCONNECTED')
  try {
    await assertPublishable(deps.db, target.id)
  } catch (err) {
    if (err instanceof AppError && isPublishIssue(err.code)) return markFailed(deps, target, 'scheduled', err.code)
    if (err instanceof AppError && err.code === 'NOT_FOUND') return 'skipped'
    throw err
  }

  const [claimed] = await deps.db
    .update(postTargets)
    .set({ status: 'publishing' satisfies PostTargetStatus, publishingAt: now, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
    .where(
      and(eq(postTargets.id, target.id), eq(postTargets.status, 'scheduled'), eq(postTargets.scheduleVersion, data.scheduleVersion), eq(postTargets.held, false)),
    )
    .returning()
  if (!claimed) return 'skipped'

  // Trước lời gọi Meta: lỗi bất ngờ (DB, thiếu khoá mã hoá…) → trả `scheduled` rồi ném để retry; lần cuối → `failed`.
  let ctx: CallContext
  try {
    const client = page.platform === 'threads' ? deps.threads : deps.graph
    if (!client) {
      deps.log?.warn({ targetId: target.id, pageId: page.id }, 'content: chưa cấu hình app Threads — không đăng được')
      return markFailed(deps, claimed, 'publishing', 'PUBLISH_FAILED')
    }
    let token: string
    try {
      token = await getAccessToken({ db: deps.db, cipher: deps.cipher }, page.id)
    } catch (err) {
      if (err instanceof AppError && (err.code === 'PAGE_REMOVED' || err.code === 'PAGE_DISCONNECTED')) return markFailed(deps, claimed, 'publishing', err.code)
      throw err
    }
    const accountId = (await getPlatformAccountId(deps.db, page.id)) ?? page.id
    const scope = page.platform === 'threads' ? `threads:${page.id}` : `page:${accountId}`
    const image = await firstImage(deps.db, target.id)
    ctx = { client, token, scope, platform: page.platform, accountId, caption: claimed.caption, image, signal: opts.signal }
  } catch (err) {
    if (opts.finalAttempt) await markFailed(deps, claimed, 'publishing', 'PUBLISH_FAILED')
    else await returnToScheduled(deps.db, claimed)
    throw err
  }

  const step = page.platform === 'facebook' ? await publishFacebook(ctx) : await publishWithContainer(deps, ctx)

  if (step.ok) return finishPublished(deps, ctx, claimed, step.ref)
  if ('code' in step) return markFailed(deps, claimed, 'publishing', step.code)
  if ('pending' in step) return retryLater(deps, claimed, opts, 'CONTAINER_PENDING')

  const { failure } = step
  deps.log?.warn(
    { targetId: target.id, pageId: page.id, stage: step.stage, kind: failure.kind, code: failure.code, subcode: failure.subcode, notSent: failure.notSent },
    'content: Meta trả lỗi khi đăng',
  )
  // Bước tạo bài, Meta không trả lời dứt khoát (hết giờ / đứt kết nối / 5xx / bị huỷ): có thể đã lên → không retry mù.
  const ambiguous = failure.kind === 'ABORTED' || (failure.kind === 'TRANSIENT' && !failure.notSent)
  if (step.stage === 'publish' && ambiguous) {
    if (step.containerId && (await containerPublished(ctx, step.containerId))) return finishPublished(deps, ctx, claimed, null)
    return markFailed(deps, claimed, 'publishing', 'PUBLISH_UNKNOWN')
  }
  if (failure.kind === 'RATE_LIMITED') return deferRateLimited(deps, claimed, failure, now)
  if (failure.kind === 'TRANSIENT' || failure.kind === 'ABORTED') return retryLater(deps, claimed, opts, failure.kind)
  if (failure.kind === 'TOKEN_INVALID') await reportTokenInvalid(deps, page.id)
  return markFailed(deps, claimed, 'publishing', definiteErrorOf(failure.kind))
}

/** Đã đăng: ghi `published` + `PublishedRef`, phát sự kiện, rồi lấy permalink (best-effort). */
async function finishPublished(deps: PublishDeps, ctx: CallContext, claimed: TargetRow, ref: PublishedRef | null): Promise<PublishOutcome> {
  if (!(await markPublished(deps, claimed, ref))) {
    deps.log?.warn({ targetId: claimed.id }, 'content: bài đã lên nhưng target không còn ở publishing')
    return 'published'
  }
  if (!ref) {
    deps.log?.warn({ targetId: claimed.id, pageId: claimed.pageId }, 'content: Meta nhận bài nhưng không trả id')
    return 'published'
  }
  try {
    const link = await fetchPermalink(ctx, ref.platformPostId)
    if (link) await deps.db.update(postTargets).set({ permalink: link }).where(eq(postTargets.id, claimed.id))
  } catch (err) {
    deps.log?.warn({ targetId: claimed.id, err }, 'content: không lấy được permalink')
  }
  return 'published'
}

/** Lỗi tạm CHẮC CHẮN chưa tạo bài: trả `scheduled` rồi ném (retry chiếm lại); lần cuối → `PUBLISH_FAILED`. */
async function retryLater(deps: PublishDeps, claimed: TargetRow, opts: PublishOptions, kind: string): Promise<PublishOutcome> {
  if (opts.finalAttempt) return markFailed(deps, claimed, 'publishing', 'PUBLISH_FAILED')
  await returnToScheduled(deps.db, claimed)
  throw new PublishRetryableError(kind)
}

/** `RATE_LIMITED`: hoãn bằng job mới `startAfter` (không tính lượt retry); trễ quá 30 phút so với giờ hẹn → `PUBLISH_FAILED`. */
async function deferRateLimited(deps: PublishDeps, claimed: TargetRow, failure: MetaFailure, now: Date): Promise<PublishOutcome> {
  const retryAfterMs = Math.max(1000, failure.retryAfterMs ?? 0)
  const due = claimed.scheduledAt ?? now
  if (now.getTime() + retryAfterMs - due.getTime() > PUBLISH_RATE_DEFER_MAX_MS) return markFailed(deps, claimed, 'publishing', 'PUBLISH_FAILED')
  await deps.db.transaction(async (tx) => {
    await returnToScheduled(tx, claimed)
    await deps.jobs.send(
      'publish.target',
      { targetId: claimed.id, scheduleVersion: claimed.scheduleVersion },
      { startAfter: new Date(now.getTime() + retryAfterMs), db: bossDbFor(tx) },
    )
  })
  return 'deferred'
}

/** Handler job `publish.target` cho worker. */
export async function handlePublishJob(
  deps: PublishDeps,
  job: { data: unknown; retryCount: number; retryLimit: number; signal?: AbortSignal },
): Promise<PublishOutcome> {
  return publishTarget(deps, parsePublishJobData(job.data), { finalAttempt: job.retryCount >= job.retryLimit, signal: job.signal })
}
