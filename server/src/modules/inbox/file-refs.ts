// Tra tham chiếu file của `inbox` (Story 9.3, AD-14): lượt dọn file mồ côi trên Cloudinary (ghép ở worker) hỏi public_id nào
// còn dòng `message_attachments` trỏ tới. File riêng tư của khách mà dòng đã mất (ghi `stored` lỗi sau khi tải lên, cửa sổ
// đua của luồng xoá 9.2) thì không có ở đây → bị dọn khi đủ tuổi.
import { inArray } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { messageAttachments } from './schema.ts'

export async function referencedAttachmentFiles(db: DbExecutor, publicIds: readonly string[]): Promise<Set<string>> {
  if (publicIds.length === 0) return new Set()
  const rows = await db
    .select({ id: messageAttachments.filePublicId })
    .from(messageAttachments)
    .where(inArray(messageAttachments.filePublicId, [...publicIds]))
  return new Set(rows.map((r) => r.id).filter((id): id is string => id !== null))
}
