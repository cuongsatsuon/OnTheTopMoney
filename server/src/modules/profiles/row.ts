// Ánh xạ dòng `brand_profiles` ↔ DTO + helper owner, tách khỏi `service.ts` để `service.ts` và `inheritance.ts`
// dùng chung mà không tạo vòng phụ thuộc (service → inheritance cho `onGroupProfileSaved`).
import type { BrandProfileDto, ConfigOwnerType, ParsedBrandProfile } from '@ottm/shared'
import { BrandProduct } from '@ottm/shared'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { brandProfiles } from './schema.ts'

export interface ProfileOwner {
  ownerType: ConfigOwnerType
  ownerId: string
}

type Row = typeof brandProfiles.$inferSelect

const StoredProducts = z.array(BrandProduct)

/** Sản phẩm thực sự có dữ liệu (bỏ `{name:'', price:''}`) — đối xứng với client. */
export const nonEmptyProducts = (products: ParsedBrandProfile['products']) => products.filter((p) => p.name !== '' || p.price !== '')

export function toBrandDto(row: Row): BrandProfileDto {
  return {
    ownerType: row.ownerType as ConfigOwnerType,
    ownerId: row.ownerId,
    name: row.name,
    slogan: row.slogan,
    industry: row.industry,
    tones: row.tones,
    formality: row.formality,
    pronoun: row.pronoun,
    emoji: row.emoji as BrandProfileDto['emoji'],
    // Parse jsonb bằng zod: cột hỏng → lỗi server rõ (không rơi dữ liệu sai xuống FE).
    products: StoredProducts.parse(row.products),
    audience: row.audience,
    colors: row.colors,
    hashtags: row.hashtags,
    bannedWords: row.bannedWords,
    allowedDomains: row.allowedDomains,
    logoPath: row.logoPath,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const brandOwnerWhere = (owner: ProfileOwner) =>
  and(eq(brandProfiles.ownerType, owner.ownerType), eq(brandProfiles.ownerId, owner.ownerId))

/** Giá trị cột `brand_profiles` từ input đã parse (KHÔNG gồm `logo_path` — logo quản lý riêng). */
export function brandInsertValues(owner: ProfileOwner, input: ParsedBrandProfile) {
  return {
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    name: input.name,
    slogan: input.slogan,
    industry: input.industry,
    tones: input.tones,
    formality: input.formality,
    pronoun: input.pronoun,
    emoji: input.emoji,
    products: nonEmptyProducts(input.products),
    audience: input.audience,
    colors: input.colors,
    hashtags: input.hashtags,
    bannedWords: input.bannedWords,
    allowedDomains: input.allowedDomains,
  }
}
