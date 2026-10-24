// Tổng quan `/` (Story 8.5): mọi phần đọc server theo Phạm vi — không còn dữ liệu mẫu.
// - Số liệu chính (`GET /overview/metrics`, cùng nguồn + kỳ với Hiệu suất): KPI tiếp cận / tương tác / tin nhắn ("AI đã trả
//   lời X%") / người theo dõi mới + % kỳ trước, biểu đồ tương tác theo nền tảng (7 / 30 / 90 ngày).
// - Việc cần xử lý (`GET /overview`): cảnh báo theo mức gấp (`attentionItems` — hạn mức AI, webhook, trang, chiến dịch tự
//   dừng, bài lỗi, bài chờ duyệt), rồi hội thoại "Cần xử lý" chờ lâu nhất. Mỗi mục dẫn tới đúng chỗ xử lý; "Kết nối lại" /
//   "Đăng lại" bấm ngay tại chỗ. Hint realtime làm cũ `['overview', …]` → refetch ngay (lib/realtime.ts).
// - Bài sắp đăng (mở đúng bài trên Lịch), chiến dịch đang chạy (Tạm dừng / Tiếp tục ngay, lý do tạm dừng — Story 7.5),
//   bảng trang (trạng thái kết nối thật, AI trả lời đọc từ cấu hình thật).
import { AlertTriangle, ArrowRight, CalendarClock, ChevronRight, Clock, Eye, Heart, MessageCircle, Pause, Play, RefreshCw, RotateCcw, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { OverviewPostDto, PageDto, PerformanceRange } from '@ottm/shared'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Content } from '../components/AppShell'
import { Skeleton } from '../components/Skeleton'
import {
  AiBadge,
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  GroupChip,
  KpiCard,
  PageAvatar,
  PageHeader,
  PageLabel,
  PlatformIcon,
  Progress,
  Segmented,
  StatusChip,
  cn,
  platformColor,
  platformLabel,
} from '../components/ui'
import { compact, formatNumber } from '../data/mock'
import { useApp } from '../lib/app-context'
import { useAutoreplyOverview } from '../lib/autoreply'
import { calendarHref } from '../lib/calendar'
import { campaignPct, goalOf, lifecycleToast, nextPostLabel, pausedNote, relativeVnTime, resumeErrorText, useCampaignLifecycle } from '../lib/campaigns'
import { needsReconnect, reconnectInput, uiPageOf, usePages, useStartConnect } from '../lib/connections'
import { errorMessageOf } from '../lib/error-messages'
import { contactLabel, durationLabel, inboxHref, previewText, reasonText, useNow } from '../lib/inbox'
import {
  OVERVIEW_ROOT_KEY,
  aiRepliedHint,
  attentionItems,
  needsHumanText,
  postLabel,
  retryCall,
  useOverview,
  useOverviewMetrics,
  type AttentionItem,
} from '../lib/overview'
import { INSUFFICIENT_DATA_TEXT, PERFORMANCE_RANGE_OPTIONS, deltaPct, formatDay, formatMetric, hasSeriesData } from '../lib/performance'
import { transitionErrorMessage, useTransitionTargets } from '../lib/publish'

