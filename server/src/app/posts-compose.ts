// Viết caption bằng AI ở Soạn bài (Story 6.2, AD-2 ngoại lệ sinh chữ tương tác + AD-7 + AD-8 + AD-21).
// `POST /api/v1/posts/compose {topic, goal, length, pageIds, revise?}` → 200 `{results}` (JSON một lần, không stream,
// không job, không lưu bài). Nghiệp vụ ở `content.composeCaptions` (hồ sơ hiệu lực từng trang → gateway
// `feature=compose_caption` → `checkOutput`); mỗi trang một kết quả, trang chưa có hồ sơ báo `CONFIG_MISSING` riêng.
// Dừng = client đóng kết nối → AbortSignal sang OpenAI (dùng chung `runAbortable` với Viết thử / Gợi ý).
import { ComposeCaptionsRequest, ComposeCaptionsResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { composeCaptions, type ComposeDeps } from '../modules/content/index.ts'
import { runAbortable } from './ai-request.ts'

export function registerPostsCompose(app: FastifyInstance, deps: ComposeDeps): void {
  app.post('/api/v1/posts/compose', async (req, reply): Promise<ComposeCaptionsResponse | undefined> => {
    const input = ComposeCaptionsRequest.parse(req.body ?? {})
    return runAbortable(reply, async (signal) => ComposeCaptionsResponse.parse(await composeCaptions(deps, input, signal)))
  })
}
