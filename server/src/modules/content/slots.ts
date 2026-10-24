// Slot chiến dịch (Story 7.2, AD-13, AD-15, AD-21). `content` sở hữu slot (`post_targets` có `campaign_id` + `slot_at`)
// nhưng không biết bảng `campaigns` (AD-1): kế hoạch slot (ngày giờ, chủ đề, slot nào có ảnh) do `campaigns` tính bằng
// luật chung `campaignSlots` (shared) rồi truyền vào đây.
// - `ensureCampaignSlots`: tạo slot còn thiếu qua cửa duy nhất `createPost({source: campaign})`, idempotent theo khoá
//   `(campaign_id, page_id, slot_at)`; `pruneCampaignSlots`: xoá cứng slot không còn trong kế hoạch (chỉ dùng cho chiến
//   dịch nháp — bài xem trước chưa từng đăng).
// - `generateSlot`: caption theo hồ sơ hiệu lực bằng chính đường Soạn bài (`composeCaptionForPage`,
//   `feature=campaign_generate`, `ref` = target) + `ai.checkOutput`; slot cần ảnh → ô `media_assets(pending)` gắn sẵn vào
//   target + job `content.image.generate` cùng transaction, slot giữ `planned` tới khi ảnh `ready` / lỗi
//   (`settleSlotImage`, gọi từ job ảnh). AI lỗi, ảnh lỗi, hậu kiểm chặn → `pending_approval` kèm mã (AD-15).
// Mọi lần ghi là `UPDATE … WHERE status='planned'`: slot vừa bị xoá / huỷ / tạo lại thì lần ghi muộn không làm gì.
// Story 7.4 (sinh cuốn chiếu):
// - `generateSlot` chiếm slot bằng lease (`generate_lease_until`) trước khi gọi AI: job xem trước và job cuốn chiếu (lúc
//   "Bắt đầu"), hay lượt retry chồng lượt cũ, không cùng viết / cùng tính tiền một slot. Lối ra trước khi ghi caption trả
//   lease; job chết thì lease tự hết hạn và lượt cron sau viết lại.
// - `autoApprove` ("Tự đăng" — `campaigns` quyết): bài viết xong không lỗi duyệt luôn trong cùng transaction
//   (`slots-approve.ts`); slot có ảnh mang cờ qua payload job ảnh.
// - Đọc: hàng đợi "Bài chờ duyệt" (`listPendingSlots`), một slot (`getCampaignSlot`), nháp có slot kẹt (`staleSlotCampaigns`).
// Không log caption / prompt.
import {
  POST_TOPIC_MAX,
  type BrandProfileDto,
  type CampaignSlotDto,
  type ComposeGoal,
  type ErrorCode,
  type PostTargetStatus,
} from '@ottm/shared'
import { and, asc, eq, inArray, isNull, lt, lte, notExists, or, sql, type SQL } from 'drizzle-orm'
import { bossDbFor, type Db, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { buildImagePrompt } from '../ai/index.ts'
import { getPage } from '../pages/index.ts'
import { resolveEffectiveOrNull } from '../profiles/index.ts'
import { composeCaptionForPage, type ComposeDeps } from './compose.ts'
import { toMediaAssetDto } from './media.ts'
import { createPost } from './posts.ts'
import { mediaAssets, postTargetMedia, postTargets, posts } from './schema.ts'
import { autoApproveSlot } from './slots-approve.ts'

/** Một slot theo kế hoạch của `campaigns`. */
export interface SlotPlan {
  pageId: string
  slotAt: Date
  topic: string
}

/** Ký tự đầu của caption làm mô tả ảnh của slot (prompt ảnh gộp một dòng). */
const IMAGE_DESCRIPTION_MAX = 600

const keyOf = (pageId: string, slotAt: Date, topic?: string | null) => `${pageId}|${slotAt.toISOString()}${topic === undefined ? '' : `|${topic ?? ''}`}`

/**
 * Tạo các slot của `slots` chưa có (so theo trang + `slot_at`). `held` = bài xem trước (không đăng được);
 * `onCalendar` = đặt `scheduled_at = slot_at` (lên Lịch — 7.3). Trả số slot vừa tạo.
 */
export async function ensureCampaignSlots(
  tx: DbExecutor,
  campaignId: string,
  slots: readonly SlotPlan[],
  opts: { held: boolean; onCalendar: boolean },
): Promise<number> {
  const existing = await tx.select({ pageId: postTargets.pageId, slotAt: postTargets.slotAt }).from(postTargets).where(eq(postTargets.campaignId, campaignId))
  const have = new Set(existing.map((r) => keyOf(r.pageId, r.slotAt!)))
  let created = 0
  for (const s of slots) {
    if (have.has(keyOf(s.pageId, s.slotAt))) continue
    await createPost(tx, {
      source: 'campaign',
      campaignId,
      topic: s.topic,
      pageId: s.pageId,
      slotAt: s.slotAt,
      scheduledAt: opts.onCalendar ? s.slotAt : null,
      held: opts.held,
    })
    have.add(keyOf(s.pageId, s.slotAt))
    created++
  }
  return created
}

/**
 * Xoá cứng slot của chiến dịch không còn trong `keep` (khớp trang + `slot_at` + chủ đề) — cấu hình nháp vừa đổi. Slot đã
 * xoá (`cancelled`) mà vẫn khớp thì giữ (chủ shop đã bỏ bài đó). Không bao giờ chạm slot đã rời trước `publishing`.
 */
export async function pruneCampaignSlots(tx: DbExecutor, campaignId: string, keep: readonly SlotPlan[]): Promise<number> {
  const wanted = new Set(keep.map((s) => keyOf(s.pageId, s.slotAt, s.topic)))
  const rows = await tx
    .select({ postId: postTargets.postId, pageId: postTargets.pageId, slotAt: postTargets.slotAt, status: postTargets.status, topic: posts.topic })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(eq(postTargets.campaignId, campaignId))
  const removable: readonly PostTargetStatus[] = ['planned', 'pending_approval', 'cancelled']
  const drop = rows.filter((r) => removable.includes(r.status as PostTargetStatus) && !wanted.has(keyOf(r.pageId, r.slotAt!, r.topic))).map((r) => r.postId)
  if (drop.length) await tx.delete(posts).where(inArray(posts.id, drop))
  return drop.length
}

/** Job đang viết giữ slot tối đa chừng này (2 lời gọi AI ≤ 120 giây mỗi lời + ghi) — quá hạn thì lượt khác viết lại. */
export const SLOT_GENERATE_LEASE_MS = 10 * 60_000

/** Đọc slot (kèm chủ đề + ảnh) theo điều kiện, theo `scheduled_at` / `slot_at` rồi thứ tự tạo. */
async function readSlots(db: DbExecutor, where: SQL | undefined, opts: { byScheduled?: boolean; limit?: number } = {}): Promise<(CampaignSlotDto & { campaignId: string })[]> {
  const base = db
    .select({ target: postTargets, topic: posts.topic })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(where)
    .orderBy(...(opts.byScheduled ? [asc(postTargets.scheduledAt)] : []), asc(postTargets.slotAt), asc(postTargets.id))
  const rows = opts.limit === undefined ? await base : await base.limit(opts.limit)
  const media = rows.length
    ? await db
        .select({ targetId: postTargetMedia.postTargetId, asset: mediaAssets })
        .from(postTargetMedia)
        .innerJoin(mediaAssets, eq(mediaAssets.id, postTargetMedia.mediaAssetId))
        .where(inArray(postTargetMedia.postTargetId, rows.map((r) => r.target.id)))
        .orderBy(asc(postTargetMedia.position))
    : []
  return rows.map(({ target: t, topic }) => {
    const own = media.filter((m) => m.targetId === t.id)
    return {
      id: t.id,
      postId: t.postId,
      pageId: t.pageId,
      campaignId: t.campaignId!,
      slotAt: t.slotAt!.toISOString(),
      scheduledAt: t.scheduledAt?.toISOString() ?? null,
      topic,
      status: t.status as PostTargetStatus,
      caption: t.caption,
      aiCaption: t.aiCaption,
      media: own.filter((m) => m.asset.status === 'ready').map((m) => toMediaAssetDto(m.asset)),
      imagePending: own.some((m) => m.asset.status === 'pending'),
      version: t.version,
      errorCode: (t.errorCode as ErrorCode | null) ?? null,
    }
  })
}

const withoutCampaign = ({ campaignId: _c, ...slot }: CampaignSlotDto & { campaignId: string }): CampaignSlotDto => slot

/** Mọi slot của chiến dịch (kể cả đã xoá) theo `slot_at` rồi thứ tự tạo (= thứ tự trang của kế hoạch). */
export async function listCampaignSlots(db: DbExecutor, campaignId: string): Promise<CampaignSlotDto[]> {
  return (await readSlots(db, eq(postTargets.campaignId, campaignId))).map(withoutCampaign)
}

/** Một slot chiến dịch; `null` khi không có / không phải slot. */
export async function getCampaignSlot(db: DbExecutor, targetId: string): Promise<CampaignSlotDto | null> {
  const [slot] = await readSlots(db, and(eq(postTargets.id, targetId), sql`${postTargets.campaignId} is not null`))
  return slot ? withoutCampaign(slot) : null
}

/**
 * Hàng đợi "Bài chờ duyệt" (Story 7.4): slot `pending_approval` không `held` (bài xem trước của nháp còn `held`) của các
 * chiến dịch `campaignIds`, trang thuộc `pageIds` (`null` = mọi trang), theo giờ đăng (bài quá giờ trước).
 */
export async function listPendingSlots(
  db: DbExecutor,
  opts: { campaignIds: readonly string[]; pageIds: readonly string[] | null; limit: number },
): Promise<(CampaignSlotDto & { campaignId: string })[]> {
  if (!opts.campaignIds.length || (opts.pageIds !== null && !opts.pageIds.length)) return []
  return readSlots(db, pendingSlotsWhere(opts), { byScheduled: true, limit: opts.limit })
}

/** Điều kiện chung của hàng đợi "Bài chờ duyệt" và số đếm của nó. */
const pendingSlotsWhere = (opts: { campaignIds: readonly string[]; pageIds: readonly string[] | null }) =>
  and(
    inArray(postTargets.campaignId, [...opts.campaignIds]),
    eq(postTargets.status, 'pending_approval' satisfies PostTargetStatus),
    eq(postTargets.held, false),
    opts.pageIds === null ? undefined : inArray(postTargets.pageId, [...opts.pageIds]),
  )

/** Story 8.5: số bài trong hàng đợi "Bài chờ duyệt" (cùng tập `listPendingSlots`, không giới hạn) — Tổng quan. */
export async function countPendingSlots(db: DbExecutor, opts: { campaignIds: readonly string[]; pageIds: readonly string[] | null }): Promise<number> {
  if (!opts.campaignIds.length || (opts.pageIds !== null && !opts.pageIds.length)) return 0
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(postTargets).where(pendingSlotsWhere(opts))
  return row?.n ?? 0
}

/** Chiến dịch của một target (`null` = không có target / không phải slot) — route kiểm slot thuộc chiến dịch. */
export async function slotCampaignOf(db: DbExecutor, targetId: string): Promise<string | null> {
  const [row] = await db.select({ campaignId: postTargets.campaignId }).from(postTargets).where(eq(postTargets.id, targetId))
  return row?.campaignId ?? null
}

/** Slot `planned` chưa sinh: caption rỗng, chưa gắn ô ảnh, không có job nào đang giữ (lease còn hạn). */
const toGenerate = (db: DbExecutor) =>
  and(
    eq(postTargets.status, 'planned' satisfies PostTargetStatus),
    eq(postTargets.caption, ''),
    notExists(db.select({ one: sql`1` }).from(postTargetMedia).where(eq(postTargetMedia.postTargetId, postTargets.id))),
    or(isNull(postTargets.generateLeaseUntil), lte(postTargets.generateLeaseUntil, sql`now()`)),
  )

/**
 * Slot chưa sinh của chiến dịch — việc của job sinh nội dung. Story 7.4: `until` = chỉ slot có giờ đăng tới mốc này (cửa
 * sổ cuốn chiếu; không cận dưới — slot quá giờ chưa viết vẫn được viết rồi về "Chờ duyệt"), `limit` = lô.
 */
export async function listSlotsToGenerate(
  db: DbExecutor,
  campaignId: string,
  opts: { until?: Date; limit?: number } = {},
): Promise<{ id: string; pageId: string; slotAt: Date; topic: string | null }[]> {
  const query = db
    .select({ id: postTargets.id, pageId: postTargets.pageId, slotAt: postTargets.slotAt, topic: posts.topic })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(
      and(
        eq(postTargets.campaignId, campaignId),
        toGenerate(db),
        opts.until ? lte(postTargets.scheduledAt, opts.until) : undefined,
      ),
    )
    .orderBy(...(opts.until ? [asc(postTargets.scheduledAt)] : []), asc(postTargets.slotAt), asc(postTargets.id))
  const rows = opts.limit === undefined ? await query : await query.limit(opts.limit)
  return rows.map((r) => ({ id: r.id, pageId: r.pageId, slotAt: r.slotAt!, topic: r.topic }))
}

/**
 * Chiến dịch có slot chưa sinh, không job nào giữ, đứng yên từ trước `before` (job sinh bị mất — Story 7.4 dọn bài xem
 * trước kẹt "AI đang viết…"). Bên gọi lọc theo trạng thái chiến dịch.
 */
export async function staleSlotCampaigns(db: DbExecutor, before: Date): Promise<string[]> {
  const rows = await db
    .selectDistinct({ campaignId: postTargets.campaignId })
    .from(postTargets)
    .where(and(sql`${postTargets.campaignId} is not null`, toGenerate(db), lt(postTargets.updatedAt, before)))
  return rows.map((r) => r.campaignId!)
}

/**
 * `planned` → `pending_approval` (kèm caption nếu có, `errorCode` nếu lỗi), `version + 1`, phát `post_target.updated`.
 * Slot không còn `planned` → `false`.
 */
async function settle(
  tx: DbExecutor,
  events: EventPublisher,
  targetId: string,
  patch: { caption?: string; aiCaption?: boolean; errorCode: ErrorCode | null },
): Promise<boolean> {
  const [row] = await tx
    .update(postTargets)
    .set({ ...patch, status: 'pending_approval' satisfies PostTargetStatus, generateLeaseUntil: null, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(postTargets.id, targetId), eq(postTargets.status, 'planned' satisfies PostTargetStatus)))
    .returning({ pageId: postTargets.pageId, campaignId: postTargets.campaignId, version: postTargets.version })
  if (!row) return false
  await events.publishEvent(tx, 'post_target.updated', { id: targetId, pageId: row.pageId, campaignId: row.campaignId, version: row.version })
  return true
}

/** Slot không sinh được (mã dừng của cả lượt, vd hết hạn mức) → `pending_approval` kèm mã, không gọi AI. */
export async function failSlot(deps: { db: Db; events: EventPublisher }, targetId: string, code: ErrorCode): Promise<boolean> {
  return deps.db.transaction((tx) => settle(tx, deps.events, targetId, { errorCode: code }))
}

/**
 * Ô ảnh của slot đã xong (`code = null`) hoặc lỗi (`IMAGE_*`): slot gắn ô này còn `planned` → `pending_approval`
 * (lỗi: gỡ dòng gắn để slot không trỏ ảnh hỏng). Chạy trong transaction đổi trạng thái ô của job ảnh. Story 7.4:
 * `autoApprove` ("Tự đăng", cờ từ payload job ảnh) + ảnh xong → duyệt luôn (cần `jobs` để enqueue `publish.target`;
 * thiếu thì để lượt `campaigns.generate` sau duyệt).
 */
export async function settleSlotImage(
  tx: DbExecutor,
  deps: { events: EventPublisher; jobs?: JobSender | undefined; now?: (() => Date) | undefined },
  mediaAssetId: string,
  code: ErrorCode | null,
  opts: { autoApprove?: boolean } = {},
): Promise<void> {
  const linked = await tx
    .select({ id: postTargets.id })
    .from(postTargetMedia)
    .innerJoin(postTargets, eq(postTargets.id, postTargetMedia.postTargetId))
    .where(and(eq(postTargetMedia.mediaAssetId, mediaAssetId), eq(postTargets.status, 'planned' satisfies PostTargetStatus)))
  for (const t of linked) {
    if (code) await tx.delete(postTargetMedia).where(and(eq(postTargetMedia.postTargetId, t.id), eq(postTargetMedia.mediaAssetId, mediaAssetId)))
    const settled = await settle(tx, deps.events, t.id, { errorCode: code })
    if (settled && !code && opts.autoApprove && deps.jobs) {
      await autoApproveSlot(tx, { jobs: deps.jobs, events: deps.events, ...(deps.now ? { now: deps.now } : {}) }, t.id)
    }
  }
}

/** Slot (trang) của một ô ảnh đang gắn — job ảnh tính chi phí `campaign_generate` theo trang đó. */
export async function slotOfAsset(db: DbExecutor, mediaAssetId: string): Promise<{ targetId: string; pageId: string } | null> {
  const [row] = await db
    .select({ targetId: postTargets.id, pageId: postTargets.pageId })
    .from(postTargetMedia)
    .innerJoin(postTargets, eq(postTargets.id, postTargetMedia.postTargetId))
    .where(and(eq(postTargetMedia.mediaAssetId, mediaAssetId), sql`${postTargets.campaignId} is not null`))
    .limit(1)
  return row ?? null
}

export type SlotGenerateDeps = ComposeDeps & { jobs: JobSender; now?: () => Date }

/** `scheduled` = Story 7.4 "Tự đăng": viết xong và đã duyệt luôn. */
export type SlotOutcome = { status: 'ready' | 'scheduled' | 'image_pending' | 'skipped' } | { status: 'error'; errorCode: ErrorCode }

/** Lỗi tạm của OpenAI ở lượt chưa phải cuối — job ném để pg-boss thử lại (slot vẫn `planned`, chưa sinh). */
export class SlotGenerateRetryableError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode) {
    super(`content.slot: ${code}`)
    this.name = 'SlotGenerateRetryableError'
    this.code = code
  }
}

