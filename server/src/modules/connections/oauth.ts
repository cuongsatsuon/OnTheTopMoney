// OAuth "Facebook Login for Business" (Story 2.2, AD-23).
// 1. `startFacebookOAuth`: `state` ngẫu nhiên lưu ở `oauth_states` (TTL 15 phút) cùng id phiên → URL hộp thoại
//    Meta (hoặc trang đồng ý giả khi `META_FAKE=1`).
// 2. `handleFacebookCallback`: chỉ nhận khi `state` còn hạn VÀ thuộc phiên của cookie (không khớp → không đổi
//    `code`). Đổi code → user token ngắn → dài hạn (`fb_exchange_token`), `debug_token` lấy `granular_scopes`,
//    `/me/accounts` lấy Fanpage + token Page + IG liên kết → ứng viên vào `oauth_results` (TTL 15 phút) → URL
//    chuyển hướng về màn chọn trang. Token chỉ ở server, dạng envelope.
// 3. `getOAuthResult`: bản đã lọc token cho FE; chỉ chủ phiên đọc được.
// Threads (Story 2.3) dùng lại cùng khung (`oauth_states.provider = 'threads'`, `oauth_results`, xác nhận):
// `startThreadsOAuth` → `threads.com/oauth/authorize`; `handleThreadsCallback` bỏ `#_` khỏi `code`, đổi token ngắn
// (`POST /oauth/access_token`) → dài hạn 60 ngày (`th_exchange_token`), `debug_token` (app token `TH|id|secret`)
// lấy `scopes` + kiểm `app_id`, `/me` lấy hồ sơ → một ứng viên Threads. Không có `meta_accounts`.
import { randomBytes } from 'node:crypto'
import {
  META_LOGIN_SCOPES,
  OAUTH_MAX_PAGES,
  THREADS_LOGIN_SCOPES,
  CONNECT_PROVIDER_PARAM,
  type ConnectFrom,
  type ErrorCode,
  type OAuthProvider,
  type OAuthResultResponse,
} from '@ottm/shared'
import { and, eq, gt, lte } from 'drizzle-orm'
import type { MetaClient, MetaFailure } from '../../adapters/meta/index.ts'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import {
  buildCandidates,
  buildThreadsCandidate,
  toPublicCandidate,
  type GranularScope,
  type MetaPageAccount,
  type StoredCandidate,
  type ThreadsProfile,
} from './candidates.ts'
import type { ConnectionsConfig, ConnectionsDeps } from './deps.ts'
import { FAKE_APP_ID, FAKE_APP_SECRET, FAKE_THREADS_APP_ID, FAKE_THREADS_APP_SECRET } from './fake-meta.ts'
import { metaAccounts, oauthResults, oauthStates } from './schema.ts'

export const OAUTH_TTL_MS = 15 * 60_000
export const FACEBOOK_CALLBACK_PATH = '/oauth/facebook/callback'
export const FACEBOOK_FAKE_CONSENT_PATH = '/oauth/facebook/fake-consent'
export const THREADS_CALLBACK_PATH = '/oauth/threads/callback'
export const THREADS_FAKE_CONSENT_PATH = '/oauth/threads/fake-consent'
/** Cửa sổ đồng ý của Threads (tài liệu Threads, kiểm 2026-10-22). */
export const THREADS_AUTHORIZE_URL = 'https://threads.com/oauth/authorize'
/** Màn đưa chủ shop về sau callback. */
export const RETURN_PATHS: Record<ConnectFrom, string> = { pages: '/trang-nhom', welcome: '/bat-dau', settings: '/cai-dat' }
/** Tham số URL chuyển hướng cho biết nền tảng (chỉ Threads; thiếu = Facebook) — FE dùng cho "Thử lại" khi kết quả đã hết hạn. */
export const PROVIDER_PARAM = CONNECT_PROVIDER_PARAM
/** Lỗi trước khi biết màn gốc (state lạ / hết hạn / khác phiên) → luôn về Trang & Nhóm (đường dẫn trên host web). */
export const STATE_INVALID_LOCATION = `${RETURN_PATHS.pages}?ket-noi-loi=OAUTH_STATE_INVALID`

