// Soạn bài AI `/soan-bai` (F4). Story 6.1: đích là trang/nhóm thật, mỗi trang một tab với caption + ảnh riêng, luật
// nền tảng báo ngay trên tab (bảng `publishIssues` dùng chung với server), tải ảnh thật, "Lưu nháp" thật và mở lại
// nháp bằng `?bai=<id>`. Story 6.2: "Tạo bằng AI", "Viết bằng AI cho N trang", Viết lại / Ngắn hơn / Thêm CTA gọi AI thật
// theo hồ sơ từng trang (`POST /posts/compose`, nút Dừng huỷ request); tab báo lỗi riêng (chưa có hồ sơ…) và đánh dấu
// cụm vi phạm; nút AI khoá theo khoá OpenAI / hạn mức / mã lỗi, vẫn soạn tay được. Story 6.3: "Tạo ảnh AI" (và "Tạo bằng
// AI" khi bật "Kèm 4 ảnh AI") sinh 4 ảnh bằng job; ô ảnh đổi dần qua realtime (đang tạo → ảnh, hoặc "Không tạo được ảnh
// này" + "Thử mô tả khác"), caption không bị ảnh hưởng. Story 6.4: "Lên lịch" (ngày giờ theo giờ VN) / "Đăng ngay" lưu nháp
// rồi chuyển mọi trang sang `scheduled`; bài đã rời nháp chỉ xem được — mỗi tab có nhãn trạng thái (đã lên lịch, đang
// đăng, đã đăng + "Xem bài", lỗi + lý do), footer có "Bỏ lịch" / "Đổi giờ" / "Đăng lại". Xem trước IG đệm trắng ảnh
// ngoài khung 4:5–1,91:1 như lúc đăng. Story 8.4: "Tạo bài tương tự" mở `?idea=…&trang=<pageId>` — bài mới chọn đúng
// trang của bài gốc làm đích + điền ý tưởng; không gọi AI tới khi chủ shop bấm "Tạo bằng AI". Story 6.6: ảnh tải lên có
// "Dùng làm ảnh tham khảo" → 4 ảnh AI giữ đúng sản phẩm, đổi bối cảnh theo "Yêu cầu bối cảnh"; tab đã có ảnh thì mọi nút
// AI viết caption gửi kèm ảnh của tab cho AI xem.
import {
  AlertCircle,
  Bookmark,
  CalendarClock,
  CalendarX,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Globe,
  Heart,
  ImageOff,
  ImagePlus,
  Images,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  PenSquare,
  RefreshCw,
  Repeat2,
  RotateCcw,
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
import type { ComposeGoal, ComposeLength, ComposeReviseAction, ImagePromptDirection, ImageStyle, MediaAssetDto, PageDto, PostDto, PostTargetDto, TargetAction } from '@ottm/shared'
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
  Switch,
  Tabs,
  Textarea,
  cn,
  platformLabel,
} from '../components/ui'
import type { Page } from '../data/mock'
import { useAiBudget } from '../lib/ai-budget'
import { useApp } from '../lib/app-context'
import {
  GOAL_OPTIONS,
  IDEA_PARAM,
  IMAGE_ACCEPT,
  IMAGE_PROMPT_DIRECTION_OPTIONS,
  IMAGE_STYLE_OPTIONS,
  LENGTH_OPTIONS,
  POST_PARAM,
  SOURCE_PAGE_UNAVAILABLE,
  TARGET_PAGE_PARAM,
  aiErrorText,
  applyComposeResults,
  applyImageToAll,
  assignImage,
  assignUploaded,
  blockingIssues,
  brandProfileLink,
  buildComposeBody,
  buildImageBody,
  buildImagePromptBody,
  buildSaveBody,
  canUseAsReference,
  captionCounter,
  captionViolations,
  clearImage,
  composeImages,
  composeLock,
  composeLockCodeOf,
  composeToast,
  composerErrorMessage,
  copyCaptionToEmpty,
  dismissFailed,
  draftFromPost,
  draftOf,
  imageFailureText,
  imageFileIssue,
  imagePrompt,
  imageTiles,
  isSelectable,
  issueText,
  issuesFor,
  keepAttachedGenerated,
  orderedTargets,
  pendingTiles,
  referenceAsset,
  startSelection,
  tileImages,
  toggleGroupSelection,
  useComposeCaptions,
  useGenerateImages,
  useGeneratedImages,
  usePost,
  useWriteImagePrompt,
  useSavePost,
  useUploadPostImage,
  type AiNote,
  type AiNotes,
  type ComposeLockCode,
  type Drafts,
  type ImageTile,
  type TargetDraft,
} from '../lib/composer'
import { toUiPage, usePages } from '../lib/connections'
import { useGroups } from '../lib/groups'
import { markViolations } from '../lib/profiles'
import {
  IN_FLIGHT_POLL_MS,
  defaultScheduleInput,
  hasInFlight,
  igPreviewFit,
  isLocked,
  scheduleInputIssue,
  scheduledToast,
  targetRefs,
  targetStatusView,
  transitionErrorMessage,
  useTransitionTargets,
  vnToIso,
  type StatusTone,
} from '../lib/publish'

/* ---------- Màn hình ---------- */

