// adapters/openai — checkKey gọi GET /v1/models; createResponse (Responses API, store:false) và generateImage
// (Images API, JPEG base64): phân loại lỗi, timeout, huỷ, không đưa khoá vào kết quả. Story 6.6: editImage (multipart
// `image[]`), ảnh trong createResponse (`input_image` base64), `input_fidelity` theo model, usage tách token ảnh vào.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyStatus, createOpenAiAdapter, inputFidelityFor, parseUsage } from '../src/adapters/openai/index.ts'
import { freePort } from './helpers/net.ts'

const KEY = 'sk-test-ADAPTER-0000'

describe('adapters/openai checkKey', () => {
  let server: Server
  let baseUrl: string
  let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {}
  const seen: { method?: string; url?: string; auth?: string }[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization })
      handler(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const reply = (status: number, body: unknown) => {
    handler = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
  }

  it('200 → ok; gọi GET /v1/models kèm Bearer', async () => {
    reply(200, { object: 'list', data: [] })
    seen.length = 0
    expect(await createOpenAiAdapter({ baseUrl }).checkKey(KEY)).toEqual({ ok: true })
    expect(seen).toEqual([{ method: 'GET', url: '/v1/models', auth: `Bearer ${KEY}` }])
  })

  it.each([
    [401, { error: { code: 'invalid_api_key' } }, 'KEY_INVALID'],
    [403, { error: { code: 'unsupported_country_region_territory' } }, 'KEY_RESTRICTED'],
    [429, { error: { code: 'insufficient_quota' } }, 'PROVIDER_QUOTA'],
    [429, { error: { code: 'rate_limit_exceeded' } }, 'RATE_LIMITED'],
    [500, { error: {} }, 'TRANSIENT'],
    [503, 'không phải json', 'TRANSIENT'],
  ])('%i → %s', async (status, body, kind) => {
    reply(status, body)
    const result = await createOpenAiAdapter({ baseUrl }).checkKey(KEY)
    expect(result).toEqual({ ok: false, kind, status })
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('không trả lời trong thời hạn → TRANSIENT (timeout)', async () => {
    handler = () => {} // giữ kết nối, không trả lời
    const started = Date.now()
    expect(await createOpenAiAdapter({ baseUrl, timeoutMs: 200 }).checkKey(KEY)).toEqual({ ok: false, kind: 'TRANSIENT' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('không kết nối được → TRANSIENT', async () => {
    const port = await freePort()
    expect(await createOpenAiAdapter({ baseUrl: `http://127.0.0.1:${port}/v1` }).checkKey(KEY)).toEqual({ ok: false, kind: 'TRANSIENT' })
  })

  it('classifyStatus: nội dung bị chặn → CONTENT_REJECTED; request sai cố định → INVALID_REQUEST (không retry)', () => {
    expect(classifyStatus(400, 'content_policy_violation')).toBe('CONTENT_REJECTED')
    expect(classifyStatus(400, 'moderation_blocked')).toBe('CONTENT_REJECTED')
    expect(classifyStatus(400, 'content_filter')).toBe('CONTENT_REJECTED')
    expect(classifyStatus(400)).toBe('INVALID_REQUEST')
    expect(classifyStatus(400, 'invalid_request_error')).toBe('INVALID_REQUEST')
    expect(classifyStatus(400, 'context_length_exceeded')).toBe('INVALID_REQUEST')
    expect(classifyStatus(404, 'model_not_found')).toBe('INVALID_REQUEST')
    expect(classifyStatus(422)).toBe('INVALID_REQUEST')
    expect(classifyStatus(500)).toBe('TRANSIENT')
    expect(classifyStatus(503)).toBe('TRANSIENT')
  })
})

describe('adapters/openai createResponse / generateImage', () => {
  let server: Server
  let baseUrl: string
  let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void = () => {}
  const seen: { method?: string; url?: string; auth?: string; body: Record<string, unknown> }[] = []
  let closedEarly = 0

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => (raw += c.toString()))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} })
        res.on('close', () => {
          if (!res.writableFinished) closedEarly += 1
        })
        handler(req, res, raw)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const reply = (status: number, body: unknown) => {
    handler = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
  }
  const textReq = { apiKey: KEY, model: 'gpt-6-luna', instructions: 'Viết ngắn', input: 'Chào shop', maxOutputTokens: 300 }

  it('POST /v1/responses với store:false, max_output_tokens; gom output_text, đọc usage (cached)', async () => {
    reply(200, {
      id: 'resp_1',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'Xin ' }, { type: 'output_text', text: 'chào' }] },
      ],
      usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 20 }, output_tokens: 33, total_tokens: 153 },
    })
    seen.length = 0
    const result = await createOpenAiAdapter({ baseUrl }).createResponse(textReq)
    expect(result).toEqual({
      ok: true,
      id: 'resp_1',
      text: 'Xin chào',
      usage: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 33 },
      incomplete: null,
    })
    expect(seen).toEqual([
      {
        method: 'POST',
        url: '/v1/responses',
        auth: `Bearer ${KEY}`,
        body: { model: 'gpt-6-luna', input: 'Chào shop', instructions: 'Viết ngắn', max_output_tokens: 300, store: false },
      },
    ])
  })

  it('incomplete: max_output_tokens giữ chữ; content_filter / refusal được đánh dấu', async () => {
    const usage = { input_tokens: 1, output_tokens: 1 }
    reply(200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Cắt' }] }], usage })
    expect(await createOpenAiAdapter({ baseUrl }).createResponse(textReq)).toMatchObject({ ok: true, text: 'Cắt', incomplete: 'max_output_tokens' })
    reply(200, { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [], usage })
    expect(await createOpenAiAdapter({ baseUrl }).createResponse(textReq)).toMatchObject({ ok: true, incomplete: 'content_filter' })
    reply(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Không' }] }], usage })
    expect(await createOpenAiAdapter({ baseUrl }).createResponse(textReq)).toMatchObject({ ok: true, text: '', incomplete: 'refusal' })
  })

  it('200 không có usage → TRANSIENT (không tính được tiền, có thể đã bị tính)', async () => {
    reply(200, { status: 'completed', output: [] })
    expect(await createOpenAiAdapter({ baseUrl }).createResponse(textReq)).toEqual({ ok: false, kind: 'TRANSIENT', status: 200, maybeBilled: true })
  })

  it.each(['failed', 'cancelled', 'in_progress', 'queued'])('200 với status %s → TRANSIENT, không trả chữ rỗng như thành công', async (status) => {
    reply(200, { status, output: [], usage: { input_tokens: 5, output_tokens: 0 } })
    expect(await createOpenAiAdapter({ baseUrl }).createResponse(textReq)).toEqual({ ok: false, kind: 'TRANSIENT', status: 200, maybeBilled: true })
  })

  it('không kết nối được → TRANSIENT, chắc chắn chưa tính tiền (maybeBilled false)', async () => {
    const port = await freePort()
    expect(await createOpenAiAdapter({ baseUrl: `http://127.0.0.1:${port}/v1` }).createResponse(textReq)).toEqual({ ok: false, kind: 'TRANSIENT', maybeBilled: false })
  })

  it.each([
    [401, { error: { code: 'invalid_api_key' } }, 'KEY_INVALID'],
    [403, { error: { code: 'unsupported_country_region_territory' } }, 'KEY_RESTRICTED'],
    [429, { error: { code: 'insufficient_quota' } }, 'PROVIDER_QUOTA'],
    [429, { error: { code: 'rate_limit_exceeded' } }, 'RATE_LIMITED'],
    [400, { error: { code: 'content_policy_violation' } }, 'CONTENT_REJECTED'],
    [400, { error: { code: 'context_length_exceeded' } }, 'INVALID_REQUEST'],
    [500, { error: {} }, 'TRANSIENT'],
  ])('lỗi %i → %s (cả chữ lẫn ảnh)', async (status, body, kind) => {
    reply(status, body)
    const adapter = createOpenAiAdapter({ baseUrl })
    const text = await adapter.createResponse(textReq)
    const image = await adapter.generateImage({ apiKey: KEY, model: 'gpt-image-2', prompt: 'mèo', n: 1, size: '1024x1024' })
    expect(text).toEqual({ ok: false, kind, status })
    expect(image).toEqual({ ok: false, kind, status })
    expect(JSON.stringify([text, image])).not.toContain(KEY)
  })

  it('hết giờ → TRANSIENT; caller huỷ → ABORTED và kết nối tới OpenAI bị đóng', async () => {
    handler = () => {} // không trả lời
    expect(await createOpenAiAdapter({ baseUrl, responseTimeoutMs: 150 }).createResponse(textReq)).toEqual({ ok: false, kind: 'TRANSIENT', maybeBilled: true })

    closedEarly = 0
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const result = await createOpenAiAdapter({ baseUrl }).createResponse({ ...textReq, signal: controller.signal })
    expect(result).toEqual({ ok: false, kind: 'ABORTED', maybeBilled: true })
    expect(Date.now() - started).toBeLessThan(5_000)
    await new Promise((r) => setTimeout(r, 100))
    expect(closedEarly).toBeGreaterThanOrEqual(1)

    // Đã huỷ từ trước → không gửi request.
    seen.length = 0
    expect(await createOpenAiAdapter({ baseUrl }).generateImage({ apiKey: KEY, model: 'm', prompt: 'p', n: 1, size: 's', signal: AbortSignal.abort() })).toEqual({
      ok: false,
      kind: 'ABORTED',
      maybeBilled: false,
    })
    expect(seen).toEqual([])
  })

  it('POST /v1/images/generations output_format jpeg; giải base64; usage có thì đọc, không có → null', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    reply(200, { created: 1, data: [{ b64_json: jpeg.toString('base64') }, { b64_json: jpeg.toString('base64') }] })
    seen.length = 0
    const result = await createOpenAiAdapter({ baseUrl }).generateImage({ apiKey: KEY, model: 'gpt-image-2.5-flare', prompt: 'áo thun', n: 2, size: '1024x1536' })
    expect(result).toEqual({ ok: true, images: [jpeg, jpeg], usage: null })
    expect(seen[0]).toEqual({
      method: 'POST',
      url: '/v1/images/generations',
      auth: `Bearer ${KEY}`,
      body: { model: 'gpt-image-2.5-flare', prompt: 'áo thun', n: 2, size: '1024x1536', output_format: 'jpeg' },
    })

    reply(200, { data: [{ b64_json: jpeg.toString('base64') }], usage: { input_tokens: 50, output_tokens: 4160, input_tokens_details: { text_tokens: 50 } } })
    expect(await createOpenAiAdapter({ baseUrl }).generateImage({ apiKey: KEY, model: 'm', prompt: 'p', n: 1, size: 's' })).toEqual({
      ok: true,
      images: [jpeg],
      usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 4160 },
    })

    reply(200, { data: [] })
    expect(await createOpenAiAdapter({ baseUrl }).generateImage({ apiKey: KEY, model: 'm', prompt: 'p', n: 1, size: 's' })).toEqual({
      ok: false,
      kind: 'TRANSIENT',
      status: 200,
      maybeBilled: true,
    })
  })

  it('parseUsage: thiếu → null; cached không vượt input; số lạ → 0', () => {
    expect(parseUsage(undefined)).toBeNull()
    expect(parseUsage({})).toBeNull()
    expect(parseUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 99 }, output_tokens: -3 })).toEqual({ inputTokens: 10, cachedInputTokens: 10, outputTokens: 0 })
  })
})