/**
 * URL tuyệt đối trên host web: web (Hostinger) và api (VPS) có thể khác host, nên mọi chuyển hướng về app sau
 * callback ở host api đều mang `WEB_BASE_URL`. `path` là đường dẫn tương đối (`/trang-nhom?…`).
 */
export function webLocation(config: Pick<ConnectionsConfig, 'WEB_BASE_URL'>, path: string): string {
  return `${config.WEB_BASE_URL}${path}`
}

/** Trường Fanpage xin qua `/me/accounts` (IG chưa chuyên nghiệp chỉ lấy id — các trường khác bị hạn chế). */
export const PAGE_ACCOUNT_FIELDS = [
  'id',
  'name',
  'username',
  'access_token',
  'picture{url}',
  'instagram_business_account{id,username,name,profile_picture_url}',
  'connected_instagram_account',
].join(',')
/** Fanpage mỗi lần gọi `/me/accounts`; số lần gọi tối đa = `OAUTH_MAX_PAGES / ACCOUNTS_PAGE_SIZE`. */
export const ACCOUNTS_PAGE_SIZE = 100
const MAX_ACCOUNT_CALLS = Math.ceil(OAUTH_MAX_PAGES / ACCOUNTS_PAGE_SIZE)
/** User token dài hạn khi Meta không cho biết hạn: coi như 60 ngày (hạn chuẩn của token dài hạn). */
const DEFAULT_USER_TOKEN_TTL_S = 60 * 86_400

const nowOf = (deps: Pick<ConnectionsDeps, 'now'>) => deps.now?.() ?? new Date()

export function facebookRedirectUri(config: Pick<ConnectionsConfig, 'PUBLIC_BASE_URL'>): string {
  return `${config.PUBLIC_BASE_URL}${FACEBOOK_CALLBACK_PATH}`
}

export function threadsRedirectUri(config: Pick<ConnectionsConfig, 'PUBLIC_BASE_URL'>): string {
  return `${config.PUBLIC_BASE_URL}${THREADS_CALLBACK_PATH}`
}

/** Thông tin app để đổi token; fake → giá trị giả (không cần app Meta). `null` → chưa cấu hình. */
function appCredentials(config: ConnectionsConfig): { appId: string; appSecret: string } | null {
  if (config.META_FAKE) return { appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET }
  if (!config.META_APP_ID || !config.META_APP_SECRET) return null
  return { appId: config.META_APP_ID, appSecret: config.META_APP_SECRET }
}

/** App Threads + client Threads; fake → giá trị giả. `null` → chưa cấu hình (`META_NOT_CONFIGURED`). */
function threadsApp(deps: Pick<ConnectionsDeps, 'config' | 'threads'>): { appId: string; appSecret: string; client: MetaClient } | null {
  const { config, threads } = deps
  if (!threads) return null
  if (config.META_FAKE) return { appId: FAKE_THREADS_APP_ID, appSecret: FAKE_THREADS_APP_SECRET, client: threads }
  if (!config.THREADS_APP_ID || !config.THREADS_APP_SECRET) return null
  return { appId: config.THREADS_APP_ID, appSecret: config.THREADS_APP_SECRET, client: threads }
}

/**
 * Dọn `oauth_states` / `oauth_results` hết hạn (gọi mỗi lần đọc/ghi và từ cron `connections.oauth_gc`).
 * Trả số dòng đã xoá.
 */
export async function cleanupExpiredOAuth(db: DbExecutor, now: Date = new Date()): Promise<number> {
  const states = await db.delete(oauthStates).where(lte(oauthStates.expiresAt, now)).returning({ s: oauthStates.state })
  const results = await db.delete(oauthResults).where(lte(oauthResults.expiresAt, now)).returning({ id: oauthResults.id })
  return states.length + results.length
}

