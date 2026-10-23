import type { AutoreplyChannel, KnowledgeListResponse } from '@ottm/shared'
import { Bot, BookOpen, FileText, Loader2, MessageCircleQuestion, Plus, RotateCcw, Send, Sparkles, Trash, TriangleAlert, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
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
import {
  DAY_LABELS,
  INDUSTRY_OPTIONS,
  autoReplyFieldErrorsOf,
  autoReplyIssuesOf,
  autoReplyOf,
  blankAutoReply,
  scriptTemplateErrorMessage,
  toSaveAutoreplyRequest,
  treePageLabel,
  useAutoreplyConfig,
  useAutoreplyOverview,
  useAutoreplyScriptTemplate,
  useEffectiveAutoreply,
  useSaveAutoreplyConfig,
  useSetAutoreplyUseOwn,
  type AutoReplyConfig,
  type AutoReplyFieldErrors,
  type KnowledgeItem,
} from '../lib/autoreply'
import { usePages } from '../lib/connections'
import {
  KNOWLEDGE_FILE_ACCEPT,
  KNOWLEDGE_FILE_HINT,
  KNOWLEDGE_TOO_LARGE_MESSAGE,
  knowledgeErrorMessage,
  knowledgeFileIssue,
  knowledgeItemLine,
  knowledgeUsage,
  useAddKnowledgeFaq,
  useDeleteKnowledgeItem,
  useKnowledge,
  useUploadKnowledgeFile,
  type KnowledgeOwner,
} from '../lib/knowledge'
import { errorMessageOf } from '../lib/error-messages'
import { useGroups } from '../lib/groups'
import { isRealOwner } from '../lib/profiles'

/* =====================================================================
 * Mô hình cấu hình AI trả lời tự động (EXPERIENCE.md › Cấu hình AI trả lời tự động)
 * Nhóm/trang thật (id uuid) đọc/lưu qua API (Story 5.1, `lib/autoreply.ts`); id kho mẫu vẫn chạy dữ liệu mẫu.
 * ===================================================================== */

type Domain = 'beauty' | 'home' | 'fashion'

const CHANNELS: { key: AutoreplyChannel; label: string; hint: string; platforms: Platform[] }[] = [
  { key: 'messenger', label: 'Tin nhắn Messenger', hint: 'Trả lời tin nhắn gửi tới Fanpage', platforms: ['facebook'] },
  { key: 'ig_direct', label: 'Instagram Direct', hint: 'Trả lời tin nhắn riêng trên Instagram', platforms: ['instagram'] },
  { key: 'comment_public', label: 'Trả lời bình luận công khai', hint: 'Trả lời ngay dưới bình luận của khách', platforms: ['facebook', 'instagram', 'threads'] },
  { key: 'comment_private', label: 'Nhắn riêng cho người bình luận', hint: 'Gửi tin nhắn riêng khi khách bình luận hỏi giá', platforms: ['facebook', 'instagram'] },
]

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
/** Câu thử cho nhóm/trang thật (không gắn ngành mẫu). */
const REAL_SAMPLE_QUESTIONS = ['Sản phẩm này giá bao nhiêu?', 'Mình muốn đổi trả', 'Cho mình gặp nhân viên']

const domainOf = (groupId: string | null): Domain => (groupId === 'g-beauty' ? 'beauty' : groupId === 'g-home' ? 'home' : 'fashion')

/** Mẫu ngành của kho mẫu theo nhãn ở ô "Mẫu theo ngành". */
const MOCK_TEMPLATE_DOMAIN: Record<string, Domain> = { 'Mỹ phẩm': 'beauty', 'Gia dụng': 'home', 'Thời trang': 'fashion' }

const makeConfig = (domain: Domain, patch: Partial<AutoReplyConfig> = {}): AutoReplyConfig => ({
  ...blankAutoReply(),
  enabled: true,
  channels: { messenger: true, ig_direct: true, comment_public: true, comment_private: false },
  prompt: PROMPTS[domain],
  knowledge: KNOWLEDGE[domain].map((k) => ({ ...k })),
  keywords: domain === 'home' ? ['đổi trả', 'bảo hành lỗi', 'khiếu nại', 'hoàn tiền'] : ['đổi trả', 'khiếu nại', 'hoàn tiền'],
  ...patch,
})

/* ---------- Kho cấu hình mẫu dùng chung (cây bên trái + form + màn chi tiết trang/nhóm) ---------- */

interface StoreState {
  configs: Record<string, AutoReplyConfig>
  own: Record<string, boolean>
}

function initStore(): StoreState {
  const configs: Record<string, AutoReplyConfig> = {}
  for (const g of groups) configs[`group:${g.id}`] = makeConfig(domainOf(g.id), { enabled: g.autoReply, schedule: g.id === 'g-home' ? 'offhours' : 'always' })
  if (configs['group:g-home']) configs['group:g-home'].ranges = DAY_LABELS.map((day) => ({ day, on: true, from: '08:00', to: '18:00' }))
  const own: Record<string, boolean> = {}
  for (const p of pages) {
    const g = groupById(p.groupId)
    const isOwn = !g || p.brandSource === 'own' || p.autoReply !== g.autoReply
    own[p.id] = isOwn
    if (isOwn) {
      const base = g ? structuredClone(configs[`group:${g.id}`]!) : makeConfig(domainOf(p.groupId))
      configs[`page:${p.id}`] = {
        ...base,
        enabled: p.autoReply,
        prompt: p.id === 'p3' ? PROMPT_THREADS : base.prompt,
        channels: p.id === 'p6' ? { ...base.channels, comment_public: false } : base.channels,
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

/** Cấu hình đang có hiệu lực cho một trang mẫu (riêng hoặc theo nhóm). */
const effectiveForPage = (s: StoreState, pageId: string, groupId: string | null) =>
  s.own[pageId] || !groupId ? s.configs[`page:${pageId}`] : s.configs[`group:${groupId}`]

/* ---------- Mô phỏng câu trả lời cho khung "Thử AI" ---------- */

const STOP_WORDS = new Set(['hàng', 'không', 'bao', 'lâu', 'nào', 'của', 'cho', 'được', 'phí', 'bảng', 'chính', 'sách', 'thế', 'gì', 'có'])
const ASK_HUMAN_RE = /(gặp người|gặp nhân viên|nhân viên|người thật|tư vấn viên|gọi điện|gọi cho)/

/** Luật chuyển người chạy xác định (từ khoá, khách yêu cầu gặp người) — trả lý do, hoặc `null` khi không khớp. */
function matchHandoffRule(text: string, cfg: AutoReplyConfig): string | null {
  const t = text.toLowerCase()
  const kw = cfg.keywords.find((k) => k.trim() && t.includes(k.trim().toLowerCase()))
  if (kw) return `khách nhắc tới “${kw}”`
  if (cfg.askHuman && ASK_HUMAN_RE.test(t)) return 'khách yêu cầu gặp người'
  return null
}

function simulateReply(text: string, cfg: AutoReplyConfig, domain: Domain): { reply: string; handoff?: string } {
  const t = text.toLowerCase()
  const rule = matchHandoffRule(text, cfg)
  if (rule) return { reply: cfg.handoffMessage, handoff: rule }
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

  // Chủ thật (uuid): cấu hình RIÊNG của chủ + (trang) hiệu lực đã giải kế thừa ở server — nguồn sự thật cho công tắc
  // "Dùng cấu hình AI riêng", nhãn kế thừa và cấu hình nhóm hiển thị khi trang đang theo nhóm.
  const real = isRealOwner(target.id)
  const realPage = real && target.kind === 'page'
  const owner = { ownerType: target.kind, ownerId: target.id } as const
  const configQuery = useAutoreplyConfig(owner, { enabled: real })
  const effectiveQuery = useEffectiveAutoreply(target.id, { enabled: realPage })
  const saveM = useSaveAutoreplyConfig(owner)
  const useOwnM = useSetAutoreplyUseOwn(target.id)
  const templateM = useAutoreplyScriptTemplate()

  const page = target.kind === 'page' ? (pages.find((p) => p.id === target.id) ?? null) : null
  const group = target.kind === 'group' ? groupById(target.id) : page ? groupById(page.groupId) : null
  const exists = target.kind === 'group' ? !!group : !!page
  const domain = domainOf(group?.id ?? page?.groupId ?? null)
  const key = `${target.kind}:${target.id}`

  // Trang thật thuộc nhóm: đọc thẳng cấu hình của nhóm — khi trang đang dùng riêng, hiệu lực là cấu hình trang nên
  // không suy ra được cấu hình nhóm (tắt "Dùng riêng" phải xem trước đúng cấu hình nhóm, không báo "nhóm chưa có").
  const realGroupId = realPage && group && isRealOwner(group.id) ? group.id : null
  const groupConfigQuery = useAutoreplyConfig({ ownerType: 'group', ownerId: realGroupId ?? '' }, { enabled: !!realGroupId })

  const realLoaded = real && configQuery.data !== undefined && (!realPage || effectiveQuery.data !== undefined)
  const effective = effectiveQuery.data?.effective ?? null
  const realGroupDto = groupConfigQuery.data
    ? groupConfigQuery.data.config
    : effective?.source.ownerType === 'group'
      ? effective.config
      : null
  const realGroupConfig = realGroupDto ? autoReplyOf(realGroupDto) : null
  const mockGroupConfig = group ? (store.configs[`group:${group.id}`] ?? null) : null
  const groupConfig = real ? realGroupConfig : mockGroupConfig

  const savedOwn = target.kind === 'group' || !group ? true : real ? (effectiveQuery.data?.useOwn ?? false) : !!store.own[target.id]
  const savedConfig: AutoReplyConfig = real
    ? autoReplyOf(configQuery.data?.config ?? null)
    : target.kind === 'group'
      ? (store.configs[key] ?? makeConfig(domain))
      : savedOwn
        ? (store.configs[key] ?? (mockGroupConfig ? structuredClone(mockGroupConfig) : makeConfig(domain)))
        : (mockGroupConfig ?? makeConfig(domain))

  const [own, setOwn] = useState(savedOwn)
  const [draft, setDraft] = useState<AutoReplyConfig>(() => structuredClone(savedConfig))
  const [errors, setErrors] = useState<AutoReplyFieldErrors>({})
  const [confirmOff, setConfirmOff] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [kwInput, setKwInput] = useState('')
  // Chủ thật: nạp form một lần khi dữ liệu server về (các lần refetch sau giữ chỉnh sửa đang dở).
  const seededRef = useRef(false)
  useEffect(() => {
    if (!realLoaded || seededRef.current) return
    seededRef.current = true
    setOwn(savedOwn)
    setDraft(structuredClone(savedConfig))
  }, [realLoaded, savedOwn, savedConfig])

  const inheriting = target.kind === 'page' && !!group && !own
  const shown = inheriting ? (groupConfig ?? blankAutoReply()) : draft
  const dirty = own !== savedOwn || (!inheriting && JSON.stringify(draft) !== JSON.stringify(savedConfig))
  const saving = saveM.isPending || useOwnM.isPending

  // Kho kiến thức (Story 5.2): chủ thật đọc/ghi qua API, áp ngay (không chờ Lưu). Trang đang theo nhóm — hoặc vừa bật
  // "Dùng cấu hình AI riêng" mà chưa Lưu — xem kho của nhóm, chỉ đọc; Lưu cấu hình riêng sẽ sao chép kho nhóm sang trang.
  const kbWritable = real && (target.kind === 'group' || !group || (own && savedOwn))
  const kbOwnerReal: KnowledgeOwner | null = !real
    ? null
    : kbWritable
      ? { ownerType: target.kind, ownerId: target.id }
      : realGroupId
        ? { ownerType: 'group', ownerId: realGroupId }
        : null
  const kbOwner: KnowledgeOwner = kbOwnerReal ?? { ownerType: 'group', ownerId: '' }
  const knowledgeQuery = useKnowledge(kbOwner, { enabled: !!kbOwnerReal })
  const addFaqM = useAddKnowledgeFaq(kbOwner)
  const uploadM = useUploadKnowledgeFile(kbOwner)
  const deleteM = useDeleteKnowledgeItem(kbOwner)
  const kbOver = knowledgeQuery.data ? knowledgeUsage(knowledgeQuery.data).over : false

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

  if (real && !realLoaded) {
    if (configQuery.isError || effectiveQuery.isError)
      return (
        <Card>
          <EmptyState
            icon={<Bot size={22} />}
            title="Chưa tải được cấu hình AI"
            action={<Button onClick={() => void Promise.all([configQuery.refetch(), realPage ? effectiveQuery.refetch() : null])}>Thử lại</Button>}
          >
            {errorMessageOf(configQuery.error ?? effectiveQuery.error)}
          </EmptyState>
        </Card>
      )
    return (
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]" aria-busy="true" role="status">
        <span className="sr-only">Đang tải cấu hình AI…</span>
        <div className="space-y-5">
          <Skeleton className="h-10 w-72" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-48 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
        <Skeleton className="h-[480px] rounded-lg" />
      </div>
    )
  }

  const name = target.kind === 'group' ? group!.name : page!.name
  const set = (p: Partial<AutoReplyConfig>) => setDraft((d) => ({ ...d, ...p }))
  const clearError = (field: keyof AutoReplyFieldErrors) => setErrors((e) => (e[field] ? { ...e, [field]: undefined } : e))

  const toggleEnabled = (v: boolean) => {
    if (v && !openAiKeySet) return
    if (v) {
      // Cùng luật bật của server (kịch bản, kênh, khung giờ) → không cho bật, báo dưới ô.
      const issues = autoReplyIssuesOf({ ...draft, enabled: true })
      delete issues.handoffMessage
      if (Object.keys(issues).length) {
        setErrors(issues)
        return
      }
      // Kho kiến thức vượt giới hạn → server sẽ từ chối lưu ở trạng thái bật (KNOWLEDGE_TOO_LARGE).
      if (real && kbOver) {
        setErrors({ knowledge: KNOWLEDGE_TOO_LARGE_MESSAGE })
        return
      }
    }
    set({ enabled: v })
  }

  const toggleOwn = (v: boolean) => {
    if (v) {
      // Điểm xuất phát = cấu hình nhóm hiện hành (server cũng sao chép khi Lưu).
      setDraft(structuredClone(groupConfig ?? draft))
      setOwn(true)
    } else setConfirmOff(true)
  }

  const saveReal = async () => {
    try {
      if (target.kind === 'page' && !own) {
        // Bỏ cấu hình riêng → server xoá bản riêng, trang về cấu hình nhóm.
        if (savedOwn) await useOwnM.mutateAsync(false)
        setDraft(blankAutoReply())
        notify(`${name} giờ dùng cấu hình AI của ${group?.name ?? 'nhóm'}`)
        return
      }
      const dto = await saveM.mutateAsync(toSaveAutoreplyRequest(draft))
      setDraft(autoReplyOf(dto))
      setOwn(true)
      setErrors({})
      notify(`Đã lưu cấu hình AI cho ${name}`)
    } catch (err) {
      const fe = autoReplyFieldErrorsOf(err)
      setErrors(fe)
      notify(fe.knowledge ? 'Cần rút gọn kho kiến thức trước khi bật AI.' : Object.keys(fe).length ? 'Kiểm tra lại các ô được đánh dấu.' : errorMessageOf(err))
    }
  }

  const save = () => {
    if (!inheriting) {
      const issues = autoReplyIssuesOf(draft)
      if (Object.keys(issues).length) {
        setErrors(issues)
        notify(issues.script ? 'Viết kịch bản cho AI trước khi lưu.' : 'Kiểm tra lại các ô được đánh dấu.')
        return
      }
      if (real && draft.enabled && kbOver) {
        setErrors({ knowledge: KNOWLEDGE_TOO_LARGE_MESSAGE })
        notify('Cần rút gọn kho kiến thức trước khi bật AI.')
        return
      }
    }
    if (real) {
      void saveReal()
      return
    }
    // --- Kho mẫu (như cũ) ---
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
    setErrors({})
    notify('Đã huỷ thay đổi')
  }

  const addKeyword = () => {
    const k = kwInput.trim().replace(/,$/, '')
    if (k && !draft.keywords.includes(k)) set({ keywords: [...draft.keywords, k] })
    setKwInput('')
  }

  const setPrompt = (prompt: string) => {
    set({ prompt })
    clearError('script')
  }

  const fillFromBrand = () => {
    if (real) {
      // Server dựng kịch bản từ hồ sơ hiệu lực bằng template xác định — không gọi AI (AD-2).
      templateM.mutate(
        { source: 'brand', ownerType: target.kind, ownerId: target.id },
        {
          onSuccess: (res) => {
            setPrompt(res.script)
            notify(`Đã lấy kịch bản từ Hồ sơ thương hiệu của ${res.brandSource?.name ?? name}`)
          },
          onError: (err) => notify(scriptTemplateErrorMessage(err)),
        },
      )
      return
    }
    const prompt =
      domain === 'beauty'
        ? `Bạn là nhân viên tư vấn của ${brandProfile.name} — "${brandProfile.tagline}". Xưng hô: ${brandProfile.pronoun}. Giọng: ${brandProfile.tones.join(', ').toLowerCase()}. Emoji: ${brandProfile.emoji.toLowerCase()}.

Khách hàng chính: ${brandProfile.audience}

Sản phẩm chủ lực:
${brandProfile.products.map((p) => `- ${p.name}: ${p.price}`).join('\n')}

Không dùng các cụm: ${brandProfile.banned.map((b) => `"${b}"`).join(', ')}.
Khi khách muốn mua, xin số điện thoại và địa chỉ nhận hàng.`
        : PROMPTS[domain]
    setPrompt(prompt)
    notify(`Đã lấy kịch bản từ Hồ sơ thương hiệu của ${group?.name ?? name}`)
  }

  const applyTemplate = (label: string) => {
    if (real) {
      const industry = INDUSTRY_OPTIONS.find((o) => o.label === label)?.id
      if (!industry) return
      templateM.mutate({ source: 'industry', industry }, { onSuccess: (res) => setPrompt(res.script), onError: (err) => notify(errorMessageOf(err)) })
      return
    }
    const d = MOCK_TEMPLATE_DOMAIN[label]
    if (d) setPrompt(PROMPTS[d])
  }

  const checkedChannels = channels.filter((c) => shown.channels[c.key]).length
  const channelsError = errors.channels ?? (shown.enabled && !inheriting && checkedChannels === 0 ? 'Chọn ít nhất một kênh để AI có thể trả lời.' : undefined)

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
              {groupConfig
                ? `Các mục dưới đây là cấu hình của ${group.name}, chỉ để xem. Bật “Dùng cấu hình AI riêng” để chỉnh riêng cho trang này, hoặc `
                : `${group.name} chưa có cấu hình AI nên AI chưa trả lời cho trang này. Bật “Dùng cấu hình AI riêng” để thiết lập riêng, hoặc `}
              <Link to={`/ai-tra-loi?muc=group:${group.id}`} className="font-medium text-primary hover:underline">
                {groupConfig ? 'sửa cấu hình nhóm' : 'thiết lập cho nhóm'}
              </Link>
              .
            </p>
          )}

          <fieldset disabled={inheriting || saving} className={cn('min-w-0 space-y-5', inheriting && 'opacity-70')}>
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
                      <input
                        type="radio"
                        name={`schedule-${key}`}
                        checked={shown.schedule === id}
                        onChange={() => {
                          set({ schedule: id })
                          clearError('hours')
                        }}
                        className="mt-1 accent-primary"
                      />
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
                    <div className={cn('divide-y divide-border rounded-md border', errors.hours ? 'border-danger' : 'border-border')}>
                      {shown.ranges.map((r, i) => (
                        <div key={r.day} className="flex items-center gap-3 px-3 py-1.5">
                          <label className="flex w-16 items-center gap-2 text-sm font-medium">
                            <input
                              type="checkbox"
                              checked={r.on}
                              onChange={(e) => {
                                set({ ranges: shown.ranges.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)) })
                                clearError('hours')
                              }}
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
                    {errors.hours && <p className="mt-1 text-xs text-danger">{errors.hours}</p>}
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
                      onChange={(e) => {
                        set({ channels: { ...shown.channels, [c.key]: e.target.checked } })
                        clearError('channels')
                      }}
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
                {channelsError && <p className="text-xs text-danger">{channelsError}</p>}
              </div>
            </Card>

            {/* Kịch bản */}
            <Card>
              <CardHeader
                title="Kịch bản cho AI"
                subtitle="Cách AI xưng hô, giọng điệu và điều cần tránh"
                action={
                  <button
                    type="button"
                    onClick={fillFromBrand}
                    disabled={templateM.isPending}
                    className="text-[13px] font-medium whitespace-nowrap text-primary hover:underline disabled:no-underline disabled:opacity-60"
                  >
                    Lấy từ Hồ sơ thương hiệu
                  </button>
                }
              />
              <div className="space-y-2 p-4">
                <div className="flex items-center justify-end gap-2">
                  <Select
                    options={['Mẫu theo ngành…', ...(real ? INDUSTRY_OPTIONS.map((o) => o.label) : Object.keys(MOCK_TEMPLATE_DOMAIN))]}
                    value="Mẫu theo ngành…"
                    onChange={(e) => applyTemplate(e.target.value)}
                    disabled={templateM.isPending}
                    className="h-8 w-48 text-[13px]"
                    aria-label="Chọn mẫu kịch bản theo ngành"
                  />
                </div>
                <Textarea
                  rows={9}
                  value={shown.prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  aria-label="Kịch bản cho AI"
                  aria-invalid={!!errors.script}
                  className={cn('leading-relaxed', errors.script && 'border-danger focus:border-danger focus:ring-red-100')}
                />
                <div className="flex justify-between text-xs">
                  {errors.script ? <span className="text-danger">{errors.script}</span> : <span className="text-muted-foreground">AI luôn trả lời theo kịch bản này và kho kiến thức bên dưới.</span>}
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
                  <Button size="sm" icon={<Plus size={14} />} onClick={() => setAddOpen(true)} disabled={real && !kbWritable}>
                    Thêm
                  </Button>
                }
              />
              {real ? (
                <RealKnowledge
                  data={knowledgeQuery.data}
                  failed={knowledgeQuery.isError && !knowledgeQuery.data}
                  onRetry={() => void knowledgeQuery.refetch()}
                  writable={kbWritable}
                  note={
                    !kbWritable && own && target.kind === 'page'
                      ? `Đang hiện kho kiến thức của ${group?.name ?? 'nhóm'}. Lưu cấu hình riêng để sao chép sang trang này rồi sửa.`
                      : null
                  }
                  error={errors.knowledge}
                  deletingId={deleteM.isPending ? deleteM.variables : undefined}
                  onDelete={(item) =>
                    deleteM.mutate(item.id, {
                      onSuccess: () => {
                        clearError('knowledge')
                        notify(`Đã xoá “${item.title}” khỏi kho kiến thức`)
                      },
                      onError: (err) => notify(knowledgeErrorMessage(err)),
                    })
                  }
                />
              ) : shown.knowledge.length === 0 ? (
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
                <Field label="Câu AI nói trước khi chuyển" hint={errors.handoffMessage ? undefined : 'Gửi cho khách khi khớp từ khoá hoặc khách muốn gặp người.'}>
                  <Input
                    value={shown.handoffMessage}
                    onChange={(e) => {
                      set({ handoffMessage: e.target.value })
                      clearError('handoffMessage')
                    }}
                    aria-invalid={!!errors.handoffMessage}
                    className={cn(errors.handoffMessage && 'border-danger')}
                  />
                </Field>
                {errors.handoffMessage && <p className="-mt-2 text-xs text-danger">{errors.handoffMessage}</p>}
              </div>
            </Card>
          </fieldset>
        </div>

        <TestChat config={shown} domain={domain} name={name} keyReady={openAiKeySet} real={real} />
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
        <Button variant="ghost" className="ml-auto" onClick={cancel} disabled={!dirty || saving}>
          Huỷ
        </Button>
        <Button variant="primary" onClick={save} disabled={!dirty || saving}>
          {saving ? 'Đang lưu…' : 'Lưu cấu hình'}
        </Button>
      </div>

      <AddKnowledgeModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={async (input) => {
          if (real) {
            try {
              const item =
                input.kind === 'faq' ? await addFaqM.mutateAsync({ question: input.question, answer: input.answer }) : await uploadM.mutateAsync(input.file)
              notify(item.kind === 'file' ? `Đã tải “${item.title}” lên — AI đang đọc nội dung` : `Đã thêm “${item.title}” vào kho kiến thức`)
              return null
            } catch (err) {
              return knowledgeErrorMessage(err)
            }
          }
          // --- Kho mẫu (như cũ) ---
          const item: KnowledgeItem =
            input.kind === 'faq'
              ? { id: `k-${Date.now()}`, kind: 'faq', title: input.question, detail: input.answer }
              : {
                  id: `k-${Date.now()}`,
                  kind: 'file',
                  title: input.file.name,
                  detail: `${input.file.name.split('.').pop()?.toUpperCase() ?? 'FILE'} · ${input.file.size > 1024 * 1024 ? `${(input.file.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(input.file.size / 1024))} KB`} · AI đang đọc nội dung`,
                }
          set({ knowledge: [...draft.knowledge, item] })
          notify(`Đã thêm “${item.title}” vào kho kiến thức`)
          return null
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
  const overview = useAutoreplyOverview({ enabled: isRealOwner(groupId) })
  const members = pagesInGroup(groupId)
  if (!members.length) return null
  // Trang thật: chế độ dẫn xuất từ server; trang mẫu: kho mẫu.
  const isOwn = (pageId: string) =>
    isRealOwner(pageId) ? overview.data?.pages.find((p) => p.pageId === pageId)?.mode === 'own' : !!store.own[pageId]
  const overriding = members.filter((p) => isOwn(p.id))
  return (
    <div className="rounded-md border border-primary/30 bg-primary-soft/40 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span>Áp dụng cho:</span>
        {members.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1.5">
            <PageAvatar page={p} size={20} />
            <span className="text-[13px] font-medium">{p.name}</span>
            {isOwn(p.id) && <Chip className="!py-0 text-[11px]">Riêng</Chip>}
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

/* ---------- Kho kiến thức của chủ thật (Story 5.2) ---------- */

const KB_TONE: Record<ReturnType<typeof knowledgeItemLine>['tone'], string> = {
  normal: 'text-muted-foreground',
  busy: 'text-ai',
  danger: 'text-danger',
  warning: 'text-amber-800',
}

/**
 * Danh sách kho (cũ → mới), mức dùng token và lỗi "cần rút gọn". Dòng đang đọc nội dung tự đổi khi server phát
 * `knowledge_item.processed`. `writable=false` → chỉ xem (trang đang theo nhóm).
 */
function RealKnowledge({
  data,
  failed,
  onRetry,
  writable,
  note,
  error,
  deletingId,
  onDelete,
}: {
  data: KnowledgeListResponse | undefined
  failed: boolean
  onRetry: () => void
  writable: boolean
  note: string | null
  error: string | undefined
  deletingId: string | undefined
  onDelete: (item: KnowledgeListResponse['items'][number]) => void
}) {
  if (failed)
    return (
      <EmptyState icon={<BookOpen size={20} />} title="Chưa tải được kho kiến thức" action={<Button onClick={onRetry}>Thử lại</Button>} />
    )
  if (!data)
    return (
      <div className="space-y-2 p-4" aria-busy="true" role="status">
        <span className="sr-only">Đang tải kho kiến thức…</span>
        <Skeleton className="h-10 rounded-md" />
        <Skeleton className="h-10 rounded-md" />
      </div>
    )
  const usage = knowledgeUsage(data)
  return (
    <div>
      {note && <p className="border-b border-border px-4 py-2 text-[13px] text-muted-foreground">{note}</p>}
      {data.items.length === 0 ? (
        <EmptyState icon={<BookOpen size={20} />} title="Kho kiến thức đang trống">
          Thêm câu hỏi thường gặp hoặc tải bảng giá, chính sách để AI trả lời đúng hơn.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {data.items.map((k) => {
            const line = knowledgeItemLine(k)
            return (
              <li key={k.id} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 rounded-md bg-slate-100 p-1.5 text-muted-foreground">
                  {k.status === 'processing' ? <Loader2 size={16} className="animate-spin text-ai" /> : k.kind === 'file' ? <FileText size={16} /> : <MessageCircleQuestion size={16} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium break-words">{k.title}</span>
                  <span className={cn('block text-xs break-words', KB_TONE[line.tone])}>{line.text}</span>
                </span>
                <Chip tone={k.status === 'failed' ? 'danger' : k.status === 'too_large' ? 'warning' : 'neutral'}>
                  {k.status === 'failed' ? 'Lỗi' : k.status === 'too_large' ? 'Quá lớn' : k.kind === 'file' ? 'File' : 'Hỏi đáp'}
                </Chip>
                {writable && (
                  <button
                    type="button"
                    onClick={() => onDelete(k)}
                    disabled={deletingId === k.id}
                    className="rounded-md p-1 text-muted-foreground hover:bg-red-50 hover:text-danger disabled:opacity-50"
                    aria-label={`Xoá ${k.title}`}
                  >
                    <Trash size={15} />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <div className="space-y-1 border-t border-border px-4 py-2.5">
        <div className="flex items-center gap-3 text-xs">
          <span className={cn('tabular', usage.over ? 'font-medium text-danger' : 'text-muted-foreground')}>{usage.text}</span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
            <span className={cn('block h-full rounded-full', usage.over ? 'bg-danger' : 'bg-ai')} style={{ width: `${Math.round(usage.ratio * 100)}%` }} />
          </span>
        </div>
        {(error || usage.over) && <p className="text-xs text-danger">{error ?? KNOWLEDGE_TOO_LARGE_MESSAGE}</p>}
      </div>
    </div>
  )
}

/* ---------- Thêm vào kho kiến thức ---------- */

type KnowledgeInput = { kind: 'faq'; question: string; answer: string } | { kind: 'file'; file: File }

/** `onSubmit` trả câu lỗi (giữ modal mở, hiện dưới form) hoặc `null` khi đã thêm. */
function AddKnowledgeModal({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (input: KnowledgeInput) => Promise<string | null> }) {
  const [mode, setMode] = useState<'faq' | 'file'>('faq')
  const [q, setQ] = useState('')
  const [a, setA] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const reset = () => {
    setQ('')
    setA('')
    setFile(null)
    setMode('faq')
    setError(null)
  }
  const close = () => {
    if (pending) return
    reset()
    onClose()
  }
  const fileIssue = file ? knowledgeFileIssue(file) : null
  const valid = mode === 'faq' ? !!q.trim() && !!a.trim() : !!file && !fileIssue
  const submit = async () => {
    if (!valid || pending) return
    setPending(true)
    setError(null)
    const err = await onSubmit(mode === 'faq' ? { kind: 'faq', question: q.trim(), answer: a.trim() } : { kind: 'file', file: file! })
    setPending(false)
    if (err) {
      setError(err)
      return
    }
    reset()
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Thêm vào kho kiến thức"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={pending}>
            Huỷ
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!valid || pending}>
            {pending ? (mode === 'file' ? 'Đang tải lên…' : 'Đang thêm…') : 'Thêm vào kho'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={mode}
          onChange={(m) => {
            setMode(m)
            setError(null)
          }}
          options={[
            { id: 'faq', label: 'Câu hỏi thường gặp' },
            { id: 'file', label: 'Tải file lên' },
          ]}
        />
        {mode === 'faq' ? (
          <>
            <Field label="Câu hỏi">
              <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ví dụ: Phí giao hàng?" maxLength={300} />
            </Field>
            <Field label="Câu trả lời" hint="Viết như bạn trả lời khách. AI sẽ diễn đạt lại theo giọng của trang.">
              <Textarea rows={4} value={a} onChange={(e) => setA(e.target.value)} placeholder="Ví dụ: Nội thành miễn phí, tỉnh khác 30.000đ." maxLength={4000} />
            </Field>
          </>
        ) : (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border px-6 py-8 text-center hover:border-primary/50 hover:bg-primary-soft/20">
            <Upload size={22} className="text-muted-foreground" />
            {file ? (
              <span className="text-sm font-medium break-all">{file.name}</span>
            ) : (
              <>
                <span className="text-sm font-medium">Chọn file bảng giá, chính sách…</span>
                <span className="text-xs text-muted-foreground">{KNOWLEDGE_FILE_HINT}</span>
              </>
            )}
            <input
              type="file"
              accept={KNOWLEDGE_FILE_ACCEPT}
              className="sr-only"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null)
                setError(null)
              }}
            />
          </label>
        )}
        {(error ?? (mode === 'file' ? fileIssue : null)) && <p className="text-xs text-danger">{error ?? fileIssue}</p>}
      </div>
    </Modal>
  )
}

/* ---------- Khung "Thử AI" ---------- */

type TestMsg = { id: number; from: 'customer' | 'ai' | 'system'; text: string }

/**
 * Khung thử. Kho mẫu: mô phỏng trọn câu trả lời. Nhóm/trang thật: chỉ kiểm luật chuyển người (từ khoá, khách yêu cầu
 * gặp người) với cấu hình đang chỉnh — câu trả lời thật của AI cần pipeline của Story 5.3.
 */
function TestChat({ config, domain, name, keyReady, real }: { config: AutoReplyConfig; domain: Domain; name: string; keyReady: boolean; real: boolean }) {
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
    if (real) {
      const rule = matchHandoffRule(text, config)
      if (!rule) return push('system', 'Không khớp quy tắc chuyển người. Thử câu trả lời thật của AI sẽ có ở bản cập nhật tới.')
      push('ai', config.handoffMessage)
      return push('system', `AI sẽ chuyển cho bạn · ${rule}`)
    }
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
            <p className="text-[13px] text-muted-foreground">
              {real ? 'Gõ thử để xem khi nào AI sẽ chuyển cho bạn.' : 'Chọn một câu hỏi mẫu hoặc tự gõ để xem AI trả lời.'}
            </p>
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
          {(real ? REAL_SAMPLE_QUESTIONS : SAMPLE_QUESTIONS[domain]).map((s) => (
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
  // Nhóm/trang thật chép vào kho mẫu (cây đọc từ đó); trạng thái AI dẫn xuất lấy từ tổng quan của server.
  usePages()
  useGroups()
  const overview = useAutoreplyOverview()
  const [params, setParams] = useSearchParams()
  const raw = params.get('muc') ?? `group:${groups[0]?.id ?? ''}`
  const [kind, id] = raw.split(':') as ['group' | 'page', string]
  const target = { kind: kind === 'page' ? ('page' as const) : ('group' as const), id: id ?? '' }
  const choose = (k: 'group' | 'page', i: string) => setParams({ muc: `${k}:${i}` })

  const pageStatus = (pageId: string) => overview.data?.pages.find((p) => p.pageId === pageId)
  const groupOn = (groupId: string) =>
    isRealOwner(groupId) ? !!overview.data?.groups.find((g) => g.groupId === groupId)?.enabled : !!store.configs[`group:${groupId}`]?.enabled
  const pageOn = (pageId: string, groupId: string | null) =>
    isRealOwner(pageId) ? !!pageStatus(pageId)?.enabled : !!effectiveForPage(store, pageId, groupId)?.enabled

  const ungrouped = pages.filter((p) => !p.groupId)
  const onCount = pages.filter((p) => pageOn(p.id, p.groupId)).length

  return (
    <Content>
      <PageHeader title="AI trả lời tự động" subtitle={`Chọn nhóm hoặc trang để thiết lập cách AI trả lời tin nhắn và bình luận · AI đang bật cho ${onCount}/${pages.length} trang`} />
      <div className="grid grid-cols-[280px_minmax(0,1fr)] items-start gap-6">
        <Card className="sticky top-6">
          <CardHeader title="Áp dụng cho" />
          <nav className="max-h-[calc(100vh-200px)] space-y-3 overflow-y-auto p-2" aria-label="Chọn nhóm hoặc trang">
            {groups.map((g) => (
              <div key={g.id}>
                <TreeItem active={target.kind === 'group' && target.id === g.id} onClick={() => choose('group', g.id)}>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.color }} />
                  <span className="min-w-0 flex-1 truncate font-semibold">{g.name}</span>
                  <OnOff on={groupOn(g.id)} />
                </TreeItem>
                <div className="mt-0.5 space-y-0.5">
                  {pagesInGroup(g.id).map((p) => {
                    const real = isRealOwner(p.id)
                    const status = real ? pageStatus(p.id) : undefined
                    const label = real
                      ? status
                        ? treePageLabel(status)
                        : 'Theo nhóm'
                      : treePageLabel({ mode: store.own[p.id] ? 'own' : 'group', enabled: !!store.configs[`page:${p.id}`]?.enabled })
                    const own = label !== 'Theo nhóm'
                    return (
                      <TreeItem key={p.id} indent active={target.kind === 'page' && target.id === p.id} onClick={() => choose('page', p.id)}>
                        <PageAvatar page={p} size={20} />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        <span className={cn('text-[11px]', own ? 'font-medium text-foreground' : 'text-muted-foreground')}>{label}</span>
                      </TreeItem>
                    )
                  })}
                </div>
              </div>
            ))}
            {ungrouped.length > 0 && (
              <div>
                <div className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Trang chưa có nhóm</div>
                {ungrouped.map((p) => (
                  <TreeItem key={p.id} active={target.kind === 'page' && target.id === p.id} onClick={() => choose('page', p.id)}>
                    <PageAvatar page={p} size={20} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <OnOff on={pageOn(p.id, null)} />
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
