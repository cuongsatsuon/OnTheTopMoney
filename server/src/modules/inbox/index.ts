// Module `inbox` (AD-1, AD-9, AD-11, AD-20): chủ DUY NHẤT của khách, định danh, hội thoại, tin, đính kèm và trạng
// thái hội thoại. Public API chỉ export từ file này.
// Gọi: `connections` (token trang), `ai` (Story 4.8), module nền `pages`; được import `adapters/meta`, `adapters/media`.
// Được gọi bởi: `webhooks` (`ingest`), `autoreply` (bước triage), entrypoint (REST, worker).
// Story 4.3: ingest DM (Messenger, IG Direct), giải `triage`, đính kèm vào kho riêng tư, tên khách từ Meta, đọc REST.
// Story 4.4: ingest bình luận FB/IG + trả lời Threads, sửa/xoá/ẩn tin, caption bài được bình luận.
// Story 4.6: lọc/đếm theo tab ở server, lệnh Tiếp quản / bật lại AI / Đánh dấu xong.
// Story 4.7: `canSend` (cửa sổ gửi), gửi / gửi lại từ Hộp thư, job `inbox.send`, cron dọn tin kẹt `sending`.
// Story 4.5: tin của chính trang (echo) — khớp tin app đã gửi / `app_unmatched` / `external_human`, job
// `inbox.echo_match`; "đã nhận / đã xem" của tin outbound.
// Story 4.8: Gợi ý bằng AI — bản nháp trả lời theo hồ sơ hiệu lực (bên gọi truyền vào) + tin gần nhất, qua `ai`.
// Story 4.9: khách hàng — danh sách theo phạm vi, hồ sơ (thẻ, giai đoạn, ghi chú, SĐT), lịch sử nhiều trang, gộp khách
// bằng tay + gợi ý gộp từ nhắn riêng, tóm tắt AI bằng job `inbox.contact_summary`. Trường dẫn xuất (`pageIds`,
// `handledBy`) ghép ở `app/read-models/contacts.ts`.
// Story 4.10: `searchContacts` — tìm khách không dấu / theo SĐT cho ⌘K; `/api/v1/search` ghép ở `app/read-models/search.ts`.
export const MODULE = 'inbox'

export {
  bulkUpdateContacts,
  contactActivity,
  contactFacets,
  getContact,
  listContactMessages,
  listContacts,
  listMergeSuggestions,
  mergeContacts,
  searchContacts,
  suggestMerge,
  updateContact,
  type BulkContactOp,
  type ContactActivity,
  type ContactFacets,
  type ContactListQuery,
  type ContactPatch,
  type ContactRecord,
  type ContactSearchHit,
  type ContactsDeps,
  type MergeResult,
} from './contacts.ts'
export {
  ContactSummaryRetryableError,
  SUMMARY_CONTEXT_MESSAGES,
  SUMMARY_TEXT_MAX,
  aiSummaryStatusOf,
  handleContactSummaryJob,
  parseContactSummaryJobData,
  requestContactSummary,
  summarizeContact,
  type ContactSummaryDeps,
  type RequestSummaryDeps,
  type RequestSummaryResult,
  type SummaryOutcome,
} from './contact-summary.ts'

export {
  ECHO_MATCH_ATTEMPTS,
  ECHO_MATCH_DELAY_MS,
  ECHO_MATCH_WINDOW_MS,
  EchoUnmatchedError,
  echoAuthor,
  echoFromComment,
  echoFromDm,
  echoJobData,
  handleEchoMatchJob,
  ingestEcho,
  markOutboundReceipt,
  parseEchoMatchJobData,
  type EchoAttempt,
  type EchoDeps,
  type EchoInput,
  type EchoMessage,
  type EchoResult,
  type ReceiptInput,
  type ReceiptResult,
} from './echo.ts'

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
  SUGGEST_CONTEXT_MESSAGES,
  SUGGEST_TEXT_MAX,
  replyTurns,
  suggestKind,
  suggestReply,
  type SuggestBrand,
  type SuggestDeps,
  type SuggestInput,
  type SuggestResult,
} from './suggest.ts'
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
