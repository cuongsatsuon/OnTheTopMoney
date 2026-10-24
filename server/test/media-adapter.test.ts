// adapters/media (AD-14) — Cloudinary qua fetch, chạy trên Cloudinary giả (adapters/media/fake.ts), không gọi mạng.
// Phủ ma trận của spec-media-cloudinary: upload công khai, asJpeg, riêng tư put/get + URL thường bị chặn, chưa cấu
// hình, sai khoá, lỗi tạm, request sai, xoá idempotent, config sai; chữ ký khớp ví dụ trong tài liệu Cloudinary.
import { pino } from 'pino'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createFakeCloudinary, FAKE_JPEG, FAKE_PNG, FAKE_WEBP, FAKE_DELIVERY_BASE_URL } from '../src/adapters/media/fake.ts'
import { classifyStatus, createMediaStores, fitImageUrl, incomingTransformation, MEDIA_MAX_BYTES, signParams, type MediaConfig } from '../src/adapters/media/index.ts'
import { ConfigError, parseEnv, parseMediaEnv } from '../src/platform/config/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { runMediaCheck } from '../scripts/lib/media-check.ts'

const CREDS = { cloudName: 'demo-cloud', apiKey: '123456789012345', apiSecret: 'S3cr3t-ADAPTER_xyz' }
const CLOUDINARY_URL = `cloudinary://${CREDS.apiKey}:${CREDS.apiSecret}@${CREDS.cloudName}`
const config: MediaConfig = { CLOUDINARY_URL: CREDS, CLOUDINARY_FOLDER: 'ottm-test' }
const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')

function setup(overrides: Partial<MediaConfig> = {}, opts: { timeoutMs?: number; uploadTimeoutMs?: number } = {}) {
  const fake = createFakeCloudinary(CREDS)
  const stores = createMediaStores({ ...config, ...overrides }, { fetch: fake.fetch, now: () => 1_800_000_000_000, ...opts })
  return { fake, stores }
}

/** Không chứa secret (hay chữ ký) trong kết quả. */
const noSecret = (value: unknown) => expect(JSON.stringify(value)).not.toContain(CREDS.apiSecret)

describe('adapters/media — chữ ký', () => {
  it('khớp ví dụ trong tài liệu Cloudinary ("Generating authentication signatures")', () => {
    expect(
      signParams({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 }, 'abcd'),
    ).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e')
  })

  it('bỏ file, cloud_name, resource_type, api_key và tham số rỗng; thứ tự tham số không ảnh hưởng', () => {
    const base = signParams({ public_id: 'a', timestamp: 1 }, 'x')
    expect(signParams({ timestamp: 1, public_id: 'a', api_key: 'k', file: 'f', cloud_name: 'c', resource_type: 'image', format: '', type: undefined }, 'x')).toBe(base)
    expect(signParams({ public_id: 'a', timestamp: 2 }, 'x')).not.toBe(base)
  })

  it('upload gửi timestamp theo `now`, api_key, chữ ký đúng (fake kiểm như Cloudinary)', async () => {
    const { fake, stores } = setup()
    expect((await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })).ok).toBe(true)
    const req = fake.requests[0]!
    expect(req.url).toBe(`https://api.cloudinary.com/v1_1/${CREDS.cloudName}/image/upload`)
    expect(req.params).toMatchObject({ timestamp: '1800000000', api_key: CREDS.apiKey })
    expect(JSON.stringify(req.params)).not.toContain(CREDS.apiSecret)
  })
})

