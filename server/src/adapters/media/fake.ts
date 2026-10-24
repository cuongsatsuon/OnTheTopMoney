// Cloudinary giả cho test (AD-14): một `fetch` trong bộ nhớ, không gọi mạng. Adapter thật (`createMediaStores`) chạy
// nguyên vẹn trên nó — ký tham số, multipart, phân loại lỗi đều được kiểm.
// - API `https://api.cloudinary.com/v1_1/<cloud>/<resource_type>/{upload,destroy,download}`: kiểm `api_key` và chữ
//   ký như Cloudinary (sai → 401), lưu file, `format` đổi định dạng ảnh, ảnh hỏng → 400, `destroy` trả
//   `{result: 'ok' | 'not found'}`, `download` (chỉ file `authenticated`) trả bytes hoặc 404.
// - Giao file `https://res.cloudinary.com/<cloud>/<resource_type>/<type>/...`: `upload` công khai → 200; `authenticated`
//   chỉ trả khi URL có chữ ký giả của chính fake (`s--fakesig--`), không thì 401; không có → 404.
// - Admin API `GET …/<cloud>/resources/<resource_type>/<type>?prefix=&max_results=&next_cursor=` (Story 9.3): Basic auth
//   `api_key:api_secret` (sai → 401), lọc theo prefix, sắp theo public_id, phân trang bằng con trỏ; `created_at` lấy từ
//   `asset.createdAt` (test sửa trực tiếp để giả file cũ).
// - `failNext(...)`: lời gọi kế tiếp trả HTTP status đó, lỗi mạng, treo tới khi bị huỷ (hết giờ), hoặc 200 body hỏng.
import { CLOUDINARY_API_BASE_URL, signParams } from './index.ts'

export interface FakeCloudinaryAsset {
  publicId: string
  resourceType: string
  type: 'upload' | 'authenticated'
  /** `null` với file raw. */
  format: string | null
  data: Buffer
  width: number
  height: number
  version: number
  /** Lúc tải lên (Admin API trả `created_at`); test đổi để giả file cũ. */
  createdAt: Date
}

export interface FakeCloudinaryRequest {
  method: string
  /** URL không có query. */
  url: string
  /** Tham số form (upload/destroy) hoặc query (download), trừ `file`. */
  params: Record<string, string>
}

export type FakeFailure = number | 'network' | 'hang' | 'bad-json'

export interface FakeCloudinary {
  fetch: typeof fetch
  /** Khoá `<resource_type>/<type>/<public_id>`. */
  readonly assets: Map<string, FakeCloudinaryAsset>
  readonly requests: FakeCloudinaryRequest[]
  failNext(failure: FakeFailure): void
}

export interface FakeCloudinaryOptions {
  cloudName: string
  apiKey: string
  apiSecret: string
  apiBaseUrl?: string
  /** Đồng hồ cho `createdAt` của file mới. */
  now?: () => Date
}

export const FAKE_DELIVERY_BASE_URL = 'https://res.cloudinary.com'
const FAKE_SIGNATURE = 's--fakesig--'

/** PNG 2×2 hợp lệ (màu cam) — Cloudinary thật cũng nhận (dùng trong `npm run media:check`). */
export const FAKE_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a73000000104944415478da63f8dfc000440c100a00' +
    '2dee05fd633ec10b0000000049454e44ae426082',
  'hex',
)
/** JPEG tối giản (SOI + APP0 + EOI) — fake chỉ nhận dạng theo magic bytes. */
export const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])
/** Đầu file WebP (RIFF....WEBP). */
export const FAKE_WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(14)])

