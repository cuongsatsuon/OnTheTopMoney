// Env đọc đúng một lần qua zod (Consistency Conventions › Cấu hình).
// Thiếu biến bắt buộc → tiến trình không khởi động, log tên biến, exit ≠ 0.
import { z } from 'zod'
import { MEDIA_ORPHAN_SWEEP_MODES } from '@ottm/shared'

/** Bool từ env: chỉ nhận `true|false|1|0` (z.coerce.boolean coi "false" là true). */
const EnvBool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

/** Danh sách origin cách nhau bởi dấu phẩy, mỗi mục là origin http(s) không có path. */
const OriginList = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .pipe(
    z.array(
      z.url({ protocol: /^https?$/ }).refine((u) => new URL(u).origin === u, 'phải là origin dạng scheme://host[:port]'),
    ),
  )

const isOrigin = (u: string): boolean => URL.canParse(u) && new URL(u).origin === u

/** URL gốc công khai: origin http(s) không path, không dấu `/` cuối (vd `https://app.example.com`). */
const PublicBaseUrl = z
  .url({ protocol: /^https?$/ })
  .refine(isOrigin, 'phải là origin dạng https://host[:port], không path, không dấu / cuối')

/** keyId của khoá chủ: chữ, số, `_`, `-` (khớp `KEY_ID_PATTERN` của adapters/crypto). */
const ENCRYPTION_KEY_ID = /^[A-Za-z0-9_-]{1,32}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * `APP_ENCRYPTION_KEYS` = `<keyId>:<base64 của đúng 32 byte>`, nhiều khoá cách nhau bởi dấu phẩy
 * (để xoay khoá). Kết quả là `Map` keyId → khoá: `JSON.stringify` của Map ra `{}`, nên lỡ log config
 * cũng không lộ khoá. Thông báo lỗi chỉ nêu vị trí mục, không bao giờ chép giá trị.
 */
const EncryptionKeys = z.string().transform((raw, ctx) => {
  const keys = new Map<string, Buffer>()
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (entries.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'cần ít nhất một khoá <keyId>:<base64 32 byte>' })
    return z.NEVER
  }
  for (const [i, entry] of entries.entries()) {
    const colon = entry.indexOf(':')
    const keyId = colon === -1 ? '' : entry.slice(0, colon)
    const b64 = colon === -1 ? '' : entry.slice(colon + 1)
    const where = `mục ${i + 1}`
    if (!ENCRYPTION_KEY_ID.test(keyId)) {
      ctx.addIssue({ code: 'custom', message: `${where}: phải có dạng <keyId>:<base64>, keyId chỉ gồm chữ, số, _ hoặc -` })
      return z.NEVER
    }
    const key = BASE64.test(b64) ? Buffer.from(b64, 'base64') : undefined
    if (!key || key.length !== 32 || key.toString('base64') !== b64) {
      ctx.addIssue({ code: 'custom', message: `${where} (${keyId}): khoá phải là base64 của đúng 32 byte` })
      return z.NEVER
    }
    if (keys.has(keyId)) {
      ctx.addIssue({ code: 'custom', message: `keyId "${keyId}" bị lặp` })
      return z.NEVER
    }
    keys.set(keyId, key)
  }
  return keys as ReadonlyMap<string, Buffer>
})

/** Thông tin đăng nhập Cloudinary tách từ `CLOUDINARY_URL` (AD-14). */
export interface CloudinaryCredentials {
  readonly cloudName: string
  readonly apiKey: string
  readonly apiSecret: string
}

/**
 * `cloudinary://<api_key>:<api_secret>@<cloud_name>` — đúng dòng "API environment variable" của Cloudinary Console.
 * Có thể kèm `?<tuỳ chọn>` (vd `?secure_distribution=…` với tên miền riêng): được nhận nhưng bỏ qua — adapter luôn gọi
 * api.cloudinary.com và dùng `secure_url` Cloudinary trả về.
 */
const CLOUDINARY_URL_RE = /^cloudinary:\/\/([A-Za-z0-9]+):([A-Za-z0-9_-]+)@([A-Za-z0-9_-]+)(?:\?\S*)?$/

