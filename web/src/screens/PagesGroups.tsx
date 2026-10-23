import { Check, ChevronDown, Ellipsis, FolderPlus, Loader2, Plus, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Content } from '../components/AppShell'
import { GROUP_COLORS, GROUP_COLOR_HEX, type GroupColor, type GroupMoveImpact, type OAuthProvider } from '@ottm/shared'
import ConnectResultModal from '../components/ConnectResultModal'
import {
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  GroupChip,
  Input,
  Modal,
  PageAvatar,
  PageLabel,
  PageHeader,
  PlatformIcon,
  StatusChip,
  Switch,
  Tabs,
  cn,
  platformLabel,
} from '../components/ui'
import { groupById, type Group, type Page, type Platform } from '../data/mock'
import { useApp } from '../lib/app-context'
import { bulkConfirmText, bulkResultMessage, useAutoreplyOverview, useBulkSetAutoreply } from '../lib/autoreply'
import {
  CONNECT_ERROR_PARAM,
  CONNECT_PROVIDER_PARAM,
  CONNECT_RESULT_PARAM,
  PROVIDER_LABEL,
  providerFromParam,
  providerOfPlatform,
  reconnectInput,
  stripOAuthFragment,
  uiPageOf,
  usePages,
  useStartConnect,
} from '../lib/connections'
import {
  colorCodeOf,
  firstFreeColor,
  shouldConfirmMove,
  toUiGroup,
  useAssignGroup,
  useCreateGroup,
  useDeleteGroup,
  useGroupMoveImpact,
  useGroups,
  useUnassignGroup,
  useUpdateGroup,
} from '../lib/groups'
import { errorMessage, errorMessageOf } from '../lib/error-messages'

const PLATFORM_NAMES: Record<Platform, string> = { facebook: 'Facebook Fanpage', instagram: 'Instagram Business', threads: 'Threads' }


/* ---------- Menu thả xuống nhỏ ---------- */

function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return ref
}

function RowMenu({ label, items }: { label: string; items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false)
  const ref = useOutside(open, () => setOpen(false))
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-slate-100 hover:text-foreground"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Ellipsis size={18} />
      </button>
      {open && (
        <div role="menu" className="absolute top-9 right-0 z-30 w-48 rounded-lg border border-border bg-surface p-1 shadow-lg">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
                it.onClick()
              }}
              className={cn('block w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-slate-50', it.danger && 'text-danger hover:bg-red-50')}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Checkbox({ checked, onChange, label, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; label: string; indeterminate?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate
  }, [indeterminate])
  return <input ref={ref} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} className="size-4 cursor-pointer rounded accent-primary" />
}

/* ---------- Màn hình ---------- */

type Dialog =
  | { kind: 'create'; preselect: string[] }
  | { kind: 'edit'; group: Group }
  | { kind: 'delete'; group: Group }
  | { kind: 'addTo'; pageIds: string[] }
  | { kind: 'ai'; pageIds: string[]; on: boolean }
  | { kind: 'move'; groupId: string; groupName: string; pageIds: string[]; impact: GroupMoveImpact }
  | null

