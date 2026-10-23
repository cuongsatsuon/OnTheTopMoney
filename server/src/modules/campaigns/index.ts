// Module `campaigns` (AD-1, AD-15 — Story 7.1): sở hữu `campaigns`, `campaign_topics`, `campaign_pages`. Public API chỉ
// export từ file này.
// Gọi `pages` (base), `profiles` (hồ sơ thương hiệu hiệu lực — trang chọn được); 7.2+ gọi thêm `content`, `ai` (bảng
// mũi tên AD-1). Không module nào gọi `campaigns`; `content` báo ngược chiều qua sự kiện.
export const MODULE = 'campaigns'

// Nháp wizard bước 1–3 (Story 7.1): lưu / thay / đọc cấu hình.
export { createCampaignDraft, getCampaign, updateCampaignDraft } from './drafts.ts'
// Trang chọn được làm đích (mất kết nối / thiếu hồ sơ → không chọn được, kèm lý do).
export { listPageOptions, pageBlockReason } from './pages.ts'
