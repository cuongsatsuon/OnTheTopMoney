import { ArrowRight, CalendarClock, Clock, Eye, Heart, MessageCircle, Pause, Play, RotateCcw, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
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
  PageAvatar,
  PageHeader,
  PageLabel,
  PlatformIcon,
  Progress,
  Segmented,
  StatusChip,
  Switch,
  cn,
  platformColor,
  platformLabel,
} from '../components/ui'
import {
  compact,
  contactById,
  conversations,
  engagement30d,
  formatNumber,
  pageById,
  pages,
  posts,
  type Platform,
  type Post,
} from '../data/mock'
import { useApp } from '../lib/app-context'
import { activeCampaigns as activeOf, campaignPct, goalOf, lifecycleToast, nextPostLabel, pausedNote, resumeErrorText, useCampaignLifecycle, useCampaigns } from '../lib/campaigns'
import { errorMessageOf } from '../lib/error-messages'
import { needsReconnect } from '../lib/connections'

type Range = '7d' | '30d' | 'month'

const RANGES: { id: Range; label: string }[] = [
  { id: '7d', label: '7 ngày' },
  { id: '30d', label: '30 ngày' },
  { id: 'month', label: 'Tháng này' },
]

/** Số ngày trong khoảng (hôm nay là 19/10 nên "Tháng này" = 19 ngày). */
const RANGE_DAYS: Record<Range, number> = { '7d': 7, '30d': 30, month: 19 }

/** Số liệu 30 ngày của toàn bộ trang; các khoảng khác và phạm vi khác được quy đổi theo tỉ lệ. */
const BASE_30D = { reach: 486_200, engagement: 38_940, messages: 1_126, followers: 3_420 }

const DELTAS: Record<Range, { reach: number; engagement: number; messages: number; followers: number }> = {
  '7d': { reach: 6.2, engagement: 9.8, messages: 14.1, followers: 4.3 },
  '30d': { reach: 12.4, engagement: 18.2, messages: 22.6, followers: -3.1 },
  month: { reach: 8.7, engagement: 11.5, messages: 17.9, followers: 2.4 },
}

const PLATFORMS: Platform[] = ['facebook', 'instagram', 'threads']

const TODAY = '2026-10-19'
const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

function whenLabel(post: Post) {
  const d = new Date(`${post.date}T00:00:00`)
  const diff = Math.round((d.getTime() - new Date(`${TODAY}T00:00:00`).getTime()) / 86_400_000)
  const day = diff === 0 ? 'Hôm nay' : diff === 1 ? 'Mai' : `${WEEKDAYS[d.getDay()]}, ${d.getDate()}/${d.getMonth() + 1}`
  return `${day} ${post.time}`
}

