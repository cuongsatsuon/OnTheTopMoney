// Hiệu suất `/hieu-suat` (Story 8.2, UX Flow 5): KPI + so với kỳ trước, tương tác theo nền tảng, so sánh từng trang và
// bài tốt nhất — số thật từ `GET /performance` (lib/performance.ts), lọc theo Phạm vi ở thanh trên. "Hiệu quả AI" còn dữ
// liệu mẫu tới Story 8.3; "Tạo bài tương tự" điền sẵn đủ ở Story 8.4.
import { ArrowDown, ArrowUp, Bot, ExternalLink, Eye, Heart, ImageOff, Percent, RefreshCw, Timer, UserPlus, Users } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { PagePerformanceDto, PerformanceRange, TopPostDto } from '@ottm/shared'
import { AiLockHint } from '../components/AiLockHint'
import { Content } from '../components/AppShell'
import { Skeleton } from '../components/Skeleton'
import {
  AiBadge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  GroupChip,
  KpiCard,
  PageHeader,
  PageLabel,
  PlatformIcon,
  Segmented,
  Switch,
  cn,
  platformColor,
  platformLabel,
} from '../components/ui'
import { compact, formatNumber, pages, type Page } from '../data/mock'
import { useApp } from '../lib/app-context'
import { reconnectInput, usePages, useStartConnect } from '../lib/connections'
import { errorMessageOf } from '../lib/error-messages'
import {
  INSUFFICIENT_DATA_TEXT,
  PERFORMANCE_RANGE_OPTIONS,
  deltaPct,
  engagementRate,
  formatDay,
  formatMetric,
  formatRate,
  hasSeriesData,
  metricsStateText,
  sortPageRows,
  usePerformance,
  type PageSortKey,
} from '../lib/performance'

