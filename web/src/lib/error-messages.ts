// Bản đồ ErrorCode → microcopy: chỗ DUY NHẤT trong web/ đổi mã lỗi thành câu hiển thị (AD-18).
// `Record<ErrorCode, string>` → thêm mã mới ở packages/shared mà quên ở đây thì typecheck đỏ.
// Giọng: ngắn, động từ đi đầu, xưng "bạn", không lộ mã kỹ thuật (EXPERIENCE.md › Voice and Tone).
import type { ErrorCode, OAuthProvider } from '@ottm/shared'

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  // Chung
  INTERNAL: 'Có lỗi xảy ra. Thử lại sau ít phút.',
  VALIDATION_FAILED: 'Thông tin chưa hợp lệ. Kiểm tra lại các ô đã nhập.',
  NOT_FOUND: 'Không tìm thấy mục này. Có thể nó đã bị xoá.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết. Đăng nhập lại để tiếp tục.',
  FORBIDDEN: 'Yêu cầu bị chặn. Tải lại trang rồi thử lại.',
  VERSION_CONFLICT: 'Dữ liệu vừa được thay đổi ở nơi khác. Tải lại để xem bản mới nhất.',
  RATE_LIMITED: 'Thử lại sau ít phút.',
  NETWORK_ERROR: 'Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.',
  // Đăng nhập
  INVALID_CREDENTIALS: 'Mật khẩu không đúng.',
  // Kết nối Meta / OAuth
  PAGE_DISCONNECTED: 'Trang đã mất kết nối. Kết nối lại để tiếp tục.',
  PAGE_REMOVED: 'Trang này đã bị gỡ khỏi app.',
  PERMISSION_DENIED: 'Tài khoản chưa có quyền với trang này. Kiểm tra vai trò quản trị trên Facebook.',
  PERMISSIONS_MISSING: 'Còn thiếu quyền cần thiết. Kết nối lại và chọn đủ quyền.',
  IG_NOT_BUSINESS: 'Tài khoản Instagram chưa phải Business. Chuyển sang Business rồi kết nối lại.',
  OAUTH_CANCELLED: 'Bạn đã huỷ kết nối. Thử lại khi sẵn sàng.',
  OAUTH_STATE_INVALID: 'Phiên kết nối đã hết hạn hoặc không hợp lệ. Bấm Kết nối để thử lại.',
  OAUTH_FAILED: 'Không hoàn tất được đăng nhập Meta. Thử lại.',
  META_NOT_CONFIGURED: 'Máy chủ chưa cấu hình app Meta nên chưa kết nối được. Đặt META_APP_ID và META_APP_SECRET (hoặc META_FAKE=1 khi dev) rồi thử lại.',
  // Gửi tin
  OUTSIDE_24H: 'Đã quá 24 giờ kể từ tin cuối của khách. Chờ khách nhắn lại để trả lời.',
  PRIVATE_REPLY_USED: 'Bình luận này đã được nhắn riêng một lần.',
  PRIVATE_REPLY_INVALID: 'Không thể nhắn riêng cho bình luận này.',
  RECIPIENT_UNAVAILABLE: 'Không gửi được tới người này. Họ có thể đã chặn trang.',
  SEND_REJECTED: 'Nền tảng từ chối tin nhắn. Sửa nội dung rồi gửi lại.',
  SEND_FAILED: 'Gửi chưa được. Thử gửi lại.',
  SEND_UNKNOWN: 'Chưa rõ tin đã gửi hay chưa. Kiểm tra hội thoại trước khi gửi lại.',
  // Đăng bài
  MEDIA_REQUIRED: 'Thêm ít nhất một ảnh hoặc video cho nền tảng này.',
  CAPTION_TOO_LONG: 'Nội dung quá dài cho nền tảng này. Rút gọn bớt.',
  TOO_MANY_HASHTAGS: 'Quá nhiều hashtag. Bớt hashtag rồi thử lại.',
  PUBLISH_LIMIT_REACHED: 'Trang đã chạm giới hạn đăng bài hôm nay. Lên lịch sang ngày khác.',
  SCHEDULE_IN_PAST: 'Thời gian đăng đã qua. Chọn thời điểm khác.',
  PUBLISH_REJECTED: 'Nền tảng từ chối bài viết. Sửa nội dung rồi đăng lại.',
  PUBLISH_FAILED: 'Đăng bài chưa được. Thử đăng lại.',
  PUBLISH_UNKNOWN: 'Chưa rõ bài đã lên hay chưa. Kiểm tra trang trước khi đăng lại.',
  // Ảnh
  IMAGE_REJECTED: 'Ảnh bị từ chối. Thử ảnh khác.',
  IMAGE_FAILED: 'Tạo ảnh chưa được. Thử lại.',
  MEDIA_NOT_CONFIGURED: 'Chưa cấu hình kho ảnh (Cloudinary) nên chưa lưu được ảnh/file. Xem hướng dẫn cài đặt.',
  UPLOAD_FAILED: 'Tải file lên chưa được. Thử lại sau ít phút.',
  // AI
  OPENAI_KEY_MISSING: 'Thêm khoá OpenAI ở Cài đặt để dùng AI.',
  OPENAI_KEY_INVALID: 'Khoá OpenAI không hợp lệ. Cập nhật khoá ở Cài đặt.',
  OPENAI_KEY_RESTRICTED: 'OpenAI từ chối quyền của khoá này (quyền hạn hoặc khu vực). Kiểm tra quyền của khoá rồi thử lại.',
  ENCRYPTION_NOT_CONFIGURED: 'Máy chủ chưa có khoá mã hoá nên chưa lưu được khoá. Đặt APP_ENCRYPTION_KEYS hoặc chạy bằng `npm run dev` rồi thử lại.',
  AI_BUDGET_EXCEEDED: 'Đã dùng hết hạn mức AI tháng này. Tăng hạn mức ở Cài đặt.',
  AI_PROVIDER_ERROR: 'AI đang gặp sự cố. Thử lại sau ít phút.',
  AI_POLICY_BLOCKED: 'AI không tạo được nội dung này. Thử diễn đạt khác.',
  CONFIG_MISSING: 'Còn thiếu cấu hình. Hoàn tất cài đặt rồi thử lại.',
  KNOWLEDGE_TOO_LARGE: 'Kho kiến thức vượt giới hạn. Xoá bớt mục hoặc rút gọn tài liệu rồi thử lại.',
}

