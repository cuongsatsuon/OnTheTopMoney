// Bài và đích từng trang (Story 6.1, AD-13). `createPost` là cửa DUY NHẤT tạo `posts` + `post_targets` (Soạn bài;
// Epic 7 tạo slot chiến dịch cũng qua đây). Nháp thủ công sửa bằng `updateDraftPost` (thay toàn bộ đích) khi mọi
// target còn `draft`; lên lịch/đăng/huỷ là việc của `transitionTarget` (Story 6.4).
// Nháp được lưu cả khi còn vi phạm luật nền tảng — luật chỉ chặn khi lên lịch (`assertPublishable`).
import type { ErrorCode, ParsedSavePostRequest, PostDto, PostSource, PostTargetDto, PostTargetStatus } from '@ottm/shared'
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { getPage } from '../pages/index.ts'
import { toMediaAssetDto } from './media.ts'
import { mediaAssets, postTargetMedia, postTargets, posts } from './schema.ts'

export interface CreatePostInput extends ParsedSavePostRequest {
  /** Story 6.1 chỉ tạo bài thủ công; `campaign` mở ở Epic 7 (kèm `campaignId`, `slot_at`). */
  source: Extract<PostSource, 'manual'>
}

interface FieldIssue {
  path: (string | number)[]
  message: string
}

/**
 * Trang phải tồn tại và chưa gỡ (trang `disconnected` vẫn lưu nháp được — 6.4 chặn lúc đăng); ảnh phải là
 * `media_assets` có thật và đã `ready` (ô ảnh AI đang sinh / lỗi chưa có file — Story 6.3). Gom mọi lỗi rồi ném một
 * `VALIDATION_FAILED` với `path` trỏ đúng dòng. Dòng ảnh khoá `FOR KEY SHARE` tới hết transaction: cron
 * `content.media_gc` không xoá chen được ảnh đang được gắn (lệnh xoá của cron chờ rồi gặp khoá ngoại, bỏ qua dòng đó).
 */
async function assertTargetsValid(db: DbExecutor, targets: ParsedSavePostRequest['targets']): Promise<void> {
  const issues: FieldIssue[] = []
  for (const [i, t] of targets.entries()) {
    if (!(await getPage(db, t.pageId))) issues.push({ path: ['targets', i, 'pageId'], message: 'Trang không tồn tại hoặc đã gỡ' })
  }
  const mediaIds = [...new Set(targets.flatMap((t) => t.mediaIds))]
  const known = mediaIds.length
    ? new Map(
        (
          await db
            .select({ id: mediaAssets.id, status: mediaAssets.status })
            .from(mediaAssets)
            .where(inArray(mediaAssets.id, mediaIds))
            .for('key share')
        ).map((r) => [r.id, r.status]),
      )
    : new Map<string, string>()
  for (const [i, t] of targets.entries()) {
    for (const [j, id] of t.mediaIds.entries()) {
      const status = known.get(id)
      if (status === undefined) issues.push({ path: ['targets', i, 'mediaIds', j], message: 'Ảnh không tồn tại' })
      else if (status !== 'ready') issues.push({ path: ['targets', i, 'mediaIds', j], message: 'Ảnh chưa sẵn sàng' })
    }
    if (new Set(t.mediaIds).size !== t.mediaIds.length) issues.push({ path: ['targets', i, 'mediaIds'], message: 'Ảnh bị chọn hai lần' })
  }
  if (issues.length) throw new AppError('VALIDATION_FAILED', 400, { message: 'Đích của bài không hợp lệ', details: issues })
}

async function insertTargetMedia(db: DbExecutor, targetId: string, mediaIds: readonly string[]): Promise<void> {
  if (!mediaIds.length) return
  await db.insert(postTargetMedia).values(mediaIds.map((mediaAssetId, position) => ({ postTargetId: targetId, mediaAssetId, position })))
}

/**
 * Tạo một bài + mỗi trang một target `draft` (caption/ảnh riêng). Chạy trong transaction của bên gọi để bài và
 * mọi target cùng có hoặc cùng không.
 */
export async function createPost(tx: DbExecutor, input: CreatePostInput): Promise<PostDto> {
  await assertTargetsValid(tx, input.targets)
  const [post] = await tx.insert(posts).values({ source: input.source, topic: input.topic }).returning({ id: posts.id })
  for (const [position, t] of input.targets.entries()) {
    const [row] = await tx
      .insert(postTargets)
      .values({ postId: post!.id, pageId: t.pageId, position, status: 'draft' satisfies PostTargetStatus, caption: t.caption })
      .returning({ id: postTargets.id })
    await insertTargetMedia(tx, row!.id, t.mediaIds)
  }
  return (await getPost(tx, post!.id))!
}

