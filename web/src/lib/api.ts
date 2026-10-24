// Lớp gọi API chung của web (AD-18). Mọi màn gọi server qua `apiFetch` + TanStack Query.
// Lỗi luôn thành `ApiError{code,status,details}`; câu hiển thị lấy từ `error-messages.ts`.
import { ErrorResponse, type ErrorCode } from '@ottm/shared'
import { QueryCache, QueryClient, MutationCache } from '@tanstack/react-query'

/**
 * Origin của api (cấu hình lúc build qua `VITE_API_ORIGIN`, vd `https://api.example.com` khi web ở Hostinger và
 * api ở VPS). Trống → cùng origin (dev: proxy Vite; hoặc reverse proxy phục vụ cả web lẫn api).
 */
export const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? '').trim().replace(/\/+$/, '')
export const API_BASE = `${API_ORIGIN}/api/v1`

/**
 * URL tuyệt đối tới một tài nguyên api dùng trực tiếp trong thẻ HTML (`<img src>`, `<audio src>`, link tải) — theo
 * `API_ORIGIN` nên đúng cả khi web và api khác origin (chế độ tách, spec 1.3c). Đường tương đối kiểu `/api/v1/...`
 * sẽ rơi vào SPA của web ở Hostinger và nhận `index.html`.
 */
export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * URL tới một đường công khai của api NGOÀI `/api/v1` (vd trang `/privacy/policy` — Story 9.1). Chế độ tách (web trên
 * Hostinger) đường này chỉ có ở host api; đường tương đối sẽ rơi vào SPA của web. Trống → tương đối (dev: proxy Vite).
 */
export function apiPublicUrl(path: string): string {
  return `${API_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`
}

export class ApiError extends Error {
  readonly code: ErrorCode
  /** HTTP status; 0 khi không tới được server. */
  readonly status: number
  readonly details?: unknown

  constructor(code: ErrorCode, status: number, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError
}

export interface ApiFetchOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /**
   * Gửi NGUYÊN bytes thay cho JSON (Story 5.2: tải file kho kiến thức) — `contentType` là MIME của file, `headers`
   * thêm (vd `X-File-Name`). Không dùng cùng `body`.
   */
  raw?: { data: Blob; contentType: string; headers?: Record<string, string> }
  /** Schema zod (từ `@ottm/shared`) để kiểm body phản hồi. */
  schema?: { parse(data: unknown): T }
  signal?: AbortSignal
}

/**
 * Gọi `${API_BASE}{path}`. `credentials: 'include'` để cookie phiên `ottm_sid` đi kèm cả khi api ở origin khác
 * (cùng tên miền gốc — cookie SameSite=Lax chỉ đi với request same-site; server bật CORS có credentials).
 * 204 → `undefined`.
 */
export async function apiFetch<T = void>(path: string, options: ApiFetchOptions<T> = {}): Promise<T> {
  const { method = 'GET', body, raw, schema, signal } = options
  const headers: Record<string, string> = { Accept: 'application/json', ...raw?.headers }
  if (raw) headers['Content-Type'] = raw.contentType
  else if (body !== undefined) headers['Content-Type'] = 'application/json'
  const payload = raw ? raw.data : body !== undefined ? JSON.stringify(body) : undefined

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'include',
      ...(payload !== undefined ? { body: payload } : {}),
      ...(signal ? { signal } : {}),
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new ApiError('NETWORK_ERROR', 0, `Network error: ${String(err)}`)
  }

  if (!res.ok) {
    const json: unknown = await res.json().catch(() => undefined)
    const parsed = ErrorResponse.safeParse(json)
    if (parsed.success) {
      const { code, message, details } = parsed.data.error
      throw new ApiError(code, res.status, message, details)
    }
    throw new ApiError(res.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL', res.status, `HTTP ${res.status}`)
  }

  if (res.status === 204) return undefined as T
  // 2xx nhưng body không phải JSON hoặc sai schema → ApiError INTERNAL giữ status 2xx (không retry).
  let data: unknown
  try {
    data = await res.json()
  } catch (err) {
    throw new ApiError('INTERNAL', res.status, `Invalid JSON response: ${String(err)}`)
  }
  if (!schema) return data as T
  try {
    return schema.parse(data)
  } catch (err) {
    throw new ApiError('INTERNAL', res.status, 'Response failed schema validation', err)
  }
}

/** Khoá query trạng thái đăng nhập: `MeResponse` khi có phiên, `null` khi chưa. */
export const ME_QUERY_KEY = ['auth', 'me'] as const

function isUnauthenticated(err: unknown): boolean {
  return isApiError(err) && err.status === 401 && err.code === 'UNAUTHENTICATED'
}

function isRetryable(err: unknown): boolean {
  if (!isApiError(err)) return false
  return err.status === 0 || err.status >= 500
}

export function createQueryClient(): QueryClient {
  // 401 ở bất kỳ query/mutation nào → coi như mất phiên; `RequireAuth` sẽ đá về màn đăng nhập.
  const onError = (err: unknown) => {
    if (isUnauthenticated(err)) client.setQueryData(ME_QUERY_KEY, null)
  }
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        // Chỉ thử lại lỗi mạng (status 0) và 5xx, thêm 2 lần. 4xx và phản hồi 2xx sai định dạng thì không.
        retry: (count, err) => isRetryable(err) && count < 2,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  })
  return client
}