describe('adapters/media — MediaStore (công khai)', () => {
  it.each([
    ['image/jpeg', FAKE_JPEG, 'jpg'],
    ['image/png', FAKE_PNG, 'png'],
    ['image/webp', FAKE_WEBP, 'webp'],
  ] as const)('upload %s → URL https res.cloudinary.com, public_id trong <folder>/public/', async (mime, data, format) => {
    const { fake, stores } = setup()
    const result = await stores.publicStore.put({ data, mime })
    if (!result.ok) throw new Error(`mong ok, nhận ${result.kind}`)
    expect(result.publicId).toMatch(new RegExp(`^ottm-test/public/${UUID_V7}$`))
    expect(result.url).toMatch(new RegExp(`^https://res\\.cloudinary\\.com/${CREDS.cloudName}/image/upload/v\\d+/${result.publicId}\\.${format}$`))
    expect(result).toMatchObject({ format, bytes: data.length })
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
    expect(fake.requests[0]!.params.type).toBeUndefined() // type mặc định `upload` (công khai)
    noSecret(result)
    // URL công khai tải được.
    const res = await fake.fetch(result.url)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(data)
  })

  it('kích thước thật của ảnh (PNG 2×2)', async () => {
    const { stores } = setup()
    expect(await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })).toMatchObject({ ok: true, width: 2, height: 2 })
  })

  it('asJpeg: ảnh png → format jpg (Cloudinary đổi khi upload)', async () => {
    const { fake, stores } = setup()
    const result = await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png', asJpeg: true })
    expect(result).toMatchObject({ ok: true, format: 'jpg' })
    expect(fake.requests[0]!.params.format).toBe('jpg')
  })

  it('asJpeg mà Cloudinary trả format khác jpg → INVALID_REQUEST (không retry), xoá ảnh vừa upload', async () => {
    const fake = createFakeCloudinary(CREDS)
    // Giả Cloudinary không đổi định dạng (phản hồi upload báo format png).
    const ignoresFormat = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fake.fetch(input, init)
      if (!String(input).endsWith('/image/upload')) return res
      return new Response(JSON.stringify({ ...((await res.json()) as object), format: 'png' }), { status: res.status })
    }) as typeof fetch
    const stores = createMediaStores(config, { fetch: ignoresFormat })
    const result = await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png', asJpeg: true })
    expect(result).toEqual({ ok: false, kind: 'INVALID_REQUEST', status: 200 })
    expect(fake.requests.map((r) => r.url.split('/').pop())).toEqual(['upload', 'destroy'])
    expect(fake.assets.size).toBe(0)
  })

  it('incoming transformation: xoay theo EXIF trước khi bỏ EXIF/IPTC/XMP + ICC (logo, ảnh bài); không cờ → không gửi', () => {
    expect(incomingTransformation({ stripMetadata: true })).toBe('a_exif,fl_force_strip.strip_profile')
    expect(incomingTransformation({ stripMetadata: true, toSrgb: true })).toBe('a_exif,cs_srgb,fl_force_strip.strip_profile')
    expect(incomingTransformation({})).toBeUndefined()
  })

  it('mỗi lần upload một public_id mới', async () => {
    const { stores } = setup()
    const a = await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })
    const b = await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })
    expect(a.ok && b.ok && a.publicId !== b.publicId).toBe(true)
  })

  it('CLOUDINARY_FOLDER nhiều cấp', async () => {
    const { stores } = setup({ CLOUDINARY_FOLDER: 'ottm-dev/cuong' })
    const result = await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })
    expect(result.ok && result.publicId.startsWith('ottm-dev/cuong/public/')).toBe(true)
  })

  it('xoá: có → ok và hết; không tồn tại → vẫn ok (idempotent); gửi invalidate', async () => {
    const { fake, stores } = setup()
    const put = await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })
    if (!put.ok) throw new Error(put.kind)
    expect(await stores.publicStore.delete(put.publicId)).toEqual({ ok: true })
    expect(fake.assets.size).toBe(0)
    expect(fake.requests.at(-1)).toMatchObject({ url: expect.stringMatching(/\/image\/destroy$/), params: { public_id: put.publicId, invalidate: 'true' } })
    expect(await stores.publicStore.delete(put.publicId)).toEqual({ ok: true })
    expect(await stores.publicStore.delete('ottm-test/public/khong-co')).toEqual({ ok: true })
  })

  it('destroy trả 404 → vẫn ok', async () => {
    const { fake, stores } = setup()
    fake.failNext(404)
    expect(await stores.publicStore.delete('ottm-test/public/x')).toEqual({ ok: true })
  })
})

