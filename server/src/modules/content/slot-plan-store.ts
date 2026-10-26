// Kế hoạch nội dung lưu ở slot (Story 7.8): cột `post_targets.plan` (jsonb). Đọc phòng thủ bằng zod (dòng cũ / dữ liệu lạ →
// coi như chưa có), rút phần trả FE (`SlotPlanSummary`), phần prompt caption cần (`ComposePlan`), và câu mở của các bài
// gần nhất cùng chiến dịch + trang để caption / kế hoạch kế tiếp không lặp. Tách khỏi `slot-plans.ts` (lời gọi AI) để
// `slots.ts` dùng mà không tạo vòng phụ thuộc. Không log nội dung.
import { ContentFormat, FunnelStage, type PostTargetStatus, type SlotPlanSummary } from '@ottm/shared'
import { and, asc, eq, ne, notInArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { DbExecutor } from '../../platform/db/index.ts'
import type { CampaignPlanItem, ComposePlan } from '../ai/index.ts'
import { postTargets } from './schema.ts'

const OkPlan = z.object({
  status: z.literal('ok'),
  format: ContentFormat,
  funnelStage: FunnelStage,
  title: z.string(),
  angle: z.string(),
  hook: z.string(),
  brief: z.string(),
  imageIdea: z.string(),
  cta: z.string(),
})
const StoredSlotPlan = z.discriminatedUnion('status', [OkPlan, z.object({ status: z.literal('failed') })])

/** Giá trị cột `plan`: brief đầy đủ, hoặc `failed` (đã lên mà hỏng — không lên lại, trừ "Tạo lại"). */
export type StoredSlotPlan = z.infer<typeof StoredSlotPlan>
export type OkSlotPlan = z.infer<typeof OkPlan>

export const okSlotPlan = (item: CampaignPlanItem): StoredSlotPlan => ({ status: 'ok', ...item })
export const FAILED_SLOT_PLAN: StoredSlotPlan = { status: 'failed' }

/** Điều kiện SQL "slot có brief dùng được". */
export const hasOkPlan = sql`${postTargets.plan} ->> 'status' = 'ok'`

/** Brief dùng được của slot; chưa lên / `failed` / dữ liệu lạ → `null`. */
export function readSlotPlan(raw: unknown): OkSlotPlan | null {
  if (raw === null || raw === undefined) return null
  const parsed = StoredSlotPlan.safeParse(raw)
  return parsed.success && parsed.data.status === 'ok' ? parsed.data : null
}

/** Phần trả FE (thẻ bài, hàng chờ duyệt, Lịch). */
export function planSummary(raw: unknown): SlotPlanSummary | null {
  const plan = readSlotPlan(raw)
  return plan ? { format: plan.format, funnelStage: plan.funnelStage, title: plan.title, angle: plan.angle } : null
}

/** Phần prompt caption cần (`ai.buildComposePrompt` — tiêu đề / ý ảnh dành cho ảnh). */
export function composePlanOf(plan: OkSlotPlan): ComposePlan {
  return { format: plan.format, funnelStage: plan.funnelStage, angle: plan.angle, hook: plan.hook, brief: plan.brief, cta: plan.cta }
}

/** Độ dài tối đa của câu mở rút từ caption. */
const OPENING_MAX = 160

/** Câu mở của caption: dòng có chữ đầu tiên, gộp khoảng trắng, cắt ≤ `OPENING_MAX` theo code point. */
export function captionOpening(caption: string): string {
  const line = caption.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? ''
  const chars = [...line]
  return chars.length > OPENING_MAX ? `${chars.slice(0, OPENING_MAX - 1).join('')}…` : line
}

/** Slot cùng chiến dịch + trang (khác `excludeIds`, chưa huỷ) đã có caption hoặc brief, gần `anchor` nhất trước. */
export async function nearbySlots(
  db: DbExecutor,
  where: { campaignId: string; pageId: string; anchor: Date; excludeIds: readonly string[] },
  limit: number,
): Promise<{ caption: string; plan: unknown }[]> {
  return db
    .select({ caption: postTargets.caption, plan: postTargets.plan })
    .from(postTargets)
    .where(
      and(
        eq(postTargets.campaignId, where.campaignId),
        eq(postTargets.pageId, where.pageId),
        ne(postTargets.status, 'cancelled' satisfies PostTargetStatus),
        where.excludeIds.length ? notInArray(postTargets.id, [...where.excludeIds]) : undefined,
        or(ne(postTargets.caption, ''), hasOkPlan),
      ),
    )
    .orderBy(sql`abs(extract(epoch from ${postTargets.slotAt} - ${where.anchor.toISOString()}::timestamptz))`, asc(postTargets.id))
    .limit(limit)
}

/**
 * Câu mở của các bài gần slot này nhất (cùng chiến dịch + trang, trừ chính nó): caption đã viết → dòng đầu; chưa viết mà
 * có brief (bài cùng lô đang viết song song) → câu mở của brief. Cho prompt caption "không lặp".
 */
export async function recentOpenings(
  db: DbExecutor,
  slot: { id: string; campaignId: string; pageId: string; slotAt: Date },
  limit: number,
): Promise<string[]> {
  const rows = await nearbySlots(db, { campaignId: slot.campaignId, pageId: slot.pageId, anchor: slot.slotAt, excludeIds: [slot.id] }, limit)
  return rows.map((r) => (r.caption ? captionOpening(r.caption) : (readSlotPlan(r.plan)?.hook ?? ''))).filter(Boolean)
}
