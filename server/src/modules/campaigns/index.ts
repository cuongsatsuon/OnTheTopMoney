// Module `campaigns` (AD-1, AD-15 — Story 7.1): sở hữu `campaigns`, `campaign_topics`, `campaign_pages`. Public API chỉ
// export từ file này.
// Gọi `pages` (base), `profiles` (hồ sơ thương hiệu hiệu lực — trang chọn được), `content` (slot — Story 7.2; `content`
// gọi tiếp `ai`) theo bảng mũi tên AD-1. Không module nào gọi `campaigns`; `content` báo ngược chiều qua sự kiện.
export const MODULE = 'campaigns'

// Nháp wizard bước 1–3 (Story 7.1): lưu / thay / đọc cấu hình.
export { createCampaignDraft, getCampaign, updateCampaignDraft } from './drafts.ts'
// Trang chọn được làm đích (mất kết nối / thiếu hồ sơ → không chọn được, kèm lý do).
export { listPageOptions, pageBlockReason } from './pages.ts'
// Xem trước 7 bài đầu (Story 7.2): đồng bộ slot khi lưu nháp, job `campaigns.preview`, đọc, Sửa / Xoá / Tạo lại.
export {
  PREVIEW_CONCURRENCY,
  PreviewRetryableError,
  applySlotAction,
  getPreview,
  handlePreviewJob,
  previewPlan,
  runPreview,
  syncPreviewSlots,
  type PreviewDeps,
  type PreviewResult,
} from './preview.ts'
