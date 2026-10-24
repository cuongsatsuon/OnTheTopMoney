// Xem trước 7 bài đầu (Story 7.2, AD-15, AD-13). Bài xem trước là slot THẬT của chiến dịch nháp (`planned` → AI sinh →
// `pending_approval`, luôn `held`): "Bắt đầu" (7.3) giữ nguyên và chỉ bỏ `held` — không sinh lại, không nhân đôi
// (khoá `(campaign_id, page_id, slot_at)` + luật slot chung `campaignSlots`).
// - Lưu nháp (bước 3 → 4): `syncPreviewSlots` trong transaction lưu — dọn slot không còn khớp cấu hình mới, tạo slot
//   thiếu, enqueue `campaigns.preview` (stately theo chiến dịch).
// - Job `campaigns.preview`: ensure lại slot (idempotent), sinh từng slot chưa sinh qua `content.generateSlot`
//   (caption theo hồ sơ hiệu lực + hậu kiểm, ảnh qua job ảnh có sẵn), tối đa 3 slot song song. Mã dừng (khoá OpenAI /
//   hạn mức / mã hoá) → slot chưa bắt đầu nhận cùng mã, không gọi AI. Lỗi tạm → ném sau khi slot khác đã xong.
// - Sửa / Xoá / Tạo lại: đi qua `content.transitionTarget` với `version`; Tạo lại enqueue `campaigns.preview`.
// - Story 7.4: cùng route hành động cho "Bài chờ duyệt" của chiến dịch đã bắt đầu (Duyệt / Từ chối / Sửa / Tạo lại / Xoá)
//   — hàng đợi ở `/chien-dich` và Lịch nội dung gọi chung (AD-13). Vòng sinh dùng chung `runner.ts`.
// - Story 7.7: ảnh sản phẩm của nháp → mọi slot có ảnh sinh ảnh từ ảnh đó (`referenceAssetId`). Đổi / bỏ ảnh ở nháp → lưu
//   nháp và job làm lại ảnh của bài đã có ảnh từ ảnh khác (`content.refreshSlotImages`, giữ caption). Job làm cả bước này
//   dưới khoá `FOR SHARE`: slot đang viết dở lúc lưu (ô ảnh ghi theo ảnh cũ) được lượt sau sửa.
import {
  CAMPAIGN_PREVIEW_COUNT,
  campaignSlots,
  type CampaignDto,
  type CampaignGoal,
  type CampaignPreviewResponse,
  type CampaignSlot,
  type CampaignSlotDto,
  type ParsedCampaignSlotActionRequest,
  type CampaignStatus,
  type ComposeGoal,
  type ErrorCode,
  type Platform,
} from '@ottm/shared'
import { eq } from 'drizzle-orm'
import { bossDbFor, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import {
  ensureCampaignSlots,
  getCampaignSlot,
  listCampaignSlots,
  listSlotsToGenerate,
  pruneCampaignSlots,
  refreshSlotImages,
  slotCampaignOf,
  transitionTarget,
  type SlotGenerateDeps,
  type SlotPlan,
  type TargetTransition,
  type TransitionDeps,
} from '../content/index.ts'
import { getPage } from '../pages/index.ts'
import { getCampaign } from './drafts.ts'
import { SLOT_CONCURRENCY, campaignIn, runSlotBatch } from './runner.ts'
import { campaigns } from './schema.ts'

/** Số slot sinh song song trong một lượt [ASSUMPTION] — như Soạn bài (`COMPOSE_CONCURRENCY`). */
export const PREVIEW_CONCURRENCY = SLOT_CONCURRENCY

/** Mục tiêu chiến dịch → mục tiêu bài của mẫu prompt Soạn bài (dùng lại, không thêm mẫu mới — AD-7). */
export const COMPOSE_GOAL: Record<CampaignGoal, ComposeGoal> = { engage: 'engagement', follow: 'engagement', sell: 'sales', launch: 'announce' }

export const keyOf = (pageId: string, slotAt: string) => `${pageId}|${slotAt}`

/**
 * Kế hoạch slot theo cấu hình đã lưu (`limit` slot đầu; mặc định cả thời lượng): trang chưa gỡ, theo thứ tự lưu. Story
 * 7.3 dùng kế hoạch đầy đủ khi "Bắt đầu" và để đếm tổng bài của nháp.
 */
export async function campaignPlan(db: DbExecutor, campaign: CampaignDto, limit?: number): Promise<CampaignSlot[]> {
  const pages: { pageId: string; platform: Platform; frequency: CampaignDto['pages'][number]['frequency'] }[] = []
  for (const p of campaign.pages) {
    const page = await getPage(db, p.pageId)
    if (page) pages.push({ pageId: p.pageId, platform: page.platform, frequency: p.frequency })
  }
  return campaignSlots({ ...campaign, pages }, limit)
}

/** Kế hoạch `CAMPAIGN_PREVIEW_COUNT` slot đầu (bài xem trước). */
export const previewPlan = (db: DbExecutor, campaign: CampaignDto): Promise<CampaignSlot[]> => campaignPlan(db, campaign, CAMPAIGN_PREVIEW_COUNT)

export const toSlotPlan = (s: CampaignSlot): SlotPlan => ({ pageId: s.pageId, slotAt: new Date(s.slotAt), topic: s.topic })

/**
 * Đồng bộ bài xem trước với cấu hình nháp vừa lưu (chạy trong transaction lưu): slot không còn khớp (trang / giờ / chủ
 * đề) bị xoá, slot thiếu được tạo `planned` + `held` (chưa lên Lịch), bài đã có ảnh từ ảnh sản phẩm khác được làm lại ảnh
 * (Story 7.7), rồi enqueue `campaigns.preview` (thiếu `jobs` — test không pg-boss — thì chỉ dựng slot; thiếu `events` thì
 * để job làm lại ảnh).
 */
export async function syncPreviewSlots(tx: DbExecutor, campaign: CampaignDto, deps: { jobs?: JobSender | undefined; events?: EventPublisher | undefined } = {}): Promise<void> {
  const plan = (await previewPlan(tx, campaign)).map(toSlotPlan)
  await pruneCampaignSlots(tx, campaign.id, plan)
  await ensureCampaignSlots(tx, campaign.id, plan, { held: true, onCalendar: false })
  if (deps.jobs && deps.events) {
    await refreshSlotImages(tx, { jobs: deps.jobs, events: deps.events }, campaign.id, {
      referenceAssetId: campaign.productImage?.id ?? null,
      goal: COMPOSE_GOAL[campaign.goal],
    })
  }
  if (deps.jobs) await deps.jobs.send('campaigns.preview', { campaignId: campaign.id }, { db: bossDbFor(tx) })
}

/** Có lỗi tạm của OpenAI ở lượt chưa phải cuối — ném để pg-boss thử lại (slot lỗi vẫn `planned`, chưa sinh). */
export class PreviewRetryableError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode) {
    super(`campaigns.preview: ${code}`)
    this.name = 'PreviewRetryableError'
    this.code = code
  }
}

