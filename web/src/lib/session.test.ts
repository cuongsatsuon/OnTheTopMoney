import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './api'
import { fetchMe, loginUrl, safeNext } from './session'

describe('safeNext', () => {
  it.each([
    ['//evil.com'],
    ['/\\evil.com'],
    ['https://evil.com'],
    ['/hop-thu\u0000'],
    ['/\tevil'],
    ['/dang-nhap?next=/hop-thu'],
    ['/dang-nhap'],
    [''],
    [null],
    [undefined],
  ])('từ chối %j → "/"', (next) => {
    expect(safeNext(next)).toBe('/')
  })

  it('giữ đường dẫn nội bộ kèm query', () => {
    expect(safeNext('/hop-thu?tab=1')).toBe('/hop-thu?tab=1')
    expect(loginUrl('/hop-thu?tab=1')).toBe('/dang-nhap?next=%2Fhop-thu%3Ftab%3D1')
    expect(loginUrl('//evil.com')).toBe('/dang-nhap')
  })
})

describe('fetchMe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })))
  const signal = new AbortController().signal

  it('200 → MeResponse', async () => {
    respond(200, { authenticated: true })
    await expect(fetchMe({ signal })).resolves.toEqual({ authenticated: true })
  })

  it('401 → null', async () => {
    respond(401, { error: { code: 'UNAUTHENTICATED', message: 'Session required' } })
    await expect(fetchMe({ signal })).resolves.toBeNull()
  })

  it('500 → ném ApiError', async () => {
    respond(500, { error: { code: 'INTERNAL', message: 'Internal error' } })
    const err = await fetchMe({ signal }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'INTERNAL', status: 500 })
  })
})