/** Đăng xuất: xoá state và kết quả OAuth (chứa envelope token Page) của phiên. */
export async function deleteOAuthForSession(db: DbExecutor, sessionId: string): Promise<void> {
  await db.delete(oauthStates).where(eq(oauthStates.sessionId, sessionId))
  await db.delete(oauthResults).where(eq(oauthResults.sessionId, sessionId))
}

/** `state` ngẫu nhiên (dùng một lần, TTL 15 phút) gắn với phiên, nền tảng và màn gốc. */
async function createState(deps: ConnectionsDeps, provider: OAuthProvider, input: { sessionId: string; from: ConnectFrom }): Promise<string> {
  if (!deps.cipher) throw new AppError('ENCRYPTION_NOT_CONFIGURED', 500, { message: 'APP_ENCRYPTION_KEYS chưa đặt' })
  const now = nowOf(deps)
  const state = randomBytes(32).toString('base64url')
  await cleanupExpiredOAuth(deps.db, now)
  await deps.db.insert(oauthStates).values({
    state,
    provider,
    sessionId: input.sessionId,
    intent: 'connect',
    returnTo: input.from,
    expiresAt: new Date(now.getTime() + OAUTH_TTL_MS),
  })
  return state
}

export async function startFacebookOAuth(
  deps: ConnectionsDeps,
  input: { sessionId: string; from: ConnectFrom },
): Promise<{ url: string }> {
  const app = appCredentials(deps.config)
  if (!app) throw new AppError('META_NOT_CONFIGURED', 500, { message: 'META_APP_ID / META_APP_SECRET chưa đặt' })
  const state = await createState(deps, 'facebook', input)

  // Trang đồng ý giả nằm ở host api (web có thể ở host khác) → URL tuyệt đối.
  if (deps.config.META_FAKE) return { url: `${deps.config.PUBLIC_BASE_URL}${FACEBOOK_FAKE_CONSENT_PATH}?${new URLSearchParams({ state })}` }

  const url = new URL(`https://www.facebook.com/${deps.config.META_GRAPH_VERSION}/dialog/oauth`)
  url.searchParams.set('client_id', app.appId)
  url.searchParams.set('redirect_uri', facebookRedirectUri(deps.config))
  url.searchParams.set('state', state)
  url.searchParams.set('response_type', 'code')
  if (deps.config.META_LOGIN_CONFIG_ID) url.searchParams.set('config_id', deps.config.META_LOGIN_CONFIG_ID)
  else url.searchParams.set('scope', META_LOGIN_SCOPES.join(','))
  return { url: url.toString() }
}

/** Bắt đầu OAuth Threads (app Threads riêng). Thiếu cặp `THREADS_APP_ID/SECRET` và không bật giả → `META_NOT_CONFIGURED`. */
export async function startThreadsOAuth(
  deps: ConnectionsDeps,
  input: { sessionId: string; from: ConnectFrom },
): Promise<{ url: string }> {
  const app = threadsApp(deps)
  if (!app) throw new AppError('META_NOT_CONFIGURED', 500, { message: 'THREADS_APP_ID / THREADS_APP_SECRET chưa đặt' })
  const state = await createState(deps, 'threads', input)

  if (deps.config.META_FAKE) return { url: `${deps.config.PUBLIC_BASE_URL}${THREADS_FAKE_CONSENT_PATH}?${new URLSearchParams({ state })}` }

  const url = new URL(THREADS_AUTHORIZE_URL)
  url.searchParams.set('client_id', app.appId)
  url.searchParams.set('redirect_uri', threadsRedirectUri(deps.config))
  url.searchParams.set('scope', THREADS_LOGIN_SCOPES.join(','))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  return { url: url.toString() }
}

export interface CallbackQuery {
  code?: string | undefined
  state?: string | undefined
  error?: string | undefined
}

type CollectOutcome =
  | { status: 'ok'; candidates: StoredCandidate[]; metaAccountId: string | null; truncated: boolean }
  | { status: 'error'; errorCode: ErrorCode }

