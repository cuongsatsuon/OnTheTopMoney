// Module `privacy` (AD-1, AD-22): sở hữu `deletion_requests`, `deletion_request_parts`; điều phối DUY NHẤT của luồng xoá
// dữ liệu. Public API chỉ export từ file này. Chỉ entrypoint gọi module này; module khác báo cho nó qua sự kiện. Phụ thuộc:
// chỉ module nền (`pages`, `settings`). Không import `adapters/meta` (verify `signed_request` tự làm).
// Story 9.1: ghi yêu cầu từ callback Meta + phát `privacy.purge_requested`. Story 9.2: yêu cầu xoá khách / trang gỡ quá 30
// ngày, chống phát lại `signed_request`, điều phối hai giai đoạn (`coordinator.ts`), tiến độ cho trang trạng thái.
export const MODULE = 'privacy'

export {
  SIGNED_REQUEST_ALGORITHM,
  signRequestForTest,
  verifySignedRequest,
  type SignedRequestFailure,
  type SignedRequestResult,
} from './signed-request.ts'
export {
  CONFIRMATION_CODE_RE,
  findMetaReplay,
  getRequestByCode,
  latestTargetRequest,
  metaSubjectHash,
  newConfirmationCode,
  recordMetaRequest,
  requestTargetDeletion,
  type DeletionRequestStatus,
  type DeletionRequestView,
  type RecordMetaRequestInput,
  type RecordMetaRequestResult,
  type TargetDeletionInput,
} from './requests.ts'
export {
  PURGE_STALL_MS,
  REMOVED_PAGE_RETENTION_MS,
  handlePrivacyEvent,
  resumeStalledRequests,
  sweepRemovedPages,
  type CoordinatorDeps,
  type PrivacyEventResult,
  type ResumeResult,
} from './coordinator.ts'

/** Chỉ để test đọc / dọn bảng; không truy vấn trực tiếp ngoài module. */
export { deletionRequestParts as deletionRequestPartsTable, deletionRequests as deletionRequestsTable } from './schema.ts'
