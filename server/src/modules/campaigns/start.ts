// "Bắt đầu chiến dịch" (Story 7.3, AD-15) + danh sách chiến dịch theo phạm vi (AD-18). MỘT transaction, tất cả hoặc
// không, không gọi Meta / OpenAI:
// 1. Khoá dòng chiến dịch (`FOR UPDATE` — cùng khoá với lưu nháp / Sửa bài xem trước; job `campaigns.preview` chờ rồi
//    thấy `running` và bỏ qua). Đã rời `draft` → `alreadyStarted` (bấm hai lần, hai tab), không đổi gì.
// 2. Kiểm lại cấu hình đã lưu bằng chính hàm kiểm khi lưu (`assertDraftValid`): trang gỡ / mất kết nối / thiếu hồ sơ /
//    rời nhóm nhãn, ngày bắt đầu đã qua → `VALIDATION_FAILED` theo ô.
// 3. Chụp `campaign_pages`: chốt tần suất hiệu lực (`null` → tần suất mặc định).
// 4. Kế hoạch đầy đủ `campaignSlots` → `content.startCampaignSlots` (slot còn lại `planned` trên Lịch, bài xem trước bỏ
//    `held`; "Tự đăng" duyệt bài đã viết xong).
// 5. `running` + `started_at`, phát `campaign.started` (realtime: Lịch và danh sách chiến dịch tải lại).
// 6. Story 7.4: enqueue `campaigns.generate` cùng transaction — slot trong 3 ngày đầu không phải chờ lượt cron kế.
import type { CampaignDto, CampaignStatus, ParsedSaveCampaignRequest, StartCampaignRequest } from '@ottm/shared'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { bossDbFor, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { startCampaignSlots, type StartSlotsResult, type TransitionDeps } from '../content/index.ts'
import { assertDraftValid, getCampaign, getCampaigns } from './drafts.ts'
import { campaignPlan, toSlotPlan } from './preview.ts'
import { campaignPages, campaigns } from './schema.ts'

export type StartCampaignResult = { alreadyStarted: true } | { alreadyStarted: false; slots: StartSlotsResult }

/** Cấu hình đã lưu → đầu vào của hàm kiểm khi lưu (đã qua `SaveCampaignRequest` lúc lưu nên chỉ còn phần cần dữ liệu). */
const asSaved = (c: CampaignDto): ParsedSaveCampaignRequest => ({
  name: c.name,
  goal: c.goal,
  startDate: c.startDate,
  durationDays: c.durationDays,
  groupId: c.groupId,
  defaultFrequency: c.defaultFrequency,
  pages: c.pages,
  topics: c.topics,
  postTimes: c.postTimes,
  imageRatio: c.imageRatio,
  mode: c.mode,
})

/**
 * Bắt đầu chiến dịch `id` (chạy trong transaction của bên gọi). Không có → 404; `baseUpdatedAt` lệch (nháp đã đổi ở tab
 * khác) → 409; cấu hình không còn hợp lệ → 400 `VALIDATION_FAILED` như khi lưu.
 */
export async function startCampaign(
  tx: DbExecutor,
  deps: TransitionDeps,
  id: string,
  input: StartCampaignRequest,
  now: Date,
): Promise<StartCampaignResult> {
  const [row] = await tx.select({ status: campaigns.status, updatedAt: campaigns.updatedAt }).from(campaigns).where(eq(campaigns.id, id)).for('update')
  if (!row) throw new AppError('NOT_FOUND', 404, { message: 'Chiến dịch không tồn tại', details: { campaignId: id } })
  if (row.status !== ('draft' satisfies CampaignStatus)) return { alreadyStarted: true }
  if (input.baseUpdatedAt !== undefined && input.baseUpdatedAt !== row.updatedAt.toISOString()) {
    throw new AppError('VERSION_CONFLICT', 409, { message: 'Nháp đã đổi ở nơi khác', details: { campaignId: id, updatedAt: row.updatedAt.toISOString() } })
  }
  const campaign = (await getCampaign(tx, id))!
  await assertDraftValid(tx, asSaved(campaign), now)

  await tx
    .update(campaignPages)
    .set({ frequency: sql`coalesce(${campaignPages.frequency}, ${campaign.defaultFrequency})` })
    .where(eq(campaignPages.campaignId, id))
  // Mọi trang đã kiểm còn dùng được (chưa gỡ) → kế hoạch đầy đủ khớp đúng 7 bài xem trước (cùng luật, cùng thứ tự trang).
  const plan = (await campaignPlan(tx, campaign)).map(toSlotPlan)
  const slots = await startCampaignSlots(tx, { ...deps, now: () => now }, id, plan, { autoPublish: campaign.mode === 'auto' })
  await tx
    .update(campaigns)
    .set({ status: 'running' satisfies CampaignStatus, startedAt: now, updatedAt: sql`now()` })
    .where(eq(campaigns.id, id))
  await deps.events.publishEvent(tx, 'campaign.started', { id })
  await deps.jobs.send('campaigns.generate', { campaignId: id }, { db: bossDbFor(tx) })
  return { alreadyStarted: false, slots }
}

/**
 * Chiến dịch (mọi trạng thái) mới tạo trước. `pageIds` = tập trang của phạm vi (`null` = mọi chiến dịch): chiến dịch
 * thuộc phạm vi khi `campaign_pages` giao tập đó (AD-18).
 */
export async function listCampaigns(db: DbExecutor, pageIds: readonly string[] | null): Promise<CampaignDto[]> {
  if (pageIds !== null && pageIds.length === 0) return []
  const inScope = pageIds === null ? undefined : inArray(campaigns.id, db.selectDistinct({ id: campaignPages.campaignId }).from(campaignPages).where(inArray(campaignPages.pageId, [...pageIds])))
  const rows = await db.select({ id: campaigns.id }).from(campaigns).where(inScope).orderBy(desc(campaigns.createdAt), desc(campaigns.id))
  return getCampaigns(
    db,
    rows.map((r) => r.id),
  )
}
