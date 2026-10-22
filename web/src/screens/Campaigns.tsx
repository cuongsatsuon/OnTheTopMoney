import { AlertTriangle, CalendarDays, Check, Clock, Coins, Megaphone, Pause, Pencil, Play, Plus, ShieldCheck, Trash2, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { Content } from '../components/AppShell'
import {
  AiBadge,
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  GroupChip,
  KpiCard,
  Modal,
  PageAvatar,
  PageHeader,
  PlatformIcon,
  Progress,
  Tabs,
  Textarea,
  cn,
} from '../components/ui'
import { campaigns as seedCampaigns, pageById, posts, type Campaign, type CampaignStatus, type Post } from '../data/mock'
import { formatVnd, useAiBudget } from '../lib/ai-budget'
import { useApp } from '../lib/app-context'

type TabId = 'all' | CampaignStatus

const STATUS_TEXT: Record<CampaignStatus, string> = { running: 'Đang chạy', paused: 'Tạm dừng', done: 'Đã xong', draft: 'Bản nháp' }

const shortDate = (iso: string) => {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

function CampaignStatusPill({ c }: { c: Campaign }) {
  if (c.status === 'running') return <Chip tone="success">● Đang chạy</Chip>
  if (c.status === 'paused') return <Chip tone="warning" icon={<Pause size={11} />}>Tạm dừng</Chip>
  if (c.status === 'done') return <Chip icon={<Check size={11} />}>Đã xong</Chip>
  return <Chip>Bản nháp</Chip>
}

function Sparkline({ data }: { data: number[] }) {
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
  const { inScope, scopeLabel, notify } = useApp()
  const navigate = useNavigate()
  const budget = useAiBudget()

  const [items, setItems] = useState<Campaign[]>(seedCampaigns)
  const [pending, setPending] = useState<Post[]>(() => posts.filter((p) => p.status === 'pending'))
  const [tab, setTab] = useState<TabId>('all')
  const [toDelete, setToDelete] = useState<Campaign | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const scoped = useMemo(() => items.filter((c) => inScope(c.pageIds)), [items, inScope])
  const shown = tab === 'all' ? scoped : scoped.filter((c) => c.status === tab)
  const scopedPending = pending.filter((p) => inScope(p.pageIds))
  const count = (s: CampaignStatus) => scoped.filter((c) => c.status === s).length
  const aiPublished = scoped.reduce((n, c) => n + c.postsDone, 0)

  const setStatus = (c: Campaign, status: CampaignStatus) => {
    setItems((all) =>
      all.map((x) =>
        x.id === c.id
          ? { ...x, status, pauseReason: status === 'paused' ? 'Bạn đã tạm dừng' : undefined, nextPost: status === 'paused' ? 'Tạm dừng' : 'Hôm nay 19:30' }
          : x,
      ),
    )
    notify(status === 'paused' ? `Đã tạm dừng “${c.name}”` : `Đã tiếp tục “${c.name}”`)
  }

  const approve = (p: Post) => {
    setPending((all) => all.filter((x) => x.id !== p.id))
    notify(`Đã duyệt — bài sẽ đăng lúc ${p.time} ngày ${shortDate(p.date)}`)
  }
  const approveAll = () => {
    const n = scopedPending.length
    setPending((all) => all.filter((x) => !inScope(x.pageIds)))
    notify(`Đã duyệt ${n} bài`)
  }
  const saveEdit = (p: Post) => {
    setPending((all) => all.map((x) => (x.id === p.id ? { ...x, caption: editText } : x)))
    setEditingId(null)
    notify('Đã lưu nội dung bài')
  }

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
        <KpiCard label="Số chiến dịch" value={String(scoped.length)} hint={`${count('running')} đang chạy · ${count('paused')} tạm dừng`} icon={<Megaphone size={16} />} />
        <KpiCard label="Bài AI đã đăng" value={String(aiPublished)} delta={18} hint="so với tháng trước" />
        <KpiCard
          label="Bài chờ duyệt"
          value={String(scopedPending.length)}
          icon={<Clock size={16} className="text-warning" />}
          hint={
            scopedPending.length ? (
              <button
                onClick={() => document.getElementById('cho-duyet')?.scrollIntoView({ behavior: 'smooth' })}
                className="font-medium text-primary hover:underline"
              >
                Duyệt ngay
              </button>
            ) : (
              'Không còn bài nào cần duyệt'
            )
          }
        />
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
          { id: 'all', label: 'Tất cả', count: scoped.length },
          { id: 'running', label: 'Đang chạy', count: count('running') },
          { id: 'paused', label: 'Tạm dừng', count: count('paused') },
          { id: 'draft', label: 'Bản nháp', count: count('draft') },
          { id: 'done', label: 'Đã xong', count: count('done') },
        ]}
      />

      {shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Megaphone size={22} />}
            title={tab === 'all' ? 'Chưa có chiến dịch nào' : `Không có chiến dịch ${STATUS_TEXT[tab as CampaignStatus].toLowerCase()}`}
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
          {shown.map((c) => {
            const pct = c.daysTotal ? Math.round((c.daysDone / c.daysTotal) * 100) : 0
            const first = c.trend[0] || 1
            const delta = Math.round(((c.trend[c.trend.length - 1] - first) / first) * 100)
            return (
              <Card key={c.id} className="flex flex-col p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold">{c.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Chip>{c.goal}</Chip>
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
                  <CampaignStatusPill c={c} />
                </div>

                {c.status === 'paused' && c.pauseReason && (
                  <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-200 bg-warning-soft px-3 py-2 text-[13px] text-amber-900">
                    <AlertTriangle size={14} className="shrink-0" />
                    <span className="flex-1">{c.pauseReason}</span>
                    {c.pauseReason.includes('token') && (
                      <Link to="/trang-nhom" className="font-medium whitespace-nowrap underline">
                        Kết nối lại
                      </Link>
                    )}
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <span className="flex -space-x-2">
                    {c.pageIds.map((id) => (
                      <span key={id} title={pageById(id).name} className="rounded-full ring-2 ring-white">
                        <PageAvatar page={pageById(id)} size={28} />
                      </span>
                    ))}
                  </span>
                  <span className="text-xs text-muted-foreground">{c.pageIds.length} trang</span>
                  {c.groupId && <GroupChip groupId={c.groupId} size="sm" />}
                </div>

                <div className="mt-4 flex items-end justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex justify-between text-xs">
                      <span className="tabular font-medium">
                        {c.daysDone}/{c.daysTotal} ngày · {c.postsDone}/{c.postsTotal} bài
                      </span>
                      <span className="tabular text-muted-foreground">{pct}%</span>
                    </div>
                    <Progress value={pct} />
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock size={12} />
                      Bài tiếp theo: <span className="font-medium text-foreground">{c.nextPost}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <Sparkline data={c.trend} />
                    <div className="text-[11px] text-muted-foreground">
                      Tương tác 7 ngày{' '}
                      {c.status !== 'draft' && <span className={cn('font-semibold', delta >= 0 ? 'text-success' : 'text-danger')}>{delta >= 0 ? `+${delta}` : delta}%</span>}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
                  {c.status === 'running' && (
                    <Button size="sm" icon={<Pause size={14} />} onClick={() => setStatus(c, 'paused')}>
                      Tạm dừng
                    </Button>
                  )}
                  {c.status === 'paused' && (
                    <Button size="sm" icon={<Play size={14} />} onClick={() => setStatus(c, 'running')}>
                      Tiếp tục
                    </Button>
                  )}
                  {c.status === 'draft' && (
                    <Button size="sm" icon={<Pencil size={14} />} onClick={() => navigate('/chien-dich/tao')}>
                      Tiếp tục thiết lập
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon={<CalendarDays size={14} />} onClick={() => navigate('/lich')}>
                    Xem lịch
                  </Button>
                  <Button size="sm" variant="ghost" className="ml-auto text-danger hover:bg-red-50 hover:text-danger" icon={<Trash2 size={14} />} onClick={() => setToDelete(c)}>
                    Xoá
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* Bài chờ duyệt */}
      <Card className="mt-8">
        <div id="cho-duyet" className="scroll-mt-6" />
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Bài chờ duyệt <Chip tone="warning">{scopedPending.length}</Chip>
            </span>
          }
          subtitle="AI đã viết sẵn. Duyệt để bài được đăng đúng giờ, hoặc sửa trước khi duyệt."
          action={
            scopedPending.length > 1 && (
              <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={approveAll}>
                Duyệt tất cả
              </Button>
            )
          }
        />
        {scopedPending.length === 0 ? (
          <EmptyState icon={<Check size={22} />} title="Không còn bài nào chờ duyệt">
            Bài mới từ chiến dịch sẽ hiện ở đây trước khi đăng.
          </EmptyState>
        ) : (
          <div className="divide-y divide-border">
            {scopedPending.map((p) => {
              const camp = items.find((c) => c.id === p.campaignId)
              const editing = editingId === p.id
              return (
                <div key={p.id} className="flex gap-4 p-4">
                  <img src={p.image} alt="" className="size-24 shrink-0 rounded-md border border-border object-cover" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{p.title}</span>
                      {p.ai && <AiBadge />}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        {p.pageIds.map((id) => (
                          <PlatformIcon key={id} platform={pageById(id).platform} size={14} />
                        ))}
                        <span className="ml-0.5">{p.pageIds.map((id) => pageById(id).name).join(', ')}</span>
                      </span>
                      <span className="tabular flex items-center gap-1">
                        <Clock size={12} /> {p.time} · {shortDate(p.date)}
                      </span>
                      {camp && <span>Từ: {camp.name}</span>}
                    </div>
                    {editing ? (
                      <div className="mt-2">
                        <Textarea rows={3} value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Sửa nội dung" />
                        <div className="mt-2 flex gap-2">
                          <Button size="sm" variant="primary" onClick={() => saveEdit(p)}>
                            Lưu
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                            Huỷ
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-2 line-clamp-2 text-[13px] text-slate-700">{p.caption}</p>
                    )}
                  </div>
                  {!editing && (
                    <div className="flex shrink-0 flex-col gap-2">
                      <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={() => approve(p)}>
                        Duyệt
                      </Button>
                      <Button
                        size="sm"
                        icon={<Pencil size={14} />}
                        onClick={() => {
                          setEditingId(p.id)
                          setEditText(p.caption)
                        }}
                      >
                        Sửa
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Modal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Xoá chiến dịch?"
        width={440}
        footer={
          <>
            <Button onClick={() => setToDelete(null)}>Huỷ</Button>
            <Button
              variant="danger"
              icon={<Trash2 size={14} />}
              onClick={() => {
                if (!toDelete) return
                setItems((all) => all.filter((x) => x.id !== toDelete.id))
                notify(`Đã xoá “${toDelete.name}”`)
                setToDelete(null)
              }}
            >
              Xoá chiến dịch
            </Button>
          </>
        }
      >
        <p className="text-sm">
          “{toDelete?.name}” sẽ dừng hẳn và các bài chưa đăng sẽ bị gỡ khỏi lịch. Bài đã đăng ({toDelete?.postsDone} bài) vẫn giữ nguyên trên trang.
        </p>
      </Modal>
    </Content>
  )
}
