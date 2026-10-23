// Tin nhắn trong webhook Meta (AD-4, AD-6, Story 4.3): chuẩn hoá một mục `messaging[]` (Messenger / Instagram
// Direct) thành tin DM dạng chung, và tải đính kèm từ CDN của Meta. Hàm thuần + fetch tiêm vào — không biết nghiệp
// vụ, không log, không chạm DB. Module gọi (`webhooks` → `inbox`) quyết định làm gì với kết quả.
// - Messenger: `sender.id` = PSID, `recipient.id` = id Fanpage. IG Direct: `sender.id` = IGSID, `recipient.id` = id
//   tài khoản IG. `timestamp` là mili giây epoch.
// - Story 4.5: tin của chính trang (`is_echo`, hoặc `sender.id` = id trang) → `echo` (khách = `recipient.id`, kèm
//   `app_id`/`metadata` để `inbox` nhận diện tin của app). Tin bị thu hồi (`is_deleted`), postback, reaction → `skip`.
// - Story 4.5: "đã nhận / đã xem" (`delivery`, `read`) → `normalizeMessagingReceipt`.
// - URL đính kèm là link CDN có chữ ký, hết hạn sau một thời gian → phải tải về lúc ingest (AD-11, AD-14).
import type { AttachmentKind } from '@ottm/shared'

/** Một đính kèm cần tải về. `url` đã kiểm là chuỗi; host được kiểm lúc tải (`downloadWebhookAttachment`). */
export interface DmAttachment {
  kind: AttachmentKind
  url: string
}

export interface DmMessage {
  kind: 'dm'
  /** PSID / IGSID của khách — `thread_key` của hội thoại DM. */
  senderId: string
  /** Id nền tảng của trang nhận. */
  recipientId: string
  mid: string
  timestamp: Date
  /** Chữ của tin; `null` khi chỉ có đính kèm hoặc Meta không gửi nội dung (`is_unsupported`). */
  text: string | null
  attachments: DmAttachment[]
}

/** Tin do chính trang gửi (echo) — từ app này, app khác (Business Suite, app Facebook) hay Send API của bên thứ ba. */
export interface DmEcho {
  kind: 'echo'
  /** PSID / IGSID của khách nhận tin — `thread_key` của hội thoại DM. */
  customerId: string
  mid: string
  timestamp: Date
  text: string | null
  attachments: DmAttachment[]
  /** `message.app_id`: app đã gửi tin; `null` khi Meta không gửi (IG có thể thiếu). */
  appId: string | null
  /** `message.metadata`: chuỗi app gửi kèm khi gọi Send API (app này gửi `messages.id`); `null` khi không có. */
  metadata: string | null
}

export type DmSkipReason =
  /** Khách thu hồi tin (IG `is_deleted`). */
  | 'deleted'
  /** Không phải tin nhắn (postback, reaction, delivery, read…). */
  | 'not_message'
  /** Thiếu `sender.id` / `mid` (echo: thiếu `recipient.id` hoặc người nhận là chính trang). */
  | 'malformed'

export type NormalizedDm = DmMessage | DmEcho | { kind: 'skip'; reason: DmSkipReason }

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const str = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v)
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s === '' ? undefined : s
}

/**
 * Loại Meta → loại lưu. Chỉ các loại là FILE mới tải về; `share`, `story_mention`, `ig_reel`, `fallback`,
 * `template`, `location`… là liên kết tới nội dung khác (không phải file của khách) → bỏ qua.
 */
const ATTACHMENT_KIND: Readonly<Record<string, AttachmentKind>> = {
  image: 'image',
  sticker: 'image',
  animated_image_share: 'image',
  audio: 'audio',
  video: 'video',
  file: 'file',
}

/** `timestamp` mili giây epoch của mục (số hoặc chuỗi số); không đọc được → `null`. */
function epochMs(raw: unknown): Date | null {
  const ms = typeof raw === 'number' && Number.isFinite(raw) ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null
}

