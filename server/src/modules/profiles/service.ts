// Nghiệp vụ hồ sơ thương hiệu (Story 3.1). Ranh giới AD-1: `profiles` gọi `pages` (kiểm owner tồn tại) và
// `adapters/media` (lưu logo công khai) — xem `index.ts`. Một hồ sơ mỗi `(ownerType, ownerId)` (upsert).
// Kế thừa Nhóm→Trang (Story 3.2/3.3) giải ở `inheritance.ts`; upsert hồ sơ NHÓM chạy `onGroupProfileSaved`
// (trong CÙNG transaction, AD-3) để các trang đang chờ nhóm chuyển về "Theo nhóm".
import type { LogoMime, ParsedBrandProfile } from '@ottm/shared'
import { LOGO_MAX_BYTES } from '@ottm/shared'
import type { BrandProfileDto } from '@ottm/shared'
import { sql } from 'drizzle-orm'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { getGroup, getPage } from '../pages/index.ts'
import { onGroupProfileSaved } from './inheritance.ts'
import { brandInsertValues, brandOwnerWhere as ownerWhere, toBrandDto as toDto, type ProfileOwner } from './row.ts'
import { brandProfiles } from './schema.ts'

export type { ProfileOwner } from './row.ts'

/**
 * Owner (nhóm/trang) phải tồn tại và chưa gỡ, nếu không 404. Dùng `pages.getGroup` / `pages.getPage` (AD-1:
 * `profiles` → `pages`). `getPage` đã loại trang đã gỡ (`removed_at`).
 */
export async function assertOwnerExists(db: DbExecutor, owner: ProfileOwner): Promise<void> {
  const exists = owner.ownerType === 'group' ? !!(await getGroup(db, owner.ownerId)) : !!(await getPage(db, owner.ownerId))
  if (!exists) {
    const what = owner.ownerType === 'group' ? 'Nhóm' : 'Trang'
    throw new AppError('NOT_FOUND', 404, { message: `${what} không tồn tại`, details: { ownerType: owner.ownerType, ownerId: owner.ownerId } })
  }
}

/** Hồ sơ của một chủ; `null` khi chưa có (FE form trống). Không kiểm owner tồn tại (đọc rỗng là hợp lệ). */
export async function getProfile(db: DbExecutor, owner: ProfileOwner): Promise<BrandProfileDto | null> {
  const [row] = await db.select().from(brandProfiles).where(ownerWhere(owner))
  return row ? toDto(row) : null
}

async function upsertBrandRow(tx: DbExecutor, owner: ProfileOwner, input: ParsedBrandProfile): Promise<BrandProfileDto> {
  await assertOwnerExists(tx, owner)
  const values = brandInsertValues(owner, input)
  const [row] = await tx
    .insert(brandProfiles)
    .values(values)
    .onConflictDoUpdate({
      target: [brandProfiles.ownerType, brandProfiles.ownerId],
      set: { ...values, updatedAt: sql`now()` },
    })
    .returning()
  return toDto(row!)
}

/**
 * Tạo/cập nhật hồ sơ theo `(owner_type, owner_id)`. Owner phải tồn tại (404). KHÔNG đụng `logo_path` (logo quản lý
 * riêng qua `setLogo`/`clearLogo`) — upsert phần chữ không xoá logo đã có.
 * Hồ sơ NHÓM: sau khi lưu, trong CÙNG transaction chạy `onGroupProfileSaved` (Story 3.3) — các trang đang chờ
 * nhóm (`awaiting_group_default`) chuyển về "Theo nhóm".
 */
export async function upsertProfile(db: Db, owner: ProfileOwner, input: ParsedBrandProfile): Promise<BrandProfileDto> {
  if (owner.ownerType === 'group') {
    return db.transaction(async (tx) => {
      const dto = await upsertBrandRow(tx, owner, input)
      await onGroupProfileSaved(tx, owner.ownerId, 'brand')
      return dto
    })
  }
  return upsertBrandRow(db, owner, input)
}

/**
 * Định dạng ảnh theo magic bytes (JPEG `FFD8FF`, PNG `89504E470D0A1A0A`, WebP `RIFF…WEBP`). Không phải một trong ba
 * (SVG, text, ảnh khác) → `null`. Tự kiểm, không thêm thư viện ảnh server (AD-14: EXIF do Cloudinary loại).
 */
export function detectImageMime(bytes: Uint8Array): LogoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

export const LOGO_VALIDATION = {
  /** Byte rỗng / vượt 2 MB. */
  tooLarge: 'Logo tối đa 2MB',
  /** Không nhận dạng được là PNG/JPEG/WebP (SVG/text bị từ chối). */
  notImage: 'Chỉ nhận ảnh PNG, JPEG hoặc WebP',
  /** Magic bytes không khớp MIME khai báo. */
  mismatch: 'Định dạng ảnh không khớp',
} as const

/**
 * Kiểm bytes logo trước khi gọi Cloudinary: không rỗng, ≤ 2 MB, là ảnh PNG/JPEG/WebP và khớp `declaredMime`
 * (SVG/text bị từ chối). Trả MIME đã xác nhận, hoặc thông báo lỗi (dưới ô logo). Không gọi mạng.
 */
export function validateLogoBytes(bytes: Uint8Array, declaredMime: LogoMime): { ok: true; mime: LogoMime } | { ok: false; message: string } {
  if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) return { ok: false, message: LOGO_VALIDATION.tooLarge }
  const detected = detectImageMime(bytes)
  if (!detected) return { ok: false, message: LOGO_VALIDATION.notImage }
  if (detected !== declaredMime) return { ok: false, message: LOGO_VALIDATION.mismatch }
  return { ok: true, mime: detected }
}

/** Đặt `logo_path` (URL Cloudinary) cho hồ sơ đã có. Hồ sơ chưa tồn tại → 404 (lưu phần chữ trước). */
export async function setLogo(db: DbExecutor, owner: ProfileOwner, logoPath: string): Promise<BrandProfileDto> {
  const [row] = await db
    .update(brandProfiles)
    .set({ logoPath, updatedAt: sql`now()` })
    .where(ownerWhere(owner))
    .returning()
  if (!row) throw new AppError('NOT_FOUND', 404, { message: 'Chưa có hồ sơ để gắn logo — lưu hồ sơ trước' })
  return toDto(row)
}

/** Gỡ logo (`logo_path = null`). Hồ sơ chưa tồn tại → 404. */
export async function clearLogo(db: DbExecutor, owner: ProfileOwner): Promise<BrandProfileDto> {
  const [row] = await db
    .update(brandProfiles)
    .set({ logoPath: null, updatedAt: sql`now()` })
    .where(ownerWhere(owner))
    .returning()
  if (!row) throw new AppError('NOT_FOUND', 404, { message: 'Chưa có hồ sơ' })
  return toDto(row)
}
