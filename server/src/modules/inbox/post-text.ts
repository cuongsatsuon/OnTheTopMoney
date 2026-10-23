// Caption bài được bình luận (Story 4.4, AD-16): hội thoại `comment` mới enqueue job `inbox.fetch_post_text` trong
// transaction ingest. Job lấy token bằng `connections.getAccessToken` ngay trước khi gọi (AD-5) rồi đọc caption qua
// `adapters/meta` một lần: FB `GET /{post}?fields=message`, IG `GET /{media}?fields=caption`, Threads
// `GET /{media}?fields=text`. Lưu ở `conversations.post_text_snapshot` để prompt autoreply bình luận (Epic 5) đọc,
// không gọi `content`.
// - Chỉ điền khi còn trống, cắt `POST_TEXT_MAX` ký tự → phát `conversation.updated` (web hiện dòng bài).
// - `RATE_LIMITED`/`TRANSIENT` → ném để retry; lần thử cuối và lỗi khác (bài đã xoá, thiếu quyền…) → bỏ qua, chỉ ghi
//   `post_text_fetched_at`. Trang đã gỡ/mất kết nối, thiếu client Threads → bỏ qua. Không log caption hay token.
// - Story 4.7: `TOKEN_INVALID` → `markDisconnected` trang giữ token (`meta-token.ts`, chung với `inbox.send`), rồi bỏ qua.
import { and, eq, isNull } from 'drizzle-orm'
import type { SecretCipher } from '../../adapters/crypto/index.ts'
import type { MetaClient } from '../../adapters/meta/index.ts'
import type { Db } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { getAccessToken } from '../connections/index.ts'
import { getPage, getPlatformAccountId } from '../pages/index.ts'
import { reportTokenInvalid } from './meta-token.ts'
import { conversations } from './schema.ts'

export interface FetchPostTextDeps {
  db: Db
  events: EventPublisher
  cipher: SecretCipher | null
  graph: MetaClient
  /** Client Threads; `undefined` khi chưa cấu hình app Threads → bỏ qua bài Threads. */
  threads?: MetaClient | undefined
  log?: { warn(obj: Record<string, unknown>, msg: string): void }
}

export type FetchPostTextOutcome = 'updated' | 'unchanged' | 'skipped'

/** Độ dài tối đa caption lưu — đủ cho prompt, chặn bài rất dài. */
export const POST_TEXT_MAX = 2000

export class PostTextRetryableError extends Error {
  readonly kind: string
  constructor(kind: string) {
    super(`inbox.fetch_post_text: ${kind}`)
    this.name = 'PostTextRetryableError'
    this.kind = kind
  }
}

interface PostPayload {
  message?: unknown
  caption?: unknown
  text?: unknown
}

/** Phản hồi Graph/Threads → caption (cắt `POST_TEXT_MAX`); bài không có chữ → `null`. */
export function postTextFromGraph(data: PostPayload | null | undefined): string | null {
  const raw = [data?.message, data?.caption, data?.text].find((v) => typeof v === 'string' && v.trim() !== '')
  return typeof raw === 'string' ? raw.trim().slice(0, POST_TEXT_MAX) : null
}

export async function fetchPostText(deps: FetchPostTextDeps, conversationId: string, opts: { finalAttempt: boolean }): Promise<FetchPostTextOutcome> {
  const [conv] = await deps.db.select().from(conversations).where(eq(conversations.id, conversationId))
  if (!conv || !conv.platformPostId || conv.postTextFetchedAt || conv.postTextSnapshot !== null) return 'skipped'
  const markFetched = async () => {
    await deps.db.update(conversations).set({ postTextFetchedAt: new Date() }).where(eq(conversations.id, conversationId))
  }

  const page = await getPage(deps.db, conv.pageId)
  const client = page?.platform === 'threads' ? deps.threads : deps.graph
  if (!page || page.connectionStatus === 'disconnected' || !client) {
    await markFetched()
    return 'skipped'
  }
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

  const field = page.platform === 'facebook' ? 'message' : page.platform === 'instagram' ? 'caption' : 'text'
  const scope = page.platform === 'threads' ? `threads:${page.id}` : `page:${(await getPlatformAccountId(deps.db, page.id)) ?? page.id}`
  const res = await client.get<PostPayload>(`/${conv.platformPostId}`, { token, tier: 'background', scope, params: { fields: field } })
  if (!res.ok) {
    if ((res.kind === 'RATE_LIMITED' || res.kind === 'TRANSIENT') && !opts.finalAttempt) throw new PostTextRetryableError(res.kind)
    if (res.kind === 'TOKEN_INVALID') await reportTokenInvalid(deps, page.id)
    deps.log?.warn({ conversationId, pageId: page.id, kind: res.kind }, 'inbox: không lấy được caption bài từ Meta')
    await markFetched()
    return 'skipped'
  }

  const text = postTextFromGraph(res.data)
  return deps.db.transaction(async (tx): Promise<FetchPostTextOutcome> => {
    const [updated] = await tx
      .update(conversations)
      .set({ postTextSnapshot: text, postTextFetchedAt: new Date() })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.postTextSnapshot)))
      .returning({ id: conversations.id })
    if (!updated || text === null) return 'unchanged'
    await deps.events.publishEvent(tx, 'conversation.updated', { id: conversationId, pageId: page.id })
    return 'updated'
  })
}

export function parseFetchPostTextJobData(data: unknown): { conversationId: string } {
  const id = (data as { conversationId?: unknown } | null)?.conversationId
  if (typeof id !== 'string' || id === '') throw new Error('inbox.fetch_post_text: thiếu conversationId')
  return { conversationId: id }
}

/** Handler job `inbox.fetch_post_text` cho worker: lần thử cuối gặp lỗi tạm → bỏ qua thay vì ném. */
export async function handleFetchPostTextJob(
  deps: FetchPostTextDeps,
  job: { data: unknown; retryCount: number; retryLimit: number },
): Promise<FetchPostTextOutcome> {
  const { conversationId } = parseFetchPostTextJobData(job.data)
  return fetchPostText(deps, conversationId, { finalAttempt: job.retryCount >= job.retryLimit })
}