/** Định dạng ảnh theo magic bytes (như Cloudinary); không phải ảnh → `undefined`. */
function sniffImage(data: Buffer): { format: string; width: number; height: number } | undefined {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { format: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { format: 'jpg', width: 1, height: 1 }
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return { format: 'webp', width: 1, height: 1 }
  }
  return undefined
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const apiError = (status: number, message: string) => json(status, { error: { message } })

export function createFakeCloudinary(options: FakeCloudinaryOptions): FakeCloudinary {
  const apiPrefix = `${(options.apiBaseUrl ?? CLOUDINARY_API_BASE_URL).replace(/\/+$/, '')}/`
  const deliveryPrefix = `${FAKE_DELIVERY_BASE_URL}/${options.cloudName}/`
  const assets = new Map<string, FakeCloudinaryAsset>()
  const requests: FakeCloudinaryRequest[] = []
  const failures: FakeFailure[] = []
  let version = 1_700_000_000

  const keyOf = (resourceType: string, type: string, publicId: string) => `${resourceType}/${type}/${publicId}`

  function checkAuth(params: Record<string, string>): Response | undefined {
    if (params.api_key !== options.apiKey) return apiError(401, 'Unknown API key')
    const { signature, ...rest } = params
    if (!signature || signature !== signParams(rest, options.apiSecret)) return apiError(401, 'Invalid Signature')
    return undefined
  }

  /** Admin API liệt kê: con trỏ = public_id cuối của trang trước (Cloudinary thật dùng chuỗi mờ). */
  function handleList(resourceType: string, type: string, params: Record<string, string>, authorization: string | null): Response {
    const expected = `Basic ${Buffer.from(`${options.apiKey}:${options.apiSecret}`).toString('base64')}`
    if (authorization !== expected) return apiError(401, 'Invalid credentials')
    if (resourceType !== 'image' && resourceType !== 'raw') return apiError(400, 'Invalid resource type')
    if (type !== 'upload' && type !== 'authenticated') return apiError(400, 'Invalid type')
    const prefix = params.prefix ?? ''
    const max = Math.min(Number(params.max_results ?? 10) || 10, 500)
    const after = params.next_cursor ? Buffer.from(params.next_cursor, 'base64url').toString('utf8') : null
    if (params.next_cursor && !after) return apiError(400, 'Invalid next_cursor')
    const all = [...assets.values()]
      .filter((a) => a.resourceType === resourceType && a.type === type && a.publicId.startsWith(prefix) && (after === null || a.publicId > after))
      .sort((a, b) => (a.publicId < b.publicId ? -1 : 1))
    const page = all.slice(0, max)
    return json(200, {
      resources: page.map((a) => ({
        public_id: a.publicId,
        resource_type: a.resourceType,
        type: a.type,
        format: a.format,
        version: a.version,
        bytes: a.data.length,
        created_at: a.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      })),
      ...(all.length > max ? { next_cursor: Buffer.from(page[page.length - 1]!.publicId).toString('base64url') } : {}),
    })
  }

  async function handleApi(method: string, path: string, params: Record<string, string>, file: Blob | undefined): Promise<Response> {
    const [cloud, resourceType, action, ...extra] = path.split('/')
    if (cloud !== options.cloudName || extra.length > 0) return apiError(401, 'Invalid cloud_name')
    if (resourceType !== 'image' && resourceType !== 'raw') return apiError(400, 'Invalid resource type')
    const denied = checkAuth(params)
    if (denied) return denied
    const type = params.type === 'authenticated' ? 'authenticated' : params.type === undefined || params.type === 'upload' ? 'upload' : undefined
    if (!type) return apiError(400, 'Invalid type')

    if (method === 'POST' && action === 'upload') {
      if (!file || !params.public_id) return apiError(400, 'Missing required parameter')
      const data = Buffer.from(await file.arrayBuffer())
      let format: string | null = null
      let width = 0
      let height = 0
      if (resourceType === 'image') {
        const sniffed = sniffImage(data)
        if (!sniffed) return apiError(400, 'Invalid image file')
        format = params.format || sniffed.format
        width = sniffed.width
        height = sniffed.height
      }
      version += 1
      const asset: FakeCloudinaryAsset = { publicId: params.public_id, resourceType, type, format, data, width, height, version, createdAt: options.now?.() ?? new Date() }
      assets.set(keyOf(resourceType, type, asset.publicId), asset)
      const ext = format ? `.${format}` : ''
      const sig = type === 'authenticated' ? `${FAKE_SIGNATURE}/` : ''
      const url = `${deliveryPrefix}${resourceType}/${type}/${sig}v${version}/${asset.publicId}${ext}`
      return json(200, {
        public_id: asset.publicId,
        version,
        resource_type: resourceType,
        type,
        bytes: data.length,
        ...(format ? { format, width, height } : {}),
        url: url.replace('https://', 'http://'),
        secure_url: url,
      })
    }
    if (method === 'POST' && action === 'destroy') {
      const removed = assets.delete(keyOf(resourceType, type, params.public_id ?? ''))
      return json(200, { result: removed ? 'ok' : 'not found' })
    }
    if (method === 'GET' && action === 'download') {
      const asset = assets.get(keyOf(resourceType, type, params.public_id ?? ''))
      if (!asset || (params.format && asset.format !== params.format)) return apiError(404, 'Resource not found')
      return new Response(new Uint8Array(asset.data), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }
    return apiError(404, 'Not found')
  }

  /** `<resource_type>/<type>/[s--sig--/][v<version>/]<public_id>[.<format>]`. */
  function handleDelivery(path: string): Response {
    const [resourceType = '', type = '', ...rest] = path.split('/')
    let signedOk = false
    if (rest[0]?.startsWith('s--')) signedOk = rest.shift() === FAKE_SIGNATURE
    if (rest[0] && /^v\d+$/.test(rest[0])) rest.shift()
    const tail = rest.join('/')
    const candidates = [tail, tail.replace(/\.[A-Za-z0-9]+$/, '')]
    const asset = candidates.map((id) => assets.get(keyOf(resourceType, type, id))).find(Boolean)
    if (type === 'authenticated' && !signedOk) return new Response('Unauthorized', { status: 401 })
    if (!asset || (type !== 'upload' && type !== 'authenticated')) return new Response('Not found', { status: 404 })
    return new Response(new Uint8Array(asset.data), { status: 200 })
  }

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href)
    const method = (init?.method ?? 'GET').toUpperCase()
    const params: Record<string, string> = Object.fromEntries(url.searchParams)
    let file: Blob | undefined
    if (init?.body instanceof FormData) {
      for (const [k, v] of init.body) {
        if (k === 'file' && typeof v !== 'string') file = v
        else if (typeof v === 'string') params[k] = v
      }
    }
    const bare = `${url.origin}${url.pathname}`
    requests.push({ method, url: bare, params })

    const failure = failures.shift()
    if (failure === 'network') throw new TypeError('fetch failed')
    if (failure === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return
        if (signal.aborted) reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    if (failure === 'bad-json') return new Response('<html>không phải json</html>', { status: 200 })
    if (typeof failure === 'number') return apiError(failure, 'lỗi giả')

    if (bare.startsWith(apiPrefix)) {
      const [cloud, section, resourceType = '', type = '', ...rest] = bare.slice(apiPrefix.length).split('/')
      if (section === 'resources' && method === 'GET') {
        if (cloud !== options.cloudName || rest.length > 0) return apiError(401, 'Invalid cloud_name')
        return handleList(resourceType, type, params, new Headers(init?.headers).get('authorization'))
      }
      return handleApi(method, bare.slice(apiPrefix.length), params, file)
    }
    if (bare.startsWith(deliveryPrefix)) return handleDelivery(bare.slice(deliveryPrefix.length))
    return new Response('Not found', { status: 404 })
  }) as typeof fetch

  return {
    fetch: fakeFetch,
    assets,
    requests,
    failNext(failure) {
      failures.push(failure)
    },
  }
}