/**
 * Mục `messaging` → tin DM chuẩn, tin của chính trang (`echo`) hoặc lý do bỏ qua. `pagePlatformId` là id nền tảng
 * của trang đã khớp (để nhận diện tin do chính trang gửi). `now` dùng khi Meta không gửi `timestamp`.
 */
export function normalizeMessagingItem(item: unknown, pagePlatformId: string, now: Date = new Date()): NormalizedDm {
  const rec = asRecord(item)
  const message = asRecord(rec?.message)
  if (!rec || !message) return { kind: 'skip', reason: 'not_message' }
  if (message.is_deleted === true) return { kind: 'skip', reason: 'deleted' }
  const senderId = str(asRecord(rec.sender)?.id)
  const recipientId = str(asRecord(rec.recipient)?.id)
  const mid = str(message.mid)
  const timestamp = epochMs(rec.timestamp) ?? now
  const text = typeof message.text === 'string' && message.text.trim() !== '' ? message.text : null

  // Tin của chính trang: khách là người NHẬN. Người nhận thiếu / là chính trang → không biết luồng nào.
  if (message.is_echo === true || (senderId !== undefined && senderId === pagePlatformId)) {
    if (!mid || !recipientId || recipientId === pagePlatformId) return { kind: 'skip', reason: 'malformed' }
    return {
      kind: 'echo',
      customerId: recipientId,
      mid,
      timestamp,
      text,
      attachments: attachmentsOf(message),
      appId: str(message.app_id) ?? null,
      metadata: str(message.metadata) ?? null,
    }
  }

  if (!senderId || !mid) return { kind: 'skip', reason: 'malformed' }
  return { kind: 'dm', senderId, recipientId: recipientId ?? pagePlatformId, mid, timestamp, text, attachments: attachmentsOf(message) }
}

/** Đính kèm là FILE của tin (bỏ loại liên kết, thiếu URL). */
function attachmentsOf(message: Record<string, unknown>): DmAttachment[] {
  const attachments: DmAttachment[] = []
  for (const raw of Array.isArray(message.attachments) ? message.attachments : []) {
    const att = asRecord(raw)
    const type = str(att?.type)
    const kind = type ? ATTACHMENT_KIND[type] : undefined
    const url = str(asRecord(att?.payload)?.url)
    if (kind && url) attachments.push({ kind, url })
  }
  return attachments
}

/**
 * "Đã nhận / đã xem" của tin trang gửi (Story 4.5, AD-4). Messenger: `delivery {mids?, watermark}` (mọi tin trước
 * `watermark` đã tới), `read {watermark}`; IG (`messaging_seen`): `read {mid}`. `customerId` = `sender.id` (khách).
 */
export interface DmReceipt {
  kind: 'receipt'
  status: 'delivered' | 'read'
  customerId: string
  mids: string[]
  /** Mốc của Meta; `null` khi chỉ có `mid` (IG). */
  watermark: Date | null
}

export type NormalizedReceipt = DmReceipt | { kind: 'skip'; reason: 'not_receipt' | 'malformed' }

/** Mục `messaging` có `delivery` / `read` → receipt chuẩn. `pagePlatformId` để loại mục mà "khách" là chính trang. */
export function normalizeMessagingReceipt(item: unknown, pagePlatformId: string): NormalizedReceipt {
  const rec = asRecord(item)
  const delivery = asRecord(rec?.delivery)
  const read = asRecord(rec?.read)
  const body = delivery ?? read
  if (!rec || !body) return { kind: 'skip', reason: 'not_receipt' }
  const customerId = str(asRecord(rec.sender)?.id)
  if (!customerId || customerId === pagePlatformId) return { kind: 'skip', reason: 'malformed' }
  const mids = (Array.isArray(body.mids) ? body.mids : [body.mid]).map(str).filter((m): m is string => m !== undefined)
  const watermark = epochMs(body.watermark)
  if (mids.length === 0 && !watermark) return { kind: 'skip', reason: 'malformed' }
  return { kind: 'receipt', status: delivery ? 'delivered' : 'read', customerId, mids, watermark }
}

