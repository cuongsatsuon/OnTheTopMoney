// Cron `content.media_gc` (Story 6.3, AD-14): xoá ảnh bài không gắn vào bài nào quá 7 ngày [ASSUMPTION] — ảnh AI chủ
// shop không chọn, ảnh tải lên rồi bỏ, ô ảnh AI lỗi / kẹt không có file. Ảnh đang gắn vào target (nháp, đã lên lịch,
// đã đăng) luôn giữ. Chỉ dọn theo DB; file trên Cloudinary không có dòng nào trỏ tới do cron `privacy.orphan_files` dọn
// (Story 9.3).
// Mỗi dòng: xoá dòng trước (điều kiện "không gắn" lặp lại ngay trong lệnh xoá), rồi xoá file — ngược lại thì một ảnh
// vừa được gắn có thể mất file. Lưu nháp khoá dòng ảnh `FOR KEY SHARE` (`posts.ts`) nên lệnh xoá chen vào chỉ gặp lỗi
// khoá ngoại → bỏ qua dòng đó.
// Story 6.6: ảnh còn ô ảnh AI trỏ tới (`reference_asset_id`, mọi trạng thái) là ảnh tham khảo đang được dùng → giữ; ô
// con bị dọn (sau 7 ngày của chính nó) thì lượt sau mới dọn ảnh tham khảo.
// Story 7.7: ảnh sản phẩm của chiến dịch còn tồn tại (`campaigns.product_image_id`, khoá ngoại không cascade) → giữ. `content`
// không biết bảng `campaigns` (AD-1): worker hỏi `campaigns` rồi truyền `keep`; khoá ngoại là lưới an toàn (chiến dịch tạo
// chen giữa → lỗi khoá ngoại, bỏ qua). `keep` để các dòng bị khoá ngoại chặn không chiếm lô mỗi ngày.
import { DAY_MS, RETENTION } from '@ottm/shared'
import { and, asc, eq, lt, notExists, notInArray, sql } from 'drizzle-orm'
import type { MediaStores } from '../../adapters/media/index.ts'
import type { Db } from '../../platform/db/index.ts'
import type { Logger } from '../../platform/log/index.ts'
import { mediaAssets, postTargetMedia } from './schema.ts'

/** Ảnh không gắn bài cũ hơn mức này thì bị dọn [ASSUMPTION AD-14]. */
export const MEDIA_GC_AFTER_MS = RETENTION.unattachedImageDays * DAY_MS
/** Số dòng tối đa mỗi lần chạy (cron hằng ngày — phần còn lại để ngày sau). */
export const MEDIA_GC_BATCH = 500

export interface MediaGcDeps {
  db: Db
  media: Pick<MediaStores, 'configured' | 'publicStore'>
  log?: Logger
  now?: () => Date
  /** Story 7.7: ảnh còn được nơi khác dùng (ảnh sản phẩm của chiến dịch — worker ghép) → không xoá. */
  keep?: readonly string[]
}

export interface MediaGcResult {
  /** Dòng đã xoá. */
  deleted: number
  /** Dòng bỏ qua vì vừa được gắn vào bài (lỗi khoá ngoại). */
  skipped: number
  /** File Cloudinary xoá lỗi (dòng đã xoá — file thành mồ côi trên kho). */
  fileErrors: number
}

const notAttached = notExists(sql`(select 1 from ${postTargetMedia} where ${postTargetMedia.mediaAssetId} = ${mediaAssets.id})`)
/** Không ô ảnh AI nào lấy ảnh này làm ảnh tham khảo (bảng con đặt bí danh `c`; `media_assets` bên ngoài là dòng đang xét). */
const notReference = notExists(sql`(select 1 from ${mediaAssets} c where c.reference_asset_id = ${mediaAssets.id})`)

/** Lỗi khoá ngoại của Postgres (Drizzle bọc lỗi gốc trong `cause`). */
function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null
  return e?.code === '23503' || e?.cause?.code === '23503'
}

export async function gcOrphanMedia(deps: MediaGcDeps): Promise<MediaGcResult> {
  const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - MEDIA_GC_AFTER_MS)
  const kept = deps.keep?.length ? notInArray(mediaAssets.id, [...deps.keep]) : undefined
  const old = and(lt(mediaAssets.createdAt, cutoff), notAttached, notReference, kept)
  const candidates = await deps.db
    .select({ id: mediaAssets.id, publicId: mediaAssets.publicId })
    .from(mediaAssets)
    // Kho chưa cấu hình: chỉ dọn dòng không có file (xoá dòng có file thì file thành mồ côi vĩnh viễn).
    .where(deps.media.configured ? old : and(old, sql`${mediaAssets.publicId} is null`))
    .orderBy(asc(mediaAssets.createdAt))
    .limit(MEDIA_GC_BATCH)

  const result: MediaGcResult = { deleted: 0, skipped: 0, fileErrors: 0 }
  for (const c of candidates) {
    let removed: boolean
    try {
      const rows = await deps.db
        .delete(mediaAssets)
        .where(and(eq(mediaAssets.id, c.id), lt(mediaAssets.createdAt, cutoff), notAttached, notReference))
        .returning({ id: mediaAssets.id })
      removed = rows.length > 0
    } catch (err) {
      if (!isForeignKeyViolation(err)) throw err
      removed = false
    }
    if (!removed) {
      result.skipped++
      continue
    }
    result.deleted++
    if (c.publicId) {
      const res = await deps.media.publicStore.delete(c.publicId)
      if (!res.ok) {
        result.fileErrors++
        deps.log?.warn({ mediaAssetId: c.id, kind: res.kind }, 'content: không xoá được file ảnh mồ côi trên kho')
      }
    }
  }
  return result
}
