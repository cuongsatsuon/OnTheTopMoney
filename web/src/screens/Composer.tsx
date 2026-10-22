import {
  Bookmark,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Globe,
  Heart,
  ImageOff,
  MessageCircle,
  MoreHorizontal,
  PenSquare,
  RefreshCw,
  Repeat2,
  Save,
  Scissors,
  Send,
  Share2,
  Sparkles,
  ThumbsUp,
  Upload,
  WandSparkles,
  Megaphone,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AiLockHint } from '../components/AiLockHint'
import { Content } from '../components/AppShell'
import {
  AiBadge,
  Button,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  Field,
  GroupChip,
  Input,
  PageAvatar,
  PageHeader,
  PlatformIcon,
  Segmented,
  Select,
  Switch,
  Tabs,
  Textarea,
  cn,
  platformLabel,
} from '../components/ui'
import { brandProfile, groupById, groups, pageById, pages, pagesInGroup, type Page } from '../data/mock'
import { useApp } from '../lib/app-context'

/* ---------- Bộ sinh caption giả lập ---------- */

type Goal = 'Bán hàng' | 'Tương tác' | 'Thông báo'
type Length = 'short' | 'medium' | 'long'

const GOALS: Goal[] = ['Bán hàng', 'Tương tác', 'Thông báo']
const IMAGE_COUNTS = ['1 ảnh', '2 ảnh', '4 ảnh']
const IMAGE_STYLES = ['Ảnh sản phẩm', 'Phong cách sống', 'Tối giản', 'Minh hoạ']

const OPENERS: Record<Goal, string[]> = {
  'Bán hàng': ['🔥 {idea}!', '⚡ Deal cực hời: {idea}', '🛒 Chốt đơn liền tay: {idea}', '💥 Chỉ trong tuần này: {idea}'],
  'Tương tác': ['Bạn đã thử chưa? {idea} 👇', '💬 Cùng bàn nhé: {idea}', '✨ {idea} — bạn nghĩ sao?', '🤔 Hỏi nhanh: {idea}?'],
  'Thông báo': ['📢 Thông báo: {idea}', '📌 Cập nhật mới: {idea}', '🔔 {idea}', '📣 Tin vui cho khách quen: {idea}'],
}

const BODY = [
  'Số lượng có hạn, ưu tiên khách đặt sớm nha.',
  'Hàng chính hãng, đổi trả trong 7 ngày nếu có lỗi.',
  'Giao nhanh toàn quốc, kiểm tra hàng trước khi nhận.',
  'Hơn 2.000 khách đã tin dùng và đánh giá 5 sao ⭐',
  'Tư vấn miễn phí để chọn đúng sản phẩm hợp với bạn.',
  'Quà tặng kèm cho 50 đơn đầu tiên 🎁',
]

const CTA_LINE = '🎁 Bình luận “QUAN TÂM” để nhận ưu đãi riêng nhé!'

const stripMarks = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')

function hashStr(s: string) {
  let h = 7
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0
  return Math.abs(h)
}

function hashtags(page: Page, idea: string, goal: Goal, useBrand: boolean, n: number) {
  const words = stripMarks(idea).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 2)
  const tags = new Set<string>()
  tags.add('#' + page.handle.replace(/[^a-z0-9]/gi, ''))
  if (words.length >= 2) tags.add('#' + words.slice(0, 3).join(''))
  if (useBrand && page.groupId === 'g-beauty') brandProfile.hashtags.forEach((t) => tags.add(t))
  ;(goal === 'Bán hàng' ? ['#sale', '#deal', '#muasam'] : goal === 'Tương tác' ? ['#chiase', '#meohay', '#review'] : ['#thongbao', '#tinmoi'])
    .forEach((t) => tags.add(t))
  words.slice(0, 4).forEach((w) => tags.add('#' + w))
  return [...tags].slice(0, n).join(' ')
}

