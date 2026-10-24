// Quyền riêng tư (Story 9.1, AD-22, AD-19): trang công khai `/privacy/*` nằm trên host api (`PUBLIC_BASE_URL`) ở cả
// hai chế độ deploy — chế độ tách (web trên Hostinger) thì host web KHÔNG phục vụ các đường này. Web dựng link bằng
// origin api (`apiPublicUrl` ở web/src/lib/api.ts), không dùng đường tương đối.
import { z } from 'zod'
import { DeletionScope, DeletionStatus, type DeletionScope as DeletionScopeT } from './enums.ts'

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

// ---------------------------------------------------------------------------------------------------------
// Story 9.2 — luồng xoá hai giai đoạn (AD-22). `privacy` điều phối; mỗi module tự xoá bảng của mình rồi phát
// `privacy.purge_part_completed{module}`. Giai đoạn 1 = `PURGE_MODULES[scope]` (nghe `privacy.purge_requested`); khi đủ,
// `privacy` phát `privacy.purge_final_requested` cho `PURGE_FINAL_MODULE` (`inbox` — xoá sau cùng vì module khác cần dữ
// liệu của nó để tìm phần liên quan, vd `webhooks` tìm payload thô theo id nền tảng của khách).
// ---------------------------------------------------------------------------------------------------------

export const PURGE_MODULE_NAMES = ['autoreply', 'webhooks', 'ai', 'content', 'connections', 'inbox'] as const
export type PurgeModule = (typeof PURGE_MODULE_NAMES)[number]

/** Phần giai đoạn 1 theo phạm vi. `content` chỉ khi `page|all`; `connections` (xoá `meta_accounts`) chỉ khi `all`. */
export const PURGE_MODULES: Record<DeletionScopeT, readonly PurgeModule[]> = {
  contact: ['autoreply', 'webhooks', 'ai'],
  page: ['autoreply', 'webhooks', 'ai', 'content'],
  all: ['autoreply', 'webhooks', 'ai', 'content', 'connections'],
}
export const PURGE_FINAL_MODULE = 'inbox' satisfies PurgeModule

/** Tổng số phần của một yêu cầu (giai đoạn 1 + phần cuối). */
export const purgePartCount = (scope: DeletionScopeT): number => PURGE_MODULES[scope].length + 1

/** `POST /api/v1/contacts/:id/deletion` — xác nhận rõ ràng (web hỏi trước khi gửi), không có thì 400. */
export const ContactDeletionBody = z.object({ confirm: z.literal(true) })
export type ContactDeletionBody = z.input<typeof ContactDeletionBody>

/** Yêu cầu xoá vừa tạo (202) hoặc đã có (200) — `statusUrl` = trang trạng thái công khai trên host api. */
export const ContactDeletionResponse = z.object({
  requestId: z.string().min(1),
  code: z.string().min(1),
  scope: DeletionScope,
  status: DeletionStatus,
  statusUrl: z.url(),
})
export type ContactDeletionResponse = z.infer<typeof ContactDeletionResponse>
