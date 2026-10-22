// Entrypoint api: phụ thuộc dựng từ config thật (main.ts dùng đúng các hàm này).
import { describe, expect, it } from 'vitest'
import { aiOptionsFromConfig, cipherFromConfig, connectionsOptionsFromConfig } from '../src/app/deps.ts'
import type { Db } from '../src/platform/db/index.ts'
import { createLogger } from '../src/platform/log/index.ts'
import { parseEnv } from '../src/platform/config/index.ts'

const KEY = Buffer.alloc(32, 9).toString('base64')
const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }

describe('app/deps — cipher từ config', () => {
  it('khoá chủ hợp lệ → cipher khác null, mã hoá bằng khoá active và giải mã lại được', () => {
    const config = parseEnv({ ...base, APP_ENCRYPTION_KEYS: `old:${Buffer.alloc(32, 1).toString('base64')},k1:${KEY}`, APP_ENCRYPTION_ACTIVE_KEY: 'k1' })
    const { cipher } = aiOptionsFromConfig(config)
    expect(cipher).not.toBeNull()
    const envelope = cipher!.encrypt('sk-thu')
    expect(cipher!.keyIdOf(envelope)).toBe('k1')
    expect(cipher!.decrypt(envelope)).toBe('sk-thu')
    expect(cipher!.hasKey('old')).toBe(true)
  })

  it('production hợp lệ luôn có cipher', () => {
    const config = parseEnv({
      ...base,
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://api.example.com',
      WEB_BASE_URL: 'https://app.example.com',
      ALLOWED_ORIGINS: 'https://app.example.com',
      APP_ENCRYPTION_KEYS: `k1:${KEY}`,
      APP_ENCRYPTION_ACTIVE_KEY: 'k1',
    })
    expect(cipherFromConfig(config)).not.toBeNull()
  })

  it('dev không đặt khoá chủ → null', () => {
    expect(cipherFromConfig(parseEnv(base))).toBeNull()
  })
})

describe('app/deps — connections từ config', () => {
  // `createMetaClients` chỉ giữ `db` cho store tần suất; test này không gọi Meta nên không cần DB thật.
  const db = {} as Db
  const logger = createLogger({ level: 'silent' })

  it('mang META_LOGIN_CONFIG_ID, META_FAKE, PUBLIC_BASE_URL (mặc định dev) và cặp Threads vào cấu hình OAuth', () => {
    const config = parseEnv({
      ...base,
      META_LOGIN_CONFIG_ID: '777',
      META_APP_ID: '123',
      META_APP_SECRET: 's',
      THREADS_APP_ID: '456',
      THREADS_APP_SECRET: 'ts',
      APP_ENCRYPTION_KEYS: `k1:${KEY}`,
      APP_ENCRYPTION_ACTIVE_KEY: 'k1',
    })
    const opts = connectionsOptionsFromConfig(config, db, logger)
    expect(opts.config).toEqual({
      META_APP_ID: '123',
      META_APP_SECRET: 's',
      META_LOGIN_CONFIG_ID: '777',
      META_GRAPH_VERSION: 'v26.0',
      META_FAKE: false,
      PUBLIC_BASE_URL: 'http://localhost:5173',
      WEB_BASE_URL: 'http://localhost:5173',
      THREADS_APP_ID: '456',
      THREADS_APP_SECRET: 'ts',
    })
    expect(opts.cipher).not.toBeNull()
    expect(opts.graph.baseUrl).toBe('https://graph.facebook.com/v26.0')
    expect('calls' in opts.graph).toBe(false)
    expect(opts.threads?.baseUrl).toBe('https://graph.threads.com/v1.0')
  })

  it('chưa đặt cặp Threads → không có client Threads', () => {
    const opts = connectionsOptionsFromConfig(parseEnv(base), db, logger)
    expect(opts.threads).toBeUndefined()
    expect(opts.config.THREADS_APP_ID).toBeUndefined()
  })

  it('META_FAKE=1 → graph là Meta giả (có `calls`), cấu hình mang META_FAKE', () => {
    const opts = connectionsOptionsFromConfig(parseEnv({ ...base, META_FAKE: '1' }), db, logger)
    expect(opts.config.META_FAKE).toBe(true)
    expect('calls' in opts.graph).toBe(true)
    expect(opts.threads && 'calls' in opts.threads).toBe(true)
    expect(opts.cipher).toBeNull()
  })
})
