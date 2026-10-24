import type { OAuthCandidate } from '@ottm/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IG_NOT_BUSINESS_HINT,
  MISSING_TITLES,
  PERMISSION_LABELS,
  candidateGroupsFor,
  resultProvider,
  stripOAuthFragment,
  providerFromParam,
  providerOfPlatform,
  removePageConfirm,
  removePageRequest,
  splitPagesByProvider,
  avatarColorOf,
  groupCandidates,
  lockReasonText,
  mirrorRealPages,
  missingPermissions,
  needsReconnect,
  patchMockPages,
  reconnectInput,
  toUiPage,
  toggleCandidate,
  uiPageOf,
} from './connections'
import type { Page } from '../data/mock'
import { ERROR_MESSAGES, errorMessage, errorMessageOf } from './error-messages'

const fb = (id: string, extra: Partial<OAuthCandidate> = {}): OAuthCandidate => ({
  accountId: id,
  platform: 'facebook',
  name: `Trang ${id}`,
  handle: null,
  avatarUrl: null,
  selectable: true,
  missing: [],
  ...extra,
})
const ig = (id: string, linked: string, extra: Partial<OAuthCandidate> = {}): OAuthCandidate => ({
  ...fb(id, extra),
  platform: 'instagram',
  linkedToAccountId: linked,
  ...extra,
})

const candidates = [
  fb('p1'),
  ig('ig1', 'p1'),
  fb('p2'),
  ig('ig2', 'p2', { selectable: false, reason: 'IG_NOT_BUSINESS' }),
  fb('p3', { selectable: false, missing: ['pages_messaging'], reason: 'PERMISSIONS_MISSING' }),
]

describe('groupCandidates', () => {
  it('IG đứng cạnh Fanpage nguồn; IG mồ côi bị bỏ', () => {
    const groups = groupCandidates([...candidates, ig('ig9', 'khong-co')])
    expect(groups.map((g) => [g.page.accountId, g.linked.map((x) => x.accountId)])).toEqual([
      ['p1', ['ig1']],
      ['p2', ['ig2']],
      ['p3', []],
    ])
  })
})

describe('toggleCandidate', () => {
  it('chọn IG → chọn luôn Fanpage nguồn; bỏ Fanpage → bỏ IG liên kết', () => {
    const withIg = toggleCandidate([], candidates, 'ig1')
    expect(withIg).toEqual(['p1', 'ig1'])
    expect(toggleCandidate(withIg, candidates, 'p1')).toEqual([])
    expect(toggleCandidate(withIg, candidates, 'ig1')).toEqual(['p1'])
  })

  it('ứng viên khoá không đổi được', () => {
    expect(toggleCandidate(['p1'], candidates, 'ig2')).toEqual(['p1'])
    expect(toggleCandidate(['p1'], candidates, 'p3')).toEqual(['p1'])
  })
})

describe('missingPermissions / lockReasonText', () => {
  it('gộp quyền thiếu không trùng, theo thứ tự xin quyền', () => {
    expect(
      missingPermissions([
        fb('a', { missing: ['pages_messaging'] }),
        ig('b', 'a', { missing: ['instagram_manage_messages', 'pages_messaging'] }),
      ]),
    ).toEqual(['pages_messaging', 'instagram_manage_messages'])
    expect(missingPermissions(candidates.slice(0, 2))).toEqual([])
  })

  it('lý do khoá: IG chưa Business, thiếu quyền; chọn được → null', () => {
    expect(lockReasonText(candidates[3]!)).toBe(IG_NOT_BUSINESS_HINT)
    expect(lockReasonText(candidates[4]!)).toBe('Thiếu quyền: Nhắn tin bằng Fanpage')
    expect(lockReasonText(candidates[0]!)).toBeNull()
  })
})

describe('toUiPage', () => {
  it('trang thật → hàng bảng: trạng thái từ server, chưa có nhóm, màu avatar ổn định', () => {
    const page = toUiPage({
      id: '0199a000-0000-7000-8000-000000000001',
      platform: 'instagram',
      name: 'Lan Anh',
      handle: null,
      avatarUrl: null,
      groupId: null,
      connectionStatus: 'expiring',
      connectedAt: '2026-10-22T03:00:00.000Z',
    })
    expect(page).toMatchObject({ platform: 'instagram', handle: '', status: 'expiring', groupId: null, autoReply: false, brandSource: 'own' })
    expect(page.avatarColor).toBe(avatarColorOf('0199a000-0000-7000-8000-000000000001'))
  })
})

