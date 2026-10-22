import { ArrowLeft, BotMessageSquare, FileText, Heart, Loader2, Pencil, Plus, Users, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Content } from '../components/AppShell'
import { BrandProfileForm } from '../components/BrandProfileForm'
import { Button, Card, CardHeader, Chip, EmptyState, KpiCard, Modal, PageAvatar, PageLabel, PlatformIcon, StatusChip, Tabs, cn, platformLabel } from '../components/ui'
import { compact, engagement30d, formatNumber, groups, pages, posts, type Group, type Page } from '../data/mock'
import { useApp } from '../lib/app-context'
import { uiPageOf, usePages } from '../lib/connections'
import { colorCodeOf, useAssignGroup, useGroups, useUnassignGroup, useUpdateGroup } from '../lib/groups'
import { errorMessageOf } from '../lib/error-messages'
import { AutoReplyForm } from './AutoReply'
import { PageChecklist } from './PagesGroups'

type TabId = 'brand' | 'ai' | 'members' | 'perf'

/** Dữ liệu mẫu: trang đang dùng cấu hình AI trả lời riêng. */
const AI_OWN = new Set(['p6'])
/** Dữ liệu mẫu: số tin nhắn AI đã trả lời 30 ngày theo trang. */
const AI_REPLIES: Record<string, number> = { p1: 412, p2: 288, p3: 64, p4: 530, p5: 97, p6: 0, p7: 0, p8: 0 }

function interactions30d(page: Page) {
  const total = pages.filter((p) => p.platform === page.platform).reduce((s, p) => s + p.followers, 0) || page.followers
  const share = page.followers / total
  return engagement30d.reduce((s, d) => s + Math.round(d[page.platform] * share), 0)
}

export default function GroupDetail() {
  const { id = '' } = useParams()
  // Nhóm thật từ API được chép vào kho mẫu; cũng vẽ lại khi trang thật đổi (Story 2.2, 2.5).
  const groupsQuery = useGroups()
  usePages()
  const group = groups.find((g) => g.id === id)
  if (!group && groupsQuery.isPending)
    return (
      <Content>
        <Card>
          <div className="px-4 py-8 text-center text-sm text-muted-foreground" role="status">
            <Loader2 size={16} className="mr-2 inline animate-spin" /> Đang tải nhóm…
          </div>
        </Card>
      </Content>
    )
  if (!group)
    return (
      <Content>
        <Card>
          <EmptyState
            title="Không tìm thấy nhóm"
            action={
              <Link to="/trang-nhom" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
                <ArrowLeft size={15} /> Về Trang & Nhóm
              </Link>
            }
          >
            Nhóm này có thể đã bị xoá hoặc đường dẫn không đúng.
          </EmptyState>
        </Card>
      </Content>
    )
  return <GroupDetailView key={group.id} group={group} />
}

