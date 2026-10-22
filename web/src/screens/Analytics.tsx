import { ArrowDown, ArrowUp, Bot, Download, Eye, Heart, MessageCircle, Percent, Timer, UserPlus, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AiLockHint } from '../components/AiLockHint'
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Content } from '../components/AppShell'
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
import { compact, engagement30d, formatNumber, pageById, pages, posts, type Page, type Platform } from '../data/mock'
import { useApp } from '../lib/app-context'

type Range = '7d' | '30d' | '90d'

const RANGES: { id: Range; label: string }[] = [
  { id: '7d', label: '7 ngày' },
  { id: '30d', label: '30 ngày' },
  { id: '90d', label: '90 ngày' },
]
const RANGE_FACTOR: Record<Range, number> = { '7d': 7 / 30, '30d': 1, '90d': 2.8 }
const RANGE_DAYS: Record<Range, number> = { '7d': 7, '30d': 30, '90d': 30 }

const PLATFORMS: Platform[] = ['facebook', 'instagram', 'threads']

const BASE_30D = { reach: 486_200, engagement: 38_940, followers: 3_420, messages: 1_126 }
const DELTAS: Record<Range, { reach: number; engagement: number; rate: number; followers: number; messages: number }> = {
  '7d': { reach: 6.2, engagement: 9.8, rate: 3.4, followers: 4.3, messages: 14.1 },
  '30d': { reach: 12.4, engagement: 18.2, rate: 5.1, followers: -3.1, messages: 22.6 },
  '90d': { reach: 31.0, engagement: 42.7, rate: 8.9, followers: 12.5, messages: 37.2 },
}

/* ---------- Số liệu mẫu theo từng trang (tất định theo id trang) ---------- */

function seed(id: string) {
  return [...id].reduce((s, ch) => s + ch.charCodeAt(0) * 7, 0)
}

function pageStats(p: Page, factor: number) {
  const s = seed(p.id)
  const reach = Math.round(p.followers * (1.4 + (s % 9) / 10) * factor)
  const rate = p.status === 'disconnected' ? 3.1 : 5 + ((s * 13) % 50) / 10
  const engagement = Math.round((reach * rate) / 100)
  const postCount = Math.max(1, Math.round((8 + (s % 14)) * factor))
  const trend = Array.from({ length: 12 }, (_, i) => ({ v: Math.round(40 + i * (2 + (s % 4)) + Math.sin(i / 1.6 + s) * 12) }))
  return { reach, engagement, rate, posts: postCount, trend }
}

type SortKey = 'followers' | 'reach' | 'engagement' | 'rate' | 'posts'

/* ---------- Heatmap giờ đăng ---------- */

const DAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']
const DAY_NAMES = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ nhật']

function heat(day: number, hour: number) {
  const bump = (h: number, c: number, w: number) => Math.exp(-((h - c) ** 2) / (2 * w * w))
  const base = 0.06 + 0.45 * bump(hour, 11.5, 1.3) + 0.95 * bump(hour, 20, 1.6) + 0.25 * bump(hour, 7.5, 1)
  const weekend = day >= 5 ? 1.15 : 1
  const night = hour < 6 ? 0.25 : 1
  return Math.min(1, base * weekend * night)
}

