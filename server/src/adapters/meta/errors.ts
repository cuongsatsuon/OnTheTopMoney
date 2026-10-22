// Bảng phân loại lỗi Meta (AD-6) — chỗ DUY NHẤT trong code biết mã số lỗi của Meta.
// Nguồn: review-verify-current.md mục D. Xét cặp `mã/subcode` trước, rồi mới tới mã chính.
// Lỗi trả về không bao giờ mang token hay URL (chỉ mã, subcode, fbtrace id).

export const META_ERROR_KINDS = [
  'TOKEN_INVALID',
  'RATE_LIMITED',
  'OUTSIDE_WINDOW',
  'RECIPIENT_UNAVAILABLE',
  'PERMISSION_DENIED',
  'TRANSIENT',
  'REJECTED',
  // Không đến từ Meta: caller tự huỷ (`AbortSignal`). Không retry, không log cảnh báo.
  'ABORTED',
] as const
export type MetaErrorKind = (typeof META_ERROR_KINDS)[number]

export interface MetaFailure {
  ok: false
  kind: MetaErrorKind
  /** `error.code` của Meta; không có khi lỗi mạng, hết giờ, hoặc bị chặn trước khi gửi. */
  code?: number
  /** `error.error_subcode` của Meta. */
  subcode?: number
  /** `error.fbtrace_id` — đưa cho Meta khi cần tra lỗi. */
  fbtraceId?: string
  /** HTTP status của phản hồi (nếu đã nhận được phản hồi). */
  status?: number
  /** Chỉ với `RATE_LIMITED`: chờ ít nhất chừng này mili giây rồi mới gọi lại. */
  retryAfterMs?: number
}

/** Cặp `mã/subcode` — xét TRƯỚC mã chính. */
const BY_SUBCODE: ReadonlyMap<string, MetaErrorKind> = new Map([
  // Gửi tin bị coi là quấy rầy: không retry tự động.
  ['613/2018338', 'REJECTED'],
  ['10/2018278', 'OUTSIDE_WINDOW'],
  ['10/2534022', 'OUTSIDE_WINDOW'],
  ['10/2018065', 'OUTSIDE_WINDOW'],
  ['551/1545041', 'RECIPIENT_UNAVAILABLE'],
  ['200/1545041', 'RECIPIENT_UNAVAILABLE'],
  ['10/2018108', 'RECIPIENT_UNAVAILABLE'],
  ['100/2018001', 'RECIPIENT_UNAVAILABLE'],
  // Bình luận không nhắn riêng được.
  ['100/2534025', 'REJECTED'],
])

const BY_CODE: ReadonlyMap<number, MetaErrorKind> = new Map([
  [190, 'TOKEN_INVALID'],
  // 102 = phiên API hỏng, 2500 = cần access token đang hoạt động.
  [102, 'TOKEN_INVALID'],
  [2500, 'TOKEN_INVALID'],
  [4, 'RATE_LIMITED'],
  [17, 'RATE_LIMITED'],
  [32, 'RATE_LIMITED'],
  [613, 'RATE_LIMITED'],
  [80001, 'RATE_LIMITED'],
  [80002, 'RATE_LIMITED'],
  [80006, 'RATE_LIMITED'],
  [341, 'RATE_LIMITED'],
  // Tạm khoá do vi phạm chính sách: không retry.
  [368, 'REJECTED'],
  [10, 'PERMISSION_DENIED'],
  [1, 'TRANSIENT'],
  [2, 'TRANSIENT'],
])

/** Mã giới hạn tần suất ở mức cả app (không riêng trang) → chặn cả app khi gặp. */
export const APP_LEVEL_RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 341])

const intOf = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isInteger(v)) return v
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return undefined
}

/** Phân loại theo mã (không cần body) — dùng chung cho `classifyMetaError` và test. */
export function kindOf(
  httpStatus: number,
  code: number | undefined,
  subcode: number | undefined,
  isTransient = false,
): MetaErrorKind {
  if (code !== undefined) {
    if (subcode !== undefined) {
      const bySub = BY_SUBCODE.get(`${code}/${subcode}`)
      if (bySub) return bySub
    }
    const byCode = BY_CODE.get(code)
    if (byCode) return byCode
    if (code >= 200 && code <= 299) return 'PERMISSION_DENIED'
  }
  // Mã lạ / không có mã: dựa vào HTTP status và cờ `is_transient` của Meta.
  if (httpStatus === 429) return 'RATE_LIMITED'
  if (isTransient || httpStatus >= 500) return 'TRANSIENT'
  return 'REJECTED'
}

/**
 * Phân loại phản hồi lỗi của Graph/Threads: `{error: {code, error_subcode, fbtrace_id, is_transient}}`.
 * Mã lạ hoặc body hỏng / thiếu `error` → 429 → `RATE_LIMITED`; `is_transient: true` hoặc 5xx → `TRANSIENT`;
 * còn lại `REJECTED`.
 * Không chép `error.message` (có thể chứa id người dùng hay nội dung).
 */
export function classifyMetaError(httpStatus: number, body: unknown): MetaFailure {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  const e = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
  const code = intOf(e.code)
  const subcode = intOf(e.error_subcode)
  const fbtraceId = typeof e.fbtrace_id === 'string' && e.fbtrace_id ? e.fbtrace_id : undefined
  const failure: MetaFailure = { ok: false, kind: kindOf(httpStatus, code, subcode, e.is_transient === true), status: httpStatus }
  if (code !== undefined) failure.code = code
  if (subcode !== undefined) failure.subcode = subcode
  if (fbtraceId !== undefined) failure.fbtraceId = fbtraceId
  return failure
}

/** Lỗi mạng / hết giờ / phản hồi không đọc được. */
export function transientFailure(status?: number): MetaFailure {
  return status === undefined ? { ok: false, kind: 'TRANSIENT' } : { ok: false, kind: 'TRANSIENT', status }
}

/** Caller tự huỷ lời gọi. */
export function abortedFailure(): MetaFailure {
  return { ok: false, kind: 'ABORTED' }
}

/** Lỗi retry được (job nền chỉ ném lại lỗi thuộc loại này — các loại khác ghi `failed` rồi kết thúc). */
export function isRetryable(kind: MetaErrorKind): boolean {
  return kind === 'RATE_LIMITED' || kind === 'TRANSIENT'
}
