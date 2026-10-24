// Story 8.4 — ý tưởng "Tạo bài tương tự" tóm từ caption đã đăng (`content.similarIdea`, thuần, không gọi AI). Phủ: bỏ
// hashtag / link / emoji, nối dòng thành câu; cắt theo câu khi dài; câu đầu quá dài; không còn chữ → `null`; ký hiệu
// đầu dòng + ký tự vô hình + khoảng trắng thừa.
import { describe, expect, it } from 'vitest'
import { SIMILAR_IDEA_MAX, similarIdea } from '../src/modules/content/index.ts'

const len = (s: string) => [...s].length

describe('similarIdea', () => {
  it('bỏ emoji, hashtag, mention, link; dòng thiếu dấu kết câu thêm "."; nối bằng dấu cách', () => {
    expect(similarIdea('🔥 SALE nồi chiên 20%\nChỉ cuối tuần!\n#giadung https://x.vn')).toBe('SALE nồi chiên 20%. Chỉ cuối tuần!')
    expect(similarIdea('Đặt tại www.shop.vn/abc. Hỏi @minhphat nhé 😍😍')).toBe('Đặt tại. Hỏi nhé.')
    // Email giữ nguyên (`@` sau chữ không phải mention); số đầu dòng giữ dấu trừ.
    expect(similarIdea('Liên hệ ban@shop.vn\n-20% hôm nay')).toBe('Liên hệ ban@shop.vn. -20% hôm nay.')
    // Keycap / cờ / tông da / ZWJ đều bỏ, chữ số giữ.
    expect(similarIdea('1️⃣ Giao nhanh 🇻🇳 👍🏽 👨\u200D👩\u200D👧')).toBe('1 Giao nhanh.')
  })

  it('dài hơn giới hạn → giữ trọn các câu đầu còn vừa', () => {
    const s1 = `Câu một ${'a'.repeat(120)}.`
    const s2 = `Câu hai ${'b'.repeat(120)}!`
    const s3 = `Câu ba ${'c'.repeat(120)}.`
    const idea = similarIdea(`${s1}\n${s2}\n${s3}`)!
    expect(idea).toBe(`${s1} ${s2}`)
    expect(len(idea)).toBeLessThanOrEqual(SIMILAR_IDEA_MAX)
  })

  it('một câu duy nhất quá dài → cắt ở khoảng trắng cuối trước giới hạn + "…"', () => {
    const words = Array.from({ length: 80 }, (_, i) => `từ${i}`).join(' ')
    const idea = similarIdea(words)!
    expect(len(idea)).toBeLessThanOrEqual(SIMILAR_IDEA_MAX)
    expect(idea.endsWith('…')).toBe(true)
    expect(words.startsWith(idea.slice(0, -1))).toBe(true)
    expect(idea.at(-2)).not.toBe(' ')
    // Không có khoảng trắng → cắt cứng.
    expect(len(similarIdea('x'.repeat(400))!)).toBe(SIMILAR_IDEA_MAX)
  })

  it('không còn chữ (rỗng / chỉ hashtag, emoji, link, dấu câu) → null', () => {
    expect(similarIdea('')).toBeNull()
    expect(similarIdea('   \n\n ')).toBeNull()
    expect(similarIdea('#giadung #sale 🔥🔥 https://x.vn\n...')).toBeNull()
  })

  it('ký hiệu đầu dòng, ký tự vô hình (ZWSP, RLO, BOM), tab + khoảng trắng thừa', () => {
    const caption = '\uFEFFƯu đãi:\n• Giảm\u200B 20%\n- Tặng   kèm\tnồi\n→Freeship\n\u202EĐảo chiều'
    expect(similarIdea(caption)).toBe('Ưu đãi: Giảm 20%. Tặng kèm nồi. Freeship. Đảo chiều.')
  })
})
