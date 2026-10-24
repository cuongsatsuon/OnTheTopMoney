// Chuyển trạng thái `post_targets` do chủ shop bấm (Story 6.4, AD-13): lên lịch / đăng ngay (`draft → scheduled`), đổi
// giờ (`scheduled → scheduled` — cả kéo thả trên Lịch nội dung, Story 6.5), bỏ lịch (`scheduled → draft`), đăng lại
// (`failed → scheduled`), xoá (Story 6.5: mọi trạng thái trước `publishing` và `failed` → `cancelled` + `cancel_reason`,
// phát `post_target.cancelled`). Story 7.2 (slot chiến dịch, AD-13): sửa caption bài chờ duyệt (`pending_approval →
// pending_approval`) và tạo lại (`pending_approval → planned` — `campaigns` sinh lại), đều khoá `version` và phát
// `post_target.updated`. Story 7.3: duyệt (`approve`: `pending_approval → scheduled`, cùng đường tới `scheduled`) — "Bắt
// đầu chiến dịch" ở chế độ "Tự đăng" dùng cho bài xem trước (7.4 dùng cho "Bài chờ duyệt"); slot chiến dịch không bỏ lịch
// được (không thành bài nháp).
// - `transitionTarget`: MỘT target, khoá lạc quan `version`. Mọi chuyển tới `scheduled` gọi `assertPublishable` và kiểm
//   giới hạn đăng/24h của nền tảng, rồi enqueue `publish.target {targetId, scheduleVersion}` `startAfter=scheduled_at`
//   cùng transaction (AD-2). `schedule_version` tăng mỗi lần vào/rời `scheduled` hoặc đổi giờ — job cũ thấy lệch rồi bỏ
//   qua, nên đổi giờ / bỏ lịch an toàn cả khi job cũ đang chờ.
// - `transitionPostTargets`: nhiều target của một bài, tất cả hoặc không (Soạn bài "Lên lịch" cho mọi trang).
// Phần job (`scheduled → publishing → published|failed`) ở `publish.ts`, cũng là `UPDATE` có điều kiện trạng thái.
// Không gọi Meta ở đây.
import {
  CAMPAIGN_SLOT_MIN_LEAD_MS,
  PLATFORM_RULES,
  SCHEDULE_MAX_AHEAD_MS,
  type CancelReason,
  type ParsedTransitionTargetsRequest,
  type PostDto,
  type PostTargetStatus,
  type TargetAction,
} from '@ottm/shared'
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm'
import { bossDbFor, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { getPage } from '../pages/index.ts'
import { getPost } from './posts.ts'
import { assertPublishable } from './publishable.ts'
import { postTargetMedia, postTargets, posts } from './schema.ts'

export interface TransitionDeps {
  jobs: JobSender
  /** Phát `post_target.cancelled` khi xoá (Story 6.5). */
  events: EventPublisher
  now?: () => Date
}

/**
 * Hành động + thời điểm: `'now'` = đăng ngay (giờ máy chủ); giờ cụ thể phải ở tương lai. Xoá kèm lý do (AD-13).
 * Story 7.2: `edit` (caption mới của bài chờ duyệt) và `regenerate` (tạo lại) chỉ cho slot chiến dịch — không có trong
 * `TargetAction` của route Soạn bài / Lịch.
 */
export type TargetTransition =
  | { action: Exclude<TargetAction, 'unschedule' | 'cancel'>; at: Date | 'now' }
  | { action: 'unschedule' }
  | { action: 'cancel'; reason: CancelReason }
  | { action: 'edit'; caption: string }
  | { action: 'regenerate' }
  | { action: 'approve'; at: Date }

/** Trạng thái nguồn hợp lệ của từng hành động (bảng AD-13). */
const FROM: Record<TargetTransition['action'], readonly PostTargetStatus[]> = {
  schedule: ['draft'],
  reschedule: ['scheduled'],
  unschedule: ['scheduled'],
  retry: ['failed'],
  // "Mọi trạng thái trước `publishing`" + bài lỗi (chưa lên trang — xoá khỏi lịch).
  cancel: ['planned', 'draft', 'pending_approval', 'scheduled', 'failed'],
  edit: ['pending_approval'],
  regenerate: ['pending_approval'],
  approve: ['pending_approval'],
}

/** Hành động của chủ shop đưa target tới `scheduled` (qua luật nền tảng + giới hạn/24h); `approve` cũng vậy. */
const TO_SCHEDULED: readonly TargetAction[] = ['schedule', 'reschedule', 'retry']

const DAY_MS = 24 * 60 * 60_000

/** Trạng thái được tính vào giới hạn đăng/24h: đã lên lịch, đang đăng, đã đăng. */
const COUNTED: readonly PostTargetStatus[] = ['scheduled', 'publishing', 'published']

async function dailyLimitOf(tx: DbExecutor, pageId: string): Promise<number | null> {
  const page = await getPage(tx, pageId)
  return page ? PLATFORM_RULES[page.platform].dailyPublishMax : null
}

/** Khoá advisory theo trang tới hết transaction (lấy lại trong cùng transaction không chờ). */
async function lockDailyLimit(tx: DbExecutor, pageId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`publish_limit:${pageId}`}, 0))`)
}

/**
 * Lấy trước khoá giới hạn/24h của các trang (chỉ trang có `dailyPublishMax`) theo `pageId` tăng dần — bên gọi chuyển nhiều
 * target tới `scheduled` trong một transaction gọi trước vòng lặp, để hai transaction không khoá chéo nhau.
 */
export async function lockDailyLimits(tx: DbExecutor, pageIds: readonly string[]): Promise<void> {
  for (const pageId of [...new Set(pageIds)].sort()) {
    if ((await dailyLimitOf(tx, pageId)) !== null) await lockDailyLimit(tx, pageId)
  }
}

/**
 * Giới hạn đăng/24h của nền tảng (`PLATFORM_RULES.dailyPublishMax`): đếm bài của trang có mốc (`published_at`, chưa
 * đăng thì `scheduled_at`) trong (t−24h, t+24h) — bảo thủ: mọi cửa sổ 24 giờ chứa t đều nằm trong khoảng này. Khoá
 * advisory theo trang để hai lần lên lịch song song không cùng lọt.
 */
async function assertDailyLimit(tx: DbExecutor, target: { id: string; pageId: string }, at: Date): Promise<void> {
  const max = await dailyLimitOf(tx, target.pageId)
  if (max === null) return
  await lockDailyLimit(tx, target.pageId)
  const mark = sql`coalesce(${postTargets.publishedAt}, ${postTargets.scheduledAt})`
  const [row] = await tx
    .select({ n: count() })
    .from(postTargets)
    .where(
      and(
        eq(postTargets.pageId, target.pageId),
        ne(postTargets.id, target.id),
        inArray(postTargets.status, [...COUNTED]),
        sql`${mark} > ${new Date(at.getTime() - DAY_MS).toISOString()}::timestamptz`,
        sql`${mark} < ${new Date(at.getTime() + DAY_MS).toISOString()}::timestamptz`,
      ),
    )
  if ((row?.n ?? 0) >= max) {
    throw new AppError('PUBLISH_LIMIT_REACHED', 422, {
      message: 'Trang đã chạm giới hạn đăng bài trong 24 giờ',
      details: { targetId: target.id, pageId: target.pageId, limit: max },
    })
  }
}

/**
 * Một chuyển trạng thái của chủ shop trên target `targetId` (chạy trong transaction của bên gọi, khoá dòng target).
 * Không có → 404; `version` lệch hoặc sai trạng thái nguồn → 409 `VERSION_CONFLICT`; giờ đã qua → 422
 * `SCHEDULE_IN_PAST`; quá xa → 400; vi phạm luật nền tảng / giới hạn/24h → 422 với mã tương ứng.
 */
export async function transitionTarget(
  tx: DbExecutor,
  deps: TransitionDeps,
  targetId: string,
  transition: TargetTransition,
  expectedVersion: number,
): Promise<void> {
  const now = deps.now?.() ?? new Date()
  const [target] = await tx
    .select({ id: postTargets.id, pageId: postTargets.pageId, campaignId: postTargets.campaignId, status: postTargets.status, version: postTargets.version })
    .from(postTargets)
    .where(eq(postTargets.id, targetId))
    .for('update')
  if (!target) throw new AppError('NOT_FOUND', 404, { message: 'Đích của bài không tồn tại', details: { targetId } })
  if (target.version !== expectedVersion || !FROM[transition.action].includes(target.status as PostTargetStatus)) {
    throw new AppError('VERSION_CONFLICT', 409, {
      message: 'Trạng thái bài vừa đổi',
      details: { targetId, status: target.status, version: target.version },
    })
  }

  if (transition.action === 'cancel') {
    const [row] = await tx
      .update(postTargets)
      .set({
        status: 'cancelled' satisfies PostTargetStatus,
        cancelReason: transition.reason,
        errorCode: null,
        // Rời `scheduled` → job đang chờ thấy lệch rồi bỏ qua.
        ...(target.status === 'scheduled' ? { scheduleVersion: sql`${postTargets.scheduleVersion} + 1` } : {}),
        version: sql`${postTargets.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(postTargets.id, targetId))
      .returning({ version: postTargets.version })
    await deps.events.publishEvent(tx, 'post_target.cancelled', { id: targetId, pageId: target.pageId, campaignId: target.campaignId, version: row!.version })
    return
  }

  if (transition.action === 'edit' || transition.action === 'regenerate') {
    // Sửa: chủ shop đã xem lại nội dung → bỏ mã lỗi (AI / hậu kiểm); nhãn "AI tạo" giữ nguyên (UX-DR10).
    // Tạo lại: về `planned`, bỏ caption / mã / ảnh gắn (ô ảnh cũ thành ảnh không gắn — cron dọn sau 7 ngày).
    if (transition.action === 'regenerate') await tx.delete(postTargetMedia).where(eq(postTargetMedia.postTargetId, targetId))
    const [row] = await tx
      .update(postTargets)
      .set({
        ...(transition.action === 'edit'
          ? { caption: transition.caption }
          : { status: 'planned' satisfies PostTargetStatus, caption: '', aiCaption: false }),
        errorCode: null,
        version: sql`${postTargets.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(postTargets.id, targetId))
      .returning({ version: postTargets.version })
    await deps.events.publishEvent(tx, 'post_target.updated', { id: targetId, pageId: target.pageId, campaignId: target.campaignId, version: row!.version })
    return
  }

  if (transition.action === 'unschedule') {
    // Slot chiến dịch không về nháp (nháp là của Soạn bài); muốn bỏ bài thì Xoá.
    if (target.campaignId !== null) {
      throw new AppError('VERSION_CONFLICT', 409, { message: 'Bài chiến dịch không bỏ lịch được', details: { targetId, campaignId: target.campaignId } })
    }
    await tx
      .update(postTargets)
      .set({
        status: 'draft' satisfies PostTargetStatus,
        scheduledAt: null,
        scheduleVersion: sql`${postTargets.scheduleVersion} + 1`,
        version: sql`${postTargets.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(postTargets.id, targetId))
    return
  }

  const at = transition.at === 'now' ? now : transition.at
  if (transition.at !== 'now') {
    // Duyệt bài chiến dịch: còn dưới `CAMPAIGN_SLOT_MIN_LEAD_MS` cũng coi là đã qua (AD-15) — FE hỏi giờ mới.
    const lead = transition.action === 'approve' ? CAMPAIGN_SLOT_MIN_LEAD_MS : 0
    if (at.getTime() <= now.getTime() + lead) {
      throw new AppError('SCHEDULE_IN_PAST', 422, { message: 'Thời gian đăng đã qua', details: { targetId } })
    }
    if (at.getTime() - now.getTime() > SCHEDULE_MAX_AHEAD_MS) {
      throw new AppError('VALIDATION_FAILED', 400, { message: 'Thời gian đăng quá xa', details: [{ path: ['scheduledAt'], message: 'Chỉ lên lịch trong vòng một năm' }] })
    }
  }
  await assertPublishable(tx, targetId)
  await assertDailyLimit(tx, target, at)
  const [row] = await tx
    .update(postTargets)
    .set({
      status: 'scheduled' satisfies PostTargetStatus,
      scheduledAt: at,
      scheduleVersion: sql`${postTargets.scheduleVersion} + 1`,
      version: sql`${postTargets.version} + 1`,
      errorCode: null,
      publishingAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(postTargets.id, targetId))
    .returning({ scheduleVersion: postTargets.scheduleVersion })
  await deps.jobs.send('publish.target', { targetId, scheduleVersion: row!.scheduleVersion }, { startAfter: at, db: bossDbFor(tx) })
}

/**
 * Một hành động cho nhiều target của bài `postId` (`POST /posts/:id/targets/transition`), tất cả hoặc không. Khoá dòng
 * `posts` rồi các target theo id (cùng thứ tự với `updateDraftPost` — không deadlock). Target không thuộc bài → 404.
 * Hành động tới `scheduled`: lấy trước khoá giới hạn/24h của mọi trang có giới hạn theo `pageId` tăng dần — hai request
 * chạm cùng các trang theo thứ tự body ngược nhau không deadlock (khoá xact lấy lại trong vòng lặp không chờ).
 */
export async function transitionPostTargets(
  tx: DbExecutor,
  deps: TransitionDeps,
  postId: string,
  input: ParsedTransitionTargetsRequest,
): Promise<PostDto> {
  const [post] = await tx.select({ id: posts.id }).from(posts).where(eq(posts.id, postId)).for('update')
  if (!post) throw new AppError('NOT_FOUND', 404, { message: 'Bài không tồn tại', details: { postId } })
  const ids = input.targets.map((t) => t.id)
  const owned = await tx
    .select({ id: postTargets.id, pageId: postTargets.pageId })
    .from(postTargets)
    .where(and(eq(postTargets.postId, postId), inArray(postTargets.id, ids)))
    .orderBy(asc(postTargets.id))
    .for('update')
  const ownedIds = new Set(owned.map((t) => t.id))
  const stranger = ids.find((id) => !ownedIds.has(id))
  if (stranger) throw new AppError('NOT_FOUND', 404, { message: 'Đích không thuộc bài này', details: { postId, targetId: stranger } })

  if (TO_SCHEDULED.includes(input.action)) await lockDailyLimits(tx, owned.map((t) => t.pageId))

  const transition: TargetTransition =
    input.action === 'unschedule'
      ? { action: 'unschedule' }
      : input.action === 'cancel'
        ? { action: 'cancel', reason: 'USER_DELETED' }
        : { action: input.action, at: input.scheduledAt ? new Date(input.scheduledAt) : 'now' }
  // "Đăng ngay": mọi target cùng một mốc.
  const now = deps.now?.() ?? new Date()
  const fixed = { ...deps, now: () => now }
  for (const t of input.targets) await transitionTarget(tx, fixed, t.id, transition, t.version)
  return (await getPost(tx, postId))!
}
