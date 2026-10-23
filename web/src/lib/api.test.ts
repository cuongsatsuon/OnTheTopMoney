import { MeResponse } from '@ottm/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, ME_QUERY_KEY, apiFetch, createQueryClient } from './api'
import { errorMessage } from './error-messages'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createQueryClient — xử lý 401 toàn cục', () => {
  async function failQuery(err: ApiError) {
    const client = createQueryClient()
    client.setQueryData(ME_QUERY_KEY, { authenticated: true })
    await client
      .fetchQuery({
        queryKey: ['x'],
        queryFn: () => Promise.reject(err),
        retry: false,
      })
      .catch(() => {})
    return client
  }

  it('ApiError(UNAUTHENTICATED, 401) ở query bất kỳ → me = null', async () => {
    const client = await failQuery(new ApiError('UNAUTHENTICATED', 401, 'x'))
    expect(client.getQueryData(ME_QUERY_KEY)).toBeNull()
  })

  it('ApiError(INVALID_CREDENTIALS, 401) không đụng tới me', async () => {
    const client = await failQuery(new ApiError('INVALID_CREDENTIALS', 401, 'x'))
    expect(client.getQueryData(ME_QUERY_KEY)).toEqual({ authenticated: true })
  })

  it('mutation 401 UNAUTHENTICATED cũng → me = null', async () => {
    const client = createQueryClient()
    client.setQueryData(ME_QUERY_KEY, { authenticated: true })
    const mutation = client.getMutationCache().build(client, {
      mutationFn: () => Promise.reject(new ApiError('UNAUTHENTICATED', 401, 'x')),
    })
    await mutation.execute(undefined).catch(() => {})
    expect(client.getQueryData(ME_QUERY_KEY)).toBeNull()
  })
})

describe('apiFetch — lỗi luôn thành ApiError', () => {
  it('fetch thất bại → NETWORK_ERROR, status 0, có câu riêng', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const err = await apiFetch('/auth/me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'NETWORK_ERROR', status: 0 })
    expect(errorMessage('NETWORK_ERROR')).toBe('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.')
  })

  it('2xx body không phải JSON → ApiError INTERNAL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200 })))
    const err = await apiFetch('/auth/me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'INTERNAL', status: 200 })
  })

  it('2xx sai schema → ApiError INTERNAL, query không retry', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authenticated: 'yes' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const err = await apiFetch('/auth/me', { schema: MeResponse }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'INTERNAL', status: 200 })

    const client = createQueryClient()
    fetchMock.mockClear()
    await client.fetchQuery({ queryKey: ['me2'], queryFn: () => apiFetch('/auth/me', { schema: MeResponse }) }).catch(() => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lỗi có body chuẩn → ApiError mang code/status/details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'm', details: { a: 1 } } }), { status: 429 })),
    )
    const err = await apiFetch('/auth/login', { method: 'POST', body: { password: 'x' } }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'RATE_LIMITED', status: 429, details: { a: 1 } })
  })

  it('mã lạ → câu chung', () => {
    expect(errorMessage('SOMETHING_NEW')).toBe(errorMessage('INTERNAL'))
  })
})

describe('apiFetch — origin api lúc build (VITE_API_ORIGIN) và cookie phiên', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function lastCall(origin: string | undefined) {
    if (origin !== undefined) vi.stubEnv('VITE_API_ORIGIN', origin)
    else vi.stubEnv('VITE_API_ORIGIN', '')
    vi.resetModules()
    const mod = await import('./api')
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await mod.apiFetch('/auth/logout', { method: 'POST' })
    const [url, init] = fetchMock.mock.calls[0]!
    return { url, init, mod }
  }

  it('trống → /api/v1 tương đối (dev qua proxy Vite), credentials include', async () => {
    const { url, init, mod } = await lastCall(undefined)
    expect(mod.API_BASE).toBe('/api/v1')
    expect(url).toBe('/api/v1/auth/logout')
    expect(init?.credentials).toBe('include')
  })

  it('đặt origin → URL tuyệt đối tới api, credentials include (cookie đi kèm cross-origin)', async () => {
    const { url, init, mod } = await lastCall('https://api.example.com')
    expect(mod.API_ORIGIN).toBe('https://api.example.com')
    expect(url).toBe('https://api.example.com/api/v1/auth/logout')
    expect(init?.credentials).toBe('include')
  })

  it('bỏ dấu / cuối của origin', async () => {
    const { url } = await lastCall('https://api.example.com/')
    expect(url).toBe('https://api.example.com/api/v1/auth/logout')
  })

  it('apiUrl (src của ảnh/voice đính kèm) theo origin api; trống → tương đối', async () => {
    const { mod } = await lastCall('https://api.example.com')
    expect(mod.apiUrl('/attachments/a1')).toBe('https://api.example.com/api/v1/attachments/a1')
    expect(mod.apiUrl('attachments/a1')).toBe('https://api.example.com/api/v1/attachments/a1')
    const local = await lastCall(undefined)
    expect(local.mod.apiUrl('/attachments/a1')).toBe('/api/v1/attachments/a1')
  })

  it('STREAM_URL của realtime theo cùng origin', async () => {
    vi.stubEnv('VITE_API_ORIGIN', 'https://api.example.com')
    vi.resetModules()
    const { STREAM_URL } = await import('./realtime')
    expect(STREAM_URL).toBe('https://api.example.com/api/v1/stream')
  })
})
