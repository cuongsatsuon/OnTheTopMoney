// Đính kèm của khách (Story 4.3, AD-11, AD-14): job `inbox.fetch_attachment` tải link CDN Meta (qua
// `adapters/meta`, chỉ host CDN Meta) rồi lưu `PrivateFileStore` (Cloudinary `authenticated`). Không gọi mạng trong
// transaction. Chống trùng bằng `UPDATE … WHERE status='pending'`.
// - Thành công → `stored` + ref file, xoá `source_url`; phát `message.updated`.
// - Lỗi tạm (CDN/kho 5xx, chặn tần suất) → ném `AttachmentRetryableError` để pg-boss retry; lần thử cuối → `failed`
//   `FETCH_FAILED`.
// - Lỗi cố định (host lạ, MIME lạ, quá lớn, link hết hạn, kho chưa cấu hình) → `failed` + mã ngay, không retry.
// `getAttachmentFile` đọc bytes cho `GET /api/v1/attachments/:id`. Không log URL (có chữ ký) hay nội dung.
import { PRIVATE_FILE_MIMES, type MediaStores, type PrivateFileMime, type PrivateFileRef } from '../../adapters/media/index.ts'
import {
  downloadWebhookAttachment,
  type AttachmentDownloadResult,
} from '../../adapters/meta/index.ts'
import type { AttachmentError } from '@ottm/shared'
import { and, eq } from 'drizzle-orm'
import type { Db, Tx } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { getPage } from '../pages/index.ts'
import { messageAttachments, messages } from './schema.ts'

export interface FetchAttachmentDeps {
  db: Db
  events: EventPublisher
  media: Pick<MediaStores, 'configured' | 'privateStore'>
  /** Tải link CDN — mặc định `downloadWebhookAttachment` (test tiêm bản giả). */
  download?: (url: string) => Promise<AttachmentDownloadResult>
}

export type FetchAttachmentOutcome = 'stored' | 'failed' | 'skipped'

/** Lỗi tạm: handler ném lại để pg-boss retry. Không mang URL. */
export class AttachmentRetryableError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`inbox.fetch_attachment: ${kind}`)
    this.name = 'AttachmentRetryableError'
    this.kind = kind
  }
}

/** Biệt danh MIME hay gặp từ CDN → dạng chuẩn trong danh sách cho phép. */
const MIME_ALIASES: Readonly<Record<string, PrivateFileMime>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/mp3': 'audio/mpeg',
}

export function allowedMime(raw: string): PrivateFileMime | null {
  const mime = MIME_ALIASES[raw] ?? raw
  return (PRIVATE_FILE_MIMES as readonly string[]).includes(mime) ? (mime as PrivateFileMime) : null
}

export async function fetchAttachment(
  deps: FetchAttachmentDeps,
  attachmentId: string,
  opts: { finalAttempt: boolean },
): Promise<FetchAttachmentOutcome> {
  const [row] = await deps.db
    .select({ status: messageAttachments.status, sourceUrl: messageAttachments.sourceUrl })
    .from(messageAttachments)
    .where(eq(messageAttachments.id, attachmentId))
  if (!row || row.status !== 'pending') return 'skipped'
  if (!deps.media.configured) return markFailed(deps, attachmentId, 'MEDIA_NOT_CONFIGURED')
  if (!row.sourceUrl) return markFailed(deps, attachmentId, 'INVALID_URL')

  const retryOrFail = (kind: string): Promise<FetchAttachmentOutcome> => {
    if (opts.finalAttempt) return markFailed(deps, attachmentId, 'FETCH_FAILED')
    throw new AttachmentRetryableError(kind)
  }

  const downloaded = await (deps.download ?? downloadWebhookAttachment)(row.sourceUrl)
  if (!downloaded.ok) {
    switch (downloaded.kind) {
      case 'TRANSIENT':
      case 'RATE_LIMITED':
        return retryOrFail(downloaded.kind)
      case 'INVALID_URL':
        return markFailed(deps, attachmentId, 'INVALID_URL')
      case 'TOO_LARGE':
        return markFailed(deps, attachmentId, 'TOO_LARGE')
      default:
        // NOT_FOUND / REJECTED: link đã hết hạn hoặc bị từ chối — thử lại cũng vậy.
        return markFailed(deps, attachmentId, 'FETCH_FAILED')
    }
  }
  const mime = allowedMime(downloaded.mime)
  if (!mime) return markFailed(deps, attachmentId, 'UNSUPPORTED_TYPE')

  const put = await deps.media.privateStore.put({ data: downloaded.data, mime })
  if (!put.ok) {
    switch (put.kind) {
      case 'TRANSIENT':
      case 'RATE_LIMITED':
        return retryOrFail(`MEDIA_${put.kind}`)
      case 'MEDIA_NOT_CONFIGURED':
        return markFailed(deps, attachmentId, 'MEDIA_NOT_CONFIGURED')
      case 'INVALID_REQUEST':
        // File hỏng / Cloudinary không nhận định dạng này.
        return markFailed(deps, attachmentId, 'UNSUPPORTED_TYPE')
      default:
        return markFailed(deps, attachmentId, 'FETCH_FAILED')
    }
  }

  const ref: PrivateFileRef = { publicId: put.publicId, resourceType: put.resourceType, format: put.format }
  const stored = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(messageAttachments)
      .set({
        status: 'stored',
        sourceUrl: null,
        filePublicId: ref.publicId,
        fileResourceType: ref.resourceType,
        fileFormat: ref.format,
        mime,
        bytes: put.bytes,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(and(eq(messageAttachments.id, attachmentId), eq(messageAttachments.status, 'pending')))
      .returning({ messageId: messageAttachments.messageId })
    if (!updated) return false
    await publishUpdated(deps, tx, updated.messageId)
    return true
  })
  if (!stored) {
    // Lần chạy khác đã xử lý xong trước → bỏ file vừa tải lên (best-effort, xoá idempotent).
    await deps.media.privateStore.delete(ref).catch(() => {})
    return 'skipped'
  }
  return 'stored'
}

