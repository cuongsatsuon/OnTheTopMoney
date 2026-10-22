// npm run dev (ở gốc) — chạy song song: db nhúng (nếu chưa có DATABASE_URL), web (Vite), api, worker.
// api và worker chờ DB rồi chạy migration (khoá advisory) trước khi khởi động.
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import concurrently, { type ConcurrentlyCommandInput } from 'concurrently'
import { DEV_DB_URL as EMBEDDED_URL } from './lib/embedded-pg.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const serverDir = fileURLToPath(new URL('..', import.meta.url))

const envFile = `${serverDir}/.env`
const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}
const configuredUrl = process.env.DATABASE_URL || fileEnv.DATABASE_URL
const useEmbedded = !configuredUrl

/**
 * Khoá chủ mã hoá bí mật cho dev (AD-12) khi chưa đặt `APP_ENCRYPTION_KEYS` ở shell hay server/.env:
 * sinh một lần (32 byte ngẫu nhiên) vào `.data/dev-encryption-key` (gitignored, quyền 600) rồi tái dùng,
 * để khoá OpenAI đã lưu vẫn giải mã được sau khi khởi động lại.
 * File hỏng → đổi tên thành `dev-encryption-key.bak-<thời điểm>` (giữ lại để cứu) rồi sinh khoá mới
 * (khoá OpenAI đã lưu phải nhập lại). Không đọc được file (quyền…) → báo rõ và thoát 1, không ghi đè.
 */
const DEV_KEY_ID = 'dev'
function devEncryptionEnv(): Record<string, string> {
  if (process.env.APP_ENCRYPTION_KEYS || fileEnv.APP_ENCRYPTION_KEYS) return {}
  const dir = `${root}/.data`
  const file = `${dir}/dev-encryption-key`
  let key = ''
  if (existsSync(file)) {
    try {
      key = readFileSync(file, 'utf8').trim()
    } catch (err) {
      console.error(
        `Không đọc được ${file} (${(err as NodeJS.ErrnoException).code ?? 'lỗi'}). Sửa quyền file (chmod 600) rồi chạy lại; ` +
          'không tự ghi đè để không mất khoá OpenAI đã lưu.',
      )
      process.exit(1)
    }
  }
  const decoded = Buffer.from(key, 'base64')
  // Cùng điều kiện với platform/config: base64 chuẩn của đúng 32 byte.
  if (decoded.length === 32 && decoded.toString('base64') === key) {
    return { APP_ENCRYPTION_KEYS: `${DEV_KEY_ID}:${key}`, APP_ENCRYPTION_ACTIVE_KEY: DEV_KEY_ID }
  }
  if (existsSync(file)) {
    const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    renameSync(file, backup)
    console.warn(`${file} hỏng → đã chuyển sang ${backup} và sinh khoá dev mới (khoá OpenAI đã lưu phải nhập lại).`)
  }
  key = randomBytes(32).toString('base64')
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, `${key}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  console.log(`Đã sinh khoá mã hoá dev: ${file}`)
  return { APP_ENCRYPTION_KEYS: `${DEV_KEY_ID}:${key}`, APP_ENCRYPTION_ACTIVE_KEY: DEV_KEY_ID }
}

const childEnv: Record<string, string> = { ...(useEmbedded ? { DATABASE_URL: EMBEDDED_URL } : {}), ...devEncryptionEnv() }
// Cổng api lấy từ server/.env, không lấy PORT kế thừa của shell: công cụ chạy preview thường đặt
// PORT cho web (5173), nếu api đọc theo thì hai tiến trình tranh cổng và proxy Vite không tới được api.
const apiPort = fileEnv.PORT || '3000'
const apiEnv: Record<string, string> = { ...childEnv, PORT: apiPort }

const commands: ConcurrentlyCommandInput[] = [
  ...(useEmbedded ? [{ name: 'db', command: 'npm run db:dev', cwd: serverDir, prefixColor: 'gray' }] : []),
  {
    name: 'web',
    command: 'npm run dev',
    cwd: `${root}/web`,
    env: { API_TARGET: `http://localhost:${apiPort}` },
    prefixColor: 'cyan',
  },
  {
    name: 'api',
    command: 'npm run db:migrate -- --wait && npm run dev:api',
    cwd: serverDir,
    env: apiEnv,
    prefixColor: 'green',
  },
  {
    name: 'worker',
    command: 'npm run db:migrate -- --wait && npm run dev:worker',
    cwd: serverDir,
    env: childEnv,
    prefixColor: 'magenta',
  },
]

console.log(useEmbedded ? `DATABASE_URL chưa đặt → dùng Postgres nhúng ${EMBEDDED_URL}` : 'Dùng DATABASE_URL đã cấu hình')

const { result } = concurrently(commands, { killOthersOn: ['failure'], prefix: 'name' })
result.then(
  () => process.exit(0),
  () => process.exit(1),
)
