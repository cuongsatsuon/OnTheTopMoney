// Module `privacy` (AD-1, AD-22): sở hữu `deletion_requests`, điều phối DUY NHẤT của luồng xoá dữ liệu. Public API chỉ
// export từ file này. Chỉ entrypoint gọi module này; module khác báo cho nó qua sự kiện. Phụ thuộc: chỉ module nền
// (`pages`, `settings`) — Story 9.1 chưa gọi module nào. Không import `adapters/meta` (verify `signed_request` tự làm).
// Story 9.1: ghi yêu cầu từ callback Meta + phát `privacy.purge_requested`; xoá thật + đóng yêu cầu ở Story 9.2.
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
  getRequestByCode,
  metaSubjectHash,
  newConfirmationCode,
  recordMetaRequest,
  type DeletionRequestView,
  type RecordMetaRequestInput,
  type RecordMetaRequestResult,
} from './requests.ts'

/** Chỉ để test đọc / dọn bảng; không truy vấn trực tiếp ngoài module. */
export { deletionRequests as deletionRequestsTable } from './schema.ts'
