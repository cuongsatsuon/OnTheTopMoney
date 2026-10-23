// Bình luận trong webhook Meta/Threads (AD-4, AD-6, Story 4.4): chuẩn hoá một mục `changes` (FB `feed`, IG `comments`,
// Threads `replies`) thành sự kiện bình luận dạng chung. Hàm thuần — không mạng, không DB, không log. Module gọi
// (`webhooks` → `inbox`) quyết định làm gì với kết quả.
// - FB `feed` (`item=comment`): `verb` `add` → bình luận mới; `edited` → sửa; `remove` → xoá; `hide`/`unhide` → ẩn/bỏ ẩn.
//   `from.id` là id người bình luận, `post_id` = `{pageId}_{postId}`, `parent_id` = bài (bình luận gốc) hoặc bình luận
//   gốc (trả lời), `created_time` là giây epoch. Ảnh/video kèm bình luận ở `photo`/`video` (URL CDN).
// - IG `comments`: `id` = id bình luận, `media.id` = bài, `from {id, username}`, `parent_id` khi là trả lời. Không có
//   thời điểm, không có sự kiện sửa/xoá.
// - Threads `replies` [ASSUMPTION AD-4]: `id`, `username`, `text`, `timestamp` (ISO), `replied_to.id`, `root_post {id,
//   owner_id}`, `media_type`/`media_url`. Không có id người trả lời → định danh `@username` (khi không có `from.id`).
// - Bình luận của chính trang (`from.id` = id trang, username = handle trang) → `page_comment` (Story 4.5: `inbox`
//   khớp với trả lời công khai app đã gửi, hoặc coi là chủ shop trả lời ngoài app).
import type { MessageRemoval } from '@ottm/shared'
import { normalizeWebhookPostId } from './normalize.ts'
import type { DmAttachment } from './webhook-message.ts'

/** Trang đã khớp ở `webhook.route` — để nhận diện bình luận do chính trang viết và chuẩn hoá id bài FB. */
export interface CommentPageRef {
  platformAccountId: string
  /** Username/handle của trang (Threads) — so khớp không phân biệt hoa thường, bỏ `@`. */
  handle?: string | null
}

export interface CommentAuthor {
  /** Id người bình luận theo nền tảng (Threads thiếu id → `@username`) — khoá định danh theo trang. */
  id: string
  name: string | null
  username: string | null
}

export interface NewComment {
  kind: 'comment'
  /** Id bình luận / bài trả lời — `platform_message_id` của tin. */
  commentId: string
  /** Bình luận cha (trả lời trong luồng); `null` khi bình luận nằm trực tiếp trên bài. */
  parentId: string | null
  /** Id bài được bình luận, dạng chuẩn AD-6. */
  platformPostId: string
  author: CommentAuthor
  text: string | null
  timestamp: Date
  attachments: DmAttachment[]
}

export interface CommentEdit {
  kind: 'edit'
  commentId: string
  text: string | null
  timestamp: Date
}

export interface CommentRemoval {
  kind: 'remove'
  commentId: string
  removal: MessageRemoval
  timestamp: Date
}

export interface CommentUnhide {
  kind: 'unhide'
  commentId: string
}

/** Bình luận / trả lời do chính trang viết (Story 4.5) — cùng trường với `NewComment`, không có tác giả. */
export interface PageComment {
  kind: 'page_comment'
  commentId: string
  /** Bình luận được trả lời; `null` khi trang bình luận thẳng trên bài (không thuộc hội thoại nào). */
  parentId: string | null
  platformPostId: string
  text: string | null
  timestamp: Date
  attachments: DmAttachment[]
}

export type CommentSkipReason =
  /** Không phải bình luận (bài mới, reaction, share, `verb` lạ…). */
  | 'not_comment'
  /** Thiếu id bình luận / tác giả / bài. */
  | 'malformed'

export type NormalizedComment =
  | NewComment
  | PageComment
  | CommentEdit
  | CommentRemoval
  | CommentUnhide
  | { kind: 'skip'; reason: CommentSkipReason }

/** Bình luận mới → bình luận của trang khi tác giả là chính trang. */
const asPageComment = (c: NewComment): PageComment => ({
  kind: 'page_comment',
  commentId: c.commentId,
  parentId: c.parentId,
  platformPostId: c.platformPostId,
  text: c.text,
  timestamp: c.timestamp,
  attachments: c.attachments,
})

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const str = (v: unknown): string | undefined => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v)
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s === '' ? undefined : s
}

const textOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

const skip = (reason: CommentSkipReason): NormalizedComment => ({ kind: 'skip', reason })

/**
 * Thời điểm của nền tảng: số giây epoch (FB `created_time`; số lớn hơn 1e12 coi là mili giây) hoặc chuỗi ISO
 * (Threads `2024-08-09T18:07:57+0000` — chuẩn hoá `+0000` thành `+00:00`). Không đọc được → `fallback`.
 */
export function parsePlatformTime(raw: unknown, fallback: Date): Date {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return new Date(raw > 1e12 ? raw : raw * 1000)
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (/^\d+$/.test(s)) return parsePlatformTime(Number(s), fallback)
    const ms = Date.parse(s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
    if (Number.isFinite(ms)) return new Date(ms)
  }
  return fallback
}

