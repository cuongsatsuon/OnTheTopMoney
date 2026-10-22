// Hạn mức chi phí AI (Story 1.6): tổng tháng (lịch `Asia/Ho_Chi_Minh`), % hạn mức, trạng thái và chi phí
// theo hạng mục. Hạng mục gộp từ `AiFeature` — web hiển thị "Trả lời tin nhắn / Sinh bài viết / Sinh ảnh".
import { z } from 'zod'
import type { AiFeature } from './enums.ts'

/** `reply` = Trả lời tin nhắn, `content` = Sinh bài viết, `image` = Sinh ảnh. */
export const AI_CATEGORIES = ['reply', 'content', 'image'] as const
export const AiCategory = z.enum(AI_CATEGORIES)
export type AiCategory = z.infer<typeof AiCategory>

/** Mỗi tính năng AI thuộc đúng một hạng mục (thêm `AiFeature` mới mà quên ở đây → typecheck đỏ). */
export const AI_FEATURE_CATEGORY: Record<AiFeature, AiCategory> = {
  autoreply: 'reply',
  autoreply_test: 'reply',
  inbox_suggest: 'reply',
  compose_caption: 'content',
  campaign_generate: 'content',
  brand_sample: 'content',
  contact_summary: 'content',
  image_generate: 'image',
}

export function isAiFeature(value: string): value is AiFeature {
  return Object.hasOwn(AI_FEATURE_CATEGORY, value)
}

/** Các tính năng thuộc một hạng mục. */
export function aiFeaturesOf(category: AiCategory): AiFeature[] {
  return (Object.keys(AI_FEATURE_CATEGORY) as AiFeature[]).filter((f) => AI_FEATURE_CATEGORY[f] === category)
}

/** Ngưỡng cảnh báo (%) khi bật "Cảnh báo khi đạt 80%". */
export const AI_BUDGET_WARN_PERCENT = 80

/** `ok` bình thường · `warn` đã ≥80% (chỉ khi bật cảnh báo) · `blocked` chi tiêu ≥ hạn mức (mọi lời gọi bị chặn). */
export const AI_BUDGET_STATES = ['ok', 'warn', 'blocked'] as const
export const AiBudgetState = z.enum(AI_BUDGET_STATES)
export type AiBudgetState = z.infer<typeof AiBudgetState>

/** Trạng thái hạn mức từ số đã tiêu (VND nguyên). Hạn mức ≤ 0 → luôn `blocked`. */
export function aiBudgetState(input: { spentVnd: number; limitVnd: number; warn80: boolean }): AiBudgetState {
  const { spentVnd, limitVnd, warn80 } = input
  if (limitVnd <= 0 || spentVnd >= limitVnd) return 'blocked'
  if (warn80 && spentVnd * 100 >= limitVnd * AI_BUDGET_WARN_PERCENT) return 'warn'
  return 'ok'
}

const Vnd = z.number().int().nonnegative()

export const AiCategoryCost = z.object({
  category: AiCategory,
  costVnd: Vnd,
  /** Số lượt gọi (tin, bài…); với `image` là số ảnh. */
  count: z.number().int().nonnegative(),
})
export type AiCategoryCost = z.infer<typeof AiCategoryCost>

/** `GET /api/v1/ai/budget`. Chưa có dòng tháng → mọi số = 0. `byCategory` luôn đủ ba hạng mục theo thứ tự `AI_CATEGORIES`. */
export const AiBudgetSummary = z.object({
  /** Tháng lịch giờ Việt Nam, `YYYY-MM`. */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  limitVnd: Vnd,
  spentVnd: Vnd,
  /** Chi phí ước tính đang được giữ chỗ cho các lời gọi đang chạy. */
  reservedVnd: Vnd,
  /** `floor(spent / limit × 100)`; có thể > 100. */
  percent: z.number().int().nonnegative(),
  state: AiBudgetState,
  warn80: z.boolean(),
  byCategory: z.array(AiCategoryCost),
})
export type AiBudgetSummary = z.infer<typeof AiBudgetSummary>
