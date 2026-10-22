// Meta giả cho dev (`META_FAKE=1`) và test (Story 2.2): mọi lời gọi đi qua `adapters/meta/fake.ts`, không mạng.
// Trang đồng ý giả (`/oauth/facebook/fake-consent`) gửi về callback một `code` giả: `FAKE_CODE.full` (cấp đủ
// quyền) hoặc `FAKE_CODE.noMessaging` (bỏ `pages_messaging` + `instagram_manage_messages`). Biến thể đi theo
// token giả qua từng bước đổi token, nên `debug_token` trả `granular_scopes` tương ứng.
// Dữ liệu: 2 Fanpage — một có IG Business liên kết, một có IG chưa phải tài khoản Business.
// Threads (Story 2.3): client riêng (`createFakeThreads`), trang đồng ý giả `/oauth/threads/fake-consent` gửi
// `FAKE_THREADS_CODE.full` hoặc `.noReplies` (bỏ `threads_read_replies` + `threads_manage_replies`), kèm hậu tố
// `#_` như Threads thật; dữ liệu: 1 tài khoản Threads.
import { randomBytes } from 'node:crypto'
import { META_LOGIN_SCOPES, THREADS_LOGIN_SCOPES } from '@ottm/shared'
import type { MetaResult } from '../../adapters/meta/index.ts'
import { createFakeMetaClient, type FakeMetaCall, type FakeMetaClient } from '../../adapters/meta/fake.ts'
import type { GranularScope, MetaPageAccount } from './candidates.ts'

export const FAKE_APP_ID = '1000000000000000'
export const FAKE_APP_SECRET = 'fake-app-secret'

export const FAKE_CODE = { full: 'fake-code-full', noMessaging: 'fake-code-no-messaging' } as const
type Variant = 'full' | 'nomsg'
const VARIANT_OF_CODE: Record<string, Variant> = { [FAKE_CODE.full]: 'full', [FAKE_CODE.noMessaging]: 'nomsg' }

export const FAKE_USER = { id: '100000000000001', name: 'Chủ shop (Meta giả)' } as const

export const FAKE_PAGES = {
  beauty: { id: '900000000000001', name: 'Mỹ phẩm Lan Anh (giả)', username: 'mypham.lananh' },
  home: { id: '900000000000002', name: 'Gia dụng Minh Phát (giả)', username: 'giadung.minhphat' },
} as const
export const FAKE_IG = {
  /** IG Business liên kết Fanpage `beauty`. */
  business: { id: '17841400000000001', username: 'lananh.beauty', name: 'Lan Anh Beauty' },
  /** IG liên kết Fanpage `home` nhưng chưa phải tài khoản Business. */
  personal: { id: '17841400000000002', username: 'minhphat.canhan' },
} as const

const DAY_S = 86_400
const MESSAGING_SCOPES = new Set(['pages_messaging', 'instagram_manage_messages'])
const IG_SCOPES = new Set(META_LOGIN_SCOPES.filter((s) => s.startsWith('instagram_')))
const PAGE_TARGET_SCOPES = new Set(META_LOGIN_SCOPES.filter((s) => s.startsWith('pages_')))

const rand = () => randomBytes(8).toString('hex')
const variantOfToken = (token: unknown, kind: 'SHORT' | 'LONG'): Variant | null => {
  const m = typeof token === 'string' ? new RegExp(`^FAKE_${kind}_(full|nomsg)_`).exec(token) : null
  return m ? (m[1] as Variant) : null
}

const rejected = (code = 190): MetaResult => ({ ok: false, kind: code === 190 ? 'TOKEN_INVALID' : 'REJECTED', code, status: 400 })

export function fakeGranularScopes(variant: Variant): GranularScope[] {
  const pageIds = [FAKE_PAGES.beauty.id, FAKE_PAGES.home.id]
  return META_LOGIN_SCOPES.filter((s) => variant === 'full' || !MESSAGING_SCOPES.has(s)).map((scope) => {
    if (PAGE_TARGET_SCOPES.has(scope)) return { scope, target_ids: pageIds }
    if (IG_SCOPES.has(scope)) return { scope, target_ids: [FAKE_IG.business.id] }
    return { scope }
  })
}

