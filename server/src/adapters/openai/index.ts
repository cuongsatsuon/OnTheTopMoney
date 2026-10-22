// Adapter OpenAI (AD-7): chỉ `modules/ai` gọi. Trả lỗi đã phân loại, không ném lỗi thô, không log,
// và không bao giờ đưa khoá, prompt hay nội dung trả về vào thông báo lỗi (AD-12).
// - `checkKey` (Story 1.5): `GET /v1/models`.
// - `createResponse` (Story 1.6): Responses API, `store: false`.
// - `generateImage` (Story 1.6): Images API, ảnh JPEG trả về dạng base64.
// Gọi bằng `fetch` (không dùng SDK) để test trỏ được về server giả và lỗi luôn đi qua `classifyStatus`.

/** Phân loại lỗi OpenAI (Technical Decisions › Lỗi OpenAI). */
// KEY_RESTRICTED (403): khoá có thật nhưng thiếu quyền (vd models:read) hoặc bị chặn theo khu vực.
// INVALID_REQUEST (400/404/422 khác nội dung bị chặn: tham số sai, quá dài, model không có): lỗi cố định, KHÔNG retry.
export const OPENAI_ERROR_KINDS = [
  'KEY_INVALID',
  'KEY_RESTRICTED',
  'PROVIDER_QUOTA',
  'RATE_LIMITED',
  'CONTENT_REJECTED',
  'INVALID_REQUEST',
  'TRANSIENT',
] as const
export type OpenAiErrorKind = (typeof OPENAI_ERROR_KINDS)[number]

export interface OpenAiFailure {
  ok: false
  kind: OpenAiErrorKind
  /** HTTP status của OpenAI; không có khi lỗi mạng hoặc hết giờ. */
  status?: number
  /**
   * Request có thể đã tới OpenAI và bị tính tiền (hết giờ / đứt kết nối sau khi gửi, 200 mà body hỏng).
   * Không có / false = chắc chắn không tính tiền (OpenAI trả mã lỗi HTTP, hoặc không kết nối được).
   */
  maybeBilled?: boolean
}

/** Caller huỷ (`AbortSignal`) — đã gửi abort sang OpenAI. Khác hết giờ (hết giờ = `TRANSIENT`). */
export interface OpenAiAborted {
  ok: false
  kind: 'ABORTED'
  /** true khi đã gửi request trước lúc huỷ (OpenAI có thể đã tính tiền); false khi huỷ trước khi gửi. */
  maybeBilled?: boolean
}

export type CheckKeyResult = { ok: true } | OpenAiFailure

/** Số token OpenAI tính tiền (cached nằm trong `inputTokens`). */
export interface OpenAiTokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export type ResponseInputMessage = { role: 'user' | 'assistant' | 'system' | 'developer'; content: string }

export interface CreateResponseRequest {
  apiKey: string
  model: string
  instructions?: string
  input: string | readonly ResponseInputMessage[]
  maxOutputTokens: number
  signal?: AbortSignal
}

export type CreateResponseResult =
  | {
      ok: true
      id: string
      text: string
      usage: OpenAiTokenUsage
      /**
       * Phản hồi không trọn: `max_output_tokens` (vẫn có chữ), `content_filter`, hoặc `refusal` (model từ chối).
       * Token vẫn bị tính tiền.
       */
      incomplete: 'max_output_tokens' | 'content_filter' | 'refusal' | null
    }
  | OpenAiFailure
  | OpenAiAborted

export interface GenerateImageRequest {
  apiKey: string
  model: string
  prompt: string
  n: number
  size: string
  signal?: AbortSignal
}

export type GenerateImageResult =
  | {
      ok: true
      /** Ảnh JPEG đã giải base64, theo thứ tự OpenAI trả. */
      images: Buffer[]
      /** `null` khi Images API không trả `usage` → gateway tính theo giá mỗi ảnh. */
      usage: OpenAiTokenUsage | null
    }
  | OpenAiFailure
  | OpenAiAborted

