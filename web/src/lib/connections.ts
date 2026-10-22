// Kết nối Fanpage + Instagram Business (Story 2.2) và Threads (Story 2.3) phía web. Luồng:
// 1. `useStartConnect` ({provider, from}) → server trả URL cửa sổ Meta / Threads (hoặc trang đồng ý giả) →
//    chuyển hướng toàn trang.
// 2. Meta/Threads → callback của server → server chuyển về `/trang-nhom?ket-noi=<id>` (hoặc `/bat-dau?…`);
//    Threads thêm `&nen-tang=threads`.
// 3. `useOAuthResult(id)` đọc ứng viên (không có token) → chủ shop chọn → `useConfirmConnections`.
// Danh sách trang: `usePages` (khoá `['pages']` — sự kiện `page.*` realtime vô hiệu hoá và refetch).
import {
  CONNECT_PROVIDER_PARAM,
  ConfirmConnectionsResponse,
  ListPagesResponse,
  META_LOGIN_SCOPES,
  OAuthProvider,
  OAuthResultResponse,
  StartConnectResponse,
  THREADS_LOGIN_SCOPES,
  type ConnectFrom,
  type ConnectionStatus,
  type OAuthCandidate,
  type PageDto,
  type Platform,
} from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { pages as mockPages, type Page } from '../data/mock'
import { apiFetch } from './api'

export const PAGES_KEY = ['pages'] as const
export const oauthResultKey = (id: string) => ['connections', 'oauth-result', id] as const

/** Tham số URL mà callback OAuth của server đặt khi chuyển về app. */
export const CONNECT_RESULT_PARAM = 'ket-noi'
export const CONNECT_ERROR_PARAM = 'ket-noi-loi'
/** Nền tảng của kết quả (chỉ Threads đặt; thiếu = Facebook) — để "Thử lại" đúng luồng khi kết quả đã hết hạn. */
export { CONNECT_PROVIDER_PARAM }

/** Giá trị `nen-tang` trên URL → nhà cung cấp OAuth (lạ / thiếu → Facebook). */
export function providerFromParam(value: string | null): OAuthProvider {
  return OAuthProvider.safeParse(value).data ?? 'facebook'
}

/** Nền tảng của bước chọn: theo kết quả đã đọc, chưa đọc được (đang tải / hết hạn) → theo URL. */
export function resultProvider(data: { provider: OAuthProvider } | undefined, hint: OAuthProvider): OAuthProvider {
  return data?.provider ?? hint
}

/**
 * Meta/Threads nối `#_` (Threads) hoặc `#_=_` (Facebook) vào URL callback; server đè bằng fragment rỗng `#`.
 * Bỏ phần đuôi đó khỏi thanh địa chỉ (không đổi lịch sử, giữ state của router). Trả `true` khi đã bỏ.
 */
export function stripOAuthFragment(
  loc: Pick<Location, 'href' | 'hash' | 'pathname' | 'search'> = window.location,
  history: Pick<History, 'replaceState' | 'state'> = window.history,
): boolean {
  if (!loc.href.endsWith('#') && !/^#_(=_)?$/.test(loc.hash)) return false
  history.replaceState(history.state, '', `${loc.pathname}${loc.search}`)
  return true
}

/** Trang Facebook và Instagram kết nối qua cửa sổ Meta; Threads qua OAuth riêng. */
export function providerOfPlatform(platform: Platform): OAuthProvider {
  return platform === 'threads' ? 'threads' : 'facebook'
}

/** Tên cửa sổ đăng nhập hiển thị khi đang chuyển hướng. */
export const PROVIDER_LABEL: Record<OAuthProvider, string> = { facebook: 'Meta', threads: 'Threads' }

/**
 * Trang thật. Mỗi lần tải xong, danh sách được chép vào kho mẫu `mock.pages` (`mirrorRealPages`) để các màn
 * còn đọc dữ liệu mẫu (Chi tiết trang, Chi tiết nhóm, bộ chọn phạm vi…) thấy trang thật cho tới khi story của
 * chúng chuyển sang API.
 */
export function usePages(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: PAGES_KEY,
    queryFn: async ({ signal }) => {
      const data = await apiFetch('/pages', { schema: ListPagesResponse, signal })
      mirrorRealPages(data.items)
      return data
    },
    select: (data) => data.items,
    enabled: options.enabled ?? true,
  })
}

