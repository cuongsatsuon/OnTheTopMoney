// Client HTTP tới Meta (AD-6): cổng DUY NHẤT để gọi Graph (Facebook/Instagram) và Threads.
// - Gọi bằng `fetch` (không SDK), hết giờ 30 giây, không retry trong adapter (job tự retry theo `kind`).
// - Trước khi gửi: kiểm ngân sách tần suất theo hạng (`rate.ts`). Sau MỖI phản hồi: ghi usage từ header.
// - Token đi trong query `access_token`, kèm `appsecret_proof` = HMAC-SHA256(token, app secret) khi có secret.
// - Log chỉ path (bỏ query), HTTP status, mã/subcode và fbtrace id; không bao giờ log token, proof, query hay body.
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  abortedFailure,
  classifyMetaError,
  isConnectPhaseError,
  notSentFailure,
  transientFailure,
  APP_LEVEL_RATE_LIMIT_CODES,
  type MetaFailure,
} from './errors.ts'
import {
  DEFAULT_BLOCK_MS,
  GRAPH_APP_SCOPE,
  THREADS_APP_SCOPE,
  createRateLimiter,
  parseUsageHeaders,
  type RateStore,
  type RateTier,
} from './rate.ts'

export const GRAPH_BASE_URL = 'https://graph.facebook.com'
export const DEFAULT_GRAPH_VERSION = 'v26.0'
export const THREADS_BASE_URL = 'https://graph.threads.com'
export const THREADS_API_VERSION = 'v1.0'
export const META_TIMEOUT_MS = 30_000

export type MetaResult<T = unknown> = { ok: true; data: T } | MetaFailure

export type MetaParams = Record<string, string | number | boolean | undefined>

export interface MetaCallOptions {
  /** Access token (Page / user / Threads). Bỏ trống với lời gọi không cần token (vd đổi code lấy token). */
  token?: string
  /** Hạng ưu tiên cho ngân sách tần suất. */
  tier: RateTier
  /** Phạm vi đếm tần suất, vd `page:<pageId>`, `threads:<accountId>`, `app`. */
  scope: string
  /** Tham số query (không đặt `access_token` / `appsecret_proof` ở đây). */
  params?: MetaParams
  /**
   * Gọi path ngay dưới gốc host, không kèm phiên bản — chỉ cho endpoint token mà tài liệu ghi không phiên bản
   * (vd Threads `POST /oauth/access_token`, `GET /access_token`).
   */
  unversioned?: boolean
  signal?: AbortSignal
}

export interface MetaPostOptions extends MetaCallOptions {
  /** Body JSON. */
  body?: Record<string, unknown>
  /**
   * Body `application/x-www-form-urlencoded` (thay `body`) — dùng cho bí mật (client_secret, code) để chúng không
   * nằm trong URL (proxy / APM ghi URL). Bỏ giá trị `undefined`.
   */
  form?: MetaParams
}

export interface MetaClient {
  /** Gốc API kèm phiên bản, vd `https://graph.facebook.com/v26.0`. */
  readonly baseUrl: string
  get<T = unknown>(path: string, options: MetaCallOptions): Promise<MetaResult<T>>
  post<T = unknown>(path: string, options: MetaPostOptions): Promise<MetaResult<T>>
}

/** Logger tối thiểu (pino tương thích). */
export interface MetaLogger {
  warn(obj: Record<string, unknown>, msg: string): void
  debug?(obj: Record<string, unknown>, msg: string): void
}

export interface MetaClientOptions {
  /** Gốc API không kèm phiên bản (`GRAPH_BASE_URL`, `THREADS_BASE_URL`, hoặc server giả trong test). */
  baseUrl: string
  /** Phiên bản API, vd `v26.0` (Graph) hoặc `v1.0` (Threads). */
  version: string
  /** App secret để ký `appsecret_proof` [ASSUMPTION: gửi khi có]. */
  appSecret?: string
  rateStore: RateStore
  fetch?: typeof fetch
  now?: () => Date
  log?: MetaLogger
  timeoutMs?: number
  /**
   * Scope đếm usage/chặn mức app. Graph và Threads là hai app Meta riêng nên mỗi client một scope
   * (`app:graph` mặc định, `app:threads`) — `createGraphClient` / `createThreadsClient` tự đặt.
   */
  appScope?: string
  /** Nguồn ngẫu nhiên cho jitter của hold theo usage (test). */
  random?: () => number
}

/** `appsecret_proof` = HMAC-SHA256 của token với khoá là app secret, dạng hex. */
export function appSecretProof(token: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(token).digest('hex')
}

/** Tiền tố header `X-Hub-Signature-256` của Meta. */
export const WEBHOOK_SIGNATURE_PREFIX = 'sha256='

