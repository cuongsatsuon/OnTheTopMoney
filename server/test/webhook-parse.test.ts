// Story 4.1 — tách body webhook thành mục (hàm thuần, không DB).
import { describe, expect, it, vi } from 'vitest'
import { handleRouteJob, hashItem, parseMetaBody, parseThreadsBody } from '../src/modules/webhooks/index.ts'

describe('parseMetaBody (Graph)', () => {
  it('tách entry[].messaging[] theo mid; is_echo → message_echoes', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_1',
          messaging: [
            { sender: { id: 'u1' }, message: { mid: 'm_abc', text: 'hi' } },
            { sender: { id: 'PAGE_1' }, message: { mid: 'm_echo', is_echo: true, text: 'reply' } },
            { sender: { id: 'u1' }, postback: { payload: 'P' } },
          ],
        },
      ],
    }
    const items = parseMetaBody(body)
    expect(items).toHaveLength(3)
    // Khoá chống trùng có namespace theo field (không gộp giữa các loại mục).
    expect(items[0]).toMatchObject({ platformPageId: 'PAGE_1', field: 'messages', dedupeKey: 'messages:m_abc' })
    expect(items[1]).toMatchObject({ field: 'message_echoes', dedupeKey: 'message_echoes:m_echo' })
    // Postback không có mid → khoá là hash của mục.
    expect(items[2]!.field).toBe('messaging_postbacks')
    expect(items[2]!.dedupeKey.startsWith('sha256:')).toBe(true)
  })

  it('tách entry[].changes[] feed/comment: feed theo item + id, IG comments theo id bình luận', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_2',
          changes: [
            { field: 'feed', value: { item: 'comment', comment_id: 'c_1', post_id: 'p_1' } },
            { field: 'comments', value: { id: 'igc_1', media: { id: 'media_9' } } },
            { field: 'feed', value: { item: 'status', post_id: 'p_2' } },
          ],
        },
      ],
    }
    const items = parseMetaBody(body)
    expect(items.map((i) => i.dedupeKey)).toEqual(['feed:comment:c_1', 'comments:igc_1', 'feed:status:p_2'])
    expect(items.map((i) => i.field)).toEqual(['feed', 'comments', 'feed'])
    expect(items.every((i) => i.platformPageId === 'PAGE_2')).toBe(true)
  })

  it('cross-type: id trùng giữa loại mục KHÁC nhau → khoá khác nhau (không gộp, không mất sự kiện)', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_C',
          messaging: [{ message: { mid: 'X1', text: 'hi' } }],
          changes: [{ field: 'comments', value: { comment_id: 'X1' } }],
        },
      ],
    }
    const keys = parseMetaBody(body).map((i) => i.dedupeKey)
    expect(keys).toEqual(['messages:X1', 'comments:X1'])
    expect(new Set(keys).size).toBe(2)
  })

  it('Story 4.4: hai bình luận IG cùng bài → hai khoá (không gộp theo media id)', () => {
    const change = (id: string) => ({ field: 'comments', value: { id, media: { id: 'media_1' }, from: { id: 'u' }, text: 'x' } })
    const keys = parseMetaBody({ entry: [{ id: 'IG_1', changes: [change('c_a'), change('c_b')] }] }).map((i) => i.dedupeKey)
    expect(keys).toEqual(['comments:c_a', 'comments:c_b'])
  })

  it('Story 4.4: feed add rồi edited/remove/hide cùng comment_id → khoá khác nhau; hai lần sửa khác nội dung → khác khoá', () => {
    const feed = (value: Record<string, unknown>) => ({ field: 'feed', value: { item: 'comment', comment_id: 'p_c1', post_id: 'P_p', ...value } })
    const keys = parseMetaBody({
      entry: [
        {
          id: 'P',
          changes: [
            feed({ verb: 'add', message: 'a' }),
            feed({ verb: 'edited', message: 'b' }),
            feed({ verb: 'edited', message: 'c' }),
            feed({ verb: 'hide' }),
            feed({ verb: 'remove' }),
          ],
        },
      ],
    }).map((i) => i.dedupeKey)
    expect(keys[0]).toBe('feed:comment:p_c1')
    expect(keys[1]!.startsWith('feed:comment:edited:sha256:')).toBe(true)
    expect(keys[3]!.startsWith('feed:comment:hide:sha256:')).toBe(true)
    expect(keys[4]!.startsWith('feed:comment:remove:sha256:')).toBe(true)
    expect(new Set(keys).size).toBe(5)
    // Meta gửi lại đúng mục sửa → cùng khoá (chống trùng vẫn đúng).
    expect(parseMetaBody({ entry: [{ id: 'P', changes: [feed({ verb: 'edited', message: 'b' })] }] })[0]!.dedupeKey).toBe(keys[1])
  })

  it('Story 4.4 (review): ẩn → bỏ ẩn → ẩn lại (mục giống hệt) ở entry khác thời điểm → khoá khác; gửi lại cùng entry → cùng khoá', () => {
    const hide = { field: 'feed', value: { item: 'comment', verb: 'hide', comment_id: 'p_c1', post_id: 'P_p' } }
    const keyAt = (time: number) => parseMetaBody({ entry: [{ id: 'P', time, changes: [hide] }] })[0]!.dedupeKey
    expect(keyAt(100)).not.toBe(keyAt(200))
    expect(keyAt(100)).toBe(keyAt(100))
    // Thêm mới vẫn theo id, không phụ thuộc thời điểm entry.
    const add = { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'p_c1', post_id: 'P_p' } }
    expect(parseMetaBody({ entry: [{ id: 'P', time: 1, changes: [add] }] })[0]!.dedupeKey).toBe('feed:comment:p_c1')
  })

  it('Story 4.4: reaction trên bình luận không trùng khoá với chính bình luận', () => {
    const keys = parseMetaBody({
      entry: [
        {
          id: 'P',
          changes: [
            { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'p_c1', post_id: 'P_p' } },
            { field: 'feed', value: { item: 'reaction', verb: 'add', comment_id: 'p_c1', post_id: 'P_p', reaction_type: 'like' } },
          ],
        },
      ],
    }).map((i) => i.dedupeKey)
    expect(keys[0]).toBe('feed:comment:p_c1')
    expect(keys[1]!.startsWith('feed:reaction:add:sha256:')).toBe(true)
  })

  it('body lạ / rỗng → không mục (POST vẫn 200)', () => {
    expect(parseMetaBody(null)).toEqual([])
    expect(parseMetaBody({})).toEqual([])
    expect(parseMetaBody({ entry: 'x' })).toEqual([])
    expect(parseMetaBody({ entry: [{ id: 'P', messaging: ['bad', 1] }] })).toEqual([])
  })

  it('hashItem ổn định dù thứ tự khoá khác (khoá lặp lại không đổi giữa các lần gửi)', () => {
    expect(hashItem({ a: 1, b: 2 })).toBe(hashItem({ b: 2, a: 1 }))
    expect(hashItem({ a: 1 })).not.toBe(hashItem({ a: 2 }))
  })
})

