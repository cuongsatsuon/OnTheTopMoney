// adapters/meta/normalize — id bài khi đăng và khi nhận từ webhook cùng một dạng.
import { describe, expect, it } from 'vitest'
import {
  normalizeWebhookPostId,
  publishedRefFromFacebook,
  publishedRefFromInstagram,
  publishedRefFromThreads,
} from '../src/adapters/meta/normalize.ts'

const PAGE = '1029384756'

describe('publishedRefFromFacebook', () => {
  it('đăng ảnh {id, post_id} → platformPostId = post_id', () => {
    expect(publishedRefFromFacebook(PAGE, { id: '555', post_id: `${PAGE}_777` })).toEqual({ platformPostId: `${PAGE}_777` })
  })

  it('đăng ảnh thiếu post_id (chỉ có id ảnh trần) → null (không bao giờ khớp post_id của webhook)', () => {
    expect(publishedRefFromFacebook(PAGE, { id: '555' })).toBeNull()
  })

  it('pageId rỗng → null', () => {
    expect(publishedRefFromFacebook('', { id: '1', post_id: `${PAGE}_777` })).toBeNull()
    expect(publishedRefFromFacebook('  ', { id: `${PAGE}_888` })).toBeNull()
  })

  it('id đã mang tiền tố của trang khác → null', () => {
    expect(publishedRefFromFacebook(PAGE, { id: '1', post_id: '999_777' })).toBeNull()
    expect(publishedRefFromFacebook(PAGE, { id: '999_888' })).toBeNull()
  })

  it('đăng feed {id: "{pageId}_{postId}"} → giữ nguyên; kèm permalink', () => {
    expect(publishedRefFromFacebook(PAGE, { id: `${PAGE}_888` }, 'https://facebook.com/x')).toEqual({
      platformPostId: `${PAGE}_888`,
      permalink: 'https://facebook.com/x',
    })
  })

  it('post_id chỉ có phần sau → ghép pageId', () => {
    expect(publishedRefFromFacebook(PAGE, { id: '1', post_id: '777' })).toEqual({ platformPostId: `${PAGE}_777` })
  })

  it('không có id → null', () => {
    expect(publishedRefFromFacebook(PAGE, {})).toBeNull()
    expect(publishedRefFromFacebook(PAGE, { id: '  ' })).toBeNull()
    expect(publishedRefFromFacebook(PAGE, null)).toBeNull()
  })
})

describe('Instagram / Threads', () => {
  it('IG: media id của bài từ media_publish', () => {
    expect(publishedRefFromInstagram({ id: '17895695668004550' })).toEqual({ platformPostId: '17895695668004550' })
    expect(publishedRefFromInstagram({ id: '1' }, 'https://instagram.com/p/x')).toEqual({ platformPostId: '1', permalink: 'https://instagram.com/p/x' })
    expect(publishedRefFromInstagram({})).toBeNull()
  })

  it('Threads: media id sau threads_publish', () => {
    expect(publishedRefFromThreads({ id: '18040000000000001' })).toEqual({ platformPostId: '18040000000000001' })
    expect(publishedRefFromThreads(undefined)).toBeNull()
  })
})

describe('normalizeWebhookPostId — cùng dạng như khi đăng', () => {
  it('FB post_id {pageId}_{postId} → giữ nguyên, khớp id khi đăng ảnh', () => {
    const published = publishedRefFromFacebook(PAGE, { id: '555', post_id: `${PAGE}_777` })
    expect(normalizeWebhookPostId('facebook', `${PAGE}_777`)).toBe(published?.platformPostId)
  })

  it('FB chỉ có postId + pageId → ghép', () => {
    expect(normalizeWebhookPostId('facebook', '777', PAGE)).toBe(`${PAGE}_777`)
  })

  it('FB id không có _ và không có pageId → null', () => {
    expect(normalizeWebhookPostId('facebook', '777')).toBeNull()
  })

  it('FB pageId rỗng hoặc tiền tố trang khác → null', () => {
    expect(normalizeWebhookPostId('facebook', '777', '')).toBeNull()
    expect(normalizeWebhookPostId('facebook', '999_777', PAGE)).toBeNull()
    expect(normalizeWebhookPostId('facebook', `${PAGE}_777`, PAGE)).toBe(`${PAGE}_777`)
  })

  it('IG/Threads media id giữ nguyên, khớp id khi đăng', () => {
    expect(normalizeWebhookPostId('instagram', '17895695668004550')).toBe(publishedRefFromInstagram({ id: '17895695668004550' })?.platformPostId)
    expect(normalizeWebhookPostId('threads', ' 18040000000000001 ')).toBe('18040000000000001')
  })

  it('id rỗng → null', () => {
    expect(normalizeWebhookPostId('facebook', '')).toBeNull()
    expect(normalizeWebhookPostId('instagram', undefined)).toBeNull()
  })
})