function writeCaption(page: Page, idea: string, goal: Goal, length: Length, useBrand: boolean, variant: number) {
  const seed = hashStr(page.id + idea) + variant * 7
  const opener = OPENERS[goal][seed % OPENERS[goal].length].replace('{idea}', idea.trim())
  const n = length === 'short' ? 1 : length === 'medium' ? 2 : 4
  const body = Array.from({ length: n }, (_, i) => BODY[(seed + i * 2) % BODY.length])
  const shopVoice = useBrand && page.groupId === 'g-beauty' ? 'Shop' : 'Mình'

  if (page.platform === 'threads') {
    return [
      opener.replace(/[!.]$/, ''),
      `${shopVoice} nói thật: ${body[0].charAt(0).toLowerCase()}${body[0].slice(1)}`,
      'Ai thử rồi kể mình nghe với 👀',
      hashtags(page, idea, goal, useBrand, 1),
    ].join('\n\n')
  }
  if (page.platform === 'instagram') {
    return [opener, body.join(' '), `📍 Link mua hàng ở bio @${page.handle}`, '.\n.\n' + hashtags(page, idea, goal, useBrand, 7)].join('\n\n')
  }
  return [opener, body.join(' '), `👉 Inbox ngay cho ${page.name} để được tư vấn!`, hashtags(page, idea, goal, useBrand, 4)].join('\n\n')
}

function shorten(caption: string) {
  const parts = caption.split('\n\n')
  if (parts.length <= 2) return parts[0].split(/(?<=[.!?])\s/)[0]
  return [parts[0], parts[parts.length - 1]].join('\n\n')
}

function addCta(caption: string) {
  if (caption.includes(CTA_LINE)) return caption
  const parts = caption.split('\n\n')
  const last = parts[parts.length - 1]
  if (last.trim().startsWith('#') || last.trim().startsWith('.')) return [...parts.slice(0, -1), CTA_LINE, last].join('\n\n')
  return caption + '\n\n' + CTA_LINE
}

const WEEKDAYS = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy']
function formatDay(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  const dt = new Date(y, m - 1, d)
  return `${WEEKDAYS[dt.getDay()]} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`
}

const picsum = (seed: string) => `https://picsum.photos/seed/${seed}/600/600`

interface Draft {
  caption: string
  variant: number
  edited: boolean
}
interface ImageItem {
  url: string
  ai: boolean
}

/* ---------- Màn hình ---------- */

