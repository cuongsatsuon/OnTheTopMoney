// Adapter media (AD-14): ảnh/file lưu trên Cloudinary, không lưu trên máy chủ.
// - `MediaStore` (công khai): ảnh bài đăng, logo — trả URL `https://res.cloudinary.com/...` mà Meta/trình duyệt tải được.
// - `PrivateFileStore` (riêng tư): file kho kiến thức, đính kèm của khách — Cloudinary `type: authenticated`, không có
//   URL công khai dùng được; chỉ server tải về qua API download có chữ ký.
// - `MediaInventory` (Story 9.3): liệt kê / xoá file theo prefix của app (`<folder>/public|private/`) qua Admin API — cho
//   lượt dọn file mồ côi; không bao giờ đụng file ngoài hai prefix đó.
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
  // Đính kèm của khách (Story 4.3, AD-11): sticker/ảnh động, voice, video. Lưu `raw` (chỉ server tải về).
  'image/gif',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/quicktime',
  'video/webm',
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
   * Loại metadata/ICC profile của ảnh gốc được lưu (incoming transformation `a_exif` + `fl_force_strip.strip_profile`,
   * xoay theo EXIF trước khi bỏ) — tường minh, không dựa vào mặc định. Cloudinary còn tự loại metadata trên ảnh phái sinh; cờ này đảm bảo cả bản gốc đã lưu cũng sạch.
   */
  stripMetadata?: boolean
  /**
   * Đổi không gian màu sang sRGB khi lưu (incoming transformation `cs_srgb`) — ảnh bài đăng (Story 6.1): ảnh điện
   * thoại hay ở Display P3, bỏ ICC profile mà không đổi màu thì màu lệch trên Instagram.
   */
  toSrgb?: boolean
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

/**
 * Story 9.3: loại file của app trên kho — mỗi loại một lệnh liệt kê Admin API (`resources/<resource_type>/<type>`) giới hạn
 * trong prefix của app: `public_image` = `<folder>/public/` (ảnh bài, logo), `private_*` = `<folder>/private/` (đính kèm,
 * file kho kiến thức; ảnh và raw là hai resource type khác nhau).
 */
export const STORED_FILE_KINDS = ['public_image', 'private_image', 'private_raw'] as const
export type StoredFileKind = (typeof STORED_FILE_KINDS)[number]

export interface StoredFile {
  publicId: string
  /** `created_at` của Cloudinary; `null` khi thiếu / hỏng (caller coi như mới, không xoá). */
  createdAt: Date | null
}

export type ListFilesResult = { ok: true; files: StoredFile[]; nextCursor: string | null } | MediaFailure

/** Số file tối đa mỗi trang liệt kê (giới hạn của Admin API). */
export const LIST_MAX_RESULTS = 500

/** Prefix public_id của loại `kind` trong thư mục `folder` (`<folder>/public/` hoặc `<folder>/private/`). */
export function storedFilePrefix(folder: string, kind: StoredFileKind): string {
  return `${folder}/${kind === 'public_image' ? 'public' : 'private'}/`
}

export interface MediaInventory {
  /** Prefix public_id mà loại `kind` liệt kê / xoá — cho báo cáo đếm (dry_run) đối chiếu với kho thật; không gọi mạng. */
  prefix(kind: StoredFileKind): string
  /**
   * Một trang file của loại `kind` (sắp theo public_id — với public_id uuidv7 là theo thời gian tải lên). `cursor` =
   * `nextCursor` của trang trước, `null` = từ đầu. Chỉ trả file nằm trong prefix của loại.
   */
  list(kind: StoredFileKind, cursor: string | null, maxResults?: number): Promise<ListFilesResult>
  /** Xoá một file của loại `kind`. public_id ngoài prefix của loại → `INVALID_REQUEST`, không gọi mạng. Idempotent. */
  delete(kind: StoredFileKind, publicId: string): Promise<DeleteResult>
}