describe('adapters/openai ảnh vào (Story 6.6)', () => {
  let server: Server
  let baseUrl: string
  let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {}
  const seen: { url?: string; contentType?: string; raw: Buffer }[] = []
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9])

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen.push({ url: req.url, contentType: req.headers['content-type'], raw: Buffer.concat(chunks) })
        handler(req, res)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const reply = (status: number, body: unknown) => {
    handler = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
  }

  it('editImage: POST /v1/images/edits multipart (model, prompt, n, size, output_format=jpeg, input_fidelity, image[] có MIME); usage tách token ảnh', async () => {
    reply(200, { data: [{ b64_json: jpeg.toString('base64') }], usage: { input_tokens: 1100, output_tokens: 4160, input_tokens_details: { image_tokens: 1000, text_tokens: 100 } } })
    seen.length = 0
    const result = await createOpenAiAdapter({ baseUrl }).editImage({
      apiKey: KEY,
      model: 'gpt-image-1.5',
      prompt: 'bàn gỗ',
      n: 1,
      size: '1024x1024',
      images: [{ data: jpeg, mime: 'image/jpeg' }],
      inputFidelity: 'high',
    })
    expect(result).toEqual({ ok: true, images: [jpeg], usage: { inputTokens: 1100, cachedInputTokens: 0, outputTokens: 4160, imageInputTokens: 1000 } })
    expect(seen[0]!.url).toBe('/v1/images/edits')
    expect(seen[0]!.contentType).toMatch(/^multipart\/form-data; boundary=/)
    const form = await new Response(new Uint8Array(seen[0]!.raw), { headers: { 'content-type': seen[0]!.contentType! } }).formData()
    expect(Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'))).toEqual({
      model: 'gpt-image-1.5',
      prompt: 'bàn gỗ',
      n: '1',
      size: '1024x1024',
      output_format: 'jpeg',
      input_fidelity: 'high',
    })
    const file = form.get('image[]') as File
    expect(file.type).toBe('image/jpeg')
    expect(file.name).toBe('reference-1.jpg')
    expect(Buffer.from(await file.arrayBuffer())).toEqual(jpeg)

    // Không có inputFidelity → không gửi trường; không ảnh → INVALID_REQUEST, không gọi mạng.
    seen.length = 0
    await createOpenAiAdapter({ baseUrl }).editImage({ apiKey: KEY, model: 'gpt-image-2', prompt: 'p', n: 1, size: 's', images: [{ data: jpeg, mime: 'image/jpeg' }] })
    const form2 = await new Response(new Uint8Array(seen[0]!.raw), { headers: { 'content-type': seen[0]!.contentType! } }).formData()
    expect(form2.has('input_fidelity')).toBe(false)
    seen.length = 0
    expect(await createOpenAiAdapter({ baseUrl }).editImage({ apiKey: KEY, model: 'm', prompt: 'p', n: 1, size: 's', images: [] })).toEqual({ ok: false, kind: 'INVALID_REQUEST' })
    expect(seen).toEqual([])

    reply(400, { error: { code: 'moderation_blocked' } })
    expect(await createOpenAiAdapter({ baseUrl }).editImage({ apiKey: KEY, model: 'm', prompt: 'p', n: 1, size: 's', images: [{ data: jpeg, mime: 'image/jpeg' }] })).toEqual({
      ok: false,
      kind: 'CONTENT_REJECTED',
      status: 400,
    })
  })

  it('createResponse có ảnh: input = message user [input_text, input_image data URL base64 + detail]; không URL', async () => {
    reply(200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 400, output_tokens: 5 } })
    seen.length = 0
    await createOpenAiAdapter({ baseUrl }).createResponse({
      apiKey: KEY,
      model: 'gpt-6-luna',
      input: 'Viết caption',
      maxOutputTokens: 100,
      images: [{ data: jpeg, mime: 'image/jpeg', detail: 'low' }],
    })
    expect(seen[0]!.contentType).toBe('application/json')
    const body = JSON.parse(seen[0]!.raw.toString()) as { input: unknown }
    expect(body.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Viết caption' },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'low' },
        ],
      },
    ])
    expect(seen[0]!.raw.toString()).not.toContain('https://')
  })

  it('inputFidelityFor: gpt-image-1 / 1.5 (+ snapshot) → high; mini / 2 / 2.5 / khác → không gửi', () => {
    expect(inputFidelityFor('gpt-image-1')).toBe('high')
    expect(inputFidelityFor('gpt-image-1.5')).toBe('high')
    expect(inputFidelityFor('gpt-image-1.5-2025-12-16')).toBe('high')
    for (const m of ['gpt-image-1-mini', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'dall-e-3']) expect(inputFidelityFor(m)).toBeUndefined()
  })
})
