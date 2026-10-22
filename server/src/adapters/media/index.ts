// Adapter media (AD-14): ảnh/file lưu trên Cloudinary, không lưu trên máy chủ.
// - `MediaStore` (công khai): ảnh bài đăng, logo — trả URL `https://res.cloudinary.com/...` mà Meta/trình duyệt tải được.
// - `PrivateFileStore` (riêng tư): file kho kiến thức, đính kèm của khách — Cloudinary `type: authenticated`, không có
//   URL công khai dùng được; chỉ server tải về qua API download có chữ ký.
// Gọi bằng `fetch` (không SDK, như adapters/openai) để test trỏ được về Cloudinary giả (`fake.ts`). Không biết nghiệp
// vụ, không log, không ném lỗi thô: trả `{ok:false, kind}` đã phân loại. Không bao giờ đưa api secret, chữ ký hay
// thông báo lỗi gốc của Cloudinary vào kết quả (AD-12). Khởi tạo không gọi mạng.
import { createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import type { CloudinaryCredentials } from '../../platform/config/index.ts'

export const MEDIA_ERROR_KINDS = [
  /** Chưa đặt `CLOUDINARY_URL` — không gọi mạng. Tầng trên trả `ErrorCode` `MEDIA_NOT_CONFIGURED`. */
  'MEDIA_NOT_CONFIGURED',
  /** Cloudinary 401/403: sai khoá/secret/cloud name, chữ ký sai hoặc tài khoản bị chặn. Không retry. */
  'AUTH_FAILED',
  /** Cloudinary 420/429. Caller quyết retry. */
  'RATE_LIMITED',
  /** 400/413/422 (file hỏng, quá lớn, tham số sai) hoặc input bị adapter từ chối trước khi gửi. Không retry. */
  'INVALID_REQUEST',
  /** 404 khi tải/xoá: file không tồn tại. */
  'NOT_FOUND',
  /** 5xx, lỗi mạng, hết giờ, phản hồi hỏng. Caller quyết retry. */
  'TRANSIENT',
] as const
export type MediaErrorKind = (typeof MEDIA_ERROR_KINDS)[number]

export interface MediaFailure {
  ok: false
  kind: MediaErrorKind
  /** HTTP status của Cloudinary; không có khi lỗi mạng, hết giờ hoặc bị từ chối trước khi gửi. */
  status?: number
}

export const PUBLIC_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type PublicImageMime = (typeof PUBLIC_IMAGE_MIMES)[number]

export const PRIVATE_FILE_MIMES = [
  ...PUBLIC_IMAGE_MIMES,
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
] as const
export type PrivateFileMime = (typeof PRIVATE_FILE_MIMES)[number]

/** Kích thước tối đa mỗi file [ASSUMPTION]: giới hạn ảnh/raw của gói Cloudinary Free (10 MB). */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024

export interface PutImageRequest {
  data: Uint8Array
  mime: PublicImageMime
  /** Cloudinary đổi sang JPEG khi upload (Instagram chỉ nhận JPEG). */
  asJpeg?: boolean
  /**
   * Loại metadata/ICC profile của ảnh gốc được lưu (incoming transformation `fl_strip_profile`) — tường minh, không
   * dựa vào mặc định. Cloudinary còn tự loại metadata trên ảnh phái sinh; cờ này đảm bảo cả bản gốc đã lưu cũng sạch.
   */
  stripMetadata?: boolean
}

export interface StoredImage {
  publicId: string
  /** `https://res.cloudinary.com/<cloud>/image/upload/v<version>/<publicId>.<format>`. */
  url: string
  width: number
  height: number
  bytes: number
  /** Định dạng Cloudinary lưu: `jpg`, `png`, `webp`. */
  format: string
}

export type PutImageResult = ({ ok: true } & StoredImage) | MediaFailure
export type DeleteResult = { ok: true } | MediaFailure

export interface MediaStore {
  /** Upload ảnh công khai vào `<folder>/public/<uuidv7>`. */
  put(request: PutImageRequest): Promise<PutImageResult>
  /** Xoá ảnh công khai (kèm xoá cache CDN). Không tồn tại → vẫn ok (idempotent). */
  delete(publicId: string): Promise<DeleteResult>
}

/** Chỗ của một file riêng tư trên Cloudinary — caller lưu nguyên bộ này để `get`/`delete` sau. */
export interface PrivateFileRef {
  publicId: string
  /** `image` cho ảnh, `raw` cho pdf/docx/txt. */
  resourceType: 'image' | 'raw'
  /** Định dạng ảnh Cloudinary lưu (cần cho API download); `null` với file raw. */
  format: string | null
}

export interface PutFileRequest {
  data: Uint8Array
  mime: PrivateFileMime
}

export type PutFileResult = ({ ok: true; bytes: number } & PrivateFileRef) | MediaFailure
export type GetFileResult = { ok: true; data: Buffer } | MediaFailure

export interface PrivateFileStore {
  /** Upload `type: authenticated` vào `<folder>/private/<uuidv7>`. Không trả URL. */
  put(request: PutFileRequest): Promise<PutFileResult>
  /** Tải bytes qua API download có chữ ký. */
  get(ref: PrivateFileRef): Promise<GetFileResult>
  /** Không tồn tại → vẫn ok (idempotent). */
  delete(ref: PrivateFileRef): Promise<DeleteResult>
}

export interface MediaStores {
  /** `false` khi thiếu `CLOUDINARY_URL`: mọi thao tác trả `MEDIA_NOT_CONFIGURED`, không gọi mạng. */
  configured: boolean
  publicStore: MediaStore
  privateStore: PrivateFileStore
}

/** Phần config adapter cần (khớp `Config` / `MediaEnv` của platform/config). */
export interface MediaConfig {
  CLOUDINARY_URL?: CloudinaryCredentials | undefined
  CLOUDINARY_FOLDER: string
}

export const CLOUDINARY_API_BASE_URL = 'https://api.cloudinary.com/v1_1'
export const UPLOAD_TIMEOUT_MS = 60_000
export const REQUEST_TIMEOUT_MS = 30_000

export interface MediaStoresOptions {
  fetch?: typeof fetch
  /** Đồng hồ (ms) cho `timestamp` của chữ ký — test cố định. */
  now?: () => number
  /** Gốc API (test trỏ về server giả). */
  apiBaseUrl?: string
  uploadTimeoutMs?: number
  timeoutMs?: number
}

/**
 * Chữ ký request Cloudinary (tài liệu "Generating authentication signatures"): bỏ `file`, `cloud_name`,
 * `resource_type`, `api_key` và tham số rỗng; sắp xếp theo tên; nối `k=v` bằng `&`; nối thêm api_secret; SHA-1 hex.
 */
export function signParams(params: Record<string, string | number | boolean | undefined>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .filter((k) => !UNSIGNED_PARAMS.has(k) && params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${String(params[k])}`)
    .join('&')
  return createHash('sha1').update(toSign + apiSecret).digest('hex')
}
const UNSIGNED_PARAMS = new Set(['file', 'cloud_name', 'resource_type', 'api_key'])

/** Phân loại phản hồi lỗi HTTP của Cloudinary (420 = giới hạn tần suất của Cloudinary). */
export function classifyStatus(status: number): MediaErrorKind {
  if (status === 401 || status === 403) return 'AUTH_FAILED'
  if (status === 420 || status === 429) return 'RATE_LIMITED'
  if (status === 404) return 'NOT_FOUND'
  if (status === 400 || status === 413 || status === 422) return 'INVALID_REQUEST'
  return 'TRANSIENT'
}

const NOT_CONFIGURED: MediaFailure = { ok: false, kind: 'MEDIA_NOT_CONFIGURED' }
const notConfigured = async (): Promise<MediaFailure> => ({ ...NOT_CONFIGURED })

const isPublicMime = (m: string): m is PublicImageMime => (PUBLIC_IMAGE_MIMES as readonly string[]).includes(m)
const isPrivateMime = (m: string): m is PrivateFileMime => (PRIVATE_FILE_MIMES as readonly string[]).includes(m)

const nonNegInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined

type Params = Record<string, string | number | boolean | undefined>
type Json = Record<string, unknown>

export function createMediaStores(config: MediaConfig, options: MediaStoresOptions = {}): MediaStores {
  const creds = config.CLOUDINARY_URL
  if (!creds) {
    return {
      configured: false,
      publicStore: { put: notConfigured, delete: notConfigured },
      privateStore: { put: notConfigured, get: notConfigured, delete: notConfigured },
    }
  }
  const folder = config.CLOUDINARY_FOLDER
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const apiBase = `${(options.apiBaseUrl ?? CLOUDINARY_API_BASE_URL).replace(/\/+$/, '')}/${encodeURIComponent(creds.cloudName)}`
  const uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  /** Thêm `timestamp`, `signature`, `api_key` vào tham số. */
  function signed(params: Params): Record<string, string> {
    const withTs: Params = { ...params, timestamp: Math.floor(now() / 1000) }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(withTs)) if (v !== undefined && v !== '') out[k] = String(v)
    out.signature = signParams(withTs, creds!.apiSecret)
    out.api_key = creds!.apiKey
    return out
  }

  /** Gọi Cloudinary; lỗi mạng/hết giờ → TRANSIENT, HTTP lỗi → classifyStatus. Không giữ lỗi gốc. */
  async function call(url: string, init: RequestInit, timeout: number): Promise<{ ok: true; res: Response } | MediaFailure> {
    let res: Response
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeout) })
    } catch {
      return { ok: false, kind: 'TRANSIENT' }
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, kind: classifyStatus(res.status), status: res.status }
    }
    return { ok: true, res }
  }

  async function readJson(res: Response): Promise<Json | undefined> {
    try {
      const body = (await res.json()) as unknown
      return typeof body === 'object' && body !== null ? (body as Json) : undefined
    } catch {
      return undefined
    }
  }

  async function postForm(resourceType: string, action: string, form: FormData, timeout: number): Promise<{ ok: true; json: Json } | MediaFailure> {
    const result = await call(`${apiBase}/${resourceType}/${action}`, { method: 'POST', body: form, headers: { Accept: 'application/json' } }, timeout)
    if (!result.ok) return result
    const json = await readJson(result.res)
    return json ? { ok: true, json } : { ok: false, kind: 'TRANSIENT', status: result.res.status }
  }

  async function upload(
    resourceType: 'image' | 'raw',
    params: Params,
    data: Uint8Array,
    mime: string,
  ): Promise<{ ok: true; json: Json } | MediaFailure> {
    if (data.byteLength === 0 || data.byteLength > MEDIA_MAX_BYTES) return { ok: false, kind: 'INVALID_REQUEST' }
    const form = new FormData()
    for (const [k, v] of Object.entries(signed(params))) form.append(k, v)
    form.append('file', new Blob([new Uint8Array(data)], { type: mime }), 'upload')
    return postForm(resourceType, 'upload', form, uploadTimeoutMs)
  }

  async function destroy(resourceType: 'image' | 'raw', publicId: string, type: 'upload' | 'authenticated', invalidate: boolean): Promise<DeleteResult> {
    if (!publicId) return { ok: false, kind: 'INVALID_REQUEST' }
    const form = new FormData()
    for (const [k, v] of Object.entries(signed({ public_id: publicId, type, invalidate: invalidate ? 'true' : undefined }))) form.append(k, v)
    const result = await postForm(resourceType, 'destroy', form, timeoutMs)
    if (!result.ok) return result.kind === 'NOT_FOUND' ? { ok: true } : result
    // 200 kèm `result: 'ok'` (đã xoá) hoặc `'not found'` (không có — coi như xong).
    const r = result.json.result
    return r === 'ok' || r === 'not found' ? { ok: true } : { ok: false, kind: 'TRANSIENT', status: 200 }
  }

  const newPublicId = (scope: 'public' | 'private') => `${folder}/${scope}/${uuidv7()}`

  const publicStore: MediaStore = {
    async put(request) {
      if (!isPublicMime(request.mime)) return { ok: false, kind: 'INVALID_REQUEST' }
      const publicId = newPublicId('public')
      const result = await upload(
        'image',
        { public_id: publicId, format: request.asJpeg ? 'jpg' : undefined, transformation: request.stripMetadata ? 'fl_strip_profile' : undefined },
        request.data,
        request.mime,
      )
      if (!result.ok) return result
      const j = result.json
      const url = typeof j.secure_url === 'string' && j.secure_url.startsWith('https://') ? j.secure_url : undefined
      const width = nonNegInt(j.width)
      const height = nonNegInt(j.height)
      const bytes = nonNegInt(j.bytes)
      const format = typeof j.format === 'string' && j.format ? j.format : undefined
      if (!url || width === undefined || height === undefined || bytes === undefined || !format) {
        return { ok: false, kind: 'TRANSIENT', status: 200 }
      }
      const storedId = typeof j.public_id === 'string' ? j.public_id : publicId
      // Xin JPEG (cho IG) mà Cloudinary lưu định dạng khác → INVALID_REQUEST: lỗi cố định với ảnh/tài khoản này, gọi lại
      // cũng vậy, nên không retry. Xoá (best-effort) ảnh vừa upload để không bỏ rơi trên Cloudinary.
      if (request.asJpeg && format !== 'jpg' && format !== 'jpeg') {
        await destroy('image', storedId, 'upload', true)
        return { ok: false, kind: 'INVALID_REQUEST', status: 200 }
      }
      return { ok: true, publicId: storedId, url, width, height, bytes, format }
    },
    delete(publicId) {
      return destroy('image', publicId, 'upload', true)
    },
  }

  const privateStore: PrivateFileStore = {
    async put(request) {
      if (!isPrivateMime(request.mime)) return { ok: false, kind: 'INVALID_REQUEST' }
      const resourceType = isPublicMime(request.mime) ? 'image' : 'raw'
      const publicId = newPublicId('private')
      const result = await upload(resourceType, { public_id: publicId, type: 'authenticated' }, request.data, request.mime)
      if (!result.ok) return result
      const j = result.json
      const bytes = nonNegInt(j.bytes)
      const format = typeof j.format === 'string' && j.format ? j.format : null
      if (bytes === undefined || (resourceType === 'image' && !format)) return { ok: false, kind: 'TRANSIENT', status: 200 }
      // Không trả `secure_url` (URL có chữ ký — ai có nó tải được file).
      return { ok: true, publicId: typeof j.public_id === 'string' ? j.public_id : publicId, resourceType, format, bytes }
    },
    async get(ref) {
      if (!ref.publicId) return { ok: false, kind: 'INVALID_REQUEST' }
      const query = new URLSearchParams(signed({ public_id: ref.publicId, format: ref.format ?? undefined, type: 'authenticated' }))
      const result = await call(`${apiBase}/${ref.resourceType}/download?${query}`, { method: 'GET' }, timeoutMs)
      if (!result.ok) return result
      try {
        return { ok: true, data: Buffer.from(await result.res.arrayBuffer()) }
      } catch {
        return { ok: false, kind: 'TRANSIENT', status: result.res.status }
      }
    },
    delete(ref) {
      return destroy(ref.resourceType, ref.publicId, 'authenticated', true)
    },
  }

  return { configured: true, publicStore, privateStore }
}
