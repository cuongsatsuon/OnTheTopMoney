// Sinh nội dung cuốn chiếu (Story 7.4, AD-15, AD-7). Lịch đã có đủ slot `planned` từ lúc "Bắt đầu" (7.3); AI chỉ viết
// trước các slot có giờ đăng trong `CAMPAIGN_GENERATE_WINDOW_MS` (3 ngày) — không sinh cả chiến dịch một lúc.
// - Cron `campaigns.generate_window` (hằng giờ): chốt ô ảnh slot kẹt (`content.failStuckSlotImages`), enqueue
//   `campaigns.generate` cho mọi chiến dịch `running` (`paused` / `done` bỏ qua), enqueue lại `campaigns.preview` cho nháp
//   có bài xem trước kẹt "AI đang viết…" (job mất).
// - Job `campaigns.generate {campaignId}` (stately): "Tự đăng" → duyệt bài chờ duyệt không mã lỗi trước (bài xem trước
//   viết dở lúc bắt đầu); rồi một lô `GENERATE_BATCH` slot trong cửa sổ qua `content.generateSlot` (`autoApprove` theo
//   chế độ). Còn slot ngoài lô → enqueue lượt sau.
// - Hạn mức (AD-7): kiểm khoá OpenAI + hạn mức trước lô; bị chặn → không gọi AI, không đổi slot. Hết hạn mức giữa lô →
//   slot gặp lỗi về "Chờ duyệt" kèm mã, các slot còn lại giữ `planned`, không enqueue tiếp. Gateway vẫn giữ chỗ trước mỗi
//   lời gọi nên không bao giờ vượt hạn mức.
// - Story 7.6: bị chặn (trang của chiến dịch mất kết nối / thiếu hồ sơ, khoá OpenAI chưa dùng được, hạn mức hết — trước lô
//   hay giữa lô) → tự tạm dừng chiến dịch với lý do tương ứng thay vì dừng im lặng: chủ shop thấy lý do trên thẻ, và
//   "Tiếp tục" huỷ bài lỡ giờ (`MISSED_WHILE_PAUSED`) thay vì viết bù bài đã quá giờ (tốn tiền).
// - Idempotent: slot đã sinh bỏ qua; lease của `generateSlot` chặn hai lượt cùng viết một slot (không tính tiền hai lần).
// - Story 7.7: slot có ảnh sinh ảnh từ ảnh sản phẩm của chiến dịch (`referenceAssetId` — không đổi sau khi bắt đầu).
import { CAMPAIGN_GENERATE_WINDOW_MS, type CampaignStatus, type ErrorCode, type PauseReason } from '@ottm/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import type { Logger } from '../../platform/log/index.ts'
import { getBudgetSummary, getUsableOpenAiKey } from '../ai/index.ts'
import { autoApproveCampaignSlots, failStuckSlotImages, listSlotsToGenerate, staleSlotCampaigns, type SlotGenerateDeps } from '../content/index.ts'
import { getPage } from '../pages/index.ts'
import { getCampaign } from './drafts.ts'
import { pauseBySystem } from './lifecycle.ts'
import { pageBlockReason } from './pages.ts'
import { COMPOSE_GOAL, campaignPlan, keyOf } from './preview.ts'
import { campaignIn, runSlotBatch } from './runner.ts'
import { campaigns } from './schema.ts'

/** Số slot mỗi lượt job [ASSUMPTION]: 9 slot / 3 song song × 2 lời gọi (≤120 giây mỗi lời) vừa hạn 900 giây của queue. */
export const GENERATE_BATCH = 9
/** Bài xem trước của nháp đứng yên (chưa viết, không job giữ) quá chừng này → cron enqueue lại `campaigns.preview`. */
export const PREVIEW_STALE_MS = 15 * 60_000

/** Có lỗi tạm của OpenAI ở lượt chưa phải cuối — ném để pg-boss thử lại (slot lỗi vẫn `planned`). */
export class GenerateRetryableError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode) {
    super(`campaigns.generate: ${code}`)
    this.name = 'GenerateRetryableError'
    this.code = code
  }
}

export type GenerateDeps = SlotGenerateDeps

