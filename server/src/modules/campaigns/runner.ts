// Vòng sinh một lô slot chung cho job xem trước (Story 7.2) và job cuốn chiếu (Story 7.4): tối đa `concurrency` slot song
// song qua `content.generateSlot` (caption theo hồ sơ + hậu kiểm, ảnh qua job ảnh có sẵn). Khác nhau ở cách xử lý mã dừng
// (khoá OpenAI / hạn mức / mã hoá — `AI_STOP_CODES`):
// - `mark` (xem trước): slot chưa bắt đầu nhận cùng mã, không gọi AI — bước 4 hiện lý do ngay.
// - `halt` (cuốn chiếu): dừng lô, slot chưa bắt đầu giữ `planned` để lượt sau tự viết khi gỡ chặn (không vượt hạn mức).
// Lỗi tạm của OpenAI ở slot nào đó không chặn slot khác; bên gọi ném sau khi lô xong để pg-boss thử lại.
// Story 7.5: `active()` kiểm trước mỗi slot (chiến dịch vừa tạm dừng / xoá giữa lô → dừng, không gọi AI thêm); slot đang
// viết dở thì viết xong (bài `held` không được "Tự đăng" duyệt luôn).
// Story 7.7: `referenceAssetId` = ảnh sản phẩm của chiến dịch — mọi slot có ảnh trong lô sinh ảnh từ ảnh này (edits).
// Story 7.8: `plan` = ngữ cảnh chiến dịch → trước khi viết, `content.planCampaignSlots` lên brief cho các slot của lô chưa
// có brief (một lời gọi mỗi trang; chiến dịch thôi chạy / đã huỷ thì không lên). Lỗi kế hoạch không chặn lô.
import type { CampaignStatus, ComposeGoal, ErrorCode } from '@ottm/shared'
import { eq } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import {
  AI_STOP_CODES,
  SlotGenerateRetryableError,
  failSlot,
  generateSlot,
  planCampaignSlots,
  type CampaignPlanRequest,
  type SlotGenerateDeps,
} from '../content/index.ts'
import { campaigns } from './schema.ts'

/** Chiến dịch còn tồn tại và ở một trong `statuses` (đọc không khoá — kiểm giữa lô sinh). */
export async function campaignIn(db: DbExecutor, campaignId: string, statuses: readonly CampaignStatus[]): Promise<boolean> {
  const [row] = await db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, campaignId))
  return !!row && statuses.includes(row.status as CampaignStatus)
}

/** Số slot sinh song song trong một lượt [ASSUMPTION] — như Soạn bài (`COMPOSE_CONCURRENCY`). */
export const SLOT_CONCURRENCY = 3

export interface SlotBatchResult {
  generated: number
  errors: number
  /** Slot đã duyệt luôn ("Tự đăng"). */
  scheduled: number
  /** Mã dừng đầu tiên gặp trong lô (nếu có). */
  stopCode: ErrorCode | null
  /** Có lỗi tạm ở lượt chưa phải cuối — bên gọi ném để retry. */
  retryCode: ErrorCode | null
  /** Story 7.5: lô dừng giữa chừng vì `active()` trả `false` (chiến dịch tạm dừng / đã xoá). */
  inactive: boolean
}

export async function runSlotBatch(
  deps: SlotGenerateDeps,
  todo: readonly { id: string; withImage: boolean }[],
  opts: {
    goal: ComposeGoal
    finalAttempt: boolean
    signal?: AbortSignal | undefined
    concurrency?: number
    onStop: 'mark' | 'halt'
    autoApprove?: boolean
    /** Story 7.7: ảnh sản phẩm của chiến dịch (`null` = không có). */
    referenceAssetId?: string | null
    /** Chiến dịch còn nhận sinh nội dung không — kiểm trước mỗi slot. */
    active?: () => Promise<boolean>
    /** Story 7.8: lên brief cho slot của lô trước khi viết (thiếu = viết theo chủ đề như cũ). */
    plan?: CampaignPlanRequest & { campaignId: string }
  },
): Promise<SlotBatchResult> {
  const out: SlotBatchResult = { generated: 0, errors: 0, scheduled: 0, stopCode: null, retryCode: null, inactive: false }
  if (opts.plan && todo.length && !opts.signal?.aborted) {
    if (opts.active && !(await opts.active())) return { ...out, inactive: true }
    const { campaignId, ...req } = opts.plan
    await planCampaignSlots(deps, campaignId, todo, req, opts.signal)
  }
  let fatal: unknown = null
  let next = 0
  const worker = async () => {
    while (next < todo.length && fatal === null && !out.inactive) {
      if (out.stopCode && opts.onStop === 'halt') return
      const slot = todo[next++]!
      if (opts.signal?.aborted) return
      try {
        if (opts.active && !(await opts.active())) {
          out.inactive = true
          return
        }
        if (out.stopCode) {
          if (await failSlot(deps, slot.id, out.stopCode)) out.errors++
          continue
        }
        const outcome = await generateSlot(deps, slot.id, {
          goal: opts.goal,
          withImage: slot.withImage,
          finalAttempt: opts.finalAttempt,
          signal: opts.signal,
          ...(opts.autoApprove ? { autoApprove: true } : {}),
          ...(opts.referenceAssetId ? { referenceAssetId: opts.referenceAssetId } : {}),
        })
        if (outcome.status === 'error') {
          out.errors++
          if (AI_STOP_CODES.has(outcome.errorCode)) out.stopCode ??= outcome.errorCode
        } else if (outcome.status !== 'skipped') {
          out.generated++
          if (outcome.status === 'scheduled') out.scheduled++
        }
      } catch (err) {
        if (err instanceof SlotGenerateRetryableError) out.retryCode ??= err.code
        else fatal ??= err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? SLOT_CONCURRENCY, todo.length)) }, worker))
  opts.signal?.throwIfAborted()
  if (fatal !== null) throw fatal
  return out
}
