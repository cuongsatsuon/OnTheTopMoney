// Lên kế hoạch nội dung cho một lô slot chiến dịch (Story 7.8). `campaigns` gọi trước mỗi lô sinh (7 bài xem trước / lô
// cuốn chiếu) với ngữ cảnh chiến dịch (tên, mục tiêu, có ảnh sản phẩm) — `content` không biết bảng `campaigns` (AD-1).
// - Chỉ slot của lô còn chờ sinh (`planned`, caption rỗng, chưa gắn ảnh) và chưa có `plan`. Chiếm bằng lease có sẵn
//   (`generate_lease_until`, một `UPDATE … RETURNING`) rồi nhả sau khi ghi: hai job (xem trước + cuốn chiếu, retry chồng)
//   không cùng lên / cùng tính tiền một slot; trong lúc lên, `generateSlot` của job khác gặp lease thì bỏ qua slot.
// - Gom theo trang, một lời gọi `generateText(feature='campaign_generate', ref=campaignId, jsonSchema)` mỗi trang (tối đa
//   `PLAN_CONCURRENCY` trang song song — vừa lease). Ngữ cảnh: hồ sơ hiệu lực + kho kiến thức của trang, bài đã có gần
//   nhất cùng chiến dịch + trang, số lần đã dùng mỗi định dạng.
// - Kết quả mỗi slot: brief (`ok`) hoặc `failed` (thiếu trong đầu ra, JSON hỏng, có từ cấm / link lạ, lỗi có thể đã tính
//   tiền) — `failed` không lên lại (không tính tiền lần nữa). Lỗi chưa tính tiền (hạn mức, khoá, 429, 5xx) → để `null`:
//   lô vẫn chạy, lỗi dừng xử lý ở `generateSlot` như 7.4 / 7.6. Huỷ (`signal`) → ném. Không bao giờ chặn bài.
// Không log prompt / brief.
import { KNOWLEDGE_MAX_TOKENS, type BrandProfileDto, type CampaignGoal, type ContentFormat, type PostTargetStatus } from '@ottm/shared'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { AppError } from '../../platform/errors/index.ts'
import {
  CAMPAIGN_PLAN_HISTORY_MAX,
  buildCampaignPlanPrompt,
  checkOutput,
  generateText,
  isMaybeBilled,
  parseCampaignPlanOutput,
  type CampaignPlanHistoryItem,
} from '../ai/index.ts'
import { getPage } from '../pages/index.ts'
import { pageKnowledge, resolveEffectiveOrNull } from '../profiles/index.ts'
import { AI_STOP_CODES, type ComposeDeps } from './compose.ts'
import { postTargets, posts } from './schema.ts'
import { FAILED_SLOT_PLAN, captionOpening, hasOkPlan, nearbySlots, okSlotPlan, readSlotPlan, type StoredSlotPlan } from './slot-plan-store.ts'
import { SLOT_GENERATE_LEASE_MS, toGenerate } from './slots.ts'

/** Số trang lên kế hoạch song song [ASSUMPTION]: 3 lượt × ≤ 120 giây vẫn trong lease 10 phút. */
export const PLAN_CONCURRENCY = 3

/** Ngữ cảnh chiến dịch do `campaigns` truyền. */
export interface CampaignPlanRequest {
  campaignName: string
  campaignGoal: CampaignGoal
  /** Story 7.7: ảnh bài dựng từ ảnh sản phẩm của chiến dịch. */
  withReference: boolean
}

export interface PlanSlotsResult {
  /** Slot vừa có brief. */
  planned: number
  /** Slot vừa ghi `failed`. */
  failed: number
  /** Số lời gọi AI đã gửi. */
  calls: number
}

const WEEKDAYS = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy']

/** Ngày giờ VN của slot: `Thứ Ba 28/10` + tháng `10/2026`. */
function vnDay(at: Date): { day: string; month: string } {
  const v = new Date(at.getTime() + 7 * 60 * 60_000)
  const dd = String(v.getUTCDate()).padStart(2, '0')
  const mm = String(v.getUTCMonth() + 1).padStart(2, '0')
  return { day: `${WEEKDAYS[v.getUTCDay()]} ${dd}/${mm}`, month: `${mm}/${v.getUTCFullYear()}` }
}

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError'
/** Lỗi sau khi lời gọi đã tính tiền (gateway gắn `details.usageId`, vd `AI_POLICY_BLOCKED` do model từ chối). */
const isBilled = (err: unknown): boolean => err instanceof AppError && typeof (err.details as { usageId?: unknown } | undefined)?.usageId === 'string'

