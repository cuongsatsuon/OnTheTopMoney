// Kho kiến thức (Story 5.2, AD-14, AD-16). Mọi route dưới /api/v1 → guard auth đã yêu cầu phiên; ghi kiểm Origin
// (AD-19). Nghiệp vụ ở `profiles`; route parse + tải file lên kho riêng tư.
// Tải file: body là NGUYÊN bytes của file (không base64, không multipart), `Content-Type` = MIME khai báo
// (pdf/docx/txt — loại khác Fastify trả 415 → `VALIDATION_FAILED`), tên file ở header `X-File-Name` (percent-encoded,
// không để ở query cho khỏi vào access log). Thứ tự: kiểm bytes (magic + kích thước) → kiểm chủ ghi được → tải lên
// Cloudinary `authenticated` → ghi `processing` + enqueue job cùng transaction; transaction lỗi thì xoá file vừa tải.
import {
  AddKnowledgeFaqRequest,
  ConfigOwnerType,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_FILE_MIMES,
  KNOWLEDGE_FILE_NAME_HEADER,
  KNOWLEDGE_FILE_NAME_MAX,
  KnowledgeFileMime,
  type KnowledgeItemDto,
  type KnowledgeListResponse,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { MediaStores, PrivateFileRef } from '../adapters/media/index.ts'
import {
  addKnowledgeFaq,
  assertCanAddKnowledge,
  deleteKnowledgeItem,
  listKnowledge,
  recordKnowledgeFile,
  validateKnowledgeFile,
  type ProfileOwner,
} from '../modules/profiles/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'
import type { JobSender } from '../platform/jobs/index.ts'
import { mediaAppError } from './media-errors.ts'

const OwnerParams = z.object({ ownerType: ConfigOwnerType, ownerId: z.uuid() })
const IdParams = z.object({ id: z.uuid() })

/** Fastify kiểm trước khi gọi handler: quá giới hạn → 413 (→ `VALIDATION_FAILED`). Dư 1 byte để route tự báo dưới ô. */
const FILE_BODY_LIMIT = KNOWLEDGE_FILE_MAX_BYTES + 1

const FILE_MEDIA_ERRORS = { field: 'file', invalidMessage: 'File không hợp lệ', failCode: 'UPLOAD_FAILED' } as const

function fileError(message: string): AppError {
  return new AppError('VALIDATION_FAILED', 400, { details: [{ path: ['file'], message }] })
}

/** Tên file từ header (percent-encoded UTF-8): bỏ đường dẫn, ký tự điều khiển; rỗng/hỏng/quá dài → lỗi dưới ô. */
export function parseFileNameHeader(raw: string | string[] | undefined): string {
  if (typeof raw !== 'string' || raw === '') throw fileError('Thiếu tên file')
  let name: string
  try {
    name = decodeURIComponent(raw)
  } catch {
    throw fileError('Tên file không hợp lệ')
  }
  // oxlint-disable-next-line no-control-regex
  name = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().normalize('NFC')
  if (!name) throw fileError('Thiếu tên file')
  if (name.length > KNOWLEDGE_FILE_NAME_MAX) throw fileError(`Tên file tối đa ${KNOWLEDGE_FILE_NAME_MAX} ký tự`)
  return name
}

export interface KnowledgeItemsDeps {
  db: Db
  media: MediaStores
  /** Thiếu → không đăng ký route tải file (cần enqueue `profiles.knowledge.extract`). */
  jobs?: JobSender | undefined
}

export function registerKnowledgeItems(app: FastifyInstance, deps: KnowledgeItemsDeps): void {
  const { db, media, jobs } = deps

  app.get('/api/v1/knowledge-items/:ownerType/:ownerId', async (req): Promise<KnowledgeListResponse> => {
    const owner: ProfileOwner = OwnerParams.parse(req.params)
    return listKnowledge(db, owner)
  })

  app.post('/api/v1/knowledge-items/:ownerType/:ownerId/faqs', async (req, reply): Promise<KnowledgeItemDto> => {
    const owner: ProfileOwner = OwnerParams.parse(req.params)
    const item = await addKnowledgeFaq(db, owner, AddKnowledgeFaqRequest.parse(req.body ?? {}))
    return reply.code(201).send(item)
  })

  app.delete('/api/v1/knowledge-items/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    await deleteKnowledgeItem({ db, media }, id)
    return reply.code(204).send()
  })

  if (!jobs) return
  // Parser bytes chỉ trong scope này (route khác vẫn parse JSON như thường).
  app.register(async (scope) => {
    scope.addContentTypeParser([...KNOWLEDGE_FILE_MIMES], { parseAs: 'buffer', bodyLimit: FILE_BODY_LIMIT }, (_req, body, done) => done(null, body))

    scope.post('/api/v1/knowledge-items/:ownerType/:ownerId/files', { bodyLimit: FILE_BODY_LIMIT }, async (req, reply): Promise<KnowledgeItemDto> => {
      const owner: ProfileOwner = OwnerParams.parse(req.params)
      const declared = KnowledgeFileMime.safeParse((req.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase())
      if (!declared.success) throw fileError('Chỉ nhận file PDF, DOCX hoặc TXT')
      const name = parseFileNameHeader(req.headers[KNOWLEDGE_FILE_NAME_HEADER])
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const checked = validateKnowledgeFile(data, declared.data)
      if (!checked.ok) throw fileError(checked.message)
      // Chủ phải ghi được TRƯỚC khi tải lên (404 / trang đang theo nhóm / đủ mục) — không bỏ lại file mồ côi.
      await assertCanAddKnowledge(db, owner)
      if (!media.configured) throw mediaAppError('MEDIA_NOT_CONFIGURED', FILE_MEDIA_ERRORS)
      const put = await media.privateStore.put({ data, mime: checked.mime })
      if (!put.ok) throw mediaAppError(put.kind, FILE_MEDIA_ERRORS)
      const ref: PrivateFileRef = { publicId: put.publicId, resourceType: put.resourceType, format: put.format }
      try {
        const item = await recordKnowledgeFile({ db, jobs }, owner, { name, mime: checked.mime, bytes: data.length, ref })
        return reply.code(201).send(item)
      } catch (err) {
        await media.privateStore.delete(ref).catch(() => {})
        throw err
      }
    })
  })
}