const FALLBACK = ERROR_MESSAGES.INTERNAL

/**
 * Câu riêng của luồng kết nối Threads (Story 2.3) cho các mã nhắc tên nền tảng / biến cấu hình; mã khác dùng câu
 * chung. Facebook dùng câu chung (`ERROR_MESSAGES`).
 */
const PROVIDER_MESSAGES: Record<OAuthProvider, Partial<Record<ErrorCode, string>>> = {
  facebook: {},
  threads: {
    OAUTH_FAILED: 'Không hoàn tất được đăng nhập Threads. Thử lại.',
    META_NOT_CONFIGURED:
      'Máy chủ chưa cấu hình app Threads nên chưa kết nối được. Đặt THREADS_APP_ID và THREADS_APP_SECRET (hoặc META_FAKE=1 khi dev) rồi thử lại.',
    PERMISSION_DENIED: 'Tài khoản Threads chưa cấp quyền cần thiết. Kết nối lại và giữ nguyên mọi quyền.',
  },
}

/** Câu tiếng Việt cho một mã lỗi (theo nền tảng kết nối khi có); mã lạ (vd server mới hơn web) → câu chung. */
export function errorMessage(code: string | null | undefined, provider?: OAuthProvider): string {
  if (code && Object.hasOwn(ERROR_MESSAGES, code)) {
    return (provider && PROVIDER_MESSAGES[provider][code as ErrorCode]) || ERROR_MESSAGES[code as ErrorCode]
  }
  return FALLBACK
}

/**
 * `AI_BUDGET_EXCEEDED` khi tháng chưa hết hạn mức (`details.remainingVnd > 0`) nhưng phần còn lại không đủ cho
 * ước tính của thao tác → câu riêng; hết hẳn → câu chung của mã.
 */
export function budgetExceededMessage(details: unknown): string {
  const remaining = typeof details === 'object' && details !== null ? (details as { remainingVnd?: unknown }).remainingVnd : undefined
  if (typeof remaining === 'number' && remaining > 0) {
    return `Hạn mức AI còn lại không đủ cho thao tác này (còn ${remaining.toLocaleString('vi-VN')}đ) — Tăng hạn mức ở Cài đặt.`
  }
  return ERROR_MESSAGES.AI_BUDGET_EXCEEDED
}

/** Câu cho lỗi bất kỳ ném từ `apiFetch` (lỗi không phải ApiError → câu chung); `provider` cho luồng kết nối. */
export function errorMessageOf(err: unknown, provider?: OAuthProvider): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : undefined
  if (code === 'AI_BUDGET_EXCEEDED') return budgetExceededMessage((err as { details?: unknown }).details)
  return errorMessage(typeof code === 'string' ? code : undefined, provider)
}
