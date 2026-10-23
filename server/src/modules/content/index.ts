// Module `content` (AD-1, AD-13, AD-14 — Story 6.1): sở hữu `posts`, `post_targets`, `media_assets`,
// `post_target_media`. Public API chỉ export từ file này.
// Gọi `pages` (base), `profiles` (nhận dạng ảnh; hồ sơ hiệu lực — 6.2), `ai` (caption 6.2, ảnh 6.3), `connections` (6.4);
// được `campaigns`, `analytics` gọi (bảng mũi tên AD-1).
export const MODULE = 'content'

// Bài + đích từng trang: một cửa tạo (AD-13), sửa nháp, đọc.
export { createPost, getPost, updateDraftPost, type CreatePostInput } from './posts.ts'
// Luật nền tảng phía server (cùng bảng `packages/shared` với FE) — gọi trước mọi chuyển tới `scheduled`.
export { assertPublishable } from './publishable.ts'
// Lên lịch và đăng (Story 6.4, AD-13): chuyển trạng thái do chủ shop bấm; job `publish.target`; cron `content.requeue`.
export { transitionPostTargets, transitionTarget, type TargetTransition, type TransitionDeps } from './transitions.ts'
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
export { COMPOSE_CONCURRENCY, composeCaptions, type ComposeDeps } from './compose.ts'
// Sinh ảnh AI (Story 6.3, AD-14): yêu cầu 4 ô + job `content.image.generate`; cron dọn ảnh không gắn bài.
export {
  ImageGenerateRetryableError,
  generateImageAsset,
  handleImageGenerateJob,
  listGeneratedImages,
  requestImageGeneration,
  type ImageGenerateDeps,
  type ImageGenerateOutcome,
  type RequestImagesDeps,
} from './images.ts'
export { MEDIA_GC_AFTER_MS, MEDIA_GC_BATCH, gcOrphanMedia, type MediaGcDeps, type MediaGcResult } from './media-gc.ts'