describe('adapters/media — download (ảnh gửi OpenAI, Story 6.6)', () => {
  it('tải bytes ảnh đã lưu; maxSide → chèn c_limit,w_,h_ sau /image/upload/', async () => {
    const { fake, stores } = setup()
    const put = await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })
    if (!put.ok) throw new Error(put.kind)
    const plain = await stores.publicStore.download(put.url)
    expect(plain).toEqual({ ok: true, data: FAKE_PNG })
    fake.requests.length = 0
    const small = await stores.publicStore.download(put.url, { maxSide: 1024 })
    expect(small).toEqual({ ok: true, data: FAKE_PNG })
    expect(fake.requests[0]!.url).toBe(put.url.replace('/image/upload/', '/image/upload/c_limit,w_1024,h_1024/'))
  })

  it('URL ngoài cloud / không phải image/upload / có query / có .. → INVALID_REQUEST, không gọi mạng', async () => {
    const { fake, stores } = setup()
    for (const url of [
      'https://evil.example.com/demo-cloud/image/upload/v1/a.jpg',
      `${FAKE_DELIVERY_BASE_URL}/other-cloud/image/upload/v1/a.jpg`,
      `${FAKE_DELIVERY_BASE_URL}/demo-cloud/raw/authenticated/v1/a.pdf`,
      `${FAKE_DELIVERY_BASE_URL}/demo-cloud/image/upload/v1/a.jpg?x=1`,
      `${FAKE_DELIVERY_BASE_URL}/demo-cloud/image/upload/../raw/upload/a`,
    ]) {
      expect(await stores.publicStore.download(url), url).toEqual({ ok: false, kind: 'INVALID_REQUEST' })
    }
    expect(fake.requests).toHaveLength(0)
  })

  it('không có → NOT_FOUND; 503 → TRANSIENT; lỗi mạng → TRANSIENT', async () => {
    const { fake, stores } = setup()
    const url = `${FAKE_DELIVERY_BASE_URL}/demo-cloud/image/upload/v1/ottm-test/public/none.jpg`
    expect(await stores.publicStore.download(url)).toEqual({ ok: false, kind: 'NOT_FOUND', status: 404 })
    fake.failNext(503)
    expect(await stores.publicStore.download(url)).toEqual({ ok: false, kind: 'TRANSIENT', status: 503 })
    fake.failNext('network')
    expect(await stores.publicStore.download(url)).toEqual({ ok: false, kind: 'TRANSIENT' })
  })
})

describe('adapters/media — fitImageUrl (URL giao đã biến đổi, Story 6.4)', () => {
  const URL = 'https://res.cloudinary.com/demo/image/upload/v17/ottm/public/abc.jpg'
  const IG = { minAspect: 4 / 5, maxAspect: 1.91, maxWidth: 1440 }

  it('ảnh dọc 3:4 → đệm trắng hai bên vào khung 4:5, thu nhỏ rộng ≤1440', () => {
    expect(fitImageUrl(URL, { width: 3024, height: 4032 }, IG)).toBe(
      'https://res.cloudinary.com/demo/image/upload/c_pad,w_1440,h_1800,b_white/v17/ottm/public/abc.jpg',
    )
  })

  it('ảnh 9:16 nhỏ → đệm giữ cỡ; ảnh 3:1 → đệm trên dưới về 1,91:1', () => {
    expect(fitImageUrl(URL, { width: 720, height: 1280 }, IG)).toContain('/upload/c_pad,w_1024,h_1280,b_white/v17/')
    expect(fitImageUrl(URL, { width: 1200, height: 400 }, IG)).toContain('/upload/c_pad,w_1200,h_628,b_white/v17/')
  })

  it('vừa khung: giữ nguyên; chỉ quá rộng → c_limit; đúng 4:5 (1080×1350) không bị đệm', () => {
    expect(fitImageUrl(URL, { width: 1024, height: 1024 }, IG)).toBe(URL)
    expect(fitImageUrl(URL, { width: 1080, height: 1350 }, IG)).toBe(URL)
    expect(fitImageUrl(URL, { width: 2048, height: 2048 }, IG)).toContain('/upload/c_limit,w_1440/v17/')
    expect(fitImageUrl(URL, { width: 2048, height: 4096 }, { maxWidth: 1440 })).toContain('/upload/c_limit,w_1440/v17/')
  })

  it('URL không phải ảnh upload Cloudinary / kích thước hỏng → trả nguyên URL', () => {
    expect(fitImageUrl('https://example.test/a.jpg', { width: 300, height: 900 }, IG)).toBe('https://example.test/a.jpg')
    expect(fitImageUrl(URL, { width: 0, height: 0 }, IG)).toBe(URL)
  })
})