function fakeAccounts(): MetaPageAccount[] {
  return [
    {
      ...FAKE_PAGES.beauty,
      access_token: `FAKE_PAGE_${FAKE_PAGES.beauty.id}_${rand()}`,
      instagram_business_account: { ...FAKE_IG.business },
    },
    {
      ...FAKE_PAGES.home,
      access_token: `FAKE_PAGE_${FAKE_PAGES.home.id}_${rand()}`,
      connected_instagram_account: { ...FAKE_IG.personal },
    },
  ]
}

/** Client Graph giả đã lập trình cho luồng OAuth; `now` cho mốc hết hạn token. */
export function createFakeMetaGraph(now: () => Date = () => new Date()): FakeMetaClient {
  const graph = createFakeMetaClient()
  program(graph, now)
  return graph
}

/** (Lập trình lại sau `reset()` trong test.) */
export function program(graph: FakeMetaClient, now: () => Date = () => new Date()): void {
  graph.on('GET', '/oauth/access_token', (call: FakeMetaCall) => {
    const p = call.options.params ?? {}
    if (p.client_id !== FAKE_APP_ID || p.client_secret !== FAKE_APP_SECRET) return rejected(101)
    if (p.grant_type === 'fb_exchange_token') {
      const variant = variantOfToken(p.fb_exchange_token, 'SHORT')
      if (!variant) return rejected()
      return { ok: true, data: { access_token: `FAKE_LONG_${variant}_${rand()}`, token_type: 'bearer', expires_in: 60 * DAY_S } }
    }
    const variant = typeof p.code === 'string' ? VARIANT_OF_CODE[p.code] : undefined
    if (!variant) return rejected(100)
    return { ok: true, data: { access_token: `FAKE_SHORT_${variant}_${rand()}`, token_type: 'bearer', expires_in: 3600 } }
  })

  graph.on('GET', '/debug_token', (call: FakeMetaCall) => {
    if (call.options.token !== `${FAKE_APP_ID}|${FAKE_APP_SECRET}`) return rejected()
    const variant = variantOfToken(call.options.params?.input_token, 'LONG')
    if (!variant) return { ok: true, data: { data: { is_valid: false } } }
    const nowS = Math.floor(now().getTime() / 1000)
    const granular = fakeGranularScopes(variant)
    return {
      ok: true,
      data: {
        data: {
          app_id: FAKE_APP_ID,
          type: 'USER',
          is_valid: true,
          user_id: FAKE_USER.id,
          expires_at: nowS + 60 * DAY_S,
          data_access_expires_at: nowS + 90 * DAY_S,
          scopes: granular.map((g) => g.scope),
          granular_scopes: granular,
        },
      },
    }
  })

  graph.on('GET', '/me', (call: FakeMetaCall) =>
    variantOfToken(call.options.token, 'LONG') ? { ok: true, data: { ...FAKE_USER } } : rejected(),
  )

  graph.on('GET', '/me/accounts', (call: FakeMetaCall) =>
    variantOfToken(call.options.token, 'LONG') ? { ok: true, data: { data: fakeAccounts(), paging: { cursors: {} } } } : rejected(),
  )
}

// ---------------------------------------------------------------------------------------------------------
// Threads giả (Story 2.3)
// ---------------------------------------------------------------------------------------------------------

