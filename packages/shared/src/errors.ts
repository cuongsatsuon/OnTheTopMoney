// Hợp đồng lỗi API (AD-18): HTTP status + `{error: {code, message, details?}}`.
// `code` thuộc `ErrorCode`; `message` chỉ cho dev, FE ánh xạ `code` → microcopy ở một chỗ.
import { z } from 'zod'

export const ERROR_CODES = [
  // Chung
  'INTERNAL',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  /** Chỉ web dùng: fetch không tới được server (server không bao giờ trả mã này). */
  'NETWORK_ERROR',
  // Đăng nhập (AD-19)
  'INVALID_CREDENTIALS',
  // Kết nối Meta / OAuth (AD-5, AD-23)
  'PAGE_DISCONNECTED',
  'PAGE_REMOVED',
  'PERMISSION_DENIED',
  'PERMISSIONS_MISSING',
  'IG_NOT_BUSINESS',
  'OAUTH_CANCELLED',
  /** `state` OAuth lạ, hết hạn hoặc không thuộc phiên đăng nhập hiện tại. */
  'OAUTH_STATE_INVALID',
  /** Meta không hoàn tất đăng nhập: code hết hạn / đã dùng, token của app khác hoặc không phải user token… */
  'OAUTH_FAILED',
  /** Máy chủ chưa cấu hình app Meta (`META_APP_ID`/`META_APP_SECRET`) và không bật Meta giả. */
  'META_NOT_CONFIGURED',
  // Gửi tin (AD-10)
  'OUTSIDE_24H',
  'PRIVATE_REPLY_USED',
  'PRIVATE_REPLY_INVALID',
  'RECIPIENT_UNAVAILABLE',
  'SEND_REJECTED',
  'SEND_FAILED',
  'SEND_UNKNOWN',
  // Đăng bài (AD-13)
  'MEDIA_REQUIRED',
  'CAPTION_TOO_LONG',
  'TOO_MANY_HASHTAGS',
  'PUBLISH_LIMIT_REACHED',
  'SCHEDULE_IN_PAST',
  'PUBLISH_REJECTED',
  'PUBLISH_FAILED',
  'PUBLISH_UNKNOWN',
  // Ảnh (AD-14)
  'IMAGE_REJECTED',
  'IMAGE_FAILED',
  /** Máy chủ chưa cấu hình kho ảnh/file Cloudinary (`CLOUDINARY_URL`). */
  'MEDIA_NOT_CONFIGURED',
  /** Kho file (Cloudinary) lỗi khi tải file lên (Story 5.2: file kho kiến thức). */
  'UPLOAD_FAILED',
  // AI (AD-7, AD-8, AD-16, AD-21)
  'OPENAI_KEY_MISSING',
  'OPENAI_KEY_INVALID',
  /** OpenAI 403: khoá thiếu quyền (vd models:read) hoặc bị chặn theo khu vực. */
  'OPENAI_KEY_RESTRICTED',
  /** Máy chủ chưa có khoá chủ mã hoá (`APP_ENCRYPTION_KEYS`) — không lưu/đọc được bí mật. */
  'ENCRYPTION_NOT_CONFIGURED',
  'AI_BUDGET_EXCEEDED',
  'AI_PROVIDER_ERROR',
  'AI_POLICY_BLOCKED',
  'CONFIG_MISSING',
  'KNOWLEDGE_TOO_LARGE',
] as const
export const ErrorCode = z.enum(ERROR_CODES)
export type ErrorCode = z.infer<typeof ErrorCode>

export const ErrorBody = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
})
export type ErrorBody = z.infer<typeof ErrorBody>

export const ErrorResponse = z.object({ error: ErrorBody })
export type ErrorResponse = z.infer<typeof ErrorResponse>
