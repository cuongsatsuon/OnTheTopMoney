import { ArrowLeft, ArrowRight, Check, ImageOff, MessageCircleHeart, Pencil, Plus, Rocket, ShieldCheck, ShoppingBag, Sparkles, Trash2, UserPlus, X, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AiLockHint } from '../components/AiLockHint'
import { Content } from '../components/AppShell'
import {
  AiBadge,
  Button,
  Card,
  CardHeader,
  Chip,
  Field,
  GroupChip,
  Input,
  PageAvatar,
  PageHeader,
  PageLabel,
  Segmented,
  Select,
  StatusChip,
  Textarea,
  cn,
} from '../components/ui'
import { groups, pageById, pages, pagesInGroup, type Page } from '../data/mock'
import { useApp } from '../lib/app-context'

/* ---------- Cấu hình ---------- */

type GoalId = 'engage' | 'follow' | 'sell' | 'launch'
type Topic = { name: string; share: number }

const GOALS: { id: GoalId; label: string; desc: string; icon: ReactNode; topics: Topic[] }[] = [
  {
    id: 'engage',
    label: 'Tăng tương tác',
    desc: 'Bài mẹo, hỏi đáp để khách bình luận, chia sẻ nhiều hơn.',
    icon: <MessageCircleHeart size={20} />,
    topics: [
      { name: 'Mẹo hay', share: 40 },
      { name: 'Review sản phẩm', share: 30 },
      { name: 'Hỏi đáp', share: 20 },
      { name: 'Hậu trường', share: 10 },
    ],
  },
  {
    id: 'follow',
    label: 'Tăng người theo dõi',
    desc: 'Nội dung đều đặn, dễ chia sẻ để trang mới lớn nhanh.',
    icon: <UserPlus size={20} />,
    topics: [
      { name: 'Mẹo hay', share: 50 },
      { name: 'Xu hướng', share: 30 },
      { name: 'Hậu trường', share: 20 },
    ],
  },
  {
    id: 'sell',
    label: 'Bán hàng',
    desc: 'Giới thiệu sản phẩm, ưu đãi và phản hồi khách để chốt đơn.',
    icon: <ShoppingBag size={20} />,
    topics: [
      { name: 'Khuyến mãi', share: 50 },
      { name: 'Review sản phẩm', share: 30 },
      { name: 'Feedback khách', share: 20 },
    ],
  },
  {
    id: 'launch',
    label: 'Ra mắt sản phẩm',
    desc: 'Chuỗi teaser → ra mắt → review cho sản phẩm mới.',
    icon: <Rocket size={20} />,
    topics: [
      { name: 'Teaser', share: 30 },
      { name: 'Ra mắt', share: 40 },
      { name: 'Review sản phẩm', share: 30 },
    ],
  },
]

const TOPIC_SUGGESTIONS = ['Mẹo hay', 'Review sản phẩm', 'Hỏi đáp', 'Hậu trường', 'Khuyến mãi', 'Feedback khách', 'Xu hướng', 'Mini game']
const FREQS = ['3 bài/tuần', '1 bài/ngày', '2 bài/ngày', '3 bài/ngày']
const DEFAULT_LABEL = 'Theo mặc định'
const COST_PER_POST = 700
const STEPS = ['Mục tiêu', 'Trang đích', 'Nội dung & lịch', 'Duyệt']

const CONTENT_POOL: Record<string, string[]> = {
  'g-beauty': [
    '3 bước dưỡng ẩm buổi sáng cho da dầu — nhẹ mặt mà vẫn căng mịn cả ngày 💧',
    'Kem chống nắng nên bôi lại sau mỗi 2–3 giờ, kể cả khi ngồi văn phòng nha ☀️',
    'Serum vitamin C dùng sáng hay tối? Câu trả lời ở đây 👇',
    'Thứ tự skincare chuẩn: làm sạch → toner → serum → kem dưỡng → chống nắng ✨',
  ],
  'g-home': [
    'Khử mùi tủ lạnh chỉ với 1 lát chanh và baking soda 🍋',
    'Lót giấy nến cho nồi chiên không dầu để vệ sinh nhanh gấp đôi 🍗',
    'Làm sạch bếp sau khi nấu chỉ trong 5 phút 🧽',
    '5 món ăn sáng 10 phút cho ngày bận rộn 🍳',
  ],
  other: [
    '3 cách phối áo len cho ngày se lạnh 🍂',
    'Tủ đồ tối giản: 5 món cơ bản ai cũng nên có 👗',
    'Giặt áo len không bị xù: lộn trái và giặt nước lạnh 🧥',
    'Phối màu be – nâu cho mùa thu thêm ấm áp 🤎',
  ],
}