/**
 * Kiểm chữ ký webhook `X-Hub-Signature-256` (AD-4): HMAC-SHA256 của **raw body** với app secret của đúng app,
 * so sánh constant-time (`timingSafeEqual`). Header dạng `sha256=<hex>`. Thiếu header, sai tiền tố, hex hỏng,
 * sai độ dài hay sai giá trị đều trả `false` — bên gọi trả 401, không ghi gì. Không log chữ ký (AD-12).
 */
export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret || !header || !header.startsWith(WEBHOOK_SIGNATURE_PREFIX)) return false
  const provided = header.slice(WEBHOOK_SIGNATURE_PREFIX.length).trim()
  // Chỉ nhận hex chẵn byte; khác thì Buffer.from bỏ ký tự lạ và lệch độ dài → coi như sai.
  if (provided.length === 0 || provided.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(provided)) return false
  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  const given = Buffer.from(provided, 'hex')
  // timingSafeEqual ném khi khác độ dài → kiểm trước (độ dài không phải bí mật).
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}

/** Path để log: bỏ query/fragment (có thể mang token) — chỉ giữ phần trước `?`/`#`. */
export function loggablePath(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? ''
}

/** Tham số do client tự đặt — caller không được truyền qua `params` hay query của path. */
const RESERVED_PARAMS: ReadonlySet<string> = new Set(['access_token', 'appsecret_proof'])

/** `Retry-After`: số giây hoặc HTTP-date → ms (0 khi không có / hỏng). */
export function parseRetryAfter(raw: string | null, now: Date): number {
  if (!raw) return 0
  const v = raw.trim()
  if (/^\d+$/.test(v)) return Number(v) * 1000
  const at = Date.parse(v)
  return Number.isNaN(at) ? 0 : Math.max(0, at - now.getTime())
}

