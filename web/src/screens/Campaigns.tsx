// Chiến dịch nuôi page `/chien-dich` (Story 7.3): danh sách chiến dịch thật theo Phạm vi (`GET /campaigns?scope=`) — tab
// trạng thái, KPI, thẻ tiến độ (ngày, bài đã đăng / tổng, bài tiếp theo, bài đã đăng 7 ngày). Nháp mở lại wizard
// (`/chien-dich/tao?id=`).
// Story 7.5: Tạm dừng / Tiếp tục bấm là chạy (không xác nhận), thẻ tạm dừng ghi lý do theo `pauseReason`; Xoá (cả nháp)
// hỏi xác nhận — bài chưa đăng bị huỷ, bài đã đăng giữ nguyên trên trang.
// Story 7.4: hàng đợi "Bài chờ duyệt" thật (`GET /campaigns/pending-slots?scope=`): Duyệt / Sửa / Tạo lại / Từ chối qua cùng
// route hành động slot với Lịch nội dung; bài quá giờ (hoặc server trả `SCHEDULE_IN_PAST`) → ô chọn giờ mới; "Duyệt tất
// cả" chỉ duyệt bài không lỗi, chưa quá giờ, tuần tự (lỗi giữa chừng → "Đã xong k/n bài").
import { AlertTriangle, CalendarDays, Check, CircleAlert, Clock, Coins, Megaphone, Pause, Pencil, Play, Plus, RefreshCw, ShieldCheck, Trash2, X, Zap } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import type { CampaignSlotActionRequest, CampaignStatus, CampaignSummaryDto, PageDto, PendingSlotDto } from '@ottm/shared'
import { AiLockHint } from '../components/AiLockHint'
import { Content } from '../components/AppShell'
import { ScreenSkeleton, Skeleton } from '../components/Skeleton'
import { AiBadge, Button, Card, CardHeader, Chip, EmptyState, GroupChip, Input, KpiCard, Modal, PageAvatar, PageHeader, PageLabel, Progress, Tabs, Textarea } from '../components/ui'
import { formatVnd, useAiBudget } from '../lib/ai-budget'
import { useApp } from '../lib/app-context'
import { partialRunMessage } from '../lib/calendar'
import {
  CAMPAIGN_PARAM,
  CAMPAIGN_STATUS_TEXT,
  OVERDUE_TEXT,
  approveBlock,
  approveBody,
  approveInput,
  approvedToast,
  bulkApprovable,
  campaignCounts,
  campaignPct,
  deleteConfirmText,
  deletedToast,
  goalOf,
  isOverdue,
  lifecycleToast,
  needsNewTime,
  nextPostLabel,
  pausedNote,
  pendingNote,
  resumeErrorText,
  slotTime,
  slotWhen,
  trendTotal,
  useCampaignLifecycle,
  useCampaigns,
  useDeleteCampaign,
  usePendingSlots,
  useSlotAction,
} from '../lib/campaigns'
import { composeLock } from '../lib/composer'
import { toUiPage, usePages } from '../lib/connections'
import { errorMessageOf } from '../lib/error-messages'
import { useGroups } from '../lib/groups'
import { defaultScheduleInput, scheduleInputIssue, vnToIso } from '../lib/publish'

type TabId = 'all' | CampaignStatus

function CampaignStatusPill({ status }: { status: CampaignStatus }) {
  if (status === 'running') return <Chip tone="success">● Đang chạy</Chip>
  if (status === 'paused') return <Chip tone="warning" icon={<Pause size={11} />}>Tạm dừng</Chip>
  if (status === 'done') return <Chip icon={<Check size={11} />}>Đã xong</Chip>
  return <Chip>Bản nháp</Chip>
}

