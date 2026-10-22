// Dựng phụ thuộc của api từ config — tách khỏi main.ts để test được mà không khởi động tiến trình.
import { createSecretCipher, type SecretCipher } from '../adapters/crypto/index.ts'
import { createMediaStores, type MediaStores } from '../adapters/media/index.ts'
import { createMetaClients, type ConnectionsDeps } from '../modules/connections/index.ts'
import type { Config } from '../platform/config/index.ts'
import type { Db } from '../platform/db/index.ts'
import type { Logger } from '../platform/log/index.ts'

/**
 * Bộ mã hoá bí mật từ `APP_ENCRYPTION_KEYS` + `APP_ENCRYPTION_ACTIVE_KEY`. Config đã bảo đảm production
 * luôn có cặp hợp lệ; dev không đặt (không chạy qua `npm run dev`) → `null` (lưu khoá trả
 * `ENCRYPTION_NOT_CONFIGURED`).
 */
export function cipherFromConfig(config: Pick<Config, 'APP_ENCRYPTION_KEYS' | 'APP_ENCRYPTION_ACTIVE_KEY'>): SecretCipher | null {
  if (!config.APP_ENCRYPTION_KEYS || !config.APP_ENCRYPTION_ACTIVE_KEY) return null
  return createSecretCipher({ keys: config.APP_ENCRYPTION_KEYS, activeKeyId: config.APP_ENCRYPTION_ACTIVE_KEY })
}

/** Kho ảnh/file Cloudinary (AD-14) từ config cho logo hồ sơ (Story 3.1); thiếu `CLOUDINARY_URL` → kho chưa cấu hình. */
export function mediaStoresFromConfig(config: Pick<Config, 'CLOUDINARY_URL' | 'CLOUDINARY_FOLDER'>): MediaStores {
  return createMediaStores({ CLOUDINARY_URL: config.CLOUDINARY_URL, CLOUDINARY_FOLDER: config.CLOUDINARY_FOLDER })
}

/** Phần `ai` của `buildApp` cho entrypoint thật. */
export function aiOptionsFromConfig(config: Pick<Config, 'APP_ENCRYPTION_KEYS' | 'APP_ENCRYPTION_ACTIVE_KEY'>): { cipher: SecretCipher | null } {
  return { cipher: cipherFromConfig(config) }
}

/**
 * Phần `connections` của `buildApp` (Story 2.2, 2.3): client Graph + Threads dựng từ config (fake khi `META_FAKE=1`),
 * mã hoá token bằng cùng khoá chủ với khoá OpenAI.
 */
export function connectionsOptionsFromConfig(
  config: Config,
  db: Db,
  logger: Logger,
): Omit<ConnectionsDeps, 'db' | 'events' | 'log'> {
  const { graph, threads } = createMetaClients({ config, db, log: logger.child({ component: 'meta' }) })
  return {
    graph,
    threads,
    cipher: cipherFromConfig(config),
    config: {
      META_APP_ID: config.META_APP_ID,
      META_APP_SECRET: config.META_APP_SECRET,
      META_LOGIN_CONFIG_ID: config.META_LOGIN_CONFIG_ID,
      META_GRAPH_VERSION: config.META_GRAPH_VERSION,
      META_FAKE: config.META_FAKE,
      PUBLIC_BASE_URL: config.PUBLIC_BASE_URL,
      WEB_BASE_URL: config.WEB_BASE_URL,
      THREADS_APP_ID: config.THREADS_APP_ID,
      THREADS_APP_SECRET: config.THREADS_APP_SECRET,
    },
  }
}
