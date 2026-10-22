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
import type { MediaErrorKind } from '../adapters/media/index.ts'
import {
  clearLogo,
  getProfile,
  resolveEffective,
  setLogo,
  setUseOwn,
  upsertProfile,
  validateLogoBytes,
  type ProfileOwner,
} from '../modules/profiles/index.ts'
import type { Db } from '../platform/db/index.ts'
import { AppError } from '../platform/errors/index.ts'

const OwnerParams = z.object({ ownerType: ConfigOwnerType, ownerId: z.uuid() })
const PageIdParams = z.object({ id: z.uuid() })

/** `resolveEffective` ném `CONFIG_MISSING` khi trang không nhóm & không hồ sơ → route trả `{effective:null}`. */
async function effectiveOrNull(db: Db, pageId: string): Promise<EffectiveBrandProfile | null> {
  try {
    return await resolveEffective<BrandProfileDto>(db, pageId, 'brand')
  } catch (err) {
    if (err instanceof AppError && err.code === 'CONFIG_MISSING') return null
    throw err
  }
}

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

/** MediaErrorKind → AppError. Convention repo: "chưa cấu hình" là 500 (như META/ENCRYPTION_NOT_CONFIGURED). */
function mediaError(kind: MediaErrorKind): AppError {
  switch (kind) {
    case 'MEDIA_NOT_CONFIGURED':
      return new AppError('MEDIA_NOT_CONFIGURED', 500, { message: 'CLOUDINARY_URL chưa đặt' })
    case 'INVALID_REQUEST':
      return logoValidationError('Ảnh không hợp lệ')
    case 'RATE_LIMITED':
      return new AppError('RATE_LIMITED', 429, { message: 'Cloudinary giới hạn tần suất' })
    default:
      return new AppError('IMAGE_FAILED', 502, { message: 'Không tải được logo lên Cloudinary' })
  }
}

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
      if (!media.configured) throw mediaError('MEDIA_NOT_CONFIGURED')
      // stripMetadata: loại EXIF/metadata tường minh khi lưu (không dựa mặc định của Cloudinary).
      const result = await media.publicStore.put({ data: bytes, mime: checked.mime, stripMetadata: true })
      if (!result.ok) throw mediaError(result.kind)
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
