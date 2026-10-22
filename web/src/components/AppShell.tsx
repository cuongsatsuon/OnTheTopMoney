import {
  AlertTriangle,
  Bell,
  BotMessageSquare,
  CalendarDays,
  ChartLine,
  Check,
  ChevronDown,
  Inbox,
  LayoutDashboard,
  Layers,
  LogOut,
  Megaphone,
  PenSquare,
  Plus,
  Search,
  Settings,
  Users,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { conversations, groups, pages, pagesInGroup } from '../data/mock'
import { BUDGET_BANNER_ACTION, BUDGET_BANNER_TEXT, budgetView, useAiBudget, useAiBudgetToasts } from '../lib/ai-budget'
import { useApp, type Scope } from '../lib/app-context'
import { usePages } from '../lib/connections'
import { useLogout } from '../lib/session'
import { errorMessageOf } from '../lib/error-messages'
import { useNotificationToasts, useNotifications } from '../lib/notifications'
import { useRealtimeStatus } from '../lib/realtime'
import { NotificationsDrawer } from './NotificationsDrawer'
import { Avatar, Button, PageAvatar, cn } from './ui'

const needsYou = conversations.filter((c) => c.state === 'handoff' || (c.state === 'human' && c.unread)).length

const nav = [
  { to: '/', label: 'Tổng quan', icon: LayoutDashboard, end: true },
  { to: '/hop-thu', label: 'Hộp thư', icon: Inbox, badge: needsYou },
  { to: '/khach-hang', label: 'Khách hàng', icon: Users },
  { to: '/soan-bai', label: 'Soạn bài AI', icon: PenSquare },
  { to: '/lich', label: 'Lịch nội dung', icon: CalendarDays },
  { to: '/chien-dich', label: 'Chiến dịch nuôi page', icon: Megaphone },
  { to: '/hieu-suat', label: 'Hiệu suất', icon: ChartLine },
  { to: '/trang-nhom', label: 'Trang & Nhóm', icon: Layers },
  { to: '/ai-tra-loi', label: 'AI trả lời tự động', icon: BotMessageSquare },
  { to: '/cai-dat', label: 'Cài đặt', icon: Settings },
]

function LogoutButton() {
  const { notify } = useApp()
  const logout = useLogout()
  return (
    <button
      type="button"
      onClick={() => logout.mutate(undefined, { onError: (err) => notify(errorMessageOf(err)) })}
      disabled={logout.isPending}
      className="mx-3 mb-3 flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-white/5 hover:text-white disabled:opacity-50"
    >
      <LogOut size={18} />
      <span>{logout.isPending ? 'Đang đăng xuất…' : 'Đăng xuất'}</span>
    </button>
  )
}

function Sidebar() {
  return (
    <aside className="flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="flex size-8 items-center justify-center rounded-md bg-primary font-bold text-white">O</span>
        <span className="text-[15px] font-bold tracking-tight text-white">OnTheTopMoney</span>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3" aria-label="Điều hướng chính">
        {nav.map(({ to, label, icon: Icon, end, badge }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive ? 'bg-sidebar-active text-white' : 'hover:bg-white/5 hover:text-white',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r bg-primary-soft" />}
                <Icon size={18} />
                <span className="flex-1">{label}</span>
                {badge ? <span className="rounded-full bg-warning px-1.5 text-[11px] font-semibold text-white">{badge}</span> : null}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <AiBudgetChip />
      <LogoutButton />
    </aside>
  )
}

/** Chi phí AI tháng này ở sidebar (số thật): vàng khi sắp chạm hạn mức, đỏ khi đã hết; luôn kèm chữ. */
function AiBudgetChip() {
  const budget = useAiBudget()
  const view = budget.data ? budgetView(budget.data) : null
  return (
    <Link
      to="/cai-dat"
      aria-label={
        view
          ? `Chi phí AI tháng này: ${view.percent}% hạn mức, ${view.usedText}${view.status ? `, ${view.status}` : ''}. Mở Cài đặt`
          : budget.isError
            ? 'Chi phí AI tháng này: chưa tải được. Mở Cài đặt'
            : 'Chi phí AI tháng này. Mở Cài đặt'
      }
      className={cn(
        'm-3 block rounded-md p-3 text-xs transition-colors',
        view?.tone === 'warn' && 'bg-amber-400/15 ring-1 ring-amber-400/50 hover:bg-amber-400/20',
        view?.tone === 'blocked' && 'bg-red-500/15 ring-1 ring-red-400/60 hover:bg-red-500/20',
        (!view || view.tone === 'normal') && 'bg-white/5 hover:bg-white/10',
      )}
    >
      <div className="mb-1.5 flex justify-between">
        <span>Chi phí AI tháng này</span>
        {view ? (
          <span className={cn('font-semibold', view.tone === 'warn' ? 'text-amber-300' : view.tone === 'blocked' ? 'text-red-300' : 'text-white')}>
            {view.percent}%
          </span>
        ) : budget.isError ? (
          <span className="font-semibold text-white">—</span>
        ) : (
          <span aria-hidden className="h-3.5 w-8 animate-pulse rounded bg-white/10" />
        )}
      </div>
      <div className="h-1.5 rounded-full bg-white/10">
        {view && (
          <div
            className={cn('h-full rounded-full', view.tone === 'warn' ? 'bg-amber-400' : view.tone === 'blocked' ? 'bg-red-500' : 'bg-primary-soft')}
            style={{ width: `${view.barPercent}%` }}
          />
        )}
      </div>
      <div className="mt-1.5 text-sidebar-foreground/70">
        {view ? view.usedText : budget.isError ? 'Chưa tải được chi phí (tự thử lại sau 1 phút)' : <span aria-hidden className="inline-block h-3 w-28 animate-pulse rounded bg-white/10" />}
      </div>
      {view?.status && (
        <div className={cn('mt-1.5 flex items-center gap-1 font-semibold', view.tone === 'blocked' ? 'text-red-300' : 'text-amber-300')}>
          <AlertTriangle size={12} aria-hidden />
          {view.status}
        </div>
      )}
    </Link>
  )
}

function ScopeSwitcher() {
  const { scope, setScope, scopeLabel } = useApp()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const choose = (s: Scope) => {
    setScope(s)
    setOpen(false)
    setQ('')
  }
  const isSel = (s: Scope) => JSON.stringify(s) === JSON.stringify(scope)
  const match = (name: string) => name.toLowerCase().includes(q.toLowerCase())

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm hover:bg-slate-50"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="text-muted-foreground">Phạm vi:</span>
        <span className="font-semibold">{scopeLabel}</span>
        <ChevronDown size={16} className="text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute top-11 left-0 z-30 w-80 rounded-lg border border-border bg-surface p-2 shadow-lg" role="listbox">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Tìm trang hoặc nhóm…"
            className="mb-2 h-8 w-full rounded-sm border border-border px-2.5 text-sm focus:border-primary focus:outline-none"
          />
          <ScopeItem selected={isSel({ kind: 'all' })} onClick={() => choose({ kind: 'all' })}>
            <Layers size={16} className="text-muted-foreground" /> Tất cả trang <span className="ml-auto text-xs text-muted-foreground">{pages.length}</span>
          </ScopeItem>
          <div className="mt-2 px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Nhóm</div>
          {groups.filter((g) => match(g.name)).map((g) => (
            <ScopeItem key={g.id} selected={isSel({ kind: 'group', id: g.id })} onClick={() => choose({ kind: 'group', id: g.id })}>
              <span className="size-2.5 rounded-full" style={{ backgroundColor: g.color }} /> {g.name}
              <span className="ml-auto text-xs text-muted-foreground">{pagesInGroup(g.id).length} trang</span>
            </ScopeItem>
          ))}
          <div className="mt-2 px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Trang</div>
          <div className="max-h-56 overflow-y-auto">
            {pages.filter((p) => match(p.name)).map((p) => (
              <ScopeItem key={p.id} selected={isSel({ kind: 'page', id: p.id })} onClick={() => choose({ kind: 'page', id: p.id })}>
                <PageAvatar page={p} size={22} /> <span className="truncate">{p.name}</span>
              </ScopeItem>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ScopeItem({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="option"
      aria-selected={selected}
      onClick={onClick}
      className={cn('flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm', selected ? 'bg-primary-soft/60' : 'hover:bg-slate-50')}
    >
      {children}
      {selected && <Check size={15} className="ml-1 text-primary" />}
    </button>
  )
}

function NotificationBell() {
  const [open, setOpen] = useState(false)
  const list = useNotifications()
  const unread = list.data?.unreadCount ?? 0
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative rounded-md p-2 text-muted-foreground hover:bg-slate-100"
        aria-label={unread > 0 ? `Thông báo, ${unread} chưa đọc` : 'Thông báo'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Bell size={19} />
        {unread > 0 && <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger" />}
      </button>
      <NotificationsDrawer open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/** Dải xám đầu vùng nội dung khi mất kết nối realtime (tự ẩn khi nối lại). Dính đầu cùng banner hạn mức. */
function ReconnectingBanner() {
  const status = useRealtimeStatus()
  if (status !== 'reconnecting') return null
  return (
    <div role="status" className="bg-slate-200 px-6 py-1.5 text-center text-[13px] text-slate-700">
      Đang kết nối lại…
    </div>
  )
}

/** Banner đỏ toàn app khi đã dùng hết hạn mức AI tháng này; tăng hạn mức thì tự mất. */
function AiBudgetBanner() {
  const budget = useAiBudget()
  if (!budget.data || !budgetView(budget.data).banner) return null
  return (
    <div role="alert" className="flex items-center justify-center gap-2 bg-danger px-6 py-2 text-center text-[13px] font-medium text-white">
      <AlertTriangle size={15} aria-hidden />
      <span>{BUDGET_BANNER_TEXT} —</span>
      <Link to="/cai-dat" className="font-semibold underline underline-offset-2 hover:no-underline">
        {BUDGET_BANNER_ACTION}
      </Link>
    </div>
  )
}

function Topbar() {
  const navigate = useNavigate()
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-6">
      <ScopeSwitcher />
      <div className="relative ml-2 max-w-md flex-1">
        <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground" />
        <input
          placeholder="Tìm khách hàng, bài viết, trang…"
          className="h-9 w-full rounded-md border border-border bg-background pr-14 pl-9 text-sm focus:border-primary focus:outline-none"
        />
        <kbd className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded border border-border bg-surface px-1.5 text-[11px] text-muted-foreground">⌘K</kbd>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/soan-bai')}>
          Tạo bài viết
        </Button>
        <NotificationBell />
        <Avatar name="Chủ shop" color="#99F6E4" size={32} />
      </div>
    </header>
  )
}

export default function AppShell() {
  const { notify } = useApp()
  // Tải trang thật (và chép vào kho mẫu) ở mọi màn để bộ chọn phạm vi và màn chi tiết thấy chúng (Story 2.2).
  usePages()
  useNotificationToasts(notify)
  useAiBudgetToasts(notify)
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto">
          <div className="sticky top-0 z-20">
            <ReconnectingBanner />
            <AiBudgetBanner />
          </div>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

/** Vùng nội dung chuẩn: lề 24px, rộng tối đa 1440px. */
export function Content({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('mx-auto max-w-[1440px] p-6', className)}>{children}</div>
}
