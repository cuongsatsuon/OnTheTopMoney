// Module `connections` (AD-1, AD-5, AD-6, AD-23): sở hữu `meta_rate_state` (Story 2.1), `page_credentials`,
// `oauth_states`, `oauth_results`, `meta_accounts` (Story 2.2); OAuth Threads dùng chung các bảng này (Story 2.3). Public API chỉ export từ file này.
// Story 4.2: đăng ký webhook trang (job `connections.subscribe_page`) + lỗi đăng ký cho API sức khoẻ của `webhooks`.
// Story 8.1: `grantedScopes` — quyền đã cấp theo trang (analytics kiểm quyền insight trước khi gọi Meta).
// Story 9.1: `isKnownMetaUser`, `disconnectMetaUserTx` — callback gỡ app của Meta. Story 9.2: xoá `meta_accounts` theo yêu cầu.
// Phụ thuộc: chỉ module nền (`pages`); được import `adapters/meta`. Chỉ module này giữ token trang và gọi
// `pages.upsertFromPlatform` / `pages.setConnectionStatus`.
export const MODULE = 'connections'

export { createRateStore } from './rate-store.ts'
export {
  createMetaClients,
  type CreateMetaClientsDeps,
  type MetaClients,
  type MetaClientsConfig,
} from './meta-clients.ts'
export type { ConnectionsConfig, ConnectionsDeps, ConnectionsLogger } from './deps.ts'
export {
  FACEBOOK_CALLBACK_PATH,
  FACEBOOK_FAKE_CONSENT_PATH,
  OAUTH_TTL_MS,
  PROVIDER_PARAM,
  RETURN_PATHS,
  STATE_INVALID_LOCATION,
  THREADS_CALLBACK_PATH,
  THREADS_FAKE_CONSENT_PATH,
  cleanupExpiredOAuth,
  deleteOAuthForSession,
  errorLocation,
  facebookRedirectUri,
  getOAuthResult,
  handleFacebookCallback,
  handleThreadsCallback,
  startFacebookOAuth,
  startThreadsOAuth,
  threadsRedirectUri,
  webLocation,
  type CallbackQuery,
} from './oauth.ts'
export { confirmConnections } from './confirm.ts'
export {
  PAGE_SUBSCRIBED_FIELDS,
  SubscribeRetryableError,
  enqueueMissingSubscriptions,
  handleSubscribeJob,
  listSubscriptionErrors,
  parseSubscribeJobData,
  recordSubscribeError,
  subscribePage,
  subscribedFieldsFor,
  type SubscribeJobHandlerDeps,
  type SubscribeOutcome,
  type SubscribePageDeps,
} from './subscribe.ts'
export { getAccessToken, grantedScopes, removePage, tokenOwnerPageId } from './credentials.ts'
// Story 9.1: người dùng Meta gỡ app (callback deauthorize của `privacy`, ghép ở entrypoint).
// Story 9.2: phạm vi xoá `scope=all` của người dùng + phần `connections` của luồng xoá (xoá `meta_accounts`).
export { REASON_META_DEAUTHORIZED, disconnectMetaUserTx, isKnownMetaUser, metaUserPurgeScope } from './deauthorize.ts'
// Story 9.4: người dùng gỡ Threads app / xin xoá dữ liệu (callback của `privacy` cho Threads app, ghép ở entrypoint).
export { REASON_THREADS_DEAUTHORIZED, disconnectThreadsUserTx, threadsUserPurgeScope } from './threads-deauthorize.ts'
export { handleConnectionsPurge, type ConnectionsPurgeDeps } from './purge.ts'
export { FAKE_CODE, FAKE_THREADS_CODE } from './fake-meta.ts'
export {
  computeConnectionStatus,
  effectiveExpiry,
  markDisconnected,
  markDisconnectedTx,
  REASON_TOKEN_SOURCE_REMOVED,
  runTokenCheck,
  EXPIRING_WINDOW_S,
  THREADS_MIN_AGE_S,
  THREADS_REFRESH_WINDOW_S,
  type TokenCheckDeps,
} from './token-check.ts'
