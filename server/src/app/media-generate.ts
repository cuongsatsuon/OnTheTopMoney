// Sinh ảnh AI ở Soạn bài (Story 6.3, AD-14, AD-7, AD-2). Route dưới /api/v1 → guard auth đã yêu cầu phiên; ghi kiểm
// Origin (AD-19). `POST /api/v1/media-assets/generate {prompt, style}` → 202 `{images}`: 4 ô `pending` + 4 job
// `content.image.generate` cùng transaction (nghiệp vụ ở `content.requestImageGeneration`). Kho chưa cấu hình, khoá
// OpenAI thiếu / hỏng, hết hạn mức → lỗi ngay, không ghi gì. Ảnh về dần qua SSE (`media_asset.created|failed`).
import { GenerateImagesRequest, GeneratedImagesResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { requestImageGeneration, type RequestImagesDeps } from '../modules/content/index.ts'

export function registerMediaGenerate(app: FastifyInstance, deps: RequestImagesDeps): void {
  app.post('/api/v1/media-assets/generate', async (req, reply): Promise<GeneratedImagesResponse> => {
    const input = GenerateImagesRequest.parse(req.body ?? {})
    return reply.code(202).send({ images: await requestImageGeneration(deps, input) })
  })
}
