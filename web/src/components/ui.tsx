import clsx from 'clsx'
import { ArrowDownRight, ArrowUpRight, Sparkles, X } from 'lucide-react'
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { groupById, type ConnectionStatus, type Page, type Platform } from '../data/mock'

export const cn = clsx

/* ---------- Buttons ---------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'ai' | 'danger'
type ButtonSize = 'sm' | 'md'

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  icon,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-[13px]' : 'h-9 px-4 text-sm',
        variant === 'primary' && 'bg-primary text-primary-foreground hover:bg-primary-hover',
        variant === 'secondary' && 'border border-border bg-surface text-foreground hover:bg-slate-50',
        variant === 'ghost' && 'text-muted-foreground hover:bg-slate-100 hover:text-foreground',
        variant === 'ai' && 'bg-ai text-ai-foreground hover:bg-violet-700',
        variant === 'danger' && 'border border-red-200 bg-surface text-danger hover:bg-red-50',
        className,
      )}
      {...props}
    >
      {variant === 'ai' && !icon ? <Sparkles size={15} /> : icon}
      {children}
    </button>
  )
}

/* ---------- Surfaces ---------- */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-lg border border-border bg-surface', className)}>{children}</div>
}

export function CardHeader({ title, subtitle, action, className }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 border-b border-border px-4 py-3', className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="mb-6">
      {breadcrumb && <div className="mb-2 text-[13px] text-muted-foreground">{breadcrumb}</div>}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

/* ---------- Chips & badges ---------- */

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'ai' | 'primary' | 'info'

export function Chip({ tone = 'neutral', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-slate-100 text-slate-700',
        tone === 'success' && 'bg-green-50 text-green-700',
        tone === 'warning' && 'bg-warning-soft text-amber-800',
        tone === 'danger' && 'bg-red-50 text-red-700',
        tone === 'ai' && 'bg-ai-soft text-ai',
        tone === 'primary' && 'bg-primary-soft text-primary-hover',
        tone === 'info' && 'bg-blue-50 text-blue-700',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}

export function AiBadge({ label = 'AI tạo' }: { label?: string }) {
  return (
    <Chip tone="ai" icon={<Sparkles size={11} />}>
      {label}
    </Chip>
  )
}

export function GroupChip({ groupId, size = 'md' }: { groupId: string | null; size?: 'sm' | 'md' }) {
  const g = groupById(groupId)
  if (!g) return <span className="text-xs text-muted-foreground">Chưa có nhóm</span>
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap', size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-0.5 text-xs')}
      style={{ backgroundColor: `${g.color}1F`, color: g.color }}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: g.color }} />
      {g.name}
    </span>
  )
}

export function StatusChip({ status }: { status: ConnectionStatus }) {
  if (status === 'active') return <Chip tone="success">● Đang hoạt động</Chip>
  if (status === 'expiring') return <Chip tone="warning">▲ Token sắp hết hạn</Chip>
  return <Chip tone="danger">✕ Mất kết nối</Chip>
}

/* ---------- Platform identity ---------- */

export const platformLabel: Record<Platform, string> = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads' }
export const platformColor: Record<Platform, string> = { facebook: '#1877F2', instagram: '#E1306C', threads: '#101010' }

export function PlatformIcon({ platform, size = 16, className }: { platform: Platform; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', role: 'img', 'aria-label': platformLabel[platform], className }
  if (platform === 'facebook')
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="12" fill="#1877F2" />
        <path fill="#fff" d="M13.4 19.5v-6h2l.3-2.4h-2.3V9.6c0-.7.2-1.2 1.2-1.2h1.2V6.3c-.2 0-1-.1-1.8-.1-1.8 0-3 1.1-3 3.1v1.8H9v2.4h2v6h2.4Z" />
      </svg>
    )
  if (platform === 'instagram')
    return (
      <svg {...common}>
        <defs>
          <linearGradient id="ig" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#FEDA75" />
            <stop offset=".5" stopColor="#E1306C" />
            <stop offset="1" stopColor="#833AB4" />
          </linearGradient>
        </defs>
        <rect width="24" height="24" rx="7" fill="url(#ig)" />
        <rect x="6" y="6" width="12" height="12" rx="3.5" fill="none" stroke="#fff" strokeWidth="1.6" />
        <circle cx="12" cy="12" r="2.8" fill="none" stroke="#fff" strokeWidth="1.6" />
        <circle cx="15.6" cy="8.4" r=".9" fill="#fff" />
      </svg>
    )
  return (
    <svg {...common}>
      <rect width="24" height="24" rx="7" fill="#101010" />
      <path
        fill="none"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        d="M15.3 11.3c-.4-2-1.7-2.9-3.4-2.9-2 0-3.2 1.4-3.2 3.6s1.3 3.6 3.3 3.6c1.6 0 2.8-.9 2.8-2.3 0-1.5-1.3-2.1-2.6-2-1.4.1-2 .8-1.9 1.5.1.8.9 1.1 1.6 1 1.4-.1 2-1.3 2-3"
      />
    </svg>
  )
}

export function Avatar({ name, color = '#CBD5E1', size = 36, className }: { name: string; color?: string; size?: number; className?: string }) {
  const initials = name
    .replace(/[^\p{L}\s.]/gu, '')
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(-2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-slate-700', className)}
      style={{ width: size, height: size, backgroundColor: color, fontSize: size * 0.36 }}
      aria-hidden
    >
      {initials}
    </span>
  )
}