export function createMetaClient(options: MetaClientOptions): MetaClient {
  const hostRoot = options.baseUrl.replace(/\/+$/, '')
  const root = `${hostRoot}/${options.version.replace(/^\/+|\/+$/g, '')}`
  const rootPath = new URL(root).pathname.replace(/\/+$/, '')
  const hostRootPath = new URL(hostRoot).pathname.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const timeoutMs = options.timeoutMs ?? META_TIMEOUT_MS
  const limiter = createRateLimiter(options.rateStore, { appScope: options.appScope, random: options.random })
  const log = options.log

  /** Lỗi lập trình (không phải lỗi Meta): ném luôn để lộ ra ở test/dev. */
  function buildUrl(path: string, call: MetaCallOptions): string {
    const rawPath = path.split(/[?#]/, 1)[0] ?? ''
    for (const seg of rawPath.split('/')) {
      let decoded = seg
      try {
        decoded = decodeURIComponent(seg)
      } catch {
        // giữ nguyên; URL sẽ tự mã hoá
      }
      if (decoded === '..' || decoded === '.') throw new Error(`meta client: path không được chứa segment "${seg}"`)
    }
    const base = call.unversioned ? hostRoot : root
    const url = new URL(`${base}/${path.replace(/^\/+/, '')}`)
    if (!url.pathname.startsWith(`${call.unversioned ? hostRootPath : rootPath}/`)) throw new Error('meta client: path thoát khỏi gốc phiên bản')
    for (const key of url.searchParams.keys()) {
      if (RESERVED_PARAMS.has(key)) throw new Error(`meta client: không truyền ${key} trong path — dùng options.token`)
    }
    for (const [k, v] of Object.entries(call.params ?? {})) {
      if (RESERVED_PARAMS.has(k)) throw new Error(`meta client: không truyền ${k} trong params — dùng options.token`)
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
    if (call.token) {
      url.searchParams.set('access_token', call.token)
      if (options.appSecret) url.searchParams.set('appsecret_proof', appSecretProof(call.token, options.appSecret))
    }
    return url.toString()
  }

  function fail(path: string, failure: MetaFailure, msg: string): MetaFailure {
    log?.warn(
      {
        metaPath: loggablePath(path),
        status: failure.status,
        kind: failure.kind,
        code: failure.code,
        subcode: failure.subcode,
        fbtraceId: failure.fbtraceId,
        retryAfterMs: failure.retryAfterMs,
      },
      msg,
    )
    return failure
  }

  async function call<T>(method: 'GET' | 'POST', path: string, opts: MetaPostOptions): Promise<MetaResult<T>> {
    const url = buildUrl(path, opts)
    let form: string | undefined
    if (opts.form) {
      const f = new URLSearchParams()
      for (const [k, v] of Object.entries(opts.form)) {
        if (RESERVED_PARAMS.has(k)) throw new Error(`meta client: không truyền ${k} trong form — dùng options.token`)
        if (v !== undefined) f.set(k, String(v))
      }
      form = f.toString()
    }
    if (opts.signal?.aborted) return abortedFailure()

    // 1. Ngân sách tần suất trước khi gửi.
    try {
      const decision = await limiter.checkBudget(opts.scope, opts.tier, now())
      if (!decision.ok) {
        return fail(path, { ok: false, kind: 'RATE_LIMITED', retryAfterMs: decision.retryAfterMs, notSent: true }, `meta call held: rate budget (${decision.reason})`)
      }
    } catch {
      return fail(path, notSentFailure(), 'meta rate store unavailable')
    }

    // 2. Gửi.
    const timer = AbortSignal.timeout(timeoutMs)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timer]) : timer
    let res: Response
    try {
      res = await doFetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(method === 'POST' && form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(method === 'POST' && !form && opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' && form ? { body: form } : method === 'POST' && opts.body ? { body: JSON.stringify(opts.body) } : {}),
        signal,
      })
    } catch (err) {
      // Caller huỷ → ABORTED (không cảnh báo). Lỗi mạng / hết giờ: không giữ lỗi gốc (mang URL có token). Chỉ lỗi ở pha
      // mở kết nối mới chắc chắn chưa gửi (`notSent`) — hết giờ / đứt giữa chừng có thể Meta đã nhận.
      if (opts.signal?.aborted) return abortedFailure()
      if (isConnectPhaseError(err)) return fail(path, notSentFailure(), 'meta call failed: connect error')
      return fail(path, transientFailure(), 'meta call failed: network or timeout')
    }

    // 3. Ghi usage từ header TRƯỚC khi đọc body (đọc body lỗi vẫn giữ được usage; store lỗi → bỏ qua).
    const at = now()
    let regainMs = 0
    try {
      regainMs = await limiter.recordUsage(opts.scope, parseUsageHeaders(res.headers), at)
    } catch {
      log?.warn({ metaPath: loggablePath(path) }, 'meta rate usage not recorded')
    }

    let text: string
    try {
      text = await res.text()
    } catch {
      if (opts.signal?.aborted) return abortedFailure()
      return fail(path, transientFailure(res.status), 'meta call failed: body read error')
    }

    if (res.status === 204) return { ok: true, data: undefined as T }

    let body: unknown
    let parsed = text !== ''
    try {
      body = parsed ? JSON.parse(text) : undefined
    } catch {
      parsed = false
    }

    const errorField = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
    const hasError = typeof errorField === 'object' && errorField !== null
    if (res.ok && parsed && !hasError) {
      log?.debug?.({ metaPath: loggablePath(path), status: res.status }, 'meta call ok')
      return { ok: true, data: body as T }
    }
    // 2xx mà body rỗng / không phải JSON → coi như lỗi tạm thời phía Meta.
    if (res.ok && !parsed) return fail(path, transientFailure(res.status), 'meta call failed: empty or unreadable body')

    // 4. Phân loại lỗi.
    const failure = classifyMetaError(res.status, body)
    if (failure.kind === 'RATE_LIMITED') {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'), at)
      failure.retryAfterMs = regainMs > 0 ? regainMs : retryAfter > 0 ? retryAfter : DEFAULT_BLOCK_MS
      const blockScope =
        failure.code !== undefined && APP_LEVEL_RATE_LIMIT_CODES.has(failure.code) ? limiter.appScope : opts.scope
      try {
        await limiter.recordBlock(blockScope, failure.retryAfterMs, at)
      } catch {
        log?.warn({ metaPath: loggablePath(path) }, 'meta rate block not recorded')
      }
    }
    return fail(path, failure, 'meta call failed')
  }

  return {
    baseUrl: root,
    get: (path, opts) => call('GET', path, opts),
    post: (path, opts) => call('POST', path, opts),
  }
}

type ClientDeps = Omit<MetaClientOptions, 'baseUrl' | 'version' | 'appScope'> & { baseUrl?: string }

/** Client Graph (Facebook Page + Instagram qua Facebook Login), pin `META_GRAPH_VERSION`; scope app `app:graph`. */
export function createGraphClient(deps: ClientDeps & { version?: string }): MetaClient {
  return createMetaClient({
    ...deps,
    baseUrl: deps.baseUrl ?? GRAPH_BASE_URL,
    version: deps.version ?? DEFAULT_GRAPH_VERSION,
    appScope: GRAPH_APP_SCOPE,
  })
}

/** Client Threads (`graph.threads.com/v1.0`); `appSecret` là Threads app secret; scope app `app:threads`. */
export function createThreadsClient(deps: ClientDeps): MetaClient {
  return createMetaClient({ ...deps, baseUrl: deps.baseUrl ?? THREADS_BASE_URL, version: THREADS_API_VERSION, appScope: THREADS_APP_SCOPE })
}
