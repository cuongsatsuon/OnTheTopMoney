// Hộp thư (Story 4.3, AD-9, AD-18): đọc hội thoại, tin, đính kèm. Dưới /api/v1 → guard auth đã yêu cầu phiên.
// - Phạm vi giải qua `pages.resolveScope` (nguồn duy nhất): `scope=all|group:<id>|page:<id>`; sai cú pháp →
//   VALIDATION_FAILED, nhóm/trang không tồn tại → 404. Hội thoại của trang đã gỡ không trả.
// - Đính kèm: bytes từ kho riêng tư (AD-14), không bao giờ trả URL Cloudinary/Meta. `Cache-Control: private` để
//   trình duyệt giữ lại mà proxy chung không lưu; `nosniff` + MIME đã kiểm lúc lưu.
import {
  ConversationDto,
  ConversationsQuery,
  ListConversationsResponse,
  ListMessagesResponse,
  MessagesQuery,
  ScopeParam,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { MediaStores } from '../adapters/media/index.ts'
import { getAttachmentFile, getConversation, listConversations, listMessages } from '../modules/inbox/index.ts'
import { resolveScope } from '../modules/pages/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'

const ListQuery = ConversationsQuery.extend({ scope: ScopeParam.optional() })
const IdParam = z.object({ id: z.uuid() })

const notFound = (message: string) => new AppError('NOT_FOUND', 404, { message })

export function registerInbox(app: FastifyInstance, deps: { db: Db; media: Pick<MediaStores, 'privateStore'> }): void {
  app.get('/api/v1/conversations', async (req): Promise<ListConversationsResponse> => {
    const { scope, cursor, limit } = ListQuery.parse(req.query ?? {})
    const pageIds = await resolveScope(deps.db, scope ?? { kind: 'all' })
    return ListConversationsResponse.parse(await listConversations(deps.db, pageIds, { cursor, limit }))
  })

  app.get('/api/v1/conversations/:id', async (req): Promise<ConversationDto> => {
    const { id } = IdParam.parse(req.params)
    const conv = await getConversation(deps.db, id)
    if (!conv) throw notFound('Hội thoại không tồn tại')
    return ConversationDto.parse(conv)
  })

  app.get('/api/v1/conversations/:id/messages', async (req): Promise<ListMessagesResponse> => {
    const { id } = IdParam.parse(req.params)
    const { cursor, limit } = MessagesQuery.parse(req.query ?? {})
    if (!(await getConversation(deps.db, id))) throw notFound('Hội thoại không tồn tại')
    return ListMessagesResponse.parse(await listMessages(deps.db, id, { cursor, limit }))
  })

  app.get('/api/v1/attachments/:id', async (req, reply) => {
    const { id } = IdParam.parse(req.params)
    const file = await getAttachmentFile(deps, id)
    if (!file.ok) {
      if (file.reason === 'not_found') throw notFound('Đính kèm không tồn tại')
      throw new AppError('INTERNAL', 502, { message: 'Kho file tạm thời không đọc được' })
    }
    // Ảnh/voice/video hiển thị tại chỗ; file khác tải về (không để trình duyệt diễn giải).
    const inline = file.kind === 'image' || file.kind === 'audio' || file.kind === 'video'
    return reply
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', inline ? 'inline' : 'attachment')
      .type(file.mime)
      .send(file.data)
  })
}
