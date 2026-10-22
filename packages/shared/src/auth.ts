// Hợp đồng đăng nhập chủ sở hữu (AD-19). Không có tạo tài khoản qua web — mật khẩu đặt bằng CLI.
import { z } from 'zod'

/** Độ dài tối thiểu khi đặt mật khẩu bằng CLI [ASSUMPTION: 12 ký tự]. */
export const OWNER_PASSWORD_MIN_LENGTH = 12
/** Độ dài tối đa (đơn vị UTF-16 như `string.length`, sau chuẩn hoá NFC) — trùng giới hạn của `LoginRequest`. */
export const OWNER_PASSWORD_MAX_LENGTH = 1024

/** `POST /api/v1/auth/login`. Không kiểm độ dài khi đăng nhập để không lộ chính sách qua lỗi. */
export const LoginRequest = z.object({
  password: z.string().min(1).max(OWNER_PASSWORD_MAX_LENGTH),
})
export type LoginRequest = z.infer<typeof LoginRequest>

/** `GET /api/v1/auth/me` khi có phiên. Không có phiên → 401 `UNAUTHENTICATED`. */
export const MeResponse = z.object({
  authenticated: z.literal(true),
})
export type MeResponse = z.infer<typeof MeResponse>
