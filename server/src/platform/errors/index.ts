// Lỗi miền (AD-18): ném `AppError(code, status, details?)`, error handler của api trả
// `{error:{code, message, details?}}` với đúng status. `message` chỉ cho dev.
import type { ErrorCode } from '@ottm/shared'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly statusCode: number
  readonly details?: unknown

  constructor(code: ErrorCode, statusCode: number, options: { message?: string; details?: unknown } = {}) {
    super(options.message ?? code)
    this.name = 'AppError'
    this.code = code
    this.statusCode = statusCode
    if (options.details !== undefined) this.details = options.details
  }
}
