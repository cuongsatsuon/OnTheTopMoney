// Cài đặt › Kết nối OpenAI phía web (Story 1.5). Khoá query bắt đầu bằng `settings` để sự kiện
// `settings.updated` (realtime) vô hiệu hoá và refetch. Server không bao giờ trả khoá đầy đủ.
import {
  OpenAiApiKey,
  OpenAiKeyInfo,
  OpenAiSettingsResponse,
  type ImageSize,
  type OpenAiKeyStatus,
  type UpdateOpenAiSettingsRequest,
} from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, isApiError } from './api'
import { errorMessageOf } from './error-messages'

export const OPENAI_SETTINGS_KEY = ['settings', 'openai'] as const

export function useOpenAiSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: OPENAI_SETTINGS_KEY,
    queryFn: ({ signal }) => apiFetch('/settings/openai', { schema: OpenAiSettingsResponse, signal }),
    enabled: options.enabled ?? true,
  })
}

/** "Kiểm tra và lưu": server kiểm khoá với OpenAI rồi mới lưu. Lỗi → `ApiError` (`OPENAI_KEY_INVALID`…). */
export function useSaveOpenAiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (apiKey: string) =>
      apiFetch('/settings/openai/key', { method: 'PUT', body: { apiKey }, schema: OpenAiKeyInfo }),
    onSuccess: (key) => {
      queryClient.setQueryData<OpenAiSettingsResponse>(OPENAI_SETTINGS_KEY, (prev) => (prev ? { ...prev, key } : prev))
      void queryClient.invalidateQueries({ queryKey: OPENAI_SETTINGS_KEY })
    },
  })
}

/** Gỡ khoá: server xoá bản ghi, trạng thái về `missing`. */
export function useDeleteOpenAiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch('/settings/openai/key', { method: 'DELETE', schema: OpenAiKeyInfo }),
    onSuccess: (key) => {
      queryClient.setQueryData<OpenAiSettingsResponse>(OPENAI_SETTINGS_KEY, (prev) => (prev ? { ...prev, key } : prev))
      void queryClient.invalidateQueries({ queryKey: OPENAI_SETTINGS_KEY })
    },
  })
}

/** Kiểm lại khoá đã lưu với OpenAI; phản hồi là trạng thái mới (`valid` / `invalid`). */
export function useRecheckOpenAiKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch('/settings/openai/key/recheck', { method: 'POST', body: {}, schema: OpenAiKeyInfo }),
    onSuccess: (key) => {
      queryClient.setQueryData<OpenAiSettingsResponse>(OPENAI_SETTINGS_KEY, (prev) => (prev ? { ...prev, key } : prev))
    },
  })
}

export function useSaveOpenAiSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateOpenAiSettingsRequest) =>
      apiFetch('/settings/openai', { method: 'PUT', body, schema: OpenAiSettingsResponse }),
    onSuccess: (data) => queryClient.setQueryData(OPENAI_SETTINGS_KEY, data),
  })
}

/** Trạng thái khoá cho nút AI: của server, hoặc `loading` (chưa có phản hồi) / `error` (tải lỗi, chưa có dữ liệu). */
export type AiKeyState = OpenAiKeyStatus | 'loading' | 'error'

export function openAiKeyStatusOf(query: { data?: Pick<OpenAiSettingsResponse, 'key'>; isError: boolean }): AiKeyState {
  return query.data?.key.status ?? (query.isError ? 'error' : 'loading')
}

export interface AiLock {
  /** true → nút AI mờ. Chỉ `valid` mở khoá. */
  locked: boolean
  /** Câu gợi ý (kèm liên kết Cài đặt); `null` = không hiện gợi ý (đang tải — tránh nháy chữ sai). */
  hint: string | null
}

export const AI_LOCK_HINTS = {
  missing: 'Thêm khoá OpenAI ở Cài đặt',
  invalid: 'Khoá OpenAI không hợp lệ — cập nhật ở Cài đặt',
  error: 'Chưa kiểm tra được khoá OpenAI',
} as const