describe('mirrorRealPages / patchMockPages (kho mẫu cho màn chưa chuyển API)', () => {
  const dto = (id: string, name = id, groupId: string | null = null) => ({
    id,
    platform: 'facebook' as const,
    name,
    handle: null,
    avatarUrl: null,
    groupId,
    connectionStatus: 'active' as const,
    connectedAt: '2026-10-22T03:00:00.000Z',
  })
  const sample: Page = { id: 'p1', name: 'Mẫu', handle: 'mau', platform: 'facebook', groupId: 'g-x', followers: 10, status: 'active', autoReply: true, brandSource: 'group', avatarColor: '#fff' }

  it('thêm trang thật, bỏ trang mẫu; nhóm theo server, giữ AI khi cập nhật; bỏ trang thật không còn', () => {
    const store: Page[] = [sample]
    const known = new Set<string>()
    mirrorRealPages([dto('r1'), dto('r2')], store, known)
    expect(store.map((p) => p.id)).toEqual(['r1', 'r2']) // trang mẫu p1 không lẫn vào phạm vi / Tổng quan

    // AI trả lời là overlay giao diện (giữ lại); nhóm do server sở hữu (theo DTO mới).
    patchMockPages(['r1'], () => ({ autoReply: true }), store)
    mirrorRealPages([dto('r1', 'Tên mới', 'g-y')], store, known)
    expect(store.map((p) => p.id)).toEqual(['r1'])
    expect(store[0]).toMatchObject({ name: 'Tên mới', groupId: 'g-y', autoReply: true })
    expect(uiPageOf(dto('r1'), store)).toBe(store[0])
    expect(uiPageOf(dto('r9'), store).id).toBe('r9')
  })
})

describe('Threads (Story 2.3)', () => {
  it('nền tảng → luồng OAuth: Facebook và Instagram dùng cửa sổ Meta, Threads riêng', () => {
    expect(providerOfPlatform('facebook')).toBe('facebook')
    expect(providerOfPlatform('instagram')).toBe('facebook')
    expect(providerOfPlatform('threads')).toBe('threads')
  })

  it('?nen-tang= trên URL: threads → threads; thiếu / lạ → facebook', () => {
    expect(providerFromParam('threads')).toBe('threads')
    expect(providerFromParam(null)).toBe('facebook')
    expect(providerFromParam('khac')).toBe('facebook')
  })

  it('tách trang thành khối Facebook (Fanpage + IG) và khối Threads', () => {
    const items = [
      { id: 'a', platform: 'facebook' as const },
      { id: 'b', platform: 'threads' as const },
      { id: 'c', platform: 'instagram' as const },
    ]
    const split = splitPagesByProvider(items)
    expect(split.facebook.map((p) => p.id)).toEqual(['a', 'c'])
    expect(split.threads.map((p) => p.id)).toEqual(['b'])
  })

  it('modal thiếu quyền Threads: tiêu đề riêng, quyền theo thứ tự xin, có nhãn dễ hiểu', () => {
    expect(MISSING_TITLES.threads).toBe('Chưa cấp đủ quyền Threads')
    const th = { ...fb('t1'), platform: 'threads' as const, selectable: false, reason: 'PERMISSIONS_MISSING' as const, missing: ['threads_manage_replies', 'threads_read_replies'] }
    expect(missingPermissions([th])).toEqual(['threads_read_replies', 'threads_manage_replies'])
    expect(PERMISSION_LABELS.threads_read_replies).toBeTruthy()
    expect(lockReasonText(th)).toContain('Thiếu quyền')
  })
})

