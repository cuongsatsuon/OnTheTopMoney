// Xem trước 7 bài đầu (Story 7.2, AD-15, AD-13). Bài xem trước là slot THẬT của chiến dịch nháp (`planned` → AI sinh →
// `pending_approval`, luôn `held`): "Bắt đầu" (7.3) giữ nguyên và chỉ bỏ `held` — không sinh lại, không nhân đôi
// (khoá `(campaign_id, page_id, slot_at)` + luật slot chung `campaignSlots`).
// - Lưu nháp (bước 3 → 4): `syncPreviewSlots` trong transaction lưu — dọn slot không còn khớp cấu hình mới, tạo slot
//   thiếu, enqueue `campaigns.preview` (stately theo chiến dịch).
// - Job `campaigns.preview`: ensure lại slot (idempotent), sinh từng slot chưa sinh qua `content.generateSlot`
//   (caption theo hồ sơ hiệu lực + hậu kiểm, ảnh qua job ảnh có sẵn), tối đa 3 slot song song. Mã dừng (khoá OpenAI /
//   hạn mức / mã hoá) → slot chưa bắt đầu nhận cùng mã, không gọi AI. Lỗi tạm → ném sau khi slot khác đã xong.
// - Sửa / Xoá / Tạo lại: đi qua `content.transitionTarget` với `version`; Tạo lại enqueue `campaigns.preview`.
import {
  CAMPAIGN_PREVIEW_COUNT,
  campaignSlots,
  type CampaignDto,
  type CampaignGoal,
  type CampaignPreviewResponse,
  type CampaignSlot,
  type ParsedCampaignSlotActionRequest,
  type CampaignStatus,
  type ComposeGoal,
  type ErrorCode,
  type Platform,
} from '@ottm/shared'
import { eq } from 'drizzle-orm'
import { bossDbFor, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import {
  AI_STOP_CODES,
  SlotGenerateRetryableError,
  ensureCampaignSlots,
  failSlot,
  generateSlot,
  listCampaignSlots,
  listSlotsToGenerate,
  pruneCampaignSlots,
  slotCampaignOf,
  transitionTarget,
  type SlotGenerateDeps,
  type SlotPlan,
  type TargetTransition,
  type TransitionDeps,
} from '../content/index.ts'
import { getPage } from '../pages/index.ts'
import { getCampaign } from './drafts.ts'
import { campaigns } from './schema.ts'

/** Số slot sinh song song trong một lượt [ASSUMPTION] — như Soạn bài (`COMPOSE_CONCURRENCY`). */
export const PREVIEW_CONCURRENCY = 3

/** Mục tiêu chiến dịch → mục tiêu bài của mẫu prompt Soạn bài (dùng lại, không thêm mẫu mới — AD-7). */
const COMPOSE_GOAL: Record<CampaignGoal, ComposeGoal> = { engage: 'engagement', follow: 'engagement', sell: 'sales', launch: 'announce' }

const keyOf = (pageId: string, slotAt: string) => `${pageId}|${slotAt}`

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
 * đề) bị xoá, slot thiếu được tạo `planned` + `held` (chưa lên Lịch), rồi enqueue `campaigns.preview` (thiếu `jobs` —
 * test không pg-boss — thì chỉ dựng slot).
 */
