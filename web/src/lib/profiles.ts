// Hồ sơ thương hiệu (Story 3.1) phía web. Nối BrandProfileForm vào API thật: tải/lưu phần chữ, tải/gỡ logo,
// lỗi dưới ô. Phần thuần (map DTO ↔ form, validate, kiểm logo) tách khỏi hook để test được (profiles.test.ts).
// Chủ thật (nhóm/trang có id uuid từ API) mới gọi server; id kho mẫu (g-beauty, p1…) vẫn chạy mock như cũ.
import {
  BrandProfileDto,
  BrandProfileResponse,
  EffectiveBrandProfileResponse,
  LOGO_MAX_BYTES,
  LOGO_MIMES,
  type BrandEmojiLevel,
  type ConfigOwnerType,
  type ConfigSource,
  type EffectiveBrandProfileResponse as EffectiveBrandProfileResponseT,
  type SaveBrandProfileRequest,
  type SetUseOwnRequest,
} from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, isApiError } from './api'

/* ---------- Hằng số dùng chung với form ---------- */

export type EmojiLabel = 'Không' | 'Vừa phải' | 'Nhiều'

export const TONES = ['Thân thiện', 'Chuyên gia', 'Trẻ trung', 'Sang trọng', 'Hài hước']
export const INDUSTRIES = ['Mỹ phẩm', 'Gia dụng', 'Thời trang', 'Thực phẩm', 'Mẹ & bé', 'Khác']
export const PRONOUNS = ['Shop – chị/bạn', 'Mình – bạn', 'Em – anh/chị', 'Chúng tôi – quý khách']
export const EMOJIS: { id: EmojiLabel; label: string }[] = [
  { id: 'Không', label: 'Không' },
  { id: 'Vừa phải', label: 'Vừa phải' },
  { id: 'Nhiều', label: 'Nhiều' },
]

export interface BrandProduct {
  name: string
  price: string
}

/** Dạng form của BrandProfileForm (giữ nguyên UX hiện có). `logo` là URL hoặc object URL xem trước. */
export interface BrandForm {
  name: string
  tagline: string
  industry: string
  tones: string[]
  formality: number
  pronoun: string
  emoji: EmojiLabel
  products: BrandProduct[]
  audience: string
  colors: string[]
  hashtags: string[]
  banned: string[]
  allowedDomains: string[]
  logo: string | null
}

const EMOJI_TO_LEVEL: Record<EmojiLabel, BrandEmojiLevel> = { Không: 'none', 'Vừa phải': 'some', Nhiều: 'many' }
const LEVEL_TO_EMOJI: Record<BrandEmojiLevel, EmojiLabel> = { none: 'Không', some: 'Vừa phải', many: 'Nhiều' }
export const emojiToLevel = (e: EmojiLabel): BrandEmojiLevel => EMOJI_TO_LEVEL[e] ?? 'some'
export const emojiFromLevel = (l: BrandEmojiLevel): EmojiLabel => LEVEL_TO_EMOJI[l] ?? 'Vừa phải'

/** Form trống cho một chủ chưa có hồ sơ. */
export function blankBrand(name: string): BrandForm {
  return { name, tagline: '', industry: 'Khác', tones: ['Thân thiện'], formality: 60, pronoun: PRONOUNS[0]!, emoji: 'Vừa phải', products: [], audience: '', colors: [], hashtags: [], banned: [], allowedDomains: [], logo: null }
}

/** DTO server → form. `null` (chưa có hồ sơ) → form trống với tên gợi ý. */
export function brandDataOf(dto: BrandProfileDto | null, fallbackName: string): BrandForm {
  if (!dto) return blankBrand(fallbackName)
  return {
    name: dto.name,
    tagline: dto.slogan,
    industry: dto.industry || 'Khác',
    tones: dto.tones,
    formality: dto.formality,
    pronoun: dto.pronoun || PRONOUNS[0]!,
    emoji: emojiFromLevel(dto.emoji),
    products: dto.products.map((p) => ({ name: p.name, price: p.price })),
    audience: dto.audience,
    colors: dto.colors,
    hashtags: dto.hashtags,
    banned: dto.bannedWords,
    allowedDomains: dto.allowedDomains,
    logo: dto.logoPath,
  }
}