type Collector = (deps: ConnectionsDeps, code: string, now: Date) => Promise<CollectOutcome>

/**
 * Xử lý callback Facebook; trả URL tuyệt đối trên host web (`WEB_BASE_URL`) để chuyển hướng (không bao giờ chứa
 * token hay code).
 * `sessionId` = phiên của cookie trình duyệt (null khi chưa đăng nhập).
 */
export function handleFacebookCallback(
  deps: ConnectionsDeps,
  input: { sessionId: string | null; query: CallbackQuery },
): Promise<{ location: string }> {
  return handleCallback(deps, 'facebook', input, collectCandidates)
}

/** Xử lý callback Threads (cùng khung với Facebook; `state` phải là state của luồng Threads). */
export function handleThreadsCallback(
  deps: ConnectionsDeps,
  input: { sessionId: string | null; query: CallbackQuery },
): Promise<{ location: string }> {
  return handleCallback(deps, 'threads', input, collectThreadsCandidates)
}

/** URL đưa chủ shop về màn gốc kèm id kết quả (Threads thêm `nen-tang=threads`). */
function resultLocation(provider: OAuthProvider, returnTo: ConnectFrom, resultId: string): string {
  const params = new URLSearchParams({ 'ket-noi': resultId })
  if (provider !== 'facebook') params.set(PROVIDER_PARAM, provider)
  return `${RETURN_PATHS[returnTo]}?${params}`
}

/** URL báo lỗi về màn gốc (`?ket-noi-loi=<mã>`, Threads thêm `nen-tang=threads`). */
export function errorLocation(provider: OAuthProvider, returnTo: ConnectFrom, code: ErrorCode): string {
  const params = new URLSearchParams({ 'ket-noi-loi': code })
  if (provider !== 'facebook') params.set(PROVIDER_PARAM, provider)
  return `${RETURN_PATHS[returnTo]}?${params}`
}

async function handleCallback(
  deps: ConnectionsDeps,
  provider: OAuthProvider,
  input: { sessionId: string | null; query: CallbackQuery },
  collect: Collector,
): Promise<{ location: string }> {
  const path = await callbackPath(deps, provider, input, collect)
  return { location: webLocation(deps.config, path) }
}

/** Đường dẫn (tương đối, trên host web) của màn đưa chủ shop về sau callback. */
async function callbackPath(
  deps: ConnectionsDeps,
  provider: OAuthProvider,
  input: { sessionId: string | null; query: CallbackQuery },
  collect: Collector,
): Promise<string> {
  const { sessionId, query } = input
  const now = nowOf(deps)
  if (!sessionId || !query.state || query.state.length > 200) return STATE_INVALID_LOCATION

  // Dùng một lần: chỉ xoá (và nhận) khi state còn hạn, thuộc đúng phiên VÀ đúng luồng — khác phiên thì state
  // giữ nguyên; state của luồng Facebook không dùng được ở callback Threads (và ngược lại).
  const [row] = await deps.db
    .delete(oauthStates)
    .where(
      and(
        eq(oauthStates.state, query.state),
        eq(oauthStates.sessionId, sessionId),
        eq(oauthStates.provider, provider),
        gt(oauthStates.expiresAt, now),
      ),
    )
    .returning()
  if (!row) {
    deps.log?.warn({ provider }, 'OAuth callback: state lạ, hết hạn hoặc khác phiên — bỏ qua code')
    return STATE_INVALID_LOCATION
  }
  const returnTo = (row.returnTo as ConnectFrom) in RETURN_PATHS ? (row.returnTo as ConnectFrom) : 'pages'

  let outcome: CollectOutcome
  if (query.error) {
    outcome = { status: 'error', errorCode: query.error === 'access_denied' ? 'OAUTH_CANCELLED' : 'OAUTH_FAILED' }
  } else if (!query.code) {
    outcome = { status: 'error', errorCode: 'OAUTH_FAILED' }
  } else {
    try {
      outcome = await collect(deps, query.code, now)
    } catch (err) {
      // State đã dùng: vẫn ghi kết quả lỗi để FE (đúng màn gốc) hiện "Thử lại". Chỉ log tên lỗi (không URL/code/token).
      deps.log?.warn({ provider, errName: err instanceof Error ? err.name : typeof err }, 'OAuth callback: lỗi khi đổi token')
      outcome = { status: 'error', errorCode: 'INTERNAL' }
    }
  }

  // Lưu kết quả lỗi bất ngờ (vd DB) → vẫn về đúng màn gốc + nền tảng, báo INTERNAL.
  let resultId: string
  try {
    resultId = await saveResult(deps, { provider, sessionId, returnTo, outcome, now })
  } catch (err) {
    deps.log?.warn({ provider, errName: err instanceof Error ? err.name : typeof err }, 'OAuth callback: không lưu được kết quả')
    return errorLocation(provider, returnTo, 'INTERNAL')
  }
  deps.log?.info(
    {
      provider,
      resultId,
      status: outcome.status,
      ...(outcome.status === 'ok' ? { candidates: outcome.candidates.length } : { errorCode: outcome.errorCode }),
    },
    'OAuth callback xong',
  )
  return resultLocation(provider, returnTo, resultId)
}

