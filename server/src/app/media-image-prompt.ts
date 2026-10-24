// AI viết mô tả ảnh ở Soạn bài (Story 6.7, AD-2 ngoại lệ sinh chữ tương tác + AD-7). Route dưới /api/v1 → guard auth.
// `POST /api/v1/media-assets/image-prompt {description, topic, direction, goal?, style?, withReference, pageIds?}` → 200
// `{description}` (JSON một lần, không lưu). Nghiệp vụ ở `content.writeImageDescription` (gateway `feature=image_prompt`).
// Dừng = client đóng kết nối → AbortSignal sang OpenAI (dùng chung `runAbortable` với Soạn bài / Viết thử).
import { ImagePromptRequest, ImagePromptResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { writeImageDescription, type ImagePromptDeps } from '../modules/content/index.ts'
import { runAbortable } from './ai-request.ts'

export function registerMediaImagePrompt(app: FastifyInstance, deps: ImagePromptDeps): void {
  app.post('/api/v1/media-assets/image-prompt', async (req, reply): Promise<ImagePromptResponse | undefined> => {
    const input = ImagePromptRequest.parse(req.body ?? {})
    return runAbortable(reply, async (signal) => ImagePromptResponse.parse(await writeImageDescription(deps, input, signal)))
  })
}
