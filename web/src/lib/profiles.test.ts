// Helper thuần của hồ sơ thương hiệu (Story 3.1): map DTO ↔ form, validate dưới ô, kiểm logo, nhận diện chủ thật.
import type { BrandProfileDto, EffectiveBrandProfileResponse } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import {
  BRAND_NAME_REQUIRED,
  LOGO_SIZE_ERROR,
  LOGO_TYPE_ERROR,
  avoidedBannedLabel,
  blankBrand,
  brandDataOf,
  brandNameError,
  confirmBeforeToggle,
  emojiFromLevel,
  emojiToLevel,
  fieldErrorsOf,
  inheritanceLabel,
  isAiLockError,
  isConfigMissing,
  isInheritingFromGroup,
  isRealOwner,
  logoFileError,
  markViolations,
  toSampleRequest,
  toSaveRequest,
  toUseOwnRequest,
} from './profiles'

const UUID = '018f3e2a-7c1d-7a2b-9c3d-4e5f60718293'

const DTO: BrandProfileDto = {
  ownerType: 'group',
  ownerId: UUID,
  name: 'Shop A',
  slogan: 'Đẹp mỗi ngày',
  industry: 'Mỹ phẩm',
  tones: ['Thân thiện', 'Chuyên gia'],
  formality: 70,
  pronoun: 'Shop – chị/bạn',
  emoji: 'many',
  products: [{ name: 'Serum', price: '450.000đ' }],
  audience: 'Nữ 22–35',
  colors: ['#DB2777'],
  hashtags: ['#shopa'],
  bannedWords: ['cam kết 100%'],
  allowedDomains: ['shopa.vn'],
  logoPath: 'https://res.cloudinary.com/x/y.png',
  createdAt: '2026-10-22T00:00:00.000',
  updatedAt: '2026-10-22T00:00:00.000',
}

describe('emoji ↔ level', () => {
  it('round-trip', () => {
    for (const label of ['Không', 'Vừa phải', 'Nhiều'] as const) expect(emojiFromLevel(emojiToLevel(label))).toBe(label)
    expect(emojiToLevel('Nhiều')).toBe('many')
    expect(emojiFromLevel('none')).toBe('Không')
  })
})

describe('brandDataOf', () => {
  it('null → form trống với tên gợi ý', () => {
    expect(brandDataOf(null, 'Nhóm X')).toEqual(blankBrand('Nhóm X'))
  })
  it('DTO → form (slogan→tagline, bannedWords→banned, emoji level→nhãn, logoPath)', () => {
    const f = brandDataOf(DTO, 'fallback')
    expect(f).toMatchObject({ name: 'Shop A', tagline: 'Đẹp mỗi ngày', emoji: 'Nhiều', banned: ['cam kết 100%'], allowedDomains: ['shopa.vn'], logo: 'https://res.cloudinary.com/x/y.png' })
  })
  it('industry rỗng → "Khác"', () => {
    expect(brandDataOf({ ...DTO, industry: '' }, 'x').industry).toBe('Khác')
  })
})

describe('toSaveRequest', () => {
  it('map nhãn emoji, bỏ sản phẩm trống, trim, allowedDomains rỗng', () => {
    const req = toSaveRequest({
      ...brandDataOf(DTO, 'x'),
      emoji: 'Vừa phải',
      name: '  Shop A  ',
      products: [{ name: 'Serum', price: '450' }, { name: '', price: '' }],
    })
    expect(req.emoji).toBe('some')
    expect(req.name).toBe('Shop A')
    expect(req.products).toEqual([{ name: 'Serum', price: '450' }])
    expect(req.bannedWords).toEqual(['cam kết 100%'])
    expect(req.allowedDomains).toEqual(['shopa.vn'])
  })
})

describe('brandNameError', () => {
  it('rỗng / toàn khoảng trắng → lỗi; có chữ → null', () => {
    expect(brandNameError('')).toBe(BRAND_NAME_REQUIRED)
    expect(brandNameError('   ')).toBe(BRAND_NAME_REQUIRED)
    expect(brandNameError('Shop')).toBeNull()
  })
})

describe('fieldErrorsOf', () => {
  it('VALIDATION_FAILED có details path name → {name}', () => {
    const err = new ApiError('VALIDATION_FAILED', 400, 'x', [{ path: ['name'], message: 'Tên không được để trống' }])
    expect(fieldErrorsOf(err)).toEqual({ name: 'Tên không được để trống' })
  })
  it('mã khác / details không phải mảng → rỗng', () => {
    expect(fieldErrorsOf(new ApiError('NOT_FOUND', 404, 'x'))).toEqual({})
    expect(fieldErrorsOf(new ApiError('VALIDATION_FAILED', 400, 'x', { nope: true }))).toEqual({})
    expect(fieldErrorsOf(new Error('x'))).toEqual({})
  })
})

describe('logoFileError', () => {
  it('ảnh hợp lệ → null; SVG → lỗi loại; quá lớn → lỗi kích thước', () => {
    expect(logoFileError({ type: 'image/png', size: 1000 })).toBeNull()
    expect(logoFileError({ type: 'image/svg+xml', size: 1000 })).toBe(LOGO_TYPE_ERROR)
    expect(logoFileError({ type: 'image/png', size: 3 * 1024 * 1024 })).toBe(LOGO_SIZE_ERROR)
  })
})

