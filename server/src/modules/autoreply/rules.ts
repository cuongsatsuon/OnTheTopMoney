// Luật chuyển người xác định của AI trả lời (AD-16): từ khoá của chủ shop và "khách yêu cầu gặp người" chạy TRƯỚC LLM,
// không gọi AI. Thuần. So khớp không dấu, không phân biệt hoa thường, theo biên từ ("doi tra" khớp "đổi trả"; "trả"
// không khớp "trải"). Dùng chung cho "Thử AI" (5.3) và lượt chạy thật (5.4).

/** Chuẩn hoá để so khớp: bỏ dấu (NFD), `đ → d`, hạ thường, mọi ký tự không phải chữ-số thành một khoảng trắng. */
export function foldForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** `phrase` (đã gấp) xuất hiện trọn từ trong `folded`. */
const containsPhrase = (folded: string, phrase: string): boolean => phrase !== '' && ` ${folded} `.includes(` ${phrase} `)

/**
 * Câu khách đòi gặp người (đã gấp). Chỉ các cụm rõ nghĩa: "nhân viên" đứng một mình (vd "nhân viên giao hàng") không
 * tính. Cách nói khác để LLM nhận ra (`CUSTOMER_ASKED_HUMAN` trong structured output).
 */
export const ASK_HUMAN_PHRASES: readonly string[] = [
  'gap nguoi',
  'gap nhan vien',
  'gap tu van vien',
  'gap admin',
  'gap chu shop',
  'gap quan ly',
  'noi chuyen voi nguoi',
  'noi chuyen voi nhan vien',
  'chat voi nguoi',
  'chat voi nhan vien',
  // Không dùng "người thật" trơn: "có hình người thật mặc không" là hỏi ảnh mẫu, không phải đòi gặp người.
  'voi nguoi that',
  'co nguoi that khong',
  'tu van vien',
  'nhan vien tu van',
  'goi dien cho minh',
  'goi dien cho em',
  'goi dien cho toi',
  'goi lai cho minh',
  'goi lai cho em',
  'goi lai cho toi',
  'khong muon noi chuyen voi bot',
].map(foldForMatch)

export interface HandoffRuleConfig {
  handoffKeywords: readonly string[]
  handoffOnCustomerAsk: boolean
}

export type HandoffRuleMatch = { reasonCode: 'KEYWORD'; keyword: string } | { reasonCode: 'CUSTOMER_ASKED_HUMAN'; keyword: null }

/** Luật khớp đầu tiên trên chữ các tin mới của khách: từ khoá (theo thứ tự cấu hình) rồi "khách yêu cầu gặp người". */
export function matchHandoffRule(text: string, cfg: HandoffRuleConfig): HandoffRuleMatch | null {
  const folded = foldForMatch(text)
  if (!folded) return null
  for (const keyword of cfg.handoffKeywords) {
    if (containsPhrase(folded, foldForMatch(keyword))) return { reasonCode: 'KEYWORD', keyword }
  }
  if (cfg.handoffOnCustomerAsk && ASK_HUMAN_PHRASES.some((p) => containsPhrase(folded, p))) {
    return { reasonCode: 'CUSTOMER_ASKED_HUMAN', keyword: null }
  }
  return null
}