export default function Analytics() {
  const { scope, scopeLabel, notify, openAiKeySet } = useApp()
  const navigate = useNavigate()
  const [range, setRange] = useState<PerformanceRange>('30d')
  const [compare, setCompare] = useState(true)
  const [sortKey, setSortKey] = useState<PageSortKey>('engagement')
  const [sortAsc, setSortAsc] = useState(false)
  const query = usePerformance(scope, range)
  // Trang thật nằm trong kho mẫu sau khi `usePages` tải xong — nghe để vẽ lại nhãn trang.
  usePages()
  const startConnect = useStartConnect()
  const data = query.data

  const pageMap = new Map(pages.map((p) => [p.id, p]))
  const rows = useMemo(() => (data ? sortPageRows(data.pages, sortKey, sortAsc) : []), [data, sortKey, sortAsc])
  const chartData = useMemo(() => (data?.series ?? []).map((p) => ({ ...p, day: formatDay(p.date) })), [data])

  const sortBy = (key: PageSortKey) => {
    if (key === sortKey) setSortAsc((v) => !v)
    else {
      setSortKey(key)
      setSortAsc(false)
    }
  }

  /* Kết nối lại một trang thiếu quyền thống kê (Story 2.4): OAuth xin lại quyền, về Trang & Nhóm sau khi xong. */
  const reconnect = (p: Page) => {
    if (startConnect.isPending) return
    const input = reconnectInput(p, 'pages')
    startConnect.mutate(input, { onError: (err) => notify(errorMessageOf(err, input.provider)) })
  }

  const sortProps = { sortKey, sortAsc, onSort: sortBy }
  const rangeLabel = PERFORMANCE_RANGE_OPTIONS.find((r) => r.id === range)!.label
  const period = data?.from ? `${formatDay(data.from)} – ${formatDay(data.to)}` : `${rangeLabel.toLowerCase()} gần nhất`
  const kpiDelta = (m: { current: number | null; previous: number | null }) => (compare ? deltaPct(m) : undefined)

  return (
    <Content>
      <PageHeader
        title="Hiệu suất"
        subtitle={`${scopeLabel} · ${period}`}
        actions={
          <>
            <Segmented options={PERFORMANCE_RANGE_OPTIONS} value={range} onChange={setRange} />
            <label className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] font-medium">
              <Switch checked={compare} onChange={setCompare} label="So với kỳ trước" />
              So với kỳ trước
            </label>
          </>
        }
      />

      {query.isPending ? (
        <PerformanceSkeleton />
      ) : !data ? (
        <Card>
          <EmptyState
            title="Không tải được số liệu"
            action={
              <Button icon={<RefreshCw size={15} />} onClick={() => void query.refetch()}>
                Thử lại
              </Button>
            }
          >
            {errorMessageOf(query.error)}
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
            <KpiCard label="Lượt xem" value={formatMetric(data.kpis.views.current)} delta={kpiDelta(data.kpis.views)} icon={<Eye size={16} />} />
            <KpiCard label="Lượt tiếp cận" value={formatMetric(data.kpis.reach.current)} delta={kpiDelta(data.kpis.reach)} icon={<Users size={16} />} />
            <KpiCard label="Tương tác" value={formatMetric(data.kpis.engagement.current)} delta={kpiDelta(data.kpis.engagement)} icon={<Heart size={16} />} />
            <KpiCard
              label="Tỉ lệ tương tác"
              value={formatRate(data.kpis.engagementRate.current)}
              delta={kpiDelta(data.kpis.engagementRate)}
              icon={<Percent size={16} />}
            />
            <KpiCard
              label="Người theo dõi mới"
              value={formatMetric(data.kpis.followersDelta.current)}
              delta={kpiDelta(data.kpis.followersDelta)}
              icon={<UserPlus size={16} />}
            />
          </div>

          <Card className="mt-6">
            <CardHeader title="Tương tác theo nền tảng" subtitle={compare ? 'Đường nét đứt: tổng tương tác kỳ trước' : 'Tương tác mỗi ngày của từng nền tảng'} />
            <div className="h-[300px] px-2 pt-4 pb-2">
              {data.platforms.length === 0 ? (
                <EmptyState title="Không có trang nào trong phạm vi này">Chọn phạm vi khác ở thanh trên.</EmptyState>
              ) : data.insufficientData ? (
                <EmptyState title={INSUFFICIENT_DATA_TEXT}>Trang mới kết nối chưa đủ 7 ngày — biểu đồ sẽ hiện khi đủ số liệu.</EmptyState>
              ) : !hasSeriesData(data.series) ? (
                <EmptyState title="Chưa có số liệu trong khoảng này">Số liệu từ Meta được cập nhật vài giờ một lần.</EmptyState>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#E2E8F0" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => compact(v)} />
                    <Tooltip contentStyle={{ borderRadius: 8, borderColor: '#E2E8F0', fontSize: 13 }} formatter={(v) => formatNumber(Number(v))} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13 }} />
                    {data.platforms.map((pf) => (
                      <Line key={pf} type="monotone" dataKey={pf} name={platformLabel[pf]} stroke={platformColor[pf]} strokeWidth={2} dot={false} connectNulls />
                    ))}
                    {compare && <Line type="monotone" dataKey="previous" name="Kỳ trước" stroke="#94A3B8" strokeDasharray="5 4" strokeWidth={1.5} dot={false} connectNulls />}
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>

          <Card className="mt-6">
            <CardHeader title="So sánh từng trang" subtitle="Bấm tiêu đề cột để sắp xếp" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Trang</th>
                    <th className="px-4 py-2 font-medium">Nhóm</th>
                    <SortHead id="views" label="Lượt xem" {...sortProps} />
                    <SortHead id="reach" label="Tiếp cận" {...sortProps} />
                    <SortHead id="engagement" label="Tương tác" {...sortProps} />
                    <SortHead id="rate" label="Tỉ lệ" {...sortProps} />
                    <SortHead id="followersDelta" label="Theo dõi mới" {...sortProps} />
                    <SortHead id="posts" label="Bài đăng" {...sortProps} />
                    <th className="px-4 py-2 font-medium">Xu hướng</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <PageRow
                      key={r.pageId}
                      row={r}
                      page={pageMap.get(r.pageId)}
                      onOpen={() => navigate(`/trang-nhom/trang/${r.pageId}`)}
                      onReconnect={reconnect}
                    />
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <EmptyState title="Không có trang nào trong phạm vi này" />}
            </div>
          </Card>

          <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
            <AiEfficiencyCard />
            <Card>
              <CardHeader title="Bài hiệu quả nhất" subtitle="Bài đăng trong kỳ, xếp theo tương tác" />
              {data.topPosts.length === 0 ? (
                <EmptyState title="Chưa có bài đã đăng có số liệu trong kỳ này">Đăng bài để xem hiệu quả ở đây.</EmptyState>
              ) : (
                <ul className="divide-y divide-border">
                  {data.topPosts.map((p, i) => (
                    <TopPostRow
                      key={p.targetId}
                      rank={i + 1}
                      post={p}
                      page={pageMap.get(p.pageId)}
                      aiLocked={!openAiKeySet}
                      onSimilar={() => navigate(`/soan-bai?idea=${encodeURIComponent(p.title ?? '')}`)}
                    />
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </Content>
  )
}

function SortHead({ id, label, sortKey, sortAsc, onSort }: { id: PageSortKey; label: string; sortKey: PageSortKey; sortAsc: boolean; onSort: (k: PageSortKey) => void }) {
  return (
    <th className="px-4 py-2 text-right font-medium">
      <button onClick={() => onSort(id)} className={cn('inline-flex items-center gap-1 hover:text-foreground', sortKey === id && 'text-foreground')}>
        {label}
        {sortKey === id && (sortAsc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  )
}

function PerformanceSkeleton() {
  return (
    <div aria-busy="true" role="status">
      <span className="sr-only">Đang tải số liệu…</span>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      <Skeleton className="mt-6 h-[352px] rounded-lg" />
      <Skeleton className="mt-6 h-64 rounded-lg" />
    </div>
  )
}

/** Một dòng "So sánh từng trang"; cột Xu hướng nhường chỗ cho câu trạng thái khi chưa có sparkline đáng tin. */
function PageRow({ row, page, onOpen, onReconnect }: { row: PagePerformanceDto; page: Page | undefined; onOpen: () => void; onReconnect: (p: Page) => void }) {
  const state = metricsStateText(row.metricsState)
  let trend: ReactNode
  if (row.metricsState === 'permissions_missing') {
    trend = (
      <span className="flex items-center gap-1 text-[13px] whitespace-nowrap text-warning-foreground">
        {state} —
        {page ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onReconnect(page)
            }}
            className="font-medium text-primary hover:underline"
          >
            Kết nối lại
          </button>
        ) : (
          ' Kết nối lại'
        )}
      </span>
    )
  } else if (row.insufficientData) {
    trend = <span className="text-[13px] whitespace-nowrap text-muted-foreground">{INSUFFICIENT_DATA_TEXT}</span>
  } else if (state) {
    trend = <span className="text-[13px] whitespace-nowrap text-muted-foreground">{state}</span>
  } else {
    trend = (
      <div className="h-7 w-24">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={row.trend.map((v) => ({ v }))}>
            <Line type="monotone" dataKey="v" stroke={page ? platformColor[page.platform] : '#64748B'} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    )
  }
  return (
    <tr className="cursor-pointer hover:bg-slate-50" onClick={onOpen}>
      <td className="px-4 py-2.5">{page ? <PageLabel page={page} /> : <span className="font-medium">Trang</span>}</td>
      <td className="px-4 py-2.5">{page && <GroupChip groupId={page.groupId} size="sm" />}</td>
      <td className="tabular px-4 py-2.5 text-right">{formatMetric(row.views)}</td>
      <td className="tabular px-4 py-2.5 text-right">{formatMetric(row.reach)}</td>
      <td className="tabular px-4 py-2.5 text-right">{formatMetric(row.engagement)}</td>
      <td className="tabular px-4 py-2.5 text-right">{formatRate(engagementRate(row.engagement, row.reach))}</td>
      <td className="tabular px-4 py-2.5 text-right">{formatMetric(row.followersDelta)}</td>
      <td className="tabular px-4 py-2.5 text-right">{row.posts}</td>
      <td className="px-4 py-2.5">{trend}</td>
    </tr>
  )
}

function TopPostRow({ rank, post, page, aiLocked, onSimilar }: { rank: number; post: TopPostDto; page: Page | undefined; aiLocked: boolean; onSimilar: () => void }) {
  const rate = engagementRate(post.engagement, post.reach)
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="tabular w-4 text-center text-sm font-semibold text-muted-foreground">{rank}</span>
      {post.thumbnailUrl ? (
        <img src={post.thumbnailUrl} alt="" className="size-14 shrink-0 rounded-md border border-border object-cover" />
      ) : (
        <span className="flex size-14 shrink-0 items-center justify-center rounded-md border border-border bg-slate-50 text-muted-foreground">
          <ImageOff size={18} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{post.title ?? 'Bài không có chữ'}</span>
          {post.ai && <AiBadge />}
          {post.permalink && (
            <a href={post.permalink} target="_blank" rel="noreferrer" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Mở bài trên nền tảng">
              <ExternalLink size={13} />
            </a>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          {page && <PlatformIcon platform={page.platform} size={13} />}
          <span className="ml-1 truncate">{page?.name ?? 'Trang'}</span>
        </div>
        <div className="tabular mt-1 flex gap-3 text-xs">
          <span className="flex items-center gap-1">
            <Eye size={12} className="text-muted-foreground" /> {formatMetric(post.views)}
          </span>
          <span className="flex items-center gap-1">
            <Heart size={12} className="text-muted-foreground" /> {formatMetric(post.engagement)}
          </span>
          {rate !== null && <span className="text-muted-foreground">{formatRate(rate)}</span>}
        </div>
      </div>
      <AiLockHint locked={aiLocked} align="end">
        <Button variant="ai" size="sm" disabled={aiLocked} onClick={onSimilar}>
          Tạo bài tương tự
        </Button>
      </AiLockHint>
    </li>
  )
}

/* ---------- Hiệu quả AI — dữ liệu mẫu tới Story 8.3 ---------- */

const AI_VS_HUMAN = [
  { name: 'Bài AI tạo', value: 1840 },
  { name: 'Bài tự viết', value: 1310 },
]

function AiEfficiencyCard() {
  return (
    <Card className="border-ai/25">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Bot size={17} className="text-ai" />
            Hiệu quả AI
          </span>
        }
        subtitle="Những gì AI đã làm thay bạn trong kỳ này"
      />
      <div className="grid grid-cols-3 divide-x divide-border border-b border-border">
        <div className="p-4">
          <div className="text-[13px] text-muted-foreground">AI trả lời</div>
          <div className="tabular mt-1 text-2xl font-bold text-ai">912 tin</div>
          <div className="mt-1 text-xs text-muted-foreground">81% tổng tin nhắn</div>
        </div>
        <div className="p-4">
          <div className="flex items-center gap-1 text-[13px] text-muted-foreground">
            <Users size={13} /> Chuyển cho bạn
          </div>
          <div className="tabular mt-1 text-2xl font-bold">9%</div>
          <div className="mt-1 text-xs text-muted-foreground">101 hội thoại</div>
        </div>
        <div className="p-4">
          <div className="flex items-center gap-1 text-[13px] text-muted-foreground">
            <Timer size={13} /> Phản hồi trung bình
          </div>
          <div className="tabular mt-1 text-2xl font-bold">14 giây</div>
          <div className="mt-1 text-xs text-muted-foreground">Bạn tự trả lời: 23 phút</div>
        </div>
      </div>
      <div className="p-4">
        <div className="mb-2 flex items-center justify-between text-[13px]">
          <span className="font-medium">Tương tác trung bình mỗi bài</span>
          <span className="font-medium text-ai">AI tạo cao hơn 40%</span>
        </div>
        <div className="h-[110px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={AI_VS_HUMAN} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={14}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" width={92} tick={{ fontSize: 13, fill: '#0F172A' }} tickLine={false} axisLine={false} />
              <Bar dataKey="value" radius={[0, 6, 6, 0]} isAnimationActive={false}>
                {AI_VS_HUMAN.map((row, i) => (
                  <Cell key={row.name} fill={i === 0 ? '#7C3AED' : '#CBD5E1'} />
                ))}
                <LabelList dataKey="value" position="right" style={{ fontSize: 13, fill: '#0F172A' }} formatter={(v) => formatNumber(Number(v))} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  )
}