/** Ảnh/video kèm bình luận (URL CDN) → đính kèm; host được kiểm lúc tải. */
function mediaAttachments(photo: unknown, video: unknown): DmAttachment[] {
  const out: DmAttachment[] = []
  const p = str(photo)
  if (p) out.push({ kind: 'image', url: p })
  const v = str(video)
  if (v) out.push({ kind: 'video', url: v })
  return out
}

const sameHandle = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const norm = (s: string | null | undefined) => (s ?? '').trim().replace(/^@/, '').toLowerCase()
  return norm(a) !== '' && norm(a) === norm(b)
}

/** Mục `feed` của Fanpage (`{field:'feed', value}`) → sự kiện bình luận. `fallbackTime` khi Meta không gửi thời điểm. */
export function normalizeFeedChange(change: unknown, page: CommentPageRef, fallbackTime: Date): NormalizedComment {
  const value = asRecord(asRecord(change)?.value)
  if (!value || str(value.item) !== 'comment') return skip('not_comment')
  const commentId = str(value.comment_id)
  const verb = str(value.verb) ?? 'add'
  if (!['add', 'edited', 'remove', 'hide', 'unhide'].includes(verb)) return skip('not_comment')
  if (!commentId) return skip('malformed')
  if (verb === 'edited') return { kind: 'edit', commentId, text: textOf(value.message), timestamp: fallbackTime }
  if (verb === 'remove' || verb === 'hide') {
    return { kind: 'remove', commentId, removal: verb === 'remove' ? 'deleted' : 'hidden', timestamp: fallbackTime }
  }
  if (verb === 'unhide') return { kind: 'unhide', commentId }

  const from = asRecord(value.from)
  const authorId = str(from?.id)
  if (!authorId) return skip('malformed')
  const rawPostId = str(value.post_id) ?? str(asRecord(value.post)?.id)
  if (!rawPostId) return skip('malformed')
  // Id bài của trang khác (bình luận trên bài được chia sẻ…) không ghép được → giữ nguyên id Meta gửi.
  const platformPostId = normalizeWebhookPostId('facebook', rawPostId, page.platformAccountId) ?? rawPostId
  const rawParent = str(value.parent_id)
  const parentId = rawParent && rawParent !== rawPostId && rawParent !== platformPostId ? rawParent : null
  const comment: NewComment = {
    kind: 'comment',
    commentId,
    parentId,
    platformPostId,
    author: { id: authorId, name: textOf(from?.name)?.trim() ?? null, username: null },
    text: textOf(value.message),
    timestamp: parsePlatformTime(value.created_time, fallbackTime),
    attachments: mediaAttachments(value.photo, value.video),
  }
  return authorId === page.platformAccountId ? asPageComment(comment) : comment
}

/** Mục IG `comments` (`{field:'comments', value}`) → bình luận mới. IG không gửi sửa/xoá bình luận qua webhook. */
export function normalizeInstagramComment(change: unknown, page: CommentPageRef, fallbackTime: Date): NormalizedComment {
  const value = asRecord(asRecord(change)?.value)
  if (!value) return skip('not_comment')
  const commentId = str(value.id) ?? str(value.comment_id)
  const from = asRecord(value.from)
  const authorId = str(from?.id)
  const media = asRecord(value.media)
  const platformPostId = normalizeWebhookPostId('instagram', media?.id ?? value.media_id)
  if (!commentId || !authorId || !platformPostId) return skip('malformed')
  const parent = str(value.parent_id)
  const comment: NewComment = {
    kind: 'comment',
    commentId,
    parentId: parent && parent !== commentId ? parent : null,
    platformPostId,
    author: { id: authorId, name: null, username: str(from?.username) ?? null },
    text: textOf(value.text),
    timestamp: parsePlatformTime(value.timestamp, fallbackTime),
    attachments: [],
  }
  const fromPage = authorId === page.platformAccountId || sameHandle(str(from?.username), page.handle)
  return fromPage ? asPageComment(comment) : comment
}

/** Mục Threads `replies` (`{field:'replies', value}`) → trả lời mới. */
export function normalizeThreadsReply(change: unknown, page: CommentPageRef, fallbackTime: Date): NormalizedComment {
  const value = asRecord(asRecord(change)?.value)
  if (!value) return skip('not_comment')
  const commentId = str(value.id) ?? str(value.reply_id)
  const username = str(value.username) ?? str(asRecord(value.from)?.username)
  const fromId = str(asRecord(value.from)?.id)
  const authorId = fromId ?? (username ? `@${username.replace(/^@/, '')}` : undefined)
  const rootPost = asRecord(value.root_post)
  const platformPostId = normalizeWebhookPostId('threads', rootPost?.id)
  if (!commentId || !authorId || !platformPostId) return skip('malformed')
  const repliedTo = str(asRecord(value.replied_to)?.id)
  const mediaType = str(value.media_type)
  const mediaUrl = str(value.media_url)
  const comment: NewComment = {
    kind: 'comment',
    commentId,
    parentId: repliedTo && repliedTo !== str(rootPost?.id) && repliedTo !== commentId ? repliedTo : null,
    platformPostId,
    author: { id: authorId, name: null, username: username?.replace(/^@/, '') ?? null },
    text: textOf(value.text),
    timestamp: parsePlatformTime(value.timestamp, fallbackTime),
    attachments: mediaUrl ? mediaAttachments(mediaType === 'IMAGE' ? mediaUrl : undefined, mediaType === 'VIDEO' ? mediaUrl : undefined) : [],
  }
  return fromId === page.platformAccountId || sameHandle(username, page.handle) ? asPageComment(comment) : comment
}