async function saveResult(
  deps: ConnectionsDeps,
  input: { provider: OAuthProvider; sessionId: string; returnTo: ConnectFrom; outcome: CollectOutcome; now: Date },
): Promise<string> {
  const { provider, sessionId, returnTo, outcome, now } = input
  await cleanupExpiredOAuth(deps.db, now)
  const [result] = await deps.db
    .insert(oauthResults)
    .values({
      provider,
      sessionId,
      returnTo,
      status: outcome.status,
      errorCode: outcome.status === 'error' ? outcome.errorCode : null,
      metaAccountId: outcome.status === 'ok' ? outcome.metaAccountId : null,
      candidates: outcome.status === 'ok' ? outcome.candidates : [],
      truncated: outcome.status === 'ok' && outcome.truncated,
      expiresAt: new Date(now.getTime() + OAUTH_TTL_MS),
    })
    .returning({ id: oauthResults.id })
  return result!.id
}

function errorCodeOf(failure: MetaFailure): ErrorCode {
  // 100 khi đổi token: code hết hạn / đã dùng / redirect_uri lệch → đăng nhập lại.
  if (failure.code === 100) return 'OAUTH_FAILED'
  switch (failure.kind) {
    case 'RATE_LIMITED':
      return 'RATE_LIMITED'
    case 'PERMISSION_DENIED':
      return 'PERMISSION_DENIED'
    default:
      return 'INTERNAL'
  }
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
}

interface DebugTokenResponse {
  data?: {
    app_id?: string
    type?: string
    is_valid?: boolean
    user_id?: string
    scopes?: string[]
    expires_at?: number
    data_access_expires_at?: number
    granular_scopes?: GranularScope[]
  }
}

interface AccountsResponse {
  data?: MetaPageAccount[]
  paging?: { cursors?: { after?: string }; next?: string }
}

