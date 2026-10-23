// Chuyển trạng thái `post_targets` do chủ shop bấm (Story 6.4, AD-13): lên lịch / đăng ngay (`draft → scheduled`), đổi
// giờ (`scheduled → scheduled`), bỏ lịch (`scheduled → draft`), đăng lại (`failed → scheduled`).
// - `transitionTarget`: MỘT target, khoá lạc quan `version`. Mọi chuyển tới `scheduled` gọi `assertPublishable` và kiểm
//   giới hạn đăng/24h của nền tảng, rồi enqueue `publish.target {targetId, scheduleVersion}` `startAfter=scheduled_at`
//   cùng transaction (AD-2). `schedule_version` tăng mỗi lần vào/rời `scheduled` hoặc đổi giờ — job cũ thấy lệch rồi bỏ
//   qua, nên đổi giờ / bỏ lịch an toàn cả khi job cũ đang chờ.
// - `transitionPostTargets`: nhiều target của một bài, tất cả hoặc không (Soạn bài "Lên lịch" cho mọi trang).
// Phần job (`scheduled → publishing → published|failed`) ở `publish.ts`, cũng là `UPDATE` có điều kiện trạng thái.
// Không gọi Meta ở đây.
import { PLATFORM_RULES, SCHEDULE_MAX_AHEAD_MS, type ParsedTransitionTargetsRequest, type PostDto, type PostTargetStatus, type TargetAction } from '@ottm/shared'
import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm'
import { bossDbFor, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { getPage } from '../pages/index.ts'
import { getPost } from './posts.ts'
import { assertPublishable } from './publishable.ts'
import { postTargets, posts } from './schema.ts'

export interface TransitionDeps {
  jobs: JobSender
  now?: () => Date
}

/** Hành động + thời điểm: `'now'` = đăng ngay (giờ máy chủ); giờ cụ thể phải ở tương lai. */
export type TargetTransition = { action: Exclude<TargetAction, 'unschedule'>; at: Date | 'now' } | { action: 'unschedule' }

/** Trạng thái nguồn hợp lệ của từng hành động (bảng AD-13). */
const FROM: Record<TargetAction, PostTargetStatus> = {
  schedule: 'draft',
  reschedule: 'scheduled',
  unschedule: 'scheduled',
  retry: 'failed',
}

const DAY_MS = 24 * 60 * 60_000

/** Trạng thái được tính vào giới hạn đăng/24h: đã lên lịch, đang đăng, đã đăng. */
const COUNTED: readonly PostTargetStatus[] = ['scheduled', 'publishing', 'published']

/**
 * Giới hạn đăng/24h của nền tảng (`PLATFORM_RULES.dailyPublishMax`): đếm bài của trang có mốc (`published_at`, chưa
 * đăng thì `scheduled_at`) trong (t−24h, t+24h) — bảo thủ: mọi cửa sổ 24 giờ chứa t đều nằm trong khoảng này. Khoá
 * advisory theo trang để hai lần lên lịch song song không cùng lọt.
 */
async function assertDailyLimit(tx: DbExecutor, target: { id: string; pageId: string }, at: Date): Promise<void> {
  const page = await getPage(tx, target.pageId)
  const max = page ? PLATFORM_RULES[page.platform].dailyPublishMax : null
  if (max === null) return
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`publish_limit:${target.pageId}`}, 0))`)
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
    .select({ id: postTargets.id, pageId: postTargets.pageId, status: postTargets.status, version: postTargets.version })
    .from(postTargets)
    .where(eq(postTargets.id, targetId))
    .for('update')
  if (!target) throw new AppError('NOT_FOUND', 404, { message: 'Đích của bài không tồn tại', details: { targetId } })
  if (target.version !== expectedVersion || target.status !== FROM[transition.action]) {
    throw new AppError('VERSION_CONFLICT', 409, {
      message: 'Trạng thái bài vừa đổi',
      details: { targetId, status: target.status, version: target.version },
    })
  }

  if (transition.action === 'unschedule') {
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
    if (at.getTime() <= now.getTime()) {
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
    .select({ id: postTargets.id })
    .from(postTargets)
    .where(and(eq(postTargets.postId, postId), inArray(postTargets.id, ids)))
    .orderBy(asc(postTargets.id))
    .for('update')
  const ownedIds = new Set(owned.map((t) => t.id))
  const stranger = ids.find((id) => !ownedIds.has(id))
  if (stranger) throw new AppError('NOT_FOUND', 404, { message: 'Đích không thuộc bài này', details: { postId, targetId: stranger } })

  const transition: TargetTransition =
    input.action === 'unschedule'
      ? { action: 'unschedule' }
      : { action: input.action, at: input.scheduledAt ? new Date(input.scheduledAt) : 'now' }
  // "Đăng ngay": mọi target cùng một mốc.
  const now = deps.now?.() ?? new Date()
  const fixed = { ...deps, now: () => now }
  for (const t of input.targets) await transitionTarget(tx, fixed, t.id, transition, t.version)
  return (await getPost(tx, postId))!
}