export function aiLock(state: AiKeyState): AiLock {
  switch (state) {
    case 'valid':
      return { locked: false, hint: null }
    case 'loading':
      return { locked: true, hint: null }
    default:
      return { locked: true, hint: AI_LOCK_HINTS[state] }
  }
}

export const KEY_FORMAT_ERROR = 'Khoá phải bắt đầu bằng sk- và không có khoảng trắng'
export const KEY_REJECTED_ERROR = 'Khoá không hợp lệ'

/** Kiểm dạng khoá trước khi gửi (cùng schema với server); `null` = đúng dạng. */
export function keyFormatError(input: string): string | null {
  return OpenAiApiKey.safeParse(input).success ? null : KEY_FORMAT_ERROR
}

/** Câu lỗi khi lưu khoá (Cài đặt và màn Bắt đầu dùng chung). */
export function keyErrorMessage(err: unknown): string {
  if (isApiError(err) && err.code === 'OPENAI_KEY_INVALID') return KEY_REJECTED_ERROR
  if (isApiError(err) && err.code === 'VALIDATION_FAILED') return KEY_FORMAT_ERROR
  return errorMessageOf(err)
}

/** Nhãn chip trạng thái khoá; khoá không giải mã được nữa → "Cần nhập lại khoá". */
export function keyStatusLabel(key: Pick<OpenAiKeyInfo, 'status' | 'reason'>): string {
  return key.reason === 'reentry_required' ? 'Cần nhập lại khoá' : KEY_STATUS_LABEL[key.status]
}

/** Chip trạng thái khoá ở Cài đặt — luôn có chữ, không chỉ bằng màu. */
export const KEY_STATUS_LABEL: Record<OpenAiKeyStatus, string> = {
  valid: 'Đã kết nối',
  missing: 'Chưa có khoá',
  invalid: 'Khoá không hợp lệ',
}

export const IMAGE_SIZE_LABEL: Record<ImageSize, string> = {
  '1024x1024': '1024×1024 (vuông)',
  '1024x1536': '1024×1536 (dọc)',
  '1536x1024': '1536×1024 (ngang)',
}

/** Form Cài đặt › OpenAI: như request đầy đủ; model `''` = loại đó không có model nào đang bật. */
export interface OpenAiForm {
  textModel: string
  imageModel: string
  imageSize: ImageSize
  exchangeRateVnd: number
  monthlyLimitVnd: number
  warn80: boolean
}

export function openAiFormOf(data: OpenAiSettingsResponse): OpenAiForm {
  return {
    textModel: data.textModel ?? '',
    imageModel: data.imageModel ?? '',
    imageSize: data.imageSize,
    exchangeRateVnd: data.exchangeRateVnd,
    monthlyLimitVnd: data.monthlyLimitVnd,
    warn80: data.warn80,
  }
}

/** Body `PUT /settings/openai`: bỏ model rỗng (loại không có model đang bật) để server giữ giá trị cũ. */
export function toUpdateRequest(form: OpenAiForm): UpdateOpenAiSettingsRequest {
  const { textModel, imageModel, ...rest } = form
  return { ...rest, ...(textModel ? { textModel } : {}), ...(imageModel ? { imageModel } : {}) }
}

/** Lỗi ô số tiền (tỉ giá, hạn mức): phải là số nguyên dương, không vượt `max` của hợp đồng chung. */
export function moneyFieldError(value: number, max: number): string | null {
  if (!(value > 0)) return 'Nhập số lớn hơn 0.'
  if (value > max) return `Tối đa ${formatMoney(max)}.`
  if (!Number.isInteger(value)) return 'Nhập số nguyên.'
  return null
}

/** Chuỗi tiền đã định dạng ("1.000.000", "26.000 đ") → số nguyên; rỗng → 0. */
export function parseMoney(text: string): number {
  return Number(text.replace(/\D/g, '')) || 0
}

/** Số nguyên → "1.000.000" (vi-VN); 0 → chuỗi rỗng để ô nhập trống. */
export function formatMoney(value: number): string {
  return value ? value.toLocaleString('vi-VN') : ''
}
