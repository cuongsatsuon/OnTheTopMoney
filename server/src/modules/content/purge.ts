// Phần `content` của luồng xoá (Story 9.2, AD-22, AD-1) — chỉ `scope=page|all`: queue `content.purge` nghe
// `privacy.purge_requested` → xoá mọi `post_targets` của `pageIds` (mọi trạng thái; `post_target_media` và `post_metrics`
// của `analytics` đi theo khoá ngoại cascade), bài không còn đích nào, rồi ảnh vừa thành không gắn bài (dòng + file trên
// kho công khai), cuối cùng phát `privacy.purge_part_completed{module:'content'}`.
// - Theo lô, mỗi lô một transaction (target + bài rỗng cùng lô nên chạy lại không để bài mồ côi). Job `publish.target` còn
//   chờ của target đã xoá tự bỏ qua (không thấy dòng).
// - Ảnh: xoá dòng trước (điều kiện "không gắn" lặp lại ngay trong lệnh xoá), rồi file — như cron `content.media_gc`. Xoá
//   file lỗi → file thành mồ côi trên kho (log, việc dọn mồ côi theo prefix còn hoãn). Ảnh ở bài khác vẫn gắn → giữ.
//   Tập ảnh cần dọn chỉ nằm trong bộ nhớ của lượt chạy: worker chết sau khi xoá target thì ảnh đã không gắn bài, cron
//   `content.media_gc` dọn nốt (ảnh quá 7 ngày).
// Bài của trang khác, ảnh tự tải lên chưa gắn bài, hồ sơ, kho kiến thức không bị đụng.
import { PURGE_MODULES } from '@ottm/shared'
import { and, eq, inArray, notExists, sql } from 'drizzle-orm'
import type { MediaStores } from '../../adapters/media/index.ts'
import type { Db } from '../../platform/db/index.ts'
import { envelopePayload, type EventPublisher } from '../../platform/events/index.ts'
import type { Logger } from '../../platform/log/index.ts'
import { mediaAssets, postTargetMedia, postTargets, posts } from './schema.ts'

export const PURGE_BATCH = 200

export interface ContentPurgeDeps {
  db: Db
  events: EventPublisher
  media: Pick<MediaStores, 'configured' | 'publicStore'>
  log?: Logger | undefined
  batchSize?: number
}

export interface ContentPurgeResult {
  requestId: string
  targets: number
  posts: number
  media: number
  fileErrors: number
}

const notAttached = notExists(sql`(select 1 from ${postTargetMedia} where ${postTargetMedia.mediaAssetId} = ${mediaAssets.id})`)

export async function handleContentPurge(deps: ContentPurgeDeps, data: unknown): Promise<ContentPurgeResult | 'ignored'> {
  const p = envelopePayload(data, 'privacy.purge_requested')
  if (!p || !PURGE_MODULES[p.scope].includes('content')) return 'ignored'
  const pageIds = p.pageIds ?? []
  const batch = deps.batchSize ?? PURGE_BATCH
  const result: ContentPurgeResult = { requestId: p.id, targets: 0, posts: 0, media: 0, fileErrors: 0 }
  const detachedMedia = new Set<string>()

  while (pageIds.length > 0) {
    const done = await deps.db.transaction(async (tx) => {
      const ids = (await tx.select({ id: postTargets.id }).from(postTargets).where(inArray(postTargets.pageId, pageIds)).limit(batch).for('update')).map((r) => r.id)
      if (ids.length === 0) return 0
      const media = await tx.select({ id: postTargetMedia.mediaAssetId }).from(postTargetMedia).where(inArray(postTargetMedia.postTargetId, ids))
      for (const m of media) detachedMedia.add(m.id)
      const removed = await tx.delete(postTargets).where(inArray(postTargets.id, ids)).returning({ postId: postTargets.postId })
      const postIds = [...new Set(removed.map((r) => r.postId))]
      const emptied = await tx
        .delete(posts)
        .where(and(inArray(posts.id, postIds), notExists(sql`(select 1 from ${postTargets} where ${postTargets.postId} = ${posts.id})`)))
        .returning({ id: posts.id })
      result.targets += removed.length
      result.posts += emptied.length
      return ids.length
    })
    if (done < batch) break
  }

  // Kho chưa cấu hình: giữ dòng có file (xoá dòng thì file thành mồ côi vĩnh viễn) — cron `content.media_gc` dọn khi có kho.
  for (const id of detachedMedia) {
    let removed: { publicId: string | null }[]
    try {
      removed = await deps.db
        .delete(mediaAssets)
        .where(and(eq(mediaAssets.id, id), notAttached, deps.media.configured ? undefined : sql`${mediaAssets.publicId} is null`))
        .returning({ publicId: mediaAssets.publicId })
    } catch (err) {
      // Vừa được gắn vào bài khác (lỗi khoá ngoại) → giữ.
      const e = err as { code?: unknown; cause?: { code?: unknown } }
      if (e?.code === '23503' || e?.cause?.code === '23503') continue
      throw err
    }
    if (removed.length === 0) continue
    result.media++
    const publicId = removed[0]!.publicId
    if (publicId) {
      const res = await deps.media.publicStore.delete(publicId)
      if (!res.ok) {
        result.fileErrors++
        deps.log?.warn({ requestId: p.id, mediaAssetId: id, kind: res.kind }, 'content: không xoá được file ảnh của bài đã xoá')
      }
    }
  }

  await deps.db.transaction((tx) => deps.events.publishEvent(tx, 'privacy.purge_part_completed', { id: p.id, module: 'content' }))
  return result
}