export default function Dashboard() {
  const { scope, scopedPages, scopeLabel, notify } = useApp()
  const qc = useQueryClient()
  const now = useNow()
  const [range, setRange] = useState<PerformanceRange>('30d')
  const metrics = useOverviewMetrics(scope, range)
  const overview = useOverview(scope)
  const pagesQuery = usePages()
  const autoreply = useAutoreplyOverview()
  const lifecycle = useCampaignLifecycle()
  const transition = useTransitionTargets()
  const startConnect = useStartConnect()

  const pages = useMemo(() => pagesQuery.data ?? [], [pagesQuery.data])
  const pageById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])
  const pageName = (id: string) => pageById.get(id)?.name ?? 'Trang đã gỡ'
  const aiOn = new Map((autoreply.data?.pages ?? []).map((s) => [s.pageId, s.enabled]))
  const refreshOverview = () => void qc.invalidateQueries({ queryKey: OVERVIEW_ROOT_KEY })

  // Story 7.5: Tạm dừng / Tiếp tục ngay trên thẻ (không xác nhận).
  const toggleCampaign = (id: string, action: 'pause' | 'resume') =>
    lifecycle.mutate(
      { id, action },
      {
        onSuccess: (res) => notify(lifecycleToast(action, res)),
        onError: (err) => notify(action === 'resume' ? resumeErrorText(err) : errorMessageOf(err)),
        onSettled: refreshOverview,
      },
    )

  /* Kết nối lại một trang (Story 2.4): OAuth với đúng trang, về Trang & Nhóm sau khi xong. */
  const reconnect = (p: Pick<PageDto, 'id' | 'platform'>) => {
    if (startConnect.isPending) return
    const input = reconnectInput(p, 'pages')
    startConnect.mutate(input, { onError: (err) => notify(errorMessageOf(err, input.provider)) })
  }

  /* "Đăng lại ngay" mọi trang lỗi của bài. */
  const retry = (p: OverviewPostDto) =>
    transition.mutate(retryCall(p), {
      onSuccess: () => notify(`Đang đăng lại lên ${p.targets.length} trang…`),
      onError: (err) => notify(transitionErrorMessage(err, pages)),
      onSettled: refreshOverview,
    })

  const m = metrics.data
  const chartData = useMemo(() => (m?.series ?? []).map((p) => ({ ...p, day: formatDay(p.date) })), [m])
  const rangeLabel = PERFORMANCE_RANGE_OPTIONS.find((r) => r.id === range)!.label.toLowerCase()
  const kpiHint = (delta: number | undefined) => (delta === undefined ? undefined : 'so với kỳ trước')

  const data = overview.data
  const attention = data ? attentionItems(data, pageName) : []
  const nothingToDo = !!data && attention.length === 0 && data.needsHuman.count === 0

  return (
    <Content>
      <PageHeader
        title="Tổng quan"
        subtitle={`${scopeLabel} · ${scopedPages.length} trang`}
        actions={<Segmented options={PERFORMANCE_RANGE_OPTIONS} value={range} onChange={setRange} />}
      />

      {metrics.isPending ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[104px] rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {(
            [
              ['Lượt tiếp cận', m?.kpis.reach, <Eye key="i" size={16} />, undefined],
              ['Tương tác', m?.kpis.engagement, <Heart key="i" size={16} />, undefined],
              ['Tin nhắn mới', m?.kpis.messages, <MessageCircle key="i" size={16} />, m ? aiRepliedHint(m) : undefined],
              ['Người theo dõi mới', m?.kpis.followersDelta, <UserPlus key="i" size={16} />, undefined],
            ] as const
          ).map(([label, kpi, icon, hint]) => {
            const delta = kpi ? deltaPct(kpi) : undefined
            return <KpiCard key={label} label={label} value={formatMetric(kpi?.current ?? null)} delta={delta} hint={hint ?? kpiHint(delta)} icon={icon} />
          })}
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title={`Tương tác ${rangeLabel}`} subtitle="Lượt thích, bình luận, chia sẻ theo nền tảng" />
          <div className="h-[280px] px-2 pt-4 pb-2">
            {metrics.isPending ? (
              <Skeleton className="h-full rounded-md" />
            ) : !m ? (
              <EmptyState
                title="Không tải được số liệu"
                action={
                  <Button icon={<RefreshCw size={15} />} onClick={() => void metrics.refetch()}>
                    Thử lại
                  </Button>
                }
              >
                {errorMessageOf(metrics.error)}
              </EmptyState>
            ) : m.platforms.length === 0 ? (
              <EmptyState title="Chưa có dữ liệu trong phạm vi này">Chọn phạm vi khác ở thanh trên.</EmptyState>
            ) : m.insufficientData ? (
              <EmptyState title={INSUFFICIENT_DATA_TEXT}>Trang mới kết nối chưa đủ 7 ngày — biểu đồ sẽ hiện khi đủ số liệu.</EmptyState>
            ) : !hasSeriesData(m.series) ? (
              <EmptyState title="Chưa có số liệu trong khoảng này">Số liệu từ Meta được cập nhật vài giờ một lần.</EmptyState>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#E2E8F0" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => compact(v)} />
                  <Tooltip contentStyle={{ borderRadius: 8, borderColor: '#E2E8F0', fontSize: 13 }} formatter={(v) => formatNumber(Number(v))} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13 }} />
                  {m.platforms.map((pf) => (
                    <Line key={pf} type="monotone" dataKey={pf} name={platformLabel[pf]} stroke={platformColor[pf]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Cần bạn xử lý"
            subtitle={data ? needsHumanText(data.needsHuman.count) : undefined}
            action={
              <Link to={inboxHref({ tab: 'needs_human' })} className="text-[13px] font-medium text-primary hover:underline">
                Mở hộp thư
              </Link>
            }
          />
          {overview.isPending ? (
            <ListSkeleton rows={4} />
          ) : !data ? (
            <OverviewError error={overview.error} onRetry={() => void overview.refetch()} />
          ) : nothingToDo ? (
            <EmptyState title="Không còn việc cần xử lý">AI đang trông giúp bạn.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {attention.map((it) => (
                <AttentionRow
                  key={it.key}
                  item={it}
                  busy={transition.isPending || startConnect.isPending}
                  onReconnect={() => it.page && reconnect(it.page)}
                  onRetry={() => it.post && retry(it.post)}
                />
              ))}
              {data.needsHuman.items.map((c) => {
                const dto = pageById.get(c.pageId)
                const waitingFrom = c.waitingSince ?? c.lastCustomerMessageAt
                return (
                  <li key={c.id}>
                    <Link to={inboxHref({ tab: 'needs_human', conversationId: c.id })} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50">
                      {dto && <PageAvatar page={uiPageOf(dto)} size={32} />}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{contactLabel(c.contact, dto?.platform)}</span>
                          {waitingFrom && (
                            <Chip tone="warning" icon={<Clock size={11} />}>
                              chờ {durationLabel(waitingFrom, now).toLowerCase()}
                            </Chip>
                          )}
                        </span>
                        <span className="block truncate text-[13px] text-muted-foreground">{previewText(c.preview)}</span>
                        {c.state === 'handoff' && c.stateReason && (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">Lý do: {reasonText(c.stateReason, c.channel)}</span>
                        )}
                      </span>
                    </Link>
                  </li>
                )
              })}
              {data.needsHuman.count > data.needsHuman.items.length && (
                <li>
                  <Link to={inboxHref({ tab: 'needs_human' })} className="flex items-center justify-center gap-1 px-4 py-2.5 text-[13px] font-medium text-primary hover:bg-slate-50">
                    Xem tất cả {data.needsHuman.count} tin nhắn <ArrowRight size={13} />
                  </Link>
                </li>
              )}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Trang đã kết nối"
          subtitle={`${scopedPages.length} trang trong ${scopeLabel}`}
          action={
            <Link to="/trang-nhom" className="text-[13px] font-medium text-primary hover:underline">
              Quản lý trang
            </Link>
          }
        />
        {scopedPages.length === 0 ? (
          <EmptyState title="Chưa có trang nào trong phạm vi này" action={<Link to="/trang-nhom" className="text-sm font-medium text-primary hover:underline">Kết nối trang</Link>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Trang</th>
                  <th className="px-4 py-2 font-medium">Nhóm</th>
                  <th className="px-4 py-2 font-medium">Trạng thái</th>
                  <th className="px-4 py-2 font-medium">AI trả lời</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {scopedPages.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5">
                      <Link to={`/trang-nhom/trang/${p.id}`} className="block">
                        <PageLabel page={p} />
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <GroupChip groupId={p.groupId} />
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2">
                        <StatusChip status={p.status} />
                        {needsReconnect(p.status) && (
                          <button type="button" className="text-[13px] font-medium text-primary hover:underline disabled:opacity-50" disabled={startConnect.isPending} onClick={() => reconnect(p)}>
                            Kết nối lại
                          </button>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {/* Chỉ xem — bật / tắt ở AI trả lời tự động (có xác nhận, kiểm khoá OpenAI). */}
                      <Link to={`/ai-tra-loi?muc=page:${p.id}`} className="hover:opacity-80">
                        {aiOn.get(p.id) ? <Chip tone="ai">AI đang bật</Chip> : <Chip>AI tắt</Chip>}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader
            title="Bài sắp đăng"
            action={
              <Link to="/lich" className="text-[13px] font-medium text-primary hover:underline">
                Xem lịch
              </Link>
            }
          />
          {overview.isPending ? (
            <ListSkeleton rows={3} />
          ) : !data ? (
            <OverviewError error={overview.error} onRetry={() => void overview.refetch()} />
          ) : data.upcoming.length === 0 ? (
            <EmptyState icon={<CalendarClock size={20} />} title="Chưa có bài nào sắp đăng" action={<Link to="/soan-bai" className="text-sm font-medium text-primary hover:underline">Tạo bài viết</Link>} />
          ) : (
            <ul className="divide-y divide-border">
              {data.upcoming.map((p) => (
                <li key={`${p.postId}|${p.scheduledAt}`}>
                  <Link to={calendarHref(p.targets[0]!.id, p.scheduledAt)} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
                    {p.thumbnailUrl ? (
                      <img src={p.thumbnailUrl} alt="" className="size-12 shrink-0 rounded-md border border-border object-cover" />
                    ) : (
                      <span className="flex size-12 shrink-0 items-center justify-center rounded-md border border-border bg-slate-50 text-muted-foreground">
                        <CalendarClock size={18} />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{postLabel(p)}</span>
                        {p.ai && <AiBadge />}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          {p.targets.map((t) => {
                            const pf = pageById.get(t.pageId)?.platform
                            return pf ? <PlatformIcon key={t.id} platform={pf} size={14} /> : null
                          })}
                        </span>
                        <span className="truncate">{p.targets.map((t) => pageName(t.pageId)).join(', ')}</span>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="tabular text-[13px] font-medium">{relativeVnTime(p.scheduledAt, now.getTime())}</div>
                      <div className="mt-0.5">{p.status === 'pending_approval' ? <Chip tone="warning">Chờ duyệt</Chip> : <Chip tone="primary">Đã lên lịch</Chip>}</div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Chiến dịch đang chạy"
            action={
              <Link to="/chien-dich" className="text-[13px] font-medium text-primary hover:underline">
                Tất cả chiến dịch
              </Link>
            }
          />
          {overview.isPending ? (
            <ListSkeleton rows={2} />
          ) : !data ? (
            <OverviewError error={overview.error} onRetry={() => void overview.refetch()} />
          ) : data.campaigns.length === 0 ? (
            <EmptyState title="Chưa có chiến dịch nào" action={<Link to="/chien-dich/tao" className="text-sm font-medium text-primary hover:underline">Tạo chiến dịch</Link>}>
              Để AI tự đăng bài đều đặn cho trang của bạn.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {data.campaigns.map((c) => {
                const running = c.status === 'running'
                const pct = campaignPct(c)
                return (
                  <li key={c.id} className="px-4 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{c.name}</span>
                          {running ? <Chip tone="success">Đang chạy</Chip> : <Chip tone="warning">Tạm dừng</Chip>}
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          {c.groupId && <GroupChip groupId={c.groupId} size="sm" />}
                          <span>
                            {goalOf(c.goal).label} · {c.mode === 'review' ? 'Duyệt trước khi đăng' : 'Tự đăng'}
                          </span>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        icon={running ? <Pause size={14} /> : <Play size={14} />}
                        disabled={lifecycle.isPending}
                        onClick={() => toggleCampaign(c.id, running ? 'pause' : 'resume')}
                      >
                        {running ? 'Tạm dừng' : 'Tiếp tục'}
                      </Button>
                    </div>
                    {!running && <div className="mt-2 rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-amber-900">{pausedNote(c)}</div>}
                    <Progress value={pct} className={cn('mt-3', !running && 'opacity-60')} />
                    <div className="tabular mt-1.5 flex justify-between text-xs text-muted-foreground">
                      <span>
                        {c.postsDone}/{c.postsTotal} bài · ngày {c.daysDone}/{c.durationDays}
                      </span>
                      <span>{running ? `Bài tiếp: ${nextPostLabel(c, now.getTime())}` : 'Đang tạm dừng'}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-8 text-center text-xs text-muted-foreground">
        <Link to="/bat-dau" className="inline-flex items-center gap-1 hover:text-primary hover:underline">
          Xem màn chào lần đầu <ArrowRight size={12} />
        </Link>
      </div>
    </Content>
  )
}

/** Một việc cần xử lý: biểu tượng + chữ (không chỉ bằng màu), link tới chỗ xử lý; trang / bài lỗi có nút ngay tại chỗ. */
function AttentionRow({ item, busy, onReconnect, onRetry }: { item: AttentionItem; busy: boolean; onReconnect: () => void; onRetry: () => void }) {
  const icon = (
    <span className={cn('mt-0.5 shrink-0 rounded-full p-1.5', item.tone === 'danger' ? 'bg-danger-soft text-danger-foreground' : 'bg-warning-soft text-warning-foreground')}>
      <AlertTriangle size={14} aria-hidden />
    </span>
  )
  const text = (
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium">{item.title}</span>
      <span className={cn('block truncate text-xs', item.tone === 'danger' ? 'text-danger-foreground' : 'text-muted-foreground')}>{item.detail}</span>
    </span>
  )
  if (item.page || item.post) {
    return (
      <li className="flex items-start gap-3 px-4 py-3">
        {icon}
        <Link to={item.href} className="min-w-0 flex-1 hover:underline">
          {text}
        </Link>
        {item.page ? (
          <Button size="sm" icon={<RefreshCw size={14} />} disabled={busy} onClick={onReconnect}>
            Kết nối lại
          </Button>
        ) : (
          <Button size="sm" icon={<RotateCcw size={14} />} disabled={busy} onClick={onRetry}>
            Đăng lại
          </Button>
        )}
      </li>
    )
  }
  return (
    <li>
      <Link to={item.href} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50">
        {icon}
        {text}
        <ChevronRight size={16} className="mt-1 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  )
}

/** Skeleton đúng bố cục danh sách của thẻ. */
function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-3 px-4 py-3" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 rounded-md" />
      ))}
    </div>
  )
}

function OverviewError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <EmptyState
      title="Không tải được việc cần xử lý"
      action={
        <Button icon={<RefreshCw size={15} />} onClick={onRetry}>
          Thử lại
        </Button>
      }
    >
      {errorMessageOf(error)}
    </EmptyState>
  )
}
