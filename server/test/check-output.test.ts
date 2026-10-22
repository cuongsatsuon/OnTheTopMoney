// Hậu kiểm đầu ra AI (AD-21) — hàm thuần `checkOutput` + mẫu prompt caption (Story 3.4). Không DB, không mạng.
import { AI_OUTPUT_MAX_CHARS } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import { buildCaptionPrompt, captionInput, captionInstructions, checkOutput, type CheckBrand } from '../src/modules/ai/index.ts'

const brandOf = (patch: Partial<CheckBrand> = {}): CheckBrand => ({ bannedWords: [], allowedDomains: [], ...patch })

describe('checkOutput — từ cấm (chuẩn hoá dấu + hoa thường)', () => {
  it('sạch khi không có từ cấm, URL hay quá dài', () => {
    expect(checkOutput('Mẫu mới về rồi nhé cả nhà', { brand: brandOf(), kind: 'caption' })).toEqual({ clean: true, violations: [] })
  })

  it('bắt từ cấm không phân biệt hoa thường và dấu, trích đúng cụm gốc để FE đánh dấu', () => {
    const brand = brandOf({ bannedWords: ['giảm giá', 'hàng fake'] })
    const r = checkOutput('SIÊU GIAM GIA và không bán Hàng Fake đâu', { brand, kind: 'caption' })
    expect(r.clean).toBe(false)
    expect(r.violations).toEqual([
      { kind: 'banned_word', text: 'GIAM GIA' },
      { kind: 'banned_word', text: 'Hàng Fake' },
    ])
  })

  it('khớp cả khi từ cấm có dấu còn văn bản không dấu và ngược lại; đ↔d', () => {
    expect(checkOutput('mua dong gia 99k', { brand: brandOf({ bannedWords: ['đồng giá'] }), kind: 'caption' }).clean).toBe(false)
    expect(checkOutput('ĐỒNG GIÁ toàn shop', { brand: brandOf({ bannedWords: ['dong gia'] }), kind: 'caption' }).clean).toBe(false)
  })

  it('từ cấm trùng lặp / có khoảng trắng thừa → một vi phạm; từ cấm rỗng bị bỏ qua', () => {
    const brand = brandOf({ bannedWords: ['  spam  ', 'spam', ''] })
    const r = checkOutput('toàn SPAM là SPAM', { brand, kind: 'caption' })
    expect(r.violations).toEqual([{ kind: 'banned_word', text: 'SPAM' }])
  })

  it('gom khoảng trắng nội bộ: "giảm  giá" (nhiều space) khớp từ cấm "giảm giá"', () => {
    const r = checkOutput('Siêu giảm  giá nhé', { brand: brandOf({ bannedWords: ['giảm giá'] }), kind: 'caption' })
    expect(r.violations).toEqual([{ kind: 'banned_word', text: 'giảm  giá' }])
  })

  it('biên từ: "giá" không khớp khi nằm trong chuỗi chữ-số lớn hơn ("giákhuyến") nhưng khớp khi tách bởi space/dấu câu', () => {
    const brand = brandOf({ bannedWords: ['giá'] })
    expect(checkOutput('giákhuyến mãi to', { brand, kind: 'caption' }).clean).toBe(true)
    expect(checkOutput('hàng giá rẻ', { brand, kind: 'caption' }).violations).toEqual([{ kind: 'banned_word', text: 'giá' }])
    expect(checkOutput('xem (giá) nhé', { brand, kind: 'caption' }).violations).toEqual([{ kind: 'banned_word', text: 'giá' }])
  })
})

