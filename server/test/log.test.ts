import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app/app.ts'
import type { Db, Sql } from '../src/platform/db/index.ts'
import { createLogger, redactUrl } from '../src/platform/log/index.ts'

function capture() {
  const lines: string[] = []
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk))
      cb()
    },
  })
  return { sink, text: () => lines.join('') }
}

describe('platform/log — redact theo AD-12', () => {
  it('không ghi token, khoá, cookie, mật khẩu ở mọi độ sâu', () => {
    const { sink, text } = capture()
    const log = createLogger({ level: 'info', name: 't' }, sink)
    log.info({
      access_token: 'EAAB-S3CR3T',
      apiKey: 'sk-S3CR3T',
      api_key: 'sk-S3CR3T-2',
      openai: { openaiKey: 'sk-S3CR3T-3', apiKey: 'sk-S3CR3T-4' },
      page: { token: 'page-S3CR3T', refresh_token: 'r-S3CR3T' },
      meta: { page: { token: 'nested-S3CR3T', access_token: 'deep-S3CR3T' } },
      oauth: { client_secret: 'cs-S3CR3T', appsecret_proof: 'proof-S3CR3T' },
      debug: { input_token: 'it-S3CR3T', fb_exchange_token: 'fx-S3CR3T' },
      config: { META_APP_SECRET: 'mas-S3CR3T', THREADS_APP_SECRET: 'tas-S3CR3T', META_VERIFY_TOKEN: 'mvt-S3CR3T' },
      client: { appSecret: 'as-S3CR3T', verifyToken: 'vt-S3CR3T' },
      headers: { cookie: 'sid=S3CR3T', authorization: 'Bearer S3CR3T', 'set-cookie': 'sid=S3CR3T' },
      res: { headers: { 'set-cookie': 'sid=S3CR3T' } },
      cookie: 'sid=S3CR3T',
      body: { password: 'hunter2' },
      pageId: 'p1',
    }, 'thử')
    const out = text()
    expect(out).not.toMatch(/S3CR3T|hunter2/) // giá trị, không phải tên khoá như client_secret
    expect(out).toContain('[REDACTED]')
    expect(JSON.parse(out)).toMatchObject({ pageId: 'p1', service: 't' })
  })

  it('redactUrl thay giá trị tham số query bí mật, giữ tham số khác', () => {
    expect(redactUrl('/webhooks/meta?hub.mode=subscribe&hub.verify_token=vt-secret&hub.challenge=42')).toBe(
      '/webhooks/meta?hub.mode=subscribe&hub.verify_token=REDACTED&hub.challenge=42',
    )
    expect(redactUrl('/oauth/meta/callback?code=c-secret&state=s1')).toBe('/oauth/meta/callback?code=REDACTED&state=s1')
    expect(redactUrl('/x?access_token=t-secret')).toBe('/x?access_token=REDACTED')
    expect(redactUrl('/debug_token?input_token=it-secret&access_token=at-secret')).toBe(
      '/debug_token?input_token=REDACTED&access_token=REDACTED',
    )
    expect(redactUrl('/oauth/access_token?grant_type=fb_exchange_token&fb_exchange_token=fx-secret')).toBe(
      '/oauth/access_token?grant_type=fb_exchange_token&fb_exchange_token=REDACTED',
    )
    expect(redactUrl('/healthz')).toBe('/healthz')
  })

  it('log request của Fastify không chứa bí mật trong URL', async () => {
    const { sink, text } = capture()
    const app = buildApp({ sql: {} as Sql, db: {} as Db, logger: createLogger({ level: 'info' }, sink) })
    try {
      await app.inject({ method: 'GET', url: '/oauth/meta/callback?code=c-secret&access_token=t-secret&state=s1' })
    } finally {
      await app.close()
    }
    const out = text()
    expect(out).toContain('/oauth/meta/callback?code=REDACTED')
    expect(out).not.toMatch(/secret/)
  })
})
