import { Bot, BookOpen, FileText, MessageCircleQuestion, Plus, RotateCcw, Send, Sparkles, Trash, TriangleAlert, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
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
  InheritanceBar,
  Input,
  Modal,
  PageAvatar,
  PageHeader,
  PageLabel,
  PlatformIcon,
  Segmented,
  Select,
  Switch,
  Textarea,
  cn,
  platformLabel,
} from '../components/ui'
import { brandProfile, groupById, groups, pages, pagesInGroup, type Platform } from '../data/mock'
import { useApp } from '../lib/app-context'

/* =====================================================================
 * Mô hình cấu hình AI trả lời tự động (EXPERIENCE.md › Cấu hình AI trả lời tự động)
 * ===================================================================== */

type Schedule = 'always' | 'offhours' | 'custom'
type ChannelKey = 'messenger' | 'igDirect' | 'commentPublic' | 'commentPrivate'
interface DayRange {
  day: string
  on: boolean
  from: string
  to: string
}
interface KnowledgeItem {
  id: string
  kind: 'faq' | 'file'
  title: string
  detail: string
}
interface AutoReplyConfig {
  enabled: boolean
  schedule: Schedule
  ranges: DayRange[]
  channels: Record<ChannelKey, boolean>
  prompt: string
  knowledge: KnowledgeItem[]
  keywords: string[]
  uncertain: boolean
  askHuman: boolean
}

type Domain = 'beauty' | 'home' | 'fashion'

const CHANNELS: { key: ChannelKey; label: string; hint: string; platforms: Platform[] }[] = [
  { key: 'messenger', label: 'Tin nhắn Messenger', hint: 'Trả lời tin nhắn gửi tới Fanpage', platforms: ['facebook'] },
  { key: 'igDirect', label: 'Instagram Direct', hint: 'Trả lời tin nhắn riêng trên Instagram', platforms: ['instagram'] },
  { key: 'commentPublic', label: 'Trả lời bình luận công khai', hint: 'Trả lời ngay dưới bình luận của khách', platforms: ['facebook', 'instagram', 'threads'] },
  { key: 'commentPrivate', label: 'Nhắn riêng cho người bình luận', hint: 'Gửi tin nhắn riêng khi khách bình luận hỏi giá', platforms: ['facebook', 'instagram'] },
]

const DAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']
const defaultRanges = (): DayRange[] => DAYS.map((day) => ({ day, on: day !== 'CN', from: '08:00', to: '18:00' }))

const PROMPTS: Record<Domain, string> = {
  beauty: `Bạn là nhân viên tư vấn của shop Mỹ phẩm Lan Anh. Xưng "shop", gọi khách là "chị" hoặc "bạn". Giọng thân thiện, ngắn gọn, đúng chuyên môn.

- Hỏi loại da của khách trước khi gợi ý sản phẩm.
- Chỉ báo giá theo bảng giá trong kho kiến thức.
- Không dùng các cụm: "trị dứt điểm", "cam kết 100%", "thần dược".
- Khi khách muốn mua, xin số điện thoại và địa chỉ nhận hàng.`,
  home: `Bạn là nhân viên bán hàng của Gia dụng Minh Phát. Xưng "shop", gọi khách là "anh/chị". Trả lời rõ ràng, lịch sự, ưu tiên thông tin dung tích, công suất, bảo hành.

- Hỏi số người trong gia đình để gợi ý dung tích phù hợp.
- Báo giá và phí giao hàng theo kho kiến thức.
- Hàng lỗi, đổi trả, bảo hành: ghi nhận và chuyển cho nhân viên.
- Khi khách chốt, xin số điện thoại và địa chỉ nhận hàng.`,
  fashion: `Bạn là nhân viên tư vấn của Thời trang Mộc. Xưng "Mộc", gọi khách là "bạn". Giọng nhẹ nhàng, tối giản, gợi ý cách phối đồ.

- Hỏi chiều cao, cân nặng để tư vấn size theo bảng size.
- Chỉ nhận đặt hàng sản phẩm còn trong kho kiến thức.
- Khi khách chốt, xin số điện thoại và địa chỉ nhận hàng.`,
}

const PROMPT_THREADS = `Bạn là "Lan Anh Skincare" trên Threads. Xưng "mình", gọi khách là "bạn". Giọng trẻ trung, ngắn gọn, có thể dùng 1 emoji.

- Trả lời công khai dưới bài đăng, tối đa 2 câu.
- Mời khách nhắn Instagram lananh.beauty để được báo giá chi tiết.
- Không dùng các cụm: "trị dứt điểm", "cam kết 100%", "thần dược".`

const KNOWLEDGE: Record<Domain, KnowledgeItem[]> = {
  beauty: [
    { id: 'kb1', kind: 'file', title: 'Bảng giá mỹ phẩm T10.pdf', detail: 'PDF · 3 trang · 240 KB' },
    { id: 'kb2', kind: 'faq', title: 'Phí giao hàng?', detail: 'Freeship đơn từ 300.000đ, dưới 300.000đ phí 25.000đ toàn quốc.' },
    { id: 'kb3', kind: 'faq', title: 'Có hàng chính hãng không?', detail: 'Toàn bộ sản phẩm chính hãng, có tem phụ và hoá đơn nhập khẩu.' },
  ],
  home: [
    { id: 'kh1', kind: 'file', title: 'Bảng giá.pdf', detail: 'PDF · 2 trang · 180 KB' },
    { id: 'kh2', kind: 'faq', title: 'Bảo hành bao lâu?', detail: 'nồi chiên bảo hành 12 tháng, đổi mới trong 7 ngày đầu nếu lỗi nhà sản xuất ạ.' },
    { id: 'kh3', kind: 'faq', title: 'Phí giao hàng?', detail: 'nội thành miễn phí, tỉnh khác 30.000đ, nhận hàng sau 2–3 ngày ạ.' },
  ],
  fashion: [{ id: 'kf1', kind: 'faq', title: 'Bảng size áo len', detail: 'size S cho 45–50kg, M cho 50–56kg, L cho 56–62kg ạ.' }],
}