export interface MediaStores {
  /** `false` khi thiếu `CLOUDINARY_URL`: mọi thao tác trả `MEDIA_NOT_CONFIGURED`, không gọi mạng. */
  configured: boolean
  publicStore: MediaStore
  privateStore: PrivateFileStore
  /** Story 9.3: liệt kê / xoá theo prefix cho lượt dọn file mồ côi. */
  inventory: MediaInventory
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

/**
 * Incoming transformation của ảnh công khai (một thành phần, nối bằng dấu phẩy):
 * - `a_exif`: xoay ảnh theo EXIF `Orientation` TRƯỚC khi bỏ metadata — ảnh dọc chụp điện thoại không bị nằm ngang
 *   khi Meta tải bản gốc đã mất EXIF;
 * - `cs_srgb`: đổi màu sang sRGB;
 * - `fl_force_strip.strip_profile`: `strip_profile` chỉ bỏ ICC profile; EXIF/IPTC/XMP (cả toạ độ GPS) chỉ bị xoá ở
 *   incoming transformation khi có `force_strip`.
 */
export function incomingTransformation(request: Pick<PutImageRequest, 'toSrgb' | 'stripMetadata'>): string | undefined {
  const parts = [
    request.stripMetadata ? 'a_exif' : null,
    request.toSrgb ? 'cs_srgb' : null,
    request.stripMetadata ? 'fl_force_strip.strip_profile' : null,
  ].filter((p) => p !== null)
  return parts.length ? parts.join(',') : undefined
}

export interface ImageFit {
  /** Tỉ lệ rộng/cao nhỏ nhất (ảnh dọc hơn → đệm hai bên). */
  minAspect?: number
  /** Tỉ lệ rộng/cao lớn nhất (ảnh ngang hơn → đệm trên dưới). */
  maxAspect?: number
  /** Rộng tối đa (px) của ảnh giao đi; lớn hơn → thu nhỏ giữ tỉ lệ. */
  maxWidth?: number
}

/**
 * URL giao ảnh công khai đã biến đổi theo yêu cầu của nơi nhận (Story 6.4: Instagram chỉ nhận tỉ lệ 4:5–1,91:1, IG /
 * Threads rộng ≤1440 px): chèn transformation Cloudinary (biến đổi khi giao, bản gốc giữ nguyên) sau `/image/upload/`.
 * - Ngoài khung tỉ lệ → `c_pad,w_,h_,b_white` (đệm nền trắng, không cắt mất phần nào của ảnh), cùng lúc thu nhỏ.
 * - Chỉ quá rộng → `c_limit,w_`.
 * - Đã vừa, hoặc URL không phải ảnh `upload` của Cloudinary → trả nguyên URL.
 */
export function fitImageUrl(url: string, size: { width: number; height: number }, fit: ImageFit): string {
  const { width: w, height: h } = size
  const marker = '/image/upload/'
  const at = url.indexOf(marker)
  if (at === -1 || !(w > 0 && h > 0)) return url
  let cw = w
  let ch = h
  const ratio = w / h
  if (fit.minAspect !== undefined && ratio < fit.minAspect - 1e-3) cw = Math.round(h * fit.minAspect)
  else if (fit.maxAspect !== undefined && ratio > fit.maxAspect + 1e-3) ch = Math.round(w / fit.maxAspect)
  const padded = cw !== w || ch !== h
  if (fit.maxWidth !== undefined && cw > fit.maxWidth) {
    ch = Math.round((ch * fit.maxWidth) / cw)
    cw = fit.maxWidth
  }
  const t = padded ? `c_pad,w_${cw},h_${ch},b_white` : cw !== w ? `c_limit,w_${cw}` : null
  if (!t) return url
  const head = url.slice(0, at + marker.length)
  return `${head}${t}/${url.slice(at + marker.length)}`
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
      inventory: { prefix: (kind) => storedFilePrefix(config.CLOUDINARY_FOLDER, kind), list: notConfigured, delete: notConfigured },
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
        { public_id: publicId, format: request.asJpeg ? 'jpg' : undefined, transformation: incomingTransformation(request) },
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

  const KIND_SPEC: Record<StoredFileKind, { resourceType: 'image' | 'raw'; type: 'upload' | 'authenticated'; prefix: string }> = {
    public_image: { resourceType: 'image', type: 'upload', prefix: storedFilePrefix(folder, 'public_image') },
    private_image: { resourceType: 'image', type: 'authenticated', prefix: storedFilePrefix(folder, 'private_image') },
    private_raw: { resourceType: 'raw', type: 'authenticated', prefix: storedFilePrefix(folder, 'private_raw') },
  }
  // Admin API xác thực bằng HTTP Basic (api_key:api_secret), không ký tham số như Upload API.
  const basicAuth = `Basic ${Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64')}`

  const inventory: MediaInventory = {
    prefix: (kind) => KIND_SPEC[kind].prefix,
    async list(kind, cursor, maxResults = LIST_MAX_RESULTS) {
      const spec = KIND_SPEC[kind]
      const query = new URLSearchParams({ prefix: spec.prefix, max_results: String(Math.min(Math.max(1, Math.floor(maxResults)), LIST_MAX_RESULTS)) })
      if (cursor) query.set('next_cursor', cursor)
      const result = await call(
        `${apiBase}/resources/${spec.resourceType}/${spec.type}?${query}`,
        { method: 'GET', headers: { Accept: 'application/json', Authorization: basicAuth } },
        timeoutMs,
      )
      if (!result.ok) return result
      const json = await readJson(result.res)
      if (!json || !Array.isArray(json.resources)) return { ok: false, kind: 'TRANSIENT', status: result.res.status }
      const files: StoredFile[] = []
      for (const r of json.resources as unknown[]) {
        const item = (typeof r === 'object' && r !== null ? r : {}) as Json
        // Phòng thủ: chỉ nhận file đúng prefix của loại (prefix là tham số của chính adapter, không do caller đưa).
        if (typeof item.public_id !== 'string' || !item.public_id.startsWith(spec.prefix)) continue
        const at = typeof item.created_at === 'string' ? new Date(item.created_at) : null
        files.push({ publicId: item.public_id, createdAt: at && !Number.isNaN(at.getTime()) ? at : null })
      }
      const next = typeof json.next_cursor === 'string' && json.next_cursor !== '' ? json.next_cursor : null
      return { ok: true, files, nextCursor: next }
    },
    delete(kind, publicId) {
      const spec = KIND_SPEC[kind]
      if (!publicId.startsWith(spec.prefix) || publicId.length === spec.prefix.length) return Promise.resolve({ ok: false, kind: 'INVALID_REQUEST' })
      return destroy(spec.resourceType, publicId, spec.type, true)
    },
  }

  return { configured: true, publicStore, privateStore, inventory }
}