describe('adapters/media — PrivateFileStore (riêng tư)', () => {
  it('put pdf → get: bytes giống hệt; raw + authenticated; không trả URL; URL giao thường bị chặn', async () => {
    const { fake, stores } = setup()
    const put = await stores.privateStore.put({ data: PDF, mime: 'application/pdf' })
    if (!put.ok) throw new Error(put.kind)
    expect(put).toEqual({ ok: true, publicId: expect.stringMatching(new RegExp(`^ottm-test/private/${UUID_V7}$`)), resourceType: 'raw', format: null, bytes: PDF.length })
    expect(fake.requests[0]).toMatchObject({ url: expect.stringMatching(/\/raw\/upload$/), params: { type: 'authenticated' } })
    expect(JSON.stringify(put)).not.toContain('res.cloudinary.com')

    const got = await stores.privateStore.get(put)
    expect(got.ok && Buffer.compare(got.data, PDF)).toBe(0)
    const dl = fake.requests.at(-1)!
    expect(dl).toMatchObject({ method: 'GET', url: expect.stringMatching(/\/raw\/download$/), params: { public_id: put.publicId, type: 'authenticated' } })
    expect(dl.params.signature).toMatch(/^[0-9a-f]{40}$/)

    for (const type of ['authenticated', 'upload']) {
      const res = await fake.fetch(`${FAKE_DELIVERY_BASE_URL}/${CREDS.cloudName}/raw/${type}/${put.publicId}`)
      expect([401, 404]).toContain(res.status)
    }
  })

  it.each([
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('PK\u0003\u0004 docx giả')],
    ['text/plain', Buffer.from('Bảng giá: 100.000đ\n')],
  ] as const)('%s → raw, get trả đúng bytes', async (mime, data) => {
    const { stores } = setup()
    const put = await stores.privateStore.put({ data, mime })
    if (!put.ok) throw new Error(put.kind)
    expect(put.resourceType).toBe('raw')
    const got = await stores.privateStore.get(put)
    expect(got.ok && got.data.equals(data)).toBe(true)
  })

  it('ảnh riêng tư → resource_type image, có format; URL thường (không chữ ký) bị chặn', async () => {
    const { fake, stores } = setup()
    const put = await stores.privateStore.put({ data: FAKE_PNG, mime: 'image/png' })
    if (!put.ok) throw new Error(put.kind)
    expect(put).toMatchObject({ resourceType: 'image', format: 'png' })
    const got = await stores.privateStore.get(put)
    expect(got.ok && got.data.equals(FAKE_PNG)).toBe(true)
    expect(fake.requests.at(-1)!.params.format).toBe('png')
    for (const type of ['authenticated', 'upload']) {
      const res = await fake.fetch(`${FAKE_DELIVERY_BASE_URL}/${CREDS.cloudName}/image/${type}/${put.publicId}.png`)
      expect([401, 404]).toContain(res.status)
    }
  })

  it('get file không tồn tại → NOT_FOUND', async () => {
    const { stores } = setup()
    expect(await stores.privateStore.get({ publicId: 'ottm-test/private/khong-co', resourceType: 'raw', format: null })).toEqual({
      ok: false,
      kind: 'NOT_FOUND',
      status: 404,
    })
  })

  it('xoá: có → ok và hết; lần hai / không tồn tại → vẫn ok', async () => {
    const { fake, stores } = setup()
    const put = await stores.privateStore.put({ data: PDF, mime: 'application/pdf' })
    if (!put.ok) throw new Error(put.kind)
    expect(await stores.privateStore.delete(put)).toEqual({ ok: true })
    expect(fake.assets.size).toBe(0)
    expect(fake.requests.at(-1)).toMatchObject({ url: expect.stringMatching(/\/raw\/destroy$/), params: { type: 'authenticated' } })
    expect(await stores.privateStore.delete(put)).toEqual({ ok: true })
  })
})

