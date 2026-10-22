// Hồ sơ thương hiệu (Story 3.1, AD-1 module `profiles`). Dùng chung BE/FE: BE validate bằng các schema này,
// FE dựng request từ cùng giới hạn (tên bắt buộc, giọng điệu ≤3, màu ≤6…). Một hồ sơ cho mỗi `(ownerType, ownerId)`.
// Logo là tuỳ chọn, tải lên riêng (ảnh công khai qua Cloudinary) → `logoPath` là URL; phần chữ lưu được dù chưa có logo.
import { z } from 'zod'
import { AiViolation } from './ai.ts'
import { ConfigOwnerType } from './enums.ts'

const IsoDateTime = z.iso.datetime({ offset: false })

/** Mức dùng emoji trong bài/tin AI (bật/tắt/mức). FE hiển thị nhãn tiếng Việt, map ở `web/src/lib/profiles.ts`. */
export const BRAND_EMOJI_LEVELS = ['none', 'some', 'many'] as const
export const BrandEmojiLevel = z.enum(BRAND_EMOJI_LEVELS)
export type BrandEmojiLevel = z.infer<typeof BrandEmojiLevel>

// Giới hạn độ dài hợp lý từng ô (enforce ở zod — khớp FE).
export const BRAND_NAME_MAX = 100
export const BRAND_SLOGAN_MAX = 200
export const BRAND_INDUSTRY_MAX = 60
export const BRAND_PRONOUN_MAX = 60
export const BRAND_AUDIENCE_MAX = 2000
export const BRAND_TONES_MAX = 3
export const BRAND_TONE_MAX = 40
export const BRAND_COLORS_MAX = 6
export const BRAND_PRODUCTS_MAX = 100
export const BRAND_PRODUCT_NAME_MAX = 160
export const BRAND_PRODUCT_PRICE_MAX = 60
export const BRAND_HASHTAGS_MAX = 30
export const BRAND_HASHTAG_MAX = 80
export const BRAND_BANNED_MAX = 100
export const BRAND_BANNED_WORD_MAX = 80
export const BRAND_DOMAINS_MAX = 50
export const BRAND_DOMAIN_MAX = 253
export const BRAND_FORMALITY_MIN = 0
export const BRAND_FORMALITY_MAX = 100

/** Ảnh logo: nhận PNG/JPEG/WebP ≤ 2 MB (magic bytes kiểm ở server; SVG/text bị từ chối). */
export const LOGO_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const LogoMime = z.enum(LOGO_MIMES)
export type LogoMime = z.infer<typeof LogoMime>
export const LOGO_MAX_BYTES = 2 * 1024 * 1024

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Màu phải có dạng #RRGGBB')

/** Tên thương hiệu: bắt buộc (tên rỗng → lỗi dưới ô). */
export const BrandName = z
  .string()
  .trim()
  .min(1, 'Tên thương hiệu không được để trống')
  .max(BRAND_NAME_MAX, `Tên thương hiệu tối đa ${BRAND_NAME_MAX} ký tự`)

/** Một sản phẩm chủ lực + giá (AI chỉ báo giá theo danh sách này). */
export const BrandProduct = z
  .object({
    name: z.string().trim().max(BRAND_PRODUCT_NAME_MAX),
    price: z.string().trim().max(BRAND_PRODUCT_PRICE_MAX),
  })
  .strict()
export type BrandProduct = z.infer<typeof BrandProduct>

/** Body `PUT /api/v1/brand-profiles/:ownerType/:ownerId` — phần chữ của hồ sơ (logo tải riêng). */
export const SaveBrandProfileRequest = z
  .object({
    name: BrandName,
    slogan: z.string().trim().max(BRAND_SLOGAN_MAX).default(''),
    industry: z.string().trim().max(BRAND_INDUSTRY_MAX).default(''),
    tones: z.array(z.string().trim().min(1).max(BRAND_TONE_MAX)).max(BRAND_TONES_MAX, `Chọn tối đa ${BRAND_TONES_MAX} giọng điệu`).default([]),
    formality: z.number().int().min(BRAND_FORMALITY_MIN).max(BRAND_FORMALITY_MAX).default(60),
    pronoun: z.string().trim().max(BRAND_PRONOUN_MAX).default(''),
    emoji: BrandEmojiLevel.default('some'),
    products: z.array(BrandProduct).max(BRAND_PRODUCTS_MAX).default([]),
    audience: z.string().trim().max(BRAND_AUDIENCE_MAX).default(''),
    colors: z.array(HexColor).max(BRAND_COLORS_MAX, `Tối đa ${BRAND_COLORS_MAX} màu`).default([]),
    hashtags: z.array(z.string().trim().min(1).max(BRAND_HASHTAG_MAX)).max(BRAND_HASHTAGS_MAX).default([]),
    bannedWords: z.array(z.string().trim().min(1).max(BRAND_BANNED_WORD_MAX)).max(BRAND_BANNED_MAX).default([]),
    allowedDomains: z.array(z.string().trim().min(1).max(BRAND_DOMAIN_MAX)).max(BRAND_DOMAINS_MAX).default([]),
  })
  .strict()
export type SaveBrandProfileRequest = z.input<typeof SaveBrandProfileRequest>
/** Dạng đã parse (mọi mặc định đã điền) — service nhận kiểu này. */
export type ParsedBrandProfile = z.output<typeof SaveBrandProfileRequest>