/**
 * Thay toàn bộ đích của một nháp thủ công (khoá dòng `posts` để hai lần lưu không đan nhau): trang bỏ chọn → xoá
 * target nháp; trang giữ lại → caption/ảnh/thứ tự mới, `version + 1`; trang mới → target `draft`.
 * Bài không có → 404; không phải bài thủ công hoặc có target đã rời `draft` → 409 (sửa bài đã lên lịch thuộc 6.4/6.5).
 */
export async function updateDraftPost(tx: DbExecutor, postId: string, input: ParsedSavePostRequest): Promise<PostDto> {
  const [post] = await tx.select({ source: posts.source }).from(posts).where(eq(posts.id, postId)).for('update')
  if (!post) throw new AppError('NOT_FOUND', 404, { message: 'Bài không tồn tại', details: { postId } })
  if (post.source !== 'manual') throw new AppError('VERSION_CONFLICT', 409, { message: 'Chỉ sửa được bài soạn tay' })
  // Khoá cả các dòng target: chuyển trạng thái (6.4 `transitionTarget`) chỉ khoá `post_targets`, không khoá `posts`.
  // Không khoá thì target vừa được lên lịch sau lần đọc này vẫn bị ghi đè caption/ảnh hoặc bị xoá.
  const current = await tx
    .select({ id: postTargets.id, pageId: postTargets.pageId, status: postTargets.status })
    .from(postTargets)
    .where(eq(postTargets.postId, postId))
    .for('update')
  if (current.some((t) => t.status !== 'draft')) throw new AppError('VERSION_CONFLICT', 409, { message: 'Bài đã rời trạng thái nháp' })
  await assertTargetsValid(tx, input.targets)

  const keepPageIds = input.targets.map((t) => t.pageId)
  await tx.delete(postTargets).where(and(eq(postTargets.postId, postId), notInArray(postTargets.pageId, keepPageIds)))
  const byPage = new Map(current.map((t) => [t.pageId, t.id]))
  for (const [position, t] of input.targets.entries()) {
    const existing = byPage.get(t.pageId)
    if (existing) {
      await tx
        .update(postTargets)
        .set({ caption: t.caption, position, version: sql`${postTargets.version} + 1`, updatedAt: sql`now()` })
        .where(eq(postTargets.id, existing))
      await tx.delete(postTargetMedia).where(eq(postTargetMedia.postTargetId, existing))
      await insertTargetMedia(tx, existing, t.mediaIds)
    } else {
      const [row] = await tx
        .insert(postTargets)
        .values({ postId, pageId: t.pageId, position, status: 'draft' satisfies PostTargetStatus, caption: t.caption })
        .returning({ id: postTargets.id })
      await insertTargetMedia(tx, row!.id, t.mediaIds)
    }
  }
  await tx.update(posts).set({ topic: input.topic, updatedAt: sql`now()` }).where(eq(posts.id, postId))
  return (await getPost(tx, postId))!
}

/** Một bài kèm target (theo thứ tự tab) và ảnh (theo thứ tự đăng); `null` khi không có. */
export async function getPost(db: DbExecutor, postId: string): Promise<PostDto | null> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId))
  if (!post) return null
  const targets = await db.select().from(postTargets).where(eq(postTargets.postId, postId)).orderBy(asc(postTargets.position))
  const media = targets.length
    ? await db
        .select({ targetId: postTargetMedia.postTargetId, asset: mediaAssets })
        .from(postTargetMedia)
        .innerJoin(mediaAssets, eq(mediaAssets.id, postTargetMedia.mediaAssetId))
        .where(inArray(postTargetMedia.postTargetId, targets.map((t) => t.id)))
        .orderBy(asc(postTargetMedia.position))
    : []
  return {
    id: post.id,
    source: post.source as PostSource,
    topic: post.topic,
    targets: targets.map(
      (t): PostTargetDto => ({
        id: t.id,
        pageId: t.pageId,
        status: t.status as PostTargetStatus,
        caption: t.caption,
        media: media.filter((m) => m.targetId === t.id).map((m) => toMediaAssetDto(m.asset)),
        version: t.version,
        scheduledAt: t.scheduledAt?.toISOString() ?? null,
        errorCode: (t.errorCode as ErrorCode | null) ?? null,
      }),
    ),
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  }
}
