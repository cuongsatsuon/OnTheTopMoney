// Sổ hạn mức chi phí AI theo tháng lịch giờ Việt Nam (Story 1.6, AD-7).
// - `reserve`: khoá dòng tháng (`FOR UPDATE`), kiểm `spent + Σ chỗ giữ + ước tính ≤ hạn mức`, ghi chỗ giữ.
//   Api và worker gọi song song → các transaction xếp hàng trên dòng tháng, tổng không vượt hạn mức.
// - `settle`: một transaction xoá chỗ giữ, ghi `ai_usage`, cộng chi phí thật, lật cờ cảnh báo.
// - `release`: trả chỗ giữ (lỗi, huỷ). `gcReservations`: dọn chỗ giữ bị bỏ rơi (>15 phút).
// - Cờ `alerted_80/100` chỉ lật lên bằng `UPDATE … WHERE alerted_x = false` → `ai_budget.threshold_reached`
//   phát đúng một lần; `recomputeAlerts` (đổi hạn mức / tỉ giá / cảnh báo) hạ cờ → `ai_budget.restored`.
import {
  AI_CATEGORIES,
  AI_FEATURE_CATEGORY,
  aiBudgetState,
  isAiFeature,
  type AiBudgetSummary,
  type AiCategory,
  type AiFeature,
} from '@ottm/shared'
import { and, eq, lt, sql } from 'drizzle-orm'
import type { Db, DbExecutor, Tx } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { getOpenAiPrefs, type OpenAiPrefs } from '../settings/index.ts'
import { budgetMonth, type Cost, type UsageCounts } from './cost.ts'
import { aiBudgetMonths, aiReservations, aiUsage } from './schema.ts'

export interface BudgetDeps {
  db: Db
  events: EventPublisher
  now?: () => Date
}

/** Chỗ giữ cũ hơn chừng này coi như bị bỏ rơi (tiến trình chết giữa lời gọi) — cron dọn. */
export const RESERVATION_TTL_MINUTES = 15

const nowOf = (deps: { now?: () => Date }): Date => (deps.now ? deps.now() : new Date())

async function ensureMonth(tx: DbExecutor, month: string): Promise<void> {
  await tx.insert(aiBudgetMonths).values({ month }).onConflictDoNothing({ target: aiBudgetMonths.month })
}

