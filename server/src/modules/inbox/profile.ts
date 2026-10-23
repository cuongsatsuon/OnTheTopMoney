// Tên khách từ Meta (Story 4.3): webhook chỉ mang PSID/IGSID, nên định danh mới được enqueue job
// `inbox.fetch_profile` (trong transaction ingest). Job lấy token bằng `connections.getAccessToken` ngay trước khi
// gọi (AD-5), gọi Graph `GET /{PSID}` (Messenger: `first_name,last_name,name`) hoặc `GET /{IGSID}` (Instagram:
// `name,username`) qua `adapters/meta`.
// - Chỉ điền `contacts.name` khi còn trống (không ghi đè tên chủ shop đã sửa ở Story 4.9) → phát `contact.updated`.
// - `RATE_LIMITED`/`TRANSIENT` → ném để retry; lần thử cuối và lỗi khác (thiếu quyền, người dùng chặn…) → bỏ qua,
//   chỉ ghi `profile_fetched_at`. Trang đã gỡ/mất kết nối → bỏ qua. Không log tên hay token.
import { and, eq, isNull } from 'drizzle-orm'
import type { SecretCipher } from '../../adapters/crypto/index.ts'
import type { MetaClient } from '../../adapters/meta/index.ts'
import type { Db } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { getAccessToken } from '../connections/index.ts'
import { getPage, getPlatformAccountId } from '../pages/index.ts'
import { contactIdentities, contacts } from './schema.ts'

export interface FetchProfileDeps {
  db: Db
  events: EventPublisher
  cipher: SecretCipher | null
  graph: MetaClient
  log?: { warn(obj: Record<string, unknown>, msg: string): void }
}

export type FetchProfileOutcome = 'updated' | 'unchanged' | 'skipped'

export class ProfileRetryableError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`inbox.fetch_profile: ${kind}`)
    this.name = 'ProfileRetryableError'
    this.kind = kind
  }
}

/** Độ dài tối đa tên lưu (phòng dữ liệu lạ). */
const NAME_MAX = 200

const clean = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim().slice(0, NAME_MAX)
  return s === '' ? null : s
}

interface ProfilePayload {
  name?: unknown
  first_name?: unknown
  last_name?: unknown
  username?: unknown
}

/** Phản hồi Graph → `{name, username}`. Messenger thiếu `name` thì ghép họ tên. */
export function profileFromGraph(data: ProfilePayload | null | undefined): { name: string | null; username: string | null } {
  const joined = [clean(data?.first_name), clean(data?.last_name)].filter(Boolean).join(' ')
  return { name: clean(data?.name) ?? clean(joined), username: clean(data?.username) }
}

export async function fetchProfile(deps: FetchProfileDeps, identityId: string, opts: { finalAttempt: boolean }): Promise<FetchProfileOutcome> {
  const [identity] = await deps.db.select().from(contactIdentities).where(eq(contactIdentities.id, identityId))
  if (!identity || identity.profileFetchedAt) return 'skipped'
  const markFetched = async () => {
    await deps.db.update(contactIdentities).set({ profileFetchedAt: new Date() }).where(eq(contactIdentities.id, identityId))
  }

  const page = await getPage(deps.db, identity.pageId)
  if (!page || page.connectionStatus === 'disconnected' || page.platform === 'threads') {
    await markFetched()
    return 'skipped'
  }
  const pagePlatformId = await getPlatformAccountId(deps.db, page.id)
  let token: string
  try {
    token = await getAccessToken({ db: deps.db, cipher: deps.cipher }, page.id)
  } catch (err) {
    if (err instanceof AppError && (err.code === 'PAGE_REMOVED' || err.code === 'PAGE_DISCONNECTED')) {
      await markFetched()
      return 'skipped'
    }
    throw err
  }

  const res = await deps.graph.get<ProfilePayload>(`/${identity.platformUserId}`, {
    token,
    tier: 'background',
    scope: `page:${pagePlatformId ?? page.id}`,
    params: { fields: page.platform === 'instagram' ? 'name,username' : 'first_name,last_name,name' },
  })
  if (!res.ok) {
    if ((res.kind === 'RATE_LIMITED' || res.kind === 'TRANSIENT') && !opts.finalAttempt) throw new ProfileRetryableError(res.kind)
    deps.log?.warn({ identityId, pageId: page.id, kind: res.kind }, 'inbox: không lấy được tên khách từ Meta')
    await markFetched()
    return 'skipped'
  }

  const profile = profileFromGraph(res.data)
  return deps.db.transaction(async (tx): Promise<FetchProfileOutcome> => {
    await tx
      .update(contactIdentities)
      .set({ displayName: profile.name, username: profile.username, profileFetchedAt: new Date() })
      .where(eq(contactIdentities.id, identityId))
    const name = profile.name ?? (profile.username ? `@${profile.username}` : null)
    if (!name) return 'unchanged'
    // Chỉ điền khi còn trống — không ghi đè tên đã có.
    const [updated] = await tx
      .update(contacts)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(contacts.id, identity.contactId), isNull(contacts.name)))
      .returning({ id: contacts.id })
    if (!updated) return 'unchanged'
    await deps.events.publishEvent(tx, 'contact.updated', { id: updated.id, pageId: page.id })
    return 'updated'
  })
}

export function parseFetchProfileJobData(data: unknown): { identityId: string } {
  const id = (data as { identityId?: unknown } | null)?.identityId
  if (typeof id !== 'string' || id === '') throw new Error('inbox.fetch_profile: thiếu identityId')
  return { identityId: id }
}

/** Handler job `inbox.fetch_profile` cho worker: lần thử cuối gặp lỗi tạm → bỏ qua thay vì ném. */
export async function handleFetchProfileJob(
  deps: FetchProfileDeps,
  job: { data: unknown; retryCount: number; retryLimit: number },
): Promise<FetchProfileOutcome> {
  const { identityId } = parseFetchProfileJobData(job.data)
  return fetchProfile(deps, identityId, { finalAttempt: job.retryCount >= job.retryLimit })
}
