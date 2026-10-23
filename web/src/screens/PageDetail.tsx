import { ArrowLeft, CalendarDays, ExternalLink, Eye, Heart, PenLine, RefreshCw, TriangleAlert, Users } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Content } from '../components/AppShell'
import { BrandProfileForm } from '../components/BrandProfileForm'
import { AiBadge, Button, Card, CardHeader, Chip, EmptyState, GroupChip, KpiCard, PageAvatar, StatusChip, Tabs, platformColor, platformLabel } from '../components/ui'
import { compact, engagement30d, formatNumber, pages, posts, type Page, type Platform, type PostStatus } from '../data/mock'
import { ScreenSkeleton } from '../components/Skeleton'
import { useApp } from '../lib/app-context'
import { usePages } from '../lib/connections'
import { pageSubscriptionErrorOf, subscribeErrorLabel, useWebhookHealth } from '../lib/webhooks'
import { AutoReplyForm } from './AutoReply'

type TabId = 'brand' | 'ai' | 'schedule' | 'perf'
const TAB_IDS: TabId[] = ['brand', 'ai', 'schedule', 'perf']

const PROFILE_URL: Record<Platform, (h: string) => string> = {
  facebook: (h) => `https://facebook.com/${h}`,
  instagram: (h) => `https://instagram.com/${h}`,
  threads: (h) => `https://www.threads.net/@${h}`,
}

const POST_STATUS: Record<PostStatus, { label: string; tone: 'info' | 'warning' | 'danger' | 'neutral' | 'success' }> = {
  scheduled: { label: 'Đã lên lịch', tone: 'info' },
  pending: { label: 'Chờ duyệt', tone: 'warning' },
  failed: { label: 'Đăng lỗi', tone: 'danger' },
  draft: { label: 'Nháp', tone: 'neutral' },
  published: { label: 'Đã đăng', tone: 'success' },
}

const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

/** Chuỗi tương tác 30 ngày ước tính cho một trang: tỉ lệ theo người theo dõi trong cùng nền tảng. */
function pageSeries(page: Page) {
  const total = pages.filter((p) => p.platform === page.platform).reduce((s, p) => s + p.followers, 0) || page.followers
  const share = page.followers / total
  return engagement30d.map((d) => ({ day: d.day, value: Math.round(d[page.platform] * share) }))
}

export default function PageDetail() {
  const { id = '' } = useParams()
  // Trang thật nằm trong kho mẫu sau khi `usePages` tải xong (Story 2.2) — chờ trước khi báo không tìm thấy.
  const pagesQuery = usePages()
  const page = pages.find((p) => p.id === id)
  if (!page && pagesQuery.isPending) return <ScreenSkeleton />
  if (!page)
    return (
      <Content>
        <Card>
          <EmptyState
            title="Không tìm thấy trang"
            action={
              <Link to="/trang-nhom" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                <ArrowLeft size={15} /> Về Trang & Nhóm
              </Link>
            }
          >
            Trang này có thể đã bị ngắt kết nối hoặc đường dẫn không đúng.
          </EmptyState>
        </Card>
      </Content>
    )
  return <PageDetailView key={page.id} page={page} />
}