describe('Threads — bước chọn, nền tảng kết quả, fragment, câu lỗi', () => {
  const th = (id: string, extra: Partial<OAuthCandidate> = {}): OAuthCandidate => ({ ...fb(id), platform: 'threads', name: `Threads ${id}`, ...extra })
  const threadsOnly = [th('t1'), th('t2', { selectable: false, reason: 'PERMISSIONS_MISSING', missing: ['threads_read_replies'] })]

  it('candidateGroupsFor(threads): mỗi tài khoản một dòng, không liên kết; facebook giữ nhóm Fanpage + IG', () => {
    expect(candidateGroupsFor('threads', threadsOnly)).toEqual([
      { page: threadsOnly[0], linked: [] },
      { page: threadsOnly[1], linked: [] },
    ])
    // Cùng tập Threads mà xử lý như Meta → không có Fanpage nào (lý do phải tách theo nền tảng).
    expect(candidateGroupsFor('facebook', threadsOnly)).toEqual([])
    expect(candidateGroupsFor('facebook', candidates).map((g) => g.page.accountId)).toEqual(['p1', 'p2', 'p3'])
  })

  it('resultProvider: theo kết quả khi đã đọc; chưa đọc / hết hạn → theo URL', () => {
    expect(resultProvider({ provider: 'threads' }, 'facebook')).toBe('threads')
    expect(resultProvider({ provider: 'facebook' }, 'threads')).toBe('facebook')
    expect(resultProvider(undefined, 'threads')).toBe('threads')
  })

  it.each([
    ['http://x/trang-nhom?ket-noi=1#', '', true],
    ['http://x/trang-nhom?ket-noi=1#_', '#_', true],
    ['http://x/trang-nhom?ket-noi=1#_=_', '#_=_', true],
    ['http://x/trang-nhom?ket-noi=1', '', false],
    ['http://x/trang-nhom#muc-khac', '#muc-khac', false],
  ])('stripOAuthFragment(%s) → %s', (href, hash, stripped) => {
    const calls: unknown[][] = []
    const history = { state: { idx: 3 }, replaceState: (...args: unknown[]) => void calls.push(args) }
    const u = new URL(href)
    expect(stripOAuthFragment({ href, hash, pathname: u.pathname, search: u.search }, history)).toBe(stripped)
    expect(calls).toEqual(stripped ? [[{ idx: 3 }, '', `${u.pathname}${u.search}`]] : [])
  })

  it('câu lỗi theo nền tảng: Threads nhắc Threads và chỉ biến THREADS_*; Facebook chỉ biến META_*', () => {
    expect(errorMessage('OAUTH_FAILED', 'threads')).toContain('Threads')
    expect(errorMessage('OAUTH_FAILED', 'facebook')).toBe(ERROR_MESSAGES.OAUTH_FAILED)
    const th = errorMessageOf({ code: 'META_NOT_CONFIGURED' }, 'threads')
    expect(th).toContain('THREADS_APP_ID')
    expect(th).not.toContain('META_APP_ID')
    const fbMsg = errorMessage('META_NOT_CONFIGURED', 'facebook')
    expect(fbMsg).toContain('META_APP_ID')
    expect(fbMsg).not.toContain('THREADS_APP_ID')
    // Mã không có câu riêng → câu chung.
    expect(errorMessage('RATE_LIMITED', 'threads')).toBe(ERROR_MESSAGES.RATE_LIMITED)
  })
})

describe('kết nối lại (Story 2.4)', () => {
  it('nút "Kết nối lại" chỉ hiện khi trang không còn hoạt động (chip vàng/đỏ)', () => {
    expect(needsReconnect('active')).toBe(false)
    expect(needsReconnect('expiring')).toBe(true)
    expect(needsReconnect('disconnected')).toBe(true)
  })

  it('reconnectInput: đúng nền tảng, giữ pageId, màn gốc của nút', () => {
    expect(reconnectInput({ id: 'pg-1', platform: 'facebook' }, 'pages')).toEqual({ provider: 'facebook', from: 'pages', pageId: 'pg-1' })
    // Instagram đi qua cửa sổ Meta (token theo Fanpage nguồn).
    expect(reconnectInput({ id: 'ig-1', platform: 'instagram' }, 'settings')).toEqual({ provider: 'facebook', from: 'settings', pageId: 'ig-1' })
    expect(reconnectInput({ id: 'th-1', platform: 'threads' }, 'pages')).toEqual({ provider: 'threads', from: 'pages', pageId: 'th-1' })
  })
})

describe('gỡ trang (Story 2.7)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('removePageRequest: DELETE /pages/:id (id được escape), 204 → undefined', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(removePageRequest('pg 1')).resolves.toBeUndefined()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('/api/v1/pages/pg%201')
    expect(init?.method).toBe('DELETE')
    // Không gửi body.
    expect(init?.body).toBeUndefined()
  })

  it('removePageConfirm: modal xác nhận nêu rõ giữ lịch sử + có thể khôi phục; danh từ theo nền tảng', () => {
    const fb = removePageConfirm({ name: 'Mỹ phẩm Lan Anh', platform: 'facebook' })
    expect(fb.noun).toBe('trang')
    expect(fb.title).toBe('Gỡ trang khỏi app?')
    expect(fb.confirmLabel).toBe('Gỡ trang')
    expect(fb.body).toContain('Mỹ phẩm Lan Anh')
    expect(fb.body).toContain('Lịch sử')
    expect(fb.body).toContain('khôi phục')
    // Instagram đi cùng khối Facebook → vẫn là "trang".
    expect(removePageConfirm({ name: 'lananh.beauty', platform: 'instagram' }).noun).toBe('trang')
    // Threads là "tài khoản", không phải "trang".
    const th = removePageConfirm({ name: 'shop.threads', platform: 'threads' })
    expect(th.noun).toBe('tài khoản')
    expect(th.title).toBe('Gỡ tài khoản khỏi app?')
    expect(th.confirmLabel).toBe('Gỡ tài khoản')
  })
})