export interface OpenAiAdapter {
  /** Kiểm khoá bằng `GET /v1/models` (không tốn token). */
  checkKey(apiKey: string): Promise<CheckKeyResult>
  /** `POST /v1/responses` với `store: false`. */
  createResponse(request: CreateResponseRequest): Promise<CreateResponseResult>
  /** `POST /v1/images/generations`, `output_format: jpeg`. */
  generateImage(request: GenerateImageRequest): Promise<GenerateImageResult>
}

export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const CHECK_KEY_TIMEOUT_MS = 10_000
/** Hết giờ của lời gọi sinh chữ / ảnh [ASSUMPTION] — luôn dưới 15 phút (tuổi chỗ giữ bị dọn). */
export const RESPONSE_TIMEOUT_MS = 120_000
export const IMAGE_TIMEOUT_MS = 180_000

export interface OpenAiAdapterOptions {
  /** Gốc API (test trỏ về server giả). */
  baseUrl?: string
  /** Hết giờ của `checkKey`. */
  timeoutMs?: number
  responseTimeoutMs?: number
  imageTimeoutMs?: number
  fetch?: typeof fetch
}

/** Mã lỗi OpenAI cho nội dung bị từ chối (Images: `moderation_blocked`, cũ: `content_policy_violation`). */
const CONTENT_REJECTED_CODES = new Set(['content_policy_violation', 'moderation_blocked', 'content_filter'])

/** Phân loại phản hồi lỗi HTTP. `code` = `error.code` trong body JSON của OpenAI (nếu có). */
export function classifyStatus(status: number, code?: string): OpenAiErrorKind {
  if (status === 401) return 'KEY_INVALID'
  if (status === 403) return 'KEY_RESTRICTED'
  if (status === 429) return code === 'insufficient_quota' ? 'PROVIDER_QUOTA' : 'RATE_LIMITED'
  if (status === 400 && code !== undefined && CONTENT_REJECTED_CODES.has(code)) return 'CONTENT_REJECTED'
  if (status === 400 || status === 404 || status === 422) return 'INVALID_REQUEST'
  return 'TRANSIENT'
}

async function errorCodeOf(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } }
    return typeof body?.error?.code === 'string' ? body.error.code : undefined
  } catch {
    return undefined
  }
}

/** Lỗi trước khi request rời máy (không kết nối / không phân giải được tên) → chắc chắn chưa tính tiền. */
const CONNECT_FAILURE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])
function isConnectFailure(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } })?.cause?.code
  return typeof code === 'string' && CONNECT_FAILURE_CODES.has(code)
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)

/** `usage` của Responses / Images API → số token; thiếu hẳn → `null`. */
export function parseUsage(raw: unknown): OpenAiTokenUsage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const u = raw as { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown } }
  if (u.input_tokens === undefined && u.output_tokens === undefined) return null
  const inputTokens = int(u.input_tokens)
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, int(u.input_tokens_details?.cached_tokens)),
    outputTokens: int(u.output_tokens),
  }
}

type ResponseBody = {
  id?: unknown
  status?: unknown
  incomplete_details?: { reason?: unknown } | null
  output?: { type?: unknown; content?: { type?: unknown; text?: unknown }[] }[]
  usage?: unknown
}

/** Gom chữ `output_text` của mọi message trong `output`; có `refusal` → đánh dấu từ chối. */
export function parseResponseBody(body: ResponseBody): { text: string; refusal: boolean } {
  let text = ''
  let refusal = false
  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue
    for (const part of item.content) {
      if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text
      else if (part?.type === 'refusal') refusal = true
    }
  }
  return { text, refusal }
}

