// Phần lõi của `npm run media:check` (tách ra để test chạy được với Cloudinary giả).
// Thử trọn vòng: upload ảnh công khai (đổi sang JPEG như cho IG) → tải lại bằng URL công khai; upload file riêng tư
// (raw + ảnh) → tải lại qua API có chữ ký, so bytes → URL giao thường (không chữ ký) phải KHÔNG tải được → xoá hết.
import type { MediaFailure, MediaStores, PrivateFileRef } from '../../src/adapters/media/index.ts'

/** PNG 2×2 hợp lệ (màu cam). */
export const SAMPLE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a73000000104944415478da63f8dfc000440c100a00' +
    '2dee05fd633ec10b0000000049454e44ae426082',
  'hex',
)

export const DELIVERY_BASE_URL = 'https://res.cloudinary.com'

export interface MediaCheckDeps {
  stores: MediaStores
  cloudName: string
  fetch?: typeof fetch
  log: (line: string) => void
  /** Gốc URL giao file (test trỏ về fake). */
  deliveryBaseUrl?: string
}

const describe = (f: MediaFailure) => `${f.kind}${f.status ? ` (HTTP ${f.status})` : ''}`

const HINTS: Partial<Record<MediaFailure['kind'], string>> = {
  MEDIA_NOT_CONFIGURED: 'chưa đặt CLOUDINARY_URL (server/.env khi dev, deploy/.env khi production).',
  AUTH_FAILED: 'Cloudinary từ chối khoá — kiểm lại CLOUDINARY_URL (api_key, api_secret, cloud_name) ở Console › API Keys.',
  RATE_LIMITED: 'Cloudinary đang giới hạn tần suất — thử lại sau ít phút.',
  TRANSIENT: 'lỗi mạng/tạm thời của Cloudinary — thử lại; nếu lặp lại, kiểm máy chủ ra được https://api.cloudinary.com.',
  INVALID_REQUEST: 'Cloudinary từ chối file thử — kiểm cài đặt bảo mật của tài khoản (Settings › Security).',
}

/** Trả `true` khi mọi bước đạt. Không in secret (adapter không trả secret, script không đọc CLOUDINARY_URL). */
export async function runMediaCheck(deps: MediaCheckDeps): Promise<boolean> {
  const { stores, log } = deps
  const doFetch = deps.fetch ?? fetch
  const deliveryBase = `${(deps.deliveryBaseUrl ?? DELIVERY_BASE_URL).replace(/\/+$/, '')}/${deps.cloudName}`
  let ok = true
  const pass = (msg: string) => log(`ok   - ${msg}`)
  const fail = (msg: string, f?: MediaFailure) => {
    ok = false
    log(`LỖI - ${msg}${f ? `: ${describe(f)}` : ''}`)
    const hint = f && HINTS[f.kind]
    if (hint) log(`       ${hint}`)
  }
  const cleanup: (() => Promise<void>)[] = []
  /** Xoá, rồi xoá lần nữa: lần hai (đã không còn) vẫn phải ok — xoá idempotent. */
  const removeTwice = async (label: string, remove: () => Promise<{ ok: true } | MediaFailure>) => {
    const first = await remove()
    if (!first.ok) return fail(`xoá ${label}`, first)
    const again = await remove()
    if (again.ok) pass(`xoá ${label} (xoá lần hai vẫn ok)`)
    else fail(`xoá lần hai ${label}`, again)
  }

  if (!stores.configured) {
    fail('Cloudinary chưa cấu hình', { ok: false, kind: 'MEDIA_NOT_CONFIGURED' })
    return false
  }

  try {
    // 1. Ảnh công khai (PNG → JPEG như ảnh cho Instagram) → URL công khai tải được.
    const pub = await stores.publicStore.put({ data: SAMPLE_PNG, mime: 'image/png', asJpeg: true })
    if (!pub.ok) {
      fail('upload ảnh công khai', pub)
      return false
    }
    cleanup.push(() => removeTwice(`ảnh công khai ${pub.publicId}`, () => stores.publicStore.delete(pub.publicId)))
    pass(`upload ảnh công khai: ${pub.url} (${pub.width}×${pub.height}, ${pub.bytes} byte, ${pub.format})`)
    if (pub.format === 'jpg') pass('ảnh đã đổi sang JPEG (asJpeg)')
    else fail(`ảnh chưa đổi sang JPEG (format ${pub.format})`)
    const pubStatus = await statusOf(doFetch, pub.url)
    if (pubStatus === 200) pass('URL công khai tải được (HTTP 200)')
    else fail(`URL công khai không tải được (${pubStatus ?? 'lỗi mạng'})`)

    // 2. File riêng tư: raw (txt) và ảnh → tải lại qua API có chữ ký, bytes giống hệt.
    const text = Buffer.from(`ottm media:check ${new Date().toISOString()}\n`)
    const samples = [
      { label: 'file riêng tư (txt)', data: text, mime: 'text/plain' as const },
      { label: 'ảnh riêng tư (png)', data: SAMPLE_PNG, mime: 'image/png' as const },
    ]
    for (const sample of samples) {
      const put = await stores.privateStore.put({ data: sample.data, mime: sample.mime })
      if (!put.ok) {
        fail(`upload ${sample.label}`, put)
        continue
      }
      const ref: PrivateFileRef = { publicId: put.publicId, resourceType: put.resourceType, format: put.format }
      cleanup.push(() => removeTwice(`${sample.label} ${ref.publicId}`, () => stores.privateStore.delete(ref)))
      pass(`upload ${sample.label}: ${ref.publicId} (${ref.resourceType})`)

      const got = await stores.privateStore.get(ref)
      if (!got.ok) fail(`tải lại ${sample.label} qua API có chữ ký`, got)
      else if (Buffer.compare(got.data, sample.data) !== 0) {
        fail(`tải lại ${sample.label}: bytes khác bản gốc (${got.data.length} / ${sample.data.length} byte)`)
      } else pass(`tải lại ${sample.label} qua API có chữ ký (${got.data.length} byte)`)

      // URL giao thường, không chữ ký: phải bị chặn (401/404).
      const ext = ref.format ? `.${ref.format}` : ''
      for (const type of ['authenticated', 'upload']) {
        const url = `${deliveryBase}/${ref.resourceType}/${type}/${ref.publicId}${ext}`
        const status = await statusOf(doFetch, url)
        // Chỉ 401/403/404 là "bị chặn". 2xx = lộ; 3xx (chuyển hướng tới nơi có thể tải được) hay mã khác = không chứng
        // minh được là chặn → cũng báo lỗi.
        if (status === undefined) fail(`không kiểm được ${url} (lỗi mạng)`)
        else if (status >= 200 && status < 300) fail(`${sample.label} TẢI ĐƯỢC bằng URL thường ${url} (HTTP ${status}) — file riêng tư bị lộ`)
        else if (status !== 401 && status !== 403 && status !== 404) {
          fail(`${sample.label}: URL thường ${url} trả HTTP ${status} — không phải 401/403/404, chưa chắc file riêng tư bị chặn`)
        } else pass(`${sample.label} không tải được bằng URL thường .../${type}/... (HTTP ${status})`)
      }
    }
  } finally {
    // 3. Dọn: xoá mọi thứ đã tạo (kể cả khi bước giữa lỗi), mỗi thứ xoá hai lần để kiểm idempotent.
    for (const step of cleanup.reverse()) await step()
  }
  return ok
}

async function statusOf(doFetch: typeof fetch, url: string): Promise<number | undefined> {
  try {
    const res = await doFetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    await res.body?.cancel().catch(() => {})
    return res.status
  } catch {
    return undefined
  }
}
