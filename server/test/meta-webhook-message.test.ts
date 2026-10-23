// Story 4.3 — adapters/meta: chuẩn hoá mục `messaging` (Messenger / IG Direct) và tải đính kèm từ CDN Meta
// (allowlist host, redirect phải vẫn là CDN Meta, giới hạn byte, phân loại lỗi). Thuần, không gọi mạng.
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_MAX_BYTES, downloadWebhookAttachment, isAllowedAttachmentUrl, normalizeMessagingItem } from '../src/adapters/meta/index.ts'

const PAGE = 'PAGE_1'
const NOW = new Date('2026-10-23T03:00:00.000Z')
const item = (message: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
  sender: { id: 'PSID_1' },
  recipient: { id: PAGE },
  timestamp: 1_792_000_000_000,
  ...(message ? { message } : {}),
  ...extra,
})

describe('normalizeMessagingItem', () => {
  it('tin chữ → dm với PSID, mid, thời điểm theo `timestamp` (ms)', () => {
    expect(normalizeMessagingItem(item({ mid: 'm_1', text: 'Chào shop' }), PAGE, NOW)).toEqual({
      kind: 'dm',
      senderId: 'PSID_1',
      recipientId: PAGE,
      mid: 'm_1',
      timestamp: new Date(1_792_000_000_000),
      text: 'Chào shop',
      attachments: [],
    })
  })

  it('đính kèm: ảnh/sticker/voice/video/file lấy URL; share/story_mention/fallback bỏ qua', () => {
    const dm = normalizeMessagingItem(
      item({
        mid: 'm_2',
        attachments: [
          { type: 'image', payload: { url: 'https://scontent.xx.fbcdn.net/a.jpg' } },
          { type: 'sticker', payload: { url: 'https://scontent.xx.fbcdn.net/s.png', sticker_id: 1 } },
          { type: 'audio', payload: { url: 'https://cdn.fbsbx.com/v.mp4' } },
          { type: 'video', payload: { url: 'https://video.xx.fbcdn.net/v.mp4' } },
          { type: 'file', payload: { url: 'https://cdn.fbsbx.com/f.pdf' } },
          { type: 'share', payload: { url: 'https://www.instagram.com/p/x' } },
          { type: 'story_mention', payload: { url: 'https://lookaside.fbsbx.com/s' } },
          { type: 'fallback', payload: { url: 'https://example.com' } },
          { type: 'image', payload: {} },
        ],
      }),
      PAGE,
      NOW,
    )
    if (dm.kind !== 'dm') throw new Error('mong dm')
    expect(dm.text).toBeNull()
    expect(dm.attachments.map((a) => a.kind)).toEqual(['image', 'image', 'audio', 'video', 'file'])
  })

  it.each([
    ['echo', item({ mid: 'm', text: 'x', is_echo: true })],
    ['deleted', item({ mid: 'm', is_deleted: true })],
    ['not_message', item(undefined, { postback: { payload: 'P' } })],
    ['not_message', item(undefined, { reaction: { mid: 'm', reaction: 'love' } })],
    ['not_message', item(undefined, { read: { watermark: 1 } })],
    ['malformed', item({ text: 'thiếu mid' })],
    ['malformed', { message: { mid: 'm', text: 'thiếu sender' } }],
    ['from_page', { sender: { id: PAGE }, message: { mid: 'm', text: 'x' } }],
  ] as const)('%s → skip', (reason, raw) => {
    expect(normalizeMessagingItem(raw, PAGE, NOW)).toEqual({ kind: 'skip', reason })
  })

  it('không có `timestamp` → dùng `now`; chữ toàn khoảng trắng → null', () => {
    const dm = normalizeMessagingItem({ sender: { id: 'U' }, message: { mid: 'm', text: '   ' } }, PAGE, NOW)
    expect(dm).toMatchObject({ kind: 'dm', timestamp: NOW, text: null, recipientId: PAGE })
  })
})

