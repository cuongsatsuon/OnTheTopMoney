// npm run media:check -w server — kiểm cấu hình Cloudinary (AD-14) bằng một vòng thật: upload ảnh công khai + file
// riêng tư, tải lại, kiểm file riêng tư không tải được bằng URL thường, rồi xoá. Đọc CLOUDINARY_URL /
// CLOUDINARY_FOLDER từ server/.env (dev) hoặc env của container (production:
// `docker compose exec api npm run media:check`). Không cần DATABASE_URL. Exit 0 = đạt, 1 = có lỗi.
import { createMediaStores } from '../src/adapters/media/index.ts'
import { ConfigError, parseMediaEnv } from '../src/platform/config/index.ts'
import { runMediaCheck } from './lib/media-check.ts'

const log = (line: string) => process.stdout.write(`${line}\n`)

let env
try {
  env = parseMediaEnv(process.env)
} catch (err) {
  // ConfigError chỉ nêu tên biến + dạng mong đợi, không chép giá trị.
  process.stderr.write(`${err instanceof ConfigError ? err.message : 'Không đọc được cấu hình media'}\n`)
  process.exit(1)
}

if (!env.CLOUDINARY_URL) {
  log('LỖI - chưa đặt CLOUDINARY_URL (dạng cloudinary://<api_key>:<api_secret>@<cloud_name>, lấy ở Cloudinary Console › API Keys).')
  process.exit(1)
}

log(`Cloudinary: cloud ${env.CLOUDINARY_URL.cloudName}, thư mục ${env.CLOUDINARY_FOLDER}`)
const ok = await runMediaCheck({ stores: createMediaStores(env), cloudName: env.CLOUDINARY_URL.cloudName, log })
log(ok ? 'media:check: tất cả ok' : 'media:check: có lỗi (xem các dòng LỖI ở trên)')
process.exit(ok ? 0 : 1)