/** Đổi code → token dài hạn → quyền theo trang → Fanpage + IG. Lỗi Meta → `{status:'error'}` (đã log loại lỗi). */
async function collectCandidates(deps: ConnectionsDeps, code: string, now: Date): Promise<CollectOutcome> {
  const { graph, cipher, config } = deps
  const app = appCredentials(config)
  if (!app) return { status: 'error', errorCode: 'META_NOT_CONFIGURED' }
  if (!cipher) return { status: 'error', errorCode: 'ENCRYPTION_NOT_CONFIGURED' }
  const fail = (step: string, failure: MetaFailure): CollectOutcome => {
    deps.log?.warn({ provider: 'facebook', step, kind: failure.kind, code: failure.code, subcode: failure.subcode }, 'OAuth: Meta trả lỗi')
    return { status: 'error', errorCode: errorCodeOf(failure) }
  }
  const invalid = (step: string): CollectOutcome => {
    deps.log?.warn({ provider: 'facebook', step }, 'OAuth: phản hồi Meta thiếu trường cần thiết')
    return { status: 'error', errorCode: 'INTERNAL' }
  }
  const call = { tier: 'interactive' as const, scope: 'oauth:facebook' }

  const short = await graph.get<TokenResponse>('/oauth/access_token', {
    ...call,
    params: { client_id: app.appId, client_secret: app.appSecret, redirect_uri: facebookRedirectUri(config), code },
  })
  if (!short.ok) return fail('code_exchange', short)
  if (!short.data.access_token) return invalid('code_exchange')

  const long = await graph.get<TokenResponse>('/oauth/access_token', {
    ...call,
    params: {
      grant_type: 'fb_exchange_token',
      client_id: app.appId,
      client_secret: app.appSecret,
      fb_exchange_token: short.data.access_token,
    },
  })
  if (!long.ok) return fail('long_lived_exchange', long)
  const userToken = long.data.access_token
  if (!userToken) return invalid('long_lived_exchange')

  const debug = await graph.get<DebugTokenResponse>('/debug_token', {
    ...call,
    token: `${app.appId}|${app.appSecret}`,
    params: { input_token: userToken },
  })
  if (!debug.ok) return fail('debug_token', debug)
  const info = debug.data.data
  if (!info?.is_valid || !info.user_id) return invalid('debug_token')
  // Token phải là user token của CHÍNH app này (chặn token cấp cho app khác / page token / app token).
  if (String(info.app_id) !== app.appId || info.type !== 'USER') {
    deps.log?.warn({ provider: 'facebook', step: 'debug_token', type: info.type ?? null }, 'OAuth: token không phải user token của app')
    return { status: 'error', errorCode: 'OAUTH_FAILED' }
  }
  // Không có `granular_scopes` → dùng `scopes` (quyền cấp chung, không giới hạn theo trang).
  const granular: GranularScope[] = Array.isArray(info.granular_scopes)
    ? info.granular_scopes
    : Array.isArray(info.scopes)
      ? info.scopes.map((scope) => ({ scope }))
      : []
  const userCall = { tier: 'interactive' as const, scope: `user:${info.user_id}`, token: userToken }

  const me = await graph.get<{ id?: string; name?: string }>('/me', { ...userCall, params: { fields: 'id,name' } })
  if (!me.ok) return fail('me', me)

  const accounts: MetaPageAccount[] = []
  let after: string | undefined
  for (let i = 0; i < MAX_ACCOUNT_CALLS; i++) {
    const res = await graph.get<AccountsResponse>('/me/accounts', {
      ...userCall,
      params: { fields: PAGE_ACCOUNT_FIELDS, limit: ACCOUNTS_PAGE_SIZE, ...(after ? { after } : {}) },
    })
    if (!res.ok) return fail('me_accounts', res)
    accounts.push(...(res.data.data ?? []))
    after = res.data.paging?.next ? res.data.paging.cursors?.after : undefined
    if (!after) break
  }
  // Còn trang sau khi đã đọc đủ giới hạn → cắt bớt, báo FE.
  const truncated = after !== undefined || accounts.length > OAUTH_MAX_PAGES
  if (truncated) {
    deps.log?.warn({ provider: 'facebook', limit: OAUTH_MAX_PAGES }, 'OAuth: tài khoản có quá nhiều Fanpage — chỉ giữ phần đầu')
    accounts.length = Math.min(accounts.length, OAUTH_MAX_PAGES)
  }

  // Mốc hết hạn kiểu Meta (giây epoch, 0 = không hết hạn). Thiếu trong debug_token → suy từ expires_in.
  const nowSec = Math.floor(now.getTime() / 1000)
  const userExpiresAt =
    typeof info.expires_at === 'number'
      ? info.expires_at
      : long.data.expires_in
        ? nowSec + long.data.expires_in
        : nowSec + DEFAULT_USER_TOKEN_TTL_S
  const dataAccessExpiresAt = typeof info.data_access_expires_at === 'number' ? info.data_access_expires_at : null

  const encrypt = (token: string) => cipher.encrypt(token)
  const candidates = buildCandidates(accounts, granular, encrypt).map((c) => ({ ...c, dataAccessExpiresAt }))

  const values = {
    fbUserId: info.user_id,
    name: me.data.name ?? null,
    userToken: encrypt(userToken),
    expiresAt: userExpiresAt,
    dataAccessExpiresAt,
    granularScopes: granular,
  }
  const [account] = await deps.db
    .insert(metaAccounts)
    .values(values)
    .onConflictDoUpdate({ target: metaAccounts.fbUserId, set: { ...values, updatedAt: now } })
    .returning({ id: metaAccounts.id })
  return { status: 'ok', candidates, metaAccountId: account!.id, truncated }
}

