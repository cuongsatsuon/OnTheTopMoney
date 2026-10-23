// Sinh chữ AI tương tác trong request (AD-2 ngoại lệ, AD-7): dùng chung cho "Viết thử bằng AI" (Story 3.4) và "Gợi ý
// bằng AI" ở Hộp thư (Story 4.8). Nút "Dừng" = client huỷ request → đóng kết nối → `AbortSignal` sang OpenAI (gateway
// release chỗ giữ, không settle phần chưa chạy). Client đã đi thì không còn ai nhận JSON → nhường Fastify, không 500.
import type { FastifyReply } from 'fastify'
import { AppError } from '../platform/errors/index.ts'

/** Lỗi huỷ (client đóng kết nối / nút Dừng) — không phải lỗi server, không trả JSON. */
export function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * Chạy `run(signal)` với `signal` huỷ khi client đóng kết nối. `undefined` = client đã đi (đã `hijack`). AbortError
 * trong khi client CÒN kết nối (abort từ gateway/provider, không do nút Dừng) → `AI_PROVIDER_ERROR` 502, đừng treo
 * client. Lỗi khác giữ nguyên mã (AI_BUDGET_EXCEEDED / OPENAI_KEY_* / CONFIG_MISSING / …) cho error handler.
 */
export async function runAbortable<T>(reply: FastifyReply, run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  // `clientClosed` phân biệt "client thật sự đóng" với một AbortError đến từ gateway khi client còn kết nối.
  // Nghe 'close' của RESPONSE, không phải của request: `IncomingMessage` phát 'close' ngay khi đã đọc hết body (Node ≥16)
  // nên request có body JSON sẽ bị huỷ oan ngay sau khi parse. Response 'close' trước khi ghi xong = client đã đi.
  const controller = new AbortController()
  let clientClosed = false
  const onClose = () => {
    if (reply.raw.writableFinished) return
    clientClosed = true
    controller.abort()
  }
  reply.raw.on('close', onClose)
  try {
    return await run(controller.signal)
  } catch (err) {
    if (clientClosed) {
      reply.hijack()
      return undefined
    }
    if (isAbort(err)) throw new AppError('AI_PROVIDER_ERROR', 502, { message: 'AI bị gián đoạn, thử lại.' })
    throw err
  } finally {
    reply.raw.off('close', onClose)
  }
}
