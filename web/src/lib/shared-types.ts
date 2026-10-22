// Hợp đồng chung với server (packages/shared). Chỉ re-export kiểu — không thêm mã chạy vào bundle.
// Bản đồ ErrorCode → microcopy: src/lib/error-messages.ts.
export type { ErrorCode, ErrorBody, ErrorResponse } from '@ottm/shared'