/** Story 7.6: lý do tự tạm dừng ứng với mã dừng của lô (`AI_STOP_CODES`). */
export function pauseReasonOfStop(code: ErrorCode): Exclude<PauseReason, 'MANUAL'> {
  return code === 'AI_BUDGET_EXCEEDED' ? 'AI_BUDGET_EXCEEDED' : 'OPENAI_KEY_UNAVAILABLE'
}

export type GenerateResult =
  | 'skipped'
  /** Bị chặn trước khi gọi AI; `paused` = lý do vừa tự tạm dừng. */
  | { stopped: ErrorCode; approved: number; paused: Exclude<PauseReason, 'MANUAL'> }
  | {
      generated: number
      errors: number
      scheduled: number
      approved: number
      more: boolean
      stopCode: ErrorCode | null
      /** Story 7.6: mã dừng giữa lô → lý do vừa tự tạm dừng. */
      paused: Exclude<PauseReason, 'MANUAL'> | null
    }

/**
 * Một lượt sinh cuốn chiếu của chiến dịch `campaignId` (chỉ khi `running`). `now` = mốc của cửa sổ (test cố định);
 * `concurrency` chỉ để test thứ tự.
 */
export async function runGenerate(
  deps: GenerateDeps,
  campaignId: string,
  opts: { finalAttempt: boolean; signal?: AbortSignal | undefined; concurrency?: number },
): Promise<GenerateResult> {
  const now = deps.now?.() ?? new Date()
  // Cấu hình + "Tự đăng" duyệt + danh sách slot cần sinh dưới khoá `FOR SHARE` của dòng chiến dịch (tạm dừng / xoá — 7.5 —
  // khoá `FOR UPDATE` thì lượt này chờ rồi đọc bản mới).
  const loaded = await deps.db.transaction(async (tx) => {
    const [row] = await tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId)).for('share')
    const campaign = row ? await getCampaign(tx, campaignId) : null
    if (!campaign || campaign.status !== ('running' satisfies CampaignStatus)) return null
    const approved = campaign.mode === 'auto' ? (await autoApproveCampaignSlots(tx, { jobs: deps.jobs, events: deps.events, now: () => now }, campaignId)).scheduled : 0
    const plan = await campaignPlan(tx, campaign)
    const livePages = new Set<string>()
    for (const p of campaign.pages) if (await getPage(tx, p.pageId)) livePages.add(p.pageId)
    const todo = await listSlotsToGenerate(tx, campaignId, { until: new Date(now.getTime() + CAMPAIGN_GENERATE_WINDOW_MS), limit: GENERATE_BATCH + 1 })
    return { campaign, plan, livePages, todo, approved }
  })
  if (!loaded) return 'skipped'
  const { campaign, approved } = loaded
  if (!loaded.todo.length) return { generated: 0, errors: 0, scheduled: 0, approved, more: false, stopCode: null, paused: null }

  // Bị chặn → tự tạm dừng trước khi gọi AI (Story 7.6); slot giữ `planned`. Lưới an toàn khi sự kiện bị lỡ (vd hạ hạn mức).
  const stop = async (code: ErrorCode, reason: Exclude<PauseReason, 'MANUAL'>): Promise<GenerateResult> => {
    await pauseBySystem(deps.db, deps, campaignId, reason, now)
    return { stopped: code, approved, paused: reason }
  }
  for (const pageId of loaded.livePages) {
    const page = await getPage(deps.db, pageId)
    const blocked = page ? await pageBlockReason(deps.db, page) : null
    if (blocked) return stop(blocked, blocked)
  }
  try {
    await getUsableOpenAiKey(deps)
  } catch (err) {
    if (err instanceof AppError) return stop(err.code, 'OPENAI_KEY_UNAVAILABLE')
    throw err
  }
  // Cùng đồng hồ với gateway (tháng hạn mức theo giờ thật, không theo mốc cửa sổ).
  if ((await getBudgetSummary({ db: deps.db })).state === 'blocked') return stop('AI_BUDGET_EXCEEDED', 'AI_BUDGET_EXCEEDED')

  const withImage = new Map(loaded.plan.map((s) => [keyOf(s.pageId, s.slotAt), s.withImage]))
  // Slot của trang đã gỡ không có trong kế hoạch → vẫn đi tiếp để chốt `PAGE_REMOVED` (không kẹt `planned`).
  const batch = loaded.todo
    .slice(0, GENERATE_BATCH)
    .filter((s) => withImage.has(keyOf(s.pageId, s.slotAt.toISOString())) || !loaded.livePages.has(s.pageId))
    .map((s) => ({ id: s.id, withImage: withImage.get(keyOf(s.pageId, s.slotAt.toISOString())) ?? false }))
  const result = await runSlotBatch(deps, batch, {
    goal: COMPOSE_GOAL[campaign.goal],
    finalAttempt: opts.finalAttempt,
    signal: opts.signal,
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    onStop: 'halt',
    autoApprove: campaign.mode === 'auto',
    referenceAssetId: campaign.productImage?.id ?? null,
    // Story 7.5: tạm dừng / xoá giữa lô → dừng trước slot kế (AC: cron sinh nội dung bỏ qua chiến dịch tạm dừng).
    active: () => campaignIn(deps.db, campaignId, ['running']),
  })
  // Mã dừng giữa lô (hết hạn mức, khoá bị thu hồi) → tự tạm dừng; slot gặp lỗi đã về "Chờ duyệt" kèm mã.
  const paused = result.stopCode ? pauseReasonOfStop(result.stopCode) : null
  if (paused) await pauseBySystem(deps.db, deps, campaignId, paused, now)
  if (result.retryCode && !result.inactive) throw new GenerateRetryableError(result.retryCode)
  // Còn slot trong cửa sổ ngoài lô (và lô không dừng vì mã dừng / chiến dịch thôi chạy) → lượt sau (stately: xếp sau lượt
  // đang chạy).
  const more = loaded.todo.length > GENERATE_BATCH && !result.stopCode && !result.inactive
  if (more) await deps.jobs.send('campaigns.generate', { campaignId })
  return { generated: result.generated, errors: result.errors, scheduled: result.scheduled, approved, more, stopCode: result.stopCode, paused }
}

