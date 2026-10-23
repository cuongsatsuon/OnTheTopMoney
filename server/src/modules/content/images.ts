// Sinh ảnh AI cho bài (Story 6.3, AD-14, AD-7, AD-24). Chủ shop bấm "Tạo ảnh AI" → `requestImageGeneration` ghi 4 ô
// `media_assets(source=ai, status=pending)` + enqueue 4 job `content.image.generate` trong CÙNG transaction (AD-2).
// Mỗi job (`generateImageAsset`): gateway `ai.generateImage` (`feature=image_generate`, JPEG) → `MediaStore.put()` (JPEG
// sRGB, bỏ EXIF) → `UPDATE … WHERE status='pending'` sang `ready` + phát `media_asset.created`. Lỗi → `failed`
// (`IMAGE_REJECTED` khi OpenAI từ chối nội dung, còn lại `IMAGE_FAILED`) + phát `media_asset.failed`; caption không đổi.
// - Kích thước theo Cài đặt, riêng `1024x1536` (2:3, ngoài tỉ lệ ảnh feed Instagram) đổi sang `1024x1024`.
// - Chỉ lỗi tạm của OpenAI (`RATE_LIMITED`, 5xx) ném để retry; lần thử cuối ghi `failed`.
// - Kho lỗi sau khi đã có ảnh → `failed` luôn: thử lại là gọi OpenAI (tính tiền) thêm lần nữa.
// - `job.signal` (pg-boss huỷ khi job quá hạn) đi xuống gateway: huỷ thì ném lại, không ghi — lượt thử sau làm tiếp.
// - Story 7.2: ô gắn sẵn vào slot chiến dịch → tính chi phí `campaign_generate` theo trang của slot; xong / lỗi thì đẩy slot
//   `planned` sang `pending_approval` cùng transaction (`slots.settleSlotImage`).
// `ai` không chạm `media_assets` (gateway chỉ trả bytes + ghi `ai_usage`). Không log prompt / mô tả.
import {
  IMAGE_GENERATE_COUNT,
  type ErrorCode,
  type GeneratedImageDto,
  type ImageErrorCode,
  type ImageSize,
  type ParsedGenerateImagesRequest,
} from '@ottm/shared'
import { and, eq, inArray } from 'drizzle-orm'
import type { MediaStores } from '../../adapters/media/index.ts'
import { bossDbFor, type Db, type DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'
import { buildImagePrompt, generateImage, getBudgetSummary, getUsableOpenAiKey, type AiDeps } from '../ai/index.ts'
import { detectImageMime } from '../profiles/index.ts'
import { getOpenAiPrefs } from '../settings/index.ts'
import { toGeneratedImageDto } from './media.ts'
import { mediaAssets } from './schema.ts'
import { settleSlotImage, slotOfAsset } from './slots.ts'

export interface RequestImagesDeps {
  db: Db
  cipher: AiDeps['cipher']
  media: Pick<MediaStores, 'configured'>
  jobs: JobSender
  now?: () => Date
}

export type ImageGenerateDeps = Pick<AiDeps, 'db' | 'events' | 'cipher' | 'openai' | 'log' | 'now'> & { media: MediaStores }

export type ImageGenerateOutcome = 'ready' | 'failed' | 'skipped'

/** Lỗi tạm của OpenAI ở lượt chưa phải cuối — ném để pg-boss thử lại (ô vẫn `pending`). */
export class ImageGenerateRetryableError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode) {
    super(`content.image.generate: ${code}`)
    this.name = 'ImageGenerateRetryableError'
    this.code = code
  }
}

/**
 * Yêu cầu một bộ `IMAGE_GENERATE_COUNT` ảnh. Chặn trước khi ghi (không ô nào, không job nào): kho media chưa cấu hình
 * (ảnh sinh ra không có chỗ lưu) → `MEDIA_NOT_CONFIGURED`; khoá OpenAI thiếu / hỏng → mã khoá; hạn mức đã hết →
 * `AI_BUDGET_EXCEEDED`. Hạn mức còn nhưng không đủ cả 4 ảnh → các job sau tự `failed IMAGE_FAILED`.
 */
export async function requestImageGeneration(deps: RequestImagesDeps, input: ParsedGenerateImagesRequest): Promise<GeneratedImageDto[]> {
  if (!deps.media.configured) throw new AppError('MEDIA_NOT_CONFIGURED', 500, { message: 'CLOUDINARY_URL chưa đặt' })
  await getUsableOpenAiKey(deps)
  const budget = await getBudgetSummary({ db: deps.db, ...(deps.now ? { now: deps.now } : {}) })
  if (budget.state === 'blocked') {
    throw new AppError('AI_BUDGET_EXCEEDED', 402, { details: { month: budget.month, limitVnd: budget.limitVnd, spentVnd: budget.spentVnd, remainingVnd: 0 } })
  }
  const prompt = buildImagePrompt({ description: input.prompt, style: input.style })
  const now = deps.now?.() ?? new Date()
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .insert(mediaAssets)
      .values(Array.from({ length: IMAGE_GENERATE_COUNT }, () => ({ source: 'ai', status: 'pending', prompt })))
      .returning()
    for (const row of rows) await deps.jobs.send('content.image.generate', { mediaAssetId: row.id }, { db: bossDbFor(tx) })
    return rows.map((r) => toGeneratedImageDto(r, now))
  })
}

/** Trạng thái các ô theo đúng thứ tự `ids` (bỏ id không có — đã bị dọn). */
export async function listGeneratedImages(db: DbExecutor, ids: readonly string[], now: Date = new Date()): Promise<GeneratedImageDto[]> {
  if (!ids.length) return []
  const rows = await db.select().from(mediaAssets).where(inArray(mediaAssets.id, [...ids]))
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.flatMap((id) => {
    const row = byId.get(id)
    return row ? [toGeneratedImageDto(row, now)] : []
  })
}

