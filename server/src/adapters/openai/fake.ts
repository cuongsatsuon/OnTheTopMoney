// Fake adapter OpenAI cho test (AD-7): không gọi mạng.
// - `checkKey`: khoá nằm trong `results` trả kết quả đó; khoá khác trả `fallback` (mặc định KEY_INVALID 401).
// - `createResponse` / `generateImage`: mặc định thành công với usage cố định; đổi bằng `onResponse` /
//   `onImage` (giá trị hoặc hàm nhận request — trả Promise để giả lời gọi chậm, đọc `request.signal` để giả huỷ).
import type {
  CheckKeyResult,
  CreateResponseRequest,
  CreateResponseResult,
  GenerateImageRequest,
  GenerateImageResult,
  OpenAiAdapter,
} from './index.ts'

type Handler<Req, Res> = Res | ((request: Req) => Res | Promise<Res>)

export interface FakeOpenAiAdapter extends OpenAiAdapter {
  /** Số lần `checkKey` đã được gọi. */
  readonly calls: number
  /** Các request sinh chữ / ảnh đã nhận (theo thứ tự). */
  readonly responseRequests: readonly CreateResponseRequest[]
  readonly imageRequests: readonly GenerateImageRequest[]
  /** Đặt kết quả cho một khoá (hoặc cho mọi khoá chưa đặt, với `'*'`). */
  set(apiKey: string | '*', result: CheckKeyResult): void
  onResponse(handler: Handler<CreateResponseRequest, CreateResponseResult>): void
  onImage(handler: Handler<GenerateImageRequest, GenerateImageResult>): void
}

export const FAKE_RESPONSE_TEXT = 'Xin chào từ fake OpenAI'
/** 1×1 JPEG tối giản (đủ để kiểm bytes trả về). */
export const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])

export const DEFAULT_RESPONSE: CreateResponseResult = {
  ok: true,
  id: 'resp_fake',
  text: FAKE_RESPONSE_TEXT,
  usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 500 },
  incomplete: null,
}

export function createFakeOpenAiAdapter(
  results: Record<string, CheckKeyResult> = {},
  fallback: CheckKeyResult = { ok: false, kind: 'KEY_INVALID', status: 401 },
): FakeOpenAiAdapter {
  const table = new Map(Object.entries(results))
  let fallbackResult = fallback
  let calls = 0
  const responseRequests: CreateResponseRequest[] = []
  const imageRequests: GenerateImageRequest[] = []
  let responseHandler: Handler<CreateResponseRequest, CreateResponseResult> = DEFAULT_RESPONSE
  let imageHandler: Handler<GenerateImageRequest, GenerateImageResult> = (req) => ({
    ok: true,
    images: Array.from({ length: req.n }, () => Buffer.from(FAKE_JPEG)),
    usage: null,
  })
  const run = async <Req, Res>(handler: Handler<Req, Res>, req: Req): Promise<Res> =>
    typeof handler === 'function' ? (handler as (r: Req) => Res | Promise<Res>)(req) : handler

  return {
    get calls() {
      return calls
    },
    responseRequests,
    imageRequests,
    set(apiKey, result) {
      if (apiKey === '*') fallbackResult = result
      else table.set(apiKey, result)
    },
    onResponse(handler) {
      responseHandler = handler
    },
    onImage(handler) {
      imageHandler = handler
    },
    async checkKey(apiKey) {
      calls += 1
      return table.get(apiKey) ?? fallbackResult
    },
    async createResponse(request) {
      responseRequests.push(request)
      if (request.signal?.aborted) return { ok: false, kind: 'ABORTED', maybeBilled: false }
      return run(responseHandler, request)
    },
    async generateImage(request) {
      imageRequests.push(request)
      if (request.signal?.aborted) return { ok: false, kind: 'ABORTED', maybeBilled: false }
      return run(imageHandler, request)
    },
  }
}
