// "Thử AI" trước khi bật (Story 5.3, AD-16 + AD-7 + AD-21; AD-2 ngoại lệ sinh chữ tương tác như Gợi ý AI 4.8).
// `POST /api/v1/autoreply-configs/test` body = cấu hình NHÁP + tin thử (+ các lượt trước) → 200 `AutoreplyTestResponse`
// (JSON một lần, không stream, không job). Nghiệp vụ ở `autoreply.runAutoreplyTest` — cùng hàm quyết định với lượt chạy
// thật (5.4). Lỗi gateway đã thành quyết định chuyển người (khoá / hạn mức / sự cố), không thành lỗi HTTP. Dừng = client
// đóng kết nối → AbortSignal sang OpenAI (`runAbortable`).
import { AutoreplyTestRequest, type AutoreplyTestResponse } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { runAutoreplyTest, type DecideDeps } from '../modules/autoreply/index.ts'
import { runAbortable } from './ai-request.ts'

export function registerAutoreplyTest(app: FastifyInstance, deps: DecideDeps): void {
  app.post('/api/v1/autoreply-configs/test', async (req, reply): Promise<AutoreplyTestResponse | undefined> => {
    const body = AutoreplyTestRequest.parse(req.body ?? {})
    return runAbortable(reply, (signal) => runAutoreplyTest(deps, body, signal))
  })
}