function Sparkline({ data }: { data: readonly number[] }) {
  const series = data.map((v, i) => ({ i, v }))
  return (
    <div className="h-10 w-28" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <Area type="monotone" dataKey="v" stroke="#0f766e" strokeWidth={1.5} fill="#ccfbf1" fillOpacity={0.7} isAnimationActive={false} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function Campaigns() {
  const { scope, scopeLabel } = useApp()
  const navigate = useNavigate()
  const budget = useAiBudget()
  const list = useCampaigns(scope)
  const pagesQuery = usePages()
  // Nạp nhóm thật để chip nhóm nhãn hiện đúng tên / màu.
  useGroups()
  const [tab, setTab] = useState<TabId>('all')

  if (list.isPending) return <ScreenSkeleton label="Đang tải chiến dịch…" />

  const items = list.data ?? []
  const pages = pagesQuery.data ?? []
  const counts = campaignCounts(items)
  const shown = tab === 'all' ? items : items.filter((c) => c.status === tab)
  const aiPublished = items.reduce((n, c) => n + c.postsDone, 0)
  const pending = items.reduce((n, c) => n + c.postsPending, 0)

  return (
    <Content>
      <PageHeader
        title="Chiến dịch nuôi page"
        subtitle={`${scopeLabel} · AI tự viết và đăng bài đều đặn theo lịch bạn đặt`}
        actions={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/chien-dich/tao')}>
            Tạo chiến dịch
          </Button>
        }
      />

      <div className="mb-6 grid grid-cols-4 gap-4">
        <KpiCard label="Số chiến dịch" value={String(counts.all)} hint={`${counts.running} đang chạy · ${counts.paused} tạm dừng`} icon={<Megaphone size={16} />} />
        <KpiCard label="Bài AI đã đăng" value={String(aiPublished)} hint="từ các chiến dịch trong phạm vi" />
        <KpiCard label="Bài chờ duyệt" value={String(pending)} icon={<Clock size={16} className="text-warning" />} hint={pending ? 'Duyệt ở hàng đợi bên dưới hoặc trên Lịch' : 'Không còn bài nào cần duyệt'} />
        <KpiCard
          label="Chi phí AI tháng này"
          value={budget.data ? formatVnd(budget.data.spentVnd) : budget.isError ? '—' : '…'}
          icon={<Coins size={16} />}
          hint={
            budget.data
              ? `${budget.data.percent}% hạn mức ${formatVnd(budget.data.limitVnd)} · toàn bộ trang`
              : budget.isError
                ? 'Chưa tải được chi phí'
                : 'Đang tải…'
          }
        />
      </div>

      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'all', label: 'Tất cả', count: counts.all },
          { id: 'running', label: 'Đang chạy', count: counts.running },
          { id: 'paused', label: 'Tạm dừng', count: counts.paused },
          { id: 'draft', label: 'Bản nháp', count: counts.draft },
          { id: 'done', label: 'Đã xong', count: counts.done },
        ]}
      />

      {list.isError ? (
        <Card className="flex items-center justify-between px-4 py-3 text-sm">
          <span className="text-danger">{errorMessageOf(list.error)}</span>
          <Button size="sm" onClick={() => void list.refetch()}>
            Thử lại
          </Button>
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Megaphone size={22} />}
            title={tab === 'all' ? 'Chưa có chiến dịch nào' : `Không có chiến dịch ${CAMPAIGN_STATUS_TEXT[tab].toLowerCase()}`}
            action={
              tab === 'all' && (
                <Button variant="primary" icon={<Plus size={16} />} onClick={() => navigate('/chien-dich/tao')}>
                  Tạo chiến dịch
                </Button>
              )
            }
          >
            {tab === 'all' ? 'Tạo chiến dịch để AI tự viết và đăng bài đều đặn cho các trang của bạn.' : 'Chọn tab khác để xem các chiến dịch còn lại.'}
          </EmptyState>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {shown.map((c) => (
            <CampaignCard key={c.id} c={c} pages={pages} />
          ))}
        </div>
      )}

      <PendingQueue pages={pages} />
    </Content>
  )
}

