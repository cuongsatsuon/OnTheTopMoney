// Mẫu prompt ảnh bài đăng (Story 6.3, AD-7: mẫu prompt dùng chung ở `modules/ai/prompts/`, export qua `ai/index.ts`).
// Thuần, xác định — dựng chuỗi `prompt` cho `generateImage(feature='image_generate')`. Mô tả do chủ shop gõ (ô "Mô tả
// ảnh", trống thì ý tưởng bài) chỉ là dữ liệu. Một bộ ảnh dùng chung cho mọi trang của bài nên không theo hồ sơ của
// trang nào. Ảnh không có chữ: caption mang chữ, còn chữ do model vẽ (nhất là tiếng Việt có dấu) thường sai.
import type { ImageStyle } from '@ottm/shared'

const STYLE_GUIDE: Record<ImageStyle, string> = {
  product: 'ảnh chụp sản phẩm chuyên nghiệp: sản phẩm là chủ thể rõ ràng, nền gọn, ánh sáng studio mềm',
  lifestyle: 'ảnh phong cách sống: sản phẩm được dùng trong khung cảnh đời thường tự nhiên, ánh sáng ấm',
  minimal: 'phong cách tối giản: bố cục thoáng, ít chi tiết, nền một màu nhạt',
  illustration: 'tranh minh hoạ phẳng (flat illustration), màu tươi, đường nét gọn',
}

/** Một dòng mô tả: gộp xuống dòng thành khoảng trắng (không cho mô tả chen thêm "dòng yêu cầu" giả). */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export function buildImagePrompt(input: { description: string; style: ImageStyle }): string {
  return [
    'Ảnh minh hoạ cho một bài đăng mạng xã hội (Facebook, Instagram, Threads) của shop bán hàng online tại Việt Nam.',
    `Nội dung ảnh: ${oneLine(input.description)}`,
    `Phong cách: ${STYLE_GUIDE[input.style]}.`,
    'Yêu cầu: ảnh sắc nét, chủ thể ở giữa khung, hợp đăng mạng xã hội.',
    'Không có chữ, chữ số, logo, watermark hay khung viền trong ảnh. Không vẽ người nổi tiếng hay nhân vật có bản quyền.',
  ].join('\n')
}