export type PreviewDeps = SlotGenerateDeps

export type PreviewResult = 'skipped' | { generated: number; errors: number }

/**
 * Một lượt sinh bài xem trước của chiến dịch `campaignId` (chỉ khi còn `draft`). Idempotent: slot đã sinh / đang chờ ảnh
 * bỏ qua. `concurrency` chỉ để test thứ tự.
 */
export async function runPreview(
  deps: PreviewDeps,
  campaignId: string,
  opts: { finalAttempt: boolean; signal?: AbortSignal | undefined; concurrency?: number },
): Promise<PreviewResult> {
  // Đọc cấu hình + ensure + danh sách slot cần sinh dưới khoá `FOR SHARE` của dòng chiến dịch: lưu nháp / bắt đầu (khoá
  // `FOR UPDATE`) đang chạy thì chờ nó xong rồi đọc bản MỚI — lượt cũ không dựng lại slot vừa bị dọn, và slot cần sinh
  // luôn khớp kế hoạch vừa đọc (Story 7.3 đóng việc hoãn: đọc `todo` sau khi nhả khoá).
  const loaded = await deps.db.transaction(async (tx) => {
    const [row] = await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId)).for('share')
    const campaign = row ? await getCampaign(tx, campaignId) : null
    if (!campaign || campaign.status !== ('draft' satisfies CampaignStatus)) return null
    const plan = await previewPlan(tx, campaign)
    await ensureCampaignSlots(tx, campaignId, plan.map(toSlotPlan), { held: true, onCalendar: false })
    // Story 7.7: bài vừa sinh theo ảnh sản phẩm cũ trong lúc nháp đổi ảnh → làm lại ảnh (giữ caption).
    await refreshSlotImages(tx, deps, campaignId, { referenceAssetId: campaign.productImage?.id ?? null, goal: COMPOSE_GOAL[campaign.goal] })
    const livePages = new Set<string>()
    for (const p of campaign.pages) if (await getPage(tx, p.pageId)) livePages.add(p.pageId)
    return { campaign, plan, livePages, todo: await listSlotsToGenerate(tx, campaignId) }
  })
  if (!loaded) return 'skipped'
  const { campaign, plan } = loaded
  const withImage = new Map(plan.map((s) => [keyOf(s.pageId, s.slotAt), s.withImage]))
  // Slot của trang còn dùng mà không có trong kế hoạch vừa đọc → bỏ qua (không sinh theo luật ảnh đoán mò; lượt của lần
  // lưu sau tự sinh). Slot của trang đã gỡ (không có trong kế hoạch) vẫn đi tiếp để chốt `PAGE_REMOVED`.
  const todo = loaded.todo
    .filter((s) => withImage.has(keyOf(s.pageId, s.slotAt.toISOString())) || !loaded.livePages.has(s.pageId))
    .map((s) => ({ id: s.id, withImage: withImage.get(keyOf(s.pageId, s.slotAt.toISOString())) ?? false }))

  const result = await runSlotBatch(deps, todo, {
    goal: COMPOSE_GOAL[campaign.goal],
    finalAttempt: opts.finalAttempt,
    signal: opts.signal,
    concurrency: opts.concurrency ?? PREVIEW_CONCURRENCY,
    onStop: 'mark',
    referenceAssetId: campaign.productImage?.id ?? null,
    // Story 7.5: nháp bị xoá giữa lượt → dừng (vừa "Bắt đầu" thì viết tiếp — 7.4).
    active: () => campaignIn(deps.db, campaignId, ['draft', 'running']),
  })
  // Story 7.4: chiến dịch vừa "Bắt đầu" giữa lượt → lượt cuốn chiếu duyệt bài vừa viết xong ("Tự đăng") và viết tiếp.
  const [after] = await deps.db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, campaignId))
  if (after?.status === ('running' satisfies CampaignStatus)) await deps.jobs.send('campaigns.generate', { campaignId })
  if (result.retryCode && !result.inactive) throw new PreviewRetryableError(result.retryCode)
  return { generated: result.generated, errors: result.errors }
}

