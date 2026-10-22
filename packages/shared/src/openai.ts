// Kết nối OpenAI (Story 1.5): khoá đã kiểm + mã hoá, lựa chọn model, kích thước ảnh, tỉ giá, hạn mức.
// Server không bao giờ trả khoá đầy đủ — chỉ `{configured, last4, status, checkedAt}` (AD-12).
// Danh sách model lấy từ bảng `ai_model_prices` (AD-7), không viết cứng ở web.
import { z } from 'zod'

const IsoDateTime = z.iso.datetime({ offset: false })

/** `missing` = chưa lưu khoá; `valid` = OpenAI đã nhận khoá; `invalid` = OpenAI từ chối (401). */
export const OPENAI_KEY_STATUSES = ['missing', 'valid', 'invalid'] as const
export const OpenAiKeyStatus = z.enum(OPENAI_KEY_STATUSES)
export type OpenAiKeyStatus = z.infer<typeof OpenAiKeyStatus>

/**
 * Lý do kèm `status: 'invalid'`: `reentry_required` = khoá đã lưu không giải mã được nữa (keyId không còn
 * trong `APP_ENCRYPTION_KEYS`, dữ liệu hỏng, khoá dev bị sinh lại) → phải nhập lại khoá.
 */
export const OPENAI_KEY_REASONS = ['reentry_required'] as const
export const OpenAiKeyReason = z.enum(OPENAI_KEY_REASONS)
export type OpenAiKeyReason = z.infer<typeof OpenAiKeyReason>

export const OpenAiKeyInfo = z.object({
  configured: z.boolean(),
  /** 4 ký tự cuối của khoá; `null` khi chưa có khoá. */
  last4: z.string().nullable(),
  status: OpenAiKeyStatus,
  /** Lần cuối kiểm khoá với OpenAI. */
  checkedAt: IsoDateTime.nullable(),
  reason: OpenAiKeyReason.nullable(),
})
export type OpenAiKeyInfo = z.infer<typeof OpenAiKeyInfo>

/** Độ dài tối đa của khoá nhận vào. */
export const OPENAI_API_KEY_MAX_LENGTH = 512

/**
 * Khoá OpenAI nhận vào: bắt đầu bằng `sk-`, chỉ ký tự ASCII in được (không khoảng trắng),
 * dài ≤512. Khoảng trắng hai đầu (khi dán) được bỏ.
 */
export const OpenAiApiKey = z
  .string()
  .trim()
  .max(OPENAI_API_KEY_MAX_LENGTH)
  .regex(/^sk-[\x21-\x7e]+$/, 'phải bắt đầu bằng sk- và không chứa khoảng trắng')

/** `PUT /api/v1/settings/openai/key` → `OpenAiKeyInfo`. */
export const SaveOpenAiKeyRequest = z.object({ apiKey: OpenAiApiKey }).strict()
export type SaveOpenAiKeyRequest = z.infer<typeof SaveOpenAiKeyRequest>

export const AI_MODEL_KINDS = ['text', 'image'] as const
export const AiModelKind = z.enum(AI_MODEL_KINDS)
export type AiModelKind = z.infer<typeof AiModelKind>

export const AiModelOption = z.object({
  model: z.string().min(1),
  label: z.string(),
})
export type AiModelOption = z.infer<typeof AiModelOption>

/** Kích thước ảnh sinh ra (rộng x cao). */
export const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const
export const ImageSize = z.enum(IMAGE_SIZES)
export type ImageSize = z.infer<typeof ImageSize>

/** Mặc định [ASSUMPTION]: 26.000 VND/USD, hạn mức 1.000.000 đ/tháng, ảnh vuông. */
export const DEFAULT_EXCHANGE_RATE_VND = 26_000
export const DEFAULT_MONTHLY_LIMIT_VND = 1_000_000
export const DEFAULT_IMAGE_SIZE: ImageSize = '1024x1024'
/** Cảnh báo khi chi phí tháng đạt 80% hạn mức — mặc định bật. */
export const DEFAULT_WARN_80 = true

export const EXCHANGE_RATE_VND_MAX = 1_000_000
export const MONTHLY_LIMIT_VND_MAX = 1_000_000_000_000

const ModelId = z.string().trim().min(1).max(100)

/** Một lựa chọn OpenAI đầy đủ (dạng từng trường; dùng lại cho kiểm từng khoá khi đọc giá trị đã lưu). */
export const OpenAiPreferenceFields = z
  .object({
    textModel: ModelId,
    imageModel: ModelId,
    imageSize: ImageSize,
    exchangeRateVnd: z.number().int().positive().max(EXCHANGE_RATE_VND_MAX),
    monthlyLimitVnd: z.number().int().positive().max(MONTHLY_LIMIT_VND_MAX),
    warn80: z.boolean(),
  })
  .strict()

/**
 * `PUT /api/v1/settings/openai` — chỉ gửi các khoá muốn đổi (khoá thiếu giữ giá trị đang lưu; khoá lạ bị
 * từ chối). Model phải có trong `ai_model_prices` đúng loại và đang bật.
 */
export const UpdateOpenAiSettingsRequest = OpenAiPreferenceFields.partial()
export type UpdateOpenAiSettingsRequest = z.infer<typeof UpdateOpenAiSettingsRequest>

/** `GET /api/v1/settings/openai` (và phản hồi của `PUT /api/v1/settings/openai`). */
export const OpenAiSettingsResponse = z.object({
  key: OpenAiKeyInfo,
  /** Model đang dùng; `null` chỉ khi bảng model không có model nào đang bật cho loại đó. */
  textModel: z.string().nullable(),
  imageModel: z.string().nullable(),
  imageSize: ImageSize,
  exchangeRateVnd: z.number().int().positive(),
  monthlyLimitVnd: z.number().int().positive(),
  warn80: z.boolean(),
  models: z.object({
    text: z.array(AiModelOption),
    image: z.array(AiModelOption),
  }),
})
export type OpenAiSettingsResponse = z.infer<typeof OpenAiSettingsResponse>
