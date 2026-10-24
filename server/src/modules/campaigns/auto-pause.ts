// Chiến dịch tự phản ứng khi có sự cố (Story 7.6, AD-15, AD-3, AD-5, AD-7, AD-23). Consumer queue `events.campaigns` — các
// module khác báo qua sự kiện, `campaigns` không bị gọi ngược chiều (AD-1). Mọi lần dừng đi qua `pauseCampaign` của 7.5
// (idempotent: đã dừng → không đổi gì, trừ lý do hệ thống đè `MANUAL`), mỗi chiến dịch một transaction riêng:
// - `page.disconnected`: trang VẪN `disconnected` lúc xử lý (sự kiện tới muộn sau khi đã kết nối lại → bỏ qua) → mọi chiến
//   dịch `running|paused` có trang trong `campaign_pages` → `PAGE_DISCONNECTED`. Nháp không đụng ("Bắt đầu" tự kiểm lại).
// - `ai_budget.threshold_reached{100}`: hạn mức VẪN `blocked` lúc xử lý → mọi chiến dịch `running|paused` →
//   `AI_BUDGET_EXCEEDED`. Mức 80 chỉ cảnh báo.
// - `post_target.failed` (đã là lần lỗi cuối — AD-13): `PAGE_DISCONNECTED` → dừng cùng lý do (Meta từ chối quyền mà trang
//   chưa bị đánh dấu), không đếm; `PAGE_REMOVED` → bỏ qua (gỡ trang có luồng riêng); mã khác → đếm vào chuỗi lỗi khi
//   chiến dịch `running` và target chưa đếm (`failure_target_ids` — idempotent theo `targetId`), chạm
//   `PUBLISH_FAILURES_MAX` → `PUBLISH_FAILURES` cùng transaction.
// - `post_target.published`: chuỗi lỗi về 0.
//   Chuỗi theo thứ tự thật của bài, không theo thứ tự xử lý sự kiện (2 job song song, retry backoff): lỗi của bài mà sau
//   đó đã có bài đăng được → không đếm; reset chỉ bỏ các lỗi xảy ra TRƯỚC lúc bài đó đăng (`content.publishedAfter` /
//   `failedAfterPublish`).
// - `page.removed`: `content` đã tự huỷ bài chưa đăng (`PAGE_REMOVED`); ở đây chỉ bỏ trang khỏi `campaign_pages` của chiến
//   dịch chưa xong — chiến dịch chạy tiếp với các trang còn lại (hết slot thì cron hoàn tất chuyển `done`).
// - `page.group_changed`: trang rời ĐÚNG nhóm mà chiến dịch gắn nhãn (và chưa quay lại) → `content.cancelCampaignTargets`
//   (`PAGE_LEFT_GROUP`, theo trang) + bỏ trang khỏi `campaign_pages`.
// Không tự tiếp tục (trang kết nối lại / hạn mức nâng không làm chiến dịch chạy lại — AD-5, AD-15): chủ shop bấm "Tiếp tục".
// Dữ liệu job coi như không tin cậy: sai dạng → bỏ qua (không đốt lượt retry).
import type { CampaignStatus, PauseReason } from '@ottm/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../platform/db/index.ts'
import { isEventEnvelope, type EventEnvelope } from '../../platform/events/index.ts'
import { getBudgetSummary } from '../ai/index.ts'
import { cancelCampaignTargets, failedAfterPublish, publishedAfter } from '../content/index.ts'
import { getPage } from '../pages/index.ts'
import { pauseBySystem, pauseCampaign, type LifecycleDeps } from './lifecycle.ts'
import { campaignPages, campaigns } from './schema.ts'

/** Số bài đăng lỗi liên tiếp (lần lỗi cuối) thì tự tạm dừng [ASSUMPTION AD-15]. */
export const PUBLISH_FAILURES_MAX = 3

export interface CampaignsEventDeps extends LifecycleDeps {
  db: Db
  now?: () => Date
}

/** `changed` = số chiến dịch vừa đổi (dừng, đếm lỗi, về 0, bỏ trang). */
export type CampaignsEventResult = { changed: number } | 'ignored'