export default function Dashboard() {
  const { scope, scopedPages, scopeLabel, inScope, notify } = useApp()
  const [range, setRange] = useState<Range>('30d')
  const [autoReply, setAutoReply] = useState<Record<string, boolean>>(() => Object.fromEntries(pages.map((p) => [p.id, p.autoReply])))
  // Story 7.3: chiến dịch thật theo Phạm vi (đang chạy + tạm dừng) kèm tiến độ từ read-model. Story 7.5: Tạm dừng /
  // Tiếp tục ngay trên thẻ (không xác nhận), dòng lý do khi tạm dừng.
  const campaignList = useCampaigns(scope)
  const lifecycle = useCampaignLifecycle()
  const toggleCampaign = (id: string, action: 'pause' | 'resume') =>
    lifecycle.mutate(
      { id, action },
      { onSuccess: (res) => notify(lifecycleToast(action, res)), onError: (err) => notify(action === 'resume' ? resumeErrorText(err) : errorMessageOf(err)) },
    )

  // Tỉ lệ người theo dõi của phạm vi so với tổng — dùng để quy đổi số liệu mẫu theo phạm vi.
  const scopeShare = useMemo(() => {
    const total = pages.reduce((s, p) => s + p.followers, 0)
    return scopedPages.reduce((s, p) => s + p.followers, 0) / total
  }, [scopedPages])

  const platformShare = useMemo(() => {
    const out = {} as Record<Platform, number>
    for (const pf of PLATFORMS) {
      const all = pages.filter((p) => p.platform === pf).reduce((s, p) => s + p.followers, 0)
      const mine = scopedPages.filter((p) => p.platform === pf).reduce((s, p) => s + p.followers, 0)
      out[pf] = all ? mine / all : 0
    }
    return out
  }, [scopedPages])

  const visiblePlatforms = PLATFORMS.filter((pf) => platformShare[pf] > 0)

  const chartData = useMemo(
    () =>
      engagement30d.slice(-RANGE_DAYS[range]).map((d) => ({
        day: d.day,
        facebook: Math.round(d.facebook * platformShare.facebook),
        instagram: Math.round(d.instagram * platformShare.instagram),
        threads: Math.round(d.threads * platformShare.threads),
      })),
    [range, platformShare],
  )

  const k = (RANGE_DAYS[range] / 30) * scopeShare
  const delta = DELTAS[range]

  const handoffs = conversations.filter((c) => c.state === 'handoff' && inScope([c.pageId]))
  const failedPosts = posts.filter((p) => p.status === 'failed' && inScope(p.pageIds))

  const upcoming = posts
    .filter((p) => (p.status === 'scheduled' || p.status === 'pending') && inScope(p.pageIds))
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
    .slice(0, 5)

  const activeCampaigns = activeOf(campaignList.data ?? [])

  const rangeLabel = RANGES.find((r) => r.id === range)!.label.toLowerCase()

  return (
    <Content>
      <PageHeader
        title="Tổng quan"
        subtitle={`${scopeLabel} · ${scopedPages.length} trang`}
        actions={<Segmented options={RANGES} value={range} onChange={setRange} />}
      />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiCard label="Lượt tiếp cận" value={formatNumber(Math.round(BASE_30D.reach * k))} delta={delta.reach} hint="so với kỳ trước" icon={<Eye size={16} />} />
        <KpiCard label="Tương tác" value={formatNumber(Math.round(BASE_30D.engagement * k))} delta={delta.engagement} hint="so với kỳ trước" icon={<Heart size={16} />} />
        <KpiCard
          label="Tin nhắn mới"
          value={formatNumber(Math.round(BASE_30D.messages * k))}
          delta={delta.messages}
          hint="AI đã trả lời 81%"
          icon={<MessageCircle size={16} />}
        />
        <KpiCard label="Người theo dõi mới" value={formatNumber(Math.round(BASE_30D.followers * k))} delta={delta.followers} hint="so với kỳ trước" icon={<UserPlus size={16} />} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title={`Tương tác ${rangeLabel}`} subtitle="Lượt thích, bình luận, chia sẻ theo nền tảng" />
          <div className="h-[280px] px-2 pt-4 pb-2">
            {visiblePlatforms.length === 0 ? (
              <EmptyState title="Chưa có dữ liệu trong phạm vi này">Chọn phạm vi khác ở thanh trên.</EmptyState>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#E2E8F0" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => compact(v)} />
                  <Tooltip contentStyle={{ borderRadius: 8, borderColor: '#E2E8F0', fontSize: 13 }} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13 }} />
                  {visiblePlatforms.map((pf) => (
                    <Line key={pf} type="monotone" dataKey={pf} name={platformLabel[pf]} stroke={platformColor[pf]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Cần bạn xử lý"
            subtitle={handoffs.length ? `${handoffs.length} tin nhắn cần bạn xử lý` : undefined}
            action={
              <Link to="/hop-thu" className="text-[13px] font-medium text-primary hover:underline">
                Mở hộp thư
              </Link>
            }
          />
          {handoffs.length === 0 && failedPosts.length === 0 ? (
            <EmptyState title="Không còn việc cần xử lý">AI đang trông giúp bạn.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {handoffs.map((c) => {
                const page = pageById(c.pageId)
                const contact = contactById(c.customerId)
                return (
                  <li key={c.id}>
                    <Link to={`/hop-thu?c=${c.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50">
                      <PageAvatar page={page} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{contact.name}</span>
                          <Chip tone="warning" icon={<Clock size={11} />}>
                            chờ {c.waiting}
                          </Chip>
                        </span>
                        <span className="block truncate text-[13px] text-muted-foreground">{c.lastMessage}</span>
                        {c.handoffReason && <span className="mt-0.5 block truncate text-xs text-muted-foreground">Lý do: {c.handoffReason}</span>}
                      </span>
                    </Link>
                  </li>
                )
              })}
              {failedPosts.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <img src={p.image} alt="" className="size-8 shrink-0 rounded-sm object-cover" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.title}</span>
                    <span className="block text-xs text-danger-foreground">Đăng bài lỗi · {whenLabel(p)}</span>
                  </span>
                  <Button size="sm" icon={<RotateCcw size={14} />} onClick={() => notify(`Đang đăng lại "${p.title}"`)}>
                    Đăng lại
                  </Button>
                </li>
              ))}
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                <th className="px-4 py-2 font-medium">Trang</th>
                <th className="px-4 py-2 font-medium">Nhóm</th>
                <th className="px-4 py-2 text-right font-medium">Người theo dõi</th>
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
                  <td className="tabular px-4 py-2.5 text-right">{formatNumber(p.followers)}</td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <StatusChip status={p.status} />
                      {needsReconnect(p.status) && (
                        // Tổng quan chỉ dẫn sang Trang & Nhóm — nơi kết nối lại đúng trang thật (PageDto).
                        <Link to="/trang-nhom" className="text-[13px] font-medium text-primary hover:underline">
                          Kết nối lại
                        </Link>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <Switch
                      ai
                      checked={autoReply[p.id]}
                      label={`AI trả lời cho ${p.name}`}
                      onChange={(v) => {
                        setAutoReply((s) => ({ ...s, [p.id]: v }))
                        notify(v ? `Đã bật AI trả lời cho ${p.name}` : `Đã tắt AI trả lời cho ${p.name}`)
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
          {upcoming.length === 0 ? (
            <EmptyState icon={<CalendarClock size={20} />} title="Chưa có bài nào sắp đăng" action={<Link to="/soan-bai" className="text-sm font-medium text-primary hover:underline">Tạo bài viết</Link>} />
          ) : (
            <ul className="divide-y divide-border">
              {upcoming.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <img src={p.image} alt="" className="size-12 shrink-0 rounded-md border border-border object-cover" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{p.title}</span>
                      {p.ai && <AiBadge />}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        {p.pageIds.map((id) => (
                          <PlatformIcon key={id} platform={pageById(id).platform} size={14} />
                        ))}
                      </span>
                      <span className="truncate">{p.pageIds.map((id) => pageById(id).name).join(', ')}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="tabular text-[13px] font-medium">{whenLabel(p)}</div>
                    <div className="mt-0.5">{p.status === 'pending' ? <Chip tone="warning">Chờ duyệt</Chip> : <Chip tone="primary">Đã lên lịch</Chip>}</div>
                  </div>
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
          {activeCampaigns.length === 0 ? (
            <EmptyState title="Chưa có chiến dịch nào" action={<Link to="/chien-dich/tao" className="text-sm font-medium text-primary hover:underline">Tạo chiến dịch</Link>}>
              Để AI tự đăng bài đều đặn cho trang của bạn.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {activeCampaigns.map((c) => {
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
                      <span>{running ? `Bài tiếp: ${nextPostLabel(c)}` : 'Đang tạm dừng'}</span>
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
