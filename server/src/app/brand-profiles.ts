// Hồ sơ thương hiệu (Story 3.1). Mọi route dưới /api/v1 → guard auth đã yêu cầu phiên; ghi kiểm Origin (AD-19).
// GET/PUT phần chữ + PUT/DELETE logo. owner (group|page) phải tồn tại (service → 404). Logo: base64 trong JSON
// (tránh phụ thuộc multipart), kiểm magic bytes + từ chối SVG trước khi gọi Cloudinary; chưa cấu hình Cloudinary →
// MEDIA_NOT_CONFIGURED (phần chữ vẫn lưu được vì là PUT riêng).
import {
  LOGO_MAX_BYTES,
  SaveBrandProfileRequest,
  SetUseOwnRequest,
  UploadBrandLogoRequest,
  type BrandProfileDto,
  type BrandProfileResponse,
  type EffectiveBrandProfile,
  type EffectiveBrandProfileResponse,
} from '@ottm/shared'
import { ConfigOwnerType } from '@ottm/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { MediaStores } from '../adapters/media/index.ts'
import {
  clearLogo,
  getProfile,
  resolveEffectiveOrNull,
  setLogo,
  setUseOwn,
  upsertProfile,
  validateLogoBytes,
  type ProfileOwner,
} from '../modules/profiles/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'
import { mediaAppError } from './media-errors.ts'

const OwnerParams = z.object({ ownerType: ConfigOwnerType, ownerId: z.uuid() })
const PageIdParams = z.object({ id: z.uuid() })

/** Trang không nhóm & không hồ sơ (`CONFIG_MISSING`) → route trả `{effective:null}`. */
const effectiveOrNull = (db: Db, pageId: string): Promise<EffectiveBrandProfile | null> =>
  resolveEffectiveOrNull<BrandProfileDto>(db, pageId, 'brand')

/** base64 của 2 MB (+ JSON) ~ 2.8 MB; bodyLimit mặc định của Fastify là 1 MB → nâng riêng cho route logo. */
const LOGO_BODY_LIMIT = Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 64 * 1024

export interface BrandProfilesDeps {
  db: Db
  media: MediaStores
}

/** Lỗi logo (dưới ô logo). */
function logoValidationError(message: string): AppError {
  return new AppError('VALIDATION_FAILED', 400, { details: [{ path: ['logo'], message }] })
}

const LOGO_MEDIA_ERRORS = { field: 'logo', invalidMessage: 'Ảnh không hợp lệ', failCode: 'IMAGE_FAILED' } as const

export function registerBrandProfiles(app: FastifyInstance, deps: BrandProfilesDeps): void {
  const { db, media } = deps

  app.get('/api/v1/brand-profiles/:ownerType/:ownerId', async (req): Promise<BrandProfileResponse> => {
    const owner: ProfileOwner = OwnerParams.parse(req.params)
    return { profile: await getProfile(db, owner) }
  })

  app.put('/api/v1/brand-profiles/:ownerType/:ownerId', async (req): Promise<BrandProfileDto> => {
    const owner: ProfileOwner = OwnerParams.parse(req.params)
    const input = SaveBrandProfileRequest.parse(req.body ?? {})
    return upsertProfile(db, owner, input)
  })

  app.put(
    '/api/v1/brand-profiles/:ownerType/:ownerId/logo',
    { bodyLimit: LOGO_BODY_LIMIT },
    async (req): Promise<BrandProfileDto> => {
      const owner: ProfileOwner = OwnerParams.parse(req.params)
      const body = UploadBrandLogoRequest.parse(req.body ?? {})
      // Giải mã base64 → bytes; kiểm kích thước + magic bytes (khớp MIME, từ chối SVG) TRƯỚC khi gọi Cloudinary.
      const bytes = new Uint8Array(Buffer.from(body.data, 'base64'))
      const checked = validateLogoBytes(bytes, body.mime)
      if (!checked.ok) throw logoValidationError(checked.message)
      // Hồ sơ phải tồn tại TRƯỚC khi upload (404 nếu chưa lưu chữ) — tránh bỏ lại asset Cloudinary mồ côi/tốn phí.
      if (!(await getProfile(db, owner))) throw new AppError('NOT_FOUND', 404, { message: 'Chưa có hồ sơ để gắn logo — lưu hồ sơ trước' })
      if (!media.configured) throw mediaAppError('MEDIA_NOT_CONFIGURED', LOGO_MEDIA_ERRORS)
      // stripMetadata: loại EXIF/metadata tường minh khi lưu (không dựa mặc định của Cloudinary).
      const result = await media.publicStore.put({ data: bytes, mime: checked.mime, stripMetadata: true })
      if (!result.ok) throw mediaAppError(result.kind, LOGO_MEDIA_ERRORS)
      return setLogo(db, owner, result.url)
    },
  )

  app.delete('/api/v1/brand-profiles/:ownerType/:ownerId/logo', async (req): Promise<BrandProfileDto> => {
    const owner: ProfileOwner = OwnerParams.parse(req.params)
    return clearLogo(db, owner)
  })

  // Hồ sơ hiệu lực của trang (đã giải kế thừa Nhóm→Trang, Story 3.2). `null` = CONFIG_MISSING (FE mời tạo riêng).
  app.get('/api/v1/brand-profiles/effective/page/:id', async (req): Promise<EffectiveBrandProfileResponse> => {
    const { id } = PageIdParams.parse(req.params)
    return { effective: await effectiveOrNull(db, id) }
  })

  // Bật/tắt "Dùng hồ sơ riêng" (áp khi Lưu). Thay đổi trạng thái trong MỘT transaction (AD-3), rồi trả hiệu lực mới.
  app.put('/api/v1/brand-profiles/use-own/page/:id', async (req): Promise<EffectiveBrandProfileResponse> => {
    const { id } = PageIdParams.parse(req.params)
    const { useOwn } = SetUseOwnRequest.parse(req.body ?? {})
    await db.transaction((tx) => setUseOwn(tx, id, 'brand', useOwn))
    return { effective: await effectiveOrNull(db, id) }
  })
}
