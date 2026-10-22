// Hạn mức chi phí AI phía web (Story 1.6): số thật từ `GET /api/v1/ai/budget`.
// - Khoá query `['ai_budget']`: realtime `ai_budget.*` vô hiệu hoá trực tiếp; `settings.updated` (đổi hạn
//   mức / tỉ giá / cảnh báo) cũng vô hiệu hoá nhờ `ENTITY_ALSO_INVALIDATES` trong `realtime.ts`.
// - Chip sidebar: vàng khi `warn`, đỏ khi `blocked`; banner đỏ toàn app khi `blocked`.
// - Toast 80% khi server phát `ai_budget.threshold_reached` (chữ quyết định từ REST, không từ payload).
import { AiBudgetSummary, aiBudgetState, type AiBudgetState, type AiCategory } from '@ottm/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { apiFetch } from './api'
import { useRealtimeEvent } from './realtime'

export const AI_BUDGET_KEY = ['ai_budget'] as const
/**
 * Hỏi lại định kỳ: chi tiêu giữa hai ngưỡng không phát sự kiện, và sang tháng mới (giờ VN) thì banner của
 * tháng trước phải tự mất.
 */
export const AI_BUDGET_REFETCH_MS = 60_000

export function fetchAiBudget(signal?: AbortSignal): Promise<AiBudgetSummary> {
  return apiFetch('/ai/budget', { schema: AiBudgetSummary, ...(signal ? { signal } : {}) })
}

export function useAiBudget(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: AI_BUDGET_KEY,
    queryFn: ({ signal }) => fetchAiBudget(signal),
    refetchInterval: AI_BUDGET_REFETCH_MS,
    enabled: options.enabled ?? true,
  })
}

/** "312.000đ". */
export function formatVnd(value: number): string {
  return `${value.toLocaleString('vi-VN')}đ`
}

export const BUDGET_TOAST_80 = 'Đã dùng 80% hạn mức AI tháng này'
export const BUDGET_BANNER_TEXT = 'Đã dùng hết hạn mức AI tháng này'
export const BUDGET_BANNER_ACTION = 'Tăng hạn mức'

export type BudgetTone = 'normal' | 'warn' | 'blocked'

export interface BudgetView {
  /** % hạn mức đã dùng (có thể > 100). */
  percent: number
  /** Độ dài thanh (0–100). */
  barPercent: number
  tone: BudgetTone
  /** Chữ trạng thái kèm chip (không chỉ bằng màu); `null` khi bình thường. */
  status: string | null
  /** Banner đỏ toàn app. */
  banner: boolean
  /** "312.000đ / 1.000.000đ". */
  usedText: string
}

const TONE: Record<AiBudgetState, BudgetTone> = { ok: 'normal', warn: 'warn', blocked: 'blocked' }
const STATUS: Record<AiBudgetState, string | null> = { ok: null, warn: 'Sắp chạm hạn mức', blocked: 'Đã hết hạn mức' }

/** Tông màu theo số đã tiêu / hạn mức / công tắc 80% — cùng luật với chip (dùng cho xem trước ở Cài đặt). */
export function budgetToneOf(input: { spentVnd: number; limitVnd: number; warn80: boolean }): BudgetTone {
  return TONE[aiBudgetState(input)]
}

/** Tóm tắt chi phí → chip sidebar / banner. Trạng thái do server quyết (đã tính công tắc cảnh báo 80%). */
export function budgetView(summary: AiBudgetSummary): BudgetView {
  return {
    percent: summary.percent,
    barPercent: Math.min(100, Math.max(0, summary.percent)),
    tone: TONE[summary.state],
    status: STATUS[summary.state],
    banner: summary.state === 'blocked',
    usedText: `${formatVnd(summary.spentVnd)} / ${formatVnd(summary.limitVnd)}`,
  }
}

/**
 * Câu toast khi server báo vừa chạm ngưỡng: chỉ ở `warn` (≥80%, đang bật cảnh báo). `blocked` → không toast
 * (banner đỏ đã hiện); `ok` (vd đã tăng hạn mức trước khi tải xong) → không toast.
 */
export function thresholdToast(summary: AiBudgetSummary): string | null {
  return summary.state === 'warn' ? BUDGET_TOAST_80 : null
}

/** Toast 80%: nghe `ai_budget.threshold_reached`, tải lại tóm tắt rồi quyết câu (dùng một lần, ở AppShell). */
export function useAiBudgetToasts(notify: (message: string) => void): void {
  const queryClient = useQueryClient()
  const onThreshold = useCallback(() => {
    queryClient
      .fetchQuery({ queryKey: AI_BUDGET_KEY, queryFn: ({ signal }) => fetchAiBudget(signal), staleTime: 0 })
      .then((summary) => {
        const text = thresholdToast(summary)
        if (text) notify(text)
      })
      .catch(() => {
        // Tải lỗi thì bỏ toast; chip vẫn cập nhật ở lần refetch sau.
      })
  }, [queryClient, notify])
  useRealtimeEvent('ai_budget.threshold_reached', onThreshold)
}

/** Nhãn + đơn vị đếm của hạng mục (Cài đặt › OpenAI › bảng chi phí). */
export const AI_CATEGORY_LABEL: Record<AiCategory, { label: string; unit: string }> = {
  reply: { label: 'Trả lời tin nhắn', unit: 'tin' },
  content: { label: 'Sinh bài viết', unit: 'lượt' },
  image: { label: 'Sinh ảnh', unit: 'ảnh' },
}

export interface CategoryRow {
  category: AiCategory
  label: string
  /** "912 tin". */
  amount: string
  costVnd: number
  /** Tỉ trọng trong tổng (0–100). */
  share: number
}

/** Dòng bảng chi phí theo hạng mục, theo thứ tự server trả. */
export function categoryRows(summary: Pick<AiBudgetSummary, 'byCategory'>): CategoryRow[] {
  const total = summary.byCategory.reduce((n, c) => n + c.costVnd, 0)
  return summary.byCategory.map((c) => ({
    category: c.category,
    label: AI_CATEGORY_LABEL[c.category].label,
    amount: `${c.count.toLocaleString('vi-VN')} ${AI_CATEGORY_LABEL[c.category].unit}`,
    costVnd: c.costVnd,
    share: total > 0 ? (c.costVnd / total) * 100 : 0,
  }))
}
