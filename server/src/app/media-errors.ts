// Ánh xạ lỗi adapter media (AD-14) → `AppError` cho route tải ảnh/file lên (logo Story 3.1, kho kiến thức Story 5.2).
// Một bảng cho mọi route: web đổi `code` thành câu tiếng Việt ở `error-messages.ts`; `INVALID_REQUEST` thành lỗi dưới
// đúng ô. Không mang thông báo gốc của Cloudinary (có thể chứa chuỗi đã ký — AD-12).
import type { ErrorCode } from '@ottm/shared'
import type { MediaErrorKind } from '../adapters/media/index.ts'
import { AppError } from '../platform/errors/index.ts'

export interface MediaErrorOptions {
  /** Ô báo lỗi khi Cloudinary từ chối file (`details[].path`). */
  field: string
  /** Câu dưới ô khi file bị từ chối (hỏng, quá lớn với Cloudinary). */
  invalidMessage: string
  /** Mã khi kho lỗi (sai khoá, 5xx, mạng): `IMAGE_FAILED` cho ảnh, `UPLOAD_FAILED` cho file. */
  failCode: Extract<ErrorCode, 'IMAGE_FAILED' | 'UPLOAD_FAILED'>
}

/**
 * - `MEDIA_NOT_CONFIGURED` → 500 (convention "chưa cấu hình" như META/ENCRYPTION_NOT_CONFIGURED).
 * - `INVALID_REQUEST` → 400 `VALIDATION_FAILED` dưới ô `field`.
 * - `RATE_LIMITED` → 429.
 * - `AUTH_FAILED` / `NOT_FOUND` / `TRANSIENT` → 502 `failCode` (lỗi phía kho, thử lại sau).
 */
export function mediaAppError(kind: MediaErrorKind, opts: MediaErrorOptions): AppError {
  switch (kind) {
    case 'MEDIA_NOT_CONFIGURED':
      return new AppError('MEDIA_NOT_CONFIGURED', 500, { message: 'CLOUDINARY_URL chưa đặt' })
    case 'INVALID_REQUEST':
      return new AppError('VALIDATION_FAILED', 400, { details: [{ path: [opts.field], message: opts.invalidMessage }] })
    case 'RATE_LIMITED':
      return new AppError('RATE_LIMITED', 429, { message: 'Cloudinary giới hạn tần suất' })
    default:
      return new AppError(opts.failCode, 502, { message: `Kho Cloudinary lỗi (${kind})` })
  }
}