describe('adapters/media — MediaInventory (liệt kê / xoá theo prefix, Story 9.3)', () => {
  /** Đặt thẳng một file vào kho giả (vd file của thư mục khác, hay của app nhưng không do adapter tạo). */
  function seed(fake: ReturnType<typeof createFakeCloudinary>, resourceType: 'image' | 'raw', type: 'upload' | 'authenticated', publicId: string) {
    fake.assets.set(`${resourceType}/${type}/${publicId}`, {
      publicId, resourceType, type, format: resourceType === 'image' ? 'png' : null, data: FAKE_PNG, width: 2, height: 2, version: 1, createdAt: new Date('2026-01-02T03:04:05Z'),
    })
  }

  it('liệt kê đúng loại + prefix của app, Basic auth, created_at → Date; không lộ secret', async () => {
    const { fake, stores } = setup()
    const pub = await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })
    const priv = await stores.privateStore.put({ data: FAKE_PNG, mime: 'image/png' })
    const raw = await stores.privateStore.put({ data: PDF, mime: 'application/pdf' })
    if (!pub.ok || !priv.ok || !raw.ok) throw new Error('upload hỏng')
    seed(fake, 'image', 'upload', 'thu-muc-khac/public/x')
    seed(fake, 'image', 'upload', 'ottm-test-2/public/y')

    const listed = await stores.inventory.list('public_image', null)
    if (!listed.ok) throw new Error(listed.kind)
    expect(listed.files.map((f) => f.publicId)).toEqual([pub.publicId])
    expect(listed.files[0]!.createdAt).toBeInstanceOf(Date)
    expect(listed.nextCursor).toBeNull()
    const pi = await stores.inventory.list('private_image', null)
    const pr = await stores.inventory.list('private_raw', null)
    expect(pi.ok && pi.files.map((f) => f.publicId)).toEqual([priv.publicId])
    expect(pr.ok && pr.files.map((f) => f.publicId)).toEqual([raw.publicId])
    const req = fake.requests.at(-1)!
    expect(req.url).toBe(`https://api.cloudinary.com/v1_1/${CREDS.cloudName}/resources/raw/authenticated`)
    expect(req.params).toMatchObject({ prefix: 'ottm-test/private/' })
    noSecret(req.params)
    noSecret(listed)
  })

  it('phân trang bằng con trỏ, sắp theo public_id', async () => {
    const { stores } = setup()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })
      if (r.ok) ids.push(r.publicId)
    }
    const p1 = await stores.inventory.list('public_image', null, 2)
    if (!p1.ok) throw new Error(p1.kind)
    expect(p1.files.map((f) => f.publicId)).toEqual(ids.slice(0, 2))
    expect(p1.nextCursor).not.toBeNull()
    const p2 = await stores.inventory.list('public_image', p1.nextCursor, 2)
    expect(p2.ok && p2.files.map((f) => f.publicId)).toEqual(ids.slice(2))
    expect(p2.ok && p2.nextCursor).toBeNull()
  })

  it('xoá chỉ trong prefix của loại; ngoài prefix → INVALID_REQUEST, không gọi mạng', async () => {
    const { fake, stores } = setup()
    const priv = await stores.privateStore.put({ data: PDF, mime: 'application/pdf' })
    if (!priv.ok) throw new Error(priv.kind)
    seed(fake, 'image', 'upload', 'thu-muc-khac/public/x')
    const before = fake.requests.length
    expect(await stores.inventory.delete('public_image', 'thu-muc-khac/public/x')).toEqual({ ok: false, kind: 'INVALID_REQUEST' })
    expect(await stores.inventory.delete('public_image', priv.publicId)).toEqual({ ok: false, kind: 'INVALID_REQUEST' })
    expect(await stores.inventory.delete('private_raw', 'ottm-test/private/')).toEqual({ ok: false, kind: 'INVALID_REQUEST' })
    expect(fake.requests.length).toBe(before)
    expect(await stores.inventory.delete('private_raw', priv.publicId)).toEqual({ ok: true })
    expect(fake.assets.has(`raw/authenticated/${priv.publicId}`)).toBe(false)
    expect(fake.assets.has('image/upload/thu-muc-khac/public/x')).toBe(true)
  })

  it('sai khoá → AUTH_FAILED; lỗi tạm / 420 phân loại; chưa cấu hình → MEDIA_NOT_CONFIGURED', async () => {
    const wrong = createFakeCloudinary({ ...CREDS, apiSecret: 'khac' })
    const stores = createMediaStores(config, { fetch: wrong.fetch })
    expect(await stores.inventory.list('public_image', null)).toMatchObject({ ok: false, kind: 'AUTH_FAILED' })
    const { fake, stores: ok } = setup()
    fake.failNext(420)
    expect(await ok.inventory.list('public_image', null)).toMatchObject({ ok: false, kind: 'RATE_LIMITED' })
    fake.failNext('bad-json')
    expect(await ok.inventory.list('public_image', null)).toMatchObject({ ok: false, kind: 'TRANSIENT' })
    const none = createMediaStores({ CLOUDINARY_FOLDER: 'ottm' })
    expect(await none.inventory.list('private_raw', null)).toEqual({ ok: false, kind: 'MEDIA_NOT_CONFIGURED' })
    expect(await none.inventory.delete('private_raw', 'ottm/private/a')).toEqual({ ok: false, kind: 'MEDIA_NOT_CONFIGURED' })
  })
})