export function createOpenAiAdapter(options: OpenAiAdapterOptions = {}): OpenAiAdapter {
  const baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? CHECK_KEY_TIMEOUT_MS
  const responseTimeoutMs = options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS
  const imageTimeoutMs = options.imageTimeoutMs ?? IMAGE_TIMEOUT_MS
  const doFetch = options.fetch ?? fetch

  /**
   * POST JSON có hết giờ + tín hiệu huỷ của caller. Lỗi mạng / hết giờ → `TRANSIENT`; caller huỷ →
   * `ABORTED`; HTTP lỗi → `classifyStatus`. Không giữ lỗi gốc (có thể mang chi tiết request).
   */
  async function postJson(
    path: string,
    apiKey: string,
    body: unknown,
    timeout: number,
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; json: unknown } | OpenAiFailure | OpenAiAborted> {
    if (signal?.aborted) return { ok: false, kind: 'ABORTED', maybeBilled: false }
    const timer = AbortSignal.timeout(timeout)
    const combined = signal ? AbortSignal.any([signal, timer]) : timer
    let res: Response
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: combined,
      })
    } catch (err) {
      if (signal?.aborted) return { ok: false, kind: 'ABORTED', maybeBilled: true }
      return { ok: false, kind: 'TRANSIENT', maybeBilled: !isConnectFailure(err) }
    }
    if (!res.ok) {
      const code = await errorCodeOf(res)
      return { ok: false, kind: classifyStatus(res.status, code), status: res.status }
    }
    try {
      return { ok: true, json: await res.json() }
    } catch {
      // Đứt giữa chừng khi đọc body, hoặc body không phải JSON.
      return signal?.aborted
        ? { ok: false, kind: 'ABORTED', maybeBilled: true }
        : { ok: false, kind: 'TRANSIENT', status: res.status, maybeBilled: true }
    }
  }

  return {
    async checkKey(apiKey) {
      let res: Response
      try {
        res = await doFetch(`${baseUrl}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        // Lỗi mạng / hết giờ / DNS: không giữ lỗi gốc (có thể mang chi tiết request).
        return { ok: false, kind: 'TRANSIENT' }
      }
      if (res.ok) {
        await res.body?.cancel().catch(() => {})
        return { ok: true }
      }
      const code = await errorCodeOf(res)
      return { ok: false, kind: classifyStatus(res.status, code), status: res.status }
    },

    async createResponse(request) {
      const result = await postJson(
        '/responses',
        request.apiKey,
        {
          model: request.model,
          input: request.input,
          ...(request.instructions ? { instructions: request.instructions } : {}),
          max_output_tokens: request.maxOutputTokens,
          store: false,
        },
        responseTimeoutMs,
        request.signal,
      )
      if (!result.ok) return result
      const body = (result.json ?? {}) as ResponseBody
      const usage = parseUsage(body.usage)
      // Chỉ `completed` / `incomplete` có kết quả dùng được; `failed`, `cancelled`, `in_progress`, `queued` → lỗi.
      if (typeof body.status === 'string' && body.status !== 'completed' && body.status !== 'incomplete') {
        return { ok: false, kind: 'TRANSIENT', status: 200, maybeBilled: true }
      }
      // 200 mà không có `usage` → không tính được tiền; coi như lỗi phía OpenAI.
      if (!usage) return { ok: false, kind: 'TRANSIENT', status: 200, maybeBilled: true }
      const { text, refusal } = parseResponseBody(body)
      const reason = body.status === 'incomplete' ? body.incomplete_details?.reason : undefined
      const incomplete = reason === 'content_filter' ? 'content_filter' : refusal ? 'refusal' : reason === 'max_output_tokens' ? 'max_output_tokens' : null
      return { ok: true, id: typeof body.id === 'string' ? body.id : '', text, usage, incomplete }
    },

    async generateImage(request) {
      const result = await postJson(
        '/images/generations',
        request.apiKey,
        { model: request.model, prompt: request.prompt, n: request.n, size: request.size, output_format: 'jpeg' },
        imageTimeoutMs,
        request.signal,
      )
      if (!result.ok) return result
      const body = (result.json ?? {}) as { data?: { b64_json?: unknown }[]; usage?: unknown }
      const images: Buffer[] = []
      for (const d of Array.isArray(body.data) ? body.data : []) {
        if (typeof d?.b64_json !== 'string') continue
        const bytes = Buffer.from(d.b64_json, 'base64')
        if (bytes.length > 0) images.push(bytes)
      }
      if (images.length === 0) return { ok: false, kind: 'TRANSIENT', status: 200, maybeBilled: true }
      return { ok: true, images, usage: parseUsage(body.usage) }
    },
  }
}