describe('parseThreadsBody', () => {
  it('tách entry[].changes[] field replies theo value.id', () => {
    const body = {
      object: 'threads',
      entry: [{ id: 'TH_1', changes: [{ field: 'replies', value: { id: 'r_1', text: 'xin chào' } }] }],
    }
    const items = parseThreadsBody(body)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ platformPageId: 'TH_1', field: 'replies', dedupeKey: 'replies:r_1' })
  })

  it('Story 4.4: dạng `values` (tài liệu Threads) → mục replies, trang = root_post.owner_id, rồi target_id', () => {
    const value = { id: 'r_9', username: 'khach', text: 'hi', root_post: { id: 'post_1', owner_id: 'TH_OWNER' }, replied_to: { id: 'post_1' } }
    const items = parseThreadsBody({ app_id: 'A', topic: 'moderate', target_id: 'TH_TARGET', time: 1, values: { field: 'replies', value } })
    expect(items).toEqual([{ platformPageId: 'TH_OWNER', field: 'replies', dedupeKey: 'replies:r_9', payload: { field: 'replies', value } }])
    const noOwner = parseThreadsBody({ target_id: 'TH_TARGET', values: [{ field: 'replies', value: { id: 'r_10' } }] })
    expect(noOwner[0]).toMatchObject({ platformPageId: 'TH_TARGET', dedupeKey: 'replies:r_10' })
  })

  it('không id tự nhiên → hash; body rỗng → []', () => {
    const items = parseThreadsBody({ entry: [{ id: 'TH_2', changes: [{ field: 'replies', value: {} }] }] })
    expect(items[0]!.dedupeKey.startsWith('sha256:')).toBe(true)
    expect(parseThreadsBody(null)).toEqual([])
  })
})

describe('handleRouteJob (nhánh catch của worker)', () => {
  it('lần thử CUỐI khi lỗi → markFailed(WEBHOOK_ROUTE_FAILED) rồi ném lại', async () => {
    const route = vi.fn().mockRejectedValue(new Error('boom'))
    const markFailed = vi.fn().mockResolvedValue(undefined)
    await expect(
      handleRouteJob({ route, markFailed }, { data: { eventId: 'e1' }, retryCount: 5, retryLimit: 5 }),
    ).rejects.toThrow('boom')
    expect(markFailed).toHaveBeenCalledWith('e1', 'WEBHOOK_ROUTE_FAILED')
  })

  it('lần thử CHƯA cuối khi lỗi → KHÔNG markFailed (để pg-boss retry)', async () => {
    const route = vi.fn().mockRejectedValue(new Error('boom'))
    const markFailed = vi.fn().mockResolvedValue(undefined)
    await expect(
      handleRouteJob({ route, markFailed }, { data: { eventId: 'e2' }, retryCount: 0, retryLimit: 5 }),
    ).rejects.toThrow('boom')
    expect(markFailed).not.toHaveBeenCalled()
  })

  it('thành công → không markFailed, không ném', async () => {
    const route = vi.fn().mockResolvedValue('routed')
    const markFailed = vi.fn()
    await handleRouteJob({ route, markFailed }, { data: { eventId: 'e3' }, retryCount: 0, retryLimit: 5 })
    expect(markFailed).not.toHaveBeenCalled()
    expect(route).toHaveBeenCalledWith({ eventId: 'e3' })
  })
})