function CampaignCard({ c, pages }: { c: CampaignSummaryDto; pages: readonly PageDto[] }) {
  const navigate = useNavigate()
  const { notify } = useApp()
  const lifecycle = useCampaignLifecycle()
  const remove = useDeleteCampaign()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const busy = lifecycle.isPending || remove.isPending
  const toggle = (action: 'pause' | 'resume') =>
    lifecycle.mutate(
      { id: c.id, action },
      { onSuccess: (res) => notify(lifecycleToast(action, res)), onError: (err) => notify(action === 'resume' ? resumeErrorText(err) : errorMessageOf(err)) },
    )
  const pct = campaignPct(c)
  const own = c.pages.map((p) => pages.find((x) => x.id === p.pageId)).filter((p): p is PageDto => !!p)
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{c.name}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip>{goalOf(c.goal).label}</Chip>
            {c.mode === 'review' ? (
              <Chip tone="primary" icon={<ShieldCheck size={11} />}>
                Duyệt trước khi đăng
              </Chip>
            ) : (
              <Chip tone="ai" icon={<Zap size={11} />}>
                Tự đăng
              </Chip>
            )}
          </div>
        </div>
        <CampaignStatusPill status={c.status} />
      </div>

      {c.status === 'paused' && (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-200 bg-warning-soft px-3 py-2 text-[13px] text-amber-900">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="flex-1">{pausedNote(c)}</span>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <span className="flex -space-x-2">
          {own.map((p) => (
            <span key={p.id} title={p.name} className="rounded-full ring-2 ring-white">
              <PageAvatar page={toUiPage(p)} size={28} />
            </span>
          ))}
        </span>
        <span className="text-xs text-muted-foreground">{c.pages.length} trang</span>
        {c.groupId && <GroupChip groupId={c.groupId} size="sm" />}
      </div>

      <div className="mt-4 flex items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex justify-between text-xs">
            <span className="tabular font-medium">
              {c.daysDone}/{c.durationDays} ngày · {c.postsDone}/{c.postsTotal} bài
            </span>
            <span className="tabular text-muted-foreground">{pct}%</span>
          </div>
          <Progress value={pct} />
          <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock size={12} />
            Bài tiếp theo: <span className="font-medium text-foreground">{nextPostLabel(c)}</span>
          </div>
        </div>
        {c.status !== 'draft' && (
          <div className="text-right">
            <Sparkline data={c.trend} />
            <div className="text-[11px] text-muted-foreground">Bài đã đăng 7 ngày: {trendTotal(c.trend)}</div>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
        {c.status === 'running' && (
          <Button size="sm" icon={<Pause size={14} />} disabled={busy} onClick={() => toggle('pause')}>
            Tạm dừng
          </Button>
        )}
        {c.status === 'paused' && (
          <Button size="sm" variant="primary" icon={<Play size={14} />} disabled={busy} onClick={() => toggle('resume')}>
            Tiếp tục
          </Button>
        )}
        {c.status === 'draft' && (
          <Button size="sm" icon={<Pencil size={14} />} onClick={() => navigate(`/chien-dich/tao?${CAMPAIGN_PARAM}=${c.id}`)}>
            Tiếp tục thiết lập
          </Button>
        )}
        {c.status !== 'draft' && (
          <Button size="sm" variant="ghost" icon={<CalendarDays size={14} />} onClick={() => navigate('/lich')}>
            Xem lịch
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-danger hover:bg-red-50 hover:text-danger"
          icon={<Trash2 size={14} />}
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          Xoá
        </Button>
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={c.status === 'draft' ? 'Xoá bản nháp?' : 'Xoá chiến dịch?'}
        width={440}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Huỷ</Button>
            <Button
              variant="danger"
              icon={<Trash2 size={14} />}
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(
                  { id: c.id, name: c.name },
                  {
                    onSuccess: (res) => {
                      setConfirmDelete(false)
                      notify(deletedToast(c.name, res))
                    },
                    onError: (err) => notify(errorMessageOf(err)),
                  },
                )
              }
            >
              Xoá chiến dịch
            </Button>
          </>
        }
      >
        <p className="text-sm">{deleteConfirmText(c)}</p>
      </Modal>
    </Card>
  )
}

/* ---------- Hàng đợi "Bài chờ duyệt" (Story 7.4) ---------- */

function PendingQueue({ pages }: { pages: readonly PageDto[] }) {
  const { scope, aiLock, notify } = useApp()
  const budgetState = useAiBudget().data?.state
  const lock = composeLock({ key: aiLock, budgetBlocked: budgetState === 'blocked', serverCode: null })
  const query = usePendingSlots(scope)
  const act = useSlotAction()
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  // Bài đang hỏi giờ mới (quá giờ / server trả `SCHEDULE_IN_PAST`) → ô ngày giờ VN.
  const [times, setTimes] = useState<Record<string, { date: string; time: string }>>({})
  const [bulk, setBulk] = useState(false)
  const items = query.data?.items ?? []
  // Mốc "bây giờ" theo lần tải hàng đợi (SSE / hỏi lại đổi dữ liệu → tính lại bài quá giờ); server vẫn kiểm khi duyệt.
  const now = query.dataUpdatedAt
  const ready = bulkApprovable(items, now)

  const send = (slot: PendingSlotDto, body: CampaignSlotActionRequest, done: (s: PendingSlotDto) => string, after?: () => void) =>
    act.mutate(
      { campaignId: slot.campaignId, targetId: slot.id, body },
      {
        onSuccess: (res) => {
          notify(done({ ...slot, ...res.slot }))
          after?.()
        },
        onError: (err) => {
          if (needsNewTime(err)) setTimes((t) => ({ ...t, [slot.id]: defaultScheduleInput(Date.now()) }))
          notify(needsNewTime(err) ? `${OVERDUE_TEXT}.` : errorMessageOf(err))
        },
      },
    )

  async function approveAll() {
    setBulk(true)
    let ok = 0
    try {
      for (const s of ready) {
        await act.mutateAsync({ campaignId: s.campaignId, targetId: s.id, body: approveBody(s) })
        ok++
      }
      notify(`Đã duyệt ${ok} bài`)
    } catch (err) {
      notify(partialRunMessage(ok, ready.length, errorMessageOf(err)))
    } finally {
      setBulk(false)
    }
  }

  return (
    <Card className="mt-8">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Bài chờ duyệt <Chip tone="warning">{items.length}{query.data?.truncated ? '+' : ''}</Chip>
          </span>
        }
        subtitle="AI đã viết sẵn. Duyệt để bài được đăng đúng giờ, hoặc sửa trước khi duyệt."
        action={
          <Button size="sm" variant="primary" icon={<Check size={14} />} disabled={!ready.length || act.isPending || bulk} onClick={() => void approveAll()}>
            Duyệt tất cả{ready.length ? ` (${ready.length})` : ''}
          </Button>
        }
      />
      {query.isPending ? (
        <div aria-busy="true" className="space-y-3 p-4">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      ) : query.isError ? (
        <div className="flex items-center justify-between px-4 py-3 text-sm">
          <span className="text-danger">{errorMessageOf(query.error)}</span>
          <Button size="sm" onClick={() => void query.refetch()}>
            Thử lại
          </Button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<Clock size={22} />} title="Không còn bài nào chờ duyệt">
          AI viết trước bài cho 3 ngày tới; bài mới sẽ hiện ở đây trước khi đăng.
        </EmptyState>
      ) : (
        <div className="divide-y divide-border">
          {items.map((slot) => {
            const page = pages.find((p) => p.id === slot.pageId)
            const overdue = isOverdue(slot, now)
            const note = pendingNote(slot, now)
            const block = approveBlock(slot)
            const isEditing = editing?.id === slot.id
            const when = times[slot.id] ?? (overdue ? approveInput(slot, now) : null)
            const whenIssue = when ? scheduleInputIssue(when.date, when.time, now) : null
            const at = when ? vnToIso(when.date, when.time) : null
            return (
              <div key={slot.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    {page ? <PageLabel page={toUiPage(page)} sub={`${slot.campaignName} · ${slotWhen(slotTime(slot))}`} /> : <span className="text-sm">Trang đã gỡ</span>}
                  </div>
                  {overdue && <Chip tone="warning">Quá giờ</Chip>}
                  {slot.topic && <Chip>{slot.topic}</Chip>}
                  {slot.aiCaption && <AiBadge />}
                </div>
                <div className="mt-3">
                  {isEditing ? (
                    <Textarea rows={5} value={editing.text} onChange={(e) => setEditing({ id: slot.id, text: e.target.value })} aria-label="Nội dung bài" className="w-full" />
                  ) : (
                    slot.caption && <p className="text-sm whitespace-pre-line">{slot.caption}</p>
                  )}
                  {slot.media.length > 0 && (
                    <div className="mt-3 flex gap-2">
                      {slot.media.map((m) => (
                        <img key={m.id} src={m.url} alt="Ảnh AI của bài" width={96} height={96} className="size-24 rounded-md object-cover" />
                      ))}
                    </div>
                  )}
                  {note && (
                    <p className="mt-2 flex items-start gap-1.5 text-[13px] text-amber-700">
                      <CircleAlert size={14} className="mt-0.5 shrink-0" /> {note}
                    </p>
                  )}
                  {when && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-[13px] text-muted-foreground">Đăng lúc (giờ Việt Nam)</span>
                      <Input type="date" value={when.date} onChange={(e) => setTimes((t) => ({ ...t, [slot.id]: { ...when, date: e.target.value } }))} className="w-[150px]" aria-label="Ngày đăng (giờ Việt Nam)" aria-invalid={!!whenIssue} />
                      <Input type="time" value={when.time} onChange={(e) => setTimes((t) => ({ ...t, [slot.id]: { ...when, time: e.target.value } }))} className="w-[110px]" aria-label="Giờ đăng (giờ Việt Nam)" aria-invalid={!!whenIssue} />
                      {whenIssue && <span className="w-full text-xs text-danger">{whenIssue}</span>}
                    </div>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  {isEditing ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={act.isPending}>
                        Huỷ
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={act.isPending || !editing.text.trim()}
                        onClick={() => send(slot, { action: 'edit', version: slot.version, caption: editing.text }, () => 'Đã lưu bài', () => setEditing(null))}
                      >
                        Lưu
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" icon={<X size={13} />} disabled={act.isPending} onClick={() => send(slot, { action: 'reject', version: slot.version }, () => 'Đã bỏ bài — bài không được đăng')}>
                        Từ chối
                      </Button>
                      <AiLockHint locked={lock.locked} hint={lock.hint} link={lock.link}>
                        <Button
                          size="sm"
                          icon={<RefreshCw size={13} />}
                          disabled={lock.locked || act.isPending}
                          onClick={() => send(slot, { action: 'regenerate', version: slot.version, immediate: true }, () => 'AI đang viết lại bài này…')}
                        >
                          Tạo lại
                        </Button>
                      </AiLockHint>
                      <Button size="sm" icon={<Pencil size={13} />} disabled={act.isPending} onClick={() => setEditing({ id: slot.id, text: slot.caption })}>
                        Sửa
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<Check size={13} />}
                        title={block ?? undefined}
                        disabled={act.isPending || bulk || !!block || (!!when && (!!whenIssue || !at))}
                        onClick={() =>
                          send(slot, approveBody(slot, at), (s) => approvedToast(s), () =>
                            setTimes((t) => {
                              const { [slot.id]: _drop, ...rest } = t
                              return rest
                            }),
                          )
                        }
                      >
                        Duyệt
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