async function markFailed(deps: FetchAttachmentDeps, attachmentId: string, errorCode: AttachmentError): Promise<FetchAttachmentOutcome> {
  return deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(messageAttachments)
      .set({ status: 'failed', errorCode, sourceUrl: null, updatedAt: new Date() })
      .where(and(eq(messageAttachments.id, attachmentId), eq(messageAttachments.status, 'pending')))
      .returning({ messageId: messageAttachments.messageId })
    if (!updated) return 'skipped'
    await publishUpdated(deps, tx, updated.messageId)
    return 'failed'
  })
}

async function publishUpdated(deps: FetchAttachmentDeps, tx: Tx, messageId: string): Promise<void> {
  const [msg] = await tx
    .select({ conversationId: messages.conversationId, pageId: messages.pageId })
    .from(messages)
    .where(eq(messages.id, messageId))
  if (msg) await deps.events.publishEvent(tx, 'message.updated', { id: messageId, pageId: msg.pageId, conversationId: msg.conversationId })
}

/**
 * Handler job `inbox.fetch_attachment` cho worker (tách khỏi worker/main.ts để test nhánh lần thử cuối). Lần thử
 * chưa cuối gặp lỗi tạm → ném để pg-boss retry; lần cuối → `failed`.
 */
export function parseFetchAttachmentJobData(data: unknown): { attachmentId: string } {
  const id = (data as { attachmentId?: unknown } | null)?.attachmentId
  if (typeof id !== 'string' || id === '') throw new Error('inbox.fetch_attachment: thiếu attachmentId')
  return { attachmentId: id }
}

export async function handleFetchAttachmentJob(
  deps: FetchAttachmentDeps,
  job: { data: unknown; retryCount: number; retryLimit: number },
): Promise<FetchAttachmentOutcome> {
  const { attachmentId } = parseFetchAttachmentJobData(job.data)
  return fetchAttachment(deps, attachmentId, { finalAttempt: job.retryCount >= job.retryLimit })
}

export type AttachmentFileResult =
  | { ok: true; data: Buffer; mime: string; kind: string }
  | { ok: false; reason: 'not_found' | 'unavailable' }

/**
 * Bytes của một đính kèm đã lưu (cho API). Không có / chưa `stored` / trang đã gỡ → `not_found`; kho lỗi → `unavailable`.
 */
export async function getAttachmentFile(
  deps: { db: Db; media: Pick<MediaStores, 'privateStore'> },
  attachmentId: string,
): Promise<AttachmentFileResult> {
  const [row] = await deps.db
    .select({
      status: messageAttachments.status,
      kind: messageAttachments.kind,
      mime: messageAttachments.mime,
      publicId: messageAttachments.filePublicId,
      resourceType: messageAttachments.fileResourceType,
      format: messageAttachments.fileFormat,
      pageId: messages.pageId,
    })
    .from(messageAttachments)
    .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
    .where(eq(messageAttachments.id, attachmentId))
  if (!row || row.status !== 'stored' || !row.publicId || !row.resourceType || !row.mime) return { ok: false, reason: 'not_found' }
  // Trang đã gỡ → dữ liệu của nó không còn hiện trong app (như danh sách hội thoại).
  if (!(await getPage(deps.db, row.pageId))) return { ok: false, reason: 'not_found' }
  const got = await deps.media.privateStore.get({
    publicId: row.publicId,
    resourceType: row.resourceType as PrivateFileRef['resourceType'],
    format: row.format,
  })
  if (!got.ok) return { ok: false, reason: got.kind === 'NOT_FOUND' ? 'not_found' : 'unavailable' }
  return { ok: true, data: got.data, mime: row.mime, kind: row.kind }
}