const retryable = (err: AppError) => err.code === 'RATE_LIMITED' || (err.code === 'AI_PROVIDER_ERROR' && err.statusCode >= 500)
const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError'

/** Chiếm slot chưa sinh cho lượt này (lease `SLOT_GENERATE_LEASE_MS`, theo giờ DB); `null` = slot không còn chờ / đang bị giữ. */
async function claimSlot(db: DbExecutor, targetId: string): Promise<Date | null> {
  const [row] = await db
    .update(postTargets)
    .set({ generateLeaseUntil: sql`now() + ${`${SLOT_GENERATE_LEASE_MS} milliseconds`}::interval` })
    .where(and(eq(postTargets.id, targetId), toGenerate(db)))
    .returning({ lease: postTargets.generateLeaseUntil })
  return row?.lease ?? null
}

/**
 * Sinh nội dung một slot `planned` chưa sinh. `goal` = mục tiêu bài suy từ mục tiêu chiến dịch; `withImage` = luật slot
 * (`campaignSlots`). Kết quả: `ready` (`pending_approval`), `scheduled` (Story 7.4 `autoApprove`: đã duyệt luôn),
 * `image_pending` (caption xong, chờ job ảnh), `error` (đã về `pending_approval` kèm mã), `skipped` (slot không còn chờ
 * sinh, hoặc lượt khác đang giữ). Lỗi tạm chưa phải lần cuối → `SlotGenerateRetryableError`.
 */