const PRICE_REPLY: Record<Domain, string> = {
  beauty: `Dạ ${brandProfile.products.map((p) => `${p.name} giá ${p.price}`).join(', ')} ạ. Bạn đang quan tâm sản phẩm nào để shop tư vấn kỹ hơn nha?`,
  home: 'Dạ nồi chiên không dầu 5L giá 1.290.000đ, 7L giá 1.690.000đ ạ. Cuối tuần này shop đang giảm 20% đó anh/chị!',
  fashion: 'Dạ áo len BST thu giá 390.000đ, mua 2 áo giảm 10% ạ. Bạn thích màu nào để Mộc giữ hàng nha?',
}
const GREETING: Record<Domain, string> = {
  beauty: 'Dạ shop Mỹ phẩm Lan Anh xin chào ạ ✨ Bạn đang tìm sản phẩm cho da dầu, da khô hay da hỗn hợp ạ?',
  home: 'Dạ Gia dụng Minh Phát xin chào anh/chị ạ! Anh/chị đang quan tâm sản phẩm nào để shop tư vấn ạ?',
  fashion: 'Mộc chào bạn nha 🍂 Bạn đang tìm áo cho dịp đi làm hay đi chơi ạ?',
}
const SAMPLE_QUESTIONS: Record<Domain, string[]> = {
  beauty: ['Serum giá bao nhiêu?', 'Phí giao hàng thế nào?', 'Mình muốn đổi trả hàng'],
  home: ['Nồi chiên bảo hành bao lâu?', 'Có giao Đà Nẵng không?', 'Mình muốn đổi trả'],
  fashion: ['Áo len giá bao nhiêu?', 'Mình 52kg mặc size gì?', 'Cho mình gặp nhân viên'],
}

const domainOf = (groupId: string | null): Domain => (groupId === 'g-beauty' ? 'beauty' : groupId === 'g-home' ? 'home' : 'fashion')

const makeConfig = (domain: Domain, patch: Partial<AutoReplyConfig> = {}): AutoReplyConfig => ({
  enabled: true,
  schedule: 'always',
  ranges: defaultRanges(),
  channels: { messenger: true, igDirect: true, commentPublic: true, commentPrivate: false },
  prompt: PROMPTS[domain],
  knowledge: KNOWLEDGE[domain].map((k) => ({ ...k })),
  keywords: domain === 'home' ? ['đổi trả', 'bảo hành lỗi', 'khiếu nại', 'hoàn tiền'] : ['đổi trả', 'khiếu nại', 'hoàn tiền'],
  uncertain: true,
  askHuman: true,
  ...patch,
})

/* ---------- Kho cấu hình dùng chung (cây bên trái + form + màn chi tiết trang/nhóm) ---------- */

interface StoreState {
  configs: Record<string, AutoReplyConfig>
  own: Record<string, boolean>
}

function initStore(): StoreState {
  const configs: Record<string, AutoReplyConfig> = {}
  for (const g of groups) configs[`group:${g.id}`] = makeConfig(domainOf(g.id), { enabled: g.autoReply, schedule: g.id === 'g-home' ? 'offhours' : 'always' })
  if (configs['group:g-home']) configs['group:g-home'].ranges = DAYS.map((day) => ({ day, on: true, from: '08:00', to: '18:00' }))
  const own: Record<string, boolean> = {}
  for (const p of pages) {
    const g = groupById(p.groupId)
    const isOwn = !g || p.brandSource === 'own' || p.autoReply !== g.autoReply
    own[p.id] = isOwn
    if (isOwn) {
      const base = g ? structuredClone(configs[`group:${g.id}`]) : makeConfig(domainOf(p.groupId))
      configs[`page:${p.id}`] = {
        ...base,
        enabled: p.autoReply,
        prompt: p.id === 'p3' ? PROMPT_THREADS : base.prompt,
        channels: p.id === 'p6' ? { ...base.channels, commentPublic: false } : base.channels,
      }
    }
  }
  return { configs, own }
}

let storeState: StoreState = initStore()
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
const commit = (next: StoreState) => {
  storeState = next
  listeners.forEach((l) => l())
}
const useAutoReplyStore = () => useSyncExternalStore(subscribe, () => storeState)

/** Cấu hình đang có hiệu lực cho một trang (riêng hoặc theo nhóm). */
const effectiveForPage = (s: StoreState, pageId: string, groupId: string | null) =>
  s.own[pageId] || !groupId ? s.configs[`page:${pageId}`] : s.configs[`group:${groupId}`]

/* ---------- Mô phỏng câu trả lời cho khung "Thử AI" ---------- */

const STOP_WORDS = new Set(['hàng', 'không', 'bao', 'lâu', 'nào', 'của', 'cho', 'được', 'phí', 'bảng', 'chính', 'sách', 'thế', 'gì', 'có'])