export function parsePreviewJobData(data: unknown): { campaignId: string } {
  const id = (data as { campaignId?: unknown } | null)?.campaignId
  if (typeof id !== 'string' || id === '') throw new Error('campaigns.preview: thiếu campaignId')
  return { campaignId: id }
}

export async function handlePreviewJob(
  deps: PreviewDeps,
  job: { data: unknown; retryCount: number; retryLimit: number; signal?: AbortSignal | undefined },
): Promise<PreviewResult> {
  const { campaignId } = parsePreviewJobData(job.data)
  return runPreview(deps, campaignId, { finalAttempt: job.retryCount >= job.retryLimit, signal: job.signal })
}

/** Bài xem trước của chiến dịch; `null` khi chiến dịch không có. */
export async function getPreview(db: DbExecutor, campaignId: string): Promise<CampaignPreviewResponse | null> {
  const [row] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId))
  if (!row) return null
  const items = await listCampaignSlots(db, campaignId)
  return { items, generating: items.some((s) => s.status === 'planned') }
}

/** Hành động được phép theo trạng thái chiến dịch: nháp chỉ sửa bài xem trước; đã bắt đầu có thêm duyệt / từ chối. */
const ALLOWED: Record<CampaignStatus, readonly ParsedCampaignSlotActionRequest['action'][]> = {
  draft: ['edit', 'regenerate', 'cancel'],
  running: ['edit', 'regenerate', 'cancel', 'approve', 'reject'],
  paused: ['edit', 'regenerate', 'cancel', 'approve', 'reject'],
  done: [],
}

