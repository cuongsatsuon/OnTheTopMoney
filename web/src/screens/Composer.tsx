// Soạn bài AI `/soan-bai` (F4). Story 6.1: đích là trang/nhóm thật, mỗi trang một tab với caption + ảnh riêng, luật
// nền tảng báo ngay trên tab (bảng `publishIssues` dùng chung với server), tải ảnh thật, "Lưu nháp" thật và mở lại
// nháp bằng `?bai=<id>`. Còn mô phỏng: viết caption bằng AI (Story 6.2). Sinh ảnh AI (6.3), lên lịch / đăng (6.4)
// chưa bật.
import {
  AlertCircle,
  Bookmark,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Copy,
  Globe,
  Heart,
  ImageOff,
  Images,
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
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { MediaAssetDto, PageDto } from '@ottm/shared'
import { AiLockHint } from '../components/AiLockHint'
import { Content } from '../components/AppShell'
import { Skeleton } from '../components/Skeleton'
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
  Tabs,
  Textarea,
  cn,
  platformLabel,
} from '../components/ui'
import type { Page } from '../data/mock'
import { useApp } from '../lib/app-context'
import {
  IMAGE_ACCEPT,
  POST_PARAM,
  applyImageToAll,
  assignImage,
  assignUploaded,
  blockingIssues,
  buildSaveBody,
  captionCounter,
  clearImage,
  composerErrorMessage,
  copyCaptionToEmpty,
  draftFromPost,
  draftOf,
  imageFileIssue,
  initialSelection,
  isSelectable,
  issueText,
  issuesFor,
  orderedTargets,
  toggleGroupSelection,
  usePost,
  useSavePost,
  useUploadPostImage,
  type Drafts,
  type TargetDraft,
} from '../lib/composer'
import { toUiPage, usePages } from '../lib/connections'
import { useGroups } from '../lib/groups'

/* ---------- Bộ sinh caption mô phỏng (thay bằng AI thật ở Story 6.2) ---------- */

type Goal = 'Bán hàng' | 'Tương tác' | 'Thông báo'
type Length = 'short' | 'medium' | 'long'

const GOALS: Goal[] = ['Bán hàng', 'Tương tác', 'Thông báo']

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

function hashtags(page: Page, idea: string, goal: Goal, n: number) {
  const words = stripMarks(idea).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 2)
  const tags = new Set<string>()
  const handle = page.handle.replace(/[^a-z0-9]/gi, '')
  if (handle) tags.add('#' + handle)
  if (words.length >= 2) tags.add('#' + words.slice(0, 3).join(''))
  ;(goal === 'Bán hàng' ? ['#sale', '#deal', '#muasam'] : goal === 'Tương tác' ? ['#chiase', '#meohay', '#review'] : ['#thongbao', '#tinmoi'])
    .forEach((t) => tags.add(t))
  words.slice(0, 4).forEach((w) => tags.add('#' + w))
  return [...tags].slice(0, n).join(' ')
}

function writeCaption(page: Page, idea: string, goal: Goal, length: Length, variant: number) {
  const seed = hashStr(page.id + idea) + variant * 7
  const opener = OPENERS[goal][seed % OPENERS[goal].length]!.replace('{idea}', idea.trim())
  const n = length === 'short' ? 1 : length === 'medium' ? 2 : 4
  const body = Array.from({ length: n }, (_, i) => BODY[(seed + i * 2) % BODY.length]!)

  if (page.platform === 'threads') {
    return [opener.replace(/[!.]$/, ''), `Mình nói thật: ${body[0]!.charAt(0).toLowerCase()}${body[0]!.slice(1)}`, 'Ai thử rồi kể mình nghe với 👀', hashtags(page, idea, goal, 1)].join('\n\n')
  }
  if (page.platform === 'instagram') {
    return [opener, body.join(' '), `📍 Link mua hàng ở bio${page.handle ? ` @${page.handle}` : ''}`, '.\n.\n' + hashtags(page, idea, goal, 7)].join('\n\n')
  }
  return [opener, body.join(' '), `👉 Inbox ngay cho ${page.name} để được tư vấn!`, hashtags(page, idea, goal, 4)].join('\n\n')
}

function shorten(caption: string) {
  const parts = caption.split('\n\n')
  if (parts.length <= 2) return parts[0]!.split(/(?<=[.!?])\s/)[0]!
  return [parts[0], parts[parts.length - 1]].join('\n\n')
}