/** Form → body `PUT /brand-profiles`. Bỏ sản phẩm trống; logo tải riêng nên không nằm ở đây. */
export function toSaveRequest(form: BrandForm): SaveBrandProfileRequest {
  return {
    name: form.name.trim(),
    slogan: form.tagline.trim(),
    industry: form.industry.trim(),
    tones: form.tones,
    formality: form.formality,
    pronoun: form.pronoun.trim(),
    emoji: emojiToLevel(form.emoji),
    products: form.products.map((p) => ({ name: p.name.trim(), price: p.price.trim() })).filter((p) => p.name || p.price),
    audience: form.audience.trim(),
    colors: form.colors,
    hashtags: form.hashtags,
    bannedWords: form.banned,
    allowedDomains: form.allowedDomains,
  }
}

export const BRAND_NAME_REQUIRED = 'Nhập tên thương hiệu.'

/** Lỗi ô tên (tên bắt buộc) — hiện dưới ô; `null` = hợp lệ. */
export function brandNameError(name: string): string | null {
  return name.trim() ? null : BRAND_NAME_REQUIRED
}

/** Lỗi từ server (VALIDATION_FAILED details theo field) → lỗi ô tên (chỉ map `name` — ô duy nhất có lỗi dưới ô). */
export function fieldErrorsOf(err: unknown): { name?: string } {
  if (!isApiError(err) || err.code !== 'VALIDATION_FAILED' || !Array.isArray(err.details)) return {}
  for (const d of err.details as unknown[]) {
    if (d && typeof d === 'object' && Array.isArray((d as { path?: unknown }).path) && ((d as { path: unknown[] }).path).includes('name')) {
      const message = (d as { message?: unknown }).message
      return { name: typeof message === 'string' ? message : BRAND_NAME_REQUIRED }
    }
  }
  return {}
}

export const LOGO_TYPE_ERROR = 'Chỉ nhận ảnh PNG, JPEG hoặc WebP.'
export const LOGO_SIZE_ERROR = 'Logo tối đa 2MB.'

/** Kiểm nhanh phía web trước khi tải (server vẫn kiểm magic bytes). `null` = hợp lệ. */
export function logoFileError(file: { type: string; size: number }): string | null {
  if (!(LOGO_MIMES as readonly string[]).includes(file.type)) return LOGO_TYPE_ERROR
  if (file.size > LOGO_MAX_BYTES) return LOGO_SIZE_ERROR
  return null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Chủ thật (id là uuid từ API) mới gọi server; id kho mẫu (g-beauty, p1…) dùng mock như cũ. */
export const isRealOwner = (id: string): boolean => UUID_RE.test(id)

/* ---------- Kế thừa Nhóm→Trang (Story 3.2 + 3.3) — helper thuần ---------- */

/** Mời tạo hồ sơ riêng khi `resolveEffective` trả CONFIG_MISSING (trang không nhóm & không hồ sơ). */
export const CONFIG_MISSING_INVITE = 'Trang này chưa có hồ sơ thương hiệu. Tạo hồ sơ riêng cho trang để AI viết đúng giọng.'

/** Nhãn kế thừa dưới ô (Component "Nhãn kế thừa"): nguồn hồ sơ đang dùng của trang. */
export function inheritanceLabel(source: ConfigSource): string {
  return source.ownerType === 'group' ? `Đang dùng hồ sơ của ${source.name}` : 'Đang dùng hồ sơ riêng của trang'
}

/** CONFIG_MISSING = `effective` null (trang không nhóm & không hồ sơ). */
export function isConfigMissing(res: EffectiveBrandProfileResponseT): boolean {
  return res.effective === null
}

/** Trang đang theo nhóm (không dùng hồ sơ riêng) khi có hồ sơ hiệu lực và nguồn là nhóm. */
export function isInheritingFromGroup(res: EffectiveBrandProfileResponseT): boolean {
  return res.effective !== null && res.effective.source.ownerType === 'group'
}

/**
 * Tắt "Dùng hồ sơ riêng" cần xác nhận trước (xoá hồ sơ riêng, không hoàn tác); bật thì không. (F1 Thất bại.)
 * Dùng cho công tắc: chỉ khi `next=false` mới mở hộp thoại hỏi lại.
 */
export const confirmBeforeToggle = (next: boolean): boolean => next === false

/** Body `PUT …/use-own` — chỉ gọi khi bấm Lưu (bật/tắt công tắc chưa Lưu không đụng server). */
export const toUseOwnRequest = (useOwn: boolean): SetUseOwnRequest => ({ useOwn })

/** File → base64 (không tiền tố data:) để gửi trong JSON. */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/* ---------- Hook React Query ---------- */

export interface BrandOwner {
  ownerType: ConfigOwnerType
  ownerId: string
}

export const brandProfileKey = (owner: BrandOwner) => ['brand-profile', owner.ownerType, owner.ownerId] as const
const pathOf = (owner: BrandOwner) => `/brand-profiles/${owner.ownerType}/${owner.ownerId}`

export function useBrandProfile(owner: BrandOwner, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: brandProfileKey(owner),
    queryFn: ({ signal }) => apiFetch(pathOf(owner), { schema: BrandProfileResponse, signal }),
    enabled: options.enabled ?? true,
  })
}

