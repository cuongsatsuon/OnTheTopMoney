// Mẫu prompt caption theo hồ sơ thương hiệu (AD-7: mẫu prompt dùng chung ở `modules/ai/prompts/`, export qua
// `ai/index.ts`). Thuần, xác định — dựng `{instructions, input}` cho `generateText(feature='brand_sample')`.
// Dùng cho "Viết thử bằng AI" (Story 3.4); các story sau (Soạn bài, chiến dịch) có thể tái dùng.
import type { ParsedBrandSample } from '@ottm/shared'

/** Số token đầu ra tối đa cho một caption viết thử (đủ cho bài dài, vẫn chặn chi phí). */
export const CAPTION_MAX_OUTPUT_TOKENS = 700

/** Phần hồ sơ mà prompt caption cần — hồ sơ nháp (Story 3.4) hoặc hồ sơ hiệu lực (story sau) đều khớp. */
export type CaptionBrand = Pick<
  ParsedBrandSample,
  'name' | 'slogan' | 'industry' | 'tones' | 'formality' | 'pronoun' | 'emoji' | 'products' | 'audience' | 'hashtags' | 'bannedWords' | 'allowedDomains'
>

const EMOJI_GUIDE: Record<CaptionBrand['emoji'], string> = {
  none: 'Không dùng emoji.',
  some: 'Dùng emoji vừa phải, chỉ vài cái cho tự nhiên.',
  many: 'Dùng nhiều emoji sinh động.',
}

/** Mức trang trọng 0–100 → mô tả giọng (khớp nhãn FE: Trang trọng ↔ Rất gần gũi). */
function formalityGuide(formality: number): string {
  if (formality >= 75) return 'rất gần gũi, thân mật như nói chuyện với bạn thân'
  if (formality >= 55) return 'gần gũi, thân thiện'
  if (formality >= 30) return 'cân bằng giữa thân thiện và chuyên nghiệp'
  return 'trang trọng, lịch sự'
}

/** Hướng dẫn hệ thống (`instructions`): vai trò, giọng, và RÀNG BUỘC từ cấm / link (song song với hậu kiểm AD-21). */
export function captionInstructions(brand: CaptionBrand): string {
  const lines = [
    'Bạn là trợ lý viết nội dung mạng xã hội cho một shop bán hàng online tại Việt Nam.',
    'Viết MỘT caption tiếng Việt cho một bài đăng mẫu để chủ shop xem thử giọng văn. Chỉ trả về nội dung caption, không thêm giải thích hay tiêu đề.',
    `Giọng văn: ${brand.tones.length ? brand.tones.join(', ') : 'thân thiện'}; mức độ ${formalityGuide(brand.formality)}.`,
    brand.pronoun ? `Xưng hô: ${brand.pronoun}.` : '',
    EMOJI_GUIDE[brand.emoji],
    'Độ dài vừa phải, khoảng 3–6 câu và KHÔNG quá 2000 ký tự.',
  ]
  if (brand.bannedWords.length) {
    lines.push(`TUYỆT ĐỐI KHÔNG dùng các từ/cụm từ bị cấm sau (kể cả biến thể có dấu khác): ${brand.bannedWords.join(', ')}.`)
  }
  if (brand.allowedDomains.length) {
    lines.push(`Chỉ được chèn liên kết thuộc các tên miền: ${brand.allowedDomains.join(', ')}. Không chèn bất kỳ liên kết nào khác.`)
  } else {
    lines.push('Không chèn bất kỳ liên kết (URL) nào vào caption.')
  }
  return lines.filter(Boolean).join('\n')
}

/** Dữ liệu hồ sơ (`input`) để AI viết đúng chất shop. */
export function captionInput(brand: CaptionBrand): string {
  const products = brand.products.filter((p) => p.name || p.price).map((p) => (p.price ? `${p.name} (${p.price})` : p.name))
  const lines = [
    `Tên thương hiệu: ${brand.name || 'Thương hiệu của bạn'}`,
    brand.slogan ? `Slogan: ${brand.slogan}` : '',
    brand.industry ? `Ngành hàng: ${brand.industry}` : '',
    brand.audience ? `Khách hàng mục tiêu: ${brand.audience}` : '',
    products.length ? `Sản phẩm chủ lực (chỉ báo giá theo danh sách này): ${products.join('; ')}` : '',
    brand.hashtags.length ? `Hashtag gợi ý: ${brand.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}` : '',
    '',
    'Hãy viết caption mẫu quảng bá shop hoặc một sản phẩm chủ lực, đúng giọng văn và ràng buộc ở trên.',
  ]
  return lines.filter((l) => l !== '').join('\n')
}

/** Dựng prompt caption đầy đủ cho gateway. */
export function buildCaptionPrompt(brand: CaptionBrand): { instructions: string; input: string; maxOutputTokens: number } {
  return { instructions: captionInstructions(brand), input: captionInput(brand), maxOutputTokens: CAPTION_MAX_OUTPUT_TOKENS }
}