export const FAKE_THREADS_APP_ID = '2000000000000000'
export const FAKE_THREADS_APP_SECRET = 'fake-threads-app-secret'
export const FAKE_THREADS_CODE = { full: 'fake-threads-code-full', noReplies: 'fake-threads-code-no-replies' } as const
type ThreadsVariant = 'full' | 'noreplies'
const THREADS_VARIANT_OF_CODE: Record<string, ThreadsVariant> = {
  [FAKE_THREADS_CODE.full]: 'full',
  [FAKE_THREADS_CODE.noReplies]: 'noreplies',
}
const REPLY_SCOPES = new Set(['threads_read_replies', 'threads_manage_replies'])
/** Hạn token dài hạn Threads (~60 ngày, giây) như tài liệu ví dụ. */
export const FAKE_THREADS_LONG_TTL_S = 5_183_944

export const FAKE_THREADS_USER = {
  id: '25000000000000001',
  username: 'lananh.threads',
  name: 'Lan Anh Threads (giả)',
} as const

const threadsVariantOf = (token: unknown, kind: 'SHORT' | 'LONG'): ThreadsVariant | null => {
  const m = typeof token === 'string' ? new RegExp(`^FAKE_TH_${kind}_(full|noreplies)_`).exec(token) : null
  return m ? (m[1] as ThreadsVariant) : null
}

export function fakeThreadsScopes(variant: ThreadsVariant): string[] {
  return THREADS_LOGIN_SCOPES.filter((s) => variant === 'full' || !REPLY_SCOPES.has(s))
}

/** Client Threads giả đã lập trình cho luồng OAuth Threads. */
export function createFakeThreads(now: () => Date = () => new Date()): FakeMetaClient {
  const threads = createFakeMetaClient('https://graph.threads.com/v1.0')
  programThreads(threads, now)
  return threads
}

/** (Lập trình lại sau `reset()` trong test.) */
export function programThreads(threads: FakeMetaClient, now: () => Date = () => new Date()): void {
  threads.on('POST', '/oauth/access_token', (call: FakeMetaCall) => {
    // Đổi mã nhận form body (`options.form`), không nhận query.
    const p = call.options.form ?? {}
    if (p.client_id !== FAKE_THREADS_APP_ID || p.client_secret !== FAKE_THREADS_APP_SECRET) return rejected(101)
    if (p.grant_type !== 'authorization_code') return rejected(100)
    const variant = typeof p.code === 'string' ? THREADS_VARIANT_OF_CODE[p.code] : undefined
    if (!variant) return rejected(100)
    return { ok: true, data: { access_token: `FAKE_TH_SHORT_${variant}_${rand()}`, user_id: FAKE_THREADS_USER.id } }
  })

  threads.on('GET', '/access_token', (call: FakeMetaCall) => {
    const p = call.options.params ?? {}
    if (p.grant_type !== 'th_exchange_token' || p.client_secret !== FAKE_THREADS_APP_SECRET) return rejected(101)
    const variant = threadsVariantOf(call.options.token, 'SHORT')
    if (!variant) return rejected()
    return { ok: true, data: { access_token: `FAKE_TH_LONG_${variant}_${rand()}`, token_type: 'bearer', expires_in: FAKE_THREADS_LONG_TTL_S } }
  })

  threads.on('GET', '/debug_token', (call: FakeMetaCall) => {
    if (call.options.token !== `TH|${FAKE_THREADS_APP_ID}|${FAKE_THREADS_APP_SECRET}`) return rejected()
    const variant = threadsVariantOf(call.options.params?.input_token, 'LONG')
    if (!variant) return { ok: true, data: { data: { is_valid: false } } }
    const nowS = Math.floor(now().getTime() / 1000)
    return {
      ok: true,
      data: {
        data: {
          app_id: FAKE_THREADS_APP_ID,
          type: 'USER',
          application: 'OnTheTopMoney (giả)',
          is_valid: true,
          user_id: FAKE_THREADS_USER.id,
          issued_at: nowS,
          expires_at: nowS + FAKE_THREADS_LONG_TTL_S,
          scopes: fakeThreadsScopes(variant),
        },
      },
    }
  })

  threads.on('GET', '/me', (call: FakeMetaCall) =>
    threadsVariantOf(call.options.token, 'LONG') ? { ok: true, data: { ...FAKE_THREADS_USER } } : rejected(),
  )
}