export default function Analytics() {
  const { scopedPages, scopeLabel, inScope, notify, openAiKeySet } = useApp()
  const navigate = useNavigate()
  const [range, setRange] = useState<Range>('30d')
  const [compare, setCompare] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>('engagement')
  const [sortAsc, setSortAsc] = useState(false)

  const factor = RANGE_FACTOR[range]

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

  const chartData = useMemo(() => {
    const mult = range === '90d' ? 3 : 1
    return engagement30d.slice(-RANGE_DAYS[range]).map((d, i) => {
      const fb = Math.round(d.facebook * platformShare.facebook * mult)
      const ig = Math.round(d.instagram * platformShare.instagram * mult)
      const th = Math.round(d.threads * platformShare.threads * mult)
      const label = range === '90d' ? `Tuần ${Math.floor(i / 7) + 1}` : d.day
      return { day: label, facebook: fb, instagram: ig, threads: th, previous: Math.round((fb + ig + th) * (0.82 + Math.sin(i / 2.5) * 0.06)) }
    })
  }, [range, platformShare])

  const k = factor * scopeShare
  const d = DELTAS[range]
  const reach = Math.round(BASE_30D.reach * k)
  const engagement = Math.round(BASE_30D.engagement * k)
  const rate = reach ? (engagement / reach) * 100 : 0

  const rows = useMemo(() => {
    const list = scopedPages.map((p) => ({ page: p, followers: p.followers, ...pageStats(p, factor) }))
    return list.sort((a, b) => (sortAsc ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey]))
  }, [scopedPages, factor, sortKey, sortAsc])

  const topPosts = posts
    .filter((p) => p.status === 'published' && inScope(p.pageIds))
    .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0))

  const aiVsHuman = [
    { name: 'Bài AI tạo', value: 1840 },
    { name: 'Bài tự viết', value: 1310 },
  ]

  const best = useMemo(() => {
    let top = { day: 0, hour: 0, v: 0 }
    for (let day = 0; day < 7; day++) for (let hour = 0; hour < 24; hour++) if (heat(day, hour) > top.v) top = { day, hour, v: heat(day, hour) }
    return top
  }, [])

  const sortBy = (key: SortKey) => {
    if (key === sortKey) setSortAsc((v) => !v)
    else {
      setSortKey(key)
      setSortAsc(false)
    }
  }

  const SortHead = ({ id, label }: { id: SortKey; label: string }) => (
    <th className="px-4 py-2 text-right font-medium">
      <button onClick={() => sortBy(id)} className={cn('inline-flex items-center gap-1 hover:text-foreground', sortKey === id && 'text-foreground')}>
        {label}
        {sortKey === id && (sortAsc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  )

  const rangeLabel = RANGES.find((r) => r.id === range)!.label

  return (
    <Content>
      <PageHeader
        title="Hiệu suất"
        subtitle={`${scopeLabel} · ${rangeLabel.toLowerCase()} gần nhất`}
        actions={
          <>
            <Segmented options={RANGES} value={range} onChange={setRange} />
            <label className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] font-medium">
              <Switch checked={compare} onChange={setCompare} label="So với kỳ trước" />
              So với kỳ trước
            </label>
            <Button variant="primary" icon={<Download size={15} />} onClick={() => notify(`Đang xuất báo cáo ${rangeLabel.toLowerCase()} · ${scopeLabel}`)}>
              Xuất báo cáo
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Lượt tiếp cận" value={formatNumber(reach)} delta={compare ? d.reach : undefined} icon={<Eye size={16} />} />
        <KpiCard label="Tương tác" value={formatNumber(engagement)} delta={compare ? d.engagement : undefined} icon={<Heart size={16} />} />
        <KpiCard
          label="Tỉ lệ tương tác"
          value={`${rate.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`}
          delta={compare ? d.rate : undefined}
          icon={<Percent size={16} />}
        />
        <KpiCard label="Người theo dõi mới" value={formatNumber(Math.round(BASE_30D.followers * k))} delta={compare ? d.followers : undefined} icon={<UserPlus size={16} />} />
        <KpiCard label="Tin nhắn" value={formatNumber(Math.round(BASE_30D.messages * k))} delta={compare ? d.messages : undefined} icon={<MessageCircle size={16} />} />
      </div>

      <Card className="mt-6">
        <CardHeader title="Tương tác theo nền tảng" subtitle={compare ? 'Đường nét đứt: tổng tương tác kỳ trước' : 'Cộng dồn Facebook, Instagram, Threads'} />
        <div className="h-[300px] px-2 pt-4 pb-2">
          {visiblePlatforms.length === 0 ? (
            <EmptyState title="Chưa có dữ liệu trong phạm vi này">Chọn phạm vi khác ở thanh trên.</EmptyState>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#E2E8F0" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
                <YAxis tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => compact(v)} />
                <Tooltip contentStyle={{ borderRadius: 8, borderColor: '#E2E8F0', fontSize: 13 }} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13 }} />
                {visiblePlatforms.map((pf) => (
                  <Area
                    key={pf}
                    type="monotone"
                    dataKey={pf}
                    name={platformLabel[pf]}
                    stackId="1"
                    stroke={platformColor[pf]}
                    fill={platformColor[pf]}
                    fillOpacity={0.18}
                    strokeWidth={1.5}
                  />
                ))}
                {compare && <Line type="monotone" dataKey="previous" name="Kỳ trước" stroke="#94A3B8" strokeDasharray="5 4" strokeWidth={1.5} dot={false} />}
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
                <SortHead id="followers" label="Người theo dõi" />
                <SortHead id="reach" label="Tiếp cận" />
                <SortHead id="engagement" label="Tương tác" />
                <SortHead id="rate" label="Tỉ lệ" />
                <SortHead id="posts" label="Bài đăng" />
                <th className="px-4 py-2 font-medium">Xu hướng</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.page.id} className="cursor-pointer hover:bg-slate-50" onClick={() => navigate(`/trang-nhom/trang/${r.page.id}`)}>
                  <td className="px-4 py-2.5">
                    <PageLabel page={r.page} />
                  </td>
                  <td className="px-4 py-2.5">
                    <GroupChip groupId={r.page.groupId} size="sm" />
                  </td>
                  <td className="tabular px-4 py-2.5 text-right">{formatNumber(r.followers)}</td>
                  <td className="tabular px-4 py-2.5 text-right">{formatNumber(r.reach)}</td>
                  <td className="tabular px-4 py-2.5 text-right">{formatNumber(r.engagement)}</td>
                  <td className="tabular px-4 py-2.5 text-right">{r.rate.toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%</td>
                  <td className="tabular px-4 py-2.5 text-right">{r.posts}</td>
                  <td className="px-4 py-2.5">
                    <div className="h-7 w-24">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={r.trend}>
                          <Line type="monotone" dataKey="v" stroke={platformColor[r.page.platform]} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <EmptyState title="Không có trang nào trong phạm vi này" />}
        </div>
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card className="border-ai/25">
          <CardHeader title={<span className="flex items-center gap-2"><Bot size={17} className="text-ai" />Hiệu quả AI</span>} subtitle="Những gì AI đã làm thay bạn trong kỳ này" />
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
                <BarChart data={aiVsHuman} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={14}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" width={92} tick={{ fontSize: 13, fill: '#0F172A' }} tickLine={false} axisLine={false} />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]} isAnimationActive={false}>
                    {aiVsHuman.map((row, i) => (
                      <Cell key={row.name} fill={i === 0 ? '#7C3AED' : '#CBD5E1'} />
                    ))}
                    <LabelList dataKey="value" position="right" style={{ fontSize: 13, fill: '#0F172A' }} formatter={(v) => formatNumber(Number(v))} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Bài hiệu quả nhất" subtitle="Xếp theo tương tác" />
          {topPosts.length === 0 ? (
            <EmptyState title="Chưa có bài đã đăng trong phạm vi này">Đăng bài đầu tiên để xem hiệu quả ở đây.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {topPosts.map((p, i) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="tabular w-4 text-center text-sm font-semibold text-muted-foreground">{i + 1}</span>
                  <img src={p.image} alt="" className="size-14 shrink-0 rounded-md border border-border object-cover" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{p.title}</span>
                      {p.ai && <AiBadge />}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      {p.pageIds.map((id) => (
                        <PlatformIcon key={id} platform={pageById(id).platform} size={13} />
                      ))}
                      <span className="ml-1 truncate">{p.pageIds.map((id) => pageById(id).name).join(', ')}</span>
                    </div>
                    <div className="tabular mt-1 flex gap-3 text-xs">
                      <span className="flex items-center gap-1">
                        <Eye size={12} className="text-muted-foreground" /> {formatNumber(p.reach ?? 0)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Heart size={12} className="text-muted-foreground" /> {formatNumber(p.engagement ?? 0)}
                      </span>
                      <span className="text-muted-foreground">{(((p.engagement ?? 0) / (p.reach || 1)) * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%</span>
                    </div>
                  </div>
                  <AiLockHint locked={!openAiKeySet} align="end">
                    <Button variant="ai" size="sm" disabled={!openAiKeySet} onClick={() => navigate(`/soan-bai?idea=${encodeURIComponent(p.title)}`)}>
                      Tạo bài tương tự
                    </Button>
                  </AiLockHint>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Giờ đăng tốt nhất"
          subtitle={`Tương tác cao nhất vào ${DAY_NAMES[best.day]}, ${best.hour}:00–${best.hour + 1}:00`}
          action={
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              Ít
              <span className="flex">
                {[0.1, 0.3, 0.5, 0.7, 0.9].map((a) => (
                  <span key={a} className="size-3" style={{ backgroundColor: `rgba(15,118,110,${a})` }} />
                ))}
              </span>
              Nhiều
            </span>
          }
        />
        <div className="overflow-x-auto p-4">
          <div className="grid min-w-[720px] gap-[3px]" style={{ gridTemplateColumns: '32px repeat(24, minmax(0, 1fr))' }}>
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="text-center text-[10px] text-muted-foreground">
                {h % 3 === 0 ? `${h}h` : ''}
              </span>
            ))}
            {DAYS.map((day, di) => (
              <div key={day} className="contents">
                <span className="flex items-center text-xs font-medium text-muted-foreground">{day}</span>
                {Array.from({ length: 24 }, (_, h) => {
                  const v = heat(di, h)
                  const isBest = di === best.day && h === best.hour
                  return (
                    <span
                      key={h}
                      title={`${DAY_NAMES[di]} ${h}:00 · mức tương tác ${Math.round(v * 100)}/100`}
                      className={cn('h-6 rounded-[3px]', isBest && 'ring-2 ring-primary ring-offset-1')}
                      style={{ backgroundColor: `rgba(15,118,110,${(0.05 + v * 0.9).toFixed(2)})` }}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </Card>
    </Content>
  )
}
