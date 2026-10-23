// Kho kiến thức (Story 5.2, AD-14, AD-16, AD-24). Mục FAQ `ready` ngay; file đã lưu `PrivateFileStore` (route lo tải
// lên) được ghi `processing` + enqueue `profiles.knowledge.extract` trong CÙNG transaction (AD-2). Job trích văn bản
// trong thread có timeout (`knowledge-extract-thread.ts`) rồi kết thúc mọi mục `processing` trỏ cùng file (bản sao
// kế thừa) bằng `UPDATE … WHERE status='processing'` → `ready|failed|too_large`, phát `knowledge_item.processed`, xoá
// file gốc khi không còn mục nào dùng (văn bản đã nằm ở DB).
// Giới hạn token (AD-16): cấu hình của chủ đang BẬT thì tổng `ready` không được vượt `KNOWLEDGE_MAX_TOKENS` — thêm FAQ
// làm vượt bị từ chối, file làm vượt thành `too_large`; lưu cấu hình bật khi kho đã vượt → `KNOWLEDGE_TOO_LARGE`
// (`assertKnowledgeFits`). Kho của trang đang theo nhóm chỉ đọc. Không log tên file, câu hỏi hay văn bản.
import {
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_ITEMS_MAX,
  KNOWLEDGE_MAX_TOKENS,
  type AddKnowledgeFaqRequest,
  type KnowledgeError,
  type KnowledgeFileMime,
  type KnowledgeItemDto,
  type KnowledgeListResponse,
} from '@ottm/shared'
import { and, count, eq, sql } from 'drizzle-orm'
import type { MediaStores, PrivateFileRef } from '../../adapters/media/index.ts'
import type { Db, DbExecutor, Tx } from '../../platform/db/index.ts'
import { bossDbFor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { estimateInputTokens } from '../ai/index.ts'
import { getPage } from '../pages/index.ts'
import { autoreplyOwnerWhere } from './autoreply-row.ts'
import { runExtraction } from './knowledge-extract-thread.ts'
import { detectKnowledgeMime, type ExtractResult } from './knowledge-files.ts'
import { knowledgeOwnerWhere, readyKnowledgeTokens, toKnowledgeDto } from './knowledge-row.ts'
import { getPageConfigState } from './inheritance.ts'
import type { ProfileOwner } from './row.ts'
import { autoreplyConfigs, knowledgeItems } from './schema.ts'
import { assertOwnerExists } from './service.ts'

/** Token ước tính của một mục: tiêu đề (câu hỏi / tên file) + nội dung — cùng cách ước tính của AI gateway. */
export const knowledgeTokens = (title: string, text: string): number => estimateInputTokens(title.length + text.length)

/* ---------- Khoá + giới hạn ---------- */

/** Khoá theo chủ trong transaction: thêm FAQ / kết thúc file / lưu cấu hình bật không chen nhau khi cộng tổng token. */
async function lockKnowledgeOwner(tx: DbExecutor, owner: ProfileOwner): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge:${owner.ownerType}:${owner.ownerId}`}, 0))`)
}

async function ownerConfigEnabled(db: DbExecutor, owner: ProfileOwner): Promise<boolean> {
  const [row] = await db.select({ enabled: autoreplyConfigs.enabled }).from(autoreplyConfigs).where(autoreplyOwnerWhere(owner))
  return row?.enabled ?? false
}

function tooLarge(readyTokens: number): AppError {
  return new AppError('KNOWLEDGE_TOO_LARGE', 422, {
    message: 'Kho kiến thức vượt giới hạn token',
    details: { readyTokens, maxTokens: KNOWLEDGE_MAX_TOKENS },
  })
}

/**
 * Kiểm trước khi lưu cấu hình ở trạng thái BẬT (Story 5.2 AC4): tổng token `ready` của kho chủ vượt giới hạn →
 * `KNOWLEDGE_TOO_LARGE`. Gọi trong transaction lưu (sau khi đã sao chép kho nếu trang vừa chuyển sang riêng).
 */
export async function assertKnowledgeFits(tx: DbExecutor, owner: ProfileOwner): Promise<void> {
  await lockKnowledgeOwner(tx, owner)
  const total = await readyKnowledgeTokens(tx, owner)
  if (total > KNOWLEDGE_MAX_TOKENS) throw tooLarge(total)
}

/**
 * Chủ ghi được kho: owner tồn tại (404), và trang thì phải dùng cấu hình riêng (đã lưu) hoặc không thuộc nhóm. Trang
 * đang theo nhóm dùng kho của nhóm — ghi vào đó sẽ không có tác dụng, nên từ chối (FE hiện kho nhóm, chỉ đọc).
 */
