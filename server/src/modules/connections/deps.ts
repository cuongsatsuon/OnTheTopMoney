// Phụ thuộc của luồng kết nối trang (Story 2.2 Facebook/IG, Story 2.3 Threads). Entrypoint (api) dựng một lần rồi truyền vào mọi hàm.
import type { SecretCipher } from '../../adapters/crypto/index.ts'
import type { MetaClient } from '../../adapters/meta/index.ts'
import type { Config } from '../../platform/config/index.ts'
import type { Db } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import type { JobSender } from '../../platform/jobs/index.ts'

export type ConnectionsConfig = Pick<
  Config,
  | 'META_APP_ID'
  | 'META_APP_SECRET'
  | 'META_LOGIN_CONFIG_ID'
  | 'META_GRAPH_VERSION'
  | 'META_FAKE'
  | 'PUBLIC_BASE_URL'
  | 'WEB_BASE_URL'
  | 'THREADS_APP_ID'
  | 'THREADS_APP_SECRET'
>

/** Logger tối thiểu (pino tương thích). Không bao giờ nhận token, code hay URL có query. */
export interface ConnectionsLogger {
  warn(obj: Record<string, unknown>, msg: string): void
  info(obj: Record<string, unknown>, msg: string): void
}

export interface ConnectionsDeps {
  db: Db
  events: EventPublisher
  /** Enqueue job (Story 4.2: `connections.subscribe_page` trong transaction xác nhận — AD-2). */
  jobs: JobSender
  /** `null` khi máy chủ chưa có `APP_ENCRYPTION_KEYS` → không lưu được token (`ENCRYPTION_NOT_CONFIGURED`). */
  cipher: SecretCipher | null
  /** Client Graph (`createMetaClients().graph`; fake khi `META_FAKE=1`). */
  graph: MetaClient
  /**
   * Client Threads (`createMetaClients().threads`; fake khi `META_FAKE=1`). `undefined` khi chưa đặt cặp
   * `THREADS_APP_ID` / `THREADS_APP_SECRET` → bắt đầu kết nối Threads trả `META_NOT_CONFIGURED`.
   */
  threads?: MetaClient | undefined
  config: ConnectionsConfig
  log?: ConnectionsLogger
  /** Đồng hồ cho TTL `oauth_states` / `oauth_results` (test). */
  now?: () => Date
}