/**
 * Một hành động trên slot của chiến dịch (chạy trong transaction của bên gọi, khoá dòng chiến dịch như lưu nháp):
 * - Story 7.2 (nháp, bước 4): Sửa / Xoá / Tạo lại bài xem trước; Tạo lại enqueue `campaigns.preview`.
 * - Story 7.4 (đã bắt đầu, "Bài chờ duyệt" + Lịch): thêm Duyệt (tại `scheduledAt`, thiếu = giờ hiện tại của bài; giờ đã
 *   qua / còn dưới 2 phút → 422 `SCHEDULE_IN_PAST`) và Từ chối (`USER_REJECTED`). Tạo lại `immediate` → enqueue
 *   `campaigns.generate` (không thì lượt cron kế sinh lại).
 * Chiến dịch không có → 404; hành động không hợp trạng thái chiến dịch → 409; slot không thuộc chiến dịch → 404; `version`
 * lệch / sai trạng thái slot → 409 (`transitionTarget`). Trả slot sau hành động.
 */
export async function applySlotAction(
  tx: DbExecutor,
  deps: TransitionDeps,
  campaignId: string,
  targetId: string,
  input: ParsedCampaignSlotActionRequest,
): Promise<CampaignSlotDto> {
  const [campaign] = await tx.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, campaignId)).for('update')
  if (!campaign) throw new AppError('NOT_FOUND', 404, { message: 'Chiến dịch không tồn tại', details: { campaignId } })
  const status = campaign.status as CampaignStatus
  if (!ALLOWED[status].includes(input.action)) {
    throw new AppError('VERSION_CONFLICT', 409, {
      message: status === 'draft' ? 'Chiến dịch chưa bắt đầu' : 'Chiến dịch không còn nhận thao tác này',
      details: { campaignId, status },
    })
  }
  const slot = (await slotCampaignOf(tx, targetId)) === campaignId ? await getCampaignSlot(tx, targetId) : null
  if (!slot) throw new AppError('NOT_FOUND', 404, { message: 'Bài không thuộc chiến dịch này', details: { campaignId, targetId } })
  // Hậu kiểm chặn → phải sửa trước khi duyệt (Sửa bỏ mã); không để Lịch / API duyệt thẳng nội dung vi phạm (AD-21).
  if (input.action === 'approve' && slot.errorCode === 'AI_POLICY_BLOCKED') {
    throw new AppError('AI_POLICY_BLOCKED', 422, { message: 'Sửa bài trước khi duyệt', details: { campaignId, targetId } })
  }
  const transition: TargetTransition =
    input.action === 'edit'
      ? { action: 'edit', caption: input.caption }
      : input.action === 'regenerate'
        ? { action: 'regenerate' }
        : input.action === 'approve'
          ? { action: 'approve', at: new Date(input.scheduledAt ?? slot.scheduledAt ?? slot.slotAt) }
          : input.action === 'reject'
            ? { action: 'reject' }
            : { action: 'cancel', reason: 'USER_DELETED' }
  await transitionTarget(tx, deps, targetId, transition, input.version)
  if (input.action === 'regenerate') {
    if (status === 'draft') await deps.jobs.send('campaigns.preview', { campaignId }, { db: bossDbFor(tx) })
    else if (input.immediate) await deps.jobs.send('campaigns.generate', { campaignId }, { db: bossDbFor(tx) })
  }
  return (await getCampaignSlot(tx, targetId))!
}