function PageDetailView({ page }: { page: Page }) {
  const { notify } = useApp()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const initial = params.get('tab') as TabId | null
  const [tab, setTabState] = useState<TabId>(initial && TAB_IDS.includes(initial) ? initial : 'brand')
  const [status, setStatus] = useState(page.status)
  // Story 4.2: trang đăng ký webhook lỗi → cảnh báo (tin nhắn của trang có thể không về Hộp thư).
  const webhookHealth = useWebhookHealth()
  const subscribeError = pageSubscriptionErrorOf(webhookHealth.data, page.id)

  const setTab = (t: TabId) => {
    setTabState(t)
    setParams(t === 'brand' ? {} : { tab: t }, { replace: true })
  }

  const reconnect = () => {
    page.status = 'active'
    setStatus('active')
    notify(`Đã kết nối lại ${page.name}`)
  }

  const upcoming = posts.filter((p) => p.pageIds.includes(page.id) && p.status !== 'published').sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
  const published = posts.filter((p) => p.pageIds.includes(page.id) && p.status === 'published')

  return (
    <Content>
      <nav className="mb-3 text-[13px] text-muted-foreground" aria-label="Breadcrumb">
        <Link to="/trang-nhom" className="hover:text-primary">
          Trang & Nhóm
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-foreground">{page.name}</span>
      </nav>

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <PageAvatar page={page} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[28px] leading-tight font-bold tracking-tight">{page.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
            <span>
              {platformLabel[page.platform]} · @{page.handle}
            </span>
            <GroupChip groupId={page.groupId} />
            <StatusChip status={status} />
            <span className="tabular">
              <b className="text-foreground">{formatNumber(page.followers)}</b> người theo dõi
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<ExternalLink size={15} />} onClick={() => window.open(PROFILE_URL[page.platform](page.handle), '_blank', 'noopener')}>
            Mở trên {platformLabel[page.platform]}
          </Button>
          {status !== 'active' && (
            <Button variant="primary" icon={<RefreshCw size={15} />} onClick={reconnect}>
              Kết nối lại
            </Button>
          )}
        </div>
      </div>

      {status !== 'active' && (
        <div className={`mb-5 flex items-center gap-2 rounded-md border px-4 py-3 text-sm ${status === 'expiring' ? 'border-amber-200 bg-warning-soft/60 text-amber-900' : 'border-red-200 bg-red-50 text-red-800'}`}>
          <TriangleAlert size={16} />
          {status === 'expiring'
            ? `Token ${platformLabel[page.platform]} sắp hết hạn trong 5 ngày. Chiến dịch vẫn chạy, nhưng hãy kết nối lại để không bị gián đoạn.`
            : `Mất kết nối với ${platformLabel[page.platform]}. Chiến dịch dùng trang này đã tự tạm dừng và AI không trả lời được tin nhắn.`}
          <button type="button" onClick={reconnect} className="ml-auto font-medium text-primary hover:underline">
            Kết nối lại
          </button>
        </div>
      )}

      {subscribeError && (
        <div role="alert" className="mb-5 flex items-center gap-2 rounded-md border border-amber-200 bg-warning-soft/60 px-4 py-3 text-sm text-amber-900">
          <TriangleAlert size={16} className="shrink-0" />
          <span>
            <b>Chưa đăng ký nhận tin nhắn cho trang này.</b> {subscribeErrorLabel(subscribeError.errorCode)}
          </span>
        </div>
      )}

      <Tabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'brand', label: 'Hồ sơ thương hiệu' },
          { id: 'ai', label: 'AI trả lời' },
          { id: 'schedule', label: 'Lịch đăng', count: upcoming.length },
          { id: 'perf', label: 'Hiệu suất' },
        ]}
      />

      {tab === 'brand' && <BrandProfileForm target={{ kind: 'page', id: page.id }} />}
      {tab === 'ai' && <AutoReplyForm target={{ kind: 'page', id: page.id }} />}

      {tab === 'schedule' && (
        <Card>
          <CardHeader
            title="Bài sắp đăng"
            subtitle={`${upcoming.length} bài cho trang này`}
            action={
              <div className="flex gap-2">
                <Link to="/lich" className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[13px] font-medium hover:bg-slate-50">
                  <CalendarDays size={15} /> Xem trên Lịch nội dung
                </Link>
                <Button size="sm" variant="primary" icon={<PenLine size={15} />} onClick={() => navigate('/soan-bai')}>
                  Tạo bài viết
                </Button>
              </div>
            }
          />
          {upcoming.length === 0 ? (
            <EmptyState icon={<CalendarDays size={22} />} title="Chưa có bài nào sắp đăng">
              Soạn bài bằng AI hoặc thêm trang này vào một chiến dịch nuôi page.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {upcoming.map((p) => {
                const d = new Date(`${p.date}T00:00:00`)
                const st = POST_STATUS[p.status]
                const others = p.pageIds.filter((x) => x !== page.id).map((x) => pages.find((pg) => pg.id === x)).filter((x): x is Page => !!x)
                return (
                  <li key={p.id} className="flex items-center gap-4 px-4 py-3">
                    <div className="w-12 shrink-0 text-center">
                      <div className="text-xs text-muted-foreground">{WEEKDAYS[d.getDay()]}</div>
                      <div className="text-lg leading-tight font-bold">{d.getDate()}</div>
                      <div className="text-xs text-muted-foreground">Th{d.getMonth() + 1}</div>
                    </div>
                    <img src={p.image} alt="" className="size-14 shrink-0 rounded-md border border-border object-cover" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{p.title}</span>
                        {p.ai && <AiBadge />}
                      </div>
                      <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{p.caption}</p>
                      {others.length > 0 && (
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                          Đăng cùng:
                          {others.map((o) => (
                            <PageAvatar key={o.id} page={o} size={16} />
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="tabular w-14 shrink-0 text-right text-sm font-medium">{p.time}</div>
                    <div className="w-28 shrink-0 text-right">
                      <Chip tone={st.tone}>{st.label}</Chip>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      )}

      {tab === 'perf' && <PagePerformance page={page} published={published} />}
    </Content>
  )
}

function PagePerformance({ page, published }: { page: Page; published: typeof posts }) {
  const series = pageSeries(page)
  const total = series.reduce((s, d) => s + d.value, 0)
  const firstHalf = series.slice(0, 15).reduce((s, d) => s + d.value, 0)
  const secondHalf = total - firstHalf
  const delta = firstHalf ? Math.round(((secondHalf - firstHalf) / firstHalf) * 100) : 0
  const reach = published.reduce((s, p) => s + (p.reach ?? 0), 0) || Math.round(page.followers * 1.8)
  const rate = ((total / Math.max(reach, 1)) * 100).toFixed(1).replace('.', ',')
  const color = platformColor[page.platform]

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-4">
        <KpiCard label="Người theo dõi" value={compact(page.followers)} delta={3} hint="so với 30 ngày trước" icon={<Users size={16} />} />
        <KpiCard label="Tiếp cận" value={compact(reach)} delta={12} hint="30 ngày" icon={<Eye size={16} />} />
        <KpiCard label="Tương tác" value={compact(total)} delta={delta} hint="15 ngày gần nhất" icon={<Heart size={16} />} />
        <KpiCard label="Tỷ lệ tương tác" value={`${rate}%`} delta={1} hint="trên lượt tiếp cận" />
      </div>

      <Card>
        <CardHeader title="Tương tác 30 ngày" subtitle={`Lượt thích, bình luận, chia sẻ trên ${platformLabel[page.platform]}`} />
        <div className="h-72 p-4">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
              <CartesianGrid stroke="#E2E8F0" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} interval={4} />
              <YAxis tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} width={44} />
              <Tooltip
                formatter={(v) => [formatNumber(Number(v)), 'Tương tác']}
                labelFormatter={(l) => `Ngày ${l}`}
                contentStyle={{ borderRadius: 8, border: '1px solid #E2E8F0', fontSize: 13 }}
              />
              <Line type="monotone" dataKey="value" name={platformLabel[page.platform]} stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card>
        <CardHeader title="Bài đã đăng gần đây" />
        {published.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">Chưa có bài nào được đăng trong 30 ngày qua.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
                <th className="px-4 py-2 font-medium">Bài viết</th>
                <th className="px-4 py-2 text-right font-medium">Tiếp cận</th>
                <th className="px-4 py-2 text-right font-medium">Tương tác</th>
              </tr>
            </thead>
            <tbody>
              {published.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-3">
                      <img src={p.image} alt="" className="size-9 rounded border border-border object-cover" />
                      <span className="font-medium">{p.title}</span>
                      {p.ai && <AiBadge />}
                    </span>
                  </td>
                  <td className="tabular px-4 py-2.5 text-right">{formatNumber(p.reach ?? 0)}</td>
                  <td className="tabular px-4 py-2.5 text-right">{formatNumber(p.engagement ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