describe('adapters/media — lỗi', () => {
  it('chưa cấu hình: mọi thao tác → MEDIA_NOT_CONFIGURED, không gọi mạng', async () => {
    let calls = 0
    const stores = createMediaStores({ CLOUDINARY_FOLDER: 'ottm' }, { fetch: (async () => { calls += 1; throw new Error('không được gọi') }) as typeof fetch })
    expect(stores.configured).toBe(false)
    const ref = { publicId: 'x', resourceType: 'raw' as const, format: null }
    const results = await Promise.all([
      stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' }),
      stores.publicStore.delete('x'),
      stores.publicStore.download('https://res.cloudinary.com/x/image/upload/v1/a.jpg'),
      stores.privateStore.put({ data: PDF, mime: 'application/pdf' }),
      stores.privateStore.get(ref),
      stores.privateStore.delete(ref),
    ])
    for (const r of results) expect(r).toEqual({ ok: false, kind: 'MEDIA_NOT_CONFIGURED' })
    expect(calls).toBe(0)
  })

  it('khởi tạo không gọi mạng', () => {
    let calls = 0
    const stores = createMediaStores(config, { fetch: (async () => { calls += 1; return new Response() }) as typeof fetch })
    expect(stores.configured).toBe(true)
    expect(calls).toBe(0)
  })

  it('sai secret → Cloudinary 401 → AUTH_FAILED, không retry, không lộ secret', async () => {
    const fake = createFakeCloudinary(CREDS)
    const wrong = { ...CREDS, apiSecret: 'sai-secret-ZZZ' }
    const stores = createMediaStores({ ...config, CLOUDINARY_URL: wrong }, { fetch: fake.fetch })
    const result = await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })
    expect(result).toEqual({ ok: false, kind: 'AUTH_FAILED', status: 401 })
    expect(fake.requests).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('sai-secret-ZZZ')
  })

  it.each([
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [429, 'RATE_LIMITED'],
    [420, 'RATE_LIMITED'],
    [500, 'TRANSIENT'],
    [502, 'TRANSIENT'],
    [503, 'TRANSIENT'],
    [400, 'INVALID_REQUEST'],
    [413, 'INVALID_REQUEST'],
  ] as const)('Cloudinary %i → %s (một lần gọi, caller quyết retry)', async (status, kind) => {
    const { fake, stores } = setup()
    fake.failNext(status)
    const result = await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })
    expect(result).toEqual({ ok: false, kind, status })
    expect(fake.requests).toHaveLength(1)
    noSecret(result)
  })

  it('cùng phân loại cho get và delete của file riêng tư', async () => {
    const { fake, stores } = setup()
    const ref = { publicId: 'ottm-test/private/x', resourceType: 'raw' as const, format: null }
    fake.failNext(403)
    expect(await stores.privateStore.get(ref)).toEqual({ ok: false, kind: 'AUTH_FAILED', status: 403 })
    fake.failNext(503)
    expect(await stores.privateStore.delete(ref)).toEqual({ ok: false, kind: 'TRANSIENT', status: 503 })
    fake.failNext(429)
    expect(await stores.privateStore.put({ data: PDF, mime: 'application/pdf' })).toEqual({ ok: false, kind: 'RATE_LIMITED', status: 429 })
  })

  it('lỗi mạng → TRANSIENT', async () => {
    const { fake, stores } = setup()
    fake.failNext('network')
    expect(await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })).toEqual({ ok: false, kind: 'TRANSIENT' })
  })

  it('hết giờ → TRANSIENT', async () => {
    const { fake, stores } = setup({}, { timeoutMs: 100, uploadTimeoutMs: 100 })
    fake.failNext('hang')
    const started = Date.now()
    expect(await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })).toEqual({ ok: false, kind: 'TRANSIENT' })
    fake.failNext('hang')
    expect(await stores.privateStore.get({ publicId: 'x', resourceType: 'raw', format: null })).toEqual({ ok: false, kind: 'TRANSIENT' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('200 mà body hỏng → TRANSIENT', async () => {
    const { fake, stores } = setup()
    fake.failNext('bad-json')
    expect(await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/png' })).toEqual({ ok: false, kind: 'TRANSIENT', status: 200 })
  })

  it('file hỏng (khai image/png nhưng không phải ảnh) → Cloudinary 400 → INVALID_REQUEST', async () => {
    const { stores } = setup()
    expect(await stores.publicStore.put({ data: Buffer.from('không phải ảnh'), mime: 'image/png' })).toEqual({
      ok: false,
      kind: 'INVALID_REQUEST',
      status: 400,
    })
  })

  it('quá lớn / rỗng / MIME ngoài danh sách → INVALID_REQUEST, không gọi mạng', async () => {
    const { fake, stores } = setup()
    const tooBig = Buffer.alloc(MEDIA_MAX_BYTES + 1)
    expect(await stores.publicStore.put({ data: tooBig, mime: 'image/png' })).toEqual({ ok: false, kind: 'INVALID_REQUEST' })
    expect(await stores.privateStore.put({ data: tooBig, mime: 'application/pdf' })).toEqual({ ok: false, kind: 'INVALID_REQUEST' })
    expect(await stores.publicStore.put({ data: Buffer.alloc(0), mime: 'image/png' })).toEqual({ ok: false, kind: 'INVALID_REQUEST' })
    expect(await stores.publicStore.put({ data: FAKE_PNG, mime: 'image/svg+xml' as 'image/png' })).toEqual({ ok: false, kind: 'INVALID_REQUEST' })
    expect(await stores.publicStore.put({ data: PDF, mime: 'application/pdf' as 'image/png' })).toEqual({ ok: false, kind: 'INVALID_REQUEST' })
    expect(await stores.privateStore.put({ data: PDF, mime: 'application/zip' as 'application/pdf' })).toEqual({ ok: false, kind: 'INVALID_REQUEST' })
    expect(fake.requests).toHaveLength(0)
  })

  it('classifyStatus', () => {
    expect(classifyStatus(404)).toBe('NOT_FOUND')
    expect(classifyStatus(422)).toBe('INVALID_REQUEST')
    expect(classifyStatus(504)).toBe('TRANSIENT')
    expect(classifyStatus(418)).toBe('TRANSIENT')
  })
})

describe('config CLOUDINARY_URL / CLOUDINARY_FOLDER', () => {
  const dev = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }

  it('hợp lệ → tách cloudName/apiKey/apiSecret; JSON của config không lộ secret', () => {
    const cfg = parseEnv({ ...dev, CLOUDINARY_URL })
    expect(cfg.CLOUDINARY_URL).toMatchObject(CREDS)
    expect(cfg.CLOUDINARY_FOLDER).toBe('ottm')
    expect(JSON.stringify(cfg)).not.toContain(CREDS.apiSecret)
  })

  it('có phần ?tuỳ chọn (vd secure_distribution) → nhận, bỏ qua phần query', () => {
    const cfg = parseEnv({ ...dev, CLOUDINARY_URL: `${CLOUDINARY_URL}?secure_distribution=media.example.com&private_cdn=true` })
    expect(cfg.CLOUDINARY_URL).toMatchObject(CREDS)
    expect(cfg.CLOUDINARY_URL?.cloudName).toBe(CREDS.cloudName)
  })

  it('không đặt / rỗng → không cấu hình (vẫn khởi động)', () => {
    expect(parseEnv(dev).CLOUDINARY_URL).toBeUndefined()
    expect(parseEnv({ ...dev, CLOUDINARY_URL: '' }).CLOUDINARY_URL).toBeUndefined()
  })

  it.each(['abc', 'https://api.cloudinary.com', `CLOUDINARY_URL=${CLOUDINARY_URL}`, 'cloudinary://key@cloud', 'cloudinary://k:s@'])(
    'sai dạng %s → lỗi nêu CLOUDINARY_URL, không chép giá trị',
    (value) => {
      let err: unknown
      try {
        parseEnv({ ...dev, CLOUDINARY_URL: value })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as ConfigError).variables).toEqual(['CLOUDINARY_URL'])
      expect((err as ConfigError).message).not.toContain(value)
    },
  )

  it('sai dạng không lộ secret trong thông báo', () => {
    try {
      parseEnv({ ...dev, CLOUDINARY_URL: `cloudinary://${CREDS.apiKey}:${CREDS.apiSecret}@` })
      expect.unreachable()
    } catch (e) {
      expect((e as Error).message).not.toContain(CREDS.apiSecret)
    }
  })

  it('CLOUDINARY_FOLDER: nhiều cấp được, ký tự lạ / dấu / đầu cuối bị từ chối', () => {
    expect(parseEnv({ ...dev, CLOUDINARY_FOLDER: 'ottm-dev/cuong_1' }).CLOUDINARY_FOLDER).toBe('ottm-dev/cuong_1')
    for (const bad of ['/ottm', 'ottm/', 'a//b', 'ảnh', 'a b', '../x']) {
      expect(() => parseEnv({ ...dev, CLOUDINARY_FOLDER: bad })).toThrow(/CLOUDINARY_FOLDER/)
    }
  })

  it('parseMediaEnv không đòi DATABASE_URL', () => {
    expect(parseMediaEnv({ CLOUDINARY_URL }).CLOUDINARY_URL).toMatchObject({ cloudName: CREDS.cloudName })
    expect(parseMediaEnv({})).toEqual({ CLOUDINARY_FOLDER: 'ottm' })
    expect(() => parseMediaEnv({ CLOUDINARY_URL: 'abc' })).toThrow(/CLOUDINARY_URL/)
  })
})