/**
 * Kích thước ảnh bài: theo Cài đặt, trừ `1024x1536` (2:3) — ngoài khoảng tỉ lệ ảnh feed Instagram (4:5 – 1,91:1) nên
 * đăng IG sẽ bị từ chối → sinh ảnh vuông. `1536x1024` (3:2) vẫn hợp lệ.
 */
export function postImageSize(size: ImageSize): ImageSize {
  return size === '1024x1536' ? '1024x1024' : size
}

/** Lỗi gateway đáng thử lại: chặn tần suất, OpenAI lỗi tạm (5xx / hết giờ). */
const retryable = (err: AppError) => err.code === 'RATE_LIMITED' || (err.code === 'AI_PROVIDER_ERROR' && err.statusCode >= 500)

/** `pending` → `failed` + sự kiện (chỉ khi ô còn chờ). `cause` = mã gốc, chỉ để log. */
async function markFailed(deps: ImageGenerateDeps, id: string, code: ImageErrorCode, cause: string): Promise<ImageGenerateOutcome> {
  const changed = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(mediaAssets)
      .set({ status: 'failed', errorCode: code })
      .where(and(eq(mediaAssets.id, id), eq(mediaAssets.status, 'pending')))
      .returning({ id: mediaAssets.id })
    if (row) {
      await deps.events.publishEvent(tx, 'media_asset.failed', { id, errorCode: code })
      await settleSlotImage(tx, deps.events, id, code)
    }
    return !!row
  })
  deps.log?.warn({ mediaAssetId: id, code, cause }, 'content: sinh ảnh AI lỗi')
  return changed ? 'failed' : 'skipped'
}

/**
 * Handler một ô ảnh. `finalAttempt`: lượt cuối → lỗi tạm thành `failed` thay vì ném. Ô không còn `pending` (đã xong,
 * đã lỗi, đã bị dọn) → `skipped`, không gọi OpenAI.
 */
export async function generateImageAsset(
  deps: ImageGenerateDeps,
  id: string,
  opts: { finalAttempt: boolean; signal?: AbortSignal | undefined },
): Promise<ImageGenerateOutcome> {
  const [row] = await deps.db.select({ status: mediaAssets.status, prompt: mediaAssets.prompt }).from(mediaAssets).where(eq(mediaAssets.id, id))
  if (!row || row.status !== 'pending') return 'skipped'
  if (!row.prompt) return markFailed(deps, id, 'IMAGE_FAILED', 'PROMPT_MISSING')

  const size = postImageSize((await getOpenAiPrefs(deps.db)).imageSize)
  const slot = await slotOfAsset(deps.db, id)
  let image: Buffer
  try {
    const res = await generateImage(deps, {
      feature: slot ? 'campaign_generate' : 'image_generate',
      ...(slot ? { pageId: slot.pageId } : {}),
      ref: id,
      prompt: row.prompt,
      n: 1,
      size,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    image = res.images[0]!
  } catch (err) {
    if (opts.signal?.aborted) throw err
    if (err instanceof AppError) {
      if (retryable(err) && !opts.finalAttempt) throw new ImageGenerateRetryableError(err.code)
      return markFailed(deps, id, err.code === 'AI_POLICY_BLOCKED' ? 'IMAGE_REJECTED' : 'IMAGE_FAILED', err.code)
    }
    if (!opts.finalAttempt) throw err
    return markFailed(deps, id, 'IMAGE_FAILED', 'INTERNAL')
  }

  // Images API trả JPEG (`output_format: jpeg`); vẫn kiểm magic bytes trước khi đưa lên kho công khai.
  const mime = detectImageMime(image)
  if (!mime) return markFailed(deps, id, 'IMAGE_FAILED', 'NOT_IMAGE')
  const put = await deps.media.publicStore.put({ data: image, mime, asJpeg: true, stripMetadata: true, toSrgb: true })
  if (!put.ok) return markFailed(deps, id, 'IMAGE_FAILED', put.kind)

  let stored: boolean
  try {
    stored = await deps.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(mediaAssets)
        .set({ status: 'ready', publicId: put.publicId, url: put.url, width: put.width, height: put.height, bytes: put.bytes, format: put.format })
        .where(and(eq(mediaAssets.id, id), eq(mediaAssets.status, 'pending')))
        .returning({ id: mediaAssets.id })
      if (updated) {
        await deps.events.publishEvent(tx, 'media_asset.created', { id })
        await settleSlotImage(tx, deps.events, id, null)
      }
      return !!updated
    })
  } catch (err) {
    await deps.media.publicStore.delete(put.publicId).catch(() => {})
    throw err
  }
  if (!stored) {
    // Ô đã bị dọn / đã có kết quả từ lượt khác trong lúc sinh → không để lại file mồ côi.
    await deps.media.publicStore.delete(put.publicId).catch(() => {})
    return 'skipped'
  }
  return 'ready'
}

export function parseImageGenerateJobData(data: unknown): { mediaAssetId: string } {
  const id = (data as { mediaAssetId?: unknown } | null)?.mediaAssetId
  if (typeof id !== 'string' || id === '') throw new Error('content.image.generate: thiếu mediaAssetId')
  return { mediaAssetId: id }
}

export async function handleImageGenerateJob(
  deps: ImageGenerateDeps,
  job: { data: unknown; retryCount: number; retryLimit: number; signal?: AbortSignal | undefined },
): Promise<ImageGenerateOutcome> {
  const { mediaAssetId } = parseImageGenerateJobData(job.data)
  return generateImageAsset(deps, mediaAssetId, { finalAttempt: job.retryCount >= job.retryLimit, signal: job.signal })
}