interface ClaimedSlot {
  id: string
  pageId: string
  slotAt: Date
  topic: string
  withImage: boolean
}

/**
 * Lên brief cho các slot `slots` của chiến dịch `campaignId` chưa có brief (xem đầu file). Trả số slot đã ghi / số lời
 * gọi. Chạy lại an toàn: slot đã có `plan` (kể cả `failed`) bỏ qua.
 */
export async function planCampaignSlots(
  deps: ComposeDeps,
  campaignId: string,
  slots: readonly { id: string; withImage: boolean }[],
  req: CampaignPlanRequest,
  signal?: AbortSignal,
): Promise<PlanSlotsResult> {
  const out: PlanSlotsResult = { planned: 0, failed: 0, calls: 0 }
  if (!slots.length) return out
  const withImage = new Map(slots.map((s) => [s.id, s.withImage]))
  const claimed = await deps.db
    .update(postTargets)
    .set({ generateLeaseUntil: sql`now() + ${`${SLOT_GENERATE_LEASE_MS} milliseconds`}::interval` })
    .where(and(inArray(postTargets.id, [...withImage.keys()]), eq(postTargets.campaignId, campaignId), isNull(postTargets.plan), toGenerate(deps.db)))
    .returning({ id: postTargets.id, pageId: postTargets.pageId, slotAt: postTargets.slotAt, lease: postTargets.generateLeaseUntil })
  if (!claimed.length) return out
  const lease = claimed[0]!.lease!
  const ids = claimed.map((c) => c.id)
  try {
    const topics = new Map(
      (await deps.db.select({ id: postTargets.id, topic: posts.topic }).from(postTargets).innerJoin(posts, eq(posts.id, postTargets.postId)).where(inArray(postTargets.id, ids))).map(
        (r) => [r.id, r.topic ?? ''],
      ),
    )
    const byPage = new Map<string, ClaimedSlot[]>()
    for (const c of [...claimed].sort((a, b) => a.slotAt!.getTime() - b.slotAt!.getTime() || a.id.localeCompare(b.id))) {
      const list = byPage.get(c.pageId) ?? []
      list.push({ id: c.id, pageId: c.pageId, slotAt: c.slotAt!, topic: topics.get(c.id) ?? '', withImage: withImage.get(c.id) ?? false })
      byPage.set(c.pageId, list)
    }
    const groups = [...byPage.values()]
    let stop = false
    let next = 0
    const worker = async () => {
      while (next < groups.length && !stop) {
        const group = groups[next++]!
        signal?.throwIfAborted()
        const r = await planPage(deps, campaignId, group, ids, lease, req, signal)
        out.calls += r.calls
        out.planned += r.planned
        out.failed += r.failed
        if (r.stop) stop = true
      }
    }
    await Promise.all(Array.from({ length: Math.min(PLAN_CONCURRENCY, groups.length) }, worker))
  } finally {
    await deps.db
      .update(postTargets)
      .set({ generateLeaseUntil: null })
      .where(and(inArray(postTargets.id, ids), eq(postTargets.generateLeaseUntil, lease)))
  }
  return out
}

/** Ghi brief cho slot còn do lượt này giữ (lease) và chưa có brief. */
async function savePlan(deps: ComposeDeps, targetId: string, lease: Date, plan: StoredSlotPlan): Promise<boolean> {
  const rows = await deps.db
    .update(postTargets)
    .set({ plan })
    .where(
      and(
        eq(postTargets.id, targetId),
        isNull(postTargets.plan),
        eq(postTargets.generateLeaseUntil, lease),
        eq(postTargets.status, 'planned' satisfies PostTargetStatus),
      ),
    )
    .returning({ id: postTargets.id })
  return rows.length > 0
}

