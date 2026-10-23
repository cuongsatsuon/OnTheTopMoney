// Ảnh bài (Story 6.1, AD-14): kiểm bytes trước khi tải lên kho công khai, ghi `media_assets` sau khi kho trả về.
// Route (`app/media-assets.ts`) lo tải lên Cloudinary; module chỉ kiểm và ghi — không gọi mạng.
import { POST_IMAGE_MAX_BYTES, type MediaAssetDto, type MediaAssetSource, type PostImageMime } from '@ottm/shared'
import type { StoredImage } from '../../adapters/media/index.ts'
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

type MediaRow = typeof mediaAssets.$inferSelect

export function toMediaAssetDto(row: MediaRow): MediaAssetDto {
  return {
    id: row.id,
    source: row.source as MediaAssetSource,
    url: row.url,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Ghi một ảnh đã nằm trên kho công khai. Ném lỗi DB thì route xoá ảnh vừa tải (không bỏ lại file mồ côi). */
export async function recordMediaAsset(db: DbExecutor, source: MediaAssetSource, stored: StoredImage): Promise<MediaAssetDto> {
  const [row] = await db
    .insert(mediaAssets)
    .values({
      source,
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
