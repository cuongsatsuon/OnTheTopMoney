// Viết thử bằng AI theo hồ sơ nháp (Story 3.4, AD-2 ngoại lệ sinh chữ tương tác + AD-7 + AD-21).
// `POST /api/v1/brand-profiles/sample`: body = hồ sơ nháp (KHÔNG lưu) → gateway `feature=brand_sample` (chạy TRONG
// request, trả JSON một lần, không stream) → `checkOutput` (AD-21); vi phạm → sinh lại MỘT lần; vẫn vi phạm → trả
// kèm `violations` để FE đánh dấu. Dừng = client đóng kết nối → `AbortSignal` sang OpenAI, reservation được release,
// KHÔNG settle chi phí phần chưa chạy (gateway lo). Lỗi gateway (hết hạn mức / thiếu khoá / khoá hỏng) giữ nguyên mã
// (AI_BUDGET_EXCEEDED / OPENAI_KEY_MISSING / OPENAI_KEY_INVALID) để FE khoá nút (UX-DR2), chủ shop vẫn sửa tay.
import { BrandSampleRequest, type BrandSampleResponse, type ParsedBrandSample } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { buildCaptionPrompt, checkOutput, generateText, type AiDeps, type CheckBrand } from '../modules/ai/index.ts'
import { AppError } from '../platform/errors/index.ts'

export type BrandSampleDeps = Pick<AiDeps, 'db' | 'events' | 'cipher' | 'openai' | 'log'>

/** Lỗi huỷ (client đóng kết nối / nút Dừng) — không phải lỗi server, không trả JSON. */
export function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * Lõi "Viết thử": sinh caption theo hồ sơ nháp (AD-7, `feature=brand_sample`), hậu kiểm AD-21, vi phạm → sinh lại
 * MỘT lần (tối đa 2 lời gọi). `signal` huỷ sang OpenAI (nút Dừng). Tách khỏi route để test được mà không cần socket.
 */
export async function runBrandSample(deps: BrandSampleDeps, brand: ParsedBrandSample, signal: AbortSignal): Promise<BrandSampleResponse> {
  const prompt = buildCaptionPrompt(brand)
  const checkBrand: CheckBrand = { bannedWords: brand.bannedWords, allowedDomains: brand.allowedDomains }
  const generate = () =>
    generateText(deps, {
      feature: 'brand_sample',
      instructions: prompt.instructions,
      input: prompt.input,
      maxOutputTokens: prompt.maxOutputTokens,
      signal,
    })

  let text = (await generate()).text
  let check = checkOutput(text, { brand: checkBrand, kind: 'caption' })
  if (!check.clean) {
    text = (await generate()).text
    check = checkOutput(text, { brand: checkBrand, kind: 'caption' })
  }
  return { caption: text, violations: check.violations, avoidedBannedCount: brand.bannedWords.length }
}

export function registerBrandSample(app: FastifyInstance, deps: BrandSampleDeps): void {
  app.post('/api/v1/brand-profiles/sample', async (req, reply): Promise<BrandSampleResponse | undefined> => {
    const brand = BrandSampleRequest.parse(req.body ?? {})

    // Nút "Dừng" = client huỷ request → đóng kết nối. Theo dõi `req.raw` 'close' để truyền abort sang OpenAI (AD-7).
    // `clientClosed` phân biệt "client thật sự đóng" với một AbortError đến từ gateway khi client còn kết nối.
    const controller = new AbortController()
    let clientClosed = false
    const onClose = () => {
      clientClosed = true
      controller.abort()
    }
    req.raw.on('close', onClose)

    try {
      return await runBrandSample(deps, brand, controller.signal)
    } catch (err) {
      // Client đã đi (Dừng / đóng tab): không còn ai nhận JSON → nhường Fastify, không coi là lỗi 500.
      if (clientClosed) {
        reply.hijack()
        return undefined
      }
      // AbortError nhưng client CÒN kết nối (abort từ gateway/provider, không do nút Dừng) → trả lỗi, đừng treo client.
      if (isAbort(err)) throw new AppError('AI_PROVIDER_ERROR', 502, { message: 'AI bị gián đoạn, thử lại.' })
      throw err // lỗi gateway khác: giữ nguyên mã (AI_BUDGET_EXCEEDED / OPENAI_KEY_* / …) cho error handler.
    } finally {
      req.raw.off('close', onClose)
    }
  })
}