export async function generateSlot(
  deps: SlotGenerateDeps,
  targetId: string,
  opts: { goal: ComposeGoal; withImage: boolean; finalAttempt: boolean; signal?: AbortSignal | undefined; autoApprove?: boolean },
): Promise<SlotOutcome> {
  const lease = await claimSlot(deps.db, targetId)
  if (!lease) return { status: 'skipped' }
  try {
    return await generateClaimed(deps, targetId, opts)
  } finally {
    // Chưa ghi xong (lỗi tạm, huỷ, lỗi lạ) → trả slot cho lượt sau; đã ghi thì lease đã về null (không khớp, không làm gì).
    await deps.db
      .update(postTargets)
      .set({ generateLeaseUntil: null })
      .where(and(eq(postTargets.id, targetId), eq(postTargets.generateLeaseUntil, lease)))
  }
}

async function generateClaimed(
  deps: SlotGenerateDeps,
  targetId: string,
  opts: { goal: ComposeGoal; withImage: boolean; finalAttempt: boolean; signal?: AbortSignal | undefined; autoApprove?: boolean },
): Promise<SlotOutcome> {
  const [slot] = await deps.db
    .select({ status: postTargets.status, caption: postTargets.caption, pageId: postTargets.pageId, topic: posts.topic })
    .from(postTargets)
    .innerJoin(posts, eq(posts.id, postTargets.postId))
    .where(eq(postTargets.id, targetId))
  if (!slot || slot.status !== 'planned' || slot.caption !== '') return { status: 'skipped' }

  const fail = async (code: ErrorCode): Promise<SlotOutcome> =>
    (await failSlot(deps, targetId, code)) ? { status: 'error', errorCode: code } : { status: 'skipped' }

  // Trang đã gỡ sau khi lưu nháp → chốt mã, không để slot kẹt `planned` (bước 4 hiện "AI đang viết…" và hỏi lại mãi).
  const page = await getPage(deps.db, slot.pageId)
  if (!page) return fail('PAGE_REMOVED')

  const effective = await resolveEffectiveOrNull<BrandProfileDto>(deps.db, page.id, 'brand')
  if (!effective) return fail('CONFIG_MISSING')

  let result
  try {
    result = await composeCaptionForPage(deps, page, effective.config, { topic: slot.topic ?? '', goal: opts.goal, length: 'medium' }, opts.signal, {
      feature: 'campaign_generate',
      ref: targetId,
    })
  } catch (err) {
    if (opts.signal?.aborted) throw err
    if (err instanceof AppError) {
      if (retryable(err) && !opts.finalAttempt) throw new SlotGenerateRetryableError(err.code)
      return fail(err.code)
    }
    if (isAbortError(err)) return fail('AI_PROVIDER_ERROR')
    if (!opts.finalAttempt) throw err
    return fail('INTERNAL')
  }
  if (result.status === 'error') return fail(result.errorCode)
  const caption = result.caption

  // Hậu kiểm vẫn chặn sau một lần sinh lại → giữ caption để chủ shop sửa, không tốn tiền ảnh (AD-21). Không duyệt luôn.
  if (result.violations.length) {
    const done = await deps.db.transaction((tx) => settle(tx, deps.events, targetId, { caption, aiCaption: true, errorCode: 'AI_POLICY_BLOCKED' }))
    return done ? { status: 'error', errorCode: 'AI_POLICY_BLOCKED' } : { status: 'skipped' }
  }
  if (!opts.withImage) {
    return deps.db.transaction(async (tx): Promise<SlotOutcome> => {
      if (!(await settle(tx, deps.events, targetId, { caption, aiCaption: true, errorCode: null }))) return { status: 'skipped' }
      if (!opts.autoApprove) return { status: 'ready' }
      const approved = await autoApproveSlot(tx, { jobs: deps.jobs, events: deps.events, ...(deps.now ? { now: deps.now } : {}) }, targetId)
      return { status: approved === 'scheduled' ? 'scheduled' : 'ready' }
    })
  }

  const description = caption.slice(0, Math.min(IMAGE_DESCRIPTION_MAX, POST_TOPIC_MAX))
  const prompt = buildImagePrompt({ description, style: 'product' })
  return deps.db.transaction(async (tx): Promise<SlotOutcome> => {
    const [row] = await tx
      .update(postTargets)
      .set({ caption, aiCaption: true, generateLeaseUntil: null, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(postTargets.id, targetId), eq(postTargets.status, 'planned' satisfies PostTargetStatus), eq(postTargets.caption, '')))
      .returning({ pageId: postTargets.pageId, campaignId: postTargets.campaignId, version: postTargets.version })
    if (!row) return { status: 'skipped' }
    const [asset] = await tx.insert(mediaAssets).values({ source: 'ai', status: 'pending', prompt }).returning({ id: mediaAssets.id })
    await tx.insert(postTargetMedia).values({ postTargetId: targetId, mediaAssetId: asset!.id, position: 0 })
    // "Tự đăng": job ảnh duyệt luôn khi ảnh xong (cờ đi cùng payload — `content` không đọc chế độ chiến dịch).
    await deps.jobs.send('content.image.generate', { mediaAssetId: asset!.id, ...(opts.autoApprove ? { autoApprove: true } : {}) }, { db: bossDbFor(tx) })
    await deps.events.publishEvent(tx, 'post_target.updated', { id: targetId, pageId: row.pageId, campaignId: row.campaignId, version: row.version })
    return { status: 'image_pending' }
  })
}
