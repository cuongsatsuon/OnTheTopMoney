// Hộp thư (Story 4.3, AD-9, AD-18): đọc hội thoại, tin, đính kèm. Dưới /api/v1 → guard auth đã yêu cầu phiên.
// - Phạm vi giải qua `pages.resolveScope` (nguồn duy nhất): `scope=all|group:<id>|page:<id>`; sai cú pháp →
//   VALIDATION_FAILED, nhóm/trang không tồn tại → 404. Hội thoại của trang đã gỡ không trả.
// - Đính kèm: bytes từ kho riêng tư (AD-14), không bao giờ trả URL Cloudinary/Meta. `Cache-Control: private` để
//   trình duyệt giữ lại mà proxy chung không lưu; `nosniff` + MIME đã kiểm lúc lưu.
// - Story 4.6: `tab=all|needs_human|ai|done` lọc ở server; `GET …/count` cho badge "Cần xử lý"; lệnh
//   `POST …/:id/takeover|enable-ai|done` (rate-limit + kiểm Origin của route ghi do auth plugin áp). Trạng thái nguồn
//   không hợp lệ → 409 VERSION_CONFLICT; đã ở đích → 200 không đổi.
// - Story 4.7: `POST …/:id/messages` gửi tin (201 `MessageDto` `pending`), `POST /api/v1/messages/:id/resend` gửi lại
//   tin `failed` (200). `canSend` từ chối → 409 với mã gửi tin + `details.messageId` (tin vẫn lưu `failed`). Không gọi
//   Meta trong request: job `inbox.send` gửi. Story 5.4: gửi lại nhận cả tin AI lỗi (= chủ shop gửi, tắt AI).
import {
  CONVERSATION_ACTIONS,
  ConversationCountQuery,
  ConversationCountResponse,
  ConversationDto,
  ConversationsQuery,
  ListConversationsResponse,
  ListMessagesResponse,
  MessageDto,
  MessagesQuery,
  ScopeParam,
  SendMessageBody,
  type SendErrorCode,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { MediaStores } from '../adapters/media/index.ts'
import {
  applyUserAction,
  countConversations,
  getAttachmentFile,
  getConversation,
  getMessage,
  listConversations,
  listMessages,
  resendMessage,
  sendMessage,
} from '../modules/inbox/index.ts'
import { resolveScope } from '../modules/pages/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'
import type { EventPublisher } from '../platform/events/index.ts'
import type { JobSender } from '../platform/jobs/index.ts'

const ListQuery = ConversationsQuery.extend({ scope: ScopeParam.optional() })
const CountQuery = ConversationCountQuery.extend({ scope: ScopeParam.optional() })
const IdParam = z.object({ id: z.uuid() })

const notFound = (message: string) => new AppError('NOT_FOUND', 404, { message })
/** `canSend` từ chối: tin đã lưu `failed` — FE làm cũ khung chat để hiện bong bóng lỗi. */
const refused = (code: SendErrorCode, messageId: string) =>
  new AppError(code, 409, { message: `Không gửi được tin (${code})`, details: { messageId } })

export function registerInbox(
  app: FastifyInstance,
  deps: { db: Db; media: Pick<MediaStores, 'privateStore'>; events?: EventPublisher | undefined; jobs?: JobSender | undefined },
): void {
  app.get('/api/v1/conversations', async (req): Promise<ListConversationsResponse> => {
    const { scope, tab, cursor, limit } = ListQuery.parse(req.query ?? {})
    const pageIds = await resolveScope(deps.db, scope ?? { kind: 'all' })
    return ListConversationsResponse.parse(await listConversations(deps.db, pageIds, { tab, cursor, limit }))
  })

  app.get('/api/v1/conversations/count', async (req): Promise<ConversationCountResponse> => {
    const { scope, tab } = CountQuery.parse(req.query ?? {})
    const pageIds = await resolveScope(deps.db, scope ?? { kind: 'all' })
    return { count: await countConversations(deps.db, pageIds, tab) }
  })

  // Lệnh chuyển trạng thái (Story 4.6) phát `conversation.state_changed` → chỉ đăng ký khi có `events`.
  const { events } = deps
  if (events) {
    for (const action of CONVERSATION_ACTIONS) {
      app.post(`/api/v1/conversations/:id/${action}`, async (req): Promise<ConversationDto> => {
        const { id } = IdParam.parse(req.params)
        if (!(await getConversation(deps.db, id))) throw notFound('Hội thoại không tồn tại')
        const result = await applyUserAction({ db: deps.db, events }, id, action)
        if (result.status === 'missing') throw notFound('Hội thoại không tồn tại')
        if (result.status === 'conflict') {
          throw new AppError('VERSION_CONFLICT', 409, { message: `Không áp được "${action}" cho hội thoại đang ở trạng thái ${result.state}` })
        }
        const conv = await getConversation(deps.db, id)
        if (!conv) throw notFound('Hội thoại không tồn tại')
        return ConversationDto.parse(conv)
      })
    }
  }

  // Gửi tin (Story 4.7): enqueue `inbox.send` cùng transaction → cần cả `events` và `jobs`.
  const { jobs } = deps
  if (events && jobs) {
    const sendDeps = { db: deps.db, events, jobs }
    app.post('/api/v1/conversations/:id/messages', async (req, reply): Promise<MessageDto> => {
      const { id } = IdParam.parse(req.params)
      const body = SendMessageBody.parse(req.body ?? {})
      if (!(await getConversation(deps.db, id))) throw notFound('Hội thoại không tồn tại')
      const result = await sendMessage(sendDeps, id, body)
      if (result.status === 'missing') throw notFound('Hội thoại không tồn tại')
      if (result.status === 'refused') throw refused(result.code, result.messageId)
      const msg = await getMessage(deps.db, result.messageId)
      if (!msg) throw notFound('Tin không tồn tại')
      return reply.code(201).send(MessageDto.parse(msg))
    })

    app.post('/api/v1/messages/:id/resend', async (req): Promise<MessageDto> => {
      const { id } = IdParam.parse(req.params)
      const current = await getMessage(deps.db, id)
      // Tin của hội thoại thuộc trang đã gỡ cũng coi như không có.
      if (!current || !(await getConversation(deps.db, current.conversationId))) throw notFound('Tin không tồn tại')
      const result = await resendMessage(sendDeps, id)
      if (result.status === 'missing') throw notFound('Tin không tồn tại')
      if (result.status === 'conflict') throw new AppError('VERSION_CONFLICT', 409, { message: 'Chỉ gửi lại được tin của bạn hoặc tin AI đang lỗi' })
      if (result.status === 'refused') throw refused(result.code, result.messageId)
      const msg = await getMessage(deps.db, id)
      if (!msg) throw notFound('Tin không tồn tại')
      return MessageDto.parse(msg)
    })
  }

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