describe('isRealOwner', () => {
  it('uuid → true; id kho mẫu → false', () => {
    expect(isRealOwner(UUID)).toBe(true)
    expect(isRealOwner('g-beauty')).toBe(false)
    expect(isRealOwner('p1')).toBe(false)
  })
})

describe('kế thừa Nhóm→Trang (Story 3.2)', () => {
  const groupEffective: EffectiveBrandProfileResponse = {
    effective: { config: DTO, source: { ownerType: 'group', ownerId: UUID, name: 'Nhóm Mỹ phẩm' } },
  }
  const pageEffective: EffectiveBrandProfileResponse = {
    effective: { config: DTO, source: { ownerType: 'page', ownerId: UUID, name: 'Shop A' } },
  }
  const missing: EffectiveBrandProfileResponse = { effective: null }

  it('nhãn kế thừa: nguồn nhóm → "Đang dùng hồ sơ của Nhóm Mỹ phẩm"; nguồn trang → hồ sơ riêng', () => {
    expect(inheritanceLabel(groupEffective.effective!.source)).toBe('Đang dùng hồ sơ của Nhóm Mỹ phẩm')
    expect(inheritanceLabel(pageEffective.effective!.source)).toBe('Đang dùng hồ sơ riêng của trang')
  })

  it('CONFIG_MISSING = effective null; theo nhóm = nguồn group', () => {
    expect(isConfigMissing(missing)).toBe(true)
    expect(isConfigMissing(groupEffective)).toBe(false)
    expect(isInheritingFromGroup(groupEffective)).toBe(true)
    expect(isInheritingFromGroup(pageEffective)).toBe(false)
    expect(isInheritingFromGroup(missing)).toBe(false)
  })

  it('công tắc: tắt (false) hỏi lại, bật (true) không; request áp khi Lưu', () => {
    expect(confirmBeforeToggle(false)).toBe(true)
    expect(confirmBeforeToggle(true)).toBe(false)
    expect(toUseOwnRequest(true)).toEqual({ useOwn: true })
    expect(toUseOwnRequest(false)).toEqual({ useOwn: false })
  })
})

describe('Viết thử bằng AI (Story 3.4)', () => {
  it('toSampleRequest: giống body lưu (bỏ sản phẩm trống)', () => {
    const form = { ...blankBrand('Shop'), products: [{ name: 'Son', price: '150k' }, { name: '', price: '' }], banned: ['x'] }
    expect(toSampleRequest(form)).toEqual(toSaveRequest(form))
    expect(toSampleRequest(form).products).toEqual([{ name: 'Son', price: '150k' }])
  })

  it('isAiLockError: chỉ khoá nút với hết hạn mức / thiếu / khoá OpenAI hỏng (UX-DR2)', () => {
    expect(isAiLockError(new ApiError('OPENAI_KEY_MISSING', 400, 'x'))).toBe(true)
    expect(isAiLockError(new ApiError('OPENAI_KEY_INVALID', 400, 'x'))).toBe(true)
    expect(isAiLockError(new ApiError('AI_BUDGET_EXCEEDED', 402, 'x'))).toBe(true)
    expect(isAiLockError(new ApiError('AI_PROVIDER_ERROR', 502, 'x'))).toBe(false)
    expect(isAiLockError(new ApiError('AI_POLICY_BLOCKED', 422, 'x'))).toBe(false)
    expect(isAiLockError(new Error('khác'))).toBe(false)
  })

  it('avoidedBannedLabel: N = số từ cấm đã kiểm (không phải số lần tránh); ẩn khi không khai từ cấm', () => {
    expect(avoidedBannedLabel(3)).toBe('Không có từ cấm (đã kiểm 3 từ).')
    expect(avoidedBannedLabel(0)).toBeNull()
  })

  it('markViolations: tách đoạn và đánh dấu đúng cụm từ cấm / URL; too_long bị bỏ qua', () => {
    const segs = markViolations('Siêu GIAM GIA tại evil.com nhé', [
      { kind: 'banned_word', text: 'GIAM GIA' },
      { kind: 'disallowed_url', text: 'evil.com' },
      { kind: 'too_long', text: '5000/2200' },
    ])
    expect(segs).toEqual([
      { text: 'Siêu ', kind: null },
      { text: 'GIAM GIA', kind: 'banned_word' },
      { text: ' tại ', kind: null },
      { text: 'evil.com', kind: 'disallowed_url' },
      { text: ' nhé', kind: null },
    ])
    // Chuỗi nối lại bằng caption gốc.
    expect(segs.map((s) => s.text).join('')).toBe('Siêu GIAM GIA tại evil.com nhé')
  })

  it('markViolations: không vi phạm → một đoạn thường; rỗng → []', () => {
    expect(markViolations('Mẫu mới nhé', [])).toEqual([{ text: 'Mẫu mới nhé', kind: null }])
    expect(markViolations('', [])).toEqual([])
  })

  it('markViolations: đánh dấu mọi lần lặp dù khác hoa thường (giữ nguyên hoa thường gốc)', () => {
    const segs = markViolations('spam rồi SPAM nữa', [{ kind: 'banned_word', text: 'spam' }])
    expect(segs).toEqual([
      { text: 'spam', kind: 'banned_word' },
      { text: ' rồi ', kind: null },
      { text: 'SPAM', kind: 'banned_word' },
      { text: ' nữa', kind: null },
    ])
  })
})