/** Chiến dịch đã bắt đầu, chưa xong — đối tượng của tự tạm dừng. */
const STARTED: readonly CampaignStatus[] = ['running', 'paused']
/** Chiến dịch chưa xong — gỡ trang thì bỏ trang khỏi đích (cả nháp). */
const UNFINISHED: readonly CampaignStatus[] = ['draft', 'running', 'paused']

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export async function handleCampaignsEvent(deps: CampaignsEventDeps, data: unknown): Promise<CampaignsEventResult> {
  if (!isEventEnvelope(data)) return 'ignored'
  switch (data.event) {
    case 'page.disconnected':
      return onPageDisconnected(deps, data)
    case 'ai_budget.threshold_reached':
      return onBudgetReached(deps, data)
    case 'post_target.failed':
      return onTargetFailed(deps, data)
    case 'post_target.published':
      return onTargetPublished(deps, data)
    case 'page.removed':
      return onPageRemoved(deps, data)
    case 'page.group_changed':
      return onGroupChanged(deps, data)
    default:
      return 'ignored'
  }
}

const pageOf = (envelope: EventEnvelope) => {
  const p = envelope.payload as { id?: unknown; pageId?: unknown }
  return str(p.pageId) ?? str(p.id)
}

/** Chiến dịch có trang `pageId` trong `campaign_pages` và đang ở một trong `statuses`. */
async function campaignsWithPage(db: Db, pageId: string, statuses: readonly CampaignStatus[]): Promise<string[]> {
  const rows = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .innerJoin(campaignPages, eq(campaignPages.campaignId, campaigns.id))
    .where(and(eq(campaignPages.pageId, pageId), inArray(campaigns.status, [...statuses])))
  return rows.map((r) => r.id)
}

/** Dừng từng chiến dịch (transaction riêng — `pauseBySystem`). Trả số chiến dịch đã đổi. */
async function pauseEach(deps: CampaignsEventDeps, ids: readonly string[], reason: Exclude<PauseReason, 'MANUAL'>): Promise<number> {
  const now = deps.now?.() ?? new Date()
  let changed = 0
  for (const id of ids) if (await pauseBySystem(deps.db, deps, id, reason, now)) changed++
  return changed
}

async function onPageDisconnected(deps: CampaignsEventDeps, envelope: EventEnvelope): Promise<CampaignsEventResult> {
  const pageId = pageOf(envelope)
  if (!pageId) return 'ignored'
  const page = await getPage(deps.db, pageId)
  if (!page || page.connectionStatus !== 'disconnected') return { changed: 0 }
  return { changed: await pauseEach(deps, await campaignsWithPage(deps.db, pageId, STARTED), 'PAGE_DISCONNECTED') }
}

async function onBudgetReached(deps: CampaignsEventDeps, envelope: EventEnvelope): Promise<CampaignsEventResult> {
  if ((envelope.payload as { level?: unknown }).level !== 100) return 'ignored'
  if ((await getBudgetSummary({ db: deps.db })).state !== 'blocked') return { changed: 0 }
  const rows = await deps.db.select({ id: campaigns.id }).from(campaigns).where(inArray(campaigns.status, [...STARTED]))
  return {
    changed: await pauseEach(
      deps,
      rows.map((r) => r.id),
      'AI_BUDGET_EXCEEDED',
    ),
  }
}

async function onTargetFailed(deps: CampaignsEventDeps, envelope: EventEnvelope): Promise<CampaignsEventResult> {
  const p = envelope.payload as { id?: unknown; campaignId?: unknown; errorCode?: unknown }
  const targetId = str(p.id)
  const campaignId = str(p.campaignId)
  if (!targetId || !campaignId) return 'ignored'
  if (p.errorCode === 'PAGE_REMOVED') return 'ignored'
  if (p.errorCode === 'PAGE_DISCONNECTED') return { changed: await pauseEach(deps, [campaignId], 'PAGE_DISCONNECTED') }
  // Sự kiện lỗi tới sau sự kiện đăng được của bài đăng SAU nó → thuộc chuỗi đã reset, không đếm (tránh dừng oan).
  if (await publishedAfter(deps.db, campaignId, targetId)) return { changed: 0 }
  const now = deps.now?.() ?? new Date()
  const changed = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(campaigns)
      .set({
        consecutiveFailures: sql`${campaigns.consecutiveFailures} + 1`,
        failureTargetIds: sql`array_append(${campaigns.failureTargetIds}, ${targetId}::text)`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(campaigns.id, campaignId),
          eq(campaigns.status, 'running' satisfies CampaignStatus),
          sql`not (${targetId}::text = any(${campaigns.failureTargetIds}))`,
        ),
      )
      .returning({ failures: campaigns.consecutiveFailures })
    if (!row) return 0
    if (row.failures >= PUBLISH_FAILURES_MAX) await pauseCampaign(tx, deps, campaignId, 'PUBLISH_FAILURES', now)
    return 1
  })
  return { changed }
}

