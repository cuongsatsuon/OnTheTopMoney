// Tra tham chiếu file của `content` (Story 9.3, AD-14): lượt dọn file mồ côi trên Cloudinary (ghép ở worker) hỏi public_id
// nào còn dòng `media_assets` trỏ tới — mọi trạng thái (ảnh đang gắn bài, ảnh chưa gắn chờ `content.media_gc`, ô AI). File
// có dòng thì `media_gc` lo theo hạn của nó; ở đây chỉ để không coi nhầm là mồ côi.
import { inArray } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { mediaAssets } from './schema.ts'

export async function referencedMediaFiles(db: DbExecutor, publicIds: readonly string[]): Promise<Set<string>> {
  if (publicIds.length === 0) return new Set()
  const rows = await db.select({ id: mediaAssets.publicId }).from(mediaAssets).where(inArray(mediaAssets.publicId, [...publicIds]))
  return new Set(rows.map((r) => r.id).filter((id): id is string => id !== null))
}
