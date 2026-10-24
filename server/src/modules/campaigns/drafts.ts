// Nháp chiến dịch (Story 7.1, AD-15): wizard bước 1–3 lưu cấu hình ở `draft` cùng `campaign_topics` và
// `campaign_pages`. Body đã qua `SaveCampaignRequest` (shared — gồm tổng tỉ lệ = 100%); ở đây kiểm phần cần dữ liệu:
// trang tồn tại + chọn được (`pages.ts`), nhóm nhãn tồn tại và chứa các trang, ngày bắt đầu không ở quá khứ (giờ VN).
// Mọi lỗi gom thành một `VALIDATION_FAILED` với `path` trỏ đúng ô (FE báo dưới ô, về đúng bước).
// Story 7.2: bài xem trước đồng bộ theo cấu hình ở `preview.ts` (route gọi trong cùng transaction lưu). PUT mang
// `baseUpdatedAt` khác bản hiện tại → 409 (nháp đã đổi ở tab khác). Story 7.3: "Bắt đầu" (`start.ts`) kiểm lại cấu hình
// đã lưu bằng chính `assertDraftValid` (trang có thể đã gỡ / mất kết nối / mất hồ sơ sau lúc lưu).
import {
  CAMPAIGN_START_MAX_AHEAD_DAYS,
  type CampaignDto,
  type CampaignFrequency,
  type CampaignGoal,
  type CampaignMode,
  type CampaignPageBlockReason,
  type CampaignStatus,
  type ParsedSaveCampaignRequest,
} from '@ottm/shared'
import { asc, eq, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { getGroup, getPage } from '../pages/index.ts'
import { pageBlockReason } from './pages.ts'
import { campaignPages, campaignTopics, campaigns } from './schema.ts'

interface FieldIssue {
  path: (string | number)[]
  message: string
  /** Có khi trang không chọn được — FE hiện lý do theo mã. */
  code?: CampaignPageBlockReason
}

const BLOCK_MESSAGE: Record<CampaignPageBlockReason, string> = {
  PAGE_DISCONNECTED: 'Trang đã mất kết nối — kết nối lại để chọn',
  CONFIG_MISSING: 'Trang chưa có hồ sơ thương hiệu',
}

const DAY_MS = 24 * 60 * 60_000
/** Asia/Ho_Chi_Minh: UTC+7, không có giờ mùa hè. */
const VN_OFFSET_MS = 7 * 60 * 60_000

/** Ngày lịch VN (`YYYY-MM-DD`) của thời điểm `at`, dời `days` ngày. */
const vnDate = (at: Date, days = 0) => new Date(at.getTime() + VN_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10)

export async function assertDraftValid(db: DbExecutor, input: ParsedSaveCampaignRequest, now: Date): Promise<void> {
  const issues: FieldIssue[] = []
  if (input.startDate < vnDate(now)) issues.push({ path: ['startDate'], message: 'Ngày bắt đầu đã qua' })
  else if (input.startDate > vnDate(now, CAMPAIGN_START_MAX_AHEAD_DAYS)) {
    issues.push({ path: ['startDate'], message: `Ngày bắt đầu tối đa ${CAMPAIGN_START_MAX_AHEAD_DAYS} ngày tới` })
  }
  const group = input.groupId ? await getGroup(db, input.groupId) : null
  if (input.groupId && !group) issues.push({ path: ['groupId'], message: 'Nhóm không tồn tại' })
  for (const [i, p] of input.pages.entries()) {
    const path = ['pages', i, 'pageId']
    const page = await getPage(db, p.pageId)
    if (!page) {
      issues.push({ path, message: 'Trang không tồn tại hoặc đã gỡ' })
      continue
    }
    const reason = await pageBlockReason(db, page)
    if (reason) issues.push({ path, message: BLOCK_MESSAGE[reason], code: reason })
    else if (group && page.groupId !== group.id) issues.push({ path, message: 'Trang không thuộc nhóm đã chọn' })
  }
  if (issues.length) throw new AppError('VALIDATION_FAILED', 400, { message: 'Cấu hình chiến dịch không hợp lệ', details: issues })
}

const columnsOf = (input: ParsedSaveCampaignRequest) => ({
  name: input.name,
  goal: input.goal,
  mode: input.mode,
  startDate: input.startDate,
  durationDays: input.durationDays,
  groupId: input.groupId,
  defaultFrequency: input.defaultFrequency,
  imageRatio: input.imageRatio,
  postTimes: [...input.postTimes].sort(),
})

async function insertChildren(tx: DbExecutor, campaignId: string, input: ParsedSaveCampaignRequest): Promise<void> {
  await tx.insert(campaignTopics).values(input.topics.map((t, position) => ({ campaignId, position, name: t.name, share: t.share })))
  await tx.insert(campaignPages).values(input.pages.map((p, position) => ({ campaignId, pageId: p.pageId, position, frequency: p.frequency })))
}

/** Tạo nháp (chạy trong transaction của bên gọi: chiến dịch, chủ đề, trang cùng có hoặc cùng không). */
export async function createCampaignDraft(tx: DbExecutor, input: ParsedSaveCampaignRequest, now: Date): Promise<CampaignDto> {
  await assertDraftValid(tx, input, now)
  const [row] = await tx.insert(campaigns).values(columnsOf(input)).returning({ id: campaigns.id })
  await insertChildren(tx, row!.id, input)
  return (await getCampaign(tx, row!.id))!
}

/**
 * Thay toàn bộ cấu hình của một nháp (khoá dòng chiến dịch để hai lần lưu không đan nhau). Không có → 404; đã rời
 * `draft` → 409 (v1 không sửa cấu hình chiến dịch đang chạy — AD-15 Deferred); `baseUpdatedAt` lệch → 409.
 */
export async function updateCampaignDraft(tx: DbExecutor, id: string, input: ParsedSaveCampaignRequest, now: Date): Promise<CampaignDto> {
  const [current] = await tx.select({ status: campaigns.status, updatedAt: campaigns.updatedAt }).from(campaigns).where(eq(campaigns.id, id)).for('update')
  if (!current) throw new AppError('NOT_FOUND', 404, { message: 'Chiến dịch không tồn tại', details: { campaignId: id } })
  if (current.status !== ('draft' satisfies CampaignStatus)) throw new AppError('VERSION_CONFLICT', 409, { message: 'Chiến dịch đã rời trạng thái nháp' })
  if (input.baseUpdatedAt !== undefined && input.baseUpdatedAt !== current.updatedAt.toISOString()) {
    throw new AppError('VERSION_CONFLICT', 409, { message: 'Nháp đã đổi ở nơi khác', details: { campaignId: id, updatedAt: current.updatedAt.toISOString() } })
  }
  await assertDraftValid(tx, input, now)
  await tx.update(campaigns).set({ ...columnsOf(input), updatedAt: sql`now()` }).where(eq(campaigns.id, id))
  await tx.delete(campaignTopics).where(eq(campaignTopics.campaignId, id))
  await tx.delete(campaignPages).where(eq(campaignPages.campaignId, id))
  await insertChildren(tx, id, input)
  return (await getCampaign(tx, id))!
}

/** Một chiến dịch (mọi trạng thái); `null` khi không có. Trang đã gỡ vẫn trả — wizard tự lọc theo `GET /pages`. */
export async function getCampaign(db: DbExecutor, id: string): Promise<CampaignDto | null> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id))
  if (!row) return null
  const topics = await db.select().from(campaignTopics).where(eq(campaignTopics.campaignId, id)).orderBy(asc(campaignTopics.position))
  const pages = await db.select().from(campaignPages).where(eq(campaignPages.campaignId, id)).orderBy(asc(campaignPages.position))
  return {
    id: row.id,
    name: row.name,
    goal: row.goal as CampaignGoal,
    status: row.status as CampaignStatus,
    mode: row.mode as CampaignMode,
    startDate: row.startDate,
    durationDays: row.durationDays,
    groupId: row.groupId,
    defaultFrequency: row.defaultFrequency as CampaignFrequency,
    pages: pages.map((p) => ({ pageId: p.pageId, frequency: p.frequency as CampaignFrequency | null })),
    topics: topics.map((t) => ({ name: t.name, share: t.share })),
    postTimes: row.postTimes,
    imageRatio: row.imageRatio,
    startedAt: row.startedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
