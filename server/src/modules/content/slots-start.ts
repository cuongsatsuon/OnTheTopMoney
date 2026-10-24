// "Bắt đầu chiến dịch" phía slot (Story 7.3, AD-15, AD-13). `campaigns` gọi trong transaction bắt đầu của nó (đã khoá dòng
// chiến dịch, đã kiểm trang) với kế hoạch đầy đủ `campaignSlots` — `content` không đọc bảng `campaigns` (AD-1):
// - tạo idempotent slot còn thiếu (khoá `(campaign_id, page_id, slot_at)`) ở `planned`, lên Lịch ngay (`scheduled_at =
//   slot_at`); slot đã qua giờ lúc bắt đầu thì không tạo (không còn đăng được);
// - 7 bài xem trước giữ nguyên nội dung, bỏ `held`, có giờ trên Lịch; bài đã xoá ở bước 4 vẫn `cancelled`;
// - "Tự đăng": bài xem trước đã viết xong, không mã lỗi → `approve` (`pending_approval → scheduled`, luật nền tảng +
//   giới hạn/24h + enqueue `publish.target`). Bài không duyệt được (giờ đã qua / còn dưới 2 phút, vi phạm luật, chạm
//   giới hạn) giữ `pending_approval` kèm mã (về "Chờ duyệt" — AD-15), không làm hỏng cả lần bắt đầu.
// Thứ tự khoá: dòng slot (theo id) → khoá advisory giới hạn/24h (theo `pageId` tăng dần) — cùng chiều `transitionPostTargets`.
// Không gọi Meta / OpenAI.
import { CAMPAIGN_SLOT_MIN_LEAD_MS, type PostTargetStatus } from '@ottm/shared'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { postTargets } from './schema.ts'
import { autoApproveCampaignSlots } from './slots-approve.ts'
import { ensureCampaignSlots, type SlotPlan } from './slots.ts'
import type { TransitionDeps } from './transitions.ts'

export interface StartSlotsResult {
  /** Slot mới tạo (`planned`). */
  created: number
  /** Bài xem trước vừa bỏ `held` và lên Lịch. */
  released: number
  /** Bài xem trước đã lên lịch đăng ("Tự đăng"). */
  scheduled: number
  /** Bài xem trước "Tự đăng" không duyệt được → "Chờ duyệt" kèm mã. */
  needsReview: number
}

const PREVIEW_STATUSES: readonly PostTargetStatus[] = ['planned', 'pending_approval']

export async function startCampaignSlots(
  tx: DbExecutor,
  deps: TransitionDeps,
  campaignId: string,
  plan: readonly SlotPlan[],
  opts: { autoPublish: boolean },
): Promise<StartSlotsResult> {
  const now = deps.now?.() ?? new Date()
  const fixed: TransitionDeps = { ...deps, now: () => now }
  await tx.select({ id: postTargets.id }).from(postTargets).where(eq(postTargets.campaignId, campaignId)).orderBy(asc(postTargets.id)).for('update')

  const future = plan.filter((s) => s.slotAt.getTime() > now.getTime() + CAMPAIGN_SLOT_MIN_LEAD_MS)
  const created = await ensureCampaignSlots(tx, campaignId, future, { held: false, onCalendar: true })

  const released = await tx
    .update(postTargets)
    .set({ held: false, scheduledAt: sql`coalesce(${postTargets.scheduledAt}, ${postTargets.slotAt})`, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(postTargets.campaignId, campaignId), eq(postTargets.held, true), inArray(postTargets.status, [...PREVIEW_STATUSES])))
    .returning({ id: postTargets.id })
  // Bài đã xoá ở bước 4: chỉ bỏ cờ giữ (không lên Lịch — lịch bỏ qua `cancelled`).
  await tx.update(postTargets).set({ held: false }).where(and(eq(postTargets.campaignId, campaignId), eq(postTargets.held, true)))

  // "Tự đăng": bài xem trước đã viết xong, không mã lỗi → duyệt (savepoint từng bài — `slots-approve.ts`).
  const approved = opts.autoPublish ? await autoApproveCampaignSlots(tx, fixed, campaignId) : { scheduled: 0, needsReview: 0 }
  return { created, released: released.length, ...approved }
}
