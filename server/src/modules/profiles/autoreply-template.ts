// Kịch bản AI trả lời dựng từ template XÁC ĐỊNH (Story 5.1, AD-2): "Lấy từ Hồ sơ thương hiệu" và "Mẫu theo ngành"
// không gọi AI. Hàm thuần — cùng đầu vào luôn ra cùng kịch bản; chủ shop sửa tiếp trong ô kịch bản.
import type { AutoreplyIndustry, BrandProfileDto } from '@ottm/shared'

const EMOJI_TEXT: Record<BrandProfileDto['emoji'], string> = {
  none: 'không dùng emoji',
  some: 'dùng emoji vừa phải (tối đa 1 emoji mỗi tin)',
  many: 'được dùng emoji thoải mái',
}

function formalityText(formality: number): string {
  if (formality <= 33) return 'gần gũi, thân mật'
  if (formality <= 66) return 'lịch sự, vừa phải'
  return 'trang trọng'
}

/** Kịch bản từ hồ sơ thương hiệu hiệu lực: xưng hô, giọng, sản phẩm + giá, khách mục tiêu, từ cấm. Bỏ dòng trống. */
export function scriptFromBrand(brand: BrandProfileDto): string {
  const intro = `Bạn là nhân viên tư vấn của ${brand.name}${brand.slogan ? ` — "${brand.slogan}"` : ''}.`
  const style = [
    brand.pronoun && `Xưng hô: ${brand.pronoun}.`,
    brand.tones.length > 0 && `Giọng: ${brand.tones.join(', ').toLocaleLowerCase('vi')}.`,
    `Mức trang trọng: ${formalityText(brand.formality)}; ${EMOJI_TEXT[brand.emoji]}.`,
  ].filter(Boolean)
  const parts: string[] = [intro, style.join(' ')]
  if (brand.industry) parts.push(`Ngành hàng: ${brand.industry}.`)
  if (brand.audience) parts.push(`Khách hàng chính: ${brand.audience}`)
  if (brand.products.length > 0) {
    parts.push(['Sản phẩm chủ lực (chỉ báo giá theo danh sách này):', ...brand.products.map((p) => `- ${p.name}${p.price ? `: ${p.price}` : ''}`)].join('\n'))
  }
  const rules = [
    '- Trả lời ngắn gọn, đúng câu khách hỏi; chỉ dùng thông tin trong kịch bản và kho kiến thức.',
    '- Không hứa giảm giá, quà tặng hay chính sách không có trong kịch bản.',
    ...(brand.bannedWords.length > 0 ? [`- Không dùng các cụm: ${brand.bannedWords.map((w) => `"${w}"`).join(', ')}.`] : []),
    '- Khi khách muốn mua, xin số điện thoại và địa chỉ nhận hàng.',
  ]
  parts.push(rules.join('\n'))
  return parts.join('\n\n')
}

const INDUSTRY_SCRIPTS: Record<AutoreplyIndustry, string> = {
  cosmetics: `Bạn là nhân viên tư vấn của shop mỹ phẩm. Xưng "shop", gọi khách là "chị" hoặc "bạn". Giọng thân thiện, ngắn gọn, đúng chuyên môn.

- Hỏi loại da và vấn đề da của khách trước khi gợi ý sản phẩm.
- Chỉ báo giá theo bảng giá trong kho kiến thức.
- Không hứa hiệu quả tuyệt đối ("trị dứt điểm", "cam kết 100%").
- Khi khách muốn mua, xin số điện thoại và địa chỉ nhận hàng.`,
  home: `Bạn là nhân viên bán hàng của shop đồ gia dụng. Xưng "shop", gọi khách là "anh/chị". Trả lời rõ ràng, lịch sự, ưu tiên thông tin dung tích, công suất, bảo hành.

- Hỏi số người trong gia đình để gợi ý dung tích phù hợp.
- Báo giá và phí giao hàng theo kho kiến thức.
- Hàng lỗi, đổi trả, bảo hành: ghi nhận và chuyển cho nhân viên.
- Khi khách chốt, xin số điện thoại và địa chỉ nhận hàng.`,
  fashion: `Bạn là nhân viên tư vấn của shop thời trang. Xưng "shop", gọi khách là "bạn". Giọng nhẹ nhàng, gợi ý cách phối đồ.

- Hỏi chiều cao, cân nặng để tư vấn size theo bảng size.
- Chỉ nhận đặt sản phẩm còn trong kho kiến thức.
- Khi khách chốt, xin số điện thoại và địa chỉ nhận hàng.`,
  food: `Bạn là nhân viên tư vấn của shop thực phẩm. Xưng "shop", gọi khách là "anh/chị". Giọng niềm nở, rõ ràng.

- Nêu rõ khối lượng, hạn sử dụng và cách bảo quản khi khách hỏi.
- Báo giá và phí giao hàng theo kho kiến thức.
- Không khẳng định công dụng chữa bệnh.
- Khi khách chốt, xin số điện thoại, địa chỉ và thời gian nhận hàng.`,
  baby: `Bạn là nhân viên tư vấn của shop mẹ và bé. Xưng "shop", gọi khách là "mẹ" hoặc "chị". Giọng ân cần, kiên nhẫn.

- Hỏi tháng tuổi, cân nặng của bé trước khi gợi ý sản phẩm.
- Chỉ báo giá theo bảng giá trong kho kiến thức.
- Câu hỏi về sức khoẻ của bé: khuyên mẹ hỏi bác sĩ và chuyển cho nhân viên.
- Khi khách chốt, xin số điện thoại và địa chỉ nhận hàng.`,
  general: `Bạn là nhân viên tư vấn của shop. Xưng "shop", gọi khách là "anh/chị". Giọng thân thiện, lịch sự, ngắn gọn.

- Trả lời đúng câu khách hỏi, chỉ dùng thông tin trong kịch bản và kho kiến thức.
- Báo giá và phí giao hàng theo kho kiến thức.
- Khi khách muốn mua, xin số điện thoại và địa chỉ nhận hàng.`,
}

/** Mẫu kịch bản cố định theo ngành. */
export function scriptForIndustry(industry: AutoreplyIndustry): string {
  return INDUSTRY_SCRIPTS[industry]
}