/**
 * `CLOUDINARY_URL` → `{cloudName, apiKey, apiSecret}`. Lỗi chỉ nêu dạng mong đợi, không bao giờ chép giá trị.
 * `toJSON` che `apiSecret`: lỡ log/serialize config cũng không lộ secret.
 */
const CloudinaryUrl = z.string().transform((raw, ctx): CloudinaryCredentials => {
  const m = CLOUDINARY_URL_RE.exec(raw.trim())
  if (!m) {
    ctx.addIssue({ code: 'custom', message: 'phải có dạng cloudinary://<api_key>:<api_secret>@<cloud_name> (Cloudinary Console › API Keys)' })
    return z.NEVER
  }
  const [, apiKey, apiSecret, cloudName] = m as unknown as [string, string, string, string]
  return Object.freeze({
    cloudName,
    apiKey,
    apiSecret,
    toJSON: () => ({ cloudName, apiKey, apiSecret: '[REDACTED]' }),
  })
})

/** Thư mục gốc trên Cloudinary: các đoạn chữ, số, `_`, `-` ngăn bởi `/` (vd `ottm`, `ottm-dev/cuong`). */
const CloudinaryFolder = z
  .string()
  .regex(/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/, 'chỉ gồm chữ, số, _ hoặc -, các cấp ngăn bởi /, không / đầu/cuối')

/** Phần cấu hình media (dùng riêng cho `npm run media:check`, không đòi DATABASE_URL). */
const MediaEnvShape = {
  /**
   * Kho ảnh/file Cloudinary (AD-14): `cloudinary://<api_key>:<api_secret>@<cloud_name>`. Tuỳ chọn — thiếu thì
   * adapters/media trả `MEDIA_NOT_CONFIGURED`; sai dạng thì không khởi động.
   */
  CLOUDINARY_URL: CloudinaryUrl.optional(),
  /** Thư mục gốc trên Cloudinary; public_id = `<folder>/<public|private>/<uuidv7>`. */
  CLOUDINARY_FOLDER: CloudinaryFolder.default('ottm'),
}

/** Origin mặc định khi dev (Vite 5173/5174). Production bắt buộc đặt `ALLOWED_ORIGINS`. */
export const DEV_ALLOWED_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://localhost:5174']

/**
 * `PUBLIC_BASE_URL` khi dev không đặt: Vite (proxy `/oauth` sang api) — gốc của `redirect_uri` OAuth.
 * `WEB_BASE_URL` dev không đặt → bằng `PUBLIC_BASE_URL` (web và api cùng origin qua proxy Vite).
 */
export const DEV_PUBLIC_BASE_URL = 'http://localhost:5173'