/** fetch giả: map URL → Response (hoặc hàm). */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; redirect: RequestInit['redirect'] }[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, redirect: init?.redirect })
    const route = routes[url]
    if (!route) throw new TypeError('fetch failed')
    return route()
  }) as typeof fetch
  return { fn, calls }
}

const CDN = 'https://scontent.xx.fbcdn.net/v/a.jpg?oh=sig'

describe('downloadWebhookAttachment', () => {
  it('host CDN Meta, https → bytes + MIME (bỏ tham số), không theo redirect tự động', async () => {
    const f = fakeFetch({ [CDN]: () => new Response(Buffer.from('JPEGDATA'), { headers: { 'content-type': 'image/JPEG; charset=binary' } }) })
    const res = await downloadWebhookAttachment(CDN, { fetch: f.fn })
    expect(res).toEqual({ ok: true, data: Buffer.from('JPEGDATA'), mime: 'image/jpeg' })
    expect(f.calls[0]!.redirect).toBe('manual')
  })

  it.each([
    'http://scontent.xx.fbcdn.net/a.jpg',
    'https://evil.example.com/a.jpg',
    'https://fbcdn.net.evil.com/a.jpg',
    'https://scontent.xx.fbcdn.net:8443/a.jpg',
    'https://user:pw@scontent.xx.fbcdn.net/a.jpg',
    'không phải url',
  ])('URL không được phép %s → INVALID_URL, không gọi mạng', async (url) => {
    const f = fakeFetch({})
    expect(await downloadWebhookAttachment(url, { fetch: f.fn })).toEqual({ ok: false, kind: 'INVALID_URL' })
    expect(f.calls).toHaveLength(0)
    expect(isAllowedAttachmentUrl(url)).toBe(false)
  })

  it('redirect sang CDN Meta khác → theo; redirect ra ngoài → INVALID_URL', async () => {
    const lookaside = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1'
    const f = fakeFetch({
      [lookaside]: () => new Response(null, { status: 302, headers: { location: CDN } }),
      [CDN]: () => new Response(Buffer.from('OK'), { headers: { 'content-type': 'audio/mp4' } }),
    })
    expect(await downloadWebhookAttachment(lookaside, { fetch: f.fn })).toMatchObject({ ok: true, mime: 'audio/mp4' })

    const bad = fakeFetch({ [lookaside]: () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }) })
    expect(await downloadWebhookAttachment(lookaside, { fetch: bad.fn })).toMatchObject({ ok: false, kind: 'INVALID_URL' })
    expect(bad.calls).toHaveLength(1)
  })

  it('quá giới hạn: content-length khai lớn, hoặc luồng vượt khi đọc → TOO_LARGE', async () => {
    const big = fakeFetch({ [CDN]: () => new Response('x', { headers: { 'content-length': String(ATTACHMENT_MAX_BYTES + 1) } }) })
    expect(await downloadWebhookAttachment(CDN, { fetch: big.fn })).toMatchObject({ ok: false, kind: 'TOO_LARGE' })
    const stream = fakeFetch({ [CDN]: () => new Response(Buffer.alloc(64)) })
    expect(await downloadWebhookAttachment(CDN, { fetch: stream.fn, maxBytes: 16 })).toMatchObject({ ok: false, kind: 'TOO_LARGE' })
  })

  it.each([
    [404, 'NOT_FOUND'],
    [410, 'NOT_FOUND'],
    [403, 'REJECTED'],
    [429, 'RATE_LIMITED'],
    [500, 'TRANSIENT'],
    [503, 'TRANSIENT'],
  ] as const)('HTTP %d → %s', async (status, kind) => {
    const f = fakeFetch({ [CDN]: () => new Response('err', { status }) })
    expect(await downloadWebhookAttachment(CDN, { fetch: f.fn })).toEqual({ ok: false, kind, status })
  })

  it('lỗi mạng → TRANSIENT', async () => {
    expect(await downloadWebhookAttachment(CDN, { fetch: fakeFetch({}).fn })).toEqual({ ok: false, kind: 'TRANSIENT' })
  })
})
