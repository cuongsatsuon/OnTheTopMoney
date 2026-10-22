// Dựng danh sách ứng viên từ phản hồi Meta (Story 2.2): Fanpage từ `/me/accounts`, IG Business liên kết,
// quyền thiếu theo từng trang từ `granular_scopes` của `debug_token`. Threads (Story 2.3): một ứng viên từ hồ sơ
// `/me` + `scopes` của `debug_token`. Thuần, không gọi mạng hay DB.
import {
  INSTAGRAM_REQUIRED_SCOPES,
  META_LOGIN_SCOPES,
  PAGE_REQUIRED_SCOPES,
  THREADS_LOGIN_SCOPES,
  THREADS_REQUIRED_SCOPES,
  type OAuthCandidate,
} from '@ottm/shared'

/** Một mục `granular_scopes` của `debug_token`: không có `target_ids` → quyền áp cho mọi đối tượng. */
export interface GranularScope {
  scope: string
  target_ids?: string[]
}

/** Một Fanpage trong `/me/accounts` (chỉ các trường đã xin qua `fields`). */
export interface MetaPageAccount {
  id: string
  name?: string
  username?: string
  access_token?: string
  picture?: { data?: { url?: string } }
  /** IG Business/Creator đã liên kết Fanpage — dùng được với "Instagram API with Facebook Login". */
  instagram_business_account?: { id: string; username?: string; name?: string; profile_picture_url?: string }
  /** IG liên kết Fanpage nhưng chưa phải tài khoản chuyên nghiệp (không có `instagram_business_account`). */
  connected_instagram_account?: { id: string; username?: string }
}

/** Hồ sơ Threads từ `GET /v1.0/me?fields=id,username,name,threads_profile_picture_url`. */
export interface ThreadsProfile {
  id?: string
  username?: string
  name?: string
  threads_profile_picture_url?: string
}

/**
 * Ứng viên lưu ở `oauth_results.candidates` (nội bộ). `tokenEnvelope` (Fanpage: token Page; Threads: token dài
 * hạn) là envelope — KHÔNG BAO GIỜ trả ra API: `toPublicCandidate` bỏ mọi trường nội bộ.
 */
export interface StoredCandidate extends OAuthCandidate {
  tokenEnvelope?: string
  /** Mốc hết hạn token (giây epoch, kiểu Meta; 0 = không hết hạn) → `page_credentials.expires_at`. Threads: now + expires_in. */
  tokenExpiresAt?: number
  /** Quyền (trong danh sách xin) đã cấp cho riêng đối tượng này → `page_credentials.granular_scopes`. */
  grantedScopes: string[]
  /** `data_access_expires_at` của user token (giây epoch) → `page_credentials`. */
  dataAccessExpiresAt?: number | null
}

export function hasScope(granular: readonly GranularScope[], scope: string, targetId: string): boolean {
  const entry = granular.find((g) => g.scope === scope)
  if (!entry) return false
  return !entry.target_ids || entry.target_ids.includes(targetId)
}

export function missingScopes(granular: readonly GranularScope[], required: readonly string[], targetId: string): string[] {
  return required.filter((s) => !hasScope(granular, s, targetId))
}

function grantedScopes(granular: readonly GranularScope[], targetId: string): string[] {
  return META_LOGIN_SCOPES.filter((s) => hasScope(granular, s, targetId))
}

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])]

function locked(missing: string[]): Pick<OAuthCandidate, 'selectable' | 'missing' | 'reason'> {
  return missing.length === 0 ? { selectable: true, missing } : { selectable: false, missing, reason: 'PERMISSIONS_MISSING' }
}

/**
 * Fanpage + IG liên kết (đứng ngay sau Fanpage của nó). Fanpage không có token Page (người dùng không có vai trò
 * đủ) bị bỏ qua. IG Business thiếu quyền khi thiếu quyền IG của chính nó HOẶC Fanpage nguồn thiếu quyền (token
 * đi theo Fanpage). IG chưa phải Business → khoá `IG_NOT_BUSINESS`.
 */