export const EnvSchema = z
  .object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /**
     * Origin của web (AD-19): được gửi request ghi tới `/api/v1/*` và nhận header CORS có credentials.
     * Cùng VPS: = `PUBLIC_BASE_URL`. Web ở host khác api (Hostinger) → origin của web, vd `https://app.example.com`.
     */
    ALLOWED_ORIGINS: OriginList.optional(),
    /** Tin một hop `X-Forwarded-For` (reverse proxy nginx) để lấy IP thật cho giới hạn đăng nhập. */
    TRUST_PROXY: EnvBool.default(false),
    /** Cookie phiên có cờ `Secure`. */
    COOKIE_SECURE: EnvBool.default(true),
    /**
     * URL HTTPS công khai của api (nginx trên VPS) — gốc cho webhook/OAuth callback. Cùng VPS: tên miền của app
     * (vd `https://app.example.com`); chế độ tách: host api (vd `https://api.example.com`). Bắt buộc khi production.
     */
    PUBLIC_BASE_URL: PublicBaseUrl.optional(),
    /**
     * Origin của web — OAuth callback chuyển chủ shop về đây. Không đặt = `PUBLIC_BASE_URL` (web + api cùng VPS).
     * Chế độ tách (web trên Hostinger, vd `https://app.example.com`): production phải https, nằm trong `ALLOWED_ORIGINS`.
     */
    WEB_BASE_URL: PublicBaseUrl.optional(),
    /** App Meta dùng cho môi trường này (bắt buộc từ Epic 2). */
    META_APP_ID: z.string().regex(/^\d+$/, 'chỉ gồm chữ số').optional(),
    /** `META_APP_ID` là Test App (`test`) hay app thật (`live`). Production chỉ nhận `live`. */
    META_APP_ENV: z.enum(['test', 'live']).optional(),
    /** App secret của `META_APP_ID` — ký `appsecret_proof`, kiểm chữ ký webhook (bắt buộc từ Story 2.2). */
    META_APP_SECRET: z.string().optional(),
    /**
     * Configuration ID của Facebook Login for Business (tuỳ chọn). Có thì hộp thoại dùng `config_id`
     * (quyền khai trong cấu hình ở Meta), không có thì dùng `scope`.
     */
    META_LOGIN_CONFIG_ID: z.string().regex(/^\d+$/, 'chỉ gồm chữ số').optional(),
    /**
     * Chỉ dev: mọi lời gọi Meta đi qua fake (`adapters/meta/fake.ts`), nút kết nối mở trang đồng ý giả cục bộ
     * — thử trọn luồng mà không cần app Meta. Production từ chối khởi động khi bật.
     */
    META_FAKE: EnvBool.default(false),
    /** Phiên bản Graph API mà `adapters/meta` pin (AD-6). */
    META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/, 'phải có dạng vNN.N, vd v26.0').default('v26.0'),
    /** Threads app (OAuth riêng, bắt buộc từ Story 2.3). Dev dùng Threads test app riêng. */
    THREADS_APP_ID: z.string().regex(/^\d+$/, 'chỉ gồm chữ số').optional(),
    THREADS_APP_SECRET: z.string().optional(),
    /** `THREADS_APP_ID` là Threads test app (`test`) hay app thật (`live`). Production chỉ nhận `live`. */
    THREADS_APP_ENV: z.enum(['test', 'live']).optional(),
    /** Chuỗi tự đặt cho bước xác minh webhook của Meta (`hub.verify_token`). */
    META_VERIFY_TOKEN: z.string().min(16, 'ít nhất 16 ký tự').optional(),
    /**
     * Trang chính sách `/privacy/policy` (Story 9.1): tên đơn vị / người vận hành app và email nhận yêu cầu về dữ liệu.
     * Tuỳ chọn — thiếu thì trang hiện chỗ trống đánh dấu "chưa điền" (Meta duyệt app sẽ thấy), api log cảnh báo.
     */
    PRIVACY_CONTROLLER_NAME: z.string().trim().min(1).max(200).optional(),
    PRIVACY_CONTACT_EMAIL: z.email('phải là địa chỉ email').optional(),
    /**
     * Story 9.3: chế độ cron `privacy.orphan_files` (dọn file Cloudinary không còn dòng nào tham chiếu) — `off`, `dry_run`
     * (chỉ đếm), `on`, `force` (bỏ cầu dao tỉ lệ mồ côi). Không đặt → `dry_run` ở MỌI môi trường, kể cả production
     * (quyết định của chủ dự án, review 9.3: đối chiếu báo cáo dry_run với Cloudinary thật rồi mới đặt `on`).
     */
    MEDIA_ORPHAN_SWEEP: z.enum(MEDIA_ORPHAN_SWEEP_MODES).optional(),
    /** Thư mục trên đĩa mà `/healthz` đo dung lượng (mặc định `/` — gốc container; media nằm trên Cloudinary). */
    HEALTH_DISK_PATH: z.string().startsWith('/', 'phải là đường dẫn tuyệt đối').default('/'),
    /** Khoá chủ mã hoá bí mật (AD-12). Bắt buộc khi production; dev do `npm run dev` tự sinh. */
    APP_ENCRYPTION_KEYS: EncryptionKeys.optional(),
    /** keyId trong `APP_ENCRYPTION_KEYS` dùng để mã hoá bản ghi mới. */
    APP_ENCRYPTION_ACTIVE_KEY: z.string().regex(ENCRYPTION_KEY_ID, 'chỉ gồm chữ, số, _ hoặc -').optional(),
    ...MediaEnvShape,
  })
  .superRefine((env, ctx) => {
    // Threads app: id và secret đi cùng nhau (mọi môi trường).
    if (env.THREADS_APP_ID && !env.THREADS_APP_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['THREADS_APP_SECRET'], message: 'bắt buộc khi đặt THREADS_APP_ID' })
    } else if (env.THREADS_APP_SECRET && !env.THREADS_APP_ID) {
      ctx.addIssue({ code: 'custom', path: ['THREADS_APP_ID'], message: 'bắt buộc khi đặt THREADS_APP_SECRET' })
    }
    // Khoá chủ: đặt thì phải đủ cặp, và khoá active phải nằm trong danh sách (mọi môi trường).
    if (env.APP_ENCRYPTION_KEYS && !env.APP_ENCRYPTION_ACTIVE_KEY) {
      ctx.addIssue({ code: 'custom', path: ['APP_ENCRYPTION_ACTIVE_KEY'], message: 'bắt buộc khi đặt APP_ENCRYPTION_KEYS' })
    } else if (env.APP_ENCRYPTION_ACTIVE_KEY && env.APP_ENCRYPTION_KEYS && !env.APP_ENCRYPTION_KEYS.has(env.APP_ENCRYPTION_ACTIVE_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['APP_ENCRYPTION_ACTIVE_KEY'], message: 'phải là một keyId có trong APP_ENCRYPTION_KEYS' })
    }
    if (env.NODE_ENV !== 'production') {
      if (env.APP_ENCRYPTION_ACTIVE_KEY && !env.APP_ENCRYPTION_KEYS) {
        ctx.addIssue({ code: 'custom', path: ['APP_ENCRYPTION_KEYS'], message: 'bắt buộc khi đặt APP_ENCRYPTION_ACTIVE_KEY' })
      }
      return
    }
    if (!env.APP_ENCRYPTION_KEYS) {
      ctx.addIssue({ code: 'custom', path: ['APP_ENCRYPTION_KEYS'], message: 'bắt buộc khi production' })
    }
    if (!env.APP_ENCRYPTION_ACTIVE_KEY && !env.APP_ENCRYPTION_KEYS) {
      ctx.addIssue({ code: 'custom', path: ['APP_ENCRYPTION_ACTIVE_KEY'], message: 'bắt buộc khi production' })
    }
    if (!env.ALLOWED_ORIGINS?.length) {
      ctx.addIssue({ code: 'custom', path: ['ALLOWED_ORIGINS'], message: 'bắt buộc khi production' })
    } else if (env.ALLOWED_ORIGINS.some((o) => !o.startsWith('https://'))) {
      ctx.addIssue({ code: 'custom', path: ['ALLOWED_ORIGINS'], message: 'production chỉ nhận origin https' })
    }
    if (!env.COOKIE_SECURE) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'production không cho phép false' })
    }
    if (!env.PUBLIC_BASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'bắt buộc khi production' })
    } else if (!env.PUBLIC_BASE_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'production chỉ nhận https' })
    }
    // Origin của web (WEB_BASE_URL; không đặt = PUBLIC_BASE_URL — chế độ web + api cùng VPS) phải nằm trong
    // ALLOWED_ORIGINS. Chế độ tách (web ở Hostinger): PUBLIC_BASE_URL là host api, không cần nằm trong danh sách.
    const web = env.WEB_BASE_URL
    if (web !== undefined && web !== env.PUBLIC_BASE_URL) {
      if (!web.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['WEB_BASE_URL'], message: 'production chỉ nhận https' })
      } else if (
        // refine của WEB_BASE_URL không chặn superRefine: chỉ so khi giá trị đã là origin hợp lệ.
        isOrigin(web) &&
        env.ALLOWED_ORIGINS?.length &&
        !env.ALLOWED_ORIGINS.includes(web)
      ) {
        ctx.addIssue({ code: 'custom', path: ['WEB_BASE_URL'], message: 'phải nằm trong ALLOWED_ORIGINS' })
      }
    } else if (
      env.PUBLIC_BASE_URL?.startsWith('https://') &&
      isOrigin(env.PUBLIC_BASE_URL) &&
      env.ALLOWED_ORIGINS?.length &&
      !env.ALLOWED_ORIGINS.includes(env.PUBLIC_BASE_URL)
    ) {
      ctx.addIssue({ code: 'custom', path: ['ALLOWED_ORIGINS'], message: 'phải gồm origin của PUBLIC_BASE_URL (hoặc đặt WEB_BASE_URL)' })
    }
    // Production không được chạy bằng Meta Test App (dữ liệu thật đi vào app thử, review bị bỏ qua).
    if (env.META_APP_ID && env.META_APP_ENV !== 'live') {
      ctx.addIssue({
        code: 'custom',
        path: ['META_APP_ENV'],
        message: env.META_APP_ENV ? 'production không dùng Meta Test App' : 'bắt buộc (live) khi đặt META_APP_ID ở production',
      })
    }
    if (env.META_APP_ID && !env.META_APP_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['META_APP_SECRET'], message: 'bắt buộc khi đặt META_APP_ID ở production' })
    }
    if (env.META_FAKE) {
      ctx.addIssue({ code: 'custom', path: ['META_FAKE'], message: 'production không được bật Meta giả' })
    }
    // Tương tự với Threads test app.
    if (env.THREADS_APP_ID && env.THREADS_APP_ENV !== 'live') {
      ctx.addIssue({
        code: 'custom',
        path: ['THREADS_APP_ENV'],
        message: env.THREADS_APP_ENV ? 'production không dùng Threads test app' : 'bắt buộc (live) khi đặt THREADS_APP_ID ở production',
      })
    }
  })
  .transform((env) => {
    // Production đã bắt buộc đặt (superRefine) — mặc định chỉ áp ngoài production.
    const publicBaseUrl = env.PUBLIC_BASE_URL ?? DEV_PUBLIC_BASE_URL
    return {
      ...env,
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS ?? [...DEV_ALLOWED_ORIGINS],
      PUBLIC_BASE_URL: publicBaseUrl,
      WEB_BASE_URL: env.WEB_BASE_URL ?? publicBaseUrl,
    }
  })