export function parseGenerateJobData(data: unknown): { campaignId: string } {
  const id = (data as { campaignId?: unknown } | null)?.campaignId
  if (typeof id !== 'string' || id === '') throw new Error('campaigns.generate: thiếu campaignId')
  return { campaignId: id }
}

export async function handleGenerateJob(
  deps: GenerateDeps,
  job: { data: unknown; retryCount: number; retryLimit: number; signal?: AbortSignal | undefined },
): Promise<GenerateResult> {
  const { campaignId } = parseGenerateJobData(job.data)
  return runGenerate(deps, campaignId, { finalAttempt: job.retryCount >= job.retryLimit, signal: job.signal })
}

export interface GenerateWindowDeps {
  db: Db
  events: EventPublisher
  jobs: JobSender
  log?: Logger | undefined
  now?: () => Date
}

export interface GenerateWindowResult {
  /** Ô ảnh slot kẹt vừa chốt `IMAGE_FAILED`. */
  stuckImages: number
  /** Chiến dịch đang chạy được enqueue `campaigns.generate`. */
  generate: number
  /** Nháp có bài xem trước kẹt được enqueue lại `campaigns.preview`. */
  preview: number
}

/** Handler cron `campaigns.generate_window`. */
export async function runGenerateWindow(deps: GenerateWindowDeps): Promise<GenerateWindowResult> {
  const now = deps.now?.() ?? new Date()
  const stuckImages = await failStuckSlotImages(deps, now)
  const running = await deps.db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.status, 'running' satisfies CampaignStatus))
  for (const c of running) await deps.jobs.send('campaigns.generate', { campaignId: c.id })
  const stale = new Set(await staleSlotCampaigns(deps.db, new Date(now.getTime() - PREVIEW_STALE_MS)))
  let preview = 0
  if (stale.size) {
    const drafts = await deps.db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.status, 'draft' satisfies CampaignStatus))
    for (const c of drafts) {
      if (!stale.has(c.id)) continue
      await deps.jobs.send('campaigns.preview', { campaignId: c.id })
      preview++
    }
  }
  return { stuckImages, generate: running.length, preview }
}
