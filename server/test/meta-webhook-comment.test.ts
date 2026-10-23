// Story 4.4 — adapters/meta: chuẩn hoá bình luận FB `feed`, IG `comments`, trả lời Threads `replies` (bình luận mới,
// sửa, xoá/ẩn/bỏ ẩn, của chính trang, thiếu trường, id bài chuẩn AD-6, thời điểm). Thuần, không gọi mạng.
import { describe, expect, it } from 'vitest'
import { normalizeFeedChange, normalizeInstagramComment, normalizeThreadsReply, parsePlatformTime } from '../src/adapters/meta/index.ts'

const NOW = new Date('2026-10-23T03:00:00.000Z')
const FB = { platformAccountId: 'PAGE_1' }
const feed = (value: Record<string, unknown>) => ({
  field: 'feed',
  value: { item: 'comment', verb: 'add', comment_id: 'POST_C1', post_id: 'PAGE_1_POST', parent_id: 'PAGE_1_POST', from: { id: 'U1', name: 'Nguyễn Thu Hà' }, message: 'Còn hàng không shop?', created_time: 1_792_000_000, ...value },
})

describe('normalizeFeedChange (FB feed)', () => {
  it('bình luận mới trên bài → comment, parentId null, id bài chuẩn, tên từ from.name, thời điểm created_time', () => {
    expect(normalizeFeedChange(feed({}), FB, NOW)).toEqual({
      kind: 'comment',
      commentId: 'POST_C1',
      parentId: null,
      platformPostId: 'PAGE_1_POST',
      author: { id: 'U1', name: 'Nguyễn Thu Hà', username: null },
      text: 'Còn hàng không shop?',
      timestamp: new Date(1_792_000_000_000),
      attachments: [],
    })
  })

  it('trả lời bình luận → parentId = bình luận gốc; post_id chỉ phần sau → ghép id trang', () => {
    const c = normalizeFeedChange(feed({ comment_id: 'POST_C2', parent_id: 'POST_C1', post_id: 'POST' }), FB, NOW)
    expect(c).toMatchObject({ kind: 'comment', parentId: 'POST_C1', platformPostId: 'PAGE_1_POST' })
  })

  it('ảnh/video kèm bình luận → đính kèm; thiếu created_time → thời điểm dự phòng', () => {
    const c = normalizeFeedChange(feed({ photo: 'https://scontent.xx.fbcdn.net/a.jpg', video: 'https://video.xx.fbcdn.net/v.mp4', created_time: undefined, message: '' }), FB, NOW)
    expect(c).toMatchObject({
      kind: 'comment',
      text: null,
      timestamp: NOW,
      attachments: [
        { kind: 'image', url: 'https://scontent.xx.fbcdn.net/a.jpg' },
        { kind: 'video', url: 'https://video.xx.fbcdn.net/v.mp4' },
      ],
    })
  })

  it('edited → sửa; remove → deleted; hide → hidden; unhide → bỏ ẩn', () => {
    expect(normalizeFeedChange(feed({ verb: 'edited', message: 'Sửa lại' }), FB, NOW)).toEqual({ kind: 'edit', commentId: 'POST_C1', text: 'Sửa lại', timestamp: NOW })
    expect(normalizeFeedChange(feed({ verb: 'remove' }), FB, NOW)).toEqual({ kind: 'remove', commentId: 'POST_C1', removal: 'deleted', timestamp: NOW })
    expect(normalizeFeedChange(feed({ verb: 'hide' }), FB, NOW)).toEqual({ kind: 'remove', commentId: 'POST_C1', removal: 'hidden', timestamp: NOW })
    expect(normalizeFeedChange(feed({ verb: 'unhide' }), FB, NOW)).toEqual({ kind: 'unhide', commentId: 'POST_C1' })
  })

  it('bình luận của chính trang → from_page; item khác / verb lạ → not_comment; thiếu id → malformed', () => {
    expect(normalizeFeedChange(feed({ from: { id: 'PAGE_1', name: 'Shop' } }), FB, NOW)).toEqual({ kind: 'skip', reason: 'from_page' })
    expect(normalizeFeedChange(feed({ item: 'reaction' }), FB, NOW)).toEqual({ kind: 'skip', reason: 'not_comment' })
    expect(normalizeFeedChange(feed({ item: 'status' }), FB, NOW)).toEqual({ kind: 'skip', reason: 'not_comment' })
    expect(normalizeFeedChange(feed({ verb: 'block' }), FB, NOW)).toEqual({ kind: 'skip', reason: 'not_comment' })
    expect(normalizeFeedChange(feed({ comment_id: undefined }), FB, NOW)).toEqual({ kind: 'skip', reason: 'malformed' })
    expect(normalizeFeedChange(feed({ from: undefined }), FB, NOW)).toEqual({ kind: 'skip', reason: 'malformed' })
    expect(normalizeFeedChange(feed({ post_id: undefined }), FB, NOW)).toEqual({ kind: 'skip', reason: 'malformed' })
    expect(normalizeFeedChange({ field: 'feed' }, FB, NOW)).toEqual({ kind: 'skip', reason: 'not_comment' })
  })

  it('bài của trang khác (tiền tố khác) → giữ id Meta gửi', () => {
    expect(normalizeFeedChange(feed({ post_id: 'OTHER_POST', parent_id: 'OTHER_POST' }), FB, NOW)).toMatchObject({ platformPostId: 'OTHER_POST', parentId: null })
  })
})