export type Config = z.infer<typeof EnvSchema>

export class ConfigError extends Error {
  readonly variables: string[]
  constructor(issues: { variable: string; message: string }[]) {
    super(`Cấu hình env không hợp lệ: ${issues.map((i) => `${i.variable} (${i.message})`).join(', ')}`)
    this.name = 'ConfigError'
    this.variables = issues.map((i) => i.variable)
  }
}

function parseWith<T extends z.ZodType>(schema: T, env: Record<string, string | undefined>): z.infer<T> {
  // Chuỗi rỗng coi như thiếu.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''))
  const result = schema.safeParse(cleaned)
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        variable: String(issue.path[0] ?? '?'),
        message: issue.message,
      })),
    )
  }
  return result.data
}

/** Kiểm env thuần, không side effect — dùng trong test. */
export function parseEnv(env: Record<string, string | undefined>): Config {
  return parseWith(EnvSchema, env)
}

const MediaEnvSchema = z.object(MediaEnvShape)
export type MediaEnv = z.infer<typeof MediaEnvSchema>

/** Chỉ phần media của env (cùng luật với `parseEnv`) — cho script `media:check`, không cần DATABASE_URL. */
export function parseMediaEnv(env: Record<string, string | undefined>): MediaEnv {
  return parseWith(MediaEnvSchema, env)
}

let cached: Config | undefined

/** Đọc `process.env` lần đầu và cache; lỗi → ghi stderr rồi `process.exit(1)`. */
export function getConfig(): Config {
  if (cached) return cached
  try {
    cached = parseEnv(process.env)
    return cached
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(
        `${JSON.stringify({ level: 'fatal', msg: err.message, missingOrInvalid: err.variables })}\n`,
      )
      process.exit(1)
    }
    throw err
  }
}
