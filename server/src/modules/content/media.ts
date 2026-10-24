// Ảnh bài (Story 6.1, AD-14): kiểm bytes trước khi tải lên kho công khai, ghi `media_assets` sau khi kho trả về.
// Route (`app/media-assets.ts`) lo tải lên Cloudinary; module chỉ kiểm và ghi — không gọi mạng.
// Story 6.3: dòng có thêm trạng thái (ô ảnh AI đang sinh / lỗi chưa có file) — DTO ảnh chỉ dựng từ dòng `ready`.
// Story 7.7: `lockUploadedImage` / `uploadedImagesById` — ảnh sản phẩm của chiến dịch (ảnh tải lên `ready`); `campaigns`
// kiểm và đọc qua đây, không đọc bảng `media_assets`.
import {
  IMAGE_PENDING_MS,
  POST_IMAGE_MAX_BYTES,
  type GeneratedImageDto,
  type ImageErrorCode,
  type MediaAssetDto,
  type MediaAssetSource,
  type MediaAssetStatus,
  type PostImageMime,
} from '@ottm/shared'
import type { StoredImage } from '../../adapters/media/index.ts'
import { eq, inArray } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { detectImageMime } from '../profiles/index.ts'
import { mediaAssets } from './schema.ts'

export const POST_IMAGE_VALIDATION = {
  /** Byte rỗng / vượt 10 MB. */
  tooLarge: 'Ảnh tối đa 10MB',
  /** Không nhận dạng được là PNG/JPEG/WebP (SVG, GIF, text bị từ chối). */
  notImage: 'Chỉ nhận ảnh PNG, JPEG hoặc WebP',
  /** Magic bytes không khớp MIME khai báo. */
  mismatch: 'Định dạng ảnh không khớp',
} as const

/**
 * Kiểm bytes ảnh bài trước khi gọi Cloudinary: 1 byte–10 MB, là PNG/JPEG/WebP theo magic bytes và khớp
 * `declaredMime`. Trả MIME đã xác nhận, hoặc câu lỗi (dưới ô ảnh). Không gọi mạng.
 */
export function validatePostImage(
  bytes: Uint8Array,
  declaredMime: PostImageMime,
): { ok: true; mime: PostImageMime } | { ok: false; message: string } {
  if (bytes.length === 0 || bytes.length > POST_IMAGE_MAX_BYTES) return { ok: false, message: POST_IMAGE_VALIDATION.tooLarge }
  const detected = detectImageMime(bytes)
  if (!detected) return { ok: false, message: POST_IMAGE_VALIDATION.notImage }
  if (detected !== declaredMime) return { ok: false, message: POST_IMAGE_VALIDATION.mismatch }
  return { ok: true, mime: detected }
}

export type MediaRow = typeof mediaAssets.$inferSelect

/** Ảnh có file (`ready`) → DTO. Dòng chưa có file là lỗi lập trình (chỉ ảnh `ready` được gắn / trả về như ảnh). */
export function toMediaAssetDto(row: MediaRow): MediaAssetDto {
  if (row.status !== 'ready' || row.url === null || row.width === null || row.height === null) {
    throw new Error(`media_assets ${row.id}: ảnh chưa sẵn sàng (${row.status})`)
  }
  return {
    id: row.id,
    source: row.source as MediaAssetSource,
    url: row.url,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Ô ảnh AI → DTO. Ô `pending` quá `IMAGE_PENDING_MS` (job mất / worker chết giữa chừng) đọc ra `failed IMAGE_FAILED`
 * để FE không chờ mãi; dòng giữ nguyên (cron dọn sau 7 ngày, job muộn vẫn có thể ghi `ready`).
 */
export function toGeneratedImageDto(row: MediaRow, now: Date): GeneratedImageDto {
  const stale = row.status === 'pending' && now.getTime() - row.createdAt.getTime() >= IMAGE_PENDING_MS
  const status: MediaAssetStatus = stale ? 'failed' : (row.status as MediaAssetStatus)
  return {
    id: row.id,
    status,
    errorCode: stale ? 'IMAGE_FAILED' : ((row.errorCode as ImageErrorCode | null) ?? null),
    asset: status === 'ready' ? toMediaAssetDto(row) : null,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Ghi một ảnh đã nằm trên kho công khai. Ném lỗi DB thì route xoá ảnh vừa tải (không bỏ lại file mồ côi). */
export async function recordMediaAsset(db: DbExecutor, source: MediaAssetSource, stored: StoredImage): Promise<MediaAssetDto> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      source,
      status: 'ready',
      publicId: stored.publicId,
      url: stored.url,
      width: stored.width,
      height: stored.height,
      bytes: stored.bytes,
      format: stored.format,
    })
    .returning()
  return toMediaAssetDto(row!)
}

/** Lý do một ảnh không dùng được làm ảnh sản phẩm (Story 7.7). */
export type UploadedImageProblem = 'missing' | 'not_ready' | 'not_upload'

/**
 * Story 7.7: kiểm ảnh tải lên dùng làm ảnh sản phẩm của chiến dịch, khoá dòng `FOR KEY SHARE` tới hết transaction của bên
 * gọi (cron dọn / xoá theo yêu cầu không xoá chen giữa lúc kiểm và lúc ghi khoá ngoại). `null` = dùng được.
 */
export async function lockUploadedImage(tx: DbExecutor, id: string): Promise<UploadedImageProblem | null> {
  const [row] = await tx.select({ status: mediaAssets.status, source: mediaAssets.source }).from(mediaAssets).where(eq(mediaAssets.id, id)).for('key share')
  if (!row) return 'missing'
  if (row.status !== 'ready') return 'not_ready'
  return row.source === 'upload' ? null : 'not_upload'
}

/** Story 7.7: DTO các ảnh `ready` theo id (id không có / chưa `ready` thì bỏ) — đọc ảnh sản phẩm của nhiều chiến dịch một lần. */
export async function uploadedImagesById(db: DbExecutor, ids: readonly string[]): Promise<Map<string, MediaAssetDto>> {
  if (!ids.length) return new Map()
  const rows = await db.select().from(mediaAssets).where(inArray(mediaAssets.id, [...new Set(ids)]))
  return new Map(rows.filter((r) => r.status === 'ready' && r.url !== null).map((r) => [r.id, toMediaAssetDto(r)]))
}
