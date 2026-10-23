// Lịch nội dung `/lich` (Story 6.5): target theo `scheduled_at` (`GET /calendar`, lọc theo Phạm vi), gom thành "bài trên
// lịch" theo tuần / tháng giờ VN. Kéo thả và các nút ở ngăn chi tiết đều gọi `POST /posts/:id/targets/transition` có sẵn
// (đổi giờ, đăng lại, bỏ lịch, xoá). Bài lỗi màu đỏ, mở ra thấy lý do theo `ErrorCode` + "Đăng lại". Logic lưới / gom /
// kéo thả ở `lib/calendar.ts`.
import type { CalendarItemDto, PageDto, Platform, PostTargetStatus } from '@ottm/shared'
import { AlertTriangle, CalendarX, Check, ChevronLeft, ChevronRight, Clock, ExternalLink, Loader2, Megaphone, Pencil, Plus, RotateCcw, Send, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Content } from '../components/AppShell'
import { AiBadge, Button, Card, Chip, Drawer, Input, Modal, PageHeader, PlatformIcon, Segmented, Select, cn } from '../components/ui'
import { useApp } from '../lib/app-context'
import {
  CALENDAR_STATUS_LABEL,
  CALENDAR_STATUS_TONE,
  addDays,
  addMonths,
  calendarCounts,
  calendarTitle,
  canCancel,
  canDrag,
  filterItems,
  groupCalendarItems,
  groupCalls,
  groupPages,
  groupTitle,
  groupsByDay,
  mondayOf,
  monthGrid,
  monthOf,
  moveRefusal,
  moveToast,
  planMove,
  rangeOfDays,
  todayKey,
  useCalendar,
  weekGrid,
  type CalendarFilter,
  type CalendarGroup,
  type CalendarView,
  type DayKey,
  type TransitionCall,
} from '../lib/calendar'
import { POST_PARAM, usePost } from '../lib/composer'
import { usePages } from '../lib/connections'
import { errorMessage } from '../lib/error-messages'
import { defaultScheduleInput, formatVnDateTime, isoToVnInput, scheduleInputIssue, transitionErrorMessage, useTransitionTargets, vnToIso, type StatusTone } from '../lib/publish'

const WEEK_LABELS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']
const HOURS = Array.from({ length: 24 }, (_, i) => i)
/** Tuần mở ra cuộn tới giờ này (giờ đăng bài phổ biến bắt đầu từ sáng). */
const WEEK_SCROLL_HOUR = 7
const pad = (n: number) => String(n).padStart(2, '0')

const PLATFORM_FILTERS: { value: CalendarFilter['platform']; label: string }[] = [
  { value: 'all', label: 'Tất cả nền tảng' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'threads', label: 'Threads' },
]
const STATUS_FILTERS: { value: CalendarFilter['status']; label: string }[] = [
  { value: 'all', label: 'Tất cả trạng thái' },
  { value: 'scheduled', label: 'Đã lên lịch' },
  { value: 'publishing', label: 'Đang đăng' },
  { value: 'published', label: 'Đã đăng' },
  { value: 'failed', label: 'Lỗi đăng' },
  { value: 'pending_approval', label: 'Chờ duyệt' },
]

/** Màu ô theo trạng thái (kèm chữ / biểu tượng — không chỉ dựa vào màu). */
const statusPill: Partial<Record<PostTargetStatus, string>> & { default: string } = {
  scheduled: 'border-primary/25 bg-primary-soft/60 text-teal-900',
  publishing: 'border-primary/25 bg-primary-soft/30 text-teal-900',
  pending_approval: 'border-amber-300 bg-warning-soft text-amber-900',
  published: 'border-border bg-slate-100 text-muted-foreground',
  failed: 'border-red-300 bg-red-50 text-red-800',
  default: 'border-dashed border-slate-300 bg-surface text-slate-600',
}
const pillClass = (s: PostTargetStatus) => statusPill[s] ?? statusPill.default

const CHIP_TONE: Record<StatusTone, 'neutral' | 'primary' | 'success' | 'danger'> = { muted: 'neutral', info: 'primary', success: 'success', danger: 'danger' }

/* ---------- Màn hình ---------- */