export default function PagesGroups() {
  const { notify, openAiKeySet } = useApp()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const pagesQuery = usePages()
  const groupsQuery = useGroups()
  const startConnect = useStartConnect()
  const createGroupM = useCreateGroup()
  const updateGroupM = useUpdateGroup()
  const deleteGroupM = useDeleteGroup()
  const assignM = useAssignGroup()
  const unassignM = useUnassignGroup()
  const moveImpactM = useGroupMoveImpact()
  // AI trả lời (Story 5.1): trạng thái dẫn xuất từ server (`Page.autoReply`), đổi qua Bật/Tắt hàng loạt.
  const overviewQuery = useAutoreplyOverview()
  const bulkAiM = useBulkSetAutoreply()
  const [tab, setTab] = useState<'groups' | 'pages'>(() => (searchParams.has(CONNECT_RESULT_PARAM) ? 'pages' : 'groups'))
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  const connectRef = useOutside(connectOpen, () => setConnectOpen(false))

  // Nhóm thật từ `GET /api/v1/groups`. `groupId` của trang lấy thẳng từ server (Story 2.5); AI trả lời dẫn xuất từ
  // tổng quan cấu hình AI (Story 5.1).
  const aiPages = new Map((overviewQuery.data?.pages ?? []).map((s) => [s.pageId, s]))
  const aiGroups = new Map((overviewQuery.data?.groups ?? []).map((s) => [s.groupId, s.enabled]))
  const groupList: Group[] = (groupsQuery.data ?? []).map((dto) => ({ ...toUiGroup(dto), autoReply: aiGroups.get(dto.id) ?? false }))
  const pageList: Page[] = (pagesQuery.data ?? []).map((dto) => ({ ...uiPageOf(dto), groupId: dto.groupId, autoReply: aiPages.get(dto.id)?.enabled ?? false }))
  const resultId = searchParams.get(CONNECT_RESULT_PARAM)
  const resultProvider = providerFromParam(searchParams.get(CONNECT_PROVIDER_PARAM))
  const connectError = searchParams.get(CONNECT_ERROR_PARAM)

  /* Kết quả OAuth: `?ket-noi=<id>[&nen-tang=threads]` mở bước chọn trang; `?ket-noi-loi=<mã>` báo lỗi rồi bỏ tham số. */
  const clearConnectParams = useCallback(
    () =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete(CONNECT_RESULT_PARAM)
          next.delete(CONNECT_ERROR_PARAM)
          next.delete(CONNECT_PROVIDER_PARAM)
          return next
        },
        { replace: true },
      ),
    [setSearchParams],
  )
  // Bỏ `#` / `#_` mà callback OAuth để lại trên thanh địa chỉ.
  useEffect(() => {
    stripOAuthFragment()
  }, [])
  useEffect(() => {
    if (!connectError) return
    notify(errorMessage(connectError, resultProvider))
    clearConnectParams()
  }, [connectError, resultProvider, notify, clearConnectParams])

  /** Facebook và Instagram mở cùng cửa sổ Meta; Threads mở cửa sổ Threads riêng. */
  const beginConnect = (provider: OAuthProvider) => {
    if (startConnect.isPending) return
    startConnect.mutate({ provider, from: 'pages' }, { onError: (err) => notify(errorMessageOf(err, provider)) })
  }
  const opening = startConnect.isPending ? PROVIDER_LABEL[startConnect.variables.provider] : null

  const inGroup = (gid: string) => pageList.filter((p) => p.groupId === gid)
  const groupName = (gid: string | null) => groupList.find((g) => g.id === gid)?.name ?? ''
  const needsAttention = pageList.filter((p) => p.status !== 'active')

  const q = query.trim().toLowerCase()
  const visiblePages = q ? pageList.filter((p) => p.name.toLowerCase().includes(q) || p.handle.includes(q) || groupName(p.groupId).toLowerCase().includes(q)) : pageList

  /* ----- Thao tác nhóm (API thật, AD-8) ----- */

  /** Gán thật (sau khi đã xác nhận nếu cần). Mỗi trang đổi phát `page.group_changed` ở server. */
  const doAssign = (groupId: string, pageIds: string[], name: string) => {
    assignM.mutate(
      { groupId, pageIds },
      {
        onSuccess: (res) => {
          setSelected([])
          setDialog(null)
          notify(res.changedPageIds.length ? `Đã thêm ${res.changedPageIds.length} trang vào ${name}` : `Các trang đã ở ${name}`)
        },
        onError: (err) => notify(errorMessageOf(err)),
      },
    )
  }

  /**
   * Gán vào một nhóm đã tồn tại. LUÔN hỏi server danh sách ảnh hưởng trước (server là nguồn sự thật cho AC2):
   * có trang phải rời nhóm cũ → hiện modal xác nhận; không có → gán thẳng.
   */
  const requestAssign = (groupId: string, pageIds: string[]) => {
    const name = groupName(groupId)
    moveImpactM.mutate(
      { groupId, pageIds },
      {
        onSuccess: (impact) => {
          if (shouldConfirmMove(impact)) setDialog({ kind: 'move', groupId, groupName: name, pageIds, impact })
          else doAssign(groupId, pageIds, name)
        },
        onError: (err) => notify(errorMessageOf(err)),
      },
    )
  }

  const createGroup = (name: string, color: GroupColor, pageIds: string[]) => {
    createGroupM.mutate(
      { name, color, pageIds },
      {
        onSuccess: () => {
          setSelected([])
          setDialog(null)
          notify(pageIds.length ? `Đã tạo ${name} với ${pageIds.length} trang` : `Đã tạo ${name}`)
        },
        onError: (err) => notify(errorMessageOf(err)),
      },
    )
  }

  const saveGroup = (g: Group, name: string, color: GroupColor) => {
    updateGroupM.mutate(
      { id: g.id, name, color },
      {
        onSuccess: () => {
          setDialog(null)
          notify(`Đã lưu ${name}`)
        },
        onError: (err) => notify(errorMessageOf(err)),
      },
    )
  }

  const deleteGroup = (g: Group) => {
    deleteGroupM.mutate(g.id, {
      onSuccess: (res) => {
        setDialog(null)
        notify(`Đã xoá ${g.name}. ${res.memberPageIds.length} trang chuyển về “Chưa có nhóm”.`)
      },
      onError: (err) => notify(errorMessageOf(err)),
    })
  }

  /* ----- AI trả lời (Story 5.1, AD-8): luôn hỏi xác nhận rồi server đổi từng trang (theo nhóm → chuyển riêng) ----- */

  const setAi = (ids: string[], on: boolean) => {
    if (on && !openAiKeySet) return
    setDialog({ kind: 'ai', pageIds: ids, on })
  }
  const aiConfirm = (ids: string[], on: boolean) =>
    bulkConfirmText(
      ids.map((id) => ({ name: pageList.find((p) => p.id === id)?.name ?? '', status: aiPages.get(id) })),
      on,
    )
  const doSetAi = (ids: string[], on: boolean) => {
    bulkAiM.mutate(
      { pageIds: ids, enabled: on },
      {
        onSuccess: (res) => {
          setDialog(null)
          if (ids.length > 1) setSelected([])
          notify(bulkResultMessage(res, on))
        },
        onError: (err) => notify(errorMessageOf(err)),
      },
    )
  }

  /* Kết nối lại một trang (Story 2.4): OAuth với `intent=reconnect:<pageId>` → server cập nhật đúng dòng trang cũ. */
  const reconnect = (p: Page) => {
    if (startConnect.isPending) return
    const input = reconnectInput(p, 'pages')
    startConnect.mutate(input, { onError: (err) => notify(errorMessageOf(err, input.provider)) })
  }

  const removeFromGroup = (p: Page) => {
    const name = groupName(p.groupId)
    unassignM.mutate(p.id, {
      onSuccess: () => notify(`Đã bỏ ${p.name} khỏi ${name}`),
      onError: (err) => notify(errorMessageOf(err)),
    })
  }

  const onConnected = (count: number) => {
    clearConnectParams()
    setTab('pages')
    notify(`Đã kết nối ${count} trang`)
  }

  const allVisibleSelected = visiblePages.length > 0 && visiblePages.every((p) => selected.includes(p.id))

  return (
    <Content>
      <PageHeader
        title="Trang & Nhóm"
        subtitle={`${pageList.length} trang đã kết nối · ${groupList.length} nhóm`}
        actions={
          <>
            <Button icon={<FolderPlus size={16} />} onClick={() => setDialog({ kind: 'create', preselect: [] })}>
              Tạo nhóm
            </Button>
            <div className="relative" ref={connectRef}>
              <Button
                variant="primary"
                icon={startConnect.isPending ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                onClick={() => setConnectOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={connectOpen}
                disabled={startConnect.isPending}
              >
                {opening ? `Đang mở ${opening}…` : 'Kết nối tài khoản'} <ChevronDown size={15} />
              </Button>
              {connectOpen && (
                <div role="menu" className="absolute top-11 right-0 z-30 w-64 rounded-lg border border-border bg-surface p-1 shadow-lg">
                  {(['facebook', 'instagram', 'threads'] as Platform[]).map((pl) => (
                    <button
                      key={pl}
                      role="menuitem"
                      type="button"
                      disabled={startConnect.isPending}
                      onClick={() => {
                        setConnectOpen(false)
                        beginConnect(providerOfPlatform(pl))
                      }}
                      className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                    >
                      <PlatformIcon platform={pl} size={18} />
                      {PLATFORM_NAMES[pl]}
                    </button>
                  ))}
                  <p className="border-t border-border px-3 pt-2 pb-1.5 text-xs text-muted-foreground">Facebook và Instagram Business kết nối chung qua một cửa sổ Meta. Threads đăng nhập riêng bằng tài khoản Threads.</p>
                </div>
              )}
            </div>
          </>
        }
      />

      {needsAttention.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-amber-200 bg-warning-soft/60 px-4 py-3 text-sm">
          <span className="font-medium text-amber-900">{needsAttention.length} trang cần kết nối lại:</span>
          {needsAttention.map((p) => (
            <span key={p.id} className="flex items-center gap-2">
              <PageAvatar page={p} size={22} />
              <span>{p.name}</span>
              <StatusChip status={p.status} />
              <button type="button" onClick={() => reconnect(p)} className="text-[13px] font-medium text-primary hover:underline">
                Kết nối lại
              </button>
            </span>
          ))}
        </div>
      )}

      <Tabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'groups', label: 'Nhóm', count: groupList.length },
          { id: 'pages', label: 'Tất cả trang', count: pageList.length },
        ]}
      />

      {tab === 'groups' ? (
        groupsQuery.isPending ? (
          <Card>
            <div className="px-4 py-8 text-center text-sm text-muted-foreground" role="status">
              <Loader2 size={16} className="mr-2 inline animate-spin" /> Đang tải danh sách nhóm…
            </div>
          </Card>
        ) : groupsQuery.isError ? (
          <Card>
            <EmptyState title="Chưa tải được danh sách nhóm" action={<Button onClick={() => void groupsQuery.refetch()}>Thử lại</Button>}>
              {errorMessageOf(groupsQuery.error)}
            </EmptyState>
          </Card>
        ) : groupList.length === 0 ? (
          <Card>
            <EmptyState
              icon={<FolderPlus size={22} />}
              title="Chưa có nhóm nào"
              action={
                <Button variant="primary" icon={<Plus size={16} />} onClick={() => setDialog({ kind: 'create', preselect: [] })}>
                  Tạo nhóm
                </Button>
              }
            >
              Gom các trang cùng chủ đề để dùng chung cấu hình.
            </EmptyState>
          </Card>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
            {groupList.map((g) => {
              const members = inGroup(g.id)
              const platforms = [...new Set(members.map((p) => p.platform))]
              const ownCount = members.filter((p) => p.brandSource === 'own').length
              const aiOn = members.filter((p) => p.autoReply).length
              return (
                <Card key={g.id} className="relative transition-colors hover:border-slate-300">
                  <div className="absolute top-3 right-3">
                    <RowMenu
                      label={`Thao tác cho ${g.name}`}
                      items={[
                        { label: 'Sửa nhóm', onClick: () => setDialog({ kind: 'edit', group: g }) },
                        { label: 'Xoá nhóm', danger: true, onClick: () => setDialog({ kind: 'delete', group: g }) },
                      ]}
                    />
                  </div>
                  <Link to={`/trang-nhom/nhom/${g.id}`} className="block rounded-lg p-4">
                    <div className="flex items-center gap-2.5 pr-8">
                      <span className="size-3 rounded-full" style={{ backgroundColor: g.color }} />
                      <h3 className="truncate text-base font-semibold">{g.name}</h3>
                    </div>
                    <div className="mt-4 flex items-center gap-3">
                      <div className="flex -space-x-2">
                        {members.slice(0, 5).map((p) => (
                          <span key={p.id} className="rounded-full ring-2 ring-white">
                            <PageAvatar page={p} size={34} />
                          </span>
                        ))}
                        {members.length > 5 && (
                          <span className="flex size-[34px] items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600 ring-2 ring-white">+{members.length - 5}</span>
                        )}
                        {members.length === 0 && <span className="text-[13px] text-muted-foreground">Chưa có trang</span>}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                      {members.length} trang · {platforms.length} nền tảng
                      <span className="ml-1 flex gap-1">
                        {platforms.map((pl) => (
                          <PlatformIcon key={pl} platform={pl} size={14} />
                        ))}
                      </span>
                    </div>
                    <dl className="mt-4 space-y-2 border-t border-border pt-3 text-[13px]">
                      <Indicator label="Hồ sơ thương hiệu">
                        <span className="font-medium">Dùng chung</span>
                        {ownCount > 0 && <span className="text-muted-foreground"> · {ownCount} trang riêng</span>}
                      </Indicator>
                      <Indicator label="AI trả lời">
                        {g.autoReply ? (
                          <Chip tone="ai">
                            Bật · {aiOn}/{members.length} trang
                          </Chip>
                        ) : (
                          <Chip>Tắt</Chip>
                        )}
                      </Indicator>
                      <Indicator label="Chiến dịch">
                        <span className={cn('font-medium', g.activeCampaigns === 0 && 'text-muted-foreground')}>{g.activeCampaigns ? `${g.activeCampaigns} đang chạy` : 'Không có'}</span>
                      </Indicator>
                    </dl>
                  </Link>
                </Card>
              )
            })}
            <button
              type="button"
              onClick={() => setDialog({ kind: 'create', preselect: [] })}
              className="flex min-h-[230px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:bg-primary-soft/30 hover:text-primary"
            >
              <span className="rounded-full bg-slate-100 p-2.5">
                <Plus size={20} />
              </span>
              Tạo nhóm mới
              <span className="max-w-56 text-center text-xs font-normal">Gom các trang cùng chủ đề để dùng chung hồ sơ và AI trả lời.</span>
            </button>
          </div>
        )
      ) : (
        <>
          <div className="mb-3 flex items-center gap-3">
            <div className="relative w-72">
              <Search size={15} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm trang hoặc nhóm…" className="pl-9" aria-label="Tìm trang" />
            </div>
            {selected.length > 0 && (
              <div className="flex flex-1 items-center gap-2 rounded-md border border-primary/30 bg-primary-soft/40 px-3 py-1.5" role="toolbar" aria-label="Thao tác hàng loạt">
                <span className="mr-2 text-sm font-medium">Đã chọn {selected.length} trang</span>
                <Button size="sm" variant="primary" icon={<FolderPlus size={15} />} onClick={() => setDialog({ kind: 'addTo', pageIds: selected })}>
                  Thêm vào nhóm
                </Button>
                <Button size="sm" onClick={() => setAi(selected, true)} disabled={!openAiKeySet} title={openAiKeySet ? undefined : 'Thêm khoá OpenAI ở Cài đặt'}>
                  Bật AI trả lời
                </Button>
                <Button size="sm" onClick={() => setAi(selected, false)}>
                  Tắt AI trả lời
                </Button>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected([])}>
                  Bỏ chọn
                </Button>
              </div>
            )}
          </div>

          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                  <th className="w-10 py-2.5 pl-4">
                    <Checkbox
                      label="Chọn tất cả"
                      checked={allVisibleSelected}
                      indeterminate={!allVisibleSelected && visiblePages.some((p) => selected.includes(p.id))}
                      onChange={(v) => setSelected(v ? [...new Set([...selected, ...visiblePages.map((p) => p.id)])] : selected.filter((id) => !visiblePages.some((p) => p.id === id)))}
                    />
                  </th>
                  <th className="px-3 py-2.5 font-medium">Trang</th>
                  <th className="px-3 py-2.5 font-medium">Nền tảng</th>
                  <th className="px-3 py-2.5 font-medium">Nhóm</th>
                  <th className="px-3 py-2.5 font-medium">Trạng thái</th>
                  <th className="px-3 py-2.5 font-medium">AI trả lời</th>
                  <th className="px-3 py-2.5 font-medium">Hồ sơ</th>
                  <th className="w-12" />
                </tr>
              </thead>
              <tbody>
                {visiblePages.map((p) => {
                  const sel = selected.includes(p.id)
                  return (
                    <tr key={p.id} className={cn('border-b border-border last:border-b-0', sel ? 'bg-primary-soft/25' : 'hover:bg-slate-50/70')}>
                      <td className="py-2.5 pl-4">
                        <Checkbox label={`Chọn ${p.name}`} checked={sel} onChange={(v) => setSelected(v ? [...selected, p.id] : selected.filter((id) => id !== p.id))} />
                      </td>
                      <td className="max-w-64 px-3 py-2.5">
                        <Link to={`/trang-nhom/trang/${p.id}`} className="block rounded hover:text-primary">
                          <PageLabel page={p} sub={`@${p.handle}`} />
                        </Link>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1.5">
                          <PlatformIcon platform={p.platform} size={16} />
                          {platformLabel[p.platform]}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <GroupChip groupId={p.groupId} />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <StatusChip status={p.status} />
                          {p.status !== 'active' && (
                            <button type="button" onClick={() => reconnect(p)} className="inline-flex items-center gap-1 text-[13px] font-medium whitespace-nowrap text-primary hover:underline">
                              <RefreshCw size={13} /> Kết nối lại
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Switch
                          ai
                          checked={p.autoReply}
                          label={`AI trả lời cho ${p.name}`}
                          disabled={!p.autoReply && !openAiKeySet}
                          onChange={(v) => setAi([p.id], v)}
                        />
                      </td>
                      <td className="px-3 py-2.5">{p.groupId && p.brandSource === 'group' ? <Chip tone="primary">Theo nhóm</Chip> : <Chip>Riêng</Chip>}</td>
                      <td className="pr-3">
                        <RowMenu
                          label={`Thao tác cho ${p.name}`}
                          items={[
                            { label: 'Xem chi tiết', onClick: () => navigate(`/trang-nhom/trang/${p.id}`) },
                            { label: p.groupId ? 'Chuyển nhóm…' : 'Thêm vào nhóm…', onClick: () => setDialog({ kind: 'addTo', pageIds: [p.id] }) },
                            ...(p.groupId ? [{ label: 'Bỏ khỏi nhóm', onClick: () => removeFromGroup(p) }] : []),
                          ]}
                        />
                      </td>
                    </tr>
                  )
                })}
                {pagesQuery.isPending ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground" role="status">
                      <Loader2 size={16} className="mr-2 inline animate-spin" /> Đang tải danh sách trang…
                    </td>
                  </tr>
                ) : pagesQuery.isError ? (
                  <tr>
                    <td colSpan={8}>
                      <EmptyState title="Chưa tải được danh sách trang" action={<Button onClick={() => void pagesQuery.refetch()}>Thử lại</Button>}>
                        {errorMessageOf(pagesQuery.error)}
                      </EmptyState>
                    </td>
                  </tr>
                ) : (
                  visiblePages.length === 0 && (
                    <tr>
                      <td colSpan={8}>
                        <EmptyState title={query ? 'Không tìm thấy trang' : 'Chưa kết nối trang nào'}>{query ? `Không có trang nào khớp “${query}”.` : 'Bấm “Kết nối tài khoản” để thêm Fanpage và Instagram Business.'}</EmptyState>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {/* ----- Hộp thoại ----- */}
      {resultId && (
        <ConnectResultModal
          key={resultId}
          resultId={resultId}
          provider={resultProvider}
          onClose={clearConnectParams}
          onRetry={beginConnect}
          retrying={startConnect.isPending}
          onConnected={(pages) => onConnected(pages.length)}
        />
      )}
      {dialog?.kind === 'create' && (
        <CreateGroupModal groups={groupList} pages={pageList} preselect={dialog.preselect} busy={createGroupM.isPending} onClose={() => setDialog(null)} onCreate={createGroup} />
      )}
      {dialog?.kind === 'edit' && (
        <EditGroupModal group={dialog.group} busy={updateGroupM.isPending} onClose={() => setDialog(null)} onSave={(n, c) => saveGroup(dialog.group, n, c)} />
      )}
      {dialog?.kind === 'delete' && (
        <Modal
          open
          onClose={() => setDialog(null)}
          title={`Xoá ${dialog.group.name}?`}
          width={460}
          footer={
            <>
              <Button onClick={() => setDialog(null)}>Giữ nhóm</Button>
              <Button variant="danger" onClick={() => deleteGroup(dialog.group)}>
                Xoá nhóm
              </Button>
            </>
          }
        >
          <p className="text-sm">
            {inGroup(dialog.group.id).length} trang trong nhóm sẽ thành “Chưa có nhóm”. Mỗi trang giữ một bản sao hồ sơ thương hiệu và cấu hình AI trả lời của nhóm làm cấu hình riêng.
          </p>
          {dialog.group.activeCampaigns > 0 && <p className="mt-2 text-sm text-amber-800">Nhóm có {dialog.group.activeCampaigns} chiến dịch đang chạy. Chiến dịch vẫn tiếp tục trên từng trang.</p>}
        </Modal>
      )}
      {dialog?.kind === 'ai' && (
        <Modal
          open
          onClose={() => setDialog(null)}
          title={aiConfirm(dialog.pageIds, dialog.on).title}
          width={460}
          footer={
            <>
              <Button onClick={() => setDialog(null)}>Huỷ</Button>
              <Button variant="primary" disabled={bulkAiM.isPending} onClick={() => doSetAi(dialog.pageIds, dialog.on)}>
                {aiConfirm(dialog.pageIds, dialog.on).confirmLabel}
              </Button>
            </>
          }
        >
          <p className="text-sm">{aiConfirm(dialog.pageIds, dialog.on).body}</p>
        </Modal>
      )}
      {dialog?.kind === 'addTo' && (
        <AddToGroupModal
          pageIds={dialog.pageIds}
          pages={pageList}
          groups={groupList}
          busy={moveImpactM.isPending || assignM.isPending}
          onClose={() => setDialog(null)}
          onPick={(gid) => requestAssign(gid, dialog.pageIds)}
          onCreateNew={() => setDialog({ kind: 'create', preselect: dialog.pageIds })}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveConfirmModal
          dialog={dialog}
          pages={pageList}
          groups={groupList}
          busy={assignM.isPending}
          onClose={() => setDialog(null)}
          onConfirm={() => doAssign(dialog.groupId, dialog.pageIds, dialog.groupName)}
        />
      )}
    </Content>
  )
}

function Indicator({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/* ---------- Tạo nhóm ---------- */

function ColorPicker({ color, onPick }: { color: GroupColor; onPick: (c: GroupColor) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Màu nhóm">
      {GROUP_COLORS.map((c) => {
        const hex = GROUP_COLOR_HEX[c]
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={c}
            onClick={() => onPick(c)}
            className={cn('flex size-8 items-center justify-center rounded-full ring-offset-2 transition', color === c && 'ring-2')}
            style={{ backgroundColor: hex, ['--tw-ring-color' as string]: hex }}
          >
            {color === c && <Check size={15} className="text-white" />}
          </button>
        )
      })}
    </div>
  )
}

function ChipPreview({ name, color }: { name: string; color: GroupColor }) {
  const hex = GROUP_COLOR_HEX[color]
  return (
    <span className="ml-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium" style={{ backgroundColor: `${hex}1F`, color: hex }}>
      <span className="size-1.5 rounded-full" style={{ backgroundColor: hex }} />
      {name}
    </span>
  )
}

function CreateGroupModal({
  groups,
  pages,
  preselect,
  busy,
  onClose,
  onCreate,
}: {
  groups: Group[]
  pages: Page[]
  preselect: string[]
  busy?: boolean
  onClose: () => void
  onCreate: (name: string, color: GroupColor, pageIds: string[]) => void
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<GroupColor>(() => firstFreeColor(groups))
  const [picked, setPicked] = useState<string[]>(preselect)
  const trimmed = name.trim()
  // [ASSUMPTION] spec cho phép trùng tên nhóm → chỉ nhắc nhẹ, không chặn.
  const duplicate = groups.some((g) => g.name.toLowerCase() === trimmed.toLowerCase())

  return (
    <Modal
      open
      onClose={onClose}
      title="Tạo nhóm"
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Huỷ</Button>
          <Button variant="primary" disabled={!trimmed || busy} onClick={() => onCreate(trimmed, color, picked)}>
            Tạo nhóm{picked.length ? ` với ${picked.length} trang` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Tên nhóm" hint={duplicate ? <span className="text-amber-800">Đã có nhóm cùng tên — vẫn tạo được.</span> : 'VD: Nhóm Mỹ phẩm, Nhóm Gia dụng'}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nhóm …" />
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium">Màu nhóm</span>
          <ColorPicker color={color} onPick={setColor} />
          {trimmed && (
            <div className="mt-2 text-xs text-muted-foreground">
              Xem trước: <ChipPreview name={trimmed} color={color} />
            </div>
          )}
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[13px] font-medium">Chọn trang</span>
            <span className="text-xs text-muted-foreground">Mỗi trang chỉ thuộc một nhóm</span>
          </div>
          <PageChecklist pages={pages} picked={picked} setPicked={setPicked} targetGroupId={null} />
          {pages.filter((p) => picked.includes(p.id) && p.groupId).length > 0 && (
            <p className="mt-2 text-xs text-amber-800">{pages.filter((p) => picked.includes(p.id) && p.groupId).length} trang sẽ rời nhóm cũ để vào nhóm mới.</p>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function PageChecklist({ pages, picked, setPicked, targetGroupId }: { pages: Page[]; picked: string[]; setPicked: (v: string[]) => void; targetGroupId: string | null }) {
  return (
    <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
      {pages.map((p) => {
        const on = picked.includes(p.id)
        const other = p.groupId && p.groupId !== targetGroupId ? groupById(p.groupId) : null
        return (
          <li key={p.id}>
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50">
              <input type="checkbox" className="size-4 accent-primary" checked={on} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((id) => id !== p.id))} />
              <PageLabel page={p} />
              <span className="ml-auto text-right text-xs">
                {other ? (
                  on ? (
                    <span className="text-amber-800">
                      đang ở {other.name}, sẽ chuyển sang nhóm này
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      đang ở <GroupChip groupId={other.id} size="sm" />
                    </span>
                  )
                ) : (
                  <span className="text-muted-foreground">Chưa có nhóm</span>
                )}
              </span>
            </label>
          </li>
        )
      })}
    </ul>
  )
}

/* ---------- Sửa tên/màu ---------- */

function EditGroupModal({ group, busy, onClose, onSave }: { group: Group; busy?: boolean; onClose: () => void; onSave: (name: string, color: GroupColor) => void }) {
  const [name, setName] = useState(group.name)
  const [color, setColor] = useState<GroupColor>(() => colorCodeOf(group.color))
  const t = name.trim()
  const changed = t !== group.name || color !== colorCodeOf(group.color)
  const ok = !!t && changed && !busy
  return (
    <Modal
      open
      onClose={onClose}
      title="Sửa nhóm"
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Huỷ</Button>
          <Button variant="primary" disabled={!ok} onClick={() => onSave(t, color)}>
            Lưu
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Tên nhóm">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok && onSave(t, color)} />
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium">Màu nhóm</span>
          <ColorPicker color={color} onPick={setColor} />
          {t && (
            <div className="mt-2 text-xs text-muted-foreground">
              Xem trước: <ChipPreview name={t} color={color} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

/* ---------- Xác nhận chuyển nhóm (AC2) ---------- */

function MoveConfirmModal({
  dialog,
  pages,
  groups,
  busy,
  onClose,
  onConfirm,
}: {
  dialog: { groupId: string; groupName: string; pageIds: string[]; impact: GroupMoveImpact }
  pages: Page[]
  groups: Group[]
  busy?: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const nameOf = (gid: string | null) => groups.find((g) => g.id === gid)?.name ?? 'nhóm cũ'
  const movers = dialog.impact.moves
  return (
    <Modal
      open
      onClose={onClose}
      title="Chuyển trang sang nhóm khác?"
      width={480}
      footer={
        <>
          <Button onClick={onClose}>Huỷ</Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>
            Chuyển sang {dialog.groupName}
          </Button>
        </>
      }
    >
      <p className="text-sm">
        {movers.length === 1 ? 'Trang này sẽ chuyển khỏi' : `${movers.length} trang sẽ chuyển khỏi`}{' '}
        {[...new Set(movers.map((m) => nameOf(m.fromGroupId)))].map((n, i, arr) => (
          <span key={n}>
            <span className="font-medium">{n}</span>
            {i < arr.length - 1 ? ', ' : ''}
          </span>
        ))}{' '}
        và dùng cấu hình của <span className="font-medium">{dialog.groupName}</span>.
      </p>
      <ul className="mt-3 space-y-1.5">
        {movers.map((m) => {
          const p = pages.find((x) => x.id === m.pageId)
          return (
            <li key={m.pageId} className="flex items-center gap-2 text-sm">
              {p && <PageAvatar page={p} size={22} />}
              <span>{p?.name ?? m.pageId}</span>
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                đang ở <GroupChip groupId={m.fromGroupId} size="sm" />
              </span>
            </li>
          )
        })}
      </ul>
      {dialog.impact.campaigns.length > 0 && (
        <p className="mt-3 text-xs text-amber-800">
          {dialog.impact.campaigns.length} chiến dịch đang chạy dùng các trang này. Chiến dịch vẫn tiếp tục trên từng trang.
        </p>
      )}
    </Modal>
  )
}

/* ---------- Thêm vào nhóm (hàng loạt) ---------- */

function AddToGroupModal({
  pageIds,
  pages,
  groups,
  busy,
  onClose,
  onPick,
  onCreateNew,
}: {
  pageIds: string[]
  pages: Page[]
  groups: Group[]
  busy?: boolean
  onClose: () => void
  onPick: (gid: string) => void
  onCreateNew: () => void
}) {
  const [gid, setGid] = useState<string | null>(null)
  const chosen = pages.filter((p) => pageIds.includes(p.id))
  const movers = gid ? chosen.filter((p) => p.groupId && p.groupId !== gid) : []
  return (
    <Modal
      open
      onClose={onClose}
      title={`Thêm ${chosen.length} trang vào nhóm`}
      width={480}
      footer={
        <>
          <Button onClick={onClose}>Huỷ</Button>
          <Button variant="primary" disabled={!gid || busy} onClick={() => gid && onPick(gid)}>
            Thêm vào nhóm
          </Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap gap-1.5">
        {chosen.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border border-border py-0.5 pr-2.5 pl-0.5 text-xs">
            <PageAvatar page={p} size={20} /> {p.name}
          </span>
        ))}
      </div>
      <div className="space-y-1.5" role="radiogroup" aria-label="Chọn nhóm">
        {groups.map((g) => {
          const count = pages.filter((p) => p.groupId === g.id).length
          return (
            <label key={g.id} className={cn('flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5', gid === g.id ? 'border-primary bg-primary-soft/30' : 'border-border hover:bg-slate-50')}>
              <input type="radio" name="grp" className="accent-primary" checked={gid === g.id} onChange={() => setGid(g.id)} />
              <GroupChip groupId={g.id} />
              <span className="ml-auto text-xs text-muted-foreground">{count} trang</span>
            </label>
          )
        })}
        <button
          type="button"
          onClick={onCreateNew}
          className="flex w-full items-center gap-2 rounded-md border border-dashed border-slate-300 px-3 py-2.5 text-sm font-medium text-primary hover:border-primary hover:bg-primary-soft/30"
        >
          <Plus size={16} /> Tạo nhóm mới với {chosen.length} trang này
        </button>
      </div>
      {movers.length > 0 && (
        <p className="mt-3 text-xs text-amber-800">
          {movers.map((p) => `${p.name} (đang ở ${groups.find((g) => g.id === p.groupId)?.name})`).join(', ')} sẽ chuyển sang nhóm này.
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">Trang mới vào nhóm sẽ dùng hồ sơ thương hiệu và AI trả lời của nhóm.</p>
    </Modal>
  )
}