// ---------------------------------------------------------------------------------------------------------
// Threads (Story 2.3)
// ---------------------------------------------------------------------------------------------------------

interface ThreadsTokenResponse {
  access_token?: string
  /** Có thể là số JSON lớn (mất chính xác) → id tài khoản lấy từ `/me` (chuỗi). */
  user_id?: string | number
  expires_in?: number
}

interface ThreadsDebugTokenResponse {
  data?: {
    app_id?: string | number
    type?: string
    is_valid?: boolean
    user_id?: string | number
    scopes?: string[]
    expires_at?: number
  }
}

export const THREADS_PROFILE_FIELDS = 'id,username,name,threads_profile_picture_url'
/** Threads có thể nối `#_` vào `code` — phải bỏ trước khi đổi mã. */
export const stripThreadsCodeSuffix = (code: string): string => (code.endsWith('#_') ? code.slice(0, -2) : code)

/**
 * Đổi code Threads → token ngắn → token dài hạn (~60 ngày) → quyền (`debug_token`, kiểm `app_id`) → hồ sơ.
 * Lỗi đổi mã (hết hạn / đã dùng / redirect lệch) → `OAUTH_FAILED`; token của app khác → `OAUTH_FAILED`.
 */
async function collectThreadsCandidates(deps: ConnectionsDeps, rawCode: string, now: Date): Promise<CollectOutcome> {
  const app = threadsApp(deps)
  if (!app) return { status: 'error', errorCode: 'META_NOT_CONFIGURED' }
  const { cipher, config } = deps
  if (!cipher) return { status: 'error', errorCode: 'ENCRYPTION_NOT_CONFIGURED' }
  const { client } = app
  const fail = (step: string, failure: MetaFailure, errorCode: ErrorCode = errorCodeOf(failure)): CollectOutcome => {
    deps.log?.warn({ provider: 'threads', step, kind: failure.kind, code: failure.code, subcode: failure.subcode }, 'OAuth: Threads trả lỗi')
    return { status: 'error', errorCode }
  }
  const invalid = (step: string): CollectOutcome => {
    deps.log?.warn({ provider: 'threads', step }, 'OAuth: phản hồi Threads thiếu trường cần thiết')
    return { status: 'error', errorCode: 'INTERNAL' }
  }
  const call = { tier: 'interactive' as const, scope: 'oauth:threads' }

  const short = await client.post<ThreadsTokenResponse>('/oauth/access_token', {
    ...call,
    unversioned: true,
    // Form body: client_secret và code không nằm trong URL (proxy / APM ghi URL).
    form: {
      client_id: app.appId,
      client_secret: app.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: threadsRedirectUri(config),
      code: stripThreadsCodeSuffix(rawCode),
    },
  })
  // Mã hết hạn / đã dùng / redirect_uri lệch → đăng nhập lại; chỉ giữ RATE_LIMITED.
  if (!short.ok) return fail('code_exchange', short, short.kind === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'OAUTH_FAILED')
  if (!short.data.access_token) return invalid('code_exchange')

  const long = await client.get<ThreadsTokenResponse>('/access_token', {
    ...call,
    unversioned: true,
    token: short.data.access_token,
    params: { grant_type: 'th_exchange_token', client_secret: app.appSecret },
  })
  if (!long.ok) return fail('long_lived_exchange', long)
  const longToken = long.data.access_token
  if (!longToken) return invalid('long_lived_exchange')

  const debug = await client.get<ThreadsDebugTokenResponse>('/debug_token', {
    ...call,
    token: `TH|${app.appId}|${app.appSecret}`,
    params: { input_token: longToken },
  })
  if (!debug.ok) return fail('debug_token', debug)
  const info = debug.data.data
  if (!info) return invalid('debug_token')
  // Token phải còn hiệu lực (`is_valid === true`), là user token (khi có `type`) và do CHÍNH app Threads này cấp.
  if (info.is_valid !== true || (info.type !== undefined && info.type !== 'USER') || String(info.app_id) !== app.appId) {
    deps.log?.warn(
      { provider: 'threads', step: 'debug_token', valid: info.is_valid ?? null, type: info.type ?? null },
      'OAuth: token Threads không thuộc app hoặc không hợp lệ',
    )
    return { status: 'error', errorCode: 'OAUTH_FAILED' }
  }

  const me = await client.get<ThreadsProfile>('/me', { ...call, token: longToken, params: { fields: THREADS_PROFILE_FIELDS } })
  if (!me.ok) return fail('me', me)
  const debugUserId = info.user_id === undefined || info.user_id === null ? null : String(info.user_id)
  const accountId = me.data.id ? String(me.data.id) : debugUserId
  if (!accountId) return invalid('me')
  // `debug_token` nói token thuộc người khác hồ sơ vừa đọc → không tin (so dạng chuỗi, mọi kiểu JSON).
  if (debugUserId !== null && debugUserId !== accountId) {
    deps.log?.warn({ provider: 'threads', step: 'me' }, 'OAuth: hồ sơ Threads không khớp chủ token')
    return { status: 'error', errorCode: 'OAUTH_FAILED' }
  }

  // Hạn token dài hạn = now + expires_in (thiếu → mốc của debug_token, rồi 60 ngày). Làm tròn xuống: cột bigint.
  const nowSec = Math.floor(now.getTime() / 1000)
  const tokenExpiresAt = Math.floor(
    typeof long.data.expires_in === 'number' && long.data.expires_in > 0
      ? nowSec + long.data.expires_in
      : typeof info.expires_at === 'number' && info.expires_at > 0
        ? info.expires_at
        : nowSec + DEFAULT_USER_TOKEN_TTL_S,
  )
  const candidate = buildThreadsCandidate({
    accountId,
    profile: me.data,
    grantedScopes: Array.isArray(info.scopes) ? info.scopes : null,
    tokenEnvelope: cipher.encrypt(longToken),
    tokenExpiresAt,
  })
  return { status: 'ok', candidates: [candidate], metaAccountId: null, truncated: false }
}

/** Kết quả callback cho FE (đã lọc token). Hết hạn / không thuộc phiên → 404. */
export async function getOAuthResult(
  deps: Pick<ConnectionsDeps, 'db' | 'now'>,
  input: { sessionId: string; resultId: string },
): Promise<OAuthResultResponse> {
  const now = nowOf(deps)
  await cleanupExpiredOAuth(deps.db, now)
  const [row] = await deps.db
    .select()
    .from(oauthResults)
    .where(and(eq(oauthResults.id, input.resultId), eq(oauthResults.sessionId, input.sessionId), gt(oauthResults.expiresAt, now)))
  if (!row) throw new AppError('NOT_FOUND', 404, { message: 'Kết quả kết nối không tồn tại hoặc đã hết hạn' })
  const candidates = (row.candidates as StoredCandidate[]).map(toPublicCandidate)
  return {
    provider: row.provider as OAuthProvider,
    status: row.status as OAuthResultResponse['status'],
    candidates,
    ...(row.errorCode ? { errorCode: row.errorCode as ErrorCode } : {}),
    truncated: row.truncated,
  }
}
