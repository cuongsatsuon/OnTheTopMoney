// Kết nối Facebook Fanpage + Instagram Business (Story 2.2) và Threads (Story 2.3) — AD-5, AD-23.
// Token không bao giờ có trong hợp đồng: FE chỉ nhận `resultId` (qua URL) rồi đọc danh sách ứng viên.
import { z } from 'zod'
import { ConnectionStatus, Platform } from './enums.ts'
import { ErrorCode } from './errors.ts'

const IsoDateTime = z.iso.datetime({ offset: false })

/**
 * Quyền xin trong hộp thoại Meta (Facebook Login for Business), phần Facebook/Instagram của epic 2.
 * Dùng "Instagram API with Facebook Login" (Page token) — không dùng `instagram_business_*`.
 */
export const META_LOGIN_SCOPES = [
  'pages_show_list',
  'business_management',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_engagement',
  'pages_manage_posts',
  'read_insights',
  'instagram_basic',
  'instagram_manage_messages',
  'instagram_manage_comments',
  'instagram_content_publish',
  'instagram_manage_insights',
] as const

/** Quyền bắt buộc cho mỗi Fanpage (đọc từ `granular_scopes` theo id trang). */
export const PAGE_REQUIRED_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_engagement',
] as const

/** Quyền bắt buộc thêm cho tài khoản Instagram Business (theo id IG; token lấy từ Fanpage nguồn). */
export const INSTAGRAM_REQUIRED_SCOPES = [
  'instagram_basic',
  'instagram_manage_messages',
  'instagram_manage_comments',
  'instagram_content_publish',
] as const

/**
 * Quyền xin trong cửa sổ đồng ý của Threads (OAuth riêng, app Threads). Cả năm đều bắt buộc: thiếu quyền nào
 * thì tài khoản Threads không chọn được (`PERMISSIONS_MISSING`).
 */
export const THREADS_LOGIN_SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_read_replies',
  'threads_manage_replies',
  'threads_manage_insights',
] as const
export const THREADS_REQUIRED_SCOPES = THREADS_LOGIN_SCOPES

/** Nhà cung cấp OAuth: `facebook` (Fanpage + IG qua Facebook Login for Business) hoặc `threads` (OAuth riêng). */
export const OAUTH_PROVIDERS = ['facebook', 'threads'] as const
export const OAuthProvider = z.enum(OAUTH_PROVIDERS)
export type OAuthProvider = z.infer<typeof OAuthProvider>

/**
 * Tham số URL callback đặt khi chuyển về app (`?ket-noi=<id>&nen-tang=threads`, `?ket-noi-loi=<mã>&nen-tang=…`):
 * nền tảng của luồng; thiếu = `facebook`. FE dùng cho "Thử lại" và câu lỗi đúng nền tảng.
 */
export const CONNECT_PROVIDER_PARAM = 'nen-tang'

/**
 * Số Fanpage tối đa đọc từ `/me/accounts` trong một lần kết nối (10 trang kết quả × 100). Vượt quá → kết quả
 * có `truncated: true` (FE báo "Chỉ hiện 1.000 trang đầu").
 */
export const OAUTH_MAX_PAGES = 1000
/** Mỗi Fanpage tối đa một IG liên kết → số ứng viên tối đa. */
export const OAUTH_MAX_CANDIDATES = OAUTH_MAX_PAGES * 2

/** Nơi bắt đầu luồng kết nối — callback đưa chủ shop về đúng màn đó (Trang & Nhóm, Màn chào, Cài đặt). */
export const CONNECT_FROM = ['pages', 'welcome', 'settings'] as const
export const ConnectFrom = z.enum(CONNECT_FROM)
export type ConnectFrom = z.infer<typeof ConnectFrom>

/**
 * Body của `POST /api/v1/connections/{facebook|threads}/start`. `pageId` (Story 2.4) = kết nối lại: luồng OAuth
 * mang `intent=reconnect:<pageId>` và `auth_type=reauthorize`, callback cập nhật đúng dòng trang đó. Thiếu `pageId`
 * = kết nối mới (`intent=connect`).
 */