/** Id các trang thật đã chép vào kho mẫu (để gỡ khi server không còn trả về). */
const mirroredIds = new Set<string>()

/**
 * Chép trang thật vào kho mẫu: thêm trang mới, cập nhật tên/handle/trạng thái của trang đã có nhưng GIỮ các
 * trường chỉ có ở giao diện mẫu (nhóm, AI trả lời, hồ sơ, màu avatar); bỏ trang thật không còn trong danh sách.
 * Trang mẫu sẵn có (p1…p8) không bị đụng tới.
 */
export function mirrorRealPages(dtos: readonly PageDto[], store: Page[] = mockPages, known: Set<string> = mirroredIds): void {
  const incoming = new Set(dtos.map((d) => d.id))
  for (let i = store.length - 1; i >= 0; i--) {
    const id = store[i]!.id
    if (known.has(id) && !incoming.has(id)) {
      store.splice(i, 1)
      known.delete(id)
    }
  }
  for (const dto of dtos) {
    const fresh = toUiPage(dto)
    const i = store.findIndex((p) => p.id === dto.id)
    if (i === -1) store.push(fresh)
    else {
      // `groupId` do server sở hữu (Story 2.5) → lấy theo `fresh`. AI trả lời / màu avatar còn ở giao diện mẫu
      // (Epic 3, 5) → giữ overlay cũ. Trang rời nhóm (groupId=null) thì không thể "theo nhóm" → brandSource về
      // 'own' (giữ hành vi tới Epic 3).
      const old = store[i]!
      store[i] = {
        ...fresh,
        autoReply: old.autoReply,
        brandSource: fresh.groupId === null ? 'own' : old.brandSource,
        avatarColor: old.avatarColor,
      }
    }
    known.add(dto.id)
  }
}

/** Ghi thay đổi chỉ-giao-diện (nhóm, AI trả lời, hồ sơ) của trang vào kho mẫu (thay object để React thấy đổi). */
export function patchMockPages(ids: readonly string[], patch: (p: Page) => Partial<Page>, store: Page[] = mockPages): void {
  for (let i = 0; i < store.length; i++) {
    const p = store[i]!
    if (ids.includes(p.id)) store[i] = { ...p, ...patch(p) }
  }
}

/** Hàng bảng của trang thật: bản trong kho mẫu (kèm thay đổi giao diện) hoặc bản dựng từ API. */
export function uiPageOf(dto: PageDto, store: readonly Page[] = mockPages): Page {
  return store.find((p) => p.id === dto.id) ?? toUiPage(dto)
}

/** Chuyển hướng toàn trang (tách ra để test thay được). */
export const browser = {
  assign(url: string) {
    window.location.assign(url)
  },
}

export interface StartConnectInput {
  provider: OAuthProvider
  from: ConnectFrom
  /** Có → kết nối lại (Story 2.4): server gắn `intent=reconnect:<pageId>` + `auth_type=reauthorize`, cập nhật đúng dòng trang đó. */
  pageId?: string
}

/** Bắt đầu OAuth: thành công → rời app sang cửa sổ Meta / Threads (hoặc trang đồng ý giả khi dev). */
export function useStartConnect() {
  return useMutation({
    mutationFn: ({ provider, from, pageId }: StartConnectInput) =>
      apiFetch(`/connections/${provider}/start`, {
        method: 'POST',
        body: { from, ...(pageId ? { pageId } : {}) },
        schema: StartConnectResponse,
      }),
    onSuccess: ({ url }) => browser.assign(url),
  })
}

