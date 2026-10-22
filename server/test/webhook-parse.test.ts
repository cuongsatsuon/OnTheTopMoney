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

  it('tách entry[].changes[] feed/comment theo comment_id / media id / post_id', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_2',
          changes: [
            { field: 'feed', value: { item: 'comment', comment_id: 'c_1', post_id: 'p_1' } },
            { field: 'comments', value: { media: { id: 'media_9' } } },
            { field: 'feed', value: { item: 'status', post_id: 'p_2' } },
          ],
        },
      ],
    }
    const items = parseMetaBody(body)
    expect(items.map((i) => i.dedupeKey)).toEqual(['feed:c_1', 'comments:media_9', 'feed:p_2'])
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