export const StartConnectRequest = z.object({ from: ConnectFrom.default('pages'), pageId: z.uuid().optional() }).strict()
export type StartConnectRequest = z.input<typeof StartConnectRequest>
export const StartFacebookConnectRequest = StartConnectRequest
export type StartFacebookConnectRequest = StartConnectRequest
export const StartThreadsConnectRequest = StartConnectRequest
export type StartThreadsConnectRequest = StartConnectRequest

/** URL hộp thoại Meta (hoặc trang đồng ý giả khi `META_FAKE=1`) — FE chuyển hướng toàn trang tới đó. */
export const StartConnectResponse = z.object({ url: z.string().min(1) })
export type StartConnectResponse = z.infer<typeof StartConnectResponse>

/** Lý do ứng viên không chọn được. */
export const CANDIDATE_LOCK_REASONS = ['PERMISSIONS_MISSING', 'IG_NOT_BUSINESS'] as const
export const CandidateLockReason = z.enum(CANDIDATE_LOCK_REASONS)
export type CandidateLockReason = z.infer<typeof CandidateLockReason>

/** Một Fanpage, tài khoản IG liên kết hoặc tài khoản Threads mà chủ shop có thể chọn. */
export const OAuthCandidate = z.object({
  /** Id trên nền tảng (Page id / IG user id / Threads user id). */
  accountId: z.string().min(1),
  platform: Platform,
  name: z.string(),
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /** IG: id Fanpage mà tài khoản này liên kết (token đi theo Fanpage đó). */
  linkedToAccountId: z.string().min(1).optional(),
  selectable: z.boolean(),
  /** Quyền bắt buộc còn thiếu cho riêng ứng viên này. */
  missing: z.array(z.string()),
  reason: CandidateLockReason.optional(),
})
export type OAuthCandidate = z.infer<typeof OAuthCandidate>

export const OAUTH_RESULT_STATUSES = ['ok', 'error'] as const
export const OAuthResultStatus = z.enum(OAUTH_RESULT_STATUSES)
export type OAuthResultStatus = z.infer<typeof OAuthResultStatus>

export const OAuthResultResponse = z.object({
  /** Luồng đã tạo kết quả — FE chọn tiêu đề, modal thiếu quyền và "Thử lại" theo nền tảng. */
  provider: OAuthProvider,
  status: OAuthResultStatus,
  candidates: z.array(OAuthCandidate),
  /** Khi `status: 'error'`: `OAUTH_CANCELLED`, `OAUTH_FAILED`, `RATE_LIMITED`, `PERMISSION_DENIED`, `INTERNAL`… */
  errorCode: ErrorCode.optional(),
  /** `true` khi tài khoản có hơn `OAUTH_MAX_PAGES` Fanpage — chỉ hiện phần đầu. */
  truncated: z.boolean(),
})
export type OAuthResultResponse = z.infer<typeof OAuthResultResponse>

export const ConfirmConnectionsRequest = z
  .object({
    resultId: z.uuid(),
    accountIds: z.array(z.string().min(1).max(64)).min(1).max(OAUTH_MAX_CANDIDATES),
  })
  .strict()
export type ConfirmConnectionsRequest = z.infer<typeof ConfirmConnectionsRequest>

/** Trang đã kết nối (chưa gỡ). `autoReply`/`brandSource`/nhóm do read-model của story sau ghép. */
export const PageDto = z.object({
  id: z.uuid(),
  platform: Platform,
  name: z.string(),
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  connectionStatus: ConnectionStatus,
  connectedAt: IsoDateTime,
})
export type PageDto = z.infer<typeof PageDto>

export const ListPagesResponse = z.object({ items: z.array(PageDto) })
export type ListPagesResponse = z.infer<typeof ListPagesResponse>

export const ConfirmConnectionsResponse = z.object({
  /** Trang vừa tạo hoặc khôi phục, theo thứ tự xử lý (Fanpage trước IG liên kết; Threads riêng). */
  pages: z.array(PageDto),
})
export type ConfirmConnectionsResponse = z.infer<typeof ConfirmConnectionsResponse>