async function reservedOf(tx: DbExecutor, month: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${aiReservations.estVnd}), 0)` })
    .from(aiReservations)
    .where(eq(aiReservations.month, month))
  return Number(row?.total ?? 0)
}

export interface Reservation {
  id: string
  month: string
  estVnd: number
}

/**
 * Giữ chỗ `estVnd` trong tháng hiện tại. Hết hạn mức (đã tiêu ≥ hạn mức, hoặc đã tiêu + đang giữ + ước
 * tính > hạn mức) → `AI_BUDGET_EXCEEDED` (402), không ghi gì.
 */
export async function reserve(deps: Pick<BudgetDeps, 'db' | 'now'>, estVnd: number): Promise<Reservation> {
  const month = budgetMonth(nowOf(deps))
  const est = Math.max(0, Math.ceil(estVnd))
  return deps.db.transaction(async (tx) => {
    await ensureMonth(tx, month)
    const [row] = await tx
      .select({ spentVnd: aiBudgetMonths.spentVnd })
      .from(aiBudgetMonths)
      .where(eq(aiBudgetMonths.month, month))
      .for('update')
    const spentVnd = row?.spentVnd ?? 0
    const reservedVnd = await reservedOf(tx, month)
    const { monthlyLimitVnd: limitVnd } = await getOpenAiPrefs(tx)
    if (spentVnd >= limitVnd || spentVnd + reservedVnd + est > limitVnd) {
      // `remainingVnd > 0` = chưa hết hạn mức, chỉ là phần còn lại không đủ cho ước tính của thao tác này.
      const remainingVnd = Math.max(0, limitVnd - spentVnd - reservedVnd)
      throw new AppError('AI_BUDGET_EXCEEDED', 402, {
        details: { month, limitVnd, spentVnd, reservedVnd, remainingVnd, estimateVnd: est },
      })
    }
    const [saved] = await tx.insert(aiReservations).values({ month, estVnd: est }).returning({ id: aiReservations.id })
    return { id: saved!.id, month, estVnd: est }
  })
}

/** Trả chỗ giữ (lời gọi lỗi / bị huỷ): không ghi chi phí. Đã bị dọn → bỏ qua. */
export async function release(db: DbExecutor, reservationId: string): Promise<void> {
  await db.delete(aiReservations).where(eq(aiReservations.id, reservationId))
}

/** Dọn chỗ giữ cũ hơn `RESERVATION_TTL_MINUTES` (cron `ai.reservations_gc`). Trả số dòng đã xoá. */
export async function gcReservations(db: DbExecutor, ttlMinutes = RESERVATION_TTL_MINUTES): Promise<number> {
  const deleted = await db
    .delete(aiReservations)
    .where(lt(aiReservations.createdAt, sql`now() - make_interval(mins => ${ttlMinutes})`))
    .returning({ id: aiReservations.id })
  return deleted.length
}

/**
 * Cờ đáng có theo số đã tiêu và hạn mức — KHÔNG phụ thuộc công tắc `warn80`: cờ 80% ghi nhận "tháng này đã
 * qua 80%" để bật/tắt công tắc không phát lại hay gỡ cảnh báo; công tắc chỉ quyết có phát sự kiện 80% không.
 */
function desiredAlerts(spentVnd: number, prefs: Pick<OpenAiPrefs, 'monthlyLimitVnd'>): { a80: boolean; a100: boolean } {
  const limitVnd = prefs.monthlyLimitVnd
  const a100 = aiBudgetState({ spentVnd, limitVnd, warn80: false }) === 'blocked'
  return { a100, a80: a100 || aiBudgetState({ spentVnd, limitVnd, warn80: true }) === 'warn' }
}

/**
 * Lật cờ của `month` (dòng đã bị khoá trong `tx`) cho khớp `spentVnd` và hạn mức. Lên: `UPDATE … WHERE
 * alerted_x = false` → phát `threshold_reached` đúng một lần (mức 80 chỉ khi bật `warn80`). Xuống (chỉ khi
 * `lower` — hạn mức tăng): hạ cờ, phát một `restored`.
 */
async function applyAlerts(
  tx: Tx,
  events: EventPublisher,
  month: string,
  spentVnd: number,
  prefs: OpenAiPrefs,
  lower: boolean,
): Promise<void> {
  const want = desiredAlerts(spentVnd, prefs)
  const raised: (80 | 100)[] = []
  if (want.a80) {
    const rows = await tx
      .update(aiBudgetMonths)
      .set({ alerted80: true, updatedAt: sql`now()` })
      .where(and(eq(aiBudgetMonths.month, month), eq(aiBudgetMonths.alerted80, false)))
      .returning({ month: aiBudgetMonths.month })
    if (rows.length) raised.push(80)
  }
  if (want.a100) {
    const rows = await tx
      .update(aiBudgetMonths)
      .set({ alerted100: true, updatedAt: sql`now()` })
      .where(and(eq(aiBudgetMonths.month, month), eq(aiBudgetMonths.alerted100, false)))
      .returning({ month: aiBudgetMonths.month })
    if (rows.length) raised.push(100)
  }
  for (const level of raised) {
    if (level === 80 && !prefs.warn80) continue
    await events.publishEvent(tx, 'ai_budget.threshold_reached', { id: `${month}:${level}`, level })
  }
  if (!lower) return
  let lowered = false
  if (!want.a80) {
    const rows = await tx
      .update(aiBudgetMonths)
      .set({ alerted80: false, updatedAt: sql`now()` })
      .where(and(eq(aiBudgetMonths.month, month), eq(aiBudgetMonths.alerted80, true)))
      .returning({ month: aiBudgetMonths.month })
    lowered ||= rows.length > 0
  }
  if (!want.a100) {
    const rows = await tx
      .update(aiBudgetMonths)
      .set({ alerted100: false, updatedAt: sql`now()` })
      .where(and(eq(aiBudgetMonths.month, month), eq(aiBudgetMonths.alerted100, true)))
      .returning({ month: aiBudgetMonths.month })
    lowered ||= rows.length > 0
  }
  if (lowered) await events.publishEvent(tx, 'ai_budget.restored', { id: month })
}

export interface SettleInput {
  /** Chỗ giữ cần thay bằng chi phí thật; `null` khi không giữ chỗ (công cụ dev `ai-simulate`). */
  reservationId: string | null
  /** Tháng của chỗ giữ (lời gọi bắt đầu cuối tháng vẫn tính vào tháng đó). */
  month: string
  feature: AiFeature
  model: string
  pageId: string | null
  ref: string | null
  usage: UsageCounts
  cost: Cost
  /** Chi phí là ước tính lúc giữ chỗ (OpenAI không trả usage nhưng có thể đã tính tiền). */
  estimated?: boolean
}

/**
 * Một transaction: xoá chỗ giữ, ghi `ai_usage`, cộng chi phí thật vào tháng, lật cờ 80% / 100% và phát
 * `ai_budget.threshold_reached` (đúng một lần mỗi mức). Chỗ giữ đã bị dọn → vẫn ghi chi phí (đã tốn tiền).
 */
export async function settle(deps: Pick<BudgetDeps, 'db' | 'events'>, input: SettleInput): Promise<{ usageId: string; spentVnd: number }> {
  return deps.db.transaction(async (tx) => {
    if (input.reservationId) await release(tx, input.reservationId)
    await ensureMonth(tx, input.month)
    const [usage] = await tx
      .insert(aiUsage)
      .values({
        month: input.month,
        feature: input.feature,
        model: input.model,
        pageId: input.pageId,
        ref: input.ref,
        inputTokens: input.usage.inputTokens,
        cachedInputTokens: input.usage.cachedInputTokens,
        outputTokens: input.usage.outputTokens,
        images: input.usage.images,
        usdMicros: input.cost.usdMicros,
        costVnd: input.cost.costVnd,
        estimated: input.estimated ?? false,
      })
      .returning({ id: aiUsage.id })
    // UPDATE khoá dòng tháng tới hết transaction → hai lần settle song song không đọc lẫn số của nhau.
    const [month] = await tx
      .update(aiBudgetMonths)
      .set({ spentVnd: sql`${aiBudgetMonths.spentVnd} + ${input.cost.costVnd}`, updatedAt: sql`now()` })
      .where(eq(aiBudgetMonths.month, input.month))
      .returning({ spentVnd: aiBudgetMonths.spentVnd })
    const spentVnd = month!.spentVnd
    await applyAlerts(tx, deps.events, input.month, spentVnd, await getOpenAiPrefs(tx), false)
    return { usageId: usage!.id, spentVnd }
  })
}

/**
 * Đổi hạn mức / tỉ giá (`settings.updated`) → tính lại cờ của tháng hiện tại theo hạn mức mới: lên thì phát
 * `threshold_reached`, xuống dưới ngưỡng thì phát `ai_budget.restored`. Công tắc `warn80` không đổi cờ.
 * Chưa có dòng tháng → không làm gì.
 */
export async function recomputeAlerts(deps: Pick<BudgetDeps, 'db' | 'events' | 'now'>): Promise<void> {
  const month = budgetMonth(nowOf(deps))
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ spentVnd: aiBudgetMonths.spentVnd })
      .from(aiBudgetMonths)
      .where(eq(aiBudgetMonths.month, month))
      .for('update')
    if (!row) return
    await applyAlerts(tx, deps.events, month, row.spentVnd, await getOpenAiPrefs(tx), true)
  })
}

/** `GET /api/v1/ai/budget`: tổng tháng hiện tại, % hạn mức, trạng thái và chi phí theo hạng mục. */
export async function getBudgetSummary(deps: { db: DbExecutor; now?: () => Date }): Promise<AiBudgetSummary> {
  const month = budgetMonth(nowOf(deps))
  const db = deps.db
  const [prefs, [row], reservedVnd, perFeature] = await Promise.all([
    getOpenAiPrefs(db),
    db.select({ spentVnd: aiBudgetMonths.spentVnd }).from(aiBudgetMonths).where(eq(aiBudgetMonths.month, month)),
    reservedOf(db, month),
    db
      .select({
        feature: aiUsage.feature,
        costVnd: sql<string>`coalesce(sum(${aiUsage.costVnd}), 0)`,
        // Ảnh đếm theo số ảnh, còn lại theo số lượt gọi.
        count: sql<string>`coalesce(sum(case when ${aiUsage.images} > 0 then ${aiUsage.images} else 1 end), 0)`,
      })
      .from(aiUsage)
      .where(eq(aiUsage.month, month))
      .groupBy(aiUsage.feature),
  ])
  const spentVnd = row?.spentVnd ?? 0
  const limitVnd = prefs.monthlyLimitVnd
  const totals = new Map<AiCategory, { costVnd: number; count: number }>(AI_CATEGORIES.map((c) => [c, { costVnd: 0, count: 0 }]))
  for (const f of perFeature) {
    if (!isAiFeature(f.feature)) continue
    const t = totals.get(AI_FEATURE_CATEGORY[f.feature])!
    t.costVnd += Number(f.costVnd)
    t.count += Number(f.count)
  }
  return {
    month,
    limitVnd,
    spentVnd,
    reservedVnd,
    percent: limitVnd > 0 ? Math.floor((spentVnd * 100) / limitVnd) : 100,
    state: aiBudgetState({ spentVnd, limitVnd, warn80: prefs.warn80 }),
    warn80: prefs.warn80,
    byCategory: AI_CATEGORIES.map((category) => ({ category, ...totals.get(category)! })),
  }
}

/** Model của chi phí giả do công cụ dev `ai-simulate` ghi. */
export const SIMULATED_MODEL = 'dev-simulate'

/**
 * Dev (`ai-simulate --reset`): xoá chi phí giả của tháng, đặt lại `spent_vnd` = tổng `ai_usage` còn lại và tính
 * lại cờ (hạ cờ → `ai_budget.restored`). Trả số dòng đã xoá.
 */
export async function resetSimulatedSpend(deps: Pick<BudgetDeps, 'db' | 'events' | 'now'>): Promise<number> {
  const month = budgetMonth(nowOf(deps))
  return deps.db.transaction(async (tx) => {
    await ensureMonth(tx, month)
    await tx.select({ month: aiBudgetMonths.month }).from(aiBudgetMonths).where(eq(aiBudgetMonths.month, month)).for('update')
    const deleted = await tx
      .delete(aiUsage)
      .where(and(eq(aiUsage.month, month), eq(aiUsage.model, SIMULATED_MODEL)))
      .returning({ id: aiUsage.id })
    const [row] = await tx
      .update(aiBudgetMonths)
      .set({
        spentVnd: sql`(select coalesce(sum(${aiUsage.costVnd}), 0) from ${aiUsage} where ${aiUsage.month} = ${month})`,
        updatedAt: sql`now()`,
      })
      .where(eq(aiBudgetMonths.month, month))
      .returning({ spentVnd: aiBudgetMonths.spentVnd })
    await applyAlerts(tx, deps.events, month, row!.spentVnd, await getOpenAiPrefs(tx), true)
    return deleted.length
  })
}