/** Một trang của lô: ngữ cảnh → một lời gọi AI → ghi brief / `failed` từng slot. `stop` = mã dừng (các trang sau bỏ). */
async function planPage(
  deps: ComposeDeps,
  campaignId: string,
  group: readonly ClaimedSlot[],
  claimedIds: readonly string[],
  lease: Date,
  req: CampaignPlanRequest,
  signal: AbortSignal | undefined,
): Promise<{ calls: number; planned: number; failed: number; stop: boolean }> {
  const res = { calls: 0, planned: 0, failed: 0, stop: false }
  const pageId = group[0]!.pageId
  // Trang đã gỡ / thiếu hồ sơ → để `generateSlot` chốt mã như cũ (không tốn lời gọi).
  const page = await getPage(deps.db, pageId)
  if (!page) return res
  const effective = await resolveEffectiveOrNull<BrandProfileDto>(deps.db, pageId, 'brand')
  if (!effective) return res
  const brand = effective.config

  const nearby = await nearbySlots(deps.db, { campaignId, pageId, anchor: group[0]!.slotAt, excludeIds: claimedIds }, CAMPAIGN_PLAN_HISTORY_MAX)
  const history: CampaignPlanHistoryItem[] = nearby.map((r) => {
    const plan = readSlotPlan(r.plan)
    return plan
      ? { format: plan.format, title: plan.title, angle: plan.angle, hook: r.caption ? captionOpening(r.caption) : plan.hook, imageIdea: plan.imageIdea }
      : { format: null, title: '', angle: '', hook: captionOpening(r.caption), imageIdea: '' }
  })
  const countRows = await deps.db
    .select({ format: sql<string>`${postTargets.plan} ->> 'format'`, n: sql<number>`count(*)::int` })
    .from(postTargets)
    .where(and(eq(postTargets.campaignId, campaignId), eq(postTargets.pageId, pageId), ne(postTargets.status, 'cancelled' satisfies PostTargetStatus), hasOkPlan))
    .groupBy(sql`1`)
  const formatCounts: Partial<Record<ContentFormat, number>> = {}
  for (const r of countRows) formatCounts[r.format as ContentFormat] = r.n
  const knowledge = await pageKnowledge(deps.db, pageId, KNOWLEDGE_MAX_TOKENS)

  const slots = group.map((s, i) => ({ ref: i + 1, topic: s.topic, day: vnDay(s.slotAt).day, withImage: s.withImage }))
  const prompt = buildCampaignPlanPrompt(brand, {
    platform: page.platform,
    pageName: page.name,
    campaignName: req.campaignName,
    campaignGoal: req.campaignGoal,
    withReference: req.withReference,
    month: vnDay(group[0]!.slotAt).month,
    slots,
    history,
    formatCounts,
    knowledge,
  })

  const saveAll = async (plan: (slot: ClaimedSlot, ref: number) => StoredSlotPlan) => {
    for (const [i, slot] of group.entries()) {
      const value = plan(slot, i + 1)
      if (await savePlan(deps, slot.id, lease, value)) {
        if (value.status === 'ok') res.planned++
        else res.failed++
      }
    }
  }

  let text: string
  try {
    res.calls++
    text = (
      await generateText(deps, {
        feature: 'campaign_generate',
        pageId,
        ref: campaignId,
        instructions: prompt.instructions,
        input: prompt.input,
        maxOutputTokens: prompt.maxOutputTokens,
        jsonSchema: prompt.jsonSchema,
        ...(signal ? { signal } : {}),
      })
    ).text
  } catch (err) {
    if (signal?.aborted) throw err
    // Có thể đã tính tiền (hết giờ sau khi gửi) hoặc đã tính tiền thật (model từ chối / lọc nội dung sau khi trả — gateway
    // đã ghi `ai_usage`, lỗi mang `usageId`) → không lên lại; lỗi khác chưa tính tiền → để lô sau / lượt retry lên.
    if (isMaybeBilled(err) || isBilled(err)) {
      await saveAll(() => FAILED_SLOT_PLAN)
      return res
    }
    if (err instanceof AppError) {
      if (AI_STOP_CODES.has(err.code)) res.stop = true
      deps.log?.warn({ campaignId, pageId, code: err.code }, 'content: lên kế hoạch nội dung lỗi — bài viết theo chủ đề')
      return res
    }
    if (isAbortError(err)) return res
    throw err
  }

  const items = parseCampaignPlanOutput(text, slots.map((s) => s.ref))
  if (!items) deps.log?.warn({ campaignId, pageId }, 'content: kế hoạch nội dung không đọc được — bài viết theo chủ đề')
  const guard = { bannedWords: brand.bannedWords, allowedDomains: brand.allowedDomains }
  await saveAll((_slot, ref) => {
    const item = items?.get(ref)
    if (!item) return FAILED_SLOT_PLAN
    const all = [item.title, item.angle, item.hook, item.brief, item.imageIdea, item.cta].join('\n')
    return checkOutput(all, { brand: guard, kind: 'caption' }).clean ? okSlotPlan(item) : FAILED_SLOT_PLAN
  })
  return res
}
