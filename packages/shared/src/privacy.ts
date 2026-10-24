// Quyền riêng tư (Story 9.1, AD-22, AD-19): trang công khai `/privacy/*` nằm trên host api (`PUBLIC_BASE_URL`) ở cả
// hai chế độ deploy — chế độ tách (web trên Hostinger) thì host web KHÔNG phục vụ các đường này. Web dựng link bằng
// origin api (`apiPublicUrl` ở web/src/lib/api.ts), không dùng đường tương đối.
import { z } from 'zod'

/** Đường công khai ngoài `/api/v1` (không cần phiên). */
export const PRIVACY_PATHS = {
  policy: '/privacy/policy',
  /** Meta gọi khi người dùng gỡ app (Facebook Login › Deauthorize callback URL). */
  deauthorize: '/privacy/meta/deauthorize',
  /** Meta gọi khi người dùng xin xoá dữ liệu (Data deletion callback URL). */
  dataDeletion: '/privacy/meta/data-deletion',
  /** Tiền tố trang trạng thái: `/privacy/status/<code>`. */
  status: '/privacy/status',
} as const

/** Phản hồi data-deletion đúng dạng Meta yêu cầu (snake_case là của Meta). */
export const MetaDataDeletionResponse = z.object({
  url: z.url(),
  confirmation_code: z.string().min(1),
})
export type MetaDataDeletionResponse = z.infer<typeof MetaDataDeletionResponse>

/** `GET /api/v1/privacy/config` — URL tuyệt đối để chủ shop dán vào Meta App (Cài đặt › Tài khoản Meta). */
export const PrivacyConfigResponse = z.object({
  policyUrl: z.url(),
  deauthorizeUrl: z.url(),
  dataDeletionUrl: z.url(),
  /** Đã đặt tên đơn vị vận hành + email liên hệ (`PRIVACY_CONTROLLER_NAME`, `PRIVACY_CONTACT_EMAIL`) cho trang chính sách. */
  operatorConfigured: z.boolean(),
  /** Có `META_APP_SECRET` — thiếu thì callback không verify được chữ ký (luôn 400). */
  metaSecretConfigured: z.boolean(),
})
export type PrivacyConfigResponse = z.infer<typeof PrivacyConfigResponse>
