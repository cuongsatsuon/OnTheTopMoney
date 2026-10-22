// Module `connections` (AD-1, AD-5, AD-6, AD-23): sở hữu `meta_rate_state` (Story 2.1), `page_credentials`,
// `oauth_states`, `oauth_results`, `meta_accounts` (Story 2.2); OAuth Threads dùng chung các bảng này (Story 2.3). Public API chỉ export từ file này.
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
export { getAccessToken, removePage } from './credentials.ts'
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
