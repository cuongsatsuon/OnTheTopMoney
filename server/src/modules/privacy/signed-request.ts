// `signed_request` của Meta (Story 9.1, AD-22): callback gỡ app / xin xoá dữ liệu gửi `<chữ ký>.<payload>`, cả hai là
// base64url. Chữ ký = HMAC-SHA256 trên CHUỖI payload đã mã hoá (không phải JSON đã giải), khoá là app secret.
// - Kiểm chữ ký trước, so sánh constant-time (`timingSafeEqual`, kiểm độ dài trước — độ dài không phải bí mật);
//   chỉ khi đúng mới giải payload. Giống `verifyWebhookSignature` (adapters/meta) nhưng đặt ở đây: `privacy` không
//   được import `adapters/meta` (AD-6 — cổng gọi Meta), mà việc này chỉ là kiểm chữ ký, không gọi Meta.
// - Payload phải có `algorithm` = `HMAC-SHA256` và `user_id` (id theo app, dạng số). Không log giá trị nào (AD-12).
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNED_REQUEST_ALGORITHM = 'HMAC-SHA256'
/** base64url (cho phép `=` đệm cuối — vài thư viện của Meta vẫn gửi). */
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/
/** `user_id` của Meta là chuỗi số; giới hạn độ dài để không nhận rác. */
const USER_ID = /^\d{1,32}$/

export type SignedRequestFailure = 'not_configured' | 'missing' | 'malformed' | 'bad_signature' | 'bad_algorithm' | 'no_user'

export type SignedRequestResult =
  | { ok: true; userId: string; issuedAt: number | null }
  | { ok: false; reason: SignedRequestFailure }

/** Kiểm + giải `signed_request`. Mọi lỗi trả `ok:false` kèm lý do (để log), không ném. */
export function verifySignedRequest(signedRequest: unknown, appSecret: string | undefined): SignedRequestResult {
  if (!appSecret) return { ok: false, reason: 'not_configured' }
  if (typeof signedRequest !== 'string' || signedRequest.length === 0) return { ok: false, reason: 'missing' }
  const parts = signedRequest.split('.')
  if (parts.length !== 2) return { ok: false, reason: 'malformed' }
  const [sigPart, payloadPart] = parts as [string, string]
  if (!B64URL.test(sigPart) || !B64URL.test(payloadPart)) return { ok: false, reason: 'malformed' }

  const expected = createHmac('sha256', appSecret).update(payloadPart).digest()
  const given = Buffer.from(sigPart, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof payload !== 'object' || payload === null) return { ok: false, reason: 'malformed' }
  const p = payload as { algorithm?: unknown; user_id?: unknown; issued_at?: unknown }
  if (typeof p.algorithm !== 'string' || p.algorithm.toUpperCase() !== SIGNED_REQUEST_ALGORITHM) {
    return { ok: false, reason: 'bad_algorithm' }
  }
  const userId = typeof p.user_id === 'number' && Number.isSafeInteger(p.user_id) ? String(p.user_id) : p.user_id
  if (typeof userId !== 'string' || !USER_ID.test(userId)) return { ok: false, reason: 'no_user' }
  const issuedAt = typeof p.issued_at === 'number' && Number.isFinite(p.issued_at) ? p.issued_at : null
  return { ok: true, userId, issuedAt }
}

/** Dựng `signed_request` hợp lệ — cho test và script thử cục bộ (không dùng ở đường chạy thật). */
export function signRequestForTest(payload: Record<string, unknown>, appSecret: string): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sigPart = createHmac('sha256', appSecret).update(payloadPart).digest('base64url')
  return `${sigPart}.${payloadPart}`
}
