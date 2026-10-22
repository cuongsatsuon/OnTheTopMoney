// Helper thuần của hồ sơ thương hiệu (Story 3.1): map DTO ↔ form, validate dưới ô, kiểm logo, nhận diện chủ thật.
import type { BrandProfileDto } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import {
  BRAND_NAME_REQUIRED,
  LOGO_SIZE_ERROR,
  LOGO_TYPE_ERROR,
  blankBrand,
  brandDataOf,
  brandNameError,
  emojiFromLevel,
  emojiToLevel,
  fieldErrorsOf,
  isRealOwner,
  logoFileError,
  toSaveRequest,
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
