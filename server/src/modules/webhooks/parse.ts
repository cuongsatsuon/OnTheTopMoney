// Tách body webhook thành từng MỤC chuẩn (AD-4). Hàm thuần, không chạm DB — test trực tiếp.
// - Graph (Facebook/Instagram): `entry[].messaging[]` (Messenger/IG Direct) và `entry[].changes[]` (feed/comment).
// - Threads: parser riêng (`entry[].changes[]`, field thường là `replies`); dạng payload Threads là [ASSUMPTION]
//   (AD-4) tới khi có sự kiện thật — fallback hash bảo đảm mục lạ vẫn ra đúng một dòng chống trùng.
// Khoá chống trùng: `mid`/`comment_id`/id media nếu có; không thì `sha256:<hash canonical của mục>`.
import { createHash } from 'node:crypto'

/** Một mục webhook đã tách, sẵn sàng ghi một dòng `webhook_events`. */
export interface WebhookItem {
  /** Id trang theo nền tảng (`entry.id`); `null` khi không xác định được. */
  platformPageId: string | null
  /** Loại mục để hiển thị/định tuyến. */
  field: string
  /** Khoá chống trùng của mục. */
  dedupeKey: string
  /** Mục thô (JSON) — không phải cả body. */
  payload: unknown
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim() !== '') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

/** Hash ổn định của mục (khoá lặp lại không đổi giữa các lần gửi) → fallback khi không có id tự nhiên. */
export function hashItem(item: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(item)).digest('hex')}`
}

/**
 * Khoá chống trùng của mục: gắn namespace `field` vào id tự nhiên để id trùng giữa các LOẠI mục
 * (vd `comment_id` == `mid`) không gộp thành một → không mất sự kiện. Không có id tự nhiên → hash của mục.
 */
function dedupeKeyFor(field: string, naturalId: string | undefined, item: unknown): string {
  return naturalId !== undefined ? `${field}:${naturalId}` : hashItem(item)
}

/** JSON với khoá object sắp xếp — hai mục giống nhau (thứ tự khoá khác) cho cùng hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const rec = asRecord(value)
  if (!rec) return JSON.stringify(value) ?? 'null'
  const keys = Object.keys(rec).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`
}

/** Field + id tự nhiên của một mục `messaging` Messenger/IG Direct. */
function messagingField(item: Record<string, unknown>): { field: string; naturalId?: string } {
  const message = asRecord(item.message)
  if (message) {
    const mid = str(message.mid)
    const field = message.is_echo === true ? 'message_echoes' : 'messages'
    return mid ? { field, naturalId: mid } : { field }
  }
  if (asRecord(item.postback)) return { field: 'messaging_postbacks' }
  if (asRecord(item.reaction)) return { field: 'message_reactions' }
  if (asRecord(item.delivery)) return { field: 'message_deliveries' }
  if (asRecord(item.read)) return { field: 'message_reads' }
  return { field: 'messaging' }
}

/** Id tự nhiên của một mục `changes` (feed/comment): comment_id → media id → post_id → id. */
function changeNaturalId(value: Record<string, unknown> | null): string | undefined {
  if (!value) return undefined
  return (
    str(value.comment_id) ??
    str(asRecord(value.media)?.id) ??
    str(value.media_id) ??
    str(value.post_id) ??
    str(value.id)
  )
}

/** Tách một `entry` Graph thành các mục (`messaging[]` + `changes[]`). */
function parseGraphEntry(entry: Record<string, unknown>): WebhookItem[] {
  const platformPageId = str(entry.id) ?? null
  const items: WebhookItem[] = []
  for (const raw of asArray(entry.messaging)) {
    const item = asRecord(raw)
    if (!item) continue
    const { field, naturalId } = messagingField(item)
    items.push({ platformPageId, field, dedupeKey: dedupeKeyFor(field, naturalId, item), payload: item })
  }
  for (const raw of asArray(entry.changes)) {
    const item = asRecord(raw)
    if (!item) continue
    const field = str(item.field) ?? 'changes'
    const naturalId = changeNaturalId(asRecord(item.value))
    items.push({ platformPageId, field, dedupeKey: dedupeKeyFor(field, naturalId, item), payload: item })
  }
  return items
}

/** Body Graph (`{object, entry:[…]}`) → mục. Body lạ/không parse được → `[]` (trả 200, không enqueue). */
export function parseMetaBody(body: unknown): WebhookItem[] {
  const root = asRecord(body)
  if (!root) return []
  const items: WebhookItem[] = []
  for (const raw of asArray(root.entry)) {
    const entry = asRecord(raw)
    if (entry) items.push(...parseGraphEntry(entry))
  }
  return items
}

/**
 * Body Threads → mục. Dạng Threads: `{object:'threads', entry:[{id, time, changes:[{field, value}]}]}`
 * (một số sự kiện dùng `messaging[]` như Graph). Parser riêng để không lẫn với Graph; id tự nhiên lấy từ
 * `value.id`/`reply_id`/`comment_id`, không thì hash.
 */
export function parseThreadsBody(body: unknown): WebhookItem[] {
  const root = asRecord(body)
  if (!root) return []
  const items: WebhookItem[] = []
  for (const raw of asArray(root.entry)) {
    const entry = asRecord(raw)
    if (!entry) continue
    const platformPageId = str(entry.id) ?? null
    for (const rawChange of asArray(entry.changes)) {
      const change = asRecord(rawChange)
      if (!change) continue
      const field = str(change.field) ?? 'replies'
      const value = asRecord(change.value)
      const naturalId = value ? str(value.id) ?? str(value.reply_id) ?? str(value.comment_id) : undefined
      items.push({ platformPageId, field, dedupeKey: dedupeKeyFor(field, naturalId, change), payload: change })
    }
    // Một số sự kiện Threads tới dạng `messaging[]` (giống Graph) — vẫn tách thành mục.
    for (const rawMsg of asArray(entry.messaging)) {
      const item = asRecord(rawMsg)
      if (!item) continue
      const { field, naturalId } = messagingField(item)
      items.push({ platformPageId, field, dedupeKey: dedupeKeyFor(field, naturalId, item), payload: item })
    }
  }
  return items
}