function addCta(caption: string) {
  if (caption.includes(CTA_LINE)) return caption
  const parts = caption.split('\n\n')
  const last = parts[parts.length - 1]!
  if (last.trim().startsWith('#') || last.trim().startsWith('.')) return [...parts.slice(0, -1), CTA_LINE, last].join('\n\n')
  return caption + '\n\n' + CTA_LINE
}

/** Lên lịch / Đăng ngay mở ở Story 6.4 — tới lúc đó chỉ lưu nháp. */
const SCHEDULE_SOON = 'Sắp có: lên lịch và đăng bài. Hiện bạn lưu nháp trước.'

/* ---------- Màn hình ---------- */

export default function Composer() {
  const { scope, notify, openAiKeySet } = useApp()
  const [params, setParams] = useSearchParams()
  const postId = params.get(POST_PARAM)
  const pagesQuery = usePages()
  const groupsQuery = useGroups()
  const postQuery = usePost(postId)
  const save = useSavePost()
  const upload = useUploadPostImage()

  const allPages = useMemo(() => pagesQuery.data ?? [], [pagesQuery.data])
  const groupList = groupsQuery.data ?? []

  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [idea, setIdea] = useState(params.get('idea') ?? '')
  const [drafts, setDrafts] = useState<Drafts>({})
  /** Kho ảnh của bài (ảnh đã tải lên / đang gắn) — mỗi tab chọn một ảnh từ đây. */
  const [pool, setPool] = useState<MediaAssetDto[]>([])
  const [activeTab, setActiveTab] = useState('')
  /** Nháp đã nạp vào state: `'new'` (bài mới) hoặc id bài. Đổi `?bai=` → nạp lại. */
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  const [goal, setGoal] = useState<Goal>('Bán hàng')
  const [length, setLength] = useState<Length>('medium')
  const [useBrand, setUseBrand] = useState(true)
  const [writing, setWriting] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  // Nạp trạng thái ban đầu ngay khi đủ dữ liệu (trong lúc render, không qua effect): bài mới → chọn sẵn theo Phạm vi;
  // `?bai=<id>` → nội dung nháp đã lưu.
  const initKey = postId ?? 'new'
  if (loadedKey !== initKey && pagesQuery.data && (!postId || postQuery.data)) {
    const groupOf = (ids: Iterable<string>) => new Set([...ids].map((id) => allPages.find((p) => p.id === id)?.groupId).filter((g): g is string => !!g))
    if (postId && postQuery.data) {
      const loaded = draftFromPost(postQuery.data, new Set(allPages.map((p) => p.id)))
      setSelected(loaded.selected)
      setDrafts(loaded.drafts)
      setPool(loaded.pool)
      setIdea(loaded.topic)
      setExpanded(groupOf(loaded.selected))
    } else {
      const ids = initialSelection(scope, allPages)
      setSelected(new Set(ids))
      setDrafts({})
      setPool([])
      setIdea(params.get('idea') ?? '')
      setExpanded(groupOf(ids))
    }
    setActiveTab('')
    setLoadedKey(initKey)
  }

  // Nháp không mở được (đã xoá / id sai) → báo và quay về bài mới.
  useEffect(() => {
    if (!postId || !postQuery.isError) return
    notify(composerErrorMessage(postQuery.error))
    setParams(
      (p) => {
        p.delete(POST_PARAM)
        return p
      },
      { replace: true },
    )
  }, [postId, postQuery.isError, postQuery.error, notify, setParams])

  const timers = useRef<number[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), [])
  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms)
    timers.current.push(id)
    return id
  }
  const genTimer = useRef<number | null>(null)

  const targets = orderedTargets(allPages, selected)
  const targetIds = targets.map((p) => p.id)
  const activePage = targets.find((p) => p.id === activeTab) ?? targets[0] ?? null
  const activeId = activePage?.id ?? ''
  const activeDraft = activePage ? draftOf(drafts, activePage.id) : null
  const activeImage = activeDraft ? pool.find((m) => m.id === activeDraft.mediaIds[0]) : undefined
  const emptyTabs = targets.filter((p) => !draftOf(drafts, p.id).caption.trim())
  const tabsWithIssues = targets.filter((p) => blockingIssues(issuesFor(p.platform, draftOf(drafts, p.id))).length > 0)
  const grouped = groupList.map((g) => ({ group: g, pages: allPages.filter((p) => p.groupId === g.id) })).filter((x) => x.pages.length > 0)
  const ungrouped = allPages.filter((p) => !p.groupId || !groupList.some((g) => g.id === p.groupId))
  const loading = pagesQuery.isPending || (postId !== null && postQuery.isPending)

  const togglePage = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const toggleGroup = (gid: string, groupPages: PageDto[]) => {
    const next = toggleGroupSelection(selected, groupPages)
    setSelected(next)
    if (groupPages.some((p) => next.has(p.id))) setExpanded((e) => new Set(e).add(gid))
  }
  const toggleExpand = (gid: string) =>
    setExpanded((e) => {
      const n = new Set(e)
      if (n.has(gid)) n.delete(gid)
      else n.add(gid)
      return n
    })
  const setCaption = (pageId: string, caption: string) =>
    setDrafts((prev) => {
      const d = draftOf(prev, pageId)
      return { ...prev, [pageId]: { ...d, caption, edited: d.ai } }
    })

  const canGenerate = openAiKeySet && targets.length > 0 && idea.trim().length > 0 && !writing

  // Mô phỏng (Story 6.2 thay bằng gọi AI thật theo hồ sơ từng trang): viết cho mọi tab hoặc chỉ tab còn trống.
  function generate(onlyEmpty = false) {
    const list = onlyEmpty ? emptyTabs : targets
    if (!list.length) return
    setWriting(true)
    genTimer.current = later(() => {
      setDrafts((prev) => {
        const next = { ...prev }
        list.forEach((p) => (next[p.id] = { ...draftOf(prev, p.id), caption: writeCaption(toUiPage(p), idea, goal, length, 0), ai: true, edited: false }))
        return next
      })
      setWriting(false)
      genTimer.current = null
      notify(`AI đã viết cho ${list.length} trang`)
    }, 1500)
  }

  function stop() {
    if (genTimer.current) clearTimeout(genTimer.current)
    genTimer.current = null
    setWriting(false)
    notify('Đã dừng AI')
  }

  function quickAction(kind: 'rewrite' | 'shorter' | 'cta') {
    if (!activePage || !activeDraft) return
    const page = activePage
    setBusyAction(kind)
    later(() => {
      setDrafts((prev) => {
        const d = draftOf(prev, page.id)
        const caption =
          kind === 'rewrite' ? writeCaption(toUiPage(page), idea, goal, length, hashStr(d.caption) % 5 + 1) : kind === 'shorter' ? shorten(d.caption) : addCta(d.caption)
        return { ...prev, [page.id]: { ...d, caption, ai: true, edited: false } }
      })
      setBusyAction(null)
    }, 700)
  }

  function copyToEmpty() {
    if (!activeId) return
    const { drafts: next, count } = copyCaptionToEmpty(drafts, targetIds, activeId)
    setDrafts(next)
    if (count) notify(`Đã chép nội dung sang ${count} trang`)
  }

  function onUpload(files: FileList | null) {
    const file = files?.[0]
    if (fileRef.current) fileRef.current.value = ''
    if (!file) return
    const issue = imageFileIssue(file)
    if (issue) {
      notify(issue)
      return
    }
    upload.mutate(file, {
      onSuccess: (asset) => {
        setPool((p) => [asset, ...p])
        if (activeId) setDrafts((d) => assignUploaded(d, targetIds, activeId, asset.id))
        notify('Đã tải ảnh lên')
      },
      onError: (err) => notify(composerErrorMessage(err)),
    })
  }

  function saveDraft() {
    if (!targets.length) return
    save.mutate(
      { id: postId, body: buildSaveBody(idea, targets, drafts) },
      {
        onSuccess: (post) => {
          // Đánh dấu đã nạp TRƯỚC khi đổi `?bai=` để không nạp lại (giữ kho ảnh, nhãn AI của phiên đang soạn).
          setLoadedKey(post.id)
          if (post.id !== postId) {
            setParams(
              (p) => {
                p.set(POST_PARAM, post.id)
                p.delete('idea')
                return p
              },
              { replace: true },
            )
          }
          notify(`Đã lưu nháp cho ${post.targets.length} trang`)
        },
        onError: (err) => notify(composerErrorMessage(err)),
      },
    )
  }

  const footer = (
    <div className="sticky bottom-0 z-10 -mx-6 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface px-6 py-3">
      <div className="text-[13px] text-muted-foreground">
        {targets.length ? (
          <>
            Bài cho <b className="text-foreground">{targets.length} trang</b>
            {tabsWithIssues.length > 0 && <span className="text-danger"> · {tabsWithIssues.length} trang chưa đúng luật nền tảng</span>}
            {postId && ' · đã có bản nháp'}
          </>
        ) : (
          'Chọn trang đích để bắt đầu'
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button icon={<Save size={15} />} disabled={!targets.length || save.isPending} onClick={saveDraft}>
          {save.isPending ? 'Đang lưu…' : 'Lưu nháp'}
        </Button>
        <span className="mx-1 h-6 w-px bg-border" />
        <span title={SCHEDULE_SOON} className="flex flex-wrap items-center gap-2">
          <Input type="date" disabled defaultValue="" className="w-[150px]" aria-label="Ngày đăng" />
          <Input type="time" disabled defaultValue="19:00" className="w-[110px]" aria-label="Giờ đăng" />
          <Button icon={<CalendarClock size={15} />} disabled>
            Lên lịch
          </Button>
          <Button variant="primary" icon={<Send size={15} />} disabled>
            Đăng ngay
          </Button>
        </span>
      </div>
    </div>
  )

  return (
    <Content className="pb-0">
      <PageHeader
        title="Soạn bài AI"
        subtitle="Viết một ý, soạn riêng cho từng trang kèm ảnh. Sửa thoải mái trước khi đăng."
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
              {loading ? (
                <div className="space-y-2 rounded-md border border-border p-3" aria-busy="true">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-7" />
                  ))}
                </div>
              ) : allPages.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-[13px] text-muted-foreground">
                  Chưa có trang nào. <Link to="/trang-nhom" className="font-medium text-primary hover:underline">Kết nối trang</Link> để soạn bài.
                </div>
              ) : (
                <div className="divide-y divide-border rounded-md border border-border">
                  {grouped.map(({ group: g, pages: gp }) => {
                    const usable = gp.filter(isSelectable)
                    const count = gp.filter((p) => selected.has(p.id)).length
                    const all = usable.length > 0 && usable.every((p) => selected.has(p.id))
                    const open = expanded.has(g.id)
                    return (
                      <div key={g.id}>
                        <div className="flex items-center gap-2 px-3 py-2">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={all}
                            disabled={usable.length === 0}
                            ref={(el) => {
                              if (el) el.indeterminate = count > 0 && !all
                            }}
                            onChange={() => toggleGroup(g.id, gp)}
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
              )}
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
                  {writing ? 'AI đang viết…' : 'Tạo bằng AI'}
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
          <CardHeader title="Nội dung" subtitle="Mỗi trang một phiên bản riêng. Bấm vào chữ để sửa." />
          {loading ? (
            <div className="space-y-3 p-4" aria-busy="true">
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-48" />
              <Skeleton className="h-24" />
            </div>
          ) : writing ? (
            <WritingSkeleton onStop={stop} count={(emptyTabs.length && emptyTabs.length < targets.length ? emptyTabs : targets).length} />
          ) : !activePage || !activeDraft ? (
            <EmptyState icon={<PenSquare size={22} />} title="Chưa chọn trang">
              Chọn trang đích ở cột bên trái. Mỗi trang có một tab để viết nội dung và chọn ảnh riêng.
            </EmptyState>
          ) : (
            <div className="p-4">
              <Tabs
                className="overflow-x-auto"
                tabs={targets.map((p) => ({
                  id: p.id,
                  label: (
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      <PlatformIcon platform={p.platform} size={14} />
                      {p.name}
                      {tabsWithIssues.some((t) => t.id === p.id) && <AlertCircle size={13} className="text-danger" aria-label="Chưa đúng luật nền tảng" />}
                    </span>
                  ),
                }))}
                value={activeId}
                onChange={setActiveTab}
              />

              {emptyTabs.length > 0 && emptyTabs.length < targets.length && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-slate-50 px-3 py-2 text-[13px]">
                  <span>{emptyTabs.length} trang chưa có nội dung.</span>
                  <div className="flex gap-2">
                    {activeDraft.caption.trim() && (
                      <Button size="sm" icon={<Copy size={13} />} onClick={copyToEmpty}>
                        Chép sang trang còn trống
                      </Button>
                    )}
                    <AiLockHint locked={!openAiKeySet} align="end">
                      <Button variant="ai" size="sm" onClick={() => generate(true)} disabled={!openAiKeySet || !idea.trim()}>
                        Viết bằng AI cho {emptyTabs.length} trang
                      </Button>
                    </AiLockHint>
                  </div>
                </div>
              )}

              <TabEditor page={activePage} draft={activeDraft} busy={!!busyAction} onChange={(c) => setCaption(activePage.id, c)} />
              <AiLockHint locked={!openAiKeySet} align="start" className="mt-2 flex">
                <div className={cn('flex flex-wrap gap-1.5', openAiKeySet && 'mt-2')}>
                  <AiQuick icon={<RefreshCw size={13} />} onClick={() => quickAction('rewrite')} disabled={!!busyAction || !openAiKeySet || !idea.trim()}>
                    Viết lại
                  </AiQuick>
                  <AiQuick icon={<Scissors size={13} />} onClick={() => quickAction('shorter')} disabled={!!busyAction || !openAiKeySet || !activeDraft.caption.trim()}>
                    Ngắn hơn
                  </AiQuick>
                  <AiQuick icon={<Megaphone size={13} />} onClick={() => quickAction('cta')} disabled={!!busyAction || !openAiKeySet}>
                    Thêm CTA
                  </AiQuick>
                </div>
              </AiLockHint>

              <div className="mt-6">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold">Ảnh</h4>
                    <p className="text-xs text-muted-foreground">Bấm một ảnh để dùng cho {activePage.name} · mỗi trang 1 ảnh</p>
                  </div>
                  <div className="flex gap-2">
                    <AiLockHint locked hint="Sinh ảnh bằng AI sắp có. Hiện bạn tải ảnh của mình lên." link={null} align="end">
                      <Button variant="ai" size="sm" disabled>
                        Tạo ảnh AI
                      </Button>
                    </AiLockHint>
                    <Button size="sm" icon={<Upload size={14} />} onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                      {upload.isPending ? 'Đang tải ảnh…' : 'Tải ảnh lên'}
                    </Button>
                    <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} className="hidden" onChange={(e) => onUpload(e.target.files)} />
                  </div>
                </div>
                {pool.length === 0 && !upload.isPending ? (
                  <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-[13px] text-muted-foreground">
                    <ImageOff size={16} /> Chưa có ảnh. Tải ảnh của bạn lên (PNG, JPEG, WebP · tối đa 10MB).
                  </div>
                ) : (
                  <div className="grid grid-cols-4 gap-2">
                    {upload.isPending && <div className="aspect-square animate-pulse rounded-md bg-slate-100" aria-label="Đang tải ảnh" />}
                    {pool.map((im, i) => {
                      const chosen = activeDraft.mediaIds.includes(im.id)
                      return (
                        <button
                          key={im.id}
                          onClick={() => setDrafts((d) => assignImage(d, activePage.id, im.id))}
                          className={cn('relative aspect-square overflow-hidden rounded-md border border-border', chosen && 'ring-2 ring-primary ring-offset-2')}
                          aria-pressed={chosen}
                          aria-label={`Dùng ảnh ${i + 1} cho ${activePage.name}`}
                        >
                          <img src={im.url} alt="" className="size-full object-cover" />
                          <span className={cn('absolute top-1 left-1 rounded px-1 text-[10px] font-semibold', im.source === 'ai' ? 'bg-ai text-white' : 'bg-white/90 text-slate-700')}>
                            {im.source === 'ai' ? 'AI' : 'Tải lên'}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
                {activeImage && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {targets.length > 1 && (
                      <Button size="sm" icon={<Images size={14} />} onClick={() => setDrafts((d) => applyImageToAll(d, targetIds, [activeImage.id]))}>
                        Dùng ảnh này cho mọi trang
                      </Button>
                    )}
                    <Button size="sm" icon={<X size={14} />} onClick={() => setDrafts((d) => clearImage(d, activePage.id))}>
                      Bỏ ảnh khỏi trang này
                    </Button>
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
            {writing ? (
              <div className="space-y-3 rounded-lg border border-border bg-white p-3">
                <div className="flex items-center gap-2">
                  <div className="size-9 animate-pulse rounded-full bg-slate-200" />
                  <div className="h-3 w-28 animate-pulse rounded bg-slate-200" />
                </div>
                <div className="h-3 w-full animate-pulse rounded bg-slate-200" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-slate-200" />
                <div className="aspect-square animate-pulse rounded bg-slate-200" />
              </div>
            ) : activePage && activeDraft && (activeDraft.caption.trim() || activeImage) ? (
              <>
                {activePage.platform === 'facebook' && <FacebookPreview page={toUiPage(activePage)} caption={activeDraft.caption} image={activeImage?.url} />}
                {activePage.platform === 'instagram' && <InstagramPreview page={toUiPage(activePage)} caption={activeDraft.caption} image={activeImage?.url} />}
                {activePage.platform === 'threads' && <ThreadsPreview page={toUiPage(activePage)} caption={activeDraft.caption} image={activeImage?.url} />}
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

function PageCheck({ page, checked, onToggle }: { page: PageDto; checked: boolean; onToggle: () => void }) {
  const off = !isSelectable(page)
  // Trang mất kết nối không chọn mới được; đã nằm trong nháp thì vẫn bỏ chọn được.
  const locked = off && !checked
  return (
    <label className={cn('flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm', locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-slate-50')}>
      <input type="checkbox" className="size-4 accent-primary" checked={checked} disabled={locked} onChange={onToggle} />
      <PageAvatar page={toUiPage(page)} size={26} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{page.name}</span>
        {off && <span className="block text-[11px] text-danger">Mất kết nối — kết nối lại để đăng</span>}
      </span>
    </label>
  )
}

/** Ô nội dung của một tab: caption, bộ đếm ký tự theo nền tảng, dòng lỗi luật nền tảng (cùng bảng với server). */
function TabEditor({ page, draft, busy, onChange }: { page: PageDto; draft: TargetDraft; busy: boolean; onChange: (caption: string) => void }) {
  const { caption, ai, edited } = draft
  const issues = issuesFor(page.platform, draft)
  const counter = captionCounter(page.platform, caption)
  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {ai && <AiBadge />}
          {edited && <Chip>Đã sửa</Chip>}
          <span>Nội dung cho {platformLabel[page.platform]}</span>
        </div>
        <span className={cn('tabular text-xs', counter.over ? 'font-medium text-danger' : 'text-muted-foreground')}>{counter.text}</span>
      </div>
      {busy ? (
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
          value={caption}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`Viết nội dung cho ${page.name}…`}
          aria-label={`Nội dung cho ${page.name}`}
          aria-invalid={blockingIssues(issues).length > 0}
        />
      )}
      {issues.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs">
          {issues.map((i) => (
            <li key={i.code} className={cn('flex items-center gap-1', i.code === 'POST_EMPTY' ? 'text-muted-foreground' : 'text-danger')}>
              {i.code !== 'POST_EMPTY' && <AlertCircle size={12} />}
              {issueText(i, page.platform)}
            </li>
          ))}
        </ul>
      )}
    </div>
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
    </div>
  )
}

function CaptionText({ text, clamp }: { text: string; clamp?: boolean }) {
  return <p className={cn('text-[13px] leading-relaxed whitespace-pre-line', clamp && 'line-clamp-6')}>{text}</p>
}

function FacebookPreview({ page, caption, image }: { page: Page; caption: string; image?: string | undefined }) {
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

function InstagramPreview({ page, caption, image }: { page: Page; caption: string; image?: string | undefined }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="rounded-full bg-gradient-to-tr from-amber-300 via-pink-500 to-purple-600 p-[2px]">
          <span className="block rounded-full bg-white p-[1.5px]">
            <PageAvatar page={page} size={28} />
          </span>
        </span>
        <span className="flex-1 truncate text-[13px] font-semibold">{page.handle || page.name}</span>
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
        <span className="font-semibold">{page.handle || page.name}</span> <span className="line-clamp-4 whitespace-pre-line">{caption}</span>
      </div>
      <div className="px-3 pb-3 text-xs text-muted-foreground">Xem tất cả 32 bình luận</div>
    </div>
  )
}

function ThreadsPreview({ page, caption, image }: { page: Page; caption: string; image?: string | undefined }) {
  return (
    <div className="rounded-lg border border-border bg-white p-3">
      <div className="flex gap-2.5">
        <div className="flex flex-col items-center">
          <PageAvatar page={page} size={34} />
          <span className="mt-2 w-px flex-1 bg-border" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="font-semibold">{page.handle || page.name}</span>
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
