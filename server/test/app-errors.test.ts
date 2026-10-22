import { ErrorResponse } from '@ottm/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { buildApp } from '../src/app/app.ts'
import type { Db, Sql } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'

describe('hợp đồng lỗi API (AD-18)', () => {
  let app: FastifyInstance

  beforeEach(() => {
    // Các route thử không chạm DB.
    app = buildApp({ sql: {} as Sql, db: {} as Db, logger: createLogger({ level: 'silent' }) })
    app.get('/boom', async () => {
      throw new Error('secret detail')
    })
    app.post('/strict', { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } }, async () => ({ ok: true }))
    app.get('/zod', async () => z.object({ n: z.number() }).parse({ n: 'x' }))
    app.get('/conflict', async () => {
      throw Object.assign(new Error('stale version'), { statusCode: 409 })
    })
    app.get('/unavailable', async () => {
      throw Object.assign(new Error('down'), { statusCode: 503 })
    })
  })
  afterEach(async () => {
    await app.close()
  })

  async function call(method: 'GET' | 'POST', url: string, payload?: object) {
    const res = await app.inject({ method, url, payload })
    return { status: res.statusCode, body: ErrorResponse.parse(res.json()) }
  }

  it('route không tồn tại → 404 NOT_FOUND', async () => {
    const { status, body } = await call('GET', '/nope')
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('route ném lỗi → 500 INTERNAL, không lộ message', async () => {
    const { status, body } = await call('GET', '/boom')
    expect(status).toBe(500)
    expect(body.error).toEqual({ code: 'INTERNAL', message: 'Internal error' })
  })

  it('body sai schema → 400 VALIDATION_FAILED kèm details', async () => {
    const { status, body } = await call('POST', '/strict', {})
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details).toBeDefined()
  })

  it('ZodError → 400 VALIDATION_FAILED kèm issues', async () => {
    const { status, body } = await call('GET', '/zod')
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(Array.isArray(body.error.details)).toBe(true)
  })

  it('giữ status 409 / 503 và ánh xạ mã', async () => {
    expect(await call('GET', '/conflict')).toMatchObject({ status: 409, body: { error: { code: 'VERSION_CONFLICT' } } })
    expect(await call('GET', '/unavailable')).toEqual({
      status: 503,
      body: { error: { code: 'INTERNAL', message: 'Internal error' } },
    })
  })
})
