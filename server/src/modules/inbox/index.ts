// Module `inbox` (AD-1, AD-9, AD-11, AD-20): chủ DUY NHẤT của khách, định danh, hội thoại, tin, đính kèm và trạng
// thái hội thoại. Public API chỉ export từ file này.
// Gọi: `connections` (token trang), `ai` (Story 4.8), module nền `pages`; được import `adapters/meta`, `adapters/media`.
// Được gọi bởi: `webhooks` (`ingest`), `autoreply` (bước triage), entrypoint (REST, worker).
// Story 4.3: ingest DM (Messenger, IG Direct), giải `triage`, đính kèm vào kho riêng tư, tên khách từ Meta, đọc REST.
export const MODULE = 'inbox'

export { ingestDm, threadLockKey, type IngestDeps, type IngestDmInput, type IngestResult } from './ingest.ts'
export {
  applyTriageDecision,
  getTriageState,
  type ApplyTriageResult,
  type StateDeps,
  type TriageDecision,
  type TriageState,
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
  decodeCursor,
  encodeCursor,
  getConversation,
  listConversations,
  listMessages,
  needsAttention,
  type PageQuery,
  type Paged,
} from './queries.ts'