describe('checkOutput — URL ngoài allowlist', () => {
  it('URL có host ngoài allowlist là vi phạm; host thuộc allowlist (kể cả subdomain, www) thì không', () => {
    const brand = brandOf({ allowedDomains: ['shop.vn'] })
    const r = checkOutput('Đặt tại https://shop.vn/sp và www.shop.vn, tránh http://evil.com/x', { brand, kind: 'caption' })
    expect(r.violations).toEqual([{ kind: 'disallowed_url', text: 'http://evil.com/x' }])
    expect(checkOutput('xem a.shop.vn nhé', { brand, kind: 'caption' }).clean).toBe(true)
  })

  it('allowlist rỗng → mọi URL là vi phạm (kể cả không scheme)', () => {
    const r = checkOutput('ghé example.com nha', { brand: brandOf(), kind: 'caption' })
    expect(r.violations).toEqual([{ kind: 'disallowed_url', text: 'example.com' }])
  })

  it('số có dấu chấm không phải URL (100.000đ, 2.5kg) → không báo', () => {
    expect(checkOutput('chỉ 100.000đ cho túi 2.5kg', { brand: brandOf(), kind: 'caption' }).clean).toBe(true)
  })

  it('bỏ dấu câu dính cuối URL và lọc trùng', () => {
    const r = checkOutput('xem example.com. và example.com nữa', { brand: brandOf(), kind: 'caption' })
    expect(r.violations).toEqual([{ kind: 'disallowed_url', text: 'example.com' }])
  })

  it('địa chỉ email (domain đứng sau @) không bị coi là URL ngoài allowlist', () => {
    expect(checkOutput('liên hệ shop@gmail.com nhé', { brand: brandOf(), kind: 'caption' }).clean).toBe(true)
    // URL thật đứng riêng vẫn bị bắt dù trong câu cũng có email.
    const r = checkOutput('mail shop@gmail.com và ghé evil.com', { brand: brandOf(), kind: 'caption' })
    expect(r.violations).toEqual([{ kind: 'disallowed_url', text: 'evil.com' }])
  })

  it('host IP literal (http://1.2.3.4/…) được kiểm theo allowlist', () => {
    expect(checkOutput('vào http://1.2.3.4/promo', { brand: brandOf(), kind: 'caption' }).violations).toEqual([
      { kind: 'disallowed_url', text: 'http://1.2.3.4/promo' },
    ])
    expect(checkOutput('vào http://1.2.3.4/promo', { brand: brandOf({ allowedDomains: ['1.2.3.4'] }), kind: 'caption' }).clean).toBe(true)
  })
})

describe('checkOutput — độ dài theo kind', () => {
  it('vượt độ dài tối đa của kind → too_long với "N/Max"', () => {
    const text = 'a'.repeat(AI_OUTPUT_MAX_CHARS.comment + 1)
    const r = checkOutput(text, { brand: brandOf(), kind: 'comment' })
    expect(r.violations).toEqual([{ kind: 'too_long', text: `${AI_OUTPUT_MAX_CHARS.comment + 1}/${AI_OUTPUT_MAX_CHARS.comment}` }])
  })

  it('đúng giới hạn thì không báo; đếm theo code point (emoji không làm lệch)', () => {
    expect(checkOutput('a'.repeat(AI_OUTPUT_MAX_CHARS.comment), { brand: brandOf(), kind: 'comment' }).clean).toBe(true)
  })

  it('thứ tự vi phạm: từ cấm → URL lạ → quá dài', () => {
    const brand = brandOf({ bannedWords: ['xxx'] })
    const text = `xxx ${'b'.repeat(AI_OUTPUT_MAX_CHARS.comment)} evil.com`
    const r = checkOutput(text, { brand, kind: 'comment' })
    expect(r.violations.map((v) => v.kind)).toEqual(['banned_word', 'disallowed_url', 'too_long'])
  })
})

describe('buildCaptionPrompt (mẫu prompt caption)', () => {
  const brand = {
    name: 'Mỹ phẩm Lan Anh',
    slogan: 'Đẹp tự nhiên',
    industry: 'Mỹ phẩm',
    tones: ['Thân thiện', 'Sang trọng'],
    formality: 70,
    pronoun: 'Shop – chị',
    emoji: 'some' as const,
    products: [{ name: 'Son lì', price: '150k' }],
    audience: 'Nữ 20–35',
    hashtags: ['mỹphẩm'],
    bannedWords: ['giảm giá'],
    allowedDomains: ['shop.vn'],
  }

  it('instructions nêu ràng buộc từ cấm + chỉ cho link allowlist; input có tên và sản phẩm', () => {
    const p = buildCaptionPrompt(brand)
    expect(p.maxOutputTokens).toBe(700)
    expect(p.instructions).toContain('giảm giá')
    expect(p.instructions).toContain('shop.vn')
    expect(p.instructions.toLowerCase()).toContain('giọng')
    expect(p.input).toContain('Mỹ phẩm Lan Anh')
    expect(p.input).toContain('Son lì (150k)')
  })

  it('không có allowlist → cấm mọi liên kết; tên rỗng → tên gợi ý', () => {
    const noLinks = captionInstructions({ ...brand, allowedDomains: [] })
    expect(noLinks).toContain('Không chèn bất kỳ liên kết')
    expect(captionInput({ ...brand, name: '' })).toContain('Thương hiệu của bạn')
  })
})
