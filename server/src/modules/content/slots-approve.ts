// Duyệt tự động bài chiến dịch ở chế độ "Tự đăng" (Story 7.3 lúc bắt đầu, Story 7.4 khi AI viết xong — AD-15, AD-13).
// `content` không biết chế độ của chiến dịch (AD-1): bên gọi (`campaigns`, hoặc job ảnh theo cờ trong payload do
// `campaigns` đặt) quyết định có duyệt luôn hay không.
// - Chỉ bài `pending_approval` KHÔNG mã lỗi, không `held`: bài AI lỗi / ảnh lỗi / hậu kiểm chặn luôn về "Chờ duyệt", kể cả
//   "Tự đăng".
// - Duyệt = hành động `approve` của `transitionTarget` tại giờ hiện tại của bài (luật nền tảng, giới hạn/24h, enqueue
//   `publish.target`), bọc savepoint: 422 (giờ đã qua / còn dưới 2 phút, vi phạm luật, chạm giới hạn) → giữ
//   `pending_approval` kèm mã đó, không làm hỏng transaction của bên gọi.
import type { PostTargetStatus } from '@ottm/shared'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { postTargets } from './schema.ts'
import { lockDailyLimits, transitionTarget, type TransitionDeps } from './transitions.ts'

export type AutoApproveOutcome = 'scheduled' | 'needs_review' | 'skipped'

/** Duyệt một bài (chạy trong transaction của bên gọi). Bài không đủ điều kiện → `skipped`, không đổi gì. */
export async function autoApproveSlot(tx: DbExecutor, deps: TransitionDeps, targetId: string): Promise<AutoApproveOutcome> {
  const [t] = await tx
    .select({ status: postTargets.status, errorCode: postTargets.errorCode, held: postTargets.held, scheduledAt: postTargets.scheduledAt, slotAt: postTargets.slotAt, version: postTargets.version })
    .from(postTargets)
    .where(eq(postTargets.id, targetId))
  if (!t || t.status !== ('pending_approval' satisfies PostTargetStatus) || t.errorCode !== null || t.held || !t.slotAt) return 'skipped'
  try {
    // Savepoint: bài không duyệt được chỉ hoàn tác phần của bài đó.
    await tx.transaction((sp) => transitionTarget(sp, deps, targetId, { action: 'approve', at: t.scheduledAt ?? t.slotAt! }, t.version))
    return 'scheduled'
  } catch (err) {
    if (!(err instanceof AppError) || err.statusCode !== 422) throw err
    await tx
      .update(postTargets)
      .set({ errorCode: err.code, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(postTargets.id, targetId), eq(postTargets.status, 'pending_approval' satisfies PostTargetStatus)))
    return 'needs_review'
  }
}

/**
 * Duyệt mọi bài chờ duyệt không mã lỗi, không `held` của chiến dịch (theo giờ đăng). Thứ tự khoá như
 * `transitionPostTargets`: dòng target (theo id) → khoá giới hạn/24h (theo `pageId` tăng dần) — chủ shop duyệt tay cùng
 * lúc không khoá chéo.
 */
export async function autoApproveCampaignSlots(tx: DbExecutor, deps: TransitionDeps, campaignId: string): Promise<{ scheduled: number; needsReview: number }> {
  const now = deps.now?.() ?? new Date()
  const fixed: TransitionDeps = { ...deps, now: () => now }
  const ready = await tx
    .select({ id: postTargets.id, pageId: postTargets.pageId, scheduledAt: postTargets.scheduledAt })
    .from(postTargets)
    .where(
      and(
        eq(postTargets.campaignId, campaignId),
        eq(postTargets.status, 'pending_approval' satisfies PostTargetStatus),
        isNull(postTargets.errorCode),
        eq(postTargets.held, false),
      ),
    )
    .orderBy(asc(postTargets.id))
    .for('update')
  if (!ready.length) return { scheduled: 0, needsReview: 0 }
  await lockDailyLimits(tx, ready.map((t) => t.pageId))
  let scheduled = 0
  let needsReview = 0
  const byTime = [...ready].sort((a, b) => (a.scheduledAt?.getTime() ?? 0) - (b.scheduledAt?.getTime() ?? 0))
  for (const t of byTime) {
    const outcome = await autoApproveSlot(tx, fixed, t.id)
    if (outcome === 'scheduled') scheduled++
    else if (outcome === 'needs_review') needsReview++
  }
  return { scheduled, needsReview }
}
