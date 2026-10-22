// Chuẩn hoá id bài đăng (AD-6): id lấy khi đăng và id nhận từ webhook phải cùng một dạng,
// để module khác so khớp bằng `platformPostId` mà không cần biết quy ước riêng của từng nền tảng.
// - Facebook: `{pageId}_{postId}`. Đăng ảnh (`POST /{page}/photos`) trả `{id: <photo id>, post_id}` → dùng `post_id`.
// - Instagram: media id của BÀI (kết quả `media_publish`), không phải container id.
// - Threads: media id sau `threads_publish`.
import type { Platform } from '@ottm/shared'

export interface PublishedRef {
  platformPostId: string
  permalink?: string
}

const str = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v)
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s === '' ? undefined : s
}

const withPermalink = (platformPostId: string, permalink?: string): PublishedRef =>
  permalink ? { platformPostId, permalink } : { platformPostId }

/**
 * Id FB về dạng `{pageId}_{postId}`: chưa có `_` → ghép `pageId`; đã có `_` thì tiền tố phải đúng `pageId`
 * (tiền tố của trang khác → `null`). `pageId` rỗng → `null`.
 */
function facebookPostId(pageId: string, id: string): string | null {
  const page = pageId.trim()
  if (!page) return null
  const sep = id.indexOf('_')
  if (sep === -1) return `${page}_${id}`
  return id.slice(0, sep) === page && sep < id.length - 1 ? id : null
}

/**
 * Phản hồi đăng bài Page: `/feed` trả `{id: "{pageId}_{postId}"}`; `/photos` trả `{id: <photo id>, post_id}`.
 * Có `post_id` → dùng nó. Không có `post_id` thì chỉ nhận `id` đã ở dạng `{pageId}_{postId}` (bài feed): id ảnh trần
 * KHÔNG phải id bài (ghép `{pageId}_{photoId}` sẽ không bao giờ khớp `post_id` của webhook) → `null`.
 * `pageId` rỗng hoặc tiền tố là trang khác → `null`.
 */
export function publishedRefFromFacebook(
  pageId: string,
  response: { id?: unknown; post_id?: unknown } | null | undefined,
  permalink?: string,
): PublishedRef | null {
  const postId = str(response?.post_id)
  const id = str(response?.id)
  const candidate = postId ?? (id?.includes('_') ? id : undefined)
  if (!candidate) return null
  const normalized = facebookPostId(pageId, candidate)
  return normalized ? withPermalink(normalized, permalink) : null
}

/** Phản hồi `POST /{ig-user-id}/media_publish` → `{id: <media id>}`. Truyền phản hồi publish, KHÔNG phải container. */
export function publishedRefFromInstagram(
  publishResponse: { id?: unknown } | null | undefined,
  permalink?: string,
): PublishedRef | null {
  const id = str(publishResponse?.id)
  return id ? withPermalink(id, permalink) : null
}

/** Phản hồi `POST /{threads-user-id}/threads_publish` → `{id: <media id>}`. */
export function publishedRefFromThreads(
  publishResponse: { id?: unknown } | null | undefined,
  permalink?: string,
): PublishedRef | null {
  const id = str(publishResponse?.id)
  return id ? withPermalink(id, permalink) : null
}

/**
 * Id bài trong webhook → cùng dạng với `PublishedRef.platformPostId`.
 * FB: `post_id` đã là `{pageId}_{postId}` → giữ (khi có `pageId` thì tiền tố phải khớp); chỉ có phần sau thì cần
 * `pageId` để ghép, thiếu `pageId` → `null`. IG/Threads: media id giữ nguyên.
 */
export function normalizeWebhookPostId(platform: Platform, rawId: unknown, pageId?: string): string | null {
  const id = str(rawId)
  if (!id) return null
  if (platform !== 'facebook') return id
  if (pageId === undefined) {
    const sep = id.indexOf('_')
    return sep > 0 && sep < id.length - 1 ? id : null
  }
  return facebookPostId(pageId, id)
}