/** Trang cần nút "Kết nối lại" khi không còn hoạt động (chip vàng/đỏ). */
export function needsReconnect(status: ConnectionStatus): boolean {
  return status !== 'active'
}

/**
 * Tham số bắt đầu kết nối lại một trang (Story 2.4): đúng nền tảng của trang, giữ `pageId` để server khôi phục
 * đúng dòng. `from` = màn đang hiển thị nút (callback đưa chủ shop về đó).
 */
export function reconnectInput(page: { id: string; platform: Platform }, from: ConnectFrom): StartConnectInput {
  return { provider: providerOfPlatform(page.platform), from, pageId: page.id }
}

export function useOAuthResult(resultId: string | null) {
  return useQuery({
    queryKey: oauthResultKey(resultId ?? ''),
    queryFn: ({ signal }) => apiFetch(`/connections/oauth-results/${encodeURIComponent(resultId!)}`, { schema: OAuthResultResponse, signal }),
    enabled: !!resultId,
    // Kết quả dùng một lần (xác nhận xong bị xoá) — không refetch ngầm.
    staleTime: Infinity,
    retry: false,
  })
}

export function useConfirmConnections() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { resultId: string; accountIds: string[] }) =>
      apiFetch('/connections/confirm', { method: 'POST', body, schema: ConfirmConnectionsResponse }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PAGES_KEY })
    },
  })
}

/** Tên dễ hiểu của quyền Meta (hiện cạnh mã quyền trong modal thiếu quyền). */
export const PERMISSION_LABELS: Record<string, string> = {
  pages_show_list: 'Xem danh sách Fanpage',
  business_management: 'Quản lý doanh nghiệp',
  pages_messaging: 'Nhắn tin bằng Fanpage',
  pages_manage_metadata: 'Quản lý cài đặt Fanpage',
  pages_read_engagement: 'Đọc tương tác Fanpage',
  pages_read_user_content: 'Đọc nội dung người dùng trên Fanpage',
  pages_manage_engagement: 'Trả lời bình luận Fanpage',
  pages_manage_posts: 'Đăng bài lên Fanpage',
  read_insights: 'Xem số liệu Fanpage',
  instagram_basic: 'Xem tài khoản Instagram',
  instagram_manage_messages: 'Nhắn tin Instagram',
  instagram_manage_comments: 'Trả lời bình luận Instagram',
  instagram_content_publish: 'Đăng bài lên Instagram',
  instagram_manage_insights: 'Xem số liệu Instagram',
  threads_basic: 'Xem tài khoản Threads',
  threads_content_publish: 'Đăng bài lên Threads',
  threads_read_replies: 'Đọc trả lời trên Threads',
  threads_manage_replies: 'Trả lời và ẩn trả lời trên Threads',
  threads_manage_insights: 'Xem số liệu Threads',
}

/** Tiêu đề modal thiếu quyền theo nền tảng. */
export const MISSING_TITLES: Record<OAuthProvider, string> = {
  facebook: 'Chưa cấp đủ quyền quản lý tin nhắn',
  threads: 'Chưa cấp đủ quyền Threads',
}

export const IG_NOT_BUSINESS_HINT = 'Chỉ hỗ trợ tài khoản Instagram Business đã liên kết Fanpage'

const KNOWN_SCOPES: readonly string[] = [...META_LOGIN_SCOPES, ...THREADS_LOGIN_SCOPES]

/** Quyền thiếu của mọi ứng viên, không trùng, theo thứ tự xin quyền. */
export function missingPermissions(candidates: readonly OAuthCandidate[]): string[] {
  const all = new Set(candidates.flatMap((c) => c.missing))
  const known = KNOWN_SCOPES.filter((s) => all.has(s))
  return [...known, ...[...all].filter((s) => !KNOWN_SCOPES.includes(s)).sort()]
}