function simulateReply(text: string, cfg: AutoReplyConfig, domain: Domain): { reply: string; handoff?: string } {
  const t = text.toLowerCase()
  const kw = cfg.keywords.find((k) => k.trim() && t.includes(k.trim().toLowerCase()))
  if (kw) return { reply: 'Dạ shop rất tiếc về sự bất tiện này ạ. Shop sẽ kiểm tra và phản hồi bạn ngay nhé!', handoff: `khách nhắc tới “${kw}”` }
  if (cfg.askHuman && /(gặp người|gặp nhân viên|nhân viên|người thật|tư vấn viên|gọi điện|gọi cho)/.test(t))
    return { reply: 'Dạ shop sẽ nhờ nhân viên liên hệ bạn ngay ạ!', handoff: 'khách yêu cầu gặp người' }
  const faq = cfg.knowledge.find(
    (k) =>
      k.kind === 'faq' &&
      k.title
        .toLowerCase()
        .replace(/[?.,!]/g, '')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
        .some((w) => t.includes(w) || (w === 'giao' && t.includes('ship'))),
  )
  if (faq) return { reply: `Dạ ${faq.detail.charAt(0).toLowerCase()}${faq.detail.slice(1)}` }
  if (/(giá|bao nhiêu|nhiêu tiền)/.test(t)) return { reply: PRICE_REPLY[domain] }
  if (/(chào|hello|alo|^hi\b)/.test(t)) return { reply: GREETING[domain] }
  if (/(còn hàng|có hàng|còn không)/.test(t)) return { reply: 'Dạ sản phẩm vẫn còn hàng ạ. Bạn cần shop tư vấn thêm gì không ạ?' }
  if (cfg.uncertain) return { reply: 'Dạ câu này shop cần kiểm tra lại cho chính xác, bạn đợi shop một chút nha!', handoff: 'AI không chắc chắn câu trả lời' }
  return { reply: 'Dạ shop đã nhận được câu hỏi ạ. Bạn cho shop xin thêm chi tiết để tư vấn chính xác nha!' }
}

/* =====================================================================
 * AutoReplyForm — dùng ở /ai-tra-loi và tab "AI trả lời" của trang/nhóm
 * ===================================================================== */

export function AutoReplyForm({ target }: { target: { kind: 'group' | 'page'; id: string } }) {
  return <AutoReplyFormInner key={`${target.kind}:${target.id}`} target={target} />
}

