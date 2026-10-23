// Xác nhận trang đã chọn (Story 2.2, AD-5, AD-23). Trong MỘT transaction:
// - lấy (và xoá) `oauth_results` của phiên — xác nhận lại cùng `resultId` thì 404;
// - kiểm từng id có trong kết quả và chọn được; chọn IG thì tự gồm Fanpage nguồn;
// - `pages.upsertFromPlatform` (tạo mới hoặc khôi phục đúng dòng cũ) + `setConnectionStatus('active')`;
// - lưu `page_credentials`: Fanpage giữ envelope token Page, IG trỏ `token_source_page_id` về Fanpage, Threads
//   giữ envelope token dài hạn của chính nó kèm `expires_at` (Story 2.3; không có `meta_accounts`);
// - phát `page.connected` (trang mới) / `page.reconnected` (dòng đã gỡ hoặc mất kết nối); trang đang hoạt động
//   được xác nhận lại chỉ làm mới token, giữ `connected_at`, không phát sự kiện;
// - enqueue `connections.subscribe_page` cho MỌI trang vừa upsert (kể cả trang `active` xác nhận lại) — Story 4.2,
//   AD-2: job chỉ tồn tại khi transaction commit. Không gọi Meta trong request/transaction.
import type { ConfirmConnectionsRequest, ConfirmConnectionsResponse, PageDto } from '@ottm/shared'
import { and, eq, gt, sql } from 'drizzle-orm'
import { AppError } from '../../platform/errors/index.ts'
import { setConnectionStatus, upsertFromPlatform } from '../pages/index.ts'
import type { StoredCandidate } from './candidates.ts'
import type { ConnectionsDeps } from './deps.ts'
import { oauthResults, pageCredentials } from './schema.ts'
import { enqueueSubscribePage } from './subscribe.ts'

/** Page token lấy từ user token dài hạn không hết hạn → `expires_at = 0` (quy ước của Meta). */
const PAGE_TOKEN_EXPIRES_AT = 0

function invalid(accountId: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', 400, { message, details: [{ path: ['accountIds'], accountId, message }] })
}

export async function confirmConnections(
  deps: Pick<ConnectionsDeps, 'db' | 'events' | 'jobs' | 'now'>,
  input: { sessionId: string; request: ConfirmConnectionsRequest },
): Promise<ConfirmConnectionsResponse> {
  const { resultId, accountIds } = input.request
  const now = deps.now?.() ?? new Date()
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .delete(oauthResults)
      .where(and(eq(oauthResults.id, resultId), eq(oauthResults.sessionId, input.sessionId), gt(oauthResults.expiresAt, now)))
      .returning()
    if (!row || row.status !== 'ok') throw new AppError('NOT_FOUND', 404, { message: 'Kết quả kết nối không tồn tại hoặc đã hết hạn' })

    const candidates = row.candidates as StoredCandidate[]
    const byId = new Map(candidates.map((c) => [c.accountId, c]))
    const chosen = new Set<string>()
    for (const id of accountIds) {
      const c = byId.get(id)
      if (!c) throw invalid(id, 'không có trong kết quả kết nối')
      if (!c.selectable) throw invalid(id, c.reason ?? 'không chọn được')
      chosen.add(id)
      if (c.platform === 'instagram') {
        const source = c.linkedToAccountId ? byId.get(c.linkedToAccountId) : undefined
        if (!source || !source.selectable) throw invalid(id, 'Fanpage nguồn không chọn được')
        chosen.add(source.accountId)
      }
    }

    // Fanpage trước để IG biết id trang nguồn.
    const ordered = candidates
      .filter((c) => chosen.has(c.accountId))
      .sort((a, b) => Number(a.platform !== 'facebook') - Number(b.platform !== 'facebook'))
    const pageIdOfAccount = new Map<string, string>()
    const out: PageDto[] = []

    for (const c of ordered) {
      const upserted = await upsertFromPlatform(tx, {
        platform: c.platform,
        platformAccountId: c.accountId,
        name: c.name,
        handle: c.handle,
        avatarUrl: c.avatarUrl,
      })
      const page = (await setConnectionStatus(tx, upserted.page.id, 'active', null)) ?? upserted.page
      pageIdOfAccount.set(c.accountId, page.id)

      let token: { accessToken: string; tokenSourcePageId: null } | { accessToken: null; tokenSourcePageId: string }
      if (c.platform === 'instagram') {
        const sourcePageId = c.linkedToAccountId ? pageIdOfAccount.get(c.linkedToAccountId) : undefined
        if (!sourcePageId) throw new AppError('INTERNAL', 500, { message: 'thiếu Fanpage nguồn của IG' })
        token = { accessToken: null, tokenSourcePageId: sourcePageId }
      } else {
        // Fanpage: token Page; Threads: token dài hạn của tài khoản Threads.
        if (!c.tokenEnvelope) throw new AppError('INTERNAL', 500, { message: `ứng viên ${c.platform} thiếu token` })
        token = { accessToken: c.tokenEnvelope, tokenSourcePageId: null }
      }
      const values = {
        metaAccountId: c.platform === 'threads' ? null : row.metaAccountId,
        ...token,
        expiresAt: c.tokenExpiresAt ?? PAGE_TOKEN_EXPIRES_AT,
        dataAccessExpiresAt: c.dataAccessExpiresAt ?? null,
        granularScopes: c.grantedScopes,
      }
      await tx
        .insert(pageCredentials)
        .values({ pageId: page.id, ...values })
        .onConflictDoUpdate({ target: pageCredentials.pageId, set: { ...values, updatedAt: sql`now()` } })

      // Trang mới → `page.connected`; trang quay lại sau khi gỡ / mất kết nối / sắp hết hạn → `page.reconnected`
      // (Story 2.4: kết nối lại một trang `expiring` cũng là khôi phục); trang đang hoạt động được xác nhận lại
      // (chỉ làm mới token) → không phát sự kiện.
      const event = upserted.created
        ? 'page.connected'
        : upserted.wasRemoved || (upserted.previousStatus !== null && upserted.previousStatus !== 'active')
          ? 'page.reconnected'
          : null
      if (event) await deps.events.publishEvent(tx, event, { id: page.id, pageId: page.id })
      await enqueueSubscribePage(tx, deps.jobs, page.id)
      out.push(page)
    }
    return { pages: out }
  })
}
