// Adapter Meta (AD-6): cổng DUY NHẤT tới Meta (Graph cho Facebook/Instagram, Threads).
// Chỉ `modules/{connections,inbox,content,analytics,webhooks}` được import (luật `ad6-meta-adapter-only`).
// Fake cho test: `./fake.ts` (import trực tiếp từ test, không export ở đây).
export {
  DEFAULT_GRAPH_VERSION,
  GRAPH_BASE_URL,
  META_TIMEOUT_MS,
  THREADS_API_VERSION,
  THREADS_BASE_URL,
  WEBHOOK_SIGNATURE_PREFIX,
  appSecretProof,
  createGraphClient,
  createMetaClient,
  createThreadsClient,
  loggablePath,
  parseRetryAfter,
  verifyWebhookSignature,
  type MetaCallOptions,
  type MetaClient,
  type MetaClientOptions,
  type MetaLogger,
  type MetaParams,
  type MetaPostOptions,
  type MetaResult,
} from './client.ts'
export {
  META_ERROR_KINDS,
  classifyMetaError,
  isRetryable,
  type MetaErrorKind,
  type MetaFailure,
} from './errors.ts'
export {
  GRAPH_APP_SCOPE,
  THREADS_APP_SCOPE,
  RATE_TIERS,
  TIER_THRESHOLD_PCT,
  createMemoryRateStore,
  type RateBucketState,
  type RateStore,
  type RateTier,
} from './rate.ts'
export {
  normalizeWebhookPostId,
  publishedRefFromFacebook,
  publishedRefFromInstagram,
  publishedRefFromThreads,
  type PublishedRef,
} from './normalize.ts'