function AutoReplyFormInner({ target }: { target: { kind: 'group' | 'page'; id: string } }) {
  const { notify, openAiKeySet } = useApp()
  const store = useAutoReplyStore()

  const page = target.kind === 'page' ? (pages.find((p) => p.id === target.id) ?? null) : null
  const group = target.kind === 'group' ? groupById(target.id) : page ? groupById(page.groupId) : null
  const exists = target.kind === 'group' ? !!group : !!page
  const domain = domainOf(group?.id ?? page?.groupId ?? null)
  const key = `${target.kind}:${target.id}`
  const groupConfig = group ? (store.configs[`group:${group.id}`] ?? null) : null

  const savedOwn = target.kind === 'group' || !group ? true : !!store.own[target.id]
  const savedConfig: AutoReplyConfig =
    target.kind === 'group'
      ? (store.configs[key] ?? makeConfig(domain))
      : savedOwn
        ? (store.configs[key] ?? (groupConfig ? structuredClone(groupConfig) : makeConfig(domain)))
        : (groupConfig ?? makeConfig(domain))

  const [own, setOwn] = useState(savedOwn)
  const [draft, setDraft] = useState<AutoReplyConfig>(() => structuredClone(savedConfig))
  const [promptError, setPromptError] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [kwInput, setKwInput] = useState('')

  const inheriting = target.kind === 'page' && !!group && !own
  const shown = inheriting && groupConfig ? groupConfig : draft
  const dirty = own !== savedOwn || (!inheriting && JSON.stringify(draft) !== JSON.stringify(savedConfig))

  // Rời trang khi chưa lưu thì hỏi lại.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const platforms: Platform[] = useMemo(() => {
    if (page) return [page.platform]
    const ps = group ? [...new Set(pagesInGroup(group.id).map((p) => p.platform))] : []
    return ps.length ? ps : ['facebook', 'instagram', 'threads']
  }, [page, group])
  const channels = CHANNELS.filter((c) => c.platforms.some((p) => platforms.includes(p)))

  if (!exists)
    return (
      <Card>
        <EmptyState icon={<Bot size={22} />} title="Không tìm thấy trang hoặc nhóm này">
          Chọn một mục khác ở cây bên trái.
        </EmptyState>
      </Card>
    )

  const name = target.kind === 'group' ? group!.name : page!.name
  const set = (p: Partial<AutoReplyConfig>) => setDraft((d) => ({ ...d, ...p }))

  const toggleEnabled = (v: boolean) => {
    if (v && !openAiKeySet) return
    if (v && !draft.prompt.trim()) {
      setPromptError(true)
      return
    }
    set({ enabled: v })
  }

  const toggleOwn = (v: boolean) => {
    if (v) {
      setDraft(structuredClone(groupConfig ?? draft))
      setOwn(true)
    } else setConfirmOff(true)
  }

  const save = () => {
    if (!inheriting && draft.enabled && !draft.prompt.trim()) {
      setPromptError(true)
      notify('Viết kịch bản cho AI trước khi lưu.')
      return
    }
    const configs = { ...store.configs }
    const ownMap = { ...store.own }
    if (target.kind === 'group' || own) configs[key] = structuredClone(draft)
    else delete configs[key]
    if (target.kind === 'page') ownMap[target.id] = own
    commit({ configs, own: ownMap })
    notify(`Đã lưu cấu hình AI cho ${name}`)
  }

  const cancel = () => {
    setOwn(savedOwn)
    setDraft(structuredClone(savedConfig))
    setPromptError(false)
    notify('Đã huỷ thay đổi')
  }

  const addKeyword = () => {
    const k = kwInput.trim().replace(/,$/, '')
    if (k && !draft.keywords.includes(k)) set({ keywords: [...draft.keywords, k] })
    setKwInput('')
  }

  const fillFromBrand = () => {
    const prompt =
      domain === 'beauty'
        ? `Bạn là nhân viên tư vấn của ${brandProfile.name} — "${brandProfile.tagline}". Xưng hô: ${brandProfile.pronoun}. Giọng: ${brandProfile.tones.join(', ').toLowerCase()}. Emoji: ${brandProfile.emoji.toLowerCase()}.

Khách hàng chính: ${brandProfile.audience}

Sản phẩm chủ lực:
${brandProfile.products.map((p) => `- ${p.name}: ${p.price}`).join('\n')}

Không dùng các cụm: ${brandProfile.banned.map((b) => `"${b}"`).join(', ')}.
Khi khách muốn mua, xin số điện thoại và địa chỉ nhận hàng.`
        : PROMPTS[domain]
    set({ prompt })
    setPromptError(false)
    notify(`Đã lấy kịch bản từ Hồ sơ thương hiệu của ${group?.name ?? name}`)
  }

  const applyTemplate = (label: string) => {
    const map: Record<string, Domain> = { 'Mỹ phẩm': 'beauty', 'Gia dụng': 'home', 'Thời trang': 'fashion' }
    const d = map[label]
    if (!d) return
    set({ prompt: PROMPTS[d] })
    setPromptError(false)
  }

  const checkedChannels = channels.filter((c) => shown.channels[c.key]).length

  return (
    <div className="@container">
      <div className="grid items-start gap-6 @3xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-5">
          {/* Tiêu đề mục đang cấu hình */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {page ? (
              <PageLabel page={page} sub={`${platformLabel[page.platform]} · ${group ? group.name : 'Chưa có nhóm'}`} />
            ) : (
              <div className="flex items-center gap-3">
                <GroupChip groupId={group!.id} />
                <span className="text-[13px] text-muted-foreground">Cấu hình mặc định cho {pagesInGroup(group!.id).length} trang trong nhóm</span>
              </div>
            )}
          </div>

          {!openAiKeySet && (
            <div className="flex items-center gap-3 rounded-md border border-amber-200 bg-warning-soft px-4 py-3 text-sm text-amber-900">
              <TriangleAlert size={16} className="shrink-0 text-warning" />
              <span className="flex-1">Chưa có khoá OpenAI nên AI chưa thể trả lời. Công tắc AI đang bị khoá.</span>
              <Link to="/cai-dat" className="font-medium text-primary hover:underline">
                Thêm khoá OpenAI ở Cài đặt
              </Link>
            </div>
          )}

          {target.kind === 'page' && <InheritanceBar groupName={group?.name ?? null} own={own} onToggle={toggleOwn} what="cấu hình AI" />}

          {target.kind === 'group' && group && <GroupMembers groupId={group.id} store={store} />}

          {inheriting && group && (
            <p className="-mt-2 text-[13px] text-muted-foreground">
              Các mục dưới đây là cấu hình của {group.name}, chỉ để xem. Bật “Dùng cấu hình AI riêng” để chỉnh riêng cho trang này, hoặc{' '}
              <Link to={`/ai-tra-loi?muc=group:${group.id}`} className="font-medium text-primary hover:underline">
                sửa cấu hình nhóm
              </Link>
              .
            </p>
          )}

          <fieldset disabled={inheriting} className={cn('min-w-0 space-y-5', inheriting && 'opacity-70')}>
            {/* Bật/Tắt */}
            <Card className={cn('p-5', shown.enabled && 'border-violet-200')}>
              <div className="flex items-center gap-4">
                <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-full', shown.enabled ? 'bg-ai-soft text-ai' : 'bg-slate-100 text-muted-foreground')}>
                  <Bot size={22} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-base font-semibold">AI trả lời tự động</div>
                  <p className="text-[13px] text-muted-foreground">
                    {shown.enabled
                      ? 'AI đang trả lời tin nhắn và bình luận theo cấu hình bên dưới.'
                      : 'AI đang tắt. Tin nhắn mới sẽ vào thẳng tab “Cần xử lý” trong Hộp thư.'}
                  </p>
                </div>
                <AiLockHint locked={!openAiKeySet} align="end">
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    <span className={shown.enabled ? 'text-ai' : 'text-muted-foreground'}>{shown.enabled ? 'Đang bật' : 'Đang tắt'}</span>
                    <span className={cn('origin-right scale-125', !openAiKeySet && 'pointer-events-none opacity-50')}>
                      <Switch checked={shown.enabled} onChange={toggleEnabled} ai label="AI trả lời tự động" />
                    </span>
                  </span>
                </AiLockHint>
              </div>
            </Card>

            {/* Giờ hoạt động */}
            <Card>
              <CardHeader title="Giờ hoạt động" subtitle="Khi nào AI được tự trả lời" />
              <div className="space-y-4 p-4">
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Giờ hoạt động">
                  {(
                    [
                      ['always', 'Luôn bật', 'AI trả lời 24/7'],
                      ['offhours', 'Ngoài giờ làm việc', 'Bạn trực trong giờ, AI trực ngoài giờ'],
                      ['custom', 'Tuỳ chỉnh', 'AI trả lời trong khung giờ bạn chọn'],
                    ] as const
                  ).map(([id, label, hint]) => (
                    <label
                      key={id}
                      className={cn(
                        'flex min-w-48 flex-1 cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5',
                        shown.schedule === id ? 'border-primary bg-primary-soft/30' : 'border-border hover:bg-slate-50',
                      )}
                    >
                      <input type="radio" name={`schedule-${key}`} checked={shown.schedule === id} onChange={() => set({ schedule: id })} className="mt-1 accent-primary" />
                      <span>
                        <span className="block text-sm font-medium">{label}</span>
                        <span className="block text-xs text-muted-foreground">{hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {shown.schedule !== 'always' && (
                  <div>
                    <p className="mb-2 text-[13px] text-muted-foreground">
                      {shown.schedule === 'offhours'
                        ? 'Giờ làm việc của bạn — AI chỉ trả lời ngoài các khung giờ này.'
                        : 'AI chỉ trả lời trong các khung giờ này.'}
                    </p>
                    <div className="divide-y divide-border rounded-md border border-border">
                      {shown.ranges.map((r, i) => (
                        <div key={r.day} className="flex items-center gap-3 px-3 py-1.5">
                          <label className="flex w-16 items-center gap-2 text-sm font-medium">
                            <input
                              type="checkbox"
                              checked={r.on}
                              onChange={(e) => set({ ranges: shown.ranges.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)) })}
                              className="size-4 accent-primary"
                            />
                            {r.day}
                          </label>
                          {r.on ? (
                            <span className="flex items-center gap-2 text-sm">
                              <input
                                type="time"
                                value={r.from}
                                aria-label={`${r.day} từ`}
                                onChange={(e) => set({ ranges: shown.ranges.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })}
                                className="h-8 rounded-sm border border-border px-2 text-sm focus:border-primary focus:outline-none"
                              />
                              –
                              <input
                                type="time"
                                value={r.to}
                                aria-label={`${r.day} đến`}
                                onChange={(e) => set({ ranges: shown.ranges.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })}
                                className="h-8 rounded-sm border border-border px-2 text-sm focus:border-primary focus:outline-none"
                              />
                            </span>
                          ) : (
                            <span className="text-[13px] text-muted-foreground">{shown.schedule === 'offhours' ? 'Nghỉ — AI trả lời cả ngày' : 'AI không trả lời'}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Card>

            {/* Kênh */}
            <Card>
              <CardHeader
                title="Kênh"
                subtitle="AI trả lời ở đâu"
                action={
                  <span className="flex items-center gap-1">
                    {platforms.map((p) => (
                      <PlatformIcon key={p} platform={p} size={18} />
                    ))}
                  </span>
                }
              />
              <div className="space-y-2 p-4">
                {channels.map((c) => (
                  <label key={c.key} className="flex cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={shown.channels[c.key]}
                      onChange={(e) => set({ channels: { ...shown.channels, [c.key]: e.target.checked } })}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span className="flex-1">
                      <span className="block text-sm font-medium">{c.label}</span>
                      <span className="block text-xs text-muted-foreground">{c.hint}</span>
                    </span>
                    <span className="flex gap-1">
                      {c.platforms
                        .filter((p) => platforms.includes(p))
                        .map((p) => (
                          <PlatformIcon key={p} platform={p} size={14} />
                        ))}
                    </span>
                  </label>
                ))}
                {platforms.includes('threads') && (
                  <p className="rounded-sm bg-slate-50 px-3 py-2 text-xs text-muted-foreground">
                    Threads chưa có API tin nhắn riêng — với trang Threads, AI chỉ trả lời công khai dưới bài đăng.
                  </p>
                )}
                {shown.enabled && checkedChannels === 0 && <p className="text-xs text-danger">Chọn ít nhất một kênh để AI có thể trả lời.</p>}
              </div>
            </Card>

            {/* Kịch bản */}
            <Card>
              <CardHeader
                title="Kịch bản cho AI"
                subtitle="Cách AI xưng hô, giọng điệu và điều cần tránh"
                action={
                  <button type="button" onClick={fillFromBrand} className="text-[13px] font-medium whitespace-nowrap text-primary hover:underline disabled:no-underline">
                    Lấy từ Hồ sơ thương hiệu
                  </button>
                }
              />
              <div className="space-y-2 p-4">
                <div className="flex items-center justify-end gap-2">
                  <Select
                    options={['Mẫu theo ngành…', 'Mỹ phẩm', 'Gia dụng', 'Thời trang']}
                    value="Mẫu theo ngành…"
                    onChange={(e) => applyTemplate(e.target.value)}
                    className="h-8 w-48 text-[13px]"
                    aria-label="Chọn mẫu kịch bản theo ngành"
                  />
                </div>
                <Textarea
                  rows={9}
                  value={shown.prompt}
                  onChange={(e) => {
                    set({ prompt: e.target.value })
                    if (e.target.value.trim()) setPromptError(false)
                  }}
                  aria-label="Kịch bản cho AI"
                  aria-invalid={promptError}
                  className={cn('leading-relaxed', promptError && 'border-danger focus:border-danger focus:ring-red-100')}
                />
                <div className="flex justify-between text-xs">
                  {promptError ? <span className="text-danger">Viết kịch bản trước khi bật AI.</span> : <span className="text-muted-foreground">AI luôn trả lời theo kịch bản này và kho kiến thức bên dưới.</span>}
                  <span className="tabular text-muted-foreground">{shown.prompt.length} ký tự</span>
                </div>
              </div>
            </Card>

            {/* Kho kiến thức */}
            <Card>
              <CardHeader
                title="Kho kiến thức"
                subtitle="Câu hỏi thường gặp, bảng giá, chính sách"
                action={
                  <Button size="sm" icon={<Plus size={14} />} onClick={() => setAddOpen(true)}>
                    Thêm
                  </Button>
                }
              />
              {shown.knowledge.length === 0 ? (
                <EmptyState icon={<BookOpen size={20} />} title="Kho kiến thức đang trống">
                  Thêm câu hỏi thường gặp hoặc tải bảng giá để AI trả lời đúng hơn.
                </EmptyState>
              ) : (
                <ul className="divide-y divide-border">
                  {shown.knowledge.map((k) => (
                    <li key={k.id} className="flex items-start gap-3 px-4 py-3">
                      <span className="mt-0.5 rounded-md bg-slate-100 p-1.5 text-muted-foreground">
                        {k.kind === 'file' ? <FileText size={16} /> : <MessageCircleQuestion size={16} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{k.title}</span>
                        <span className="block text-xs text-muted-foreground">{k.kind === 'file' ? k.detail : k.detail.charAt(0).toUpperCase() + k.detail.slice(1)}</span>
                      </span>
                      <Chip>{k.kind === 'file' ? 'File' : 'Hỏi đáp'}</Chip>
                      <button
                        type="button"
                        onClick={() => set({ knowledge: shown.knowledge.filter((x) => x.id !== k.id) })}
                        className="rounded-md p-1 text-muted-foreground hover:bg-red-50 hover:text-danger"
                        aria-label={`Xoá ${k.title}`}
                      >
                        <Trash size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Chuyển cho bạn khi */}
            <Card>
              <CardHeader title="Chuyển cho bạn khi" subtitle="AI dừng lại, hội thoại vào tab “Cần xử lý” kèm lý do" />
              <div className="space-y-4 p-4">
                <div>
                  <div className="mb-1.5 text-[13px] font-medium">Khách nhắc tới từ khoá</div>
                  <div className="flex flex-wrap items-center gap-1.5 rounded-sm border border-border p-2 focus-within:border-primary">
                    {shown.keywords.map((k) => (
                      <span key={k} className="inline-flex items-center gap-1 rounded-full bg-warning-soft py-0.5 pr-1 pl-2 text-xs font-medium text-amber-900">
                        {k}
                        <button type="button" onClick={() => set({ keywords: shown.keywords.filter((x) => x !== k) })} aria-label={`Bỏ từ khoá ${k}`} className="rounded-full p-0.5 hover:bg-amber-200/60">
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                    <input
                      value={kwInput}
                      onChange={(e) => setKwInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault()
                          addKeyword()
                        } else if (e.key === 'Backspace' && !kwInput && shown.keywords.length) set({ keywords: shown.keywords.slice(0, -1) })
                      }}
                      onBlur={addKeyword}
                      placeholder={shown.keywords.length ? 'Thêm từ khoá…' : 'Ví dụ: đổi trả, bảo hành'}
                      aria-label="Thêm từ khoá chuyển cho bạn"
                      className="h-6 min-w-32 flex-1 bg-transparent text-sm focus:outline-none"
                    />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">Nhấn Enter để thêm.</p>
                </div>
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" checked={shown.uncertain} onChange={(e) => set({ uncertain: e.target.checked })} className="mt-0.5 size-4 accent-primary" />
                  <span>
                    <span className="block text-sm font-medium">AI không chắc chắn câu trả lời</span>
                    <span className="block text-xs text-muted-foreground">Thông tin không có trong kịch bản và kho kiến thức</span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3">
                  <input type="checkbox" checked={shown.askHuman} onChange={(e) => set({ askHuman: e.target.checked })} className="mt-0.5 size-4 accent-primary" />
                  <span>
                    <span className="block text-sm font-medium">Khách yêu cầu gặp người</span>
                    <span className="block text-xs text-muted-foreground">Ví dụ: “cho mình gặp nhân viên”, “gọi điện cho mình”</span>
                  </span>
                </label>
              </div>
            </Card>
          </fieldset>
        </div>

        <TestChat config={shown} domain={domain} name={name} keyReady={openAiKeySet} />
      </div>

      {/* Footer cố định */}
      <div className="sticky bottom-0 z-10 mt-6 flex items-center gap-3 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur">
        <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
          {dirty ? (
            <>
              <span className="size-2 rounded-full bg-warning" /> Có thay đổi chưa lưu
            </>
          ) : (
            <>Đã lưu · {inheriting ? `theo ${group?.name}` : name}</>
          )}
        </span>
        <Button variant="ghost" className="ml-auto" onClick={cancel} disabled={!dirty}>
          Huỷ
        </Button>
        <Button variant="primary" onClick={save} disabled={!dirty}>
          Lưu cấu hình
        </Button>
      </div>

      <AddKnowledgeModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={(item) => {
          set({ knowledge: [...draft.knowledge, item] })
          notify(`Đã thêm “${item.title}” vào kho kiến thức`)
        }}
      />

      <Modal
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="Bỏ cấu hình AI riêng?"
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOff(false)}>
              Giữ cấu hình riêng
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setOwn(false)
                setConfirmOff(false)
              }}
            >
              Bỏ cấu hình riêng
            </Button>
          </>
        }
      >
        <p className="text-sm">
          <b>{name}</b> sẽ quay lại dùng cấu hình AI của <b>{group?.name}</b>. Kịch bản, kho kiến thức và quy tắc riêng của trang này sẽ bị bỏ khi bạn lưu.
        </p>
      </Modal>
    </div>
  )
}

/* ---------- Thành viên nhóm (khi cấu hình một nhóm) ---------- */

function GroupMembers({ groupId, store }: { groupId: string; store: StoreState }) {
  const members = pagesInGroup(groupId)
  if (!members.length) return null
  const overriding = members.filter((p) => store.own[p.id])
  return (
    <div className="rounded-md border border-primary/30 bg-primary-soft/40 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span>Áp dụng cho:</span>
        {members.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1.5">
            <PageAvatar page={p} size={20} />
            <span className="text-[13px] font-medium">{p.name}</span>
            {store.own[p.id] && <Chip className="!py-0 text-[11px]">Riêng</Chip>}
          </span>
        ))}
      </div>
      {overriding.length > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {overriding.map((p) => p.name).join(', ')} đang dùng cấu hình AI riêng nên không theo các thay đổi ở đây.
        </p>
      )}
    </div>
  )
}

/* ---------- Thêm vào kho kiến thức ---------- */

function AddKnowledgeModal({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (k: KnowledgeItem) => void }) {
  const [mode, setMode] = useState<'faq' | 'file'>('faq')
  const [q, setQ] = useState('')
  const [a, setA] = useState('')
  const [file, setFile] = useState<{ name: string; size: number } | null>(null)

  const reset = () => {
    setQ('')
    setA('')
    setFile(null)
    setMode('faq')
  }
  const close = () => {
    reset()
    onClose()
  }
  const valid = mode === 'faq' ? !!q.trim() && !!a.trim() : !!file
  const submit = () => {
    if (!valid) return
    if (mode === 'faq') onAdd({ id: `k-${Date.now()}`, kind: 'faq', title: q.trim(), detail: a.trim() })
    else if (file) {
      const ext = file.name.split('.').pop()?.toUpperCase() ?? 'FILE'
      const size = file.size > 1024 * 1024 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`
      onAdd({ id: `k-${Date.now()}`, kind: 'file', title: file.name, detail: `${ext} · ${size} · AI đang đọc nội dung` })
    }
    close()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Thêm vào kho kiến thức"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Huỷ
          </Button>
          <Button variant="primary" onClick={submit} disabled={!valid}>
            Thêm vào kho
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { id: 'faq', label: 'Câu hỏi thường gặp' },
            { id: 'file', label: 'Tải file lên' },
          ]}
        />
        {mode === 'faq' ? (
          <>
            <Field label="Câu hỏi">
              <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ví dụ: Phí giao hàng?" />
            </Field>
            <Field label="Câu trả lời" hint="Viết như bạn trả lời khách. AI sẽ diễn đạt lại theo giọng của trang.">
              <Textarea rows={4} value={a} onChange={(e) => setA(e.target.value)} placeholder="Ví dụ: Nội thành miễn phí, tỉnh khác 30.000đ." />
            </Field>
          </>
        ) : (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border px-6 py-8 text-center hover:border-primary/50 hover:bg-primary-soft/20">
            <Upload size={22} className="text-muted-foreground" />
            {file ? (
              <span className="text-sm font-medium">{file.name}</span>
            ) : (
              <>
                <span className="text-sm font-medium">Chọn file bảng giá, chính sách…</span>
                <span className="text-xs text-muted-foreground">PDF, DOCX, XLSX, CSV hoặc TXT · tối đa 10 MB</span>
              </>
            )}
            <input
              type="file"
              accept=".pdf,.docx,.xlsx,.csv,.txt"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) setFile({ name: f.name, size: f.size })
              }}
            />
          </label>
        )}
      </div>
    </Modal>
  )
}

/* ---------- Khung "Thử AI" ---------- */

type TestMsg = { id: number; from: 'customer' | 'ai' | 'system'; text: string }

function TestChat({ config, domain, name, keyReady }: { config: AutoReplyConfig; domain: Domain; name: string; keyReady: boolean }) {
  const [msgs, setMsgs] = useState<TestMsg[]>([])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const timer = useRef<number | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [msgs.length, typing])

  const push = (from: TestMsg['from'], text: string) => setMsgs((m) => [...m, { id: Date.now() + Math.random(), from, text }])

  const send = (raw?: string) => {
    const text = (raw ?? input).trim()
    if (!text || typing) return
    setInput('')
    push('customer', text)
    if (!keyReady) return push('system', 'Chưa có khoá OpenAI — thêm khoá ở Cài đặt để thử AI.')
    if (!config.enabled) return push('system', 'AI đang tắt cho mục này. Khách sẽ không nhận trả lời tự động.')
    const { reply, handoff } = simulateReply(text, config, domain)
    setTyping(true)
    timer.current = window.setTimeout(() => {
      push('ai', reply)
      if (handoff) push('system', `AI sẽ chuyển cho bạn · ${handoff}`)
      setTyping(false)
    }, 1100)
  }

  return (
    <Card className="flex flex-col @3xl:sticky @3xl:top-6">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Thử AI <AiBadge label="Mô phỏng" />
          </span>
        }
        subtitle={`Gõ như khách nhắn ${name}. Dùng cấu hình đang chỉnh, chưa cần lưu.`}
        action={
          msgs.length > 0 ? (
            <button onClick={() => setMsgs([])} className="rounded-md p-1 text-muted-foreground hover:bg-slate-100" aria-label="Làm mới cuộc thử" title="Làm mới">
              <RotateCcw size={15} />
            </button>
          ) : undefined
        }
      />
      <div className="scrollbar-thin h-[380px] space-y-2.5 overflow-y-auto bg-background px-4 py-4">
        {msgs.length === 0 && !typing && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Sparkles size={20} className="text-ai" />
            <p className="text-[13px] text-muted-foreground">Chọn một câu hỏi mẫu hoặc tự gõ để xem AI trả lời.</p>
          </div>
        )}
        {msgs.map((m) => (
          <TestBubble key={m.id} msg={m} />
        ))}
        {typing && (
          <div className="flex">
            <span className="inline-flex items-center gap-2 rounded-lg rounded-bl-sm border border-violet-200 bg-ai-soft px-3 py-2 text-xs font-medium text-ai">
              AI đang gõ
              <span className="flex gap-1">
                {[0, 150, 300].map((d) => (
                  <span key={d} className="size-1.5 animate-bounce rounded-full bg-ai" style={{ animationDelay: `${d}ms` }} />
                ))}
              </span>
            </span>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="border-t border-border p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {SAMPLE_QUESTIONS[domain].map((s) => (
            <button key={s} onClick={() => send(s)} disabled={typing} className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-slate-50 hover:text-foreground disabled:opacity-50">
              {s}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Nhập tin nhắn thử…" aria-label="Tin nhắn thử" />
          <Button type="submit" variant="primary" icon={<Send size={15} />} disabled={!input.trim() || typing} aria-label="Gửi tin thử">
            Gửi
          </Button>
        </form>
      </div>
    </Card>
  )
}

function TestBubble({ msg }: { msg: TestMsg }) {
  if (msg.from === 'system')
    return (
      <div className="flex justify-center">
        <span className="rounded-full border border-amber-200 bg-warning-soft px-3 py-1 text-center text-xs text-amber-900">{msg.text}</span>
      </div>
    )
  if (msg.from === 'customer')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-br-sm bg-slate-200/70 px-3 py-2 text-sm">{msg.text}</div>
      </div>
    )
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        <div className="rounded-lg rounded-bl-sm border border-violet-200 bg-ai-soft px-3 py-2 text-sm">{msg.text}</div>
        <div className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-ai">
          <Sparkles size={10} /> AI trả lời
        </div>
      </div>
    </div>
  )
}

/* =====================================================================
 * Màn hình /ai-tra-loi
 * ===================================================================== */

export default function AutoReply() {
  const store = useAutoReplyStore()
  const [params, setParams] = useSearchParams()
  const raw = params.get('muc') ?? `group:${groups[0]?.id ?? ''}`
  const [kind, id] = raw.split(':') as ['group' | 'page', string]
  const target = { kind: kind === 'page' ? ('page' as const) : ('group' as const), id: id ?? '' }
  const choose = (k: 'group' | 'page', i: string) => setParams({ muc: `${k}:${i}` })

  const ungrouped = pages.filter((p) => !p.groupId)
  const onCount = pages.filter((p) => effectiveForPage(store, p.id, p.groupId)?.enabled).length

  return (
    <Content>
      <PageHeader title="AI trả lời tự động" subtitle={`Chọn nhóm hoặc trang để thiết lập cách AI trả lời tin nhắn và bình luận · AI đang bật cho ${onCount}/${pages.length} trang`} />
      <div className="grid grid-cols-[280px_minmax(0,1fr)] items-start gap-6">
        <Card className="sticky top-6">
          <CardHeader title="Áp dụng cho" />
          <nav className="max-h-[calc(100vh-200px)] space-y-3 overflow-y-auto p-2" aria-label="Chọn nhóm hoặc trang">
            {groups.map((g) => {
              const gc = store.configs[`group:${g.id}`]
              return (
                <div key={g.id}>
                  <TreeItem active={target.kind === 'group' && target.id === g.id} onClick={() => choose('group', g.id)}>
                    <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.color }} />
                    <span className="min-w-0 flex-1 truncate font-semibold">{g.name}</span>
                    <OnOff on={!!gc?.enabled} />
                  </TreeItem>
                  <div className="mt-0.5 space-y-0.5">
                    {pagesInGroup(g.id).map((p) => {
                      const own = !!store.own[p.id]
                      return (
                        <TreeItem key={p.id} indent active={target.kind === 'page' && target.id === p.id} onClick={() => choose('page', p.id)}>
                          <PageAvatar page={p} size={20} />
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          {own ? (
                            <span className="text-[11px] font-medium text-foreground">Riêng · {store.configs[`page:${p.id}`]?.enabled ? 'Bật' : 'Tắt'}</span>
                          ) : (
                            <span className="text-[11px] text-muted-foreground">Theo nhóm</span>
                          )}
                        </TreeItem>
                      )
                    })}
                  </div>
                </div>
              )
            })}
            {ungrouped.length > 0 && (
              <div>
                <div className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Trang chưa có nhóm</div>
                {ungrouped.map((p) => (
                  <TreeItem key={p.id} active={target.kind === 'page' && target.id === p.id} onClick={() => choose('page', p.id)}>
                    <PageAvatar page={p} size={20} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <OnOff on={!!store.configs[`page:${p.id}`]?.enabled} />
                  </TreeItem>
                ))}
              </div>
            )}
          </nav>
        </Card>

        <AutoReplyForm target={target} />
      </div>
    </Content>
  )
}

function TreeItem({ active, indent, onClick, children }: { active: boolean; indent?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-[13px] transition-colors',
        indent ? 'pl-6' : 'pl-2',
        active ? 'bg-primary-soft/60 text-foreground' : 'hover:bg-slate-50',
      )}
    >
      {children}
    </button>
  )
}

function OnOff({ on }: { on: boolean }) {
  return on ? <Chip tone="success">Bật</Chip> : <Chip>Tắt</Chip>
}
