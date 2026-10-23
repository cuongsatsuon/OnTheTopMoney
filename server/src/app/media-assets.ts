// Ảnh bài (Story 6.1, AD-14). Route dưới /api/v1 → guard auth đã yêu cầu phiên; ghi kiểm Origin (AD-19).
// Body là NGUYÊN bytes của ảnh (không base64, không multipart), `Content-Type` = MIME khai báo (jpeg/png/webp — loại
// khác Fastify trả 415 → `VALIDATION_FAILED`). Thứ tự: kiểm bytes (magic + kích thước) → tải lên kho công khai dạng
// JPEG sRGB, bỏ EXIF/ICC (mọi ảnh bài đều chuẩn hoá vì có thể gắn cho trang Instagram) → ghi `media_assets`; ghi
// lỗi thì xoá ảnh vừa tải. Ảnh chưa gắn vào bài nào quá 7 ngày do cron `content.media_gc` dọn (Story 6.3).
// Story 6.3: `GET /media-assets/generated?ids=a,b` — trạng thái các ô ảnh AI (Soạn bài hỏi lại khi SSE báo
// `media_asset.created|failed`). Tạo ô (`POST /media-assets/generate`) ở `media-generate.ts` (cần AI + jobs).
import {
  GENERATED_IMAGES_QUERY_MAX,
  GeneratedImagesResponse,
  POST_IMAGE_MAX_BYTES,
  POST_IMAGE_MIMES,
  PostImageMime,
  type MediaAssetDto,
} from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { MediaStores } from '../adapters/media/index.ts'
import { listGeneratedImages, recordMediaAsset, validatePostImage } from '../modules/content/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'
import { mediaAppError } from './media-errors.ts'

/** Fastify kiểm trước khi gọi handler: quá giới hạn → 413 (→ `VALIDATION_FAILED`). Dư 1 byte để route tự báo dưới ô. */
const IMAGE_BODY_LIMIT = POST_IMAGE_MAX_BYTES + 1

const IMAGE_MEDIA_ERRORS = { field: 'image', invalidMessage: 'Ảnh không hợp lệ', failCode: 'UPLOAD_FAILED' } as const

function imageError(message: string): AppError {
  return new AppError('VALIDATION_FAILED', 400, { details: [{ path: ['image'], message }] })
}

export interface MediaAssetsDeps {
  db: Db
  media: MediaStores
  now?: () => Date
}

/** `?ids=a,b,c`: 1–40 uuid, không trùng thứ tự. */
const GeneratedQuery = z
  .object({
    ids: z
      .string()
      .transform((v) => [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))])
      .pipe(z.array(z.uuid()).min(1).max(GENERATED_IMAGES_QUERY_MAX)),
  })
  .strict()

export function registerMediaAssets(app: FastifyInstance, deps: MediaAssetsDeps): void {
  const { db, media } = deps

  app.get('/api/v1/media-assets/generated', async (req): Promise<GeneratedImagesResponse> => {
    const { ids } = GeneratedQuery.parse(req.query ?? {})
    return { images: await listGeneratedImages(db, ids, deps.now?.() ?? new Date()) }
  })

  // Parser bytes chỉ trong scope này (route khác vẫn parse JSON như thường).
  app.register(async (scope) => {
    scope.addContentTypeParser([...POST_IMAGE_MIMES], { parseAs: 'buffer', bodyLimit: IMAGE_BODY_LIMIT }, (_req, body, done) => done(null, body))

    scope.post('/api/v1/media-assets', { bodyLimit: IMAGE_BODY_LIMIT }, async (req, reply): Promise<MediaAssetDto> => {
      const declared = PostImageMime.safeParse((req.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase())
      if (!declared.success) throw imageError('Chỉ nhận ảnh PNG, JPEG hoặc WebP')
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const checked = validatePostImage(data, declared.data)
      if (!checked.ok) throw imageError(checked.message)
      if (!media.configured) throw mediaAppError('MEDIA_NOT_CONFIGURED', IMAGE_MEDIA_ERRORS)
      const put = await media.publicStore.put({ data, mime: checked.mime, asJpeg: true, stripMetadata: true, toSrgb: true })
      if (!put.ok) throw mediaAppError(put.kind, IMAGE_MEDIA_ERRORS)
      try {
        return reply.code(201).send(await recordMediaAsset(db, 'upload', put))
      } catch (err) {
        await media.publicStore.delete(put.publicId).catch(() => {})
        throw err
      }
    })
  })
}