// ---------------------------------------------------------------------------------------------------------
// Tải đính kèm
// ---------------------------------------------------------------------------------------------------------

/** Host CDN Meta được phép tải (link đính kèm webhook). Ngoài danh sách → không gọi mạng (chống SSRF). */
export const ATTACHMENT_HOST_SUFFIXES = ['.fbcdn.net', '.fbsbx.com', '.cdninstagram.com'] as const
/** Giới hạn mỗi đính kèm — khớp `MEDIA_MAX_BYTES` của kho Cloudinary Free. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const ATTACHMENT_TIMEOUT_MS = 30_000
/** Link `lookaside.fbsbx.com` thường chuyển hướng sang `scontent*.fbcdn.net`; mỗi bước đều kiểm host. */
const MAX_REDIRECTS = 3

export type AttachmentDownloadFailure = {
  ok: false
  /**
   * `INVALID_URL` (không phải https / host ngoài CDN Meta) · `TOO_LARGE` · `NOT_FOUND` (404/410, link hết hạn) ·
   * `REJECTED` (4xx khác, vd 403 chữ ký hết hạn) · `RATE_LIMITED` (429) · `TRANSIENT` (5xx, mạng, hết giờ).
   */
  kind: 'INVALID_URL' | 'TOO_LARGE' | 'NOT_FOUND' | 'REJECTED' | 'RATE_LIMITED' | 'TRANSIENT'
  status?: number
}
export type AttachmentDownloadResult = { ok: true; data: Buffer; mime: string } | AttachmentDownloadFailure

export interface DownloadOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
}

/** URL https trên CDN Meta? */
export function isAllowedAttachmentUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false
  const host = url.hostname.toLowerCase()
  return ATTACHMENT_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/**
 * Tải một đính kèm từ CDN Meta. Không theo redirect tự động: mỗi bước chuyển hướng phải vẫn là host CDN Meta.
 * Đọc body theo luồng, dừng ngay khi vượt `maxBytes`. MIME lấy từ `Content-Type` (bỏ tham số); kiểm định dạng
 * cho phép là việc của bên gọi.
 */
export async function downloadWebhookAttachment(rawUrl: string, options: DownloadOptions = {}): Promise<AttachmentDownloadResult> {
  const doFetch = options.fetch ?? fetch
  const maxBytes = options.maxBytes ?? ATTACHMENT_MAX_BYTES
  const signal = AbortSignal.timeout(options.timeoutMs ?? ATTACHMENT_TIMEOUT_MS)
  let url = rawUrl
  for (let hop = 0; ; hop++) {
    if (!isAllowedAttachmentUrl(url)) return { ok: false, kind: 'INVALID_URL' }
    let res: Response
    try {
      res = await doFetch(url, { method: 'GET', redirect: 'manual', signal })
    } catch {
      return { ok: false, kind: 'TRANSIENT' }
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {})
      const location = res.headers.get('location')
      if (!location || hop >= MAX_REDIRECTS) return { ok: false, kind: 'INVALID_URL', status: res.status }
      try {
        url = new URL(location, url).toString()
      } catch {
        return { ok: false, kind: 'INVALID_URL', status: res.status }
      }
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      const kind = res.status === 404 || res.status === 410 ? 'NOT_FOUND' : res.status === 429 ? 'RATE_LIMITED' : res.status >= 500 ? 'TRANSIENT' : 'REJECTED'
      return { ok: false, kind, status: res.status }
    }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, kind: 'TOO_LARGE', status: res.status }
    }
    const mime = (res.headers.get('content-type') ?? 'application/octet-stream').split(';', 1)[0]!.trim().toLowerCase()
    try {
      const data = await readCapped(res, maxBytes)
      if (!data) return { ok: false, kind: 'TOO_LARGE', status: res.status }
      return { ok: true, data, mime }
    } catch {
      return { ok: false, kind: 'TRANSIENT', status: res.status }
    }
  }
}

/** Đọc body tối đa `max` byte; vượt → huỷ luồng, trả `null`. */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
