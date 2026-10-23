// Gợi ý bằng AI ở Hộp thư (Story 4.8, AD-2 ngoại lệ sinh chữ tương tác + AD-7 + AD-8 + AD-21).
// `POST /api/v1/conversations/:id/suggest {mode?}` → 200 `{draft, violations}` (JSON một lần, không stream, không job).
// Route ghép hai module (AD-1: `inbox` không gọi `profiles`): hồ sơ hiệu lực của trang qua `profiles.resolveEffective`
// (không có → 422 `CONFIG_MISSING`, FE khoá nút cho trang đó) truyền vào `inbox.suggestReply` (tin gần nhất → gateway
// `feature=inbox_suggest` → `checkOutput`, sinh lại một lần). Dừng = client đóng kết nối → AbortSignal sang OpenAI. Lỗi
// gateway giữ nguyên mã (`OPENAI_KEY_*` / `AI_BUDGET_EXCEEDED`) để FE khoá nút; chủ shop vẫn gõ tay và gửi được.
import { SuggestReplyBody, SuggestReplyResponse, type BrandProfileDto } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { suggestReply, type SuggestDeps } from '../modules/inbox/index.ts'
import { resolveEffective } from '../modules/profiles/index.ts'
import { AppError } from '../platform/errors/index.ts'
import { runAbortable } from './ai-request.ts'

const IdParam = z.object({ id: z.uuid() })

export function registerInboxSuggest(app: FastifyInstance, deps: SuggestDeps): void {
  app.post('/api/v1/conversations/:id/suggest', async (req, reply): Promise<SuggestReplyResponse | undefined> => {
    const { id } = IdParam.parse(req.params)
    const { mode } = SuggestReplyBody.parse(req.body ?? {})
    const brandOf = async (pageId: string) => (await resolveEffective<BrandProfileDto>(deps.db, pageId, 'brand')).config
    return runAbortable(reply, async (signal) => {
      const result = await suggestReply(deps, id, { mode, brandOf, signal })
      if (result.status === 'missing') throw new AppError('NOT_FOUND', 404, { message: 'Hội thoại không tồn tại' })
      return SuggestReplyResponse.parse({ draft: result.draft, violations: result.violations })
    })
  })
}
