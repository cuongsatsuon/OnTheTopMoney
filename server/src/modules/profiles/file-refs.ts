// Tra tham chiếu file của `profiles` (Story 9.3, AD-14): lượt dọn file mồ côi trên Cloudinary (ghép ở worker) hỏi public_id
// nào còn được dùng — file kho kiến thức (`knowledge_items.file_public_id`, tới lúc trích xong) và logo hồ sơ thương hiệu
// (`brand_profiles.logo_path` lưu URL công khai chứa public_id). Logo cũ bị thay thì không còn ai trỏ tới → được dọn.
import { inArray, isNotNull } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { brandProfiles, knowledgeItems } from './schema.ts'

export async function referencedProfileFiles(db: DbExecutor, publicIds: readonly string[]): Promise<Set<string>> {
  if (publicIds.length === 0) return new Set()
  const knowledge = await db
    .select({ id: knowledgeItems.filePublicId })
    .from(knowledgeItems)
    .where(inArray(knowledgeItems.filePublicId, [...publicIds]))
  const found = new Set(knowledge.map((r) => r.id).filter((id): id is string => id !== null))
  // Mỗi nhóm / trang tối đa một hồ sơ → ít dòng; so khớp `/<public_id>` trong URL (`…/upload/v123/<public_id>.png`).
  const logos = await db.select({ path: brandProfiles.logoPath }).from(brandProfiles).where(isNotNull(brandProfiles.logoPath))
  for (const id of publicIds) {
    if (logos.some((l) => l.path!.includes(`/${id}.`) || l.path!.endsWith(`/${id}`))) found.add(id)
  }
  return found
}