/** Body `PUT …/logo`: ảnh base64 trong JSON (tránh phụ thuộc multipart). `mime` khai báo phải khớp magic bytes. */
export const UploadBrandLogoRequest = z
  .object({
    mime: LogoMime,
    // base64 của ≤ 2 MB (+ dư cho JSON); vượt → VALIDATION_FAILED trước khi giải mã.
    data: z.string().min(1).max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 1024, 'Logo tối đa 2MB'),
  })
  .strict()
export type UploadBrandLogoRequest = z.infer<typeof UploadBrandLogoRequest>

/** Hồ sơ trả về (đọc). `logoPath` là URL Cloudinary công khai hoặc `null`. */
export const BrandProfileDto = z.object({
  ownerType: ConfigOwnerType,
  ownerId: z.uuid(),
  name: z.string(),
  slogan: z.string(),
  industry: z.string(),
  tones: z.array(z.string()),
  formality: z.number().int(),
  pronoun: z.string(),
  emoji: BrandEmojiLevel,
  products: z.array(BrandProduct),
  audience: z.string(),
  colors: z.array(z.string()),
  hashtags: z.array(z.string()),
  bannedWords: z.array(z.string()),
  allowedDomains: z.array(z.string()),
  logoPath: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type BrandProfileDto = z.infer<typeof BrandProfileDto>

/** `GET …` — hồ sơ hoặc `null` (owner chưa có hồ sơ → FE form trống). */
export const BrandProfileResponse = z.object({ profile: BrandProfileDto.nullable() })
export type BrandProfileResponse = z.infer<typeof BrandProfileResponse>

/* ---------- Viết thử bằng AI (Story 3.4, AD-7 + AD-21) ---------- */

/**
 * Body `POST /api/v1/brand-profiles/sample` — hồ sơ NHÁP đang soạn (kể cả chưa lưu). Giống `SaveBrandProfileRequest`
 * nhưng `name` không bắt buộc ([ASSUMPTION] cho phép viết thử khi tên còn rỗng; prompt dùng tên gợi ý khi trống).
 */
export const BrandSampleRequest = SaveBrandProfileRequest.extend({
  name: z.string().trim().max(BRAND_NAME_MAX, `Tên thương hiệu tối đa ${BRAND_NAME_MAX} ký tự`).default(''),
}).strict()
export type BrandSampleRequest = z.input<typeof BrandSampleRequest>
export type ParsedBrandSample = z.output<typeof BrandSampleRequest>

/**
 * `POST …/sample` — caption AI viết theo hồ sơ nháp. `violations` rỗng = sạch → FE hiện "Đã tránh N từ cấm"
 * (`avoidedBannedCount`); có `violations` = vẫn vi phạm sau khi sinh lại một lần → FE đánh dấu từng cụm.
 */
export const BrandSampleResponse = z.object({
  caption: z.string(),
  violations: z.array(AiViolation),
  /** Số từ cấm đã khai trong hồ sơ ([ASSUMPTION] N = số từ cấm) — FE hiện "Đã tránh N từ cấm" khi sạch. */
  avoidedBannedCount: z.number().int().nonnegative(),
})
export type BrandSampleResponse = z.infer<typeof BrandSampleResponse>

/* ---------- Kế thừa Nhóm→Trang (Story 3.2 + 3.3, AD-8) ---------- */

/**
 * Chủ cấu hình mà `resolveEffective` chọn: nhóm (trang đang theo nhóm) hoặc chính trang (dùng hồ sơ riêng).
 * `name` để FE hiện nhãn kế thừa "Đang dùng hồ sơ của Nhóm …".
 */
export const ConfigSource = z.object({
  ownerType: ConfigOwnerType,
  ownerId: z.uuid(),
  name: z.string(),
})
export type ConfigSource = z.infer<typeof ConfigSource>

/** Cấu hình hiệu lực của một trang cho một loại cấu hình: `{config, source}`. Generic để Epic 5 (AI) dùng lại. */
export interface EffectiveConfig<T> {
  config: T
  source: ConfigSource
}

/** Hồ sơ thương hiệu hiệu lực của một trang (đã giải kế thừa). */
export const EffectiveBrandProfile = z.object({
  config: BrandProfileDto,
  source: ConfigSource,
})
export type EffectiveBrandProfile = z.infer<typeof EffectiveBrandProfile>

/**
 * `GET …/effective/page/:id` — hồ sơ hiệu lực của trang, hoặc `null` khi `resolveEffective` trả `CONFIG_MISSING`
 * (trang không nhóm & không hồ sơ) → FE mời tạo hồ sơ riêng cho trang.
 */
export const EffectiveBrandProfileResponse = z.object({ effective: EffectiveBrandProfile.nullable() })
export type EffectiveBrandProfileResponse = z.infer<typeof EffectiveBrandProfileResponse>

/**
 * Body `PUT …/use-own/page/:id` — bật/tắt "Dùng hồ sơ riêng" (chỉ áp khi Lưu). `true`: sao chép hồ sơ nhóm làm
 * điểm xuất phát rồi `use_own=true`. `false`: xoá hồ sơ riêng, trang quay về hồ sơ nhóm (FE xác nhận trước).
 */
export const SetUseOwnRequest = z.object({ useOwn: z.boolean() }).strict()
export type SetUseOwnRequest = z.infer<typeof SetUseOwnRequest>