export default function Composer() {
  const { scope, notify, openAiKeySet } = useApp()
  const [params] = useSearchParams()

  const [selected, setSelected] = useState<Set<string>>(() => {
    if (scope.kind === 'group') return new Set(pagesInGroup(scope.id).filter((p) => p.status !== 'disconnected').map((p) => p.id))
    if (scope.kind === 'page') return new Set([scope.id])
    return new Set()
  })
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(scope.kind === 'group' ? [scope.id] : []))
  const [idea, setIdea] = useState(params.get('idea') ?? '')
  const [goal, setGoal] = useState<Goal>('Bán hàng')
  const [length, setLength] = useState<Length>('medium')
  const [withImages, setWithImages] = useState(true)
  const [imageCount, setImageCount] = useState('4 ảnh')
  const [imageStyle, setImageStyle] = useState(IMAGE_STYLES[0])
  const [useBrand, setUseBrand] = useState(true)

  const [phase, setPhase] = useState<'idle' | 'writing' | 'done'>('idle')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [activeTab, setActiveTab] = useState<string>('')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [images, setImages] = useState<ImageItem[]>([])
  const [selectedImg, setSelectedImg] = useState(0)
  const [imgBusy, setImgBusy] = useState(false)
  const [imgRound, setImgRound] = useState(0)

  const [date, setDate] = useState('2026-10-24')
  const [time, setTime] = useState('19:00')
  const [publishing, setPublishing] = useState(false)

  const timers = useRef<number[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), [])
  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms)
    timers.current.push(id)
    return id
  }
  const genTimer = useRef<number | null>(null)

  const targets = useMemo(() => pages.filter((p) => selected.has(p.id)), [selected])
  const draftTabs = targets.filter((p) => drafts[p.id])
  const missing = targets.filter((p) => !drafts[p.id])
  const activeId = draftTabs.some((p) => p.id === activeTab) ? activeTab : draftTabs[0]?.id ?? ''
  const activePage = activeId ? pageById(activeId) : null
  const activeDraft = activeId ? drafts[activeId] : undefined
  const currentImage = images[selectedImg]?.url
  const ungrouped = pages.filter((p) => !p.groupId)

  const togglePage = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const toggleGroup = (gid: string) => {
    const ids = pagesInGroup(gid).filter((p) => p.status !== 'disconnected').map((p) => p.id)
    const all = ids.every((id) => selected.has(id))
    setSelected((s) => {
      const n = new Set(s)
      ids.forEach((id) => (all ? n.delete(id) : n.add(id)))
      return n
    })
    if (!all) setExpanded((e) => new Set(e).add(gid))
  }
  const toggleExpand = (gid: string) =>
    setExpanded((e) => {
      const n = new Set(e)
      if (n.has(gid)) n.delete(gid)
      else n.add(gid)
      return n
    })

  const canGenerate = openAiKeySet && targets.length > 0 && idea.trim().length > 0 && phase !== 'writing'

  function generate(onlyMissing = false) {
    const list = onlyMissing ? missing : targets
    if (!list.length) return
    setPhase('writing')
    genTimer.current = later(() => {
      setDrafts((prev) => {
        const next: Record<string, Draft> = onlyMissing ? { ...prev } : {}
        list.forEach((p) => (next[p.id] = { caption: writeCaption(p, idea, goal, length, useBrand, 0), variant: 0, edited: false }))
        return next
      })
      if (!onlyMissing) {
        const count = withImages ? parseInt(imageCount, 10) : 0
        const base = stripMarks(idea).replace(/\W+/g, '').slice(0, 12) || 'post'
        setImages(Array.from({ length: count }, (_, i) => ({ url: picsum(`${base}${imgRound}${i}`), ai: true })))
        setSelectedImg(0)
        setActiveTab(list[0].id)
      }
      setPhase('done')
      genTimer.current = null
      notify(onlyMissing ? `AI đã viết thêm cho ${list.length} trang` : `AI đã viết ${list.length} bài${withImages ? ` và tạo ${imageCount}` : ''}`)
    }, 1500)
  }

  function stop() {
    if (genTimer.current) clearTimeout(genTimer.current)
    genTimer.current = null
    setPhase(Object.keys(drafts).length ? 'done' : 'idle')
    notify('Đã dừng AI')
  }

  function quickAction(kind: 'rewrite' | 'shorter' | 'cta') {
    if (!activePage || !activeDraft) return
    const page = activePage
    setBusyAction(kind)
    later(() => {
      setDrafts((prev) => {
        const d = prev[page.id]
        if (!d) return prev
        const caption =
          kind === 'rewrite'
            ? writeCaption(page, idea, goal, length, useBrand, d.variant + 1)
            : kind === 'shorter'
              ? shorten(d.caption)
              : addCta(d.caption)
        return { ...prev, [page.id]: { caption, variant: kind === 'rewrite' ? d.variant + 1 : d.variant, edited: false } }
      })
      setBusyAction(null)
    }, 700)
  }

  function regenImages() {
    setImgBusy(true)
    const round = imgRound + 1
    setImgRound(round)
    later(() => {
      const count = Math.max(1, parseInt(imageCount, 10))
      const base = stripMarks(idea).replace(/\W+/g, '').slice(0, 12) || 'post'
      setImages((prev) => [...prev.filter((i) => !i.ai), ...Array.from({ length: count }, (_, i) => ({ url: picsum(`${base}r${round}${i}`), ai: true }))])
      setSelectedImg(0)
      setImgBusy(false)
      notify('AI đã tạo lại ảnh')
    }, 1200)
  }

  function onUpload(files: FileList | null) {
    const f = files?.[0]
    if (!f) return
    setImages((prev) => [{ url: URL.createObjectURL(f), ai: false }, ...prev])
    setSelectedImg(0)
    notify('Đã tải ảnh lên')
  }

  const needsImage = targets.some((p) => p.platform === 'instagram') && !currentImage
  const ready = phase === 'done' && draftTabs.length > 0

  function checkReady() {
    if (needsImage) {
      notify('Instagram cần ít nhất 1 ảnh — chọn hoặc tải ảnh lên')
      return false
    }
    return true
  }

  const footer = (
    <div className="sticky bottom-0 z-10 -mx-6 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface px-6 py-3">
      <div className="text-[13px] text-muted-foreground">
        {ready ? (
          <>
            Sẵn sàng đăng lên <b className="text-foreground">{draftTabs.length} trang</b>
            {currentImage ? ' · kèm 1 ảnh' : ' · không ảnh'}
          </>
        ) : (
          'Tạo nội dung trước khi đăng'
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          icon={<Save size={15} />}
          disabled={!ready}
          onClick={() => notify(`Đã lưu nháp ${draftTabs.length} bài`)}
        >
          Lưu nháp
        </Button>
        <span className="mx-1 h-6 w-px bg-border" />
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-[150px]" aria-label="Ngày đăng" />
        <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-[110px]" aria-label="Giờ đăng" />
        <Button
          icon={<CalendarClock size={15} />}
          disabled={!ready}
          onClick={() => checkReady() && notify(`Đã lên lịch ${draftTabs.length} bài lúc ${time}, ${formatDay(date)} — xem ở Lịch nội dung`)}
        >
          Lên lịch
        </Button>
        <Button
          variant="primary"
          icon={<Send size={15} />}
          disabled={!ready || publishing}
          onClick={() => {
            if (!checkReady()) return
            setPublishing(true)
            later(() => {
              setPublishing(false)
              notify(`Đã đăng lên ${draftTabs.length} trang`)
            }, 1000)
          }}
        >
          {publishing ? 'Đang đăng…' : 'Đăng ngay'}
        </Button>
      </div>
    </div>
  )

  return (
    <Content className="pb-0">
      <PageHeader
        title="Soạn bài AI"
        subtitle="Viết một ý, AI soạn riêng cho từng trang kèm ảnh. Sửa thoải mái trước khi đăng."
        breadcrumb={<Link to="/lich" className="hover:text-foreground">Lịch nội dung</Link>}
      />

      <div className="grid grid-cols-[340px_minmax(0,1fr)_340px] items-start gap-4">
        {/* (a) Thiết lập */}
        <Card>
          <CardHeader title="Thiết lập" subtitle="Chọn trang đích và mô tả bài viết" />
          <div className="space-y-5 p-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[13px] font-medium">Đăng lên</span>
                <span className="text-xs text-muted-foreground">{targets.length ? `${targets.length} trang đã chọn` : 'Chưa chọn trang'}</span>
              </div>
              <div className="divide-y divide-border rounded-md border border-border">
                {groups.map((g) => {
                  const gp = pagesInGroup(g.id)
                  const usable = gp.filter((p) => p.status !== 'disconnected')
                  const count = usable.filter((p) => selected.has(p.id)).length
                  const all = usable.length > 0 && count === usable.length
                  const open = expanded.has(g.id)
                  return (
                    <div key={g.id}>
                      <div className="flex items-center gap-2 px-3 py-2">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={all}
                          ref={(el) => {
                            if (el) el.indeterminate = count > 0 && !all
                          }}
                          onChange={() => toggleGroup(g.id)}
                          aria-label={`Chọn cả ${g.name}`}
                        />
                        <button className="flex flex-1 items-center justify-between gap-2 text-left" onClick={() => toggleExpand(g.id)} aria-expanded={open}>
                          <GroupChip groupId={g.id} />
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            {count}/{gp.length} trang
                            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </span>
                        </button>
                      </div>
                      {open && (
                        <div className="space-y-0.5 pb-2 pl-8">
                          {gp.map((p) => (
                            <PageCheck key={p.id} page={p} checked={selected.has(p.id)} onToggle={() => togglePage(p.id)} />
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {ungrouped.length > 0 && (
                  <div className="px-3 py-2">
                    <div className="mb-1 text-xs font-medium text-muted-foreground">Trang chưa có nhóm</div>
                    {ungrouped.map((p) => (
                      <PageCheck key={p.id} page={p} checked={selected.has(p.id)} onToggle={() => togglePage(p.id)} />
                    ))}
                  </div>
                )}
              </div>
            </div>

            <Field label="Ý tưởng bài viết" hint="Viết ngắn gọn: sản phẩm, ưu đãi, thời gian.">
              <Textarea
                rows={4}
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="Vd: Khuyến mãi nồi chiên không dầu 20% cuối tuần"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Mục tiêu">
                <Select options={GOALS} value={goal} onChange={(e) => setGoal(e.target.value as Goal)} />
              </Field>
              <div>
                <span className="mb-1.5 block text-[13px] font-medium">Độ dài</span>
                <Segmented
                  options={[
                    { id: 'short', label: 'Ngắn' },
                    { id: 'medium', label: 'Vừa' },
                    { id: 'long', label: 'Dài' },
                  ]}
                  value={length}
                  onChange={setLength}
                />
              </div>
            </div>

            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium">Kèm ảnh AI</span>
                <Switch checked={withImages} onChange={setWithImages} label="Kèm ảnh AI" ai />
              </div>
              {withImages && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Số ảnh">
                    <Select options={IMAGE_COUNTS} value={imageCount} onChange={(e) => setImageCount(e.target.value)} />
                  </Field>
                  <Field label="Phong cách">
                    <Select options={IMAGE_STYLES} value={imageStyle} onChange={(e) => setImageStyle(e.target.value)} />
                  </Field>
                </div>
              )}
            </div>

            <label className="flex items-start gap-2.5 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={useBrand} onChange={(e) => setUseBrand(e.target.checked)} />
              <span>
                Dùng hồ sơ thương hiệu của từng trang
                <span className="block text-xs text-muted-foreground">AI viết theo giọng điệu, sản phẩm và từ cấm của mỗi trang.</span>
              </span>
            </label>

            <div>
              <AiLockHint locked={!openAiKeySet} className="flex w-full">
                <Button variant="ai" className="h-11 w-full text-[15px]" disabled={!canGenerate} onClick={() => generate()}>
                  {phase === 'writing' ? 'AI đang viết…' : phase === 'done' ? 'Tạo lại bằng AI' : 'Tạo bằng AI'}
                </Button>
              </AiLockHint>
              {/* Chưa có khoá: gợi ý + liên kết Cài đặt nằm ở AiLockHint của nút. */}
              {openAiKeySet && (targets.length === 0 || !idea.trim()) && (
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  {targets.length === 0 ? 'Chọn ít nhất 1 trang để tạo bài.' : 'Nhập ý tưởng để AI bắt đầu viết.'}
                </p>
              )}
            </div>
          </div>
        </Card>

        {/* (b) Nội dung */}
        <Card className="min-w-0">
          <CardHeader
            title="Nội dung"
            subtitle={ready ? 'Mỗi trang một phiên bản riêng. Bấm vào chữ để sửa.' : 'AI viết riêng cho từng trang đã chọn'}
            action={ready ? <AiBadge /> : undefined}
          />
          {phase === 'writing' ? (
            <WritingSkeleton onStop={stop} count={(missing.length && Object.keys(drafts).length ? missing : targets).length} />
          ) : !ready ? (
            <EmptyState icon={<PenSquare size={22} />} title="Chưa có nội dung">
              Chọn trang đích, nhập ý tưởng rồi bấm “Tạo bằng AI”. AI sẽ viết riêng cho từng trang và tạo ảnh minh hoạ.
            </EmptyState>
          ) : (
            <div className="p-4">
              <Tabs
                className="overflow-x-auto"
                tabs={draftTabs.map((p) => ({
                  id: p.id,
                  label: (
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      <PlatformIcon platform={p.platform} size={14} />
                      {p.name}
                    </span>
                  ),
                }))}
                value={activeId}
                onChange={setActiveTab}
              />

              {missing.length > 0 && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-ai/30 bg-ai-soft/50 px-3 py-2 text-[13px]">
                  <span>{missing.length} trang mới chọn chưa có nội dung.</span>
                  <AiLockHint locked={!openAiKeySet} align="end">
                    <Button variant="ai" size="sm" onClick={() => generate(true)} disabled={!openAiKeySet}>
                      Viết thêm cho {missing.length} trang
                    </Button>
                  </AiLockHint>
                </div>
              )}

              {activePage && activeDraft && (
                <div className="mt-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <AiBadge />
                      {activeDraft.edited && <Chip>Đã sửa</Chip>}
                      <span>
                        {useBrand
                          ? activePage.brandSource === 'group' && activePage.groupId
                            ? `Theo hồ sơ của ${groupById(activePage.groupId)?.name}`
                            : 'Theo hồ sơ riêng của trang'
                          : 'Không dùng hồ sơ thương hiệu'}
                      </span>
                    </div>
                    <span className="tabular text-xs text-muted-foreground">{activeDraft.caption.length} ký tự</span>
                  </div>
                  {busyAction ? (
                    <div className="space-y-2 rounded-sm border border-ai/30 bg-ai-soft/30 p-3">
                      <div className="flex items-center gap-1.5 text-[13px] font-medium text-ai">
                        <Sparkles size={14} className="animate-pulse" /> AI đang viết…
                      </div>
                      {[90, 100, 70, 85].map((w, i) => (
                        <div key={i} className="h-3 animate-pulse rounded bg-ai-soft" style={{ width: `${w}%` }} />
                      ))}
                    </div>
                  ) : (
                    <Textarea
                      rows={9}
                      value={activeDraft.caption}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [activePage.id]: { ...prev[activePage.id], caption: e.target.value, edited: true } }))
                      }
                      aria-label={`Nội dung cho ${activePage.name}`}
                    />
                  )}
                  <AiLockHint locked={!openAiKeySet} align="start" className="mt-2 flex">
                  <div className={cn('flex flex-wrap gap-1.5', openAiKeySet && 'mt-2')}>
                    <AiQuick icon={<RefreshCw size={13} />} onClick={() => quickAction('rewrite')} disabled={!!busyAction || !openAiKeySet}>
                      Viết lại
                    </AiQuick>
                    <AiQuick icon={<Scissors size={13} />} onClick={() => quickAction('shorter')} disabled={!!busyAction || !openAiKeySet}>
                      Ngắn hơn
                    </AiQuick>
                    <AiQuick icon={<Megaphone size={13} />} onClick={() => quickAction('cta')} disabled={!!busyAction || !openAiKeySet}>
                      Thêm CTA
                    </AiQuick>
                  </div>
                  </AiLockHint>
                </div>
              )}

              <div className="mt-6">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold">Ảnh</h4>
                    <p className="text-xs text-muted-foreground">Chọn 1 ảnh dùng chung cho mọi trang · {imageStyle}</p>
                  </div>
                  <div className="flex gap-2">
                    <AiLockHint locked={!openAiKeySet} align="end">
                      <Button variant="ai" size="sm" onClick={regenImages} disabled={imgBusy || !openAiKeySet}>
                        {imgBusy ? 'Đang tạo ảnh…' : 'Tạo lại ảnh'}
                      </Button>
                    </AiLockHint>
                    <Button size="sm" icon={<Upload size={14} />} onClick={() => fileRef.current?.click()}>
                      Tải ảnh lên
                    </Button>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onUpload(e.target.files)} />
                  </div>
                </div>
                {imgBusy ? (
                  <div className="grid grid-cols-4 gap-2">
                    {Array.from({ length: Math.max(1, parseInt(imageCount, 10)) }, (_, i) => (
                      <div key={i} className="aspect-square animate-pulse rounded-md bg-ai-soft" />
                    ))}
                  </div>
                ) : images.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-[13px] text-muted-foreground">
                    <ImageOff size={16} /> Chưa có ảnh. Bấm “Tạo lại ảnh” hoặc tải ảnh của bạn lên.
                  </div>
                ) : (
                  <div className="grid grid-cols-4 gap-2">
                    {images.map((im, i) => (
                      <button
                        key={im.url}
                        onClick={() => setSelectedImg(i)}
                        className={cn(
                          'relative aspect-square overflow-hidden rounded-md border border-border',
                          selectedImg === i && 'ring-2 ring-primary ring-offset-2',
                        )}
                        aria-pressed={selectedImg === i}
                        aria-label={`Chọn ảnh ${i + 1}`}
                      >
                        <img src={im.url} alt="" className="size-full object-cover" />
                        <span
                          className={cn(
                            'absolute top-1 left-1 rounded px-1 text-[10px] font-semibold',
                            im.ai ? 'bg-ai text-white' : 'bg-white/90 text-slate-700',
                          )}
                        >
                          {im.ai ? 'AI' : 'Tải lên'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>

        {/* (c) Xem trước */}
        <Card className="sticky top-4">
          <CardHeader
            title="Xem trước"
            subtitle={activePage ? `Dạng bài ${platformLabel[activePage.platform]}` : 'Bài sẽ hiện như trên nền tảng'}
            action={activePage ? <PlatformIcon platform={activePage.platform} size={18} /> : undefined}
          />
          <div className="bg-slate-50 p-4">
            {phase === 'writing' ? (
              <div className="space-y-3 rounded-lg border border-border bg-white p-3">
                <div className="flex items-center gap-2">
                  <div className="size-9 animate-pulse rounded-full bg-slate-200" />
                  <div className="h-3 w-28 animate-pulse rounded bg-slate-200" />
                </div>
                <div className="h-3 w-full animate-pulse rounded bg-slate-200" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-slate-200" />
                <div className="aspect-square animate-pulse rounded bg-slate-200" />
              </div>
            ) : activePage && activeDraft ? (
              <>
                {activePage.platform === 'facebook' && <FacebookPreview page={activePage} caption={activeDraft.caption} image={currentImage} />}
                {activePage.platform === 'instagram' && <InstagramPreview page={activePage} caption={activeDraft.caption} image={currentImage} />}
                {activePage.platform === 'threads' && <ThreadsPreview page={activePage} caption={activeDraft.caption} image={currentImage} />}
              </>
            ) : (
              <div className="flex aspect-[4/5] flex-col items-center justify-center rounded-lg border border-dashed border-border bg-white text-center text-[13px] text-muted-foreground">
                <Globe size={20} className="mb-2" />
                Xem trước sẽ hiện ở đây
              </div>
            )}
          </div>
        </Card>
      </div>

      {footer}
    </Content>
  )
}

/* ---------- Thành phần phụ ---------- */

function PageCheck({ page, checked, onToggle }: { page: Page; checked: boolean; onToggle: () => void }) {
  const off = page.status === 'disconnected'
  return (
    <label className={cn('flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm', off ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-slate-50')}>
      <input type="checkbox" className="size-4 accent-primary" checked={checked} disabled={off} onChange={onToggle} />
      <PageAvatar page={page} size={26} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{page.name}</span>
        {off && <span className="block text-[11px] text-danger">Mất kết nối — kết nối lại để đăng</span>}
      </span>
    </label>
  )
}

function AiQuick({ children, icon, onClick, disabled }: { children: ReactNode; icon: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 items-center gap-1 rounded-full border border-ai/30 bg-ai-soft/40 px-2.5 text-xs font-medium text-ai hover:bg-ai-soft disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  )
}

function WritingSkeleton({ onStop, count }: { onStop: () => void; count: number }) {
  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between rounded-md border border-ai/30 bg-ai-soft/40 px-3 py-2.5">
        <span className="flex items-center gap-2 text-sm font-medium text-ai">
          <WandSparkles size={16} className="animate-pulse" />
          AI đang viết… ({count} trang)
        </span>
        <Button size="sm" onClick={onStop}>
          Dừng
        </Button>
      </div>
      <div className="mb-4 flex gap-2">
        {Array.from({ length: Math.min(count, 4) }, (_, i) => (
          <div key={i} className="h-7 w-28 animate-pulse rounded bg-slate-100" />
        ))}
      </div>
      <div className="space-y-2">
        {[95, 100, 88, 100, 60].map((w, i) => (
          <div key={i} className="h-3.5 animate-pulse rounded bg-slate-100" style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-4 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="aspect-square animate-pulse rounded-md bg-ai-soft/60" />
        ))}
      </div>
    </div>
  )
}

function CaptionText({ text, clamp }: { text: string; clamp?: boolean }) {
  return <p className={cn('text-[13px] leading-relaxed whitespace-pre-line', clamp && 'line-clamp-6')}>{text}</p>
}

function FacebookPreview({ page, caption, image }: { page: Page; caption: string; image?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white">
      <div className="flex items-center gap-2.5 px-3 pt-3">
        <PageAvatar page={page} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{page.name}</div>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            Vừa xong · <Globe size={11} />
          </div>
        </div>
        <MoreHorizontal size={18} className="text-muted-foreground" />
      </div>
      <div className="px-3 py-2.5">
        <CaptionText text={caption} clamp />
      </div>
      {image && <img src={image} alt="" className="aspect-square w-full object-cover" />}
      <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="flex size-4 items-center justify-center rounded-full bg-[#1877F2] text-white">
            <ThumbsUp size={9} />
          </span>
          128
        </span>
        <span>24 bình luận · 6 lượt chia sẻ</span>
      </div>
      <div className="mx-3 grid grid-cols-3 border-t border-border py-1 text-[12px] font-medium text-slate-600">
        {[
          { Icon: ThumbsUp, label: 'Thích' },
          { Icon: MessageCircle, label: 'Bình luận' },
          { Icon: Share2, label: 'Chia sẻ' },
        ].map(({ Icon, label }) => (
          <span key={label} className="flex items-center justify-center gap-1.5 py-1.5">
            <Icon size={15} /> {label}
          </span>
        ))}
      </div>
    </div>
  )
}

function InstagramPreview({ page, caption, image }: { page: Page; caption: string; image?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="rounded-full bg-gradient-to-tr from-amber-300 via-pink-500 to-purple-600 p-[2px]">
          <span className="block rounded-full bg-white p-[1.5px]">
            <PageAvatar page={page} size={28} />
          </span>
        </span>
        <span className="flex-1 truncate text-[13px] font-semibold">{page.handle}</span>
        <MoreHorizontal size={18} />
      </div>
      {image ? (
        <img src={image} alt="" className="aspect-square w-full object-cover" />
      ) : (
        <div className="flex aspect-square w-full flex-col items-center justify-center gap-1 bg-slate-100 text-xs text-muted-foreground">
          <ImageOff size={20} />
          Instagram cần ít nhất 1 ảnh
        </div>
      )}
      <div className="flex items-center gap-3.5 px-3 pt-2.5">
        <Heart size={20} />
        <MessageCircle size={20} />
        <Send size={20} />
        <Bookmark size={20} className="ml-auto" />
      </div>
      <div className="px-3 pt-1.5 text-[13px] font-semibold">1.204 lượt thích</div>
      <div className="px-3 pt-1 pb-1 text-[13px] leading-relaxed">
        <span className="font-semibold">{page.handle}</span> <span className="line-clamp-4 whitespace-pre-line">{caption}</span>
      </div>
      <div className="px-3 pb-3 text-xs text-muted-foreground">Xem tất cả 32 bình luận</div>
    </div>
  )
}

function ThreadsPreview({ page, caption, image }: { page: Page; caption: string; image?: string }) {
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <div className="flex gap-2.5">
        <div className="flex flex-col items-center">
          <PageAvatar page={page} size={34} />
          <span className="mt-2 w-px flex-1 bg-border" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="font-semibold">{page.handle}</span>
            <span className="text-muted-foreground">2 phút</span>
            <MoreHorizontal size={16} className="ml-auto text-muted-foreground" />
          </div>
          <div className="mt-1">
            <CaptionText text={caption} />
          </div>
          {image && <img src={image} alt="" className="mt-2.5 aspect-[4/3] w-4/5 rounded-lg border border-border object-cover" />}
          <div className="mt-3 flex items-center gap-4 text-slate-700">
            <Heart size={18} />
            <MessageCircle size={18} />
            <Repeat2 size={18} />
            <Send size={18} />
          </div>
          <div className="mt-2 text-xs text-muted-foreground">8 lượt trả lời · 46 lượt thích</div>
        </div>
      </div>
    </div>
  )
}