export function buildCandidates(
  pages: readonly MetaPageAccount[],
  granular: readonly GranularScope[],
  encrypt: (token: string) => string,
): StoredCandidate[] {
  const out: StoredCandidate[] = []
  const seen = new Set<string>()
  for (const page of pages) {
    if (!page.id || !page.access_token || seen.has(`facebook:${page.id}`)) continue
    seen.add(`facebook:${page.id}`)
    const pageMissing = missingScopes(granular, PAGE_REQUIRED_SCOPES, page.id)
    out.push({
      accountId: page.id,
      platform: 'facebook',
      name: page.name ?? page.id,
      handle: page.username ?? null,
      avatarUrl: page.picture?.data?.url ?? null,
      ...locked(pageMissing),
      tokenEnvelope: encrypt(page.access_token),
      grantedScopes: grantedScopes(granular, page.id),
    })

    const ig = page.instagram_business_account
    const personal = page.connected_instagram_account
    if (ig?.id && !seen.has(`instagram:${ig.id}`)) {
      seen.add(`instagram:${ig.id}`)
      out.push({
        accountId: ig.id,
        platform: 'instagram',
        name: ig.name || ig.username || ig.id,
        handle: ig.username ?? null,
        avatarUrl: ig.profile_picture_url ?? null,
        linkedToAccountId: page.id,
        ...locked(union(missingScopes(granular, INSTAGRAM_REQUIRED_SCOPES, ig.id), pageMissing)),
        grantedScopes: grantedScopes(granular, ig.id),
      })
    } else if (!ig && personal?.id && !seen.has(`instagram:${personal.id}`)) {
      seen.add(`instagram:${personal.id}`)
      out.push({
        accountId: personal.id,
        platform: 'instagram',
        // Không xin `username` của IG chưa chuyên nghiệp (trường bị hạn chế) — đặt tên theo Fanpage nguồn.
        name: personal.username || `Instagram của ${page.name ?? page.id}`,
        handle: personal.username ?? null,
        avatarUrl: null,
        linkedToAccountId: page.id,
        selectable: false,
        missing: [],
        reason: 'IG_NOT_BUSINESS',
        grantedScopes: [],
      })
    }
  }
  return out
}

/**
 * Ứng viên Threads duy nhất của lần đăng nhập. `grantedScopes === null` → Threads không trả `data.scopes`:
 * coi như đã cấp đủ những gì đã xin [ASSUMPTION của Story 2.3]. Thiếu quyền bắt buộc → khoá `PERMISSIONS_MISSING`.
 */
export function buildThreadsCandidate(input: {
  accountId: string
  profile: ThreadsProfile
  grantedScopes: readonly string[] | null
  tokenEnvelope: string
  tokenExpiresAt: number
}): StoredCandidate {
  const { accountId, profile, grantedScopes: granted } = input
  const missing = granted ? THREADS_REQUIRED_SCOPES.filter((s) => !granted.includes(s)) : []
  return {
    accountId,
    platform: 'threads',
    name: profile.name || profile.username || accountId,
    handle: profile.username ?? null,
    avatarUrl: profile.threads_profile_picture_url ?? null,
    ...locked(missing),
    tokenEnvelope: input.tokenEnvelope,
    tokenExpiresAt: input.tokenExpiresAt,
    grantedScopes: granted ? THREADS_LOGIN_SCOPES.filter((s) => granted.includes(s)) : [...THREADS_LOGIN_SCOPES],
  }
}

/** Bản trả ra API: chỉ các khoá của `OAuthCandidate` (không token, không quyền nội bộ). */
export function toPublicCandidate(c: StoredCandidate): OAuthCandidate {
  return {
    accountId: c.accountId,
    platform: c.platform,
    name: c.name,
    handle: c.handle,
    avatarUrl: c.avatarUrl,
    ...(c.linkedToAccountId ? { linkedToAccountId: c.linkedToAccountId } : {}),
    selectable: c.selectable,
    missing: c.missing,
    ...(c.reason ? { reason: c.reason } : {}),
  }
}