export function useSaveBrandProfile(owner: BrandOwner) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SaveBrandProfileRequest) => apiFetch(pathOf(owner), { method: 'PUT', body, schema: BrandProfileDto }),
    onSuccess: (profile) => qc.setQueryData(brandProfileKey(owner), { profile }),
  })
}

export function useUploadBrandLogo(owner: BrandOwner) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (file: File) =>
      apiFetch(`${pathOf(owner)}/logo`, { method: 'PUT', body: { mime: file.type, data: await fileToBase64(file) }, schema: BrandProfileDto }),
    onSuccess: (profile) => qc.setQueryData(brandProfileKey(owner), { profile }),
  })
}

export function useClearBrandLogo(owner: BrandOwner) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch(`${pathOf(owner)}/logo`, { method: 'DELETE', schema: BrandProfileDto }),
    onSuccess: (profile) => qc.setQueryData(brandProfileKey(owner), { profile }),
  })
}

/* ---------- Hook kế thừa (Story 3.2) ---------- */

export const effectiveBrandKey = (pageId: string) => ['brand-profile', 'effective', pageId] as const
const effectivePath = (pageId: string) => `/brand-profiles/effective/page/${pageId}`

/** Hồ sơ hiệu lực của một trang (đã giải kế thừa). `effective=null` → CONFIG_MISSING (mời tạo hồ sơ riêng). */
export function useEffectiveBrandProfile(pageId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: effectiveBrandKey(pageId),
    queryFn: ({ signal }) => apiFetch(effectivePath(pageId), { schema: EffectiveBrandProfileResponse, signal }),
    enabled: options.enabled ?? true,
  })
}

/** Bật/tắt "Dùng hồ sơ riêng" (áp khi Lưu). Làm mới cả hồ sơ hiệu lực lẫn hồ sơ riêng của trang. */
export function useSetBrandUseOwn(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (useOwn: boolean) =>
      apiFetch(`/brand-profiles/use-own/page/${pageId}`, { method: 'PUT', body: toUseOwnRequest(useOwn), schema: EffectiveBrandProfileResponse }),
    onSuccess: (res) => {
      qc.setQueryData(effectiveBrandKey(pageId), res)
      void qc.invalidateQueries({ queryKey: brandProfileKey({ ownerType: 'page', ownerId: pageId }) })
    },
  })
}
