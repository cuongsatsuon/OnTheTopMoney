// Khách hàng (Story 4.9, AD-11, AD-18): danh sách theo phạm vi, hồ sơ, lịch sử nhiều trang, gộp, tóm tắt AI. Dưới
// /api/v1 → guard auth đã yêu cầu phiên; route ghi được kiểm Origin + rate-limit bởi auth plugin.
// - Phạm vi giải qua `pages.resolveScope` (nguồn duy nhất): `scope=all|group:<id>|page:<id>`; sai cú pháp →
//   VALIDATION_FAILED, nhóm/trang không tồn tại → 404. DTO ghép ở `read-models/contacts.ts`.
// - Khách chỉ còn định danh trên trang đã gỡ coi như không có (404), như hội thoại của trang đã gỡ ở Hộp thư.
// - Gộp: `POST …/:id/merge {sourceId}` gộp nguồn VÀO `:id`. Tóm tắt: `POST …/:id/summarize` → 202 (job
//   `inbox.contact_summary`); khách chưa có tin có chữ → 422.
import {
  BulkUpdateContactsBody,
  BulkUpdateContactsResponse,
  ContactDetailDto,
  ContactFacetsResponse,
  ContactHistoryQuery,
  ContactsQuery,
  ListContactHistoryResponse,
  ListContactsResponse,
  MergeContactsBody,
  ScopeParam,
  UpdateContactBody,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  bulkUpdateContacts,
  contactFacets,
  listContactMessages,
  listContacts,
  mergeContacts,
  requestContactSummary,
  updateContact,
} from '../modules/inbox/index.ts'
import { resolveScope } from '../modules/pages/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'
import type { EventPublisher } from '../platform/events/index.ts'
import type { JobSender } from '../platform/jobs/index.ts'
import { contactDetail, contactDtos, livePageIds } from './read-models/contacts.ts'

const ListQuery = ContactsQuery.extend({ scope: ScopeParam.optional() })
const FacetsQuery = z.object({ scope: ScopeParam.optional() })
const IdParam = z.object({ id: z.uuid() })

const notFound = () => new AppError('NOT_FOUND', 404, { message: 'Khách không tồn tại' })

export function registerContacts(
  app: FastifyInstance,
  deps: { db: Db; events?: EventPublisher | undefined; jobs?: JobSender | undefined; now?: () => Date },
): void {
  const now = () => deps.now?.() ?? new Date()
  /** Chi tiết khách hoặc 404. */
  const detailOr404 = async (id: string): Promise<ContactDetailDto> => {
    const detail = await contactDetail(deps.db, id, now())
    if (!detail) throw notFound()
    return ContactDetailDto.parse(detail)
  }

  app.get('/api/v1/contacts', async (req): Promise<ListContactsResponse> => {
    const { scope, stage, tag, q, cursor, limit } = ListQuery.parse(req.query ?? {})
    const pageIds = await resolveScope(deps.db, scope ?? { kind: 'all' })
    const page = await listContacts(deps.db, pageIds, { stage, tag, q, cursor, limit })
    return ListContactsResponse.parse({ items: await contactDtos(deps.db, page.items, pageIds, now()), nextCursor: page.nextCursor })
  })

  app.get('/api/v1/contacts/facets', async (req): Promise<ContactFacetsResponse> => {
    const { scope } = FacetsQuery.parse(req.query ?? {})
    const pageIds = await resolveScope(deps.db, scope ?? { kind: 'all' })
    return ContactFacetsResponse.parse(await contactFacets(deps.db, pageIds))
  })

  app.get('/api/v1/contacts/:id', async (req): Promise<ContactDetailDto> => {
    const { id } = IdParam.parse(req.params)
    return detailOr404(id)
  })

  app.get('/api/v1/contacts/:id/messages', async (req): Promise<ListContactHistoryResponse> => {
    const { id } = IdParam.parse(req.params)
    const { cursor, limit } = ContactHistoryQuery.parse(req.query ?? {})
    if (!(await contactDetail(deps.db, id, now()))) throw notFound()
    return ListContactHistoryResponse.parse(await listContactMessages(deps.db, id, await livePageIds(deps.db), { cursor, limit }))
  })

  // Lệnh ghi phát `contact.updated` / `contact.merged` → chỉ đăng ký khi có `events`.
  const { events } = deps
  if (!events) return
  const writeDeps = { db: deps.db, events }

  app.patch('/api/v1/contacts/:id', async (req): Promise<ContactDetailDto> => {
    const { id } = IdParam.parse(req.params)
    const patch = UpdateContactBody.parse(req.body ?? {})
    if (!(await contactDetail(deps.db, id, now()))) throw notFound()
    if (!(await updateContact(writeDeps, id, patch))) throw notFound()
    return detailOr404(id)
  })

  app.post('/api/v1/contacts/bulk', async (req): Promise<BulkUpdateContactsResponse> => {
    const body = BulkUpdateContactsBody.parse(req.body ?? {})
    const op = body.addTag !== undefined ? { addTag: body.addTag } : { stage: body.stage! }
    return { updated: await bulkUpdateContacts(writeDeps, body.ids, op) }
  })

  app.post('/api/v1/contacts/:id/merge', async (req): Promise<ContactDetailDto> => {
    const { id } = IdParam.parse(req.params)
    const { sourceId } = MergeContactsBody.parse(req.body ?? {})
    if (sourceId === id) throw new AppError('VALIDATION_FAILED', 400, { message: 'Không gộp được một khách với chính nó' })
    if (!(await contactDetail(deps.db, id, now())) || !(await contactDetail(deps.db, sourceId, now()))) throw notFound()
    const result = await mergeContacts(writeDeps, id, sourceId)
    if (result.status === 'missing') throw notFound()
    return detailOr404(id)
  })

  // Tóm tắt AI: enqueue job cùng transaction → cần `jobs`.
  const { jobs } = deps
  if (!jobs) return
  app.post('/api/v1/contacts/:id/summarize', async (req, reply): Promise<ContactDetailDto> => {
    const { id } = IdParam.parse(req.params)
    if (!(await contactDetail(deps.db, id, now()))) throw notFound()
    const result = await requestContactSummary({ db: deps.db, events, jobs, now }, id, await livePageIds(deps.db))
    if (result.status === 'missing') throw notFound()
    if (result.status === 'no_messages') throw new AppError('VALIDATION_FAILED', 422, { message: 'Khách chưa có tin nào để tóm tắt' })
    return reply.code(202).send(await detailOr404(id))
  })
}