async function assertKnowledgeWritable(db: DbExecutor, owner: ProfileOwner): Promise<void> {
  await assertOwnerExists(db, owner)
  if (owner.ownerType !== 'page') return
  const page = await getPage(db, owner.ownerId)
  if (page?.groupId && !(await getPageConfigState(db, owner.ownerId, 'autoreply')).useOwn) {
    const message = 'Trang đang theo cấu hình AI của nhóm — lưu cấu hình riêng trước khi sửa kho kiến thức'
    throw new AppError('VALIDATION_FAILED', 400, { message, details: [{ path: ['owner'], message }] })
  }
}

/** Ghi được + chưa đủ `KNOWLEDGE_ITEMS_MAX` mục. Route gọi TRƯỚC khi tải file lên kho (không để file mồ côi). */
export async function assertCanAddKnowledge(db: DbExecutor, owner: ProfileOwner): Promise<void> {
  await assertKnowledgeWritable(db, owner)
  const [row] = await db.select({ n: count() }).from(knowledgeItems).where(knowledgeOwnerWhere(owner))
  if ((row?.n ?? 0) >= KNOWLEDGE_ITEMS_MAX) {
    const message = `Kho kiến thức tối đa ${KNOWLEDGE_ITEMS_MAX} mục — xoá bớt trước khi thêm`
    throw new AppError('VALIDATION_FAILED', 400, { message, details: [{ path: ['items'], message }] })
  }
}

/* ---------- Đọc ---------- */

/** Kho của chủ (cũ → mới) + tổng token `ready`. Owner không tồn tại → 404. */
export async function listKnowledge(db: DbExecutor, owner: ProfileOwner): Promise<KnowledgeListResponse> {
  await assertOwnerExists(db, owner)
  const rows = await db.select().from(knowledgeItems).where(knowledgeOwnerWhere(owner)).orderBy(knowledgeItems.createdAt, knowledgeItems.id)
  return { items: rows.map(toKnowledgeDto), readyTokens: await readyKnowledgeTokens(db, owner), maxTokens: KNOWLEDGE_MAX_TOKENS }
}

/* ---------- FAQ ---------- */

/** Thêm câu hỏi thường gặp — `ready` ngay. Cấu hình của chủ đang bật mà tổng sẽ vượt → `KNOWLEDGE_TOO_LARGE`. */
export async function addKnowledgeFaq(db: Db, owner: ProfileOwner, input: AddKnowledgeFaqRequest): Promise<KnowledgeItemDto> {
  return db.transaction(async (tx) => {
    await assertCanAddKnowledge(tx, owner)
    await lockKnowledgeOwner(tx, owner)
    const tokens = knowledgeTokens(input.question, input.answer)
    if (await ownerConfigEnabled(tx, owner)) {
      const total = await readyKnowledgeTokens(tx, owner)
      if (total + tokens > KNOWLEDGE_MAX_TOKENS) throw tooLarge(total + tokens)
    }
    const [row] = await tx
      .insert(knowledgeItems)
      .values({ ownerType: owner.ownerType, ownerId: owner.ownerId, kind: 'faq', title: input.question, text: input.answer, status: 'ready', tokenCount: tokens })
      .returning()
    return toKnowledgeDto(row!)
  })
}

/* ---------- File ---------- */

export const KNOWLEDGE_FILE_VALIDATION = {
  size: 'File tối đa 10 MB',
  type: 'Chỉ nhận file PDF, DOCX hoặc TXT',
  mismatch: 'Định dạng file không khớp với đuôi file',
} as const

/**
 * Kiểm bytes trước khi tải lên kho (AD-14): 1 byte–10 MB, loại nhận dạng bằng magic bytes thuộc pdf/docx/txt và khớp
 * MIME khai báo. Trả MIME đã xác nhận hoặc câu lỗi (dưới ô file). Không gọi mạng.
 */
export function validateKnowledgeFile(data: Buffer, declaredMime: KnowledgeFileMime): { ok: true; mime: KnowledgeFileMime } | { ok: false; message: string } {
  if (data.length === 0 || data.length > KNOWLEDGE_FILE_MAX_BYTES) return { ok: false, message: KNOWLEDGE_FILE_VALIDATION.size }
  const detected = detectKnowledgeMime(data)
  if (!detected) return { ok: false, message: KNOWLEDGE_FILE_VALIDATION.type }
  if (detected !== declaredMime) return { ok: false, message: KNOWLEDGE_FILE_VALIDATION.mismatch }
  return { ok: true, mime: detected }
}

