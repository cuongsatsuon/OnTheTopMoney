// Fake client Meta cho test của các module khác (AD-6): không gọi mạng, không kiểm ngân sách tần suất.
// - Ghi lại mọi lời gọi (`calls`) theo thứ tự.
// - Phản hồi lập trình theo `METHOD path` (path so khớp chính xác, bỏ `/` đầu): `on('GET', '/me/accounts', result)`;
//   `result` là giá trị hoặc hàm nhận lời gọi (trả Promise để giả lời gọi chậm).
// - Lời gọi chưa lập trình → `fallback` (mặc định `{ok: true, data: {}}`; đổi bằng `setFallback`).
import type { MetaCallOptions, MetaClient, MetaPostOptions, MetaResult } from './client.ts'

export interface FakeMetaCall {
  method: 'GET' | 'POST'
  path: string
  options: MetaPostOptions
}

type Handler = MetaResult | ((call: FakeMetaCall) => MetaResult | Promise<MetaResult>)

export interface FakeMetaClient extends MetaClient {
  readonly calls: readonly FakeMetaCall[]
  /** Lập trình phản hồi cho `method path`. Gọi lại với cùng khoá thì thay handler. */
  on(method: 'GET' | 'POST', path: string, handler: Handler): void
  /** Lập trình một chuỗi phản hồi: lần gọi thứ n nhận phần tử thứ n (hết chuỗi → phần tử cuối). */
  onSequence(method: 'GET' | 'POST', path: string, results: readonly MetaResult[]): void
  setFallback(handler: Handler): void
  /** Xoá lời gọi đã ghi và mọi handler. */
  reset(): void
}

const keyOf = (method: string, path: string) => `${method} /${path.replace(/^\/+/, '')}`

export function createFakeMetaClient(baseUrl = 'https://graph.facebook.com/v26.0'): FakeMetaClient {
  const calls: FakeMetaCall[] = []
  const handlers = new Map<string, Handler>()
  let fallback: Handler = { ok: true, data: {} }

  async function run(method: 'GET' | 'POST', path: string, options: MetaCallOptions | MetaPostOptions): Promise<MetaResult> {
    const call: FakeMetaCall = { method, path, options }
    calls.push(call)
    const handler = handlers.get(keyOf(method, path)) ?? fallback
    return typeof handler === 'function' ? handler(call) : handler
  }

  return {
    baseUrl,
    calls,
    on(method, path, handler) {
      handlers.set(keyOf(method, path), handler)
    },
    onSequence(method, path, results) {
      if (results.length === 0) throw new Error('onSequence cần ít nhất một kết quả')
      let i = 0
      handlers.set(keyOf(method, path), () => results[Math.min(i++, results.length - 1)]!)
    },
    setFallback(handler) {
      fallback = handler
    },
    reset() {
      calls.length = 0
      handlers.clear()
      fallback = { ok: true, data: {} }
    },
    get: <T>(path: string, options: MetaCallOptions) => run('GET', path, options) as Promise<MetaResult<T>>,
    post: <T>(path: string, options: MetaPostOptions) => run('POST', path, options) as Promise<MetaResult<T>>,
  }
}
