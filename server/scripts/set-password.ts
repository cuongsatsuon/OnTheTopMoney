// npm run set-password -w server — đặt mật khẩu chủ sở hữu (AD-19). Không có cách tạo tài khoản qua web.
// Nhập ẩn hai lần, tối thiểu 12 ký tự; lưu hash argon2id và xoá mọi phiên cũ.
// Không có DATABASE_URL (dev) → dùng Postgres nhúng của `npm run dev` / `npm run db:dev`.
import { OWNER_PASSWORD_MAX_LENGTH, OWNER_PASSWORD_MIN_LENGTH } from '@ottm/shared'
import { getConfig } from '../src/platform/config/index.ts'
import { createDb } from '../src/platform/db/index.ts'
import { runMigrations } from '../src/platform/db/migrate.ts'
import { normalizePassword, setOwnerPassword } from '../src/modules/settings/index.ts'
import { closePrompt, promptHidden } from './lib/prompt.ts'

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  closePrompt()
  process.exit(1)
}

if (!process.env.DATABASE_URL && process.env.NODE_ENV !== 'production') {
  // Import động: `embedded-postgres` là devDependency, không có trong image production.
  process.env.DATABASE_URL = (await import('./lib/embedded-pg.ts')).DEV_DB_URL
}
const { DATABASE_URL } = getConfig()

let password: string
let confirm: string
try {
  // NFC: terminal có thể gửi dấu tiếng Việt dạng NFD, trình duyệt gửi NFC.
  password = normalizePassword(await promptHidden('Mật khẩu mới: '))
  confirm = normalizePassword(await promptHidden('Nhập lại mật khẩu: '))
} catch (err) {
  fail(`Không đọc được mật khẩu: ${(err as Error).message}`)
}
closePrompt()

if (password !== confirm) fail('Hai lần nhập không khớp. Chưa đổi gì.')
if ([...password].length < OWNER_PASSWORD_MIN_LENGTH) {
  fail(`Mật khẩu cần ít nhất ${OWNER_PASSWORD_MIN_LENGTH} ký tự. Chưa đổi gì.`)
}
// Cùng đơn vị với `LoginRequest` (string.length) — dài hơn thì không bao giờ đăng nhập được.
if (password.length > OWNER_PASSWORD_MAX_LENGTH) {
  fail(`Mật khẩu dài tối đa ${OWNER_PASSWORD_MAX_LENGTH} ký tự. Chưa đổi gì.`)
}

const handle = createDb(DATABASE_URL, { max: 1, connectTimeoutSeconds: 5, applicationName: 'ottm-set-password' })
try {
  await runMigrations(DATABASE_URL)
  await setOwnerPassword(handle.db, password)
} catch (err) {
  await handle.close().catch(() => {})
  // Không in lỗi thô (có thể chứa URL DB kèm mật khẩu Postgres).
  fail(`Không lưu được mật khẩu: ${(err as { code?: string }).code ?? (err as Error).name}. Postgres đã chạy chưa (npm run dev)?`)
}
await handle.close()
console.log('Đã đặt mật khẩu. Mọi phiên đăng nhập cũ đã bị đăng xuất.')