function GroupDetailView({ group }: { group: Group }) {
  const { notify } = useApp()
  const pagesQuery = usePages()
  const updateGroupM = useUpdateGroup()
  const assignM = useAssignGroup()
  const unassignM = useUnassignGroup()
  const [name, setName] = useState(group.name)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(group.name)
  const [tab, setTab] = useState<TabId>('brand')
  const [adding, setAdding] = useState(false)
  const [picked, setPicked] = useState<string[]>([])

  // Thành viên lấy thẳng từ API (`groupId` của trang do server sở hữu); vẽ lại sau mỗi mutation (invalidate).
  const allPages: Page[] = (pagesQuery.data ?? []).map((dto) => ({ ...uiPageOf(dto), groupId: dto.groupId }))
  const members = allPages.filter((p) => p.groupId === group.id)
  const candidates = allPages.filter((p) => p.groupId !== group.id)
  const platforms = [...new Set(members.map((p) => p.platform))]

  /* Đổi tên nhóm qua API ([ASSUMPTION] cho phép trùng tên → không chặn). */
  const commitName = () => {
    const t = draft.trim()
    setEditing(false)
    if (!t || t === name) {
      setDraft(name)
      return
    }
    updateGroupM.mutate(
      { id: group.id, name: t, color: colorCodeOf(group.color) },
      {
        onSuccess: () => {
          setName(t)
          notify(`Đã đổi tên thành ${t}`)
        },
        onError: (err) => {
          setDraft(name)
          notify(errorMessageOf(err))
        },
      },
    )
  }

  const removeMember = (p: Page) => {
    unassignM.mutate(p.id, {
      onSuccess: () => notify(`Đã bỏ ${p.name} khỏi nhóm.`),
      onError: (err) => notify(errorMessageOf(err)),
    })
  }

  const addMembers = () => {
    assignM.mutate(
      { groupId: group.id, pageIds: picked },
      {
        onSuccess: (res) => {
          setAdding(false)
          notify(`Đã thêm ${res.changedPageIds.length} trang vào ${name}`)
          setPicked([])
        },
        onError: (err) => notify(errorMessageOf(err)),
      },
    )
  }

  return (
    <Content>
      <nav className="mb-3 text-[13px] text-muted-foreground" aria-label="Breadcrumb">
        <Link to="/trang-nhom" className="hover:text-primary">
          Trang & Nhóm
        </Link>
        <span className="mx-1.5">/</span>
        <span className="text-foreground">{name}</span>
      </nav>

      <div className="mb-5 flex flex-wrap items-start gap-4">
        <span className="mt-1 flex size-12 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${group.color}1F` }}>
          <span className="size-4 rounded-full" style={{ backgroundColor: group.color }} />
        </span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  setDraft(name)
                  setEditing(false)
                }
              }}
              aria-label="Tên nhóm"
              className="w-full max-w-lg rounded-md border border-primary bg-surface px-2 text-[28px] leading-tight font-bold tracking-tight focus:ring-2 focus:ring-primary/15 focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="group -mx-2 flex items-center gap-2 rounded-md px-2 text-left hover:bg-slate-100"
              title="Bấm để đổi tên"
            >
              <h1 className="text-[28px] leading-tight font-bold tracking-tight">{name}</h1>
              <Pencil size={16} className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          )}
          <p className="mt-1 flex items-center gap-1.5 text-[13px] text-muted-foreground">
            {members.length} trang · {platforms.length} nền tảng
            {platforms.map((pl) => (
              <PlatformIcon key={pl} platform={pl} size={14} />
            ))}
            <span className="mx-1">·</span>
            {group.activeCampaigns ? `${group.activeCampaigns} chiến dịch đang chạy` : 'Chưa có chiến dịch đang chạy'}
          </p>
        </div>
      </div>

      {/* Trang thành viên */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {members.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-2 rounded-full border border-border bg-surface py-1 pr-1.5 pl-1 text-[13px]">
            <PageAvatar page={p} size={24} />
            <Link to={`/trang-nhom/trang/${p.id}`} className="font-medium hover:text-primary">
              {p.name}
            </Link>
            <button
              type="button"
              onClick={() => removeMember(p)}
              disabled={unassignM.isPending}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-red-50 hover:text-danger disabled:opacity-50"
              aria-label={`Bỏ ${p.name} khỏi nhóm`}
            >
              <X size={14} />
            </button>
          </span>
        ))}
        {pagesQuery.isPending ? (
          <span className="text-[13px] text-muted-foreground" role="status">
            <Loader2 size={14} className="mr-1.5 inline animate-spin" /> Đang tải trang thành viên…
          </span>
        ) : pagesQuery.isError ? (
          <span className="text-[13px] text-danger">Chưa tải được danh sách trang — {errorMessageOf(pagesQuery.error)}</span>
        ) : (
          members.length === 0 && <span className="text-[13px] text-muted-foreground">Nhóm chưa có trang nào.</span>
        )}
        <Button size="sm" variant="ghost" icon={<Plus size={15} />} onClick={() => setAdding(true)}>
          Thêm trang
        </Button>
      </div>

      <Tabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'brand', label: 'Hồ sơ thương hiệu' },
          { id: 'ai', label: 'AI trả lời' },
          { id: 'members', label: 'Trang thành viên', count: members.length },
          { id: 'perf', label: 'Hiệu suất' },
        ]}
      />

      {tab === 'brand' && <BrandProfileForm target={{ kind: 'group', id: group.id }} />}
      {tab === 'ai' && <AutoReplyForm target={{ kind: 'group', id: group.id }} />}
      {tab === 'members' && <MembersTable members={members} groupName={name} onAdd={() => setAdding(true)} />}
      {tab === 'perf' && <GroupPerformance members={members} />}

      <Modal
        open={adding}
        onClose={() => {
          setAdding(false)
          setPicked([])
        }}
        title={`Thêm trang vào ${name}`}
        width={560}
        footer={
          <>
            <Button
              onClick={() => {
                setAdding(false)
                setPicked([])
              }}
            >
              Huỷ
            </Button>
            <Button variant="primary" disabled={!picked.length || assignM.isPending} onClick={addMembers}>
              Thêm {picked.length || ''} trang
            </Button>
          </>
        }
      >
        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">Mọi trang đã ở trong nhóm này.</p>
        ) : (
          <>
            <p className="mb-3 text-[13px] text-muted-foreground">Mỗi trang chỉ thuộc một nhóm. Trang mới vào sẽ dùng hồ sơ thương hiệu và AI trả lời của nhóm.</p>
            <PageChecklist pages={candidates} picked={picked} setPicked={setPicked} targetGroupId={group.id} />
          </>
        )}
      </Modal>
    </Content>
  )
}