/** Avatar trang luôn kèm icon nền tảng ở góc dưới phải (DESIGN.md › Components). */
export function PageAvatar({ page, size = 36 }: { page: Page; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar name={page.name} color={page.avatarColor} size={size} />
      <span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-white p-px">
        <PlatformIcon platform={page.platform} size={Math.max(12, Math.round(size * 0.42))} />
      </span>
    </span>
  )
}

export function PageLabel({ page, sub }: { page: Page; sub?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <PageAvatar page={page} size={32} />
      <span className="min-w-0">
        <span className="block truncate font-medium">{page.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{sub ?? platformLabel[page.platform]}</span>
      </span>
    </span>
  )
}

/* ---------- KPI ---------- */

export function KpiCard({ label, value, delta, hint, icon }: { label: string; value: string; delta?: number; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-[13px] font-medium text-muted-foreground">
        {label}
        {icon}
      </div>
      <div className="tabular mt-2 text-[28px] leading-none font-bold tracking-tight">{value}</div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        {delta !== undefined && (
          <span className={cn('inline-flex items-center font-semibold', delta >= 0 ? 'text-success' : 'text-danger')}>
            {delta >= 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
            {delta >= 0 ? '+' : ''}
            {delta}%
          </span>
        )}
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </div>
    </Card>
  )
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-slate-100', className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  )
}

/* ---------- Form controls ---------- */

export function Switch({
  checked,
  onChange,
  label,
  ai,
  disabled,
  title,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
  ai?: boolean
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? (ai ? 'bg-ai' : 'bg-primary') : 'bg-slate-300',
      )}
    >
      <span className={cn('inline-block size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  )
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-[13px] font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

const inputCls = 'rounded-sm border border-border bg-surface px-3 text-sm placeholder:text-slate-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15'

/** Mặc định rộng 100%, trừ khi className đã đặt chiều rộng (w-48, w-[150px]…) — tránh hai lớp width đè nhau. */
const fieldCls = (extra: string, className?: string) => cn(inputCls, /(^|\s)(w-|flex-1)/.test(className ?? '') ? '' : 'w-full', extra, className)

/** `ref` (React 19: prop thường) để màn gọi `focus()` — vd "Thử mô tả khác" ở Soạn bài. */
export function Input(props: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input {...props} className={fieldCls('h-9', props.className)} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea {...props} className={fieldCls('py-2', props.className)} />
}

/** `options`: chuỗi (giá trị = nhãn) hoặc `{value, label}` khi giá trị khác chữ hiển thị (vd id model). */
export function Select({ options, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { options: (string | { value: string; label: string })[] }) {
  return (
    <select {...props} className={fieldCls('h-9 pr-8', props.className)}>
      {options.map((o) =>
        typeof o === 'string' ? (
          <option key={o}>{o}</option>
        ) : (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ),
      )}
    </select>
  )
}

/* ---------- Tabs ---------- */

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cn('flex gap-1 border-b border-border', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            value === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className={cn('rounded-full px-1.5 text-xs', value === t.id ? 'bg-primary-soft' : 'bg-slate-100')}>{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cn('rounded-[6px] px-3 py-1 text-[13px] font-medium', value === o.id ? 'bg-primary-soft text-primary-hover' : 'text-muted-foreground hover:text-foreground')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ---------- Overlays ---------- */

export function Drawer({ open, onClose, title, children, footer, width = 400 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20" onClick={onClose}>
      <aside className="flex h-full flex-col border-l border-border bg-surface shadow-xl" style={{ width }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-slate-100" aria-label="Đóng">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </aside>
    </div>
  )
}

export function Modal({ open, onClose, title, children, footer, width = 520 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full overflow-hidden rounded-lg bg-surface shadow-2xl" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-slate-100" aria-label="Đóng">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 rounded-full bg-primary-soft p-3 text-primary">{icon}</div>}
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/** Nhãn kế thừa cấu hình (EXPERIENCE.md › Component Patterns › Nhãn kế thừa). */
export function InheritanceBar({ groupName, own, onToggle, what }: { groupName: string | null; own: boolean; onToggle: (v: boolean) => void; what: string }) {
  if (!groupName)
    return (
      <div className="mb-5 rounded-md border border-border bg-slate-50 px-4 py-3 text-sm text-muted-foreground">
        Trang này chưa thuộc nhóm nào nên dùng {what} riêng.
      </div>
    )
  return (
    <div className={cn('mb-5 flex items-center justify-between gap-4 rounded-md border px-4 py-3 text-sm', own ? 'border-border bg-slate-50' : 'border-primary/30 bg-primary-soft/50')}>
      <span>
        {own ? (
          <>Trang này đang dùng {what} riêng, không theo <b>{groupName}</b>.</>
        ) : (
          <>Đang dùng {what} của <b>{groupName}</b>.</>
        )}
      </span>
      <span className="flex items-center gap-2 text-[13px] font-medium whitespace-nowrap">
        Dùng {what} riêng
        <Switch checked={own} onChange={onToggle} label={`Dùng ${what} riêng`} />
      </span>
    </div>
  )
}

export function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return
    const t = setTimeout(onDone, 2600)
    return () => clearTimeout(t)
  }, [message, onDone])
  if (!message) return null
  return (
    <div className="fixed right-6 bottom-20 z-[60] rounded-md bg-slate-900 px-4 py-3 text-sm text-white shadow-lg" role="status">
      {message}
    </div>
  )
}
