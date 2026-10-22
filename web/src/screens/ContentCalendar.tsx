import { AlertTriangle, Check, ChevronLeft, ChevronRight, Clock, Megaphone, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AiLockHint } from '../components/AiLockHint'
import { Content } from '../components/AppShell'
import {
  AiBadge,
  Button,
  Card,
  Chip,
  Drawer,
  Modal,
  PageHeader,
  PageLabel,
  PlatformIcon,
  Segmented,
  Select,
  cn,
} from '../components/ui'
import { campaigns, compact, pageById, posts as seedPosts, type Platform, type Post, type PostStatus } from '../data/mock'
import { useApp } from '../lib/app-context'

/* ---------- Ngày tháng ---------- */

const TODAY = '2026-10-19'
const WEEK_LABELS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']
const WEEKDAY_NAMES = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy']
const HOURS = Array.from({ length: 16 }, (_, i) => i + 7) // 07:00 → 22:00

const pad = (n: number) => String(n).padStart(2, '0')
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fromIso = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const mondayOf = (d: Date) => addDays(d, -((d.getDay() + 6) % 7))
const dayLabel = (iso: string) => {
  const d = fromIso(iso)
  return `${WEEKDAY_NAMES[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
}

/* ---------- Trạng thái ---------- */

const STATUS_FILTERS = ['Tất cả trạng thái', 'Đã lên lịch', 'Chờ duyệt', 'Đã đăng', 'Lỗi đăng', 'Nháp'] as const
const STATUS_BY_LABEL: Record<string, PostStatus> = {
  'Đã lên lịch': 'scheduled',
  'Chờ duyệt': 'pending',
  'Đã đăng': 'published',
  'Lỗi đăng': 'failed',
  Nháp: 'draft',
}
const PLATFORM_FILTERS = ['Tất cả nền tảng', 'Facebook', 'Instagram', 'Threads']

const statusPill: Record<PostStatus, string> = {
  scheduled: 'border-primary/25 bg-primary-soft/60 text-teal-900',
  pending: 'border-amber-300 bg-warning-soft text-amber-900',
  published: 'border-border bg-slate-100 text-muted-foreground',
  failed: 'border-red-300 bg-red-50 text-red-800',
  draft: 'border-dashed border-slate-300 bg-surface text-slate-600',
}

function StatusLabel({ status }: { status: PostStatus }) {
  if (status === 'scheduled') return <Chip tone="primary">Đã lên lịch</Chip>
  if (status === 'pending') return <Chip tone="warning">Chờ duyệt</Chip>
  if (status === 'published') return <Chip tone="success" icon={<Check size={11} />}>Đã đăng</Chip>
  if (status === 'failed') return <Chip tone="danger" icon={<AlertTriangle size={11} />}>Lỗi đăng</Chip>
  return <Chip>Nháp</Chip>
}

const platformsOf = (p: Post): Platform[] => [...new Set(p.pageIds.map((id) => pageById(id).platform))]
const failReason = (p: Post) => {
  const page = pageById(p.pageIds[0])
  return `Token ${page.platform === 'threads' ? 'Threads' : 'của trang'} “${page.name}” đã hết hạn nên không đăng được lúc ${p.time}. Kết nối lại rồi bấm “Đăng lại”.`
}

/* ---------- Màn hình ---------- */

export default function ContentCalendar() {
  const { inScope, scopeLabel, notify, openAiKeySet } = useApp()
  const navigate = useNavigate()

  const [items, setItems] = useState<Post[]>(seedPosts)
  const [view, setView] = useState<'month' | 'week'>('month')
  const [month, setMonth] = useState(() => new Date(2026, 9, 1))
  const [weekStart, setWeekStart] = useState(() => mondayOf(fromIso(TODAY)))
  const [platform, setPlatform] = useState(PLATFORM_FILTERS[0])
  const [status, setStatus] = useState<string>(STATUS_FILTERS[0])
  const [expandedDay, setExpandedDay] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), [])

  const visible = useMemo(
    () =>
      items
        .filter((p) => inScope(p.pageIds))
        .filter((p) => platform === PLATFORM_FILTERS[0] || platformsOf(p).some((pl) => pl === platform.toLowerCase()))
        .filter((p) => status === STATUS_FILTERS[0] || p.status === STATUS_BY_LABEL[status])
        .sort((a, b) => a.time.localeCompare(b.time)),
    [items, inScope, platform, status],
  )
  const byDay = useMemo(() => {
    const m = new Map<string, Post[]>()
    visible.forEach((p) => m.set(p.date, [...(m.get(p.date) ?? []), p]))
    return m
  }, [visible])

  const open = items.find((p) => p.id === openId) ?? null

  /* --- Điều hướng --- */
  const title =
    view === 'month'
      ? `Tháng ${month.getMonth() + 1}, ${month.getFullYear()}`
      : `${pad(weekStart.getDate())}/${pad(weekStart.getMonth() + 1)} – ${(() => {
          const e = addDays(weekStart, 6)
          return `${pad(e.getDate())}/${pad(e.getMonth() + 1)}/${e.getFullYear()}`
        })()}`
  const shift = (dir: 1 | -1) => {
    if (view === 'month') setMonth((m) => new Date(m.getFullYear(), m.getMonth() + dir, 1))
    else setWeekStart((w) => addDays(w, dir * 7))
  }
  const goToday = () => {
    setMonth(new Date(2026, 9, 1))
    setWeekStart(mondayOf(fromIso(TODAY)))
  }

  /* --- Kéo thả --- */
  const onDragStart = (e: DragEvent, p: Post) => {
    if (p.status === 'published') {
      e.preventDefault()
      return
    }
    e.dataTransfer.setData('text/plain', p.id)
    e.dataTransfer.effectAllowed = 'move'
    setDragId(p.id)
  }
  const onDragOver = (e: DragEvent, key: string) => {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (overKey !== key) setOverKey(key)
  }
  const onDrop = (e: DragEvent, date: string, hour?: number) => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain') || dragId
    setDragId(null)
    setOverKey(null)
    const p = items.find((x) => x.id === id)
    if (!p) return
    if (date < TODAY) {
      notify('Không thể dời bài về ngày đã qua')
      return
    }
    const newTime = hour !== undefined ? `${pad(hour)}:${p.time.split(':')[1] ?? '00'}` : p.time
    if (p.date === date && p.time === newTime) return
    setItems((all) => all.map((x) => (x.id === p.id ? { ...x, date, time: newTime } : x)))
    notify(`Đã dời “${p.title}” sang ${newTime}, ${dayLabel(date)}`)
  }
  const endDrag = () => {
    setDragId(null)
    setOverKey(null)
  }

  /* --- Hành động trong drawer --- */
  const update = (id: string, patch: Partial<Post>) => setItems((all) => all.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  const closeDrawer = () => {
    setOpenId(null)
    setRegenerating(false)
  }

  function approve(p: Post) {
    update(p.id, { status: 'scheduled' })
    notify(`Đã duyệt — bài sẽ đăng lúc ${p.time}, ${dayLabel(p.date)}`)
  }
  function repost(p: Post) {
    update(p.id, { status: 'published', reach: 0, engagement: 0 })
    notify(`Đã đăng lại “${p.title}”`)
  }
  function regenerate(p: Post) {
    setRegenerating(true)
    const id = window.setTimeout(() => {
      update(p.id, {
        caption: `✨ ${p.title}: bí quyết nhỏ, hiệu quả lớn! Lưu lại ngay để không bỏ lỡ nhé 💡\n\n👉 Nhắn tin cho shop để được tư vấn miễn phí.`,
        ai: true,
        image: `https://picsum.photos/seed/${p.id}r${Date.now() % 1000}/600/600`,
      })
      setRegenerating(false)
      notify('AI đã viết lại bài')
    }, 1300)
    timers.current.push(id)
  }
  function remove(p: Post) {
    setItems((all) => all.filter((x) => x.id !== p.id))
    setConfirmDelete(false)
    closeDrawer()
    notify(`Đã xoá “${p.title}”`)
  }

  /* --- Lưới tháng --- */
  const monthCells = useMemo(() => {
    const start = mondayOf(month)
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0)
    const end = addDays(mondayOf(last), 6)
    const cells: Date[] = []
    for (let d = start; d <= end; d = addDays(d, 1)) cells.push(d)
    return cells
  }, [month])

  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])

  const counts = {
    pending: visible.filter((p) => p.status === 'pending').length,
    failed: visible.filter((p) => p.status === 'failed').length,
  }

  return (
    <Content>
      <PageHeader
        title="Lịch nội dung"
        subtitle={`${scopeLabel} · ${visible.length} bài · Kéo bài sang ngày khác để đổi lịch`}
        actions={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/soan-bai')}>
            Tạo bài viết
          </Button>
        }
      />

      <Card className="mb-4 flex flex-wrap items-center gap-3 px-4 py-3">
        <Segmented
          options={[
            { id: 'week', label: 'Tuần' },
            { id: 'month', label: 'Tháng' },
          ]}
          value={view}
          onChange={setView}
        />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => shift(-1)} aria-label="Trước" className="px-2">
            <ChevronLeft size={16} />
          </Button>
          <span className="min-w-[160px] text-center text-[15px] font-semibold">{title}</span>
          <Button variant="ghost" size="sm" onClick={() => shift(1)} aria-label="Sau" className="px-2">
            <ChevronRight size={16} />
          </Button>
          <Button size="sm" onClick={goToday} className="ml-1">
            Hôm nay
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Select options={PLATFORM_FILTERS} value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-[170px]" aria-label="Nền tảng" />
          <Select options={[...STATUS_FILTERS]} value={status} onChange={(e) => setStatus(e.target.value)} className="w-[170px]" aria-label="Trạng thái" />
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-2.5 text-xs text-muted-foreground">
          <Legend className={statusPill.scheduled} label="Đã lên lịch" />
          <Legend className={statusPill.pending} label="Chờ duyệt" />
          <Legend className={statusPill.published} label="Đã đăng" />
          <Legend className={statusPill.failed} label="Lỗi đăng" />
          <Legend className={statusPill.draft} label="Nháp" />
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-1 rounded-sm bg-ai" />
            <span className="font-semibold text-ai">AI</span> AI tạo
          </span>
          {(counts.pending > 0 || counts.failed > 0) && (
            <span className="ml-auto flex items-center gap-3">
              {counts.pending > 0 && (
                <Link to="/chien-dich" className="font-medium text-amber-800 hover:underline">
                  {counts.pending} bài chờ duyệt
                </Link>
              )}
              {counts.failed > 0 && <span className="font-medium text-danger">{counts.failed} bài đăng lỗi</span>}
            </span>
          )}
        </div>
      </Card>

      {view === 'month' ? (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-7 border-b border-border bg-slate-50">
            {WEEK_LABELS.map((w) => (
              <div key={w} className="px-2 py-2 text-center text-xs font-semibold text-muted-foreground">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {monthCells.map((d, i) => {
              const iso = toIso(d)
              const inMonth = d.getMonth() === month.getMonth()
              const list = byDay.get(iso) ?? []
              const isExpanded = expandedDay === iso
              const shown = isExpanded ? list : list.slice(0, 3)
              const past = iso < TODAY
              return (
                <div
                  key={iso}
                  onDragOver={(e) => onDragOver(e, iso)}
                  onDragLeave={() => overKey === iso && setOverKey(null)}
                  onDrop={(e) => onDrop(e, iso)}
                  className={cn(
                    'min-h-[124px] border-border p-1.5 transition-colors',
                    i % 7 !== 6 && 'border-r',
                    i < monthCells.length - 7 && 'border-b',
                    !inMonth && 'bg-slate-50/70',
                    overKey === iso && (past ? 'bg-red-50' : 'bg-primary-soft/40 ring-2 ring-primary/40 ring-inset'),
                  )}
                >
                  <div className="mb-1 flex items-center justify-between px-0.5">
                    <span
                      className={cn(
                        'tabular flex size-6 items-center justify-center rounded-full text-xs font-medium',
                        iso === TODAY ? 'bg-primary text-white' : inMonth ? 'text-foreground' : 'text-slate-400',
                      )}
                    >
                      {d.getDate()}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {shown.map((p) => (
                      <Pill key={p.id} post={p} dragging={dragId === p.id} onDragStart={onDragStart} onDragEnd={endDrag} onOpen={() => setOpenId(p.id)} />
                    ))}
                    {list.length > 3 && (
                      <button
                        onClick={() => setExpandedDay(isExpanded ? null : iso)}
                        className="w-full rounded px-1.5 py-0.5 text-left text-[11px] font-medium text-primary hover:bg-primary-soft/50"
                      >
                        {isExpanded ? 'Thu gọn' : `+${list.length - 3} bài`}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-border bg-slate-50">
            <div />
            {weekDays.map((d, i) => {
              const iso = toIso(d)
              return (
                <div key={iso} className="border-l border-border px-2 py-2 text-center">
                  <div className="text-xs font-semibold text-muted-foreground">{WEEK_LABELS[i]}</div>
                  <div
                    className={cn(
                      'tabular mx-auto mt-0.5 flex size-7 items-center justify-center rounded-full text-sm font-semibold',
                      iso === TODAY && 'bg-primary text-white',
                    )}
                  >
                    {d.getDate()}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="max-h-[620px] overflow-y-auto scrollbar-thin">
            {HOURS.map((h) => (
              <div key={h} className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-border last:border-b-0">
                <div className="tabular px-2 pt-1 text-right text-[11px] text-muted-foreground">{pad(h)}:00</div>
                {weekDays.map((d) => {
                  const iso = toIso(d)
                  const key = `${iso}@${h}`
                  const list = (byDay.get(iso) ?? []).filter((p) => parseInt(p.time, 10) === h)
                  const past = iso < TODAY
                  return (
                    <div
                      key={key}
                      onDragOver={(e) => onDragOver(e, key)}
                      onDragLeave={() => overKey === key && setOverKey(null)}
                      onDrop={(e) => onDrop(e, iso, h)}
                      className={cn(
                        'min-h-[44px] space-y-1 border-l border-border p-1',
                        past && 'bg-slate-50/60',
                        overKey === key && (past ? 'bg-red-50' : 'bg-primary-soft/40 ring-2 ring-primary/40 ring-inset'),
                      )}
                    >
                      {list.map((p) => (
                        <Pill key={p.id} post={p} dragging={dragId === p.id} onDragStart={onDragStart} onDragEnd={endDrag} onOpen={() => setOpenId(p.id)} />
                      ))}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Chi tiết bài */}
      <Drawer
        open={!!open}
        onClose={closeDrawer}
        width={440}
        title={open?.title ?? ''}
        footer={
          open && (
            <div className="flex w-full flex-wrap items-center gap-2">
              <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>
                Xoá
              </Button>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" icon={<Pencil size={14} />} onClick={() => navigate(`/soan-bai?idea=${encodeURIComponent(open.title)}`)}>
                  Sửa
                </Button>
                {open.status !== 'published' && (
                  <AiLockHint locked={!openAiKeySet}>
                    <Button variant="ai" size="sm" disabled={regenerating || !openAiKeySet} onClick={() => regenerate(open)}>
                      {regenerating ? 'AI đang viết…' : 'Tạo lại bằng AI'}
                    </Button>
                  </AiLockHint>
                )}
                {open.status === 'pending' && (
                  <Button variant="primary" size="sm" icon={<Check size={14} />} onClick={() => approve(open)}>
                    Duyệt & lên lịch
                  </Button>
                )}
                {open.status === 'failed' && (
                  <Button variant="primary" size="sm" icon={<Send size={14} />} onClick={() => repost(open)}>
                    Đăng lại
                  </Button>
                )}
                {open.status === 'draft' && (
                  <Button variant="primary" size="sm" onClick={() => {
                      update(open.id, { status: 'scheduled' })
                      notify(`Đã lên lịch lúc ${open.time}, ${dayLabel(open.date)}`)
                    }}>
                    Lên lịch
                  </Button>
                )}
              </div>
            </div>
          )
        }
      >
        {open && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusLabel status={open.status} />
              {open.ai && <AiBadge />}
            </div>

            {open.status === 'failed' && (
              <div className="flex gap-2.5 rounded-md border border-red-200 bg-red-50 p-3 text-[13px] text-red-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold">Đăng bài lỗi</div>
                  {failReason(open)}
                  <Link to="/trang-nhom" className="mt-1 block font-medium underline">
                    Kết nối lại
                  </Link>
                </div>
              </div>
            )}

            <div className="relative overflow-hidden rounded-lg border border-border">
              <img src={open.image} alt="" className={cn('aspect-square w-full object-cover', regenerating && 'opacity-40')} />
              {regenerating && (
                <div className="absolute inset-0 flex items-center justify-center text-sm font-medium text-ai">
                  <span className="rounded-full bg-white/90 px-3 py-1">AI đang viết…</span>
                </div>
              )}
            </div>

            <div>
              <div className="mb-1 text-[13px] font-medium text-muted-foreground">Nội dung</div>
              {regenerating ? (
                <div className="space-y-2">
                  {[100, 90, 70].map((w) => (
                    <div key={w} className="h-3 animate-pulse rounded bg-ai-soft" style={{ width: `${w}%` }} />
                  ))}
                </div>
              ) : (
                <p className="text-sm leading-relaxed whitespace-pre-line">{open.caption}</p>
              )}
            </div>

            <dl className="space-y-3 text-sm">
              <div>
                <dt className="mb-1.5 text-[13px] font-medium text-muted-foreground">Đăng lên {open.pageIds.length} trang</dt>
                <dd className="space-y-2">
                  {open.pageIds.map((id) => (
                    <PageLabel key={id} page={pageById(id)} />
                  ))}
                </dd>
              </div>
              <div className="flex items-center justify-between border-t border-border pt-3">
                <dt className="text-muted-foreground">Thời gian</dt>
                <dd className="flex items-center gap-1.5 font-medium">
                  <Clock size={14} className="text-muted-foreground" />
                  {open.time}, {dayLabel(open.date)}
                </dd>
              </div>
              <div className="flex items-center justify-between border-t border-border pt-3">
                <dt className="text-muted-foreground">Nguồn</dt>
                <dd className="font-medium">
                  {open.campaignId ? (
                    <Link to="/chien-dich" className="flex items-center gap-1.5 text-primary hover:underline">
                      <Megaphone size={14} />
                      {campaigns.find((c) => c.id === open.campaignId)?.name}
                    </Link>
                  ) : (
                    'Soạn thủ công'
                  )}
                </dd>
              </div>
              {open.status === 'published' && open.reach !== undefined && (
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <dt className="text-muted-foreground">Hiệu quả</dt>
                  <dd className="tabular font-medium">
                    {compact(open.reach)} tiếp cận · {compact(open.engagement ?? 0)} tương tác
                  </dd>
                </div>
              )}
              {open.status === 'published' && <p className="text-xs text-muted-foreground">Bài đã đăng nên không đổi lịch được.</p>}
            </dl>
          </div>
        )}
      </Drawer>

      <Modal
        open={confirmDelete && !!open}
        onClose={() => setConfirmDelete(false)}
        title="Xoá bài này?"
        width={420}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Huỷ</Button>
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => open && remove(open)}>
              Xoá bài
            </Button>
          </>
        }
      >
        <p className="text-sm">
          “{open?.title}” sẽ bị xoá khỏi lịch của {open?.pageIds.length} trang.
          {open?.status === 'published' && ' Bài đã đăng trên nền tảng vẫn giữ nguyên.'}
        </p>
      </Modal>
    </Content>
  )
}

/* ---------- Thành phần phụ ---------- */

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('size-3 rounded-sm border', className)} />
      {label}
    </span>
  )
}

function Pill({
  post,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  post: Post
  dragging: boolean
  onDragStart: (e: DragEvent, p: Post) => void
  onDragEnd: () => void
  onOpen: () => void
}) {
  const locked = post.status === 'published'
  const statusText =
    post.status === 'pending' ? 'Chờ duyệt' : post.status === 'failed' ? 'Lỗi đăng' : post.status === 'published' ? 'Đã đăng' : post.status === 'draft' ? 'Nháp' : 'Đã lên lịch'
  return (
    <button
      draggable={!locked}
      onDragStart={(e) => onDragStart(e, post)}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      title={`${post.title} · ${statusText}${locked ? ' · không kéo được' : ''}`}
      aria-label={`${post.time} ${post.title}, ${statusText}${post.ai ? ', AI tạo' : ''}`}
      className={cn(
        'block w-full rounded border px-1.5 py-1 text-left text-[11px] leading-tight transition-shadow hover:shadow-sm',
        statusPill[post.status],
        post.ai && 'border-l-[3px] border-l-ai',
        locked ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40 shadow-md',
      )}
    >
      <span className="flex items-center gap-1">
        <span className="flex shrink-0 -space-x-1">
          {platformsOf(post).map((pl) => (
            <PlatformIcon key={pl} platform={pl} size={12} className="rounded-full ring-1 ring-white" />
          ))}
        </span>
        <span className="tabular shrink-0 font-semibold">{post.time}</span>
        {post.status === 'published' && <Check size={11} className="shrink-0 text-success" />}
        {post.status === 'failed' && <AlertTriangle size={11} className="shrink-0 text-danger" />}
        {post.ai && <span className="ml-auto shrink-0 text-[9px] font-bold text-ai">AI</span>}
      </span>
      <span className="mt-0.5 block truncate">{post.title}</span>
      {(post.status === 'pending' || post.status === 'failed') && (
        <span className={cn('mt-0.5 block text-[10px] font-semibold', post.status === 'pending' ? 'text-amber-800' : 'text-danger')}>{statusText}</span>
      )}
    </button>
  )
}
