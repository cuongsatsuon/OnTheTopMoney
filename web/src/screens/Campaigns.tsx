// Chiến dịch nuôi page `/chien-dich` (Story 7.3): danh sách chiến dịch thật theo Phạm vi (`GET /campaigns?scope=`) — tab
// trạng thái, KPI, thẻ tiến độ (ngày, bài đã đăng / tổng, bài tiếp theo, bài đã đăng 7 ngày). Nháp mở lại wizard
// (`/chien-dich/tao?id=`). Tạm dừng / Tiếp tục / Xoá (Story 7.5) và hàng đợi "Bài chờ duyệt" (Story 7.4) khoá "Sắp có".
import { AlertTriangle, CalendarDays, Check, Clock, Coins, Megaphone, Pause, Pencil, Play, Plus, ShieldCheck, Trash2, Zap } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import type { CampaignStatus, CampaignSummaryDto, PageDto } from '@ottm/shared'
import { Content } from '../components/AppShell'
import { ScreenSkeleton } from '../components/Skeleton'
import { Button, Card, CardHeader, Chip, EmptyState, GroupChip, KpiCard, PageAvatar, PageHeader, Progress, Tabs } from '../components/ui'
import { formatVnd, useAiBudget } from '../lib/ai-budget'
import { useApp } from '../lib/app-context'
import { CAMPAIGN_PARAM, CAMPAIGN_STATUS_TEXT, campaignCounts, campaignPct, goalOf, nextPostLabel, trendTotal, useCampaigns } from '../lib/campaigns'
import { toUiPage, usePages } from '../lib/connections'
import { errorMessageOf } from '../lib/error-messages'
import { useGroups } from '../lib/groups'

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
        <KpiCard label="Bài chờ duyệt" value={String(pending)} icon={<Clock size={16} className="text-warning" />} hint={pending ? 'Xem trên Lịch nội dung' : 'Không còn bài nào cần duyệt'} />
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

      {/* Bài chờ duyệt — hàng đợi duyệt / sửa / tạo lại thuộc Story 7.4. */}
      <Card className="mt-8">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              Bài chờ duyệt <Chip tone="warning">{pending}</Chip>
            </span>
          }
          subtitle="AI đã viết sẵn. Duyệt để bài được đăng đúng giờ, hoặc sửa trước khi duyệt."
          action={
            <Button size="sm" variant="primary" icon={<Check size={14} />} disabled title="Sắp có">
              Duyệt tất cả
            </Button>
          }
        />
        <EmptyState icon={<Clock size={22} />} title="Hàng đợi duyệt sắp có">
          {pending ? (
            <>
              Trong lúc chờ, {pending} bài chờ duyệt đã hiện trên{' '}
              <Link to="/lich" className="font-medium text-primary hover:underline">
                Lịch nội dung
              </Link>
              .
            </>
          ) : (
            'Bài mới từ chiến dịch sẽ hiện ở đây trước khi đăng.'
          )}
        </EmptyState>
      </Card>
    </Content>
  )
}

function CampaignCard({ c, pages }: { c: CampaignSummaryDto; pages: readonly PageDto[] }) {
  const navigate = useNavigate()
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
          <span className="flex-1">Chiến dịch đang tạm dừng</span>
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
          <Button size="sm" icon={<Pause size={14} />} disabled title="Sắp có">
            Tạm dừng
          </Button>
        )}
        {c.status === 'paused' && (
          <Button size="sm" icon={<Play size={14} />} disabled title="Sắp có">
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
        <Button size="sm" variant="ghost" className="ml-auto text-danger hover:bg-red-50 hover:text-danger" icon={<Trash2 size={14} />} disabled title="Sắp có">
          Xoá
        </Button>
      </div>
    </Card>
  )
}