describe('log redact', () => {
  it('CLOUDINARY_URL, apiSecret, api_secret, signature bị che', () => {
    const lines: string[] = []
    const dest = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb() } })
    const logger = createLogger({ level: 'info' }, dest as unknown as pino.DestinationStream)
    logger.info({ CLOUDINARY_URL, cfg: { apiSecret: CREDS.apiSecret }, params: { api_secret: CREDS.apiSecret, signature: 'abc123sig' } }, 'x')
    const out = lines.join('')
    expect(out).not.toContain(CREDS.apiSecret)
    expect(out).not.toContain('abc123sig')
    expect(out).toContain('[REDACTED]')
  })
})

describe('media:check (scripts/lib/media-check.ts) trên Cloudinary giả', () => {
  it('đủ bước → true; xoá hết file đã tạo', async () => {
    const { fake, stores } = setup()
    const lines: string[] = []
    const ok = await runMediaCheck({ stores, cloudName: CREDS.cloudName, fetch: fake.fetch, log: (l) => lines.push(l) })
    expect(lines.filter((l) => l.startsWith('LỖI'))).toEqual([])
    expect(ok).toBe(true)
    expect(fake.assets.size).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('URL công khai tải được')
    expect(out).toMatch(/không tải được bằng URL thường/)
    expect(out).not.toContain(CREDS.apiSecret)
  })

  it('chưa cấu hình → false, gợi ý CLOUDINARY_URL', async () => {
    const lines: string[] = []
    const ok = await runMediaCheck({ stores: createMediaStores({ CLOUDINARY_FOLDER: 'ottm' }), cloudName: 'x', log: (l) => lines.push(l) })
    expect(ok).toBe(false)
    expect(lines.join('\n')).toContain('CLOUDINARY_URL')
  })

  it('sai khoá → false, báo AUTH_FAILED', async () => {
    const fake = createFakeCloudinary(CREDS)
    const stores = createMediaStores({ ...config, CLOUDINARY_URL: { ...CREDS, apiSecret: 'sai' } }, { fetch: fake.fetch })
    const lines: string[] = []
    expect(await runMediaCheck({ stores, cloudName: CREDS.cloudName, fetch: fake.fetch, log: (l) => lines.push(l) })).toBe(false)
    expect(lines.join('\n')).toContain('AUTH_FAILED')
  })

  it('URL riêng tư không chữ ký trả 3xx → false (chỉ 401/403/404 mới là chặn)', async () => {
    const { fake, stores } = setup()
    const redirects = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = String(input instanceof Request ? input.url : input)
      if (href.startsWith(`${FAKE_DELIVERY_BASE_URL}/`) && href.includes('/private/')) {
        return new Response(null, { status: 302, headers: { location: 'https://example.com/file' } })
      }
      return fake.fetch(input, init)
    }) as typeof fetch
    const lines: string[] = []
    expect(await runMediaCheck({ stores, cloudName: CREDS.cloudName, fetch: redirects, log: (l) => lines.push(l) })).toBe(false)
    expect(lines.join('\n')).toContain('HTTP 302')
    expect(fake.assets.size).toBe(0)
  })

  it('file riêng tư tải được bằng URL thường → false (phát hiện lộ)', async () => {
    const { fake, stores } = setup()
    // Giả lập tài khoản phục vụ cả file authenticated không chữ ký.
    const leaky = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = String(input instanceof Request ? input.url : input)
      if (href.startsWith(`${FAKE_DELIVERY_BASE_URL}/`) && href.includes('/private/')) return new Response('lộ', { status: 200 })
      return fake.fetch(input, init)
    }) as typeof fetch
    const lines: string[] = []
    expect(await runMediaCheck({ stores, cloudName: CREDS.cloudName, fetch: leaky, log: (l) => lines.push(l) })).toBe(false)
    expect(lines.join('\n')).toContain('bị lộ')
    expect(fake.assets.size).toBe(0)
  })
})
