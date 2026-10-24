// Module `content` (AD-1, AD-13, AD-14 — Story 6.1): sở hữu `posts`, `post_targets`, `media_assets`,
// `post_target_media`. Public API chỉ export từ file này.
// Gọi `pages` (base), `profiles` (nhận dạng ảnh; hồ sơ hiệu lực — 6.2), `ai` (caption 6.2, ảnh 6.3), `connections` (6.4);
// được `campaigns`, `analytics` gọi (bảng mũi tên AD-1).
export const MODULE = 'content'

// Bài + đích từng trang: một cửa tạo (AD-13), sửa nháp, đọc.
export { createPost, getPost, updateDraftPost, type CreateManualPostInput, type CreatePostInput, type CreateSlotPostInput } from './posts.ts'
// Luật nền tảng phía server (cùng bảng `packages/shared` với FE) — gọi trước mọi chuyển tới `scheduled`.
export { assertPublishable } from './publishable.ts'
// Lên lịch và đăng (Story 6.4, AD-13): chuyển trạng thái do chủ shop bấm; job `publish.target`; cron `content.requeue`.
export { lockDailyLimits, transitionPostTargets, transitionTarget, type TargetTransition, type TransitionDeps } from './transitions.ts'
export {
  CONTAINER_POLL_MAX,
  CONTAINER_POLL_MS,
  PUBLISH_RATE_DEFER_MAX_MS,
  PublishRetryableError,
  handlePublishJob,
  parsePublishJobData,
  publishTarget,
  type PublishDeps,
  type PublishOutcome,
} from './publish.ts'
// Lịch nội dung (Story 6.5, AD-18): target theo `scheduled_at` trong một khoảng.
export { calendarTitle, listCalendar, type CalendarRange } from './calendar.ts'
export { PUBLISHING_STUCK_MS, REQUEUE_OVERDUE_MS, requeueTargets, type RequeueDeps, type RequeueResult } from './requeue.ts'
// Ảnh bài (AD-14): kiểm bytes trước khi tải lên kho công khai, ghi `media_assets` sau.
export { POST_IMAGE_VALIDATION, recordMediaAsset, toGeneratedImageDto, toMediaAssetDto, validatePostImage } from './media.ts'
// Viết caption bằng AI theo hồ sơ từng trang (Story 6.2) — chạy trong request, không lưu bài.
export { AI_STOP_CODES, COMPOSE_CONCURRENCY, composeCaptionForPage, composeCaptions, type ComposeBrief, type ComposeDeps } from './compose.ts'
// Slot chiến dịch (Story 7.2, AD-13, AD-15): tạo / dọn slot theo kế hoạch của `campaigns`, sinh caption + ảnh, đọc xem trước.
// Story 7.4: lease khi sinh, cửa sổ cuốn chiếu (`listSlotsToGenerate({until})`), hàng đợi "Bài chờ duyệt", nháp kẹt.
export {
  SLOT_GENERATE_LEASE_MS,
  SlotGenerateRetryableError,
  ensureCampaignSlots,
  failSlot,
  generateSlot,
  getCampaignSlot,
  listCampaignSlots,
  listPendingSlots,
  listSlotsToGenerate,
  pruneCampaignSlots,
  slotCampaignOf,
  staleSlotCampaigns,
  type SlotGenerateDeps,
  type SlotOutcome,
  type SlotPlan,
} from './slots.ts'
// "Tự đăng" (Story 7.3 / 7.4): duyệt luôn bài chờ duyệt không mã lỗi của chiến dịch.
export { autoApproveCampaignSlots, type AutoApproveOutcome } from './slots-approve.ts'
// "Bắt đầu chiến dịch" (Story 7.3): tạo phần slot còn lại, bỏ `held` bài xem trước ("Tự đăng" → duyệt); tiến độ cho read-model.
export { startCampaignSlots, type StartSlotsResult } from './slots-start.ts'
export { campaignProgress, type CampaignProgress } from './slots-progress.ts'
// Tạm dừng / tiếp tục / xoá chiến dịch (Story 7.5): giữ, thả (bài lỡ giờ → `MISSED_WHILE_PAUSED`), huỷ hàng loạt slot;
// đếm slot còn mở cho cron hoàn tất.
export {
  cancelCampaignTargets,
  clearCampaignHolds,
  heldCampaignIds,
  holdCampaignTargets,
  openCampaignSlots,
  releaseCampaignTargets,
  type CancelCampaignResult,
  type ReleaseResult,
} from './slots-hold.ts'
// Sinh ảnh AI (Story 6.3, AD-14): yêu cầu 4 ô + job `content.image.generate`; cron dọn ảnh không gắn bài.
export {
  ImageGenerateRetryableError,
  failStuckSlotImages,
  generateImageAsset,
  handleImageGenerateJob,
  listGeneratedImages,
  requestImageGeneration,
  type ImageGenerateDeps,
  type ImageGenerateOutcome,
  type RequestImagesDeps,
} from './images.ts'
export { MEDIA_GC_AFTER_MS, MEDIA_GC_BATCH, gcOrphanMedia, type MediaGcDeps, type MediaGcResult } from './media-gc.ts'
