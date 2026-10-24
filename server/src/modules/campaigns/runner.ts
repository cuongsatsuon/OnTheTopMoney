// Vòng sinh một lô slot chung cho job xem trước (Story 7.2) và job cuốn chiếu (Story 7.4): tối đa `concurrency` slot song
// song qua `content.generateSlot` (caption theo hồ sơ + hậu kiểm, ảnh qua job ảnh có sẵn). Khác nhau ở cách xử lý mã dừng
// (khoá OpenAI / hạn mức / mã hoá — `AI_STOP_CODES`):
// - `mark` (xem trước): slot chưa bắt đầu nhận cùng mã, không gọi AI — bước 4 hiện lý do ngay.
// - `halt` (cuốn chiếu): dừng lô, slot chưa bắt đầu giữ `planned` để lượt sau tự viết khi gỡ chặn (không vượt hạn mức).
// Lỗi tạm của OpenAI ở slot nào đó không chặn slot khác; bên gọi ném sau khi lô xong để pg-boss thử lại.
import type { ComposeGoal, ErrorCode } from '@ottm/shared'
import { AI_STOP_CODES, SlotGenerateRetryableError, failSlot, generateSlot, type SlotGenerateDeps } from '../content/index.ts'

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
  },
): Promise<SlotBatchResult> {
  const out: SlotBatchResult = { generated: 0, errors: 0, scheduled: 0, stopCode: null, retryCode: null }
  let fatal: unknown = null
  let next = 0
  const worker = async () => {
    while (next < todo.length && fatal === null) {
      if (out.stopCode && opts.onStop === 'halt') return
      const slot = todo[next++]!
      if (opts.signal?.aborted) return
      try {
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
