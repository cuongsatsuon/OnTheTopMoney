import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ConfigError, parseEnv } from '../src/platform/config/index.ts'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
/** Khoá chủ thử (base64 của 32 byte) — production bắt buộc từ Story 1.5. */
const KEY_A = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')
const PROD_KEYS = { APP_ENCRYPTION_KEYS: `k1:${KEY_A}`, APP_ENCRYPTION_ACTIVE_KEY: 'k1' }

function variablesOf(env: Record<string, string | undefined>): string[] {
  try {
    parseEnv(env)
  } catch (err) {
    if (err instanceof ConfigError) return err.variables
    throw err
  }
  return []
}

describe('platform/config', () => {
  it('đọc env hợp lệ và áp mặc định', () => {
    expect(parseEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' })).toEqual({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      PORT: 3000,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      ALLOWED_ORIGINS: ['http://localhost:5173', 'http://localhost:5174'],
      TRUST_PROXY: false,
      COOKIE_SECURE: true,
      HEALTH_DISK_PATH: '/',
      META_GRAPH_VERSION: 'v26.0',
      META_FAKE: false,
      PUBLIC_BASE_URL: 'http://localhost:5173',
      WEB_BASE_URL: 'http://localhost:5173',
      CLOUDINARY_FOLDER: 'ottm',
    })
  })

  describe('Meta (Story 2.2): META_LOGIN_CONFIG_ID, META_FAKE, PUBLIC_BASE_URL', () => {
    const dev = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }
    const prod = {
      ...dev,
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://app.example.com',
      PUBLIC_BASE_URL: 'https://api.example.com',
      WEB_BASE_URL: 'https://app.example.com',
      ...PROD_KEYS,
    }

    it('META_LOGIN_CONFIG_ID tuỳ chọn, chỉ chữ số', () => {
      expect(parseEnv({ ...dev, META_LOGIN_CONFIG_ID: '123456' }).META_LOGIN_CONFIG_ID).toBe('123456')
      expect(parseEnv(dev).META_LOGIN_CONFIG_ID).toBeUndefined()
      expect(variablesOf({ ...dev, META_LOGIN_CONFIG_ID: 'abc' })).toEqual(['META_LOGIN_CONFIG_ID'])
    })

    it('META_FAKE: dev bật được (1/true), mặc định tắt; giá trị lạ bị từ chối', () => {
      expect(parseEnv({ ...dev, META_FAKE: '1' }).META_FAKE).toBe(true)
      expect(parseEnv({ ...dev, META_FAKE: 'true' }).META_FAKE).toBe(true)
      expect(parseEnv({ ...dev, META_FAKE: '0' }).META_FAKE).toBe(false)
      expect(variablesOf({ ...dev, META_FAKE: 'yes' })).toEqual(['META_FAKE'])
    })

    it('production bật META_FAKE → lỗi nêu tên biến; tắt thì hợp lệ', () => {
      expect(variablesOf({ ...prod, META_FAKE: '1' })).toEqual(['META_FAKE'])
      expect(variablesOf({ ...prod, META_FAKE: '0' })).toEqual([])
    })

    it('PUBLIC_BASE_URL dev mặc định http://localhost:5173; đặt thì giữ giá trị', () => {
      expect(parseEnv(dev).PUBLIC_BASE_URL).toBe('http://localhost:5173')
      expect(parseEnv({ ...dev, PUBLIC_BASE_URL: 'https://x.trycloudflare.com' }).PUBLIC_BASE_URL).toBe('https://x.trycloudflare.com')
      expect(parseEnv(prod).PUBLIC_BASE_URL).toBe('https://api.example.com')
    })

    it.each(['src/app/main.ts'])('%s production bật META_FAKE → không khởi động, log tên biến', (entry) => {
      const env: Record<string, string | undefined> = { ...process.env, ...prod, LOG_LEVEL: 'silent', META_FAKE: '1' }
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k]
      const res = spawnSync(process.execPath, [entry], { cwd: serverDir, env, encoding: 'utf8', timeout: 20_000 })
      expect(res.status).not.toBe(0)
      expect(res.status).not.toBeNull()
      expect(res.stderr).toContain('META_FAKE')
    })
  })

  describe('Meta (Story 2.1)', () => {
    const dev = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }

    it('META_GRAPH_VERSION dạng vNN.N; secret, verify token và Threads app tuỳ chọn', () => {
      expect(
        parseEnv({
          ...dev,
          META_GRAPH_VERSION: 'v27.0',
          META_APP_SECRET: 'app-secret-x',
          META_VERIFY_TOKEN: '0123456789abcdef',
          THREADS_APP_ID: '987654321',
          THREADS_APP_SECRET: 'threads-secret-x',
          THREADS_APP_ENV: 'test',
        }),
      ).toMatchObject({
        META_GRAPH_VERSION: 'v27.0',
        META_APP_SECRET: 'app-secret-x',
        META_VERIFY_TOKEN: '0123456789abcdef',
        THREADS_APP_ID: '987654321',
        THREADS_APP_SECRET: 'threads-secret-x',
        THREADS_APP_ENV: 'test',
      })
      expect(parseEnv(dev).META_APP_SECRET).toBeUndefined()
      expect(variablesOf({ ...dev, META_GRAPH_VERSION: '26.0' })).toEqual(['META_GRAPH_VERSION'])
      expect(variablesOf({ ...dev, META_GRAPH_VERSION: 'v26' })).toEqual(['META_GRAPH_VERSION'])
      expect(variablesOf({ ...dev, THREADS_APP_ID: 'abc', THREADS_APP_SECRET: 's' })).toEqual(['THREADS_APP_ID'])
      expect(variablesOf({ ...dev, THREADS_APP_ENV: 'prod' })).toEqual(['THREADS_APP_ENV'])
    })

    it('META_VERIFY_TOKEN đặt thì ít nhất 16 ký tự', () => {
      expect(variablesOf({ ...dev, META_VERIFY_TOKEN: 'short' })).toEqual(['META_VERIFY_TOKEN'])
      expect(variablesOf({ ...dev, META_VERIFY_TOKEN: 'x'.repeat(16) })).toEqual([])
    })

    it('THREADS_APP_ID và THREADS_APP_SECRET phải đi cùng nhau', () => {
      expect(variablesOf({ ...dev, THREADS_APP_ID: '42' })).toEqual(['THREADS_APP_SECRET'])
      expect(variablesOf({ ...dev, THREADS_APP_SECRET: 's' })).toEqual(['THREADS_APP_ID'])
    })

    it('thông báo lỗi không chép giá trị', () => {
      expect(() => parseEnv({ ...dev, META_GRAPH_VERSION: 'bad-S3CR3T', META_VERIFY_TOKEN: 'tok-S3CR3T' })).toThrow(ConfigError)
      try {
        parseEnv({ ...dev, META_GRAPH_VERSION: 'bad-S3CR3T', META_VERIFY_TOKEN: 'tok-S3CR3T' })
      } catch (err) {
        expect((err as ConfigError).variables.sort()).toEqual(['META_GRAPH_VERSION', 'META_VERIFY_TOKEN'])
        expect((err as Error).message).toContain('META_GRAPH_VERSION')
        expect((err as Error).message).not.toContain('S3CR3T')
      }
    })
  })

  it('PRIVACY_CONTROLLER_NAME / PRIVACY_CONTACT_EMAIL (Story 9.1): tuỳ chọn, email phải hợp lệ', () => {
    const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }
    expect(parseEnv(base).PRIVACY_CONTACT_EMAIL).toBeUndefined()
    const env = parseEnv({ ...base, PRIVACY_CONTROLLER_NAME: '  Shop Mỹ Phẩm  ', PRIVACY_CONTACT_EMAIL: 'lienhe@shop.example' })
    expect(env.PRIVACY_CONTROLLER_NAME).toBe('Shop Mỹ Phẩm')
    expect(env.PRIVACY_CONTACT_EMAIL).toBe('lienhe@shop.example')
    expect(variablesOf({ ...base, PRIVACY_CONTACT_EMAIL: 'khong-phai-email' })).toEqual(['PRIVACY_CONTACT_EMAIL'])
  })

  it('đọc ALLOWED_ORIGINS, TRUST_PROXY, COOKIE_SECURE', () => {
    const cfg = parseEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      ALLOWED_ORIGINS: 'https://app.example.com, http://localhost:5173',
      TRUST_PROXY: 'true',
      COOKIE_SECURE: 'false',
    })
    expect(cfg.ALLOWED_ORIGINS).toEqual(['https://app.example.com', 'http://localhost:5173'])
    expect(cfg.TRUST_PROXY).toBe(true)
    expect(cfg.COOKIE_SECURE).toBe(false)
  })

  it('production: bắt buộc ALLOWED_ORIGINS https, cấm COOKIE_SECURE=false', () => {
    const prod = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://api.example.com',
      WEB_BASE_URL: 'https://app.example.com',
      ...PROD_KEYS,
    }
    expect(() => parseEnv(prod)).toThrow(/ALLOWED_ORIGINS/)
    expect(() => parseEnv({ ...prod, ALLOWED_ORIGINS: 'http://app.example.com' })).toThrow(/ALLOWED_ORIGINS/)
    expect(() => parseEnv({ ...prod, ALLOWED_ORIGINS: 'https://app.example.com', COOKIE_SECURE: 'false' })).toThrow(
      /COOKIE_SECURE/,
    )
    expect(parseEnv({ ...prod, ALLOWED_ORIGINS: 'https://app.example.com' })).toMatchObject({
      ALLOWED_ORIGINS: ['https://app.example.com'],
      COOKIE_SECURE: true,
    })
  })

  describe('production: PUBLIC_BASE_URL, META_APP_ENV', () => {
    const prod = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://app.example.com',
      PUBLIC_BASE_URL: 'https://api.example.com',
      WEB_BASE_URL: 'https://app.example.com',
      ...PROD_KEYS,
    }

    it('env production đầy đủ → hợp lệ', () => {
      expect(parseEnv(prod)).toMatchObject({
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'https://api.example.com',
        WEB_BASE_URL: 'https://app.example.com',
      })
      expect(parseEnv({ ...prod, META_APP_ID: '1234567890', META_APP_ENV: 'live', META_APP_SECRET: 's' })).toMatchObject({
        META_APP_ID: '1234567890',
        META_APP_ENV: 'live',
      })
    })

    it('thiếu PUBLIC_BASE_URL → lỗi nêu tên biến', () => {
      expect(variablesOf({ ...prod, PUBLIC_BASE_URL: undefined })).toEqual(['PUBLIC_BASE_URL'])
      expect(variablesOf({ ...prod, PUBLIC_BASE_URL: '' })).toEqual(['PUBLIC_BASE_URL'])
    })

    it('PUBLIC_BASE_URL phải https và là origin', () => {
      expect(variablesOf({ ...prod, PUBLIC_BASE_URL: 'http://api.example.com' })).toEqual(['PUBLIC_BASE_URL'])
      expect(variablesOf({ ...prod, PUBLIC_BASE_URL: 'https://api.example.com/' })).toEqual(['PUBLIC_BASE_URL'])
      expect(variablesOf({ ...prod, PUBLIC_BASE_URL: 'https://api.example.com/x' })).toEqual(['PUBLIC_BASE_URL'])
    })

    it('chế độ cùng VPS (không WEB_BASE_URL): ALLOWED_ORIGINS phải gồm PUBLIC_BASE_URL; WEB_BASE_URL = PUBLIC_BASE_URL', () => {
      const vps = { ...prod, PUBLIC_BASE_URL: 'https://app.example.com', WEB_BASE_URL: undefined }
      expect(variablesOf(vps)).toEqual([])
      expect(parseEnv(vps).WEB_BASE_URL).toBe('https://app.example.com')
      expect(variablesOf({ ...vps, PUBLIC_BASE_URL: 'https://other.example.com' })).toEqual(['ALLOWED_ORIGINS'])
      // Đặt WEB_BASE_URL bằng đúng PUBLIC_BASE_URL cũng là chế độ cùng VPS.
      expect(variablesOf({ ...vps, WEB_BASE_URL: 'https://app.example.com' })).toEqual([])
      expect(variablesOf({ ...vps, PUBLIC_BASE_URL: 'https://other.example.com', WEB_BASE_URL: 'https://other.example.com' })).toEqual([
        'ALLOWED_ORIGINS',
      ])
    })

    it('chế độ tách (WEB_BASE_URL khác PUBLIC_BASE_URL): PUBLIC_BASE_URL (host api) không cần trong ALLOWED_ORIGINS', () => {
      expect(variablesOf(prod)).toEqual([])
      expect(variablesOf({ ...prod, PUBLIC_BASE_URL: 'https://other.example.com' })).toEqual([])
      // Thiếu WEB_BASE_URL → quay về chế độ cùng VPS → host api phải nằm trong ALLOWED_ORIGINS.
      expect(variablesOf({ ...prod, WEB_BASE_URL: undefined })).toEqual(['ALLOWED_ORIGINS'])
      expect(variablesOf({ ...prod, WEB_BASE_URL: '' })).toEqual(['ALLOWED_ORIGINS'])
    })

    it('WEB_BASE_URL khi đặt: https, origin, nằm trong ALLOWED_ORIGINS', () => {
      expect(variablesOf({ ...prod, WEB_BASE_URL: 'http://app.example.com' })).toEqual(['WEB_BASE_URL'])
      expect(variablesOf({ ...prod, WEB_BASE_URL: 'https://app.example.com/' })).toEqual(['WEB_BASE_URL'])
      expect(variablesOf({ ...prod, WEB_BASE_URL: 'https://app.example.com/pages' })).toEqual(['WEB_BASE_URL'])
      expect(variablesOf({ ...prod, WEB_BASE_URL: 'https://other.example.com' })).toEqual(['WEB_BASE_URL'])
      expect(
        parseEnv({ ...prod, ALLOWED_ORIGINS: 'https://www.example.com, https://app.example.com' }).WEB_BASE_URL,
      ).toBe('https://app.example.com')
    })

    it('ngoài production: WEB_BASE_URL mặc định = PUBLIC_BASE_URL; đặt thì giữ giá trị', () => {
      const dev = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }
      expect(parseEnv(dev).WEB_BASE_URL).toBe('http://localhost:5173')
      expect(parseEnv({ ...dev, PUBLIC_BASE_URL: 'https://x.trycloudflare.com' }).WEB_BASE_URL).toBe('https://x.trycloudflare.com')
      expect(parseEnv({ ...dev, WEB_BASE_URL: 'http://localhost:4173' }).WEB_BASE_URL).toBe('http://localhost:4173')
      expect(variablesOf({ ...dev, WEB_BASE_URL: 'http://localhost:4173/x' })).toEqual(['WEB_BASE_URL'])
    })

    it.each(['src/app/main.ts'])('%s production WEB_BASE_URL không thuộc ALLOWED_ORIGINS → không khởi động, log tên biến', (entry) => {
      const res = spawnEntry(entry, { WEB_BASE_URL: 'https://other.example.com' })
      expect(res.status).not.toBe(0)
      expect(res.status).not.toBeNull()
      expect(res.stderr).toContain('WEB_BASE_URL')
    })

    it('META_APP_ID đặt mà META_APP_ENV=test hoặc thiếu → lỗi META_APP_ENV', () => {
      expect(variablesOf({ ...prod, META_APP_ID: '1234567890', META_APP_ENV: 'test', META_APP_SECRET: 's' })).toEqual(['META_APP_ENV'])
      expect(variablesOf({ ...prod, META_APP_ID: '1234567890', META_APP_SECRET: 's' })).toEqual(['META_APP_ENV'])
    })

    it('META_APP_ID đặt mà thiếu META_APP_SECRET → lỗi META_APP_SECRET', () => {
      expect(variablesOf({ ...prod, META_APP_ID: '1234567890', META_APP_ENV: 'live' })).toEqual(['META_APP_SECRET'])
    })

    it('Threads: THREADS_APP_ID đặt thì THREADS_APP_ENV phải live', () => {
      const threads = { THREADS_APP_ID: '42', THREADS_APP_SECRET: 's' }
      expect(variablesOf({ ...prod, ...threads })).toEqual(['THREADS_APP_ENV'])
      expect(variablesOf({ ...prod, ...threads, THREADS_APP_ENV: 'test' })).toEqual(['THREADS_APP_ENV'])
      expect(variablesOf({ ...prod, ...threads, THREADS_APP_ENV: 'live' })).toEqual([])
    })

    it('chưa đặt META_APP_ID (story này chưa bắt buộc) → hợp lệ', () => {
      expect(variablesOf(prod)).toEqual([])
    })

    it('ngoài production: PUBLIC_BASE_URL tuỳ chọn, Meta Test App được phép', () => {
      const dev = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }
      expect(parseEnv({ ...dev, META_APP_ID: '42', META_APP_ENV: 'test' })).toMatchObject({ META_APP_ENV: 'test' })
      expect(parseEnv({ ...dev, PUBLIC_BASE_URL: 'http://localhost:5173' }).PUBLIC_BASE_URL).toBe('http://localhost:5173')
    })

    it('META_APP_ENV lạ, META_APP_ID không phải số, HEALTH_DISK_PATH tương đối → bị từ chối', () => {
      const dev = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }
      expect(variablesOf({ ...dev, META_APP_ENV: 'prod' })).toEqual(['META_APP_ENV'])
      expect(variablesOf({ ...dev, META_APP_ID: 'abc' })).toEqual(['META_APP_ID'])
      expect(variablesOf({ ...dev, HEALTH_DISK_PATH: 'data' })).toEqual(['HEALTH_DISK_PATH'])
      expect(parseEnv({ ...dev, HEALTH_DISK_PATH: '/srv/disk' }).HEALTH_DISK_PATH).toBe('/srv/disk')
    })

    function spawnEntry(entry: string, overrides: Record<string, string | undefined>) {
      const env: Record<string, string | undefined> = { ...process.env, ...prod, LOG_LEVEL: 'silent', ...overrides }
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k]
      return spawnSync(process.execPath, [entry], { cwd: serverDir, env, encoding: 'utf8', timeout: 20_000 })
    }

    it.each(['src/app/main.ts', 'src/worker/main.ts'])('%s production thiếu PUBLIC_BASE_URL → không khởi động', (entry) => {
      const res = spawnEntry(entry, { PUBLIC_BASE_URL: undefined })
      expect(res.status).not.toBe(0)
      expect(res.status).not.toBeNull()
      expect(res.stderr).toContain('PUBLIC_BASE_URL')
    })

    it.each(['src/app/main.ts', 'src/worker/main.ts'])('%s production thiếu APP_ENCRYPTION_KEYS → không khởi động', (entry) => {
      const res = spawnEntry(entry, { APP_ENCRYPTION_KEYS: undefined, APP_ENCRYPTION_ACTIVE_KEY: undefined })
      expect(res.status).not.toBe(0)
      expect(res.status).not.toBeNull()
      expect(res.stderr).toContain('APP_ENCRYPTION_KEYS')
    })

    it.each(['src/app/main.ts', 'src/worker/main.ts'])('%s CLOUDINARY_URL sai định dạng → không khởi động, nêu tên biến, không chép giá trị', (entry) => {
      const res = spawnEntry(entry, { CLOUDINARY_URL: 'abc-bi-mat-XYZ' })
      expect(res.status).not.toBe(0)
      expect(res.status).not.toBeNull()
      expect(res.stderr).toContain('CLOUDINARY_URL')
      expect(res.stderr + res.stdout).not.toContain('abc-bi-mat-XYZ')
    })

    it.each(['src/app/main.ts', 'src/worker/main.ts'])('%s APP_ENCRYPTION_KEYS sai định dạng → không khởi động, log tên biến, không log khoá', (entry) => {
      const res = spawnEntry(entry, { APP_ENCRYPTION_KEYS: 'k1:bWF5LWxhLWtob2EtY2h1LW5n' })
      expect(res.status).not.toBe(0)
      expect(res.status).not.toBeNull()
      expect(res.stderr).toContain('APP_ENCRYPTION_KEYS')
      expect(res.stderr).not.toContain('bWF5LWxhLWtob2EtY2h1LW5n')
    })

    it.each(['src/app/main.ts', 'src/worker/main.ts'])('%s production dùng Meta Test App → không khởi động', (entry) => {
      const res = spawnEntry(entry, { META_APP_ID: '1234567890', META_APP_ENV: 'test' })
      expect(res.status).not.toBe(0)
      expect(res.status).not.toBeNull()
      expect(res.stderr).toContain('META_APP_ENV')
    })
  })

  describe('APP_ENCRYPTION_KEYS, APP_ENCRYPTION_ACTIVE_KEY (AD-12)', () => {
    const dev = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }
    const prod = {
      ...dev,
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://app.example.com',
      PUBLIC_BASE_URL: 'https://api.example.com',
      WEB_BASE_URL: 'https://app.example.com',
    }

    it('đọc nhiều khoá thành Map keyId → 32 byte; JSON của config không lộ khoá', () => {
      const cfg = parseEnv({ ...dev, APP_ENCRYPTION_KEYS: `k1:${KEY_A}, k2:${KEY_B}`, APP_ENCRYPTION_ACTIVE_KEY: 'k2' })
      expect([...cfg.APP_ENCRYPTION_KEYS!.keys()]).toEqual(['k1', 'k2'])
      expect(cfg.APP_ENCRYPTION_KEYS!.get('k2')).toEqual(Buffer.alloc(32, 2))
      expect(cfg.APP_ENCRYPTION_ACTIVE_KEY).toBe('k2')
      expect(JSON.stringify(cfg)).not.toContain(KEY_A)
    })

    it('production thiếu một trong hai → lỗi nêu tên biến', () => {
      expect(variablesOf(prod)).toEqual(['APP_ENCRYPTION_KEYS', 'APP_ENCRYPTION_ACTIVE_KEY'])
      expect(variablesOf({ ...prod, APP_ENCRYPTION_KEYS: `k1:${KEY_A}` })).toEqual(['APP_ENCRYPTION_ACTIVE_KEY'])
      expect(variablesOf({ ...prod, APP_ENCRYPTION_ACTIVE_KEY: 'k1' })).toEqual(['APP_ENCRYPTION_KEYS'])
      expect(variablesOf({ ...prod, ...PROD_KEYS })).toEqual([])
    })

    it('khoá active phải có trong danh sách', () => {
      expect(variablesOf({ ...prod, APP_ENCRYPTION_KEYS: `k1:${KEY_A}`, APP_ENCRYPTION_ACTIVE_KEY: 'k2' })).toEqual(['APP_ENCRYPTION_ACTIVE_KEY'])
      expect(variablesOf({ ...dev, APP_ENCRYPTION_KEYS: `k1:${KEY_A}`, APP_ENCRYPTION_ACTIVE_KEY: 'k2' })).toEqual(['APP_ENCRYPTION_ACTIVE_KEY'])
    })

    it('không phải base64 của đúng 32 byte / keyId sai / lặp → lỗi APP_ENCRYPTION_KEYS, thông báo không chép khoá', () => {
      const short = Buffer.alloc(16, 3).toString('base64')
      for (const bad of [
        `k1:${short}`,
        'k1:không-phải-base64',
        `k1:${KEY_A.slice(0, -1)}`,
        KEY_A,
        `k:1:${KEY_A}`,
        `k1:${KEY_A},k1:${KEY_B}`,
        ',',
      ]) {
        let error: unknown
        try {
          parseEnv({ ...dev, APP_ENCRYPTION_KEYS: bad, APP_ENCRYPTION_ACTIVE_KEY: 'k1' })
        } catch (err) {
          error = err
        }
        expect(error, bad).toBeInstanceOf(ConfigError)
        expect((error as ConfigError).variables, bad).toEqual(['APP_ENCRYPTION_KEYS'])
        expect((error as ConfigError).message).not.toContain(short)
        expect((error as ConfigError).message).not.toContain(KEY_A.slice(0, 20))
      }
    })

    it('dev: không đặt cả hai → hợp lệ; đặt một nửa → lỗi', () => {
      expect(parseEnv(dev).APP_ENCRYPTION_KEYS).toBeUndefined()
      expect(variablesOf({ ...dev, APP_ENCRYPTION_KEYS: `k1:${KEY_A}` })).toEqual(['APP_ENCRYPTION_ACTIVE_KEY'])
      expect(variablesOf({ ...dev, APP_ENCRYPTION_ACTIVE_KEY: 'k1' })).toEqual(['APP_ENCRYPTION_KEYS'])
    })
  })

  it('từ chối origin có path và bool lạ', () => {
    const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }
    expect(() => parseEnv({ ...base, ALLOWED_ORIGINS: 'https://app.example.com/x' })).toThrow(/ALLOWED_ORIGINS/)
    expect(() => parseEnv({ ...base, COOKIE_SECURE: 'yes' })).toThrow(/COOKIE_SECURE/)
  })

  it('thiếu DATABASE_URL → ConfigError nêu tên biến', () => {
    const run = () => parseEnv({ PORT: '3000' })
    expect(run).toThrow(ConfigError)
    try {
      run()
    } catch (err) {
      expect((err as ConfigError).variables).toEqual(['DATABASE_URL'])
      expect((err as ConfigError).message).toContain('DATABASE_URL')
    }
  })

  it('DATABASE_URL rỗng coi như thiếu; URL không phải postgres bị từ chối', () => {
    expect(() => parseEnv({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/)
    expect(() => parseEnv({ DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/)
  })

  it.each(['src/app/main.ts', 'src/worker/main.ts'])('%s không khởi động khi thiếu DATABASE_URL', (entry) => {
    const env = { ...process.env }
    delete env.DATABASE_URL
    const res = spawnSync(process.execPath, [entry], { cwd: serverDir, env, encoding: 'utf8', timeout: 20_000 })
    expect(res.status).not.toBe(0)
    expect(res.status).not.toBeNull()
    expect(res.stderr).toContain('DATABASE_URL')
  })
})