export interface RecordKnowledgeFileInput {
  name: string
  mime: KnowledgeFileMime
  bytes: number
  ref: PrivateFileRef
}

/**
 * Ghi mục file `processing` + enqueue `profiles.knowledge.extract` trong CÙNG transaction (AD-2). File đã nằm ở kho
 * riêng tư; transaction lỗi thì route xoá file vừa tải (best-effort).
 */
export async function recordKnowledgeFile(deps: { db: Db; jobs: JobSender }, owner: ProfileOwner, input: RecordKnowledgeFileInput): Promise<KnowledgeItemDto> {
  return deps.db.transaction(async (tx) => {
    await assertCanAddKnowledge(tx, owner)
    const [row] = await tx
      .insert(knowledgeItems)
      .values({
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        kind: 'file',
        title: input.name,
        status: 'processing',
        filePublicId: input.ref.publicId,
        fileResourceType: input.ref.resourceType,
        fileFormat: input.ref.format,
        fileMime: input.mime,
        fileBytes: input.bytes,
      })
      .returning()
    await deps.jobs.send('profiles.knowledge.extract', { knowledgeItemId: row!.id, filePublicId: input.ref.publicId }, { db: bossDbFor(tx) })
    return toKnowledgeDto(row!)
  })
}

/* ---------- Xoá ---------- */

type KnowledgeMedia = Pick<MediaStores, 'privateStore'>

/** Xoá file khỏi kho riêng tư khi không còn mục nào trỏ tới (best-effort: lỗi thì để file mồ côi). */
async function deleteFileIfUnused(deps: { db: DbExecutor; media: KnowledgeMedia }, ref: PrivateFileRef): Promise<void> {
  const [row] = await deps.db.select({ n: count() }).from(knowledgeItems).where(eq(knowledgeItems.filePublicId, ref.publicId))
  if ((row?.n ?? 0) > 0) return
  await deps.media.privateStore.delete(ref).catch(() => {})
}

const refOf = (row: { filePublicId: string | null; fileResourceType: string | null; fileFormat: string | null }): PrivateFileRef | null =>
  row.filePublicId ? { publicId: row.filePublicId, resourceType: row.fileResourceType === 'image' ? 'image' : 'raw', format: row.fileFormat } : null

/** Xoá một mục (áp ngay). Mục lạ → 404; chủ không ghi được → 400. File còn trên kho thì xoá khi không ai dùng. */
export async function deleteKnowledgeItem(deps: { db: Db; media: KnowledgeMedia }, id: string): Promise<void> {
  const ref = await deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(knowledgeItems).where(eq(knowledgeItems.id, id)).for('update')
    if (!row) throw new AppError('NOT_FOUND', 404, { message: 'Mục kho kiến thức không tồn tại', details: { id } })
    await assertKnowledgeWritable(tx, { ownerType: row.ownerType as ProfileOwner['ownerType'], ownerId: row.ownerId })
    await tx.delete(knowledgeItems).where(eq(knowledgeItems.id, id))
    return refOf(row)
  })
  if (ref) await deleteFileIfUnused(deps, ref)
}

/* ---------- Job `profiles.knowledge.extract` ---------- */

export interface KnowledgeExtractDeps {
  db: Db
  events: EventPublisher
  media: Pick<MediaStores, 'privateStore'>
  /** Trích văn bản — mặc định thread có timeout (`runExtraction`); test tiêm bản giả. */
  extract?: (data: Buffer, mime: KnowledgeFileMime) => Promise<ExtractResult>
}

export type KnowledgeExtractOutcome = 'processed' | 'failed' | 'skipped'

/** Lỗi tạm khi tải file từ kho: handler ném lại để pg-boss retry. */
export class KnowledgeRetryableError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`profiles.knowledge.extract: ${kind}`)
    this.name = 'KnowledgeRetryableError'
    this.kind = kind
  }
}

type Outcome = { ok: true; text: string } | { ok: false; error: KnowledgeError }

/**
 * Kết thúc mọi mục `processing` trỏ cùng file trong MỘT transaction: từng mục tính trạng thái theo chủ của nó (cấu
 * hình bật + tổng hiện có), bỏ ref file, phát `knowledge_item.processed`. Trả số mục đã kết thúc (0 = lượt khác xong
 * trước / đã xoá).
 */
