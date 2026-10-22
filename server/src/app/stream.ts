// GET /api/v1/stream — SSE realtime (AD-3). Guard auth (onRequest) đã chặn khi chưa có phiên → 401.
// Client chỉ dùng sự kiện để vô hiệu hoá cache rồi refetch REST, không render payload.
import type { OutgoingHttpHeaders } from 'node:http'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../platform/db/index.ts'
import { SSE_RETRY_MS, sseFrame, type RealtimeHub } from '../platform/realtime/index.ts'
import { isSessionValid } from '../modules/settings/index.ts'
import { SESSION_COOKIE } from './auth/index.ts'

export const STREAM_PATH = '/api/v1/stream'

export function registerStream(app: FastifyInstance, hub: RealtimeHub, db: Db): void {
  // Đóng stream SSE trước khi server dừng nhận kết nối, để `app.close()` không treo.
  app.addHook('preClose', async () => {
    await hub.close()
  })

  app.get(STREAM_PATH, { logLevel: 'warn' }, (req, reply) => {
    // Header đã đặt qua `reply.header` (CORS, Vary — hook onRequest) không tự đi kèm sau `hijack`: gộp vào writeHead.
    const inherited: OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) inherited[name] = value
    }
    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      ...inherited,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`retry: ${SSE_RETRY_MS}\n\n`)
    res.write(sseFrame('ready', {}))
    // Phiên bị xoá (đăng xuất) hoặc hết hạn khi stream đang mở → hub đóng stream ở nhịp ping kế tiếp.
    const token = req.cookies[SESSION_COOKIE]
    hub.addClient(res, () => isSessionValid(db, token))
    req.raw.on('close', () => res.end())
  })
}
