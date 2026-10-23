// Module `inbox` (AD-1, AD-9, AD-11, AD-20): chủ DUY NHẤT của khách, định danh, hội thoại, tin, đính kèm và trạng
// thái hội thoại. Public API chỉ export từ file này.
// Gọi: `connections` (token trang), `ai` (Story 4.8), module nền `pages`; được import `adapters/meta`, `adapters/media`.
// Được gọi bởi: `webhooks` (`ingest`), `autoreply` (bước triage), entrypoint (REST, worker).
// Story 4.3: ingest DM (Messenger, IG Direct), giải `triage`, đính kèm vào kho riêng tư, tên khách từ Meta, đọc REST.
// Story 4.4: ingest bình luận FB/IG + trả lời Threads, sửa/xoá/ẩn tin, caption bài được bình luận.
// Story 4.6: lọc/đếm theo tab ở server, lệnh Tiếp quản / bật lại AI / Đánh dấu xong.
// Story 4.7: `canSend` (cửa sổ gửi), gửi / gửi lại từ Hộp thư, job `inbox.send`, cron dọn tin kẹt `sending`.
export const MODULE = 'inbox'

export {
  ingestComment,
  ingestDm,
  threadLockKey,
  type IngestCommentInput,
  type IngestDeps,
  type IngestDmInput,
  type IngestResult,
} from './ingest.ts'
export { markMessageRemoved, markMessageUnhidden, updateMessageText, type EditDeps, type EditResult } from './edits.ts'
export {
  POST_TEXT_MAX,
  PostTextRetryableError,
  fetchPostText,
  handleFetchPostTextJob,
  parseFetchPostTextJobData,
  postTextFromGraph,
  type FetchPostTextDeps,
  type FetchPostTextOutcome,
} from './post-text.ts'
export {
  DM_WINDOW_MS,
  PRIVATE_REPLY_WINDOW_MS,
  RATE_LIMIT_DEFER_MAX_MS,
  SENDING_STUCK_MS,
  SendRetryableError,
  canSend,
  deliverMessage,
  handleSendJob,
  parseSendJobData,
  resendMessage,
  sendErrorOf,
  sendMessage,
  sweepStuckSending,
  type CanSendOptions,
  type DeliverDeps,
  type DeliverOutcome,
  type ResendResult,
  type SendCheck,
  type SendDeps,
  type SendInput,
  type SendResult,
} from './send.ts'
export {
  applyHumanReply,
  applyTriageDecision,
  applyUserAction,
  getTriageState,
  type ApplyTriageResult,
  type StateDeps,
  type TriageDecision,
  type TriageState,
  type UserActionResult,
} from './state.ts'
export {
  AttachmentRetryableError,
  allowedMime,
  fetchAttachment,
  getAttachmentFile,
  handleFetchAttachmentJob,
  parseFetchAttachmentJobData,
  type AttachmentFileResult,
  type FetchAttachmentDeps,
  type FetchAttachmentOutcome,
} from './attachments.ts'
export {
  ProfileRetryableError,
  fetchProfile,
  handleFetchProfileJob,
  parseFetchProfileJobData,
  profileFromGraph,
  type FetchProfileDeps,
  type FetchProfileOutcome,
} from './profile.ts'
export {
  countConversations,
  decodeCursor,
  encodeCursor,
  getConversation,
  getMessage,
  listConversations,
  listMessages,
  needsAttention,
  tabCondition,
  type ConversationPageQuery,
  type PageQuery,
  type Paged,
} from './queries.ts'
