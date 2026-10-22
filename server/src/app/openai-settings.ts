// Cài đặt › Kết nối OpenAI (Story 1.5). Mọi route dưới /api/v1 → guard auth đã yêu cầu phiên.
// Khoá không bao giờ quay lại client: phản hồi chỉ có `{configured, last4, status, checkedAt, reason}` (AD-12).
import { SaveOpenAiKeyRequest, type OpenAiKeyInfo, type OpenAiSettingsResponse } from '@ottm/shared'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import {
  deleteOpenAiKey,
  getOpenAiSettings,
  recheckOpenAiKey,
  setOpenAiKey,
  setOpenAiSettings,
  type AiDeps,
} from '../modules/ai/index.ts'
import { AppError } from '../platform/errors/index.ts'

/** Lỗi phía OpenAI: chỉ ghi loại lỗi đã phân loại, không ghi khoá hay body. */
async function logProviderError<T>(log: FastifyBaseLogger, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof AppError && err.code === 'AI_PROVIDER_ERROR') {
      log.warn({ details: err.details }, 'kiểm khoá OpenAI: OpenAI không trả lời được')
    }
    throw err
  }
}

export function registerOpenAiSettings(app: FastifyInstance, deps: AiDeps): void {
  app.get('/api/v1/settings/openai', async (): Promise<OpenAiSettingsResponse> => getOpenAiSettings(deps))

  app.put('/api/v1/settings/openai', async (req): Promise<OpenAiSettingsResponse> => setOpenAiSettings(deps, req.body ?? {}))

  app.put('/api/v1/settings/openai/key', async (req): Promise<OpenAiKeyInfo> => {
    // Kiểm dạng body ở đây không dùng `parse` (issue của zod có thể chép giá trị khoá vào `details`).
    const body = SaveOpenAiKeyRequest.safeParse(req.body ?? {})
    if (!body.success) throw new AppError('VALIDATION_FAILED', 400, { details: [{ path: ['apiKey'], message: 'khoá sai dạng' }] })
    return logProviderError(req.log, () => setOpenAiKey(deps, body.data.apiKey))
  })

  app.delete('/api/v1/settings/openai/key', async (): Promise<OpenAiKeyInfo> => deleteOpenAiKey(deps))

  app.post('/api/v1/settings/openai/key/recheck', async (req): Promise<OpenAiKeyInfo> =>
    logProviderError(req.log, () => recheckOpenAiKey(deps)),
  )
}