/** Trang đã kết nối tách theo tài khoản OAuth: khối Facebook (Fanpage + Instagram) và khối Threads. */
export function splitPagesByProvider<T extends { platform: Platform }>(items: readonly T[]): Record<OAuthProvider, T[]> {
  return {
    facebook: items.filter((p) => providerOfPlatform(p.platform) === 'facebook'),
    threads: items.filter((p) => providerOfPlatform(p.platform) === 'threads'),
  }
}

export interface CandidateGroup {
  page: OAuthCandidate
  /** IG liên kết Fanpage này (Business hoặc bị khoá). */
  linked: OAuthCandidate[]
}

/** Nhóm hiển thị ở bước chọn: Meta → Fanpage kèm IG liên kết; Threads → mỗi tài khoản một dòng, không liên kết. */
export function candidateGroupsFor(provider: OAuthProvider, candidates: readonly OAuthCandidate[]): CandidateGroup[] {
  if (provider === 'threads') return candidates.filter((c) => c.platform === 'threads').map((page) => ({ page, linked: [] }))
  return groupCandidates(candidates)
}

/** Gom IG vào Fanpage nguồn để hiển thị cạnh nhau; IG không tìm thấy Fanpage bị bỏ. */
export function groupCandidates(candidates: readonly OAuthCandidate[]): CandidateGroup[] {
  const groups = candidates.filter((c) => c.platform === 'facebook').map((page) => ({ page, linked: [] as OAuthCandidate[] }))
  const byPage = new Map(groups.map((g) => [g.page.accountId, g]))
  for (const c of candidates) {
    if (c.platform !== 'facebook' && c.linkedToAccountId) byPage.get(c.linkedToAccountId)?.linked.push(c)
  }
  return groups
}

/**
 * Bật/tắt một ứng viên trong lựa chọn: chọn IG → chọn luôn Fanpage nguồn (token đi theo Fanpage);
 * bỏ Fanpage → bỏ luôn IG liên kết. Ứng viên khoá không đổi được.
 */
export function toggleCandidate(selected: readonly string[], candidates: readonly OAuthCandidate[], accountId: string): string[] {
  const c = candidates.find((x) => x.accountId === accountId)
  if (!c?.selectable) return [...selected]
  const next = new Set(selected)
  if (next.has(accountId)) {
    next.delete(accountId)
    if (c.platform === 'facebook') for (const x of candidates) if (x.linkedToAccountId === accountId) next.delete(x.accountId)
  } else {
    next.add(accountId)
    if (c.linkedToAccountId) next.add(c.linkedToAccountId)
  }
  return candidates.filter((x) => next.has(x.accountId)).map((x) => x.accountId)
}

/** Lý do hiển thị cho ứng viên bị khoá. */
export function lockReasonText(c: OAuthCandidate): string | null {
  if (c.selectable) return null
  if (c.reason === 'IG_NOT_BUSINESS') return IG_NOT_BUSINESS_HINT
  if (c.missing.length) return `Thiếu quyền: ${c.missing.map((s) => PERMISSION_LABELS[s] ?? s).join(', ')}`
  return 'Không chọn được tài khoản này'
}

const AVATAR_COLORS = ['#A7F3D0', '#C7D2FE', '#FDE68A', '#FBCFE8', '#BAE6FD', '#FED7AA']

/** Màu avatar ổn định theo id (trang thật chưa có màu riêng). */
export function avatarColorOf(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!
}

/**
 * Trang thật → dạng hàng của bảng Trang & Nhóm (kiểu `Page` của giao diện mẫu). `groupId` lấy từ server
 * (Story 2.5). AI trả lời và hồ sơ chưa có ở server (Epic 3, 5) → mặc định tắt, riêng.
 */
export function toUiPage(dto: PageDto): Page {
  return {
    id: dto.id,
    name: dto.name,
    handle: dto.handle ?? '',
    platform: dto.platform,
    groupId: dto.groupId,
    followers: 0,
    status: dto.connectionStatus,
    autoReply: false,
    brandSource: 'own',
    avatarColor: avatarColorOf(dto.id),
  }
}