export default function ContentCalendar() {
  const { scope, scopeLabel, notify } = useApp()
  const navigate = useNavigate()
  const pagesQuery = usePages()
  const pages = useMemo(() => pagesQuery.data ?? [], [pagesQuery.data])
  const platformOf = useMemo(() => {
    const m = new Map(pages.map((p) => [p.id, p.platform]))
    return (id: string) => m.get(id)
  }, [pages])

  const today = todayKey()
  const [view, setView] = useState<CalendarView>('month')
  const [month, setMonth] = useState(() => monthOf(today))
  const [monday, setMonday] = useState(() => mondayOf(today))
  const [filter, setFilter] = useState<CalendarFilter>({ platform: 'all', status: 'all' })
  const [expandedDay, setExpandedDay] = useState<DayKey | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const days = useMemo(() => (view === 'month' ? monthGrid(month) : weekGrid(monday)), [view, month, monday])
  const range = useMemo(() => rangeOfDays(days), [days])
  const calendar = useCalendar(scope, range)
  const transition = useTransitionTargets()

  const groups = useMemo(() => groupCalendarItems(filterItems(calendar.data?.items ?? [], filter, platformOf)), [calendar.data, filter, platformOf])
  const byDay = useMemo(() => groupsByDay(groups), [groups])
  const counts = calendarCounts(groups)
  const open = groups.find((g) => g.key === openKey) ?? null

  /* --- Điều hướng --- */
  const shift = (dir: 1 | -1) => {
    if (view === 'month') setMonth((m) => addMonths(m, dir))
    else setMonday((w) => addDays(w, dir * 7))
  }
  const goToday = () => {
    setMonth(monthOf(today))
    setMonday(mondayOf(today))
  }

  // Tuần: cuộn tới 07:00 khi mở (bài 00:00–06:59 vẫn có hàng, cuộn lên là thấy).
  const weekScroll = useRef<HTMLDivElement>(null)
  const scrollRow = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (view === 'week' && weekScroll.current && scrollRow.current) weekScroll.current.scrollTop = scrollRow.current.offsetTop
  }, [view])

  /* --- Gọi chuyển trạng thái (mỗi bài một request) --- */
  async function run(calls: TransitionCall[], done: string, after?: () => void) {
    try {
      for (const c of calls) await transition.mutateAsync(c)
      notify(done)
      after?.()
    } catch (err) {
      notify(transitionErrorMessage(err, pages))
    }
  }

  /* --- Kéo thả --- */
  const dragging = groups.find((g) => g.key === dragKey) ?? null
  const onDragStart = (e: DragEvent, g: CalendarGroup) => {
    if (!canDrag(g) || transition.isPending) {
      e.preventDefault()
      return
    }
    e.dataTransfer.setData('text/plain', g.key)
    e.dataTransfer.effectAllowed = 'move'
    setDragKey(g.key)
  }
  const onDragOver = (e: DragEvent, key: string) => {
    if (!dragKey) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (overKey !== key) setOverKey(key)
  }
  const endDrag = () => {
    setDragKey(null)
    setOverKey(null)
  }
  const onDrop = (e: DragEvent, day: DayKey, hour?: number) => {
    e.preventDefault()
    const key = e.dataTransfer.getData('text/plain') || dragKey
    endDrag()
    const g = groups.find((x) => x.key === key)
    if (!g) return
    const plan = planMove(g, day, hour)
    if (plan.kind !== 'move') {
      const refusal = moveRefusal(plan)
      if (refusal) notify(refusal)
      return
    }
    void run(plan.calls, moveToast(plan, g.items.length))
  }

  return (
    <Content>
      <PageHeader
        title="Lịch nội dung"
        subtitle={`${scopeLabel} · ${groups.length} bài · Kéo bài sang ngày khác để đổi lịch`}
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
          <span className="min-w-[160px] text-center text-[15px] font-semibold">{calendarTitle(view, { month, monday })}</span>
          <Button variant="ghost" size="sm" onClick={() => shift(1)} aria-label="Sau" className="px-2">
            <ChevronRight size={16} />
          </Button>
          <Button size="sm" onClick={goToday} className="ml-1">
            Hôm nay
          </Button>
          {(calendar.isFetching || transition.isPending) && <Loader2 size={15} className="ml-1 animate-spin text-muted-foreground" aria-label="Đang tải" />}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Select
            options={PLATFORM_FILTERS}
            value={filter.platform}
            onChange={(e) => setFilter((f) => ({ ...f, platform: e.target.value as CalendarFilter['platform'] }))}
            className="w-[170px]"
            aria-label="Nền tảng"
          />
          <Select
            options={STATUS_FILTERS}
            value={filter.status}
            onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value as CalendarFilter['status'] }))}
            className="w-[170px]"
            aria-label="Trạng thái"
          />
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-2.5 text-xs text-muted-foreground">
          <Legend className={pillClass('scheduled')} label="Đã lên lịch" />
          <Legend className={pillClass('published')} label="Đã đăng" />
          <Legend className={pillClass('failed')} label="Lỗi đăng" />
          <Legend className={pillClass('pending_approval')} label="Chờ duyệt" />
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-1 rounded-sm bg-ai" />
            <span className="font-semibold text-ai">AI tạo</span>
          </span>
          {(counts.pending > 0 || counts.failed > 0) && (
            <span className="ml-auto flex items-center gap-3">
              {counts.pending > 0 && (
                <Link to="/chien-dich" className="font-medium text-amber-800 hover:underline">
                  {counts.pending} bài chờ duyệt
                </Link>
              )}
              {counts.failed > 0 && (
                <button type="button" className="font-medium text-danger hover:underline" onClick={() => setFilter((f) => ({ ...f, status: 'failed' }))}>
                  {counts.failed} bài đăng lỗi
                </button>
              )}
            </span>
          )}
        </div>
      </Card>

      {calendar.isError && !calendar.data && (
        <Card className="mb-4 flex items-center gap-3 px-4 py-3 text-sm text-danger">
          <AlertTriangle size={16} /> Không tải được lịch.
          <Button size="sm" onClick={() => void calendar.refetch()}>
            Thử lại
          </Button>
        </Card>
      )}
      {calendar.data?.truncated && (
        <p className="mb-3 text-xs text-muted-foreground">Khoảng này có quá nhiều bài — chỉ hiện một phần. Thu hẹp Phạm vi hoặc xem theo tuần.</p>
      )}

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
            {days.map((d, i) => {
              const inMonth = monthOf(d) === month
              const list = byDay.get(d) ?? []
              const isExpanded = expandedDay === d
              const shown = isExpanded ? list : list.slice(0, 3)
              const past = d < today
              return (
                <div
                  key={d}
                  onDragOver={(e) => onDragOver(e, d)}
                  onDragLeave={() => overKey === d && setOverKey(null)}
                  onDrop={(e) => onDrop(e, d)}
                  className={cn(
                    'min-h-[124px] border-border p-1.5 transition-colors',
                    i % 7 !== 6 && 'border-r',
                    i < days.length - 7 && 'border-b',
                    !inMonth && 'bg-slate-50/70',
                    overKey === d && (past ? 'bg-red-50' : 'bg-primary-soft/40 ring-2 ring-primary/40 ring-inset'),
                  )}
                >
                  <div className="mb-1 flex items-center justify-between px-0.5">
                    <span
                      className={cn(
                        'tabular flex size-6 items-center justify-center rounded-full text-xs font-medium',
                        d === today ? 'bg-primary text-white' : inMonth ? 'text-foreground' : 'text-slate-400',
                      )}
                    >
                      {Number(d.slice(8, 10))}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {shown.map((g) => (
                      <Pill key={g.key} group={g} pages={pages} dragging={dragging?.key === g.key} onDragStart={onDragStart} onDragEnd={endDrag} onOpen={() => setOpenKey(g.key)} />
                    ))}
                    {list.length > 3 && (
                      <button
                        onClick={() => setExpandedDay(isExpanded ? null : d)}
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
            {days.map((d, i) => (
              <div key={d} className="border-l border-border px-2 py-2 text-center">
                <div className="text-xs font-semibold text-muted-foreground">{WEEK_LABELS[i]}</div>
                <div className={cn('tabular mx-auto mt-0.5 flex size-7 items-center justify-center rounded-full text-sm font-semibold', d === today && 'bg-primary text-white')}>
                  {Number(d.slice(8, 10))}
                </div>
              </div>
            ))}
          </div>
          <div ref={weekScroll} className="relative max-h-[620px] overflow-y-auto scrollbar-thin">
            {HOURS.map((h) => (
              <div key={h} ref={h === WEEK_SCROLL_HOUR ? scrollRow : undefined} className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-border last:border-b-0">
                <div className="tabular px-2 pt-1 text-right text-[11px] text-muted-foreground">{pad(h)}:00</div>
                {days.map((d) => {
                  const key = `${d}@${h}`
                  const list = (byDay.get(d) ?? []).filter((g) => g.hour === h)
                  const past = d < today
                  return (
                    <div
                      key={key}
                      onDragOver={(e) => onDragOver(e, key)}
                      onDragLeave={() => overKey === key && setOverKey(null)}
                      onDrop={(e) => onDrop(e, d, h)}
                      className={cn(
                        'min-h-[44px] space-y-1 border-l border-border p-1',
                        past && 'bg-slate-50/60',
                        overKey === key && (past ? 'bg-red-50' : 'bg-primary-soft/40 ring-2 ring-primary/40 ring-inset'),
                      )}
                    >
                      {list.map((g) => (
                        <Pill key={g.key} group={g} pages={pages} dragging={dragging?.key === g.key} onDragStart={onDragStart} onDragEnd={endDrag} onOpen={() => setOpenKey(g.key)} />
                      ))}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </Card>
      )}

      {open && (
        <GroupDrawer
          key={open.key}
          group={open}
          pages={pages}
          busy={transition.isPending}
          onClose={() => setOpenKey(null)}
          onRun={(calls, done) => void run(calls, done, () => setOpenKey(null))}
          onDelete={() => setConfirmDelete(true)}
          onEdit={() => navigate(`/soan-bai?${POST_PARAM}=${open.postIds[0]}`)}
        />
      )}

      <Modal
        open={confirmDelete && !!open}
        onClose={() => setConfirmDelete(false)}
        title="Xoá bài khỏi lịch?"
        width={420}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Huỷ</Button>
            <Button
              variant="danger"
              icon={<Trash2 size={14} />}
              disabled={transition.isPending}
              onClick={() => {
                if (!open) return
                setConfirmDelete(false)
                void run(groupCalls(open, 'cancel'), `Đã xoá bài khỏi lịch của ${open.items.length} trang`, () => setOpenKey(null))
              }}
            >
              Xoá bài
            </Button>
          </>
        }
      >
        <p className="text-sm">
          “{open ? groupTitle(open) : ''}” sẽ không được đăng lên {open?.items.length} trang và biến khỏi lịch. Không hoàn tác được.
        </p>
      </Modal>
    </Content>
  )
}

/* ---------- Ngăn chi tiết ---------- */

function GroupDrawer({
  group,
  pages,
  busy,
  onClose,
  onRun,
  onDelete,
  onEdit,
}: {
  group: CalendarGroup
  pages: readonly PageDto[]
  busy: boolean
  onClose: () => void
  onRun: (calls: TransitionCall[], done: string) => void
  onDelete: () => void
  onEdit: () => void
}) {
  // Mốc "bây giờ" lúc mở ngăn (ngăn mở ngắn; server vẫn kiểm giờ đã qua).
  const [now] = useState(() => Date.now())
  // Ô ngày giờ (giờ VN): bài đã lên lịch → giờ hiện tại của bài; bài lỗi → mặc định 19:00 tới gần nhất.
  const [when, setWhen] = useState(() => (group.status === 'scheduled' ? isoToVnInput(group.scheduledAt) : defaultScheduleInput(now)))
  const whenIssue = scheduleInputIssue(when.date, when.time, now)
  const at = vnToIso(when.date, when.time)
  const post = usePost(group.postIds.length === 1 ? group.postIds[0]! : null)
  const first = group.items[0]!
  const target = post.data?.targets.find((t) => t.id === first.id)
  const image = target?.media[0]?.url ?? group.thumbnailUrl
  const pageById = new Map(pages.map((p) => [p.id, p]))
  const editable = group.status === 'scheduled' || group.status === 'failed'
  const n = group.items.length

  return (
    <Drawer
      open
      onClose={onClose}
      width={440}
      title={groupTitle(group)}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {canCancel(group.status) && (
            <Button variant="danger" size="sm" icon={<Trash2 size={14} />} disabled={busy} onClick={onDelete}>
              Xoá
            </Button>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            {group.postIds.length === 1 && (
              <Button size="sm" icon={<Pencil size={14} />} onClick={onEdit}>
                Mở ở Soạn bài
              </Button>
            )}
            {group.status === 'scheduled' && (
              <>
                <Button size="sm" icon={<CalendarX size={14} />} disabled={busy} onClick={() => onRun(groupCalls(group, 'unschedule'), `Đã bỏ lịch ${n} trang — bài về nháp ở Soạn bài`)}>
                  Bỏ lịch
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Clock size={14} />}
                  disabled={busy || !!whenIssue || at?.slice(0, 16) === group.scheduledAt.slice(0, 16)}
                  onClick={() => at && onRun(groupCalls(group, 'reschedule', at), `Đã dời ${n} trang sang ${formatVnDateTime(at)}`)}
                >
                  Đổi giờ
                </Button>
              </>
            )}
            {group.status === 'failed' && (
              <>
                <Button size="sm" icon={<RotateCcw size={14} />} disabled={busy || !!whenIssue} onClick={() => at && onRun(groupCalls(group, 'retry', at), `Sẽ đăng lại ${n} trang lúc ${formatVnDateTime(at)}`)}>
                  Đăng lại lúc này
                </Button>
                <Button variant="primary" size="sm" icon={<Send size={14} />} disabled={busy} onClick={() => onRun(groupCalls(group, 'retry', null), `Đang đăng lại lên ${n} trang…`)}>
                  Đăng lại ngay
                </Button>
              </>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={CHIP_TONE[CALENDAR_STATUS_TONE[group.status]]} icon={statusIcon(group.status)}>
            {CALENDAR_STATUS_LABEL[group.status]}
          </Chip>
          {group.ai && <AiBadge />}
        </div>

        {group.status === 'failed' && (
          <div role="alert" className="flex gap-2.5 rounded-md border border-red-200 bg-red-50 p-3 text-[13px] text-red-800">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div className="space-y-1">
              <div className="font-semibold">Đăng bài lỗi</div>
              {group.items.map((it) => (
                <div key={it.id}>
                  {n > 1 && <b>{pageById.get(it.pageId)?.name ?? 'Trang đã gỡ'}: </b>}
                  {errorMessage(it.errorCode ?? 'PUBLISH_FAILED')}
                </div>
              ))}
              {group.items.some((it) => it.errorCode === 'PAGE_DISCONNECTED') && (
                <Link to="/trang-nhom" className="block font-medium underline">
                  Kết nối lại
                </Link>
              )}
            </div>
          </div>
        )}

        {image && <img src={image} alt="" className="aspect-square w-full rounded-lg border border-border object-cover" />}

        <div>
          <div className="mb-1 text-[13px] font-medium text-muted-foreground">Nội dung{n > 1 ? ` (${pageById.get(first.pageId)?.name ?? 'trang đầu'})` : ''}</div>
          <p className="text-sm leading-relaxed whitespace-pre-line">{target?.caption ?? group.title ?? <span className="text-muted-foreground">Bài chỉ có ảnh</span>}</p>
        </div>

        <dl className="space-y-3 text-sm">
          <div>
            <dt className="mb-1.5 text-[13px] font-medium text-muted-foreground">Đăng lên {n} trang</dt>
            <dd className="space-y-2">
              {group.items.map((it) => (
                <TargetRow key={it.id} item={it} page={pageById.get(it.pageId)} />
              ))}
            </dd>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-3">
            <dt className="text-muted-foreground">{group.status === 'published' ? 'Đã đăng' : 'Thời gian'}</dt>
            <dd className="flex items-center gap-1.5 font-medium">
              <Clock size={14} className="text-muted-foreground" />
              {formatVnDateTime(first.publishedAt ?? group.scheduledAt)}
            </dd>
          </div>
          {editable && (
            <div className="border-t border-border pt-3">
              <dt className="mb-1.5 text-muted-foreground">{group.status === 'failed' ? 'Đăng lại lúc' : 'Đổi sang'} (giờ Việt Nam)</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <Input type="date" value={when.date} onChange={(e) => setWhen((w) => ({ ...w, date: e.target.value }))} className="w-[150px]" aria-label="Ngày đăng (giờ Việt Nam)" aria-invalid={!!whenIssue} />
                <Input type="time" value={when.time} onChange={(e) => setWhen((w) => ({ ...w, time: e.target.value }))} className="w-[110px]" aria-label="Giờ đăng (giờ Việt Nam)" aria-invalid={!!whenIssue} />
                {whenIssue && <span className="w-full text-xs text-danger">{whenIssue}</span>}
              </dd>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <dt className="text-muted-foreground">Nguồn</dt>
            <dd className="font-medium">
              {group.campaignId ? (
                <Link to="/chien-dich" className="flex items-center gap-1.5 text-primary hover:underline">
                  <Megaphone size={14} /> Chiến dịch
                </Link>
              ) : (
                'Soạn thủ công'
              )}
            </dd>
          </div>
          {(group.status === 'published' || group.status === 'publishing') && <p className="text-xs text-muted-foreground">Bài đã đăng hoặc đang đăng nên không đổi lịch được.</p>}
        </dl>
      </div>
    </Drawer>
  )
}

function TargetRow({ item, page }: { item: CalendarItemDto; page: PageDto | undefined }) {
  return (
    <div className="flex items-center gap-2">
      {page && <PlatformIcon platform={page.platform} size={16} />}
      <span className="min-w-0 flex-1 truncate">{page?.name ?? 'Trang đã gỡ'}</span>
      {item.status === 'published' && item.permalink && (
        <a href={item.permalink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          Xem bài <ExternalLink size={12} />
        </a>
      )}
    </div>
  )
}

/* ---------- Thành phần phụ ---------- */

function statusIcon(status: PostTargetStatus) {
  if (status === 'published') return <Check size={11} />
  if (status === 'failed') return <AlertTriangle size={11} />
  return undefined
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('size-3 rounded-sm border', className)} />
      {label}
    </span>
  )
}

/** Bài trên lịch: biểu tượng nền tảng, giờ, trạng thái (chữ + biểu tượng), nhãn chữ "AI tạo". */
function Pill({
  group,
  pages,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  group: CalendarGroup
  pages: readonly PageDto[]
  dragging: boolean
  onDragStart: (e: DragEvent, g: CalendarGroup) => void
  onDragEnd: () => void
  onOpen: () => void
}) {
  const draggable = canDrag(group)
  const statusText = CALENDAR_STATUS_LABEL[group.status]
  const platforms = [...new Set(groupPages(group, pages).map((p) => p.platform))] as Platform[]
  const title = groupTitle(group)
  return (
    <button
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, group)}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      title={`${title} · ${statusText}${draggable ? '' : ' · không kéo được'}`}
      aria-label={`${group.time} ${title}, ${group.items.length} trang, ${statusText}${group.ai ? ', AI tạo' : ''}`}
      className={cn(
        'block w-full rounded border px-1.5 py-1 text-left text-[11px] leading-tight transition-shadow hover:shadow-sm',
        pillClass(group.status),
        group.ai && 'border-l-[3px] border-l-ai',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        dragging && 'opacity-40 shadow-md',
      )}
    >
      <span className="flex items-center gap-1">
        <span className="flex shrink-0 -space-x-1">
          {platforms.map((pl) => (
            <PlatformIcon key={pl} platform={pl} size={12} className="rounded-full ring-1 ring-white" />
          ))}
        </span>
        <span className="tabular shrink-0 font-semibold">{group.time}</span>
        {group.status === 'published' && <Check size={11} className="shrink-0 text-success" />}
        {group.status === 'failed' && <AlertTriangle size={11} className="shrink-0 text-danger" />}
        {group.status === 'publishing' && <Loader2 size={11} className="shrink-0 animate-spin" />}
        {group.ai && <span className="ml-auto shrink-0 text-[9px] font-bold text-ai">AI tạo</span>}
      </span>
      <span className="mt-0.5 block truncate">{title}</span>
      {(group.status === 'pending_approval' || group.status === 'failed') && (
        <span className={cn('mt-0.5 block text-[10px] font-semibold', group.status === 'pending_approval' ? 'text-amber-800' : 'text-danger')}>{statusText}</span>
      )}
    </button>
  )
}