export async function syncPreviewSlots(tx: DbExecutor, campaign: CampaignDto, jobs?: JobSender): Promise<void> {
  const plan = (await previewPlan(tx, campaign)).map(toSlotPlan)
  await pruneCampaignSlots(tx, campaign.id, plan)
  await ensureCampaignSlots(tx, campaign.id, plan, { held: true, onCalendar: false })
  if (jobs) await jobs.send('campaigns.preview', { campaignId: campaign.id }, { db: bossDbFor(tx) })
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
    const livePages = new Set<string>()
    for (const p of campaign.pages) if (await getPage(tx, p.pageId)) livePages.add(p.pageId)
    return { campaign, plan, livePages, todo: await listSlotsToGenerate(tx, campaignId) }
  })
  if (!loaded) return 'skipped'
  const { campaign, plan } = loaded
  const withImage = new Map(plan.map((s) => [keyOf(s.pageId, s.slotAt), s.withImage]))
  // Slot của trang còn dùng mà không có trong kế hoạch vừa đọc → bỏ qua (không sinh theo luật ảnh đoán mò; lượt của lần
  // lưu sau tự sinh). Slot của trang đã gỡ (không có trong kế hoạch) vẫn đi tiếp để chốt `PAGE_REMOVED`.
  const todo = loaded.todo.filter((s) => withImage.has(keyOf(s.pageId, s.slotAt.toISOString())) || !loaded.livePages.has(s.pageId))
  const goal = COMPOSE_GOAL[campaign.goal]

  let stopCode: ErrorCode | null = null
  let retryCode: ErrorCode | null = null
  let fatal: unknown = null
  let generated = 0
  let errors = 0
  let next = 0
  const worker = async () => {
    while (next < todo.length && fatal === null) {
      const slot = todo[next++]!
      if (opts.signal?.aborted) return
      try {
        if (stopCode) {
          if (await failSlot(deps, slot.id, stopCode)) errors++
          continue
        }
        const outcome = await generateSlot(deps, slot.id, {
          goal,
          withImage: withImage.get(keyOf(slot.pageId, slot.slotAt.toISOString())) ?? false,
          finalAttempt: opts.finalAttempt,
          signal: opts.signal,
        })
        if (outcome.status === 'error') {
          errors++
          if (AI_STOP_CODES.has(outcome.errorCode)) stopCode ??= outcome.errorCode
        } else if (outcome.status !== 'skipped') generated++
      } catch (err) {
        if (err instanceof SlotGenerateRetryableError) retryCode ??= err.code
        else fatal ??= err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? PREVIEW_CONCURRENCY, todo.length)) }, worker))
  opts.signal?.throwIfAborted()
  if (fatal !== null) throw fatal
  if (retryCode) throw new PreviewRetryableError(retryCode)
  return { generated, errors }
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

/**
 * Sửa / Xoá / Tạo lại một bài xem trước (chạy trong transaction của bên gọi, khoá dòng chiến dịch như lưu nháp).
 * Chiến dịch không có → 404; đã rời `draft` → 409 (bài chờ duyệt của chiến dịch đang chạy thuộc 7.4); slot không thuộc
 * chiến dịch → 404; `version` lệch / sai trạng thái → 409 (`transitionTarget`).
 */
export async function applySlotAction(
  tx: DbExecutor,
  deps: TransitionDeps,
  campaignId: string,
  targetId: string,
  input: ParsedCampaignSlotActionRequest,
): Promise<void> {
  const [campaign] = await tx.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, campaignId)).for('update')
  if (!campaign) throw new AppError('NOT_FOUND', 404, { message: 'Chiến dịch không tồn tại', details: { campaignId } })
  if (campaign.status !== ('draft' satisfies CampaignStatus)) throw new AppError('VERSION_CONFLICT', 409, { message: 'Chiến dịch đã bắt đầu' })
  if ((await slotCampaignOf(tx, targetId)) !== campaignId) {
    throw new AppError('NOT_FOUND', 404, { message: 'Bài không thuộc chiến dịch này', details: { campaignId, targetId } })
  }
  const transition: TargetTransition =
    input.action === 'edit'
      ? { action: 'edit', caption: input.caption }
      : input.action === 'regenerate'
        ? { action: 'regenerate' }
        : { action: 'cancel', reason: 'USER_DELETED' }
  await transitionTarget(tx, deps, targetId, transition, input.version)
  if (input.action === 'regenerate') await deps.jobs.send('campaigns.preview', { campaignId }, { db: bossDbFor(tx) })
}
