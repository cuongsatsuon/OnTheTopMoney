// Kiểm một target có đăng được trên nền tảng của trang không (AD-13). Dùng đúng bảng ràng buộc của `packages/shared`
// (`publishIssues`) mà FE dùng để báo trên tab. Story 6.4 gọi trước MỌI chuyển tới `scheduled` (lên lịch, đăng
// ngay, duyệt, đăng lại); job đăng gọi lại lúc tới giờ.
import { publishIssues, type PublishIssue } from '@ottm/shared'
import { count, eq } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { getPage } from '../pages/index.ts'
import { postTargetMedia, postTargets } from './schema.ts'

/**
 * Ném `AppError(<vi phạm đầu tiên>, 422, {details: {targetId, pageId, issues}})` khi bài vi phạm luật nền tảng
 * (`POST_EMPTY`, `MEDIA_REQUIRED`, `CAPTION_TOO_LONG`, `TOO_MANY_HASHTAGS`). Target không có, hoặc trang đã gỡ → 404.
 * Không xét trạng thái kết nối của trang (6.4: `PAGE_DISCONNECTED` lúc đăng).
 */
export async function assertPublishable(db: DbExecutor, targetId: string): Promise<void> {
  const [target] = await db.select({ pageId: postTargets.pageId, caption: postTargets.caption }).from(postTargets).where(eq(postTargets.id, targetId))
  const page = target ? await getPage(db, target.pageId) : null
  if (!target || !page) throw new AppError('NOT_FOUND', 404, { message: 'Đích của bài không tồn tại', details: { targetId } })
  const [media] = await db.select({ n: count() }).from(postTargetMedia).where(eq(postTargetMedia.postTargetId, targetId))
  const issues: PublishIssue[] = publishIssues({ platform: page.platform, caption: target.caption, mediaCount: media?.n ?? 0 })
  const first = issues[0]
  if (first) {
    throw new AppError(first.code, 422, {
      message: `Bài chưa đăng được trên ${page.platform}`,
      details: { targetId, pageId: target.pageId, issues },
    })
  }
}