export default function Composer() {
  const { scope, notify, aiLock, openAiKeyStatus } = useApp()
  const [params, setParams] = useSearchParams()
  const postId = params.get(POST_PARAM)
  const pagesQuery = usePages()
  const groupsQuery = useGroups()
  // Còn trang đang chờ tới lượt / đang đăng → hỏi lại định kỳ (SSE `post_target.*` vẫn là đường chính).
  const postQuery = usePost(postId, (p) => (hasInFlight(p) ? IN_FLIGHT_POLL_MS : false))
  const save = useSavePost()
  const transition = useTransitionTargets()
  const upload = useUploadPostImage()
  const compose = useComposeCaptions()
  const generateImages = useGenerateImages()
  const writeImagePrompt = useWriteImagePrompt()

  const allPages = useMemo(() => pagesQuery.data ?? [], [pagesQuery.data])
  const groupList = groupsQuery.data ?? []

  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [idea, setIdea] = useState(params.get(IDEA_PARAM) ?? '')
  /** `?trang=` (Tạo bài tương tự) trỏ tới trang đã mất kết nối / đã gỡ → báo trên ô "Đăng lên". */
  const [sourcePageUnavailable, setSourcePageUnavailable] = useState(false)
  const [drafts, setDrafts] = useState<Drafts>({})
  /** Kho ảnh của bài (ảnh đã tải lên / đang gắn) — mỗi tab chọn một ảnh từ đây. */
  const [pool, setPool] = useState<MediaAssetDto[]>([])
  const [activeTab, setActiveTab] = useState('')
  /** Nháp đã nạp vào state: `new|<idea>|<trang>` (bài mới) hoặc id bài. Đổi `?bai=` / `?idea=` / `?trang=` → nạp lại. */
  const [loadedKey, setLoadedKey] = useState<string | null>(null)

  const [goal, setGoal] = useState<ComposeGoal>('sales')
  const [length, setLength] = useState<ComposeLength>('medium')
  /** "Tạo bằng AI" đang chạy: số trang đang viết (`null` = không chạy). */
  const [writing, setWriting] = useState<number | null>(null)
  /** Viết lại / Ngắn hơn / Thêm CTA đang chạy cho tab nào. */
  const [busy, setBusy] = useState<{ pageId: string; action: ComposeReviseAction } | null>(null)
  /** Ghi chú AI theo tab: cụm vi phạm của caption AI, hoặc mã lỗi khiến trang đó chưa viết được. */
  const [notes, setNotes] = useState<AiNotes>({})
  const controller = useRef<AbortController | null>(null)
  /** Lần nạp nháp (đổi `?bai=`, bấm "Soạn bài" mới): đổi → huỷ AI đang viết để kết quả không đổ vào nháp khác. */
  const [session, setSession] = useState(0)

  // Ảnh AI (Story 6.3): id các ô của lần sinh gần nhất (trạng thái đọc qua REST, SSE làm cũ); mô tả + phong cách.
  const [genIds, setGenIds] = useState<string[]>([])
  const [imageDesc, setImageDesc] = useState('')
  const [imageStyle, setImageStyle] = useState<ImageStyle>('product')
  /** Ảnh tham khảo đang chọn (Story 6.6): ảnh AI giữ đúng sản phẩm trong ảnh này, mô tả là yêu cầu bối cảnh. */
  const [referenceId, setReferenceId] = useState<string | null>(null)
  /** "Kèm 4 ảnh AI": "Tạo bằng AI" sinh ảnh cùng lúc với caption (UX F4 b3). */
  const [withImages, setWithImages] = useState(true)
  const imageDescRef = useRef<HTMLTextAreaElement>(null)
  /** "AI viết mô tả" đang chạy theo hướng nào (Story 6.7); `null` = không chạy. */
  const [describing, setDescribing] = useState<ImagePromptDirection | null>(null)
  const describeController = useRef<AbortController | null>(null)
  const generatedQuery = useGeneratedImages(genIds)
  /** Ô ngày / giờ đăng (giờ VN) — dùng cho Lên lịch, Đổi giờ, Đăng lại. */
  const [when, setWhen] = useState(() => defaultScheduleInput(Date.now()))
  /** "Bây giờ" cho kiểm giờ đăng, cập nhật mỗi 30 giây (không gọi `Date.now()` trong lúc render). */
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  // Khoá nút AI (UX-DR2): khoá OpenAI → hạn mức → mã khoá của lần gọi trước. Mã lần trước chỉ còn hiệu lực khi khoá /
  // hạn mức chưa đổi (realtime làm cũ query) — đổi rồi thì để trạng thái mới quyết định.
  const budgetState = useAiBudget().data?.state
  const lockStamp = `${openAiKeyStatus}|${budgetState ?? ''}`
  const [serverLock, setServerLock] = useState<{ code: ComposeLockCode; stamp: string } | null>(null)
  const lock = composeLock({ key: aiLock, budgetBlocked: budgetState === 'blocked', serverCode: serverLock?.stamp === lockStamp ? serverLock.code : null })

  // Nạp trạng thái ban đầu ngay khi đủ dữ liệu (trong lúc render, không qua effect): bài mới → chọn sẵn theo `?trang=`
  // (Tạo bài tương tự) hoặc Phạm vi, ý tưởng theo `?idea=`; `?bai=<id>` → nội dung nháp đã lưu. Chỉ nạp state, không gọi AI.
  // Bài mới: khoá gồm cả `?idea=` / `?trang=` — đang ở Soạn bài từ "Tạo bài tương tự" mà bấm "Tạo bài" (`/soan-bai`)
  // vẫn cùng màn nên phải nạp lại (bỏ trang chọn sẵn + dòng báo của bài gốc), như đổi `?bai=`.
  const initKey = postId ?? `new|${params.get(IDEA_PARAM) ?? ''}|${params.get(TARGET_PAGE_PARAM) ?? ''}`
  if (loadedKey !== initKey && pagesQuery.data && (!postId || postQuery.data)) {
    const groupOf = (ids: Iterable<string>) => new Set([...ids].map((id) => allPages.find((p) => p.id === id)?.groupId).filter((g): g is string => !!g))
    if (postId && postQuery.data) {
      const loaded = draftFromPost(postQuery.data, new Set(allPages.map((p) => p.id)))
      setSelected(loaded.selected)
      setDrafts(loaded.drafts)
      setPool(loaded.pool)
      setIdea(loaded.topic)
      setExpanded(groupOf(loaded.selected))
      setSourcePageUnavailable(false)
    } else {
      const { ids, unavailable } = startSelection(scope, allPages, params.get(TARGET_PAGE_PARAM))
      setSelected(new Set(ids))
      setDrafts({})
      setPool([])
      setIdea(params.get(IDEA_PARAM) ?? '')
      setExpanded(groupOf(ids))
      setSourcePageUnavailable(unavailable)
    }
    setActiveTab('')
    setNotes({})
    setGenIds([])
    setReferenceId(null)
    // Story 6.7: mô tả ảnh (có thể do AI viết cho bài trước) không lưu theo bài — bỏ khi nạp bài khác, kẻo ảnh bài mới vẽ
    // theo mô tả của bài cũ.
    setImageDesc('')
    setSession((s) => s + 1)
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

  const fileRef = useRef<HTMLInputElement>(null)
  // Rời màn hoặc nạp nháp khác khi AI đang viết → huỷ request (server truyền AbortSignal sang OpenAI). Lưu nháp mới đổi
  // `?bai=` nhưng không nạp lại (`loadedKey` đặt trước) nên không huỷ.
  useEffect(
    () => () => {
      controller.current?.abort()
      describeController.current?.abort()
    },
    [session],
  )

  const targets = orderedTargets(allPages, selected)
  const targetIds = targets.map((p) => p.id)
  const activePage = targets.find((p) => p.id === activeTab) ?? targets[0] ?? null
  const activeId = activePage?.id ?? ''
  const activeDraft = activePage ? draftOf(drafts, activePage.id) : null
  const generated = generatedQuery.data?.images
  const tiles = imageTiles(genIds, generated, pool)
  const imagesPending = pendingTiles(tiles)
  const readyImages = tileImages(tiles)
  const activeImage = activeDraft ? readyImages.find((m) => m.id === activeDraft.mediaIds[0]) : undefined
  const reference = referenceAsset(tiles, referenceId)
  const emptyTabs = targets.filter((p) => !draftOf(drafts, p.id).caption.trim())
  const tabsWithIssues = targets.filter((p) => blockingIssues(issuesFor(p.platform, draftOf(drafts, p.id))).length > 0)
  const grouped = groupList.map((g) => ({ group: g, pages: allPages.filter((p) => p.groupId === g.id) })).filter((x) => x.pages.length > 0)
  const ungrouped = allPages.filter((p) => !p.groupId || !groupList.some((g) => g.id === p.groupId))
  const loading = pagesQuery.isPending || (postId !== null && postQuery.isPending)
  // Story 6.4: bài có trang đã rời nháp (đã lên lịch / đang đăng / đã đăng / lỗi) → chỉ xem; nhãn trạng thái theo trang.
  const post = postId ? postQuery.data : undefined
  const locked = isLocked(post)
  const targetOf = (pageId: string): PostTargetDto | undefined => post?.targets.find((t) => t.pageId === pageId)
  const activeTarget = activePage ? targetOf(activePage.id) : undefined
  const scheduledRefs = post ? targetRefs(post, ['scheduled']) : []
  const failedRefs = post ? targetRefs(post, ['failed']) : []
  const offline = targets.filter((p) => p.connectionStatus === 'disconnected')
  const publishBlock = !targets.length
    ? 'Chọn trang đích để đăng'
    : tabsWithIssues.length
      ? 'Sửa các tab có dấu đỏ (chưa đúng luật nền tảng) trước khi đăng'
      : offline.length
        ? `${offline.map((p) => p.name).join(', ')} đã mất kết nối — bỏ chọn hoặc kết nối lại trước khi đăng`
        : null
  const whenIssue = scheduleInputIssue(when.date, when.time, nowMs)
  const publishing = save.isPending || transition.isPending

  // Chủ shop tự chọn đích → bỏ dòng báo trang của bài gốc không dùng được.
  const togglePage = (id: string) => {
    setSourcePageUnavailable(false)
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }
  const toggleGroup = (gid: string, groupPages: PageDto[]) => {
    setSourcePageUnavailable(false)
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

  const running = writing !== null || busy !== null
  const canGenerate = !lock.locked && targets.length > 0 && idea.trim().length > 0 && !running
  const imagesBusy = generateImages.isPending || imagesPending > 0
  const canGenerateImages = !lock.locked && !imagesBusy && !describing && imagePrompt(imageDesc, idea).length > 0
  const canDescribe = !lock.locked && !describing && imagePrompt(imageDesc, idea).length > 0
  /** Story 6.7: mục tiêu bài → mục đích ảnh; trang đích → tông màu thương hiệu (server tìm hồ sơ chung). */
  const imageContext = { goal, pageIds: targetIds }

  /**
   * Gọi AI cho `list` (Story 6.2): viết mới cho mọi tab / các tab trống, hoặc sửa caption của một tab (`revise`).
   * Trang viết được → caption mới (nhãn "AI tạo"); trang lỗi giữ caption, tab hiện lý do. Dừng → giữ nguyên nội dung.
   */
  function runCompose(list: PageDto[], revise?: { action: ComposeReviseAction; caption: string }) {
    if (!list.length || lock.locked || controller.current) return
    const ctrl = new AbortController()
    controller.current = ctrl
    if (revise) setBusy({ pageId: list[0]!.id, action: revise.action })
    else setWriting(list.length)
    const stamp = lockStamp
    const pageIds = list.map((p) => p.id)
    // Story 6.6: tab có ảnh sẵn sàng → gửi kèm cho AI xem.
    const images = composeImages(pageIds, drafts, new Set(readyImages.map((m) => m.id)))
    const withImage = new Set(images.map((i) => i.pageId))
    compose.mutate(
      { body: buildComposeBody({ topic: idea, goal, length, pageIds, images, ...(revise ? { revise } : {}) }), signal: ctrl.signal },
      {
        onSuccess: ({ results }) => {
          if (ctrl.signal.aborted) return // Dừng / đã nạp nháp khác ngay lúc kết quả về: bỏ kết quả
          // Cập nhật theo state mới nhất: trong lúc sửa một tab, chủ shop vẫn có thể gõ ở tab khác.
          setDrafts((d) => applyComposeResults(d, {}, results).drafts)
          setNotes((n) => applyComposeResults({}, n, results).notes)
          const { lockCode } = applyComposeResults({}, {}, results)
          setServerLock(lockCode ? { code: lockCode, stamp } : null)
          notify(composeToast(results, withImage))
        },
        onError: (err) => {
          if (ctrl.signal.aborted) return // nút Dừng: giữ nguyên nội dung
          const code = composeLockCodeOf(err)
          setServerLock(code ? { code, stamp } : null)
          notify(composerErrorMessage(err))
        },
        onSettled: () => {
          if (controller.current === ctrl) controller.current = null
          setWriting(null)
          setBusy(null)
        },
      },
    )
  }

  /**
   * Sinh 4 ảnh AI (Story 6.3): bộ mới thay bộ cũ trong lưới (ảnh cũ đang gắn tab giữ lại trong kho). Ảnh về dần qua
   * realtime; lỗi chặn trước (thiếu khoá, hết hạn mức…) khoá nút AI như khi viết caption.
   */
  function startImages(description: string) {
    const body = buildImageBody(description, idea, imageStyle, reference?.id ?? null, imageContext)
    if (!body || lock.locked || imagesBusy) return
    const stamp = lockStamp
    generateImages.mutate(body, {
      onSuccess: ({ images }) => {
        setPool((p) => keepAttachedGenerated(p, generated, drafts))
        setGenIds(images.map((i) => i.id))
        notify(reference ? `AI đang tạo ${images.length} ảnh từ ảnh tham khảo…` : `AI đang tạo ${images.length} ảnh…`)
      },
      onError: (err) => {
        const code = composeLockCodeOf(err)
        if (code) setServerLock({ code, stamp })
        notify(composerErrorMessage(err))
      },
    })
  }

  /**
   * "AI viết mô tả" (Story 6.7): AI viết lại mô tả đang có (trống thì từ ý tưởng) theo hướng của chip, đổ vào ô để chủ
   * shop xem / sửa trước khi tạo ảnh. Lỗi / Dừng → giữ nguyên ô; mã khoá (thiếu khoá, hết hạn mức) khoá nút AI.
   */
  function describeImage(direction: ImagePromptDirection) {
    const body = buildImagePromptBody({ description: imageDesc, idea, direction, style: imageStyle, withReference: !!reference, context: imageContext })
    if (!body || lock.locked || describeController.current) return
    const ctrl = new AbortController()
    describeController.current = ctrl
    setDescribing(direction)
    const stamp = lockStamp
    writeImagePrompt.mutate(
      { body, signal: ctrl.signal },
      {
        onSuccess: ({ description }) => {
          if (ctrl.signal.aborted) return
          setImageDesc(description)
          notify('AI đã viết mô tả ảnh — xem lại rồi bấm tạo ảnh')
          imageDescRef.current?.focus()
        },
        onError: (err) => {
          if (ctrl.signal.aborted) return // Dừng: giữ nguyên ô
          const code = composeLockCodeOf(err)
          if (code) setServerLock({ code, stamp })
          notify(`${composerErrorMessage(err)} Mô tả giữ nguyên.`)
        },
        onSettled: () => {
          if (describeController.current === ctrl) describeController.current = null
          setDescribing(null)
        },
      },
    )
  }

  function stopDescribe() {
    describeController.current?.abort()
    describeController.current = null
    setDescribing(null)
  }

  /** "Thử mô tả khác": bỏ ô lỗi, đưa con trỏ vào ô Mô tả ảnh. */
  function retryImageDescription() {
    setGenIds((ids) => dismissFailed(ids, generated))
    imageDescRef.current?.focus()
    imageDescRef.current?.select()
  }

  function stop() {
    controller.current?.abort()
    controller.current = null
    setWriting(null)
    setBusy(null)
    notify('Đã dừng AI')
  }

  /** Viết lại / Ngắn hơn / Thêm CTA cho tab đang mở. */
  function revise(action: ComposeReviseAction) {
    if (!activePage || !activeDraft) return
    runCompose([activePage], { action, caption: activeDraft.caption })
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
        // Ảnh tải lên thường là ảnh sản phẩm thật → tự làm ảnh tham khảo (như FlowMate "Ảnh sản phẩm gốc") để "Tạo ảnh AI" /
        // "Tạo bằng AI" giữ đúng sản phẩm; chủ shop bỏ bằng nút X nếu chỉ muốn đăng ảnh gốc hoặc vẽ ảnh mới từ chữ.
        if (canUseAsReference(asset)) setReferenceId(asset.id)
        notify('Đã tải ảnh lên — AI sẽ tạo ảnh giữ đúng sản phẩm trong ảnh này')
      },
      onError: (err) => notify(composerErrorMessage(err)),
    })
  }

  /** Lưu nháp (lần đầu `POST`, sau đó `PUT`) rồi đặt `?bai=`; `then` chạy tiếp với bài vừa lưu (Lên lịch / Đăng ngay). */
  function persist(then: (saved: PostDto) => void) {
    if (!targets.length || locked) return
    save.mutate(
      { id: postId, body: buildSaveBody(idea, targets, drafts) },
      {
        onSuccess: (saved) => {
          // Đánh dấu đã nạp TRƯỚC khi đổi `?bai=` để không nạp lại (giữ kho ảnh, nhãn AI của phiên đang soạn).
          setLoadedKey(saved.id)
          if (saved.id !== postId) {
            setParams(
              (p) => {
                p.set(POST_PARAM, saved.id)
                p.delete(IDEA_PARAM)
                p.delete(TARGET_PAGE_PARAM)
                return p
              },
              { replace: true },
            )
          }
          then(saved)
        },
        onError: (err) => notify(composerErrorMessage(err)),
      },
    )
  }

  function saveDraft() {
    persist((saved) => notify(`Đã lưu nháp cho ${saved.targets.length} trang`))
  }

  /** Giờ đã chọn (ISO) hoặc `null` + báo lỗi khi ô ngày giờ chưa hợp lệ. */
  function chosenTime(): string | null {
    const at = vnToIso(when.date, when.time)
    if (whenIssue || !at) {
      notify(whenIssue ?? 'Chọn ngày và giờ đăng')
      return null
    }
    return at
  }

  /** Một hành động trên các trang của bài đang mở (AD-13: tất cả hoặc không). */
  function act(postIdToUse: string, action: TargetAction, refs: { id: string; version: number }[], scheduledAt: string | null, done: (p: PostDto) => string) {
    if (!refs.length) return
    transition.mutate(
      { postId: postIdToUse, body: action === 'unschedule' ? { action, targets: refs } : { action, scheduledAt, targets: refs } },
      { onSuccess: (p) => notify(done(p)), onError: (err) => notify(transitionErrorMessage(err, allPages)) },
    )
  }

  /** "Lên lịch" (giờ đã chọn) / "Đăng ngay": lưu nháp rồi chuyển mọi trang sang `scheduled`. */
  function schedule(now: boolean) {
    if (publishBlock || running || publishing) return
    const at = now ? null : chosenTime()
    if (!now && !at) return
    persist((saved) => act(saved.id, 'schedule', targetRefs(saved, ['draft']), at, () => scheduledToast(saved.targets.length, at)))
  }

  function reschedule() {
    const at = chosenTime()
    if (post && at) act(post.id, 'reschedule', scheduledRefs, at, () => scheduledToast(scheduledRefs.length, at))
  }

  function unschedule() {
    if (post) act(post.id, 'unschedule', scheduledRefs, null, (p) => (isLocked(p) ? `Đã bỏ lịch ${scheduledRefs.length} trang` : 'Đã bỏ lịch — bài trở về nháp, sửa được'))
  }

  /** "Đăng lại" các trang lỗi: giờ đã chọn, hoặc ngay. */
  function retry(now: boolean) {
    const at = now ? null : chosenTime()
    if (post && (now || at)) act(post.id, 'retry', failedRefs, at, () => scheduledToast(failedRefs.length, at))
  }

  const whenInputs = (
    <>
      <Input
        type="date"
        value={when.date}
        onChange={(e) => setWhen((w) => ({ ...w, date: e.target.value }))}
        className="w-[150px]"
        aria-label="Ngày đăng (giờ Việt Nam)"
        aria-invalid={!!whenIssue}
      />
      <Input
        type="time"
        value={when.time}
        onChange={(e) => setWhen((w) => ({ ...w, time: e.target.value }))}
        className="w-[110px]"
        aria-label="Giờ đăng (giờ Việt Nam)"
        aria-invalid={!!whenIssue}
      />
    </>
  )

  const footer = (
    <div className="sticky bottom-0 z-10 -mx-6 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface px-6 py-3">
      <div className="text-[13px] text-muted-foreground">
        {locked && post ? (
          <PostSummary post={post} />
        ) : targets.length ? (
          <>
            Bài cho <b className="text-foreground">{targets.length} trang</b>
            {tabsWithIssues.length > 0 && <span className="text-danger"> · {tabsWithIssues.length} trang chưa đúng luật nền tảng</span>}
            {offline.length > 0 && <span className="text-danger"> · {offline.length} trang mất kết nối</span>}
            {postId && ' · đã có bản nháp'}
          </>
        ) : (
          'Chọn trang đích để bắt đầu'
        )}
        {(!locked || scheduledRefs.length > 0 || failedRefs.length > 0) && whenIssue && <div className="text-xs text-danger">{whenIssue}</div>}
      </div>
      {locked ? (
        <div className="flex flex-wrap items-center gap-2">
          {(scheduledRefs.length > 0 || failedRefs.length > 0) && whenInputs}
          {scheduledRefs.length > 0 && (
            <>
              <Button icon={<CalendarX size={15} />} disabled={publishing} onClick={unschedule}>
                Bỏ lịch
              </Button>
              <Button icon={<CalendarClock size={15} />} disabled={publishing || !!whenIssue} onClick={reschedule}>
                Đổi giờ
              </Button>
            </>
          )}
          {failedRefs.length > 0 && (
            <>
              <Button icon={<RotateCcw size={15} />} disabled={publishing || !!whenIssue} onClick={() => retry(false)}>
                Đăng lại lúc này
              </Button>
              <Button variant="primary" icon={<Send size={15} />} disabled={publishing} onClick={() => retry(true)}>
                Đăng lại ngay
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<Save size={15} />} disabled={!targets.length || publishing} onClick={saveDraft}>
            {save.isPending ? 'Đang lưu…' : 'Lưu nháp'}
          </Button>
          <span className="mx-1 h-6 w-px bg-border" />
          {whenInputs}
          <span title={publishBlock ?? (running ? 'Đợi AI viết xong' : undefined)} className="flex flex-wrap items-center gap-2">
            <Button icon={<CalendarClock size={15} />} disabled={!!publishBlock || !!whenIssue || running || publishing} onClick={() => schedule(false)}>
              Lên lịch
            </Button>
            <Button variant="primary" icon={<Send size={15} />} disabled={!!publishBlock || running || publishing} onClick={() => schedule(true)}>
              {transition.isPending ? 'Đang gửi…' : 'Đăng ngay'}
            </Button>
          </span>
        </div>
      )}
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
          {/* Bài đã rời nháp: khoá mọi ô / nút của cột (fieldset `disabled`). */}
          <fieldset disabled={locked} className="min-w-0 space-y-5 p-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[13px] font-medium">Đăng lên</span>
                <span className="text-xs text-muted-foreground">{targets.length ? `${targets.length} trang đã chọn` : 'Chưa chọn trang'}</span>
              </div>
              {sourcePageUnavailable && (
                <p className="mb-2 flex items-start gap-1.5 text-xs text-amber-800">
                  <AlertCircle size={13} className="mt-px shrink-0" />
                  {SOURCE_PAGE_UNAVAILABLE}
                </p>
              )}
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
                <Select options={GOAL_OPTIONS} value={goal} onChange={(e) => setGoal(e.target.value as ComposeGoal)} />
              </Field>
              <div>
                <span className="mb-1.5 block text-[13px] font-medium">Độ dài</span>
                <Segmented options={LENGTH_OPTIONS} value={length} onChange={setLength} />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div>
                <span className="block text-[13px] font-medium">Kèm 4 ảnh AI</span>
                <span className="text-xs text-muted-foreground">AI tạo ảnh theo ý tưởng, bạn chọn 1 ảnh cho mỗi trang.</span>
              </div>
              <Switch checked={withImages} onChange={setWithImages} label="Kèm 4 ảnh AI" ai />
            </div>

            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Sparkles size={14} className="mt-px shrink-0 text-ai" />
              AI viết riêng cho từng trang theo hồ sơ thương hiệu của trang đó: giọng điệu, sản phẩm và từ cấm.
            </p>

            <div>
              <AiLockHint locked={lock.locked} hint={lock.hint} link={lock.link} className="flex w-full">
                <Button
                  variant="ai"
                  className="h-11 w-full text-[15px]"
                  disabled={!canGenerate}
                  onClick={() => {
                    runCompose(targets)
                    if (withImages && !imagesBusy) startImages(imageDesc)
                  }}
                >
                  {writing !== null ? 'AI đang viết…' : 'Tạo bằng AI'}
                </Button>
              </AiLockHint>
              {/* Khoá (thiếu khoá OpenAI, hết hạn mức…): gợi ý + liên kết nằm ở AiLockHint của nút. */}
              {!lock.locked && (targets.length === 0 || !idea.trim()) && (
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  {targets.length === 0 ? 'Chọn ít nhất 1 trang để tạo bài.' : 'Nhập ý tưởng để AI bắt đầu viết.'}
                </p>
              )}
            </div>
          </fieldset>
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
          ) : writing !== null ? (
            <WritingSkeleton onStop={stop} count={writing} />
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
                      {notes[p.id] && 'errorCode' in notes[p.id]! && <AlertCircle size={13} className="text-amber-600" aria-label="AI chưa viết được cho trang này" />}
                      <TargetStatusIcon target={targetOf(p.id)} />
                    </span>
                  ),
                }))}
                value={activeId}
                onChange={setActiveTab}
              />

              {locked && (
                <p className="mt-3 rounded-md border border-border bg-slate-50 px-3 py-2 text-[13px] text-muted-foreground">
                  Bài đã lên lịch hoặc đã đăng nên không sửa được nội dung.
                  {scheduledRefs.length > 0 && ' Bấm "Bỏ lịch" ở cuối trang để đưa các trang chưa đăng về nháp rồi sửa.'}
                </p>
              )}
              {activeTarget && activeTarget.status !== 'draft' && <TargetStatusBar target={activeTarget} />}

              <fieldset disabled={locked} className="min-w-0">
                {emptyTabs.length > 0 && emptyTabs.length < targets.length && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-slate-50 px-3 py-2 text-[13px]">
                    <span>{emptyTabs.length} trang chưa có nội dung.</span>
                    <div className="flex gap-2">
                      {activeDraft.caption.trim() && (
                        <Button size="sm" icon={<Copy size={13} />} onClick={copyToEmpty}>
                          Chép sang trang còn trống
                        </Button>
                      )}
                      <AiLockHint locked={lock.locked} hint={lock.hint} link={lock.link} align="end">
                        <Button variant="ai" size="sm" onClick={() => runCompose(emptyTabs)} disabled={lock.locked || running || !idea.trim()}>
                          Viết bằng AI cho {emptyTabs.length} trang
                        </Button>
                      </AiLockHint>
                    </div>
                  </div>
                )}

                <TabEditor
                  page={activePage}
                  draft={activeDraft}
                  note={notes[activePage.id] ?? null}
                  busy={busy?.pageId === activePage.id}
                  onStop={stop}
                  onChange={(c) => setCaption(activePage.id, c)}
                  onRetry={!lock.locked && !running && idea.trim() ? () => runCompose([activePage]) : null}
                />
                <AiLockHint locked={lock.locked} hint={lock.hint} link={lock.link} align="start" className="mt-2 flex">
                  <div className={cn('flex flex-wrap gap-1.5', !lock.locked && 'mt-2')}>
                    <AiQuick icon={<RefreshCw size={13} />} onClick={() => revise('rewrite')} disabled={running || lock.locked || !idea.trim()}>
                      Viết lại
                    </AiQuick>
                    <AiQuick icon={<Scissors size={13} />} onClick={() => revise('shorter')} disabled={running || lock.locked || !activeDraft.caption.trim()}>
                      Ngắn hơn
                    </AiQuick>
                    <AiQuick icon={<Megaphone size={13} />} onClick={() => revise('cta')} disabled={running || lock.locked || !activeDraft.caption.trim()}>
                      Thêm CTA
                    </AiQuick>
                  </div>
                </AiLockHint>
                {activeImage && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Images size={13} className="shrink-0 text-ai" />
                    AI sẽ xem ảnh của trang này khi viết, để nội dung khớp với ảnh.
                  </p>
                )}

                <div className="mt-6">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-semibold">Ảnh</h4>
                      <p className="text-xs text-muted-foreground">Bấm một ảnh để dùng cho {activePage.name} · mỗi trang 1 ảnh</p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" icon={<Upload size={14} />} onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                        {upload.isPending ? 'Đang tải ảnh…' : 'Tải ảnh lên'}
                      </Button>
                      <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} className="hidden" onChange={(e) => onUpload(e.target.files)} />
                    </div>
                  </div>
                  {reference && (
                    <div className="mb-2 flex items-center gap-3 rounded-md border border-ai/30 bg-ai-soft px-3 py-2">
                      <img src={reference.url} alt="" className="size-12 shrink-0 rounded object-cover" />
                      <div className="min-w-0 flex-1 text-[13px]">
                        <span className="block font-medium">Ảnh tham khảo</span>
                        <span className="text-xs text-muted-foreground">AI giữ đúng sản phẩm trong ảnh này, chỉ đổi bối cảnh theo yêu cầu của bạn.</span>
                      </div>
                      <Button size="sm" icon={<X size={14} />} onClick={() => setReferenceId(null)}>
                        Bỏ ảnh tham khảo
                      </Button>
                    </div>
                  )}
                  <Field
                    label={reference ? 'Yêu cầu bối cảnh' : 'Mô tả ảnh'}
                    hint={reference ? undefined : 'Càng chi tiết càng đẹp: chủ thể, bối cảnh, ánh sáng, bố cục, tông màu.'}
                  >
                    <Textarea
                      ref={imageDescRef}
                      rows={3}
                      value={imageDesc}
                      disabled={!!describing}
                      onChange={(e) => setImageDesc(e.target.value)}
                      placeholder={reference ? 'vd đặt sản phẩm lên bàn gỗ, ánh sáng buổi sáng' : 'Để trống: AI vẽ theo ý tưởng bài'}
                      maxLength={1000}
                    />
                  </Field>
                  <AiLockHint locked={lock.locked} hint={lock.hint} link={lock.link} align="start" className="mt-2 flex">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {describing ? (
                        <>
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ai">
                            <WandSparkles size={13} className="animate-pulse" />
                            AI đang viết mô tả…
                          </span>
                          <button onClick={stopDescribe} className="text-xs font-medium text-muted-foreground underline hover:text-foreground">
                            Dừng
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="text-xs text-muted-foreground">AI viết mô tả:</span>
                          {IMAGE_PROMPT_DIRECTION_OPTIONS.map((o) => (
                            <AiQuick key={o.value} icon={<WandSparkles size={13} />} onClick={() => describeImage(o.value)} disabled={!canDescribe}>
                              {o.label}
                            </AiQuick>
                          ))}
                        </>
                      )}
                    </div>
                  </AiLockHint>
                  <div className="mt-3 mb-3 flex flex-wrap items-end gap-2">
                    {!reference && (
                      <Field label="Phong cách" className="w-[170px]">
                        <Select options={IMAGE_STYLE_OPTIONS} value={imageStyle} onChange={(e) => setImageStyle(e.target.value as ImageStyle)} />
                      </Field>
                    )}
                    <AiLockHint locked={lock.locked} hint={lock.hint} link={lock.link} align="end">
                      <Button variant="ai" size="sm" className="h-9" icon={<Sparkles size={14} />} disabled={!canGenerateImages} onClick={() => startImages(imageDesc)}>
                        {imagesBusy ? 'AI đang tạo ảnh…' : reference ? 'Tạo từ ảnh tham khảo' : genIds.length > 0 ? 'Tạo lại ảnh' : 'Tạo ảnh AI'}
                      </Button>
                    </AiLockHint>
                  </div>
                  {tiles.length === 0 && !upload.isPending ? (
                    <div className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-4 text-[13px] text-muted-foreground">
                      <ImageOff size={16} /> Chưa có ảnh. Tạo ảnh bằng AI hoặc tải ảnh của bạn lên (PNG, JPEG, WebP · tối đa 10MB).
                    </div>
                  ) : (
                    <div className="grid grid-cols-4 gap-2">
                      {upload.isPending && <div className="aspect-square animate-pulse rounded-md bg-slate-100" aria-label="Đang tải ảnh" />}
                      {tiles.map((tile, i) => (
                        <ImageTileView
                          key={tile.kind === 'image' ? tile.asset.id : tile.id}
                          tile={tile}
                          index={i}
                          pageName={activePage.name}
                          chosen={tile.kind === 'image' && activeDraft.mediaIds.includes(tile.asset.id)}
                          onChoose={(id) => setDrafts((d) => assignImage(d, activePage.id, id))}
                          onRetry={retryImageDescription}
                          isReference={tile.kind === 'image' && tile.asset.id === reference?.id}
                          onUseAsReference={(id) => {
                            setReferenceId(id)
                            imageDescRef.current?.focus()
                          }}
                        />
                      ))}
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
              </fieldset>
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
            {writing !== null ? (
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
                {activePage.platform === 'instagram' && (
                  <InstagramPreview page={toUiPage(activePage)} caption={activeDraft.caption} image={activeImage?.url} fit={igPreviewFit(activeImage)} />
                )}
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

/**
 * Ô nội dung của một tab: caption, bộ đếm ký tự theo nền tảng, dòng lỗi luật nền tảng (cùng bảng với server).
 * Story 6.2: ghi chú AI của tab — lý do AI chưa viết được (chưa có hồ sơ → "Tạo hồ sơ"; lỗi khác → "Thử lại"), hoặc
 * cụm vi phạm hậu kiểm còn trong chữ được đánh dấu (từ cấm, link lạ) + ghi chú quá dài.
 */
function TabEditor({
  page,
  draft,
  note,
  busy,
  onStop,
  onChange,
  onRetry,
}: {
  page: PageDto
  draft: TargetDraft
  note: AiNote | null
  busy: boolean
  onStop: () => void
  onChange: (caption: string) => void
  /** `null` = không thử lại được lúc này (nút AI đang khoá / đang chạy / chưa có ý tưởng). */
  onRetry: (() => void) | null
}) {
  const { caption, ai, edited } = draft
  const issues = issuesFor(page.platform, draft)
  const counter = captionCounter(page.platform, caption)
  const violations = note && 'violations' in note ? captionViolations(caption, page.platform, note.violations) : []
  const marks = violations.filter((v) => v.kind !== 'too_long')
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
      {note && 'errorCode' in note && !busy && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert">
          <AlertCircle size={13} className="shrink-0" />
          <span className="flex-1">{aiErrorText(note.errorCode)}</span>
          {note.errorCode === 'CONFIG_MISSING' ? (
            <Link to={brandProfileLink(page.id).to} className="font-semibold underline underline-offset-2">
              {brandProfileLink(page.id).label}
            </Link>
          ) : (
            onRetry && (
              <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">
                Thử lại
              </button>
            )
          )}
        </div>
      )}
      {busy ? (
        <div className="space-y-2 rounded-sm border border-ai/30 bg-ai-soft/30 p-3">
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-ai">
            <Sparkles size={14} className="animate-pulse" /> AI đang viết…
            <button type="button" onClick={onStop} className="ml-auto rounded px-1.5 py-0.5 text-xs font-medium hover:bg-ai/10">
              Dừng
            </button>
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
      {violations.some((v) => v.kind === 'too_long') && (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800" role="alert">
          Caption AI vẫn dài hơn giới hạn — rút gọn bớt trước khi đăng.
        </p>
      )}
      {marks.length > 0 && (
        <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800" role="alert">
          <p className="font-medium">AI vẫn dùng cụm cần tránh của trang này — sửa lại trước khi đăng:</p>
          {/* Từ cấm (đỏ) và link ngoài danh sách cho phép (cam); markViolations dùng chung với Viết thử (Story 3.4). */}
          <p className="mt-1 leading-relaxed break-words whitespace-pre-wrap text-amber-900">
            {markViolations(caption, marks).map((seg, i) =>
              seg.kind === null ? (
                <span key={i}>{seg.text}</span>
              ) : (
                <mark key={i} className={cn('rounded px-0.5', seg.kind === 'banned_word' ? 'bg-red-200 text-red-900' : 'bg-orange-200 text-orange-900')}>
                  {seg.text}
                </mark>
              ),
            )}
          </p>
        </div>
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

const TONE_CLASS: Record<StatusTone, string> = {
  muted: 'border-border bg-slate-50 text-muted-foreground',
  info: 'border-primary/30 bg-primary-soft text-primary',
  success: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  danger: 'border-danger/40 bg-danger-soft text-danger-foreground',
}

/** Biểu tượng trạng thái trên tab trang (bài đã rời nháp). */
function TargetStatusIcon({ target }: { target: PostTargetDto | undefined }) {
  if (!target || target.status === 'draft') return null
  const label = targetStatusView(target).label
  if (target.status === 'published') return <CheckCircle2 size={13} className="text-emerald-600" aria-label={label} />
  if (target.status === 'failed') return <AlertCircle size={13} className="text-danger" aria-label={label} />
  if (target.status === 'publishing') return <Loader2 size={13} className="animate-spin text-primary" aria-label={label} />
  return <Clock size={13} className="text-primary" aria-label={label} />
}

/** Dải trạng thái của trang đang mở: đã lên lịch giờ…, đang đăng, đã đăng + "Xem bài", lỗi + lý do. */
function TargetStatusBar({ target }: { target: PostTargetDto }) {
  const view = targetStatusView(target)
  return (
    <div className={cn('mt-3 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[13px]', TONE_CLASS[view.tone])} role={view.tone === 'danger' ? 'alert' : 'status'}>
      <TargetStatusIcon target={target} />
      <span className="font-medium">{view.label}</span>
      {view.detail && <span className="flex-1">{view.detail}</span>}
      {target.status === 'published' && target.permalink && (
        <a href={target.permalink} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 font-medium underline underline-offset-2">
          Xem bài <ExternalLink size={12} />
        </a>
      )}
    </div>
  )
}

/** Tóm tắt trạng thái các trang của bài đã rời nháp (footer). */
function PostSummary({ post }: { post: PostDto }) {
  const count = (status: PostTargetDto['status']) => post.targets.filter((t) => t.status === status).length
  const parts = [
    [count('published'), 'đã đăng'],
    [count('scheduled') + count('publishing'), 'chờ đăng'],
    [count('failed'), 'lỗi'],
    [count('draft'), 'nháp'],
  ].filter(([n]) => (n as number) > 0)
  return (
    <>
      Bài cho <b className="text-foreground">{post.targets.length} trang</b>
      {parts.map(([n, label]) => (
        <span key={label as string} className={label === 'lỗi' ? 'text-danger' : undefined}>
          {' '}
          · {n} {label}
        </span>
      ))}
    </>
  )
}

function CaptionText({ text, clamp }: { text: string; clamp?: boolean }) {
  return <p className={cn('text-[13px] leading-relaxed whitespace-pre-line', clamp && 'line-clamp-6')}>{text}</p>
}

/** Một ô của lưới ảnh: đang tạo (khung chờ), lỗi ("Không tạo được ảnh này" + "Thử mô tả khác"), hoặc ảnh chọn được. */
function ImageTileView({
  tile,
  index,
  pageName,
  chosen,
  onChoose,
  onRetry,
  isReference,
  onUseAsReference,
}: {
  tile: ImageTile
  index: number
  pageName: string
  chosen: boolean
  onChoose: (mediaId: string) => void
  onRetry: () => void
  /** Story 6.6: ảnh này đang là ảnh tham khảo. */
  isReference: boolean
  onUseAsReference: (mediaId: string) => void
}) {
  if (tile.kind === 'pending') {
    return (
      <div className="flex aspect-square animate-pulse flex-col items-center justify-center gap-1 rounded-md bg-ai-soft text-[11px] text-ai" aria-label="Đang tạo ảnh">
        <Sparkles size={16} />
        Đang tạo ảnh…
      </div>
    )
  }
  if (tile.kind === 'failed') {
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border bg-slate-50 p-2 text-center" role="group" aria-label="Không tạo được ảnh này">
        <ImageOff size={16} className="text-muted-foreground" />
        <span className="text-[11px] font-medium leading-tight">Không tạo được ảnh này</span>
        <span className="text-[10px] leading-tight text-muted-foreground">{imageFailureText(tile.errorCode)}</span>
        <button type="button" className="text-[11px] font-medium text-primary hover:underline" onClick={onRetry}>
          Thử mô tả khác
        </button>
      </div>
    )
  }
  const im = tile.asset
  return (
    <div className="relative aspect-square">
      <button
        onClick={() => onChoose(im.id)}
        className={cn('relative size-full overflow-hidden rounded-md border border-border', chosen && 'ring-2 ring-primary ring-offset-2')}
        aria-pressed={chosen}
        aria-label={`Dùng ảnh ${index + 1} cho ${pageName}`}
      >
        <img src={im.url} alt="" className="size-full object-cover" />
        <span className={cn('absolute top-1 left-1 rounded px-1 text-[10px] font-semibold', im.source === 'ai' ? 'bg-ai text-white' : 'bg-white/90 text-slate-700')}>
          {im.source === 'ai' ? 'AI' : 'Tải lên'}
        </span>
      </button>
      {/* Nút riêng (không lồng trong nút chọn ảnh): ảnh tải lên làm ảnh tham khảo cho ảnh AI. */}
      {canUseAsReference(im) &&
        (isReference ? (
          <span className="pointer-events-none absolute inset-x-1 bottom-1 rounded bg-ai px-1 py-0.5 text-center text-[10px] font-semibold text-white">Ảnh tham khảo</span>
        ) : (
          <button
            type="button"
            onClick={() => onUseAsReference(im.id)}
            className="absolute inset-x-1 bottom-1 flex items-center justify-center gap-1 rounded bg-white/90 px-1 py-0.5 text-[10px] font-medium text-ai hover:bg-white"
            title="AI tạo ảnh mới giữ đúng sản phẩm trong ảnh này, đổi bối cảnh theo yêu cầu"
          >
            <ImagePlus size={11} /> Dùng làm ảnh tham khảo
          </button>
        ))}
    </div>
  )
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

/**
 * Xem trước Instagram: ảnh ngoài khung 4:5–1,91:1 hiện đệm trắng trong khung gần nhất (đúng như lúc đăng — server đệm
 * bằng Cloudinary, không cắt), kèm câu giải thích.
 */
function InstagramPreview({ page, caption, image, fit = 'ok' }: { page: Page; caption: string; image?: string | undefined; fit?: 'ok' | 'pad_tall' | 'pad_wide' }) {
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
        <>
          <img
            src={image}
            alt=""
            className={cn('w-full bg-white', fit === 'ok' ? 'aspect-square object-cover' : 'object-contain', fit === 'pad_tall' && 'aspect-[4/5]', fit === 'pad_wide' && 'aspect-[1.91/1]')}
          />
          {fit !== 'ok' && (
            <p className="bg-slate-50 px-3 py-1.5 text-[11px] text-muted-foreground">
              Instagram chỉ nhận ảnh tỉ lệ 4:5 – 1,91:1 — ảnh sẽ được thêm viền trắng {fit === 'pad_tall' ? 'hai bên' : 'trên dưới'}, không bị cắt.
            </p>
          )}
        </>
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