async function onTargetPublished(deps: CampaignsEventDeps, envelope: EventEnvelope): Promise<CampaignsEventResult> {
  const p = envelope.payload as { id?: unknown; campaignId?: unknown }
  const campaignId = str(p.campaignId)
  if (!campaignId) return 'ignored'
  const targetId = str(p.id) ?? ''
  const changed = await deps.db.transaction(async (tx) => {
    // Khoá dòng trước khi đọc chuỗi (lỗi song song chờ rồi nối vào danh sách mới — không mất lượt đếm).
    const [row] = await tx.select({ ids: campaigns.failureTargetIds }).from(campaigns).where(eq(campaigns.id, campaignId)).for('update')
    if (!row || !row.ids.length) return 0
    // Sự kiện đăng được tới muộn: giữ các lỗi xảy ra SAU lúc bài này đăng (vẫn thuộc chuỗi hiện tại).
    const kept = await failedAfterPublish(tx, row.ids, targetId)
    if (kept.length === row.ids.length) return 0
    await tx
      .update(campaigns)
      .set({ consecutiveFailures: kept.length, failureTargetIds: kept, updatedAt: sql`now()` })
      .where(eq(campaigns.id, campaignId))
    return 1
  })
  return { changed }
}

async function onPageRemoved(deps: CampaignsEventDeps, envelope: EventEnvelope): Promise<CampaignsEventResult> {
  const pageId = pageOf(envelope)
  if (!pageId) return 'ignored'
  const unfinished = deps.db.select({ id: campaigns.id }).from(campaigns).where(inArray(campaigns.status, [...UNFINISHED]))
  const rows = await deps.db
    .delete(campaignPages)
    .where(and(eq(campaignPages.pageId, pageId), inArray(campaignPages.campaignId, unfinished)))
    .returning({ campaignId: campaignPages.campaignId })
  return { changed: rows.length }
}

async function onGroupChanged(deps: CampaignsEventDeps, envelope: EventEnvelope): Promise<CampaignsEventResult> {
  const pageId = pageOf(envelope)
  const fromGroupId = str((envelope.payload as { fromGroupId?: unknown }).fromGroupId)
  if (!pageId || !fromGroupId) return 'ignored'
  const page = await getPage(deps.db, pageId)
  // Trang đã gỡ (luồng `page.removed`) hoặc đã quay lại nhóm cũ (sự kiện tới muộn) → không huỷ gì.
  if (!page || page.groupId === fromGroupId) return { changed: 0 }
  const candidates = await deps.db
    .select({ id: campaigns.id })
    .from(campaigns)
    .innerJoin(campaignPages, eq(campaignPages.campaignId, campaigns.id))
    .where(and(eq(campaignPages.pageId, pageId), eq(campaigns.groupId, fromGroupId), inArray(campaigns.status, [...STARTED])))
  let changed = 0
  for (const { id } of candidates) {
    const done = await deps.db.transaction(async (tx) => {
      // Khoá dòng chiến dịch trước slot (cùng thứ tự với tạm dừng / xoá); kiểm lại dưới khoá.
      const [row] = await tx.select({ status: campaigns.status, groupId: campaigns.groupId }).from(campaigns).where(eq(campaigns.id, id)).for('update')
      if (!row || !STARTED.includes(row.status as CampaignStatus) || row.groupId !== fromGroupId) return false
      await cancelCampaignTargets(tx, id, 'PAGE_LEFT_GROUP', { pageId })
      await tx.delete(campaignPages).where(and(eq(campaignPages.campaignId, id), eq(campaignPages.pageId, pageId)))
      return true
    })
    if (done) changed++
  }
  return { changed }
}