async function finalizeFile(deps: KnowledgeExtractDeps, publicId: string, outcome: Outcome): Promise<number> {
  return deps.db.transaction(async (tx: Tx) => {
    const rows = await tx
      .select()
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.filePublicId, publicId), eq(knowledgeItems.status, 'processing')))
      .orderBy(knowledgeItems.createdAt, knowledgeItems.id)
      .for('update')
    let done = 0
    for (const row of rows) {
      const owner: ProfileOwner = { ownerType: row.ownerType as ProfileOwner['ownerType'], ownerId: row.ownerId }
      let next: { status: 'ready' | 'failed' | 'too_large'; text: string | null; tokenCount: number | null; errorCode: KnowledgeError | null }
      if (!outcome.ok) next = { status: 'failed', text: null, tokenCount: null, errorCode: outcome.error }
      else {
        await lockKnowledgeOwner(tx, owner)
        const tokens = knowledgeTokens(row.title, outcome.text)
        const over =
          tokens > KNOWLEDGE_MAX_TOKENS ||
          ((await ownerConfigEnabled(tx, owner)) && (await readyKnowledgeTokens(tx, owner)) + tokens > KNOWLEDGE_MAX_TOKENS)
        next = over
          ? { status: 'too_large', text: null, tokenCount: tokens, errorCode: 'KNOWLEDGE_TOO_LARGE' }
          : { status: 'ready', text: outcome.text, tokenCount: tokens, errorCode: null }
      }
      const [updated] = await tx
        .update(knowledgeItems)
        .set({ ...next, filePublicId: null, fileResourceType: null, fileFormat: null, processedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(knowledgeItems.id, row.id), eq(knowledgeItems.status, 'processing')))
        .returning({ id: knowledgeItems.id })
      if (!updated) continue
      done++
      await deps.events.publishEvent(tx, 'knowledge_item.processed', {
        id: row.id,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        status: next.status,
        ...(owner.ownerType === 'page' ? { pageId: owner.ownerId } : {}),
      })
    }
    return done
  })
}

/**
 * Trích văn bản một file (theo `filePublicId`). Không còn mục `processing` nào → `skipped` (và dọn file nếu không ai
 * dùng). Tải file lỗi tạm → ném để retry; lần cuối / lỗi khác → `failed FILE_UNAVAILABLE`. Lỗi trích (hỏng, mật khẩu,
 * không chữ, hết giờ) → `failed` ngay, không retry (chạy lại cũng vậy).
 */
export async function processKnowledgeFile(
  deps: KnowledgeExtractDeps,
  filePublicId: string,
  opts: { finalAttempt: boolean },
): Promise<KnowledgeExtractOutcome> {
  const [row] = await deps.db
    .select()
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.filePublicId, filePublicId), eq(knowledgeItems.status, 'processing')))
    .limit(1)
  const ref = (row && refOf(row)) ?? { publicId: filePublicId, resourceType: 'raw' as const, format: null }
  if (!row || !row.fileMime) {
    await deleteFileIfUnused(deps, ref)
    return 'skipped'
  }

  let outcome: Outcome
  const got = await deps.media.privateStore.get(ref)
  if (!got.ok) {
    if ((got.kind === 'TRANSIENT' || got.kind === 'RATE_LIMITED') && !opts.finalAttempt) throw new KnowledgeRetryableError(got.kind)
    outcome = { ok: false, error: 'FILE_UNAVAILABLE' }
  } else {
    const result = await (deps.extract ?? runExtraction)(got.data, row.fileMime as KnowledgeFileMime)
    outcome = result.ok ? { ok: true, text: result.text } : { ok: false, error: result.reason }
  }
  const done = await finalizeFile(deps, filePublicId, outcome)
  await deleteFileIfUnused(deps, ref)
  if (done === 0) return 'skipped'
  return outcome.ok ? 'processed' : 'failed'
}

export function parseKnowledgeExtractJobData(data: unknown): { knowledgeItemId: string; filePublicId: string } {
  const d = (data ?? {}) as { knowledgeItemId?: unknown; filePublicId?: unknown }
  if (typeof d.filePublicId !== 'string' || d.filePublicId === '') throw new Error('profiles.knowledge.extract: thiếu filePublicId')
  return { knowledgeItemId: typeof d.knowledgeItemId === 'string' ? d.knowledgeItemId : '', filePublicId: d.filePublicId }
}

/** Handler worker (tách khỏi worker/main.ts để test nhánh lần thử cuối). */
export async function handleKnowledgeExtractJob(
  deps: KnowledgeExtractDeps,
  job: { data: unknown; retryCount: number; retryLimit: number },
): Promise<KnowledgeExtractOutcome> {
  const { filePublicId } = parseKnowledgeExtractJobData(job.data)
  return processKnowledgeFile(deps, filePublicId, { finalAttempt: job.retryCount >= job.retryLimit })
}