describe('normalizeInstagramComment (IG comments)', () => {
  const IG = { platformAccountId: 'IG_1', handle: 'shop.ig' }
  const ig = (value: Record<string, unknown>) => ({
    field: 'comments',
    value: { id: 'igc_1', text: 'Giá bao nhiêu?', from: { id: 'IGU_1', username: 'thuha' }, media: { id: 'media_1', media_product_type: 'FEED' }, ...value },
  })

  it('bình luận mới → id bài = media id, username, thời điểm dự phòng', () => {
    expect(normalizeInstagramComment(ig({}), IG, NOW)).toEqual({
      kind: 'comment',
      commentId: 'igc_1',
      parentId: null,
      platformPostId: 'media_1',
      author: { id: 'IGU_1', name: null, username: 'thuha' },
      text: 'Giá bao nhiêu?',
      timestamp: NOW,
      attachments: [],
    })
  })

  it('trả lời → parentId; của chính tài khoản (id hoặc username) → from_page; thiếu trường → malformed', () => {
    expect(normalizeInstagramComment(ig({ id: 'igc_2', parent_id: 'igc_1' }), IG, NOW)).toMatchObject({ parentId: 'igc_1' })
    expect(normalizeInstagramComment(ig({ from: { id: 'IG_1', username: 'x' } }), IG, NOW)).toEqual({ kind: 'skip', reason: 'from_page' })
    expect(normalizeInstagramComment(ig({ from: { id: 'other', username: '@Shop.IG' } }), IG, NOW)).toEqual({ kind: 'skip', reason: 'from_page' })
    expect(normalizeInstagramComment(ig({ media: undefined }), IG, NOW)).toEqual({ kind: 'skip', reason: 'malformed' })
    expect(normalizeInstagramComment(ig({ id: undefined }), IG, NOW)).toEqual({ kind: 'skip', reason: 'malformed' })
    expect(normalizeInstagramComment({}, IG, NOW)).toEqual({ kind: 'skip', reason: 'not_comment' })
  })
})

describe('normalizeThreadsReply (Threads replies)', () => {
  const TH = { platformAccountId: 'TH_1', handle: 'shop.threads' }
  const reply = (value: Record<string, unknown>) => ({
    field: 'replies',
    value: {
      id: 'r_1',
      username: 'thuha',
      text: 'Ship Hà Nội không?',
      media_type: 'TEXT_POST',
      timestamp: '2026-10-23T02:59:00+0000',
      replied_to: { id: 'post_1' },
      root_post: { id: 'post_1', owner_id: 'TH_1', username: 'shop.threads' },
      ...value,
    },
  })

  it('trả lời bài → định danh @username, id bài = root_post.id, thời điểm ISO +0000', () => {
    expect(normalizeThreadsReply(reply({}), TH, NOW)).toEqual({
      kind: 'comment',
      commentId: 'r_1',
      parentId: null,
      platformPostId: 'post_1',
      author: { id: '@thuha', name: null, username: 'thuha' },
      text: 'Ship Hà Nội không?',
      timestamp: new Date('2026-10-23T02:59:00.000Z'),
      attachments: [],
    })
  })

  it('trả lời lồng → parentId = replied_to; có from.id → dùng id; ảnh → đính kèm', () => {
    const c = normalizeThreadsReply(reply({ id: 'r_2', replied_to: { id: 'r_1' }, from: { id: 'THU_9' }, media_type: 'IMAGE', media_url: 'https://scontent.cdninstagram.com/x.jpg' }), TH, NOW)
    expect(c).toMatchObject({ parentId: 'r_1', author: { id: 'THU_9', username: 'thuha' }, attachments: [{ kind: 'image', url: 'https://scontent.cdninstagram.com/x.jpg' }] })
  })

  it('trả lời của chính trang (username = handle) → from_page; thiếu root_post / username → malformed', () => {
    expect(normalizeThreadsReply(reply({ username: 'Shop.Threads' }), TH, NOW)).toEqual({ kind: 'skip', reason: 'from_page' })
    expect(normalizeThreadsReply(reply({ root_post: undefined }), TH, NOW)).toEqual({ kind: 'skip', reason: 'malformed' })
    expect(normalizeThreadsReply(reply({ username: undefined }), TH, NOW)).toEqual({ kind: 'skip', reason: 'malformed' })
  })
})

describe('parsePlatformTime', () => {
  it('giây / mili giây / chuỗi số / ISO / lạ → dự phòng', () => {
    expect(parsePlatformTime(1_792_000_000, NOW)).toEqual(new Date(1_792_000_000_000))
    expect(parsePlatformTime(1_792_000_000_123, NOW)).toEqual(new Date(1_792_000_000_123))
    expect(parsePlatformTime('1792000000', NOW)).toEqual(new Date(1_792_000_000_000))
    expect(parsePlatformTime('2026-10-23T02:59:00+0000', NOW)).toEqual(new Date('2026-10-23T02:59:00Z'))
    expect(parsePlatformTime('không phải ngày', NOW)).toBe(NOW)
    expect(parsePlatformTime(undefined, NOW)).toBe(NOW)
  })
})