const pad = (n: number) => String(n).padStart(2, '0')
const fromIso = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const ddmm = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']

function postsPerDay(freq: string, dayIndex: number) {
  if (freq === '3 bài/tuần') return [0, 2, 4].includes(dayIndex % 7) ? 1 : 0
  return parseInt(freq, 10) || 0
}

interface DraftPost {
  id: string
  pageId: string
  date: string
  time: string
  topic: string
  caption: string
  image?: string
  variant: number
}

function writeDraft(page: Page, topic: string, variant: number) {
  const pool = CONTENT_POOL[page.groupId ?? ''] ?? CONTENT_POOL.other
  const line = pool[(variant + page.id.length) % pool.length]
  const tail =
    page.platform === 'threads'
      ? 'Bạn thấy sao? Trả lời mình nhé 👀'
      : page.platform === 'instagram'
        ? `Lưu lại để dùng dần nha! #${page.handle.replace(/[^a-z0-9]/gi, '')}`
        : `Bình luận “Có” để ${page.name} gửi thêm mẹo cho bạn nhé!`
  return `${topic} · ${line}\n\n${tail}`
}

/* ---------- Màn hình ---------- */

export default function CampaignWizard() {
  const { notify, openAiKeySet } = useApp()
  const navigate = useNavigate()

  const [step, setStep] = useState(1)
  const [maxStep, setMaxStep] = useState(1)

  // Bước 1
  const [goal, setGoal] = useState<GoalId>('engage')
  const [duration, setDuration] = useState<'7' | '14' | '30'>('30')
  const [start, setStart] = useState('2026-10-20')

  // Bước 2
  const [targetMode, setTargetMode] = useState<'group' | 'pages'>('group')
  const [groupId, setGroupId] = useState('g-beauty')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(['p3']))
  const [defaultFreq, setDefaultFreq] = useState('1 bài/ngày')
  const [overrides, setOverrides] = useState<Record<string, string>>({})

  // Bước 3
  const [name, setName] = useState('')
  const [topics, setTopics] = useState<Topic[]>(GOALS[0].topics)
  const [topicsTouched, setTopicsTouched] = useState(false)
  const [newTopic, setNewTopic] = useState('')
  const [times, setTimes] = useState<string[]>(['11:30', '19:30'])
  const [newTime, setNewTime] = useState('08:00')
  const [imagePct, setImagePct] = useState(70)
  const [mode, setMode] = useState<'review' | 'auto'>('review')

  // Bước 4
  const [drafts, setDrafts] = useState<DraftPost[] | null>(null)
  const [generating, setGenerating] = useState(false)
  const [regen, setRegen] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), [])
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms))

  const goalInfo = GOALS.find((g) => g.id === goal)!
  const days = Number(duration)
  const startDate = fromIso(start)
  const endDate = addDays(startDate, days - 1)

  const targetPages = targetMode === 'group' ? pagesInGroup(groupId) : pages.filter((p) => picked.has(p.id))
  const activePages = targetPages.filter((p) => p.status !== 'disconnected')
  const skipped = targetPages.length - activePages.length
  const freqOf = (p: Page) => overrides[p.id] ?? defaultFreq
  const slotCap = Math.max(1, times.length)
  const slotsOn = (p: Page, d: number) => Math.min(postsPerDay(freqOf(p), d), slotCap)

  const perDay = useMemo(
    () =>
      Array.from({ length: 30 }, (_, i) =>
        i < days ? activePages.reduce((n, p) => n + Math.min(postsPerDay(overrides[p.id] ?? defaultFreq, i), slotCap), 0) : -1,
      ),
    [days, activePages, overrides, defaultFreq, slotCap],
  )
  const totalPosts = perDay.reduce((n, v) => n + Math.max(0, v), 0)
  const maxPerDay = Math.max(1, ...perDay)
  const cost = totalPosts * COST_PER_POST

  const topicSum = topics.reduce((n, t) => n + (Number.isFinite(t.share) ? t.share : 0), 0)
  const autoName = `${targetMode === 'group' ? groups.find((g) => g.id === groupId)?.name.replace('Nhóm ', '') : activePages[0]?.name ?? 'Trang'} – ${goalInfo.label.toLowerCase()} ${days} ngày`
  const campaignName = name.trim() || autoName

  const stepValid = (s: number) => {
    if (s === 2) return activePages.length > 0
    if (s === 3) return campaignName.length > 0 && topics.length > 0 && topicSum === 100 && times.length > 0
    if (s === 4) return !generating && !!drafts
    return true
  }

  /* --- Hành động --- */
  const chooseGoal = (id: GoalId) => {
    setGoal(id)
    if (!topicsTouched) setTopics(GOALS.find((g) => g.id === id)!.topics)
  }
  const editTopics = (fn: (t: Topic[]) => Topic[]) => {
    setTopicsTouched(true)
    setTopics(fn)
  }
  const addTopic = (label: string) => {
    const t = label.trim()
    if (!t || topics.some((x) => x.name.toLowerCase() === t.toLowerCase())) return
    editTopics((all) => [...all, { name: t, share: 0 }])
    setNewTopic('')
  }
  const splitEven = () =>
    editTopics((all) => {
      const base = Math.floor(100 / all.length)
      return all.map((t, i) => ({ ...t, share: base + (i < 100 - base * all.length ? 1 : 0) }))
    })
  const addTime = () => {
    if (!newTime || times.includes(newTime)) return
    setTimes((t) => [...t, newTime].sort())
  }

  function buildDrafts(): DraftPost[] {
    const sortedTimes = [...times].sort()
    const weighted = topics.flatMap((t) => Array.from({ length: Math.max(1, Math.round(t.share / 10)) }, () => t.name))
    const out: DraftPost[] = []
    for (let d = 0; d < days && out.length < 7; d++) {
      sortedTimes.forEach((tm, ti) => {
        activePages.forEach((p) => {
          if (out.length >= 7 || ti >= slotsOn(p, d)) return
          const k = out.length
          const topic = weighted[(k * 3) % weighted.length]
          out.push({
            id: `d${k}-${Date.now() % 10000}`,
            pageId: p.id,
            date: toIso(addDays(startDate, d)),
            time: tm,
            topic,
            caption: writeDraft(p, topic, k),
            image: (k * 37) % 100 < imagePct ? `https://picsum.photos/seed/camp${p.id}${k}${start}/600/600` : undefined,
            variant: k,
          })
        })
      })
    }
    return out
  }

  function generateDrafts() {
    setGenerating(true)
    setDrafts(null)
    later(() => {
      setDrafts(buildDrafts())
      setGenerating(false)
      notify('AI đã tạo 7 bài đầu — xem và sửa trước khi bắt đầu')
    }, 1800)
  }

  function regenerateOne(d: DraftPost) {
    setRegen((s) => new Set(s).add(d.id))
    later(() => {
      setDrafts((all) =>
        (all ?? []).map((x) =>
          x.id === d.id
            ? {
                ...x,
                variant: x.variant + 1,
                caption: writeDraft(pageById(x.pageId), x.topic, x.variant + 1),
                image: x.image ? `https://picsum.photos/seed/camp${x.id}v${x.variant + 1}/600/600` : undefined,
              }
            : x,
        ),
      )
      setRegen((s) => {
        const n = new Set(s)
        n.delete(d.id)
        return n
      })
    }, 1100)
  }

  const goTo = (s: number) => {
    setStep(s)
    setMaxStep((m) => Math.max(m, s))
    if (s === 4 && !drafts && !generating) generateDrafts()
  }

  const startCampaign = () => {
    notify(
      `Đã bắt đầu “${campaignName}” — ${mode === 'review' ? `${drafts?.length ?? 0} bài đầu đang chờ bạn duyệt` : 'AI sẽ tự đăng theo lịch'}`,
    )
    navigate('/chien-dich')
  }

  return (
    <Content className="pb-0">
      <PageHeader
        breadcrumb={
          <Link to="/chien-dich" className="hover:text-foreground">
            Chiến dịch nuôi page
          </Link>
        }
        title="Tạo chiến dịch"
        subtitle="AI viết và đăng bài đều đặn theo mục tiêu, trang và lịch bạn chọn."
      />

      {/* Stepper */}
      <ol className="mb-6 flex items-center gap-2">
        {STEPS.map((label, i) => {
          const n = i + 1
          const done = n < step
          const current = n === step
          const reachable = n <= maxStep && n !== step && (n < step || [...Array(n - 1)].every((_, j) => stepValid(j + 1)))
          return (
            <li key={label} className="flex flex-1 items-center gap-2">
              <button
                disabled={!reachable}
                onClick={() => goTo(n)}
                className={cn('flex items-center gap-2.5 rounded-md px-1 py-1 text-left', reachable && 'hover:bg-slate-100')}
                aria-current={current ? 'step' : undefined}
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold',
                    done && 'bg-primary text-white',
                    current && 'bg-primary-soft text-primary ring-2 ring-primary',
                    !done && !current && 'border border-border bg-surface text-muted-foreground',
                  )}
                >
                  {done ? <Check size={14} /> : n}
                </span>
                <span className={cn('text-sm font-medium whitespace-nowrap', current ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
              </button>
              {n < STEPS.length && <span className={cn('h-px flex-1', n < step ? 'bg-primary' : 'bg-border')} />}
            </li>
          )
        })}
      </ol>

      <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-4">
        <div className="min-w-0">
          {/* ---------- Bước 1 ---------- */}
          {step === 1 && (
            <Card>
              <CardHeader title="Bạn muốn chiến dịch đạt điều gì?" subtitle="AI chọn chủ đề và giọng bài theo mục tiêu này" />
              <div className="space-y-6 p-4">
                <div role="radiogroup" aria-label="Mục tiêu" className="grid grid-cols-2 gap-3">
                  {GOALS.map((g) => (
                    <RadioCard key={g.id} checked={goal === g.id} onSelect={() => chooseGoal(g.id)} icon={g.icon} title={g.label}>
                      {g.desc}
                    </RadioCard>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-6">
                  <div>
                    <span className="mb-1.5 block text-[13px] font-medium">Thời lượng</span>
                    <Segmented
                      options={[
                        { id: '7', label: '7 ngày' },
                        { id: '14', label: '14 ngày' },
                        { id: '30', label: '30 ngày' },
                      ]}
                      value={duration}
                      onChange={setDuration}
                    />
                  </div>
                  <Field label="Ngày bắt đầu" className="w-[180px]">
                    <Input type="date" value={start} min="2026-10-19" onChange={(e) => e.target.value && setStart(e.target.value)} />
                  </Field>
                  <p className="pb-2 text-[13px] text-muted-foreground">
                    Kết thúc {WD[endDate.getDay()]}, {ddmm(endDate)}/{endDate.getFullYear()}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* ---------- Bước 2 ---------- */}
          {step === 2 && (
            <div className="space-y-4">
              <Card>
                <CardHeader
                  title="Đăng lên trang nào?"
                  subtitle="Chọn cả nhóm hoặc từng trang"
                  action={
                    <Segmented
                      options={[
                        { id: 'group', label: 'Theo nhóm' },
                        { id: 'pages', label: 'Chọn từng trang' },
                      ]}
                      value={targetMode}
                      onChange={setTargetMode}
                    />
                  }
                />
                <div className="p-4">
                  {targetMode === 'group' ? (
                    <div role="radiogroup" aria-label="Nhóm" className="grid grid-cols-3 gap-3">
                      {groups.map((g) => {
                        const gp = pagesInGroup(g.id)
                        return (
                          <RadioCard key={g.id} checked={groupId === g.id} onSelect={() => setGroupId(g.id)} title={<GroupChip groupId={g.id} />}>
                            <span className="mt-2 flex items-center gap-2">
                              <span className="flex -space-x-1.5">
                                {gp.map((p) => (
                                  <span key={p.id} className="rounded-full ring-2 ring-white">
                                    <PageAvatar page={p} size={24} />
                                  </span>
                                ))}
                              </span>
                              {gp.length} trang
                            </span>
                          </RadioCard>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {pages.map((p) => {
                        const on = picked.has(p.id)
                        return (
                          <label
                            key={p.id}
                            className={cn(
                              'flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5',
                              on ? 'border-primary bg-primary-soft/30' : 'border-border hover:bg-slate-50',
                            )}
                          >
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              checked={on}
                              onChange={() =>
                                setPicked((s) => {
                                  const n = new Set(s)
                                  if (n.has(p.id)) n.delete(p.id)
                                  else n.add(p.id)
                                  return n
                                })
                              }
                            />
                            <PageLabel page={p} sub={p.groupId ? undefined : 'Chưa có nhóm'} />
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              </Card>

              <Card>
                <CardHeader
                  title="Tần suất đăng"
                  subtitle="Mặc định cho mọi trang; đặt riêng cho trang cần đăng nhiều hoặc ít hơn"
                  action={
                    <label className="flex items-center gap-2 text-[13px] font-medium whitespace-nowrap">
                      Mặc định
                      <Select options={FREQS} value={defaultFreq} onChange={(e) => setDefaultFreq(e.target.value)} className="w-[140px]" />
                    </label>
                  }
                />
                {targetPages.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">Chọn ít nhất 1 trang để đặt tần suất.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {targetPages.map((p) => {
                      const off = p.status === 'disconnected'
                      return (
                        <div key={p.id} className={cn('flex items-center gap-4 px-4 py-3', off && 'bg-red-50/40')}>
                          <div className="min-w-0 flex-1">
                            <PageLabel page={p} />
                          </div>
                          {p.status !== 'active' && <StatusChip status={p.status} />}
                          {off ? (
                            <span className="w-[170px] text-right text-xs text-danger">Bỏ qua — kết nối lại để đăng</span>
                          ) : (
                            <Select
                              options={[DEFAULT_LABEL, ...FREQS]}
                              value={overrides[p.id] ?? DEFAULT_LABEL}
                              onChange={(e) =>
                                setOverrides((o) => {
                                  const n = { ...o }
                                  if (e.target.value === DEFAULT_LABEL) delete n[p.id]
                                  else n[p.id] = e.target.value
                                  return n
                                })
                              }
                              className={cn('w-[170px]', overrides[p.id] && 'border-primary')}
                              aria-label={`Tần suất cho ${p.name}`}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* ---------- Bước 3 ---------- */}
          {step === 3 && (
            <div className="space-y-4">
              <Card>
                <CardHeader title="Nội dung" subtitle="Chủ đề và tỉ lệ AI sẽ xoay vòng" />
                <div className="space-y-5 p-4">
                  <Field label="Tên chiến dịch">
                    <Input value={name} placeholder={autoName} onChange={(e) => setName(e.target.value)} />
                  </Field>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[13px] font-medium">Chủ đề & tỉ lệ</span>
                      <Button size="sm" variant="ghost" onClick={splitEven} disabled={!topics.length}>
                        Chia đều
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {topics.map((t, i) => (
                        <div key={t.name} className="flex items-center gap-3">
                          <span className="w-44 truncate rounded-full bg-primary-soft/60 px-3 py-1 text-[13px] font-medium text-primary-hover">{t.name}</span>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.min(100, t.share)}%` }} />
                          </div>
                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              value={Number.isFinite(t.share) ? t.share : ''}
                              onChange={(e) => editTopics((all) => all.map((x, j) => (j === i ? { ...x, share: e.target.value === '' ? 0 : Number(e.target.value) } : x)))}
                              className="tabular w-[72px] text-right"
                              aria-label={`Tỉ lệ ${t.name}`}
                            />
                            <span className="text-sm text-muted-foreground">%</span>
                          </div>
                          <button
                            onClick={() => editTopics((all) => all.filter((_, j) => j !== i))}
                            className="rounded p-1 text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                            aria-label={`Bỏ chủ đề ${t.name}`}
                          >
                            <X size={15} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div
                      className={cn(
                        'mt-2 text-[13px] font-medium',
                        topicSum === 100 ? 'text-success' : 'text-danger',
                      )}
                      role="status"
                    >
                      {topicSum === 100 ? '✓ Tổng 100%' : `Tổng ${topicSum}% — cần đúng 100% (${topicSum > 100 ? `bớt ${topicSum - 100}%` : `thêm ${100 - topicSum}%`})`}
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTopic(newTopic)} placeholder="Thêm chủ đề…" className="max-w-[240px]" />
                      <Button size="sm" className="h-9" icon={<Plus size={14} />} onClick={() => addTopic(newTopic)} disabled={!newTopic.trim()}>
                        Thêm
                      </Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {TOPIC_SUGGESTIONS.filter((s) => !topics.some((t) => t.name === s)).map((s) => (
                        <button key={s} onClick={() => addTopic(s)} className="rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary">
                          + {s}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>

              <Card>
                <CardHeader title="Lịch & chế độ đăng" />
                <div className="space-y-5 p-4">
                  <div>
                    <span className="mb-1.5 block text-[13px] font-medium">Khung giờ đăng</span>
                    <div className="flex flex-wrap items-center gap-2">
                      {times.map((t) => (
                        <span key={t} className="tabular inline-flex items-center gap-1 rounded-full border border-border bg-surface py-1 pr-1 pl-3 text-[13px] font-medium">
                          {t}
                          <button onClick={() => setTimes((all) => all.filter((x) => x !== t))} className="rounded-full p-0.5 text-muted-foreground hover:bg-slate-100" aria-label={`Bỏ giờ ${t}`}>
                            <X size={13} />
                          </button>
                        </span>
                      ))}
                      <Input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} className="w-[110px]" aria-label="Giờ mới" />
                      <Button size="sm" className="h-9" icon={<Plus size={14} />} onClick={addTime} disabled={times.includes(newTime)}>
                        Thêm giờ
                      </Button>
                    </div>
                    {times.length === 0 && <p className="mt-1.5 text-[13px] text-danger">Thêm ít nhất 1 khung giờ.</p>}
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between text-[13px]">
                      <span className="font-medium">Bài có ảnh AI</span>
                      <span className="tabular font-semibold text-ai">{imagePct}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={10}
                      value={imagePct}
                      onChange={(e) => setImagePct(Number(e.target.value))}
                      className="w-full accent-ai"
                      aria-label="Tỉ lệ bài có ảnh AI"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">Ảnh làm chi phí mỗi bài cao hơn nhưng thường tăng tương tác.</p>
                  </div>

                  <div>
                    <span className="mb-1.5 block text-[13px] font-medium">Chế độ đăng</span>
                    <div role="radiogroup" aria-label="Chế độ đăng" className="grid grid-cols-2 gap-3">
                      <RadioCard
                        checked={mode === 'review'}
                        onSelect={() => setMode('review')}
                        icon={<ShieldCheck size={20} />}
                        title={
                          <span className="flex items-center gap-2">
                            Duyệt trước khi đăng <Chip tone="primary">Khuyên dùng</Chip>
                          </span>
                        }
                      >
                        AI viết sẵn, bạn duyệt từng bài trong mục “Bài chờ duyệt”. Bài chưa duyệt sẽ không đăng.
                      </RadioCard>
                      <RadioCard checked={mode === 'auto'} onSelect={() => setMode('auto')} icon={<Zap size={20} />} title="Tự đăng hoàn toàn">
                        AI tự viết và đăng đúng giờ. Bạn vẫn có thể tạm dừng hoặc sửa bài trên Lịch.
                      </RadioCard>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}

          {/* ---------- Bước 4 ---------- */}
          {step === 4 && (
            <Card>
              <CardHeader
                title="Duyệt 7 bài đầu"
                subtitle="Xem trước giọng văn. Sửa, xoá hoặc tạo lại từng bài; phần còn lại AI viết theo cùng cấu hình."
                action={
                  <AiLockHint locked={!openAiKeySet} align="end">
                    <Button variant="ai" size="sm" onClick={generateDrafts} disabled={generating || !openAiKeySet}>
                      Tạo lại cả 7 bài
                    </Button>
                  </AiLockHint>
                }
              />
              {generating ? (
                <div className="p-4">
                  <div className="mb-4 flex items-center gap-2 rounded-md border border-ai/30 bg-ai-soft/40 px-3 py-2.5 text-sm font-medium text-ai">
                    <Sparkles size={16} className="animate-pulse" /> AI đang tạo 7 bài đầu…
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {Array.from({ length: 4 }, (_, i) => (
                      <div key={i} className="flex gap-3 rounded-md border border-border p-3">
                        <div className="size-20 animate-pulse rounded bg-ai-soft/60" />
                        <div className="flex-1 space-y-2">
                          <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100" />
                          <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
                          <div className="h-3 w-4/5 animate-pulse rounded bg-slate-100" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : !drafts || drafts.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  Bạn đã xoá hết bài xem trước. AI vẫn sẽ viết bài theo cấu hình khi chiến dịch chạy.
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 p-4">
                  {drafts.map((d) => {
                    const page = pageById(d.pageId)
                    const busy = regen.has(d.id)
                    const editing = editingId === d.id
                    const dt = fromIso(d.date)
                    return (
                      <div key={d.id} className="flex flex-col rounded-md border border-border p-3">
                        <div className="flex gap-3">
                          {d.image ? (
                            <img src={d.image} alt="" className={cn('size-20 shrink-0 rounded border border-border object-cover', busy && 'animate-pulse opacity-40')} />
                          ) : (
                            <div className="flex size-20 shrink-0 flex-col items-center justify-center gap-1 rounded border border-dashed border-border text-[10px] text-muted-foreground">
                              <ImageOff size={16} /> Không ảnh
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <PageAvatar page={page} size={22} />
                              <span className="truncate text-[13px] font-medium">{page.name}</span>
                            </div>
                            <div className="tabular mt-1 text-xs text-muted-foreground">
                              {WD[dt.getDay()]}, {ddmm(dt)} · {d.time}
                            </div>
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              <AiBadge />
                              <Chip>{d.topic}</Chip>
                            </div>
                          </div>
                        </div>
                        <div className="mt-2.5 flex-1">
                          {busy ? (
                            <div className="space-y-1.5">
                              <div className="text-xs font-medium text-ai">AI đang viết…</div>
                              <div className="h-2.5 w-full animate-pulse rounded bg-ai-soft" />
                              <div className="h-2.5 w-3/4 animate-pulse rounded bg-ai-soft" />
                            </div>
                          ) : editing ? (
                            <>
                              <Textarea rows={4} value={editText} onChange={(e) => setEditText(e.target.value)} className="text-[13px]" aria-label="Sửa nội dung" />
                              <div className="mt-2 flex gap-2">
                                <Button
                                  size="sm"
                                  variant="primary"
                                  onClick={() => {
                                    setDrafts((all) => (all ?? []).map((x) => (x.id === d.id ? { ...x, caption: editText } : x)))
                                    setEditingId(null)
                                  }}
                                >
                                  Lưu
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                                  Huỷ
                                </Button>
                              </div>
                            </>
                          ) : (
                            <p className="line-clamp-4 text-[13px] whitespace-pre-line text-slate-700">{d.caption}</p>
                          )}
                        </div>
                        {!editing && (
                          <div className="mt-3 flex items-center gap-1.5 border-t border-border pt-2.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<Pencil size={13} />}
                              disabled={busy}
                              onClick={() => {
                                setEditingId(d.id)
                                setEditText(d.caption)
                              }}
                            >
                              Sửa
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-danger hover:bg-red-50 hover:text-danger"
                              icon={<Trash2 size={13} />}
                              disabled={busy}
                              onClick={() => {
                                setDrafts((all) => (all ?? []).filter((x) => x.id !== d.id))
                                notify('Đã xoá bài xem trước')
                              }}
                            >
                              Xoá
                            </Button>
                            <AiLockHint locked={!openAiKeySet} align="end" className="ml-auto">
                              <Button size="sm" variant="ai" className="ml-auto" disabled={busy || !openAiKeySet} onClick={() => regenerateOne(d)}>
                                Tạo lại
                              </Button>
                            </AiLockHint>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
          )}
        </div>

        {/* ---------- Tóm tắt ---------- */}
        <Card className="sticky top-4">
          <CardHeader title="Tóm tắt" />
          <div className="space-y-4 p-4 text-sm">
            <SummaryRow label="Mục tiêu">{goalInfo.label}</SummaryRow>
            <SummaryRow label="Thời gian">
              {days} ngày · {ddmm(startDate)} → {ddmm(endDate)}
            </SummaryRow>
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-muted-foreground">Trang</span>
                <span className="font-medium">{activePages.length} trang</span>
              </div>
              {activePages.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {activePages.map((p) => (
                    <span key={p.id} title={`${p.name} · ${freqOf(p)}`}>
                      <PageAvatar page={p} size={26} />
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Chưa chọn trang</p>
              )}
              {skipped > 0 && <p className="mt-1.5 text-xs text-danger">Bỏ qua {skipped} trang mất kết nối</p>}
            </div>
            <div className="grid grid-cols-2 gap-3 border-y border-border py-3">
              <div>
                <div className="text-xs text-muted-foreground">Tổng số bài</div>
                <div className="tabular text-2xl font-bold">{totalPosts}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Chi phí AI ước tính</div>
                <div className="tabular text-2xl font-bold">~{cost.toLocaleString('vi-VN')}đ</div>
                <div className="text-[11px] text-muted-foreground">~{COST_PER_POST}đ/bài</div>
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-muted-foreground">Lịch 30 ngày</span>
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  Ít
                  {['bg-teal-100', 'bg-teal-300', 'bg-teal-600'].map((c) => (
                    <span key={c} className={cn('size-2.5 rounded-sm', c)} />
                  ))}
                  Nhiều
                </span>
              </div>
              <div className="grid grid-cols-10 gap-1">
                {perDay.map((v, i) => {
                  const d = addDays(startDate, i)
                  const level = v <= 0 ? 0 : v / maxPerDay
                  return (
                    <span
                      key={i}
                      title={v < 0 ? `${ddmm(d)} · ngoài chiến dịch` : `${WD[d.getDay()]} ${ddmm(d)} · ${v} bài`}
                      className={cn(
                        'aspect-square rounded-sm',
                        v < 0 && 'border border-dashed border-border bg-transparent',
                        v === 0 && 'bg-slate-100',
                        v > 0 && level <= 0.34 && 'bg-teal-100',
                        v > 0 && level > 0.34 && level <= 0.67 && 'bg-teal-300',
                        v > 0 && level > 0.67 && 'bg-teal-600',
                      )}
                    />
                  )
                })}
              </div>
            </div>
            <SummaryRow label="Chế độ">
              {mode === 'review' ? (
                <Chip tone="primary" icon={<ShieldCheck size={11} />}>
                  Duyệt trước khi đăng
                </Chip>
              ) : (
                <Chip tone="ai" icon={<Zap size={11} />}>
                  Tự đăng
                </Chip>
              )}
            </SummaryRow>
            <div className="flex gap-2 rounded-md border border-ai/20 bg-ai-soft/60 px-3 py-2.5 text-[13px] text-ai">
              <Sparkles size={15} className="mt-0.5 shrink-0" />
              AI sẽ dùng Hồ sơ thương hiệu của từng trang
            </div>
          </div>
        </Card>
      </div>

      {/* Footer */}
      <div className="sticky bottom-0 z-10 -mx-6 mt-6 flex items-center justify-between gap-3 border-t border-border bg-surface px-6 py-3">
        {step === 1 ? (
          <Button variant="ghost" onClick={() => navigate('/chien-dich')}>
            Huỷ
          </Button>
        ) : (
          <Button icon={<ArrowLeft size={15} />} onClick={() => setStep(step - 1)}>
            Quay lại
          </Button>
        )}
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-muted-foreground">
            Bước {step}/4
            {step === 2 && !stepValid(2) && ' · Chọn ít nhất 1 trang đang kết nối'}
            {step === 3 && !stepValid(3) && ' · Kiểm tra chủ đề (tổng 100%) và khung giờ'}
          </span>
          {step < 4 ? (
            <Button variant="primary" disabled={!stepValid(step)} onClick={() => goTo(step + 1)}>
              Tiếp tục <ArrowRight size={15} />
            </Button>
          ) : (
            <Button variant="primary" icon={<Rocket size={15} />} disabled={!stepValid(4)} onClick={startCampaign}>
              Bắt đầu chiến dịch
            </Button>
          )}
        </div>
      </div>
    </Content>
  )
}

/* ---------- Thành phần phụ ---------- */

function RadioCard({ checked, onSelect, icon, title, children }: { checked: boolean; onSelect: () => void; icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border p-3.5 text-left transition-colors',
        checked ? 'border-primary bg-primary-soft/30 ring-1 ring-primary' : 'border-border bg-surface hover:bg-slate-50',
      )}
    >
      {icon && <span className={cn('mt-0.5 rounded-md p-1.5', checked ? 'bg-primary text-white' : 'bg-slate-100 text-slate-600')}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        {children && <span className="mt-0.5 block text-xs text-muted-foreground">{children}</span>}
      </span>
      <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', checked ? 'border-primary bg-primary' : 'border-slate-300')}>
        {checked && <span className="size-1.5 rounded-full bg-white" />}
      </span>
    </button>
  )
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  )
}