/* ---------- Trang thành viên ---------- */

function SourceCell({ own, pageId, tab }: { own: boolean; pageId: string; tab: 'brand' | 'ai' }) {
  return (
    <div className="flex items-center gap-2">
      {own ? <Chip>Riêng</Chip> : <Chip tone="primary">Theo nhóm</Chip>}
      <Link to={`/trang-nhom/trang/${pageId}${tab === 'ai' ? '?tab=ai' : ''}`} className="text-[13px] font-medium whitespace-nowrap text-primary hover:underline">
        {own ? 'Xem cấu hình riêng' : 'Ghi đè'}
      </Link>
    </div>
  )
}

function MembersTable({ members, groupName, onAdd }: { members: Page[]; groupName: string; onAdd: () => void }) {
  if (!members.length)
    return (
      <Card>
        <EmptyState
          icon={<Users size={22} />}
          title="Nhóm chưa có trang"
          action={
            <Button variant="primary" icon={<Plus size={16} />} onClick={onAdd}>
              Thêm trang
            </Button>
          }
        >
          Thêm trang để dùng chung hồ sơ thương hiệu và AI trả lời của {groupName}.
        </EmptyState>
      </Card>
    )
  const ownBrand = members.filter((p) => p.brandSource === 'own').length
  const ownAi = members.filter((p) => AI_OWN.has(p.id)).length
  return (
    <Card>
      <CardHeader
        title="Cấu hình từng trang"
        subtitle={`${members.length - ownBrand}/${members.length} trang dùng hồ sơ nhóm · ${members.length - ownAi}/${members.length} trang dùng AI trả lời của nhóm`}
      />
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[13px] text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">Trang</th>
            <th className="px-3 py-2.5 font-medium">Trạng thái</th>
            <th className="px-3 py-2.5 font-medium">Hồ sơ thương hiệu</th>
            <th className="px-3 py-2.5 font-medium">Cấu hình AI trả lời</th>
            <th className="px-3 py-2.5 font-medium">AI trả lời</th>
          </tr>
        </thead>
        <tbody>
          {members.map((p) => (
            <tr key={p.id} className="border-b border-border last:border-b-0 hover:bg-slate-50/70">
              <td className="px-4 py-2.5">
                <Link to={`/trang-nhom/trang/${p.id}`} className="block hover:text-primary">
                  <PageLabel page={p} sub={`${platformLabel[p.platform]} · ${formatNumber(p.followers)} người theo dõi`} />
                </Link>
              </td>
              <td className="px-3 py-2.5">
                <StatusChip status={p.status} />
              </td>
              <td className="px-3 py-2.5">
                <SourceCell own={p.brandSource === 'own'} pageId={p.id} tab="brand" />
              </td>
              <td className="px-3 py-2.5">
                <SourceCell own={AI_OWN.has(p.id)} pageId={p.id} tab="ai" />
              </td>
              <td className="px-3 py-2.5">{p.autoReply ? <Chip tone="ai">Đang bật</Chip> : <Chip>Đang tắt</Chip>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

/* ---------- Hiệu suất nhóm ---------- */

function GroupPerformance({ members }: { members: Page[] }) {
  if (!members.length)
    return (
      <Card>
        <EmptyState title="Chưa có số liệu">Thêm trang vào nhóm để xem hiệu suất tổng hợp.</EmptyState>
      </Card>
    )
  const ids = new Set(members.map((p) => p.id))
  const followers = members.reduce((s, p) => s + p.followers, 0)
  const rows = members.map((p) => ({ name: p.name, page: p, value: interactions30d(p) })).sort((a, b) => b.value - a.value)
  const totalInteractions = rows.reduce((s, r) => s + r.value, 0)
  const aiReplies = members.reduce((s, p) => s + (AI_REPLIES[p.id] ?? 0), 0)
  const publishedCount = posts.filter((p) => p.status === 'published' && p.pageIds.some((x) => ids.has(x))).length
  const max = rows[0]?.value ?? 1

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-4">
        <KpiCard label="Tổng người theo dõi" value={compact(followers)} delta={4} hint="so với 30 ngày trước" icon={<Users size={16} />} />
        <KpiCard label="Tương tác 30 ngày" value={compact(totalInteractions)} delta={9} hint="cộng dồn các trang" icon={<Heart size={16} />} />
        <KpiCard label="Tin nhắn AI đã trả lời" value={formatNumber(aiReplies)} delta={14} hint="30 ngày" icon={<BotMessageSquare size={16} className="text-ai" />} />
        <KpiCard label="Bài đã đăng" value={String(publishedCount)} hint="tuần này" icon={<FileText size={16} />} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-5">
        <Card>
          <CardHeader title="So sánh tương tác theo trang" subtitle="30 ngày gần nhất" />
          <div className="p-4" style={{ height: Math.max(200, rows.length * 52 + 40) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 0 }} barCategoryGap={12}>
                <CartesianGrid stroke="#E2E8F0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 12, fill: '#64748B' }} tickLine={false} axisLine={false} tickFormatter={(v: number) => compact(v)} />
                <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 13, fill: '#0F172A' }} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: '#F1F5F9' }}
                  formatter={(v) => [formatNumber(Number(v)), 'Tương tác']}
                  contentStyle={{ borderRadius: 8, border: '1px solid #E2E8F0', fontSize: 13 }}
                />
                <Bar dataKey="value" fill="#0F766E" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHeader title="Chi tiết từng trang" />
          <ul className="divide-y divide-border">
            {rows.map((r, i) => (
              <li key={r.page.id} className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span className={cn('w-4 text-xs font-semibold', i === 0 ? 'text-primary' : 'text-muted-foreground')}>{i + 1}</span>
                  <PageAvatar page={r.page} size={26} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.name}</span>
                  <span className="tabular text-[13px] font-semibold">{compact(r.value)}</span>
                </div>
                <div className="mt-2 ml-6 h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(r.value / max) * 100}%` }} />
                </div>
                <div className="mt-1 ml-6 flex justify-between text-xs text-muted-foreground">
                  <span>{Math.round((r.value / Math.max(totalInteractions, 1)) * 100)}% của nhóm</span>
                  <span>{formatNumber(AI_REPLIES[r.page.id] ?? 0)} tin AI trả lời</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
