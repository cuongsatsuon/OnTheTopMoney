// Soạn bài (Story 6.1) phía web: nháp nhiều trang với caption/ảnh riêng từng trang. Nối Composer vào API thật:
// tải ảnh lên (`POST /media-assets`), lưu nháp (`POST /posts`, sau đó `PUT /posts/:id`), mở lại nháp (`?bai=<id>`).
// Luật nền tảng lấy đúng bảng `publishIssues` của `@ottm/shared` mà server dùng khi lên lịch (AD-13).
// Phần thuần (chọn đích, gắn ảnh, dựng body, nạp nháp, câu lỗi) tách khỏi hook để test được (composer.test.ts).
// Story 6.2: viết caption bằng AI theo hồ sơ từng trang (`POST /posts/compose`, huỷ bằng `signal`) — áp kết quả từng tab
// (`applyComposeResults`), ghi chú lỗi / cụm vi phạm trên tab, khoá nút AI theo khoá OpenAI / hạn mức / mã lỗi (`composeLock`).
// Story 6.3: sinh 4 ảnh AI (`POST /media-assets/generate` → 4 ô đang sinh), trạng thái ô đọc lại qua
// `GET /media-assets/generated` khi SSE báo `media_asset.created|failed` (khoá query gốc `media_assets`); lưới ảnh dựng
// bằng `imageTiles` (ô chờ / ô lỗi / ảnh, rồi kho ảnh của bài).
import {
  ComposeCaptionsResponse,
  GeneratedImagesResponse,
  MediaAssetDto,
  PLATFORM_RULES,
  POST_IMAGE_MAX_BYTES,
  POST_IMAGE_MIMES,
  PostDto,
  captionLength,
  publishIssues,
  type AiViolation,
  type ComposeCaptionResult,
  type ComposeCaptionsRequest,
  type ComposeGoal,
  type ComposeLength,
  type ComposeReviseAction,
  type ErrorCode,
  type GenerateImagesRequest,
  type GeneratedImageDto,
  type ImageErrorCode,
  type ImageStyle,
  type PageDto,
  type Platform,
  type PostImageMime,
  type PublishIssue,
  type SavePostRequest,
  type Scope,
} from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, isApiError } from './api'
import { errorMessage, errorMessageOf } from './error-messages'
import { remainingViolations, suggestLock, type SuggestLock } from './inbox'
import type { AiLock } from './openai'

/** Tham số URL của nháp đang mở (`/soan-bai?bai=<postId>`). */
export const POST_PARAM = 'bai'

const PLATFORM_NAME: Record<Platform, string> = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads' }

/* ---------- Trạng thái soạn của từng trang ---------- */

export interface TargetDraft {
  caption: string
  /** Ảnh của trang này (id `media_assets`), tối đa `POST_TARGET_MEDIA_MAX`. */
  mediaIds: string[]
  /** Caption do AI viết (nhãn "AI tạo"); `edited` khi chủ shop sửa lại. */
  ai: boolean
  edited: boolean
}
export type Drafts = Record<string, TargetDraft>

export const EMPTY_DRAFT: TargetDraft = { caption: '', mediaIds: [], ai: false, edited: false }

export const draftOf = (drafts: Drafts, pageId: string): TargetDraft => drafts[pageId] ?? EMPTY_DRAFT

/* ---------- Chọn đích ---------- */

/** Trang chọn được làm đích mới: chưa mất kết nối (trang mất kết nối đã có trong nháp vẫn giữ). */
export const isSelectable = (page: Pick<PageDto, 'connectionStatus'>): boolean => page.connectionStatus !== 'disconnected'

/** Chọn sẵn theo Phạm vi: nhóm → các trang chọn được của nhóm; trang → trang đó (nếu chọn được); tất cả → không chọn. */
export function initialSelection(scope: Scope, pages: readonly PageDto[]): string[] {
  if (scope.kind === 'group') return pages.filter((p) => p.groupId === scope.id && isSelectable(p)).map((p) => p.id)
  if (scope.kind === 'page') return pages.filter((p) => p.id === scope.id && isSelectable(p)).map((p) => p.id)
  return []
}

/** Bấm ô của nhóm: đã chọn đủ các trang chọn được → bỏ cả nhóm; ngược lại → thêm các trang còn thiếu. */
export function toggleGroupSelection(selected: ReadonlySet<string>, groupPages: readonly PageDto[]): Set<string> {
  const ids = groupPages.filter(isSelectable).map((p) => p.id)
  const all = ids.length > 0 && ids.every((id) => selected.has(id))
  const next = new Set(selected)
  for (const id of ids) {
    if (all) next.delete(id)
    else next.add(id)
  }
  return next
}

/** Tab theo thứ tự danh sách trang (ổn định), chỉ các trang đã chọn. */
export function orderedTargets(pages: readonly PageDto[], selected: ReadonlySet<string>): PageDto[] {
  return pages.filter((p) => selected.has(p.id))
}

/* ---------- Luật nền tảng trên tab ---------- */

export function issuesFor(platform: Platform, draft: TargetDraft): PublishIssue[] {
  return publishIssues({ platform, caption: draft.caption, mediaCount: draft.mediaIds.length })
}

/** Vi phạm chặn lên lịch (bỏ `POST_EMPTY` — tab mới mở chưa có chữ là chuyện bình thường, chỉ hiện gợi ý xám). */
export const blockingIssues = (issues: readonly PublishIssue[]): PublishIssue[] => issues.filter((i) => i.code !== 'POST_EMPTY')

/** Câu dưới ô nội dung của tab (có tên nền tảng). */
export function issueText(issue: PublishIssue, platform: Platform): string {
  const name = PLATFORM_NAME[platform]
  switch (issue.code) {
    case 'POST_EMPTY':
      return 'Chưa có nội dung — viết caption hoặc thêm ảnh'
    case 'MEDIA_REQUIRED':
      return `${name} cần ít nhất 1 ảnh`
    case 'CAPTION_TOO_LONG':
      return `${name} tối đa ${fmt(issue.limit)} ký tự (đang ${fmt(issue.actual)})`
    case 'TOO_MANY_HASHTAGS':
      return `${name} tối đa ${fmt(issue.limit)} hashtag (đang ${fmt(issue.actual)})`
  }
}
const fmt = (n: number | undefined) => (n ?? 0).toLocaleString('vi-VN')

/** Bộ đếm ký tự của tab: `n/giới hạn` (Facebook giới hạn rất lớn → chỉ đếm). */
export function captionCounter(platform: Platform, caption: string): { text: string; over: boolean } {
  const n = captionLength(caption, platform)
  const max = PLATFORM_RULES[platform].captionMax
  if (platform === 'facebook') return { text: `${fmt(n)} ký tự`, over: n > max }
  return { text: `${fmt(n)}/${fmt(max)}`, over: n > max }
}

/* ---------- Thao tác nội dung ---------- */

/** "Chép sang trang còn trống": caption của `fromId` sang các tab có caption trống. Trả drafts mới + số tab được chép. */
export function copyCaptionToEmpty(drafts: Drafts, targetIds: readonly string[], fromId: string): { drafts: Drafts; count: number } {
  const from = draftOf(drafts, fromId)
  if (!from.caption.trim()) return { drafts, count: 0 }
  const next = { ...drafts }
  let count = 0
  for (const id of targetIds) {
    if (id === fromId || draftOf(drafts, id).caption.trim()) continue
    next[id] = { ...draftOf(drafts, id), caption: from.caption, ai: from.ai, edited: false }
    count++
  }
  return { drafts: next, count }
}

const withMedia = (draft: TargetDraft, mediaIds: string[]): TargetDraft => ({ ...draft, mediaIds })

/** Ảnh vừa tải lên: gắn cho tab đang mở và mọi tab chưa có ảnh (một lần tải dùng được cho cả bài). */
export function assignUploaded(drafts: Drafts, targetIds: readonly string[], activeId: string, mediaId: string): Drafts {
  const next = { ...drafts }
  for (const id of targetIds) {
    if (id === activeId || draftOf(drafts, id).mediaIds.length === 0) next[id] = withMedia(draftOf(drafts, id), [mediaId])
  }
  return next
}

/** Bấm một ảnh trong kho của bài → ảnh của tab đó (mỗi trang 1 ảnh). */
export const assignImage = (drafts: Drafts, pageId: string, mediaId: string): Drafts => ({ ...drafts, [pageId]: withMedia(draftOf(drafts, pageId), [mediaId]) })

/** "Dùng ảnh này cho mọi trang". */
export function applyImageToAll(drafts: Drafts, targetIds: readonly string[], mediaIds: readonly string[]): Drafts {
  const next = { ...drafts }
  for (const id of targetIds) next[id] = withMedia(draftOf(drafts, id), [...mediaIds])
  return next
}

/** "Bỏ ảnh" của tab. */
export const clearImage = (drafts: Drafts, pageId: string): Drafts => ({ ...drafts, [pageId]: withMedia(draftOf(drafts, pageId), []) })

/* ---------- Lưu / nạp nháp ---------- */

/** Body lưu nháp: đúng thứ tự tab; ý tưởng trống → `null`; `aiCaption` theo nhãn "AI tạo" của tab (Story 6.5). */
export function buildSaveBody(topic: string, targets: readonly Pick<PageDto, 'id'>[], drafts: Drafts): SavePostRequest {
  return {
    topic: topic.trim() || null,
    targets: targets.map((p) => {
      const d = draftOf(drafts, p.id)
      return { pageId: p.id, caption: d.caption, mediaIds: [...d.mediaIds], aiCaption: d.ai }
    }),
  }
}

export interface LoadedDraft {
  topic: string
  selected: Set<string>
  drafts: Drafts
  /** Kho ảnh của bài: mọi ảnh đang gắn, không trùng, theo thứ tự xuất hiện. */
  pool: MediaAssetDto[]
}

/** Nháp từ server → trạng thái Composer. Bỏ target của trang không còn trong danh sách (đã gỡ) — lần lưu sau xoá nó. */
export function draftFromPost(post: PostDto, knownPageIds: ReadonlySet<string>): LoadedDraft {
  const drafts: Drafts = {}
  const pool = new Map<string, MediaAssetDto>()
  const selected = new Set<string>()
  for (const t of post.targets) {
    if (!knownPageIds.has(t.pageId)) continue
    selected.add(t.pageId)
    // Story 6.5: nhãn "AI tạo" lưu ở server; không biết đã sửa lại hay chưa → không gắn "Đã sửa".
    drafts[t.pageId] = { caption: t.caption, mediaIds: t.media.map((m) => m.id), ai: t.aiCaption, edited: false }
    for (const m of t.media) if (!pool.has(m.id)) pool.set(m.id, m)
  }
  return { topic: post.topic ?? '', selected, drafts, pool: [...pool.values()] }
}

/* ---------- Ảnh tải lên ---------- */

export const IMAGE_ACCEPT = POST_IMAGE_MIMES.join(',')

/** Kiểm sớm trước khi gửi (server vẫn kiểm magic bytes). */
export function imageFileIssue(file: { type: string; size: number }): string | null {
  if (!(POST_IMAGE_MIMES as readonly string[]).includes(file.type)) return 'Chỉ nhận ảnh PNG, JPEG hoặc WebP'
  if (file.size === 0 || file.size > POST_IMAGE_MAX_BYTES) return 'Ảnh tối đa 10MB'
  return null
}

/** Lỗi lưu/tải: câu dưới ô (`details[0].message`) nếu có, ngược lại câu theo mã. */
export function composerErrorMessage(err: unknown): string {
  if (isApiError(err) && err.code === 'VALIDATION_FAILED' && Array.isArray(err.details)) {
    const message = (err.details[0] as { message?: unknown } | undefined)?.message
    if (typeof message === 'string') return message
  }
  return errorMessageOf(err)
}

/* ---------- Viết caption bằng AI (Story 6.2) ---------- */

export const GOAL_OPTIONS: { value: ComposeGoal; label: string }[] = [
  { value: 'sales', label: 'Bán hàng' },
  { value: 'engagement', label: 'Tương tác' },
  { value: 'announce', label: 'Thông báo' },
]

export const LENGTH_OPTIONS: { id: ComposeLength; label: string }[] = [
  { id: 'short', label: 'Ngắn' },
  { id: 'medium', label: 'Vừa' },
  { id: 'long', label: 'Dài' },
]

/** Body `POST /posts/compose`: viết mới cho các trang, hoặc sửa caption của MỘT trang (`revise`). */
export function buildComposeBody(input: {
  topic: string
  goal: ComposeGoal
  length: ComposeLength
  pageIds: readonly string[]
  revise?: { action: ComposeReviseAction; caption: string }
}): ComposeCaptionsRequest {
  return {
    topic: input.topic.trim(),
    goal: input.goal,
    length: input.length,
    pageIds: [...input.pageIds],
    ...(input.revise ? { revise: input.revise } : {}),
  }
}

/** Ghi chú AI trên tab của một trang: cụm vi phạm hậu kiểm của caption AI, hoặc mã lỗi khiến trang đó chưa viết được. */
export type AiNote = { violations: AiViolation[] } | { errorCode: ErrorCode }
export type AiNotes = Record<string, AiNote>

/** Mã lỗi khoá mọi nút AI ở Soạn bài (UX-DR2): thiếu / hỏng khoá OpenAI, hết hạn mức. `CONFIG_MISSING` chỉ là lỗi của tab. */
export const COMPOSE_LOCK_CODES = ['OPENAI_KEY_MISSING', 'OPENAI_KEY_INVALID', 'AI_BUDGET_EXCEEDED'] as const
export type ComposeLockCode = (typeof COMPOSE_LOCK_CODES)[number]
const isComposeLockCode = (code: string): code is ComposeLockCode => (COMPOSE_LOCK_CODES as readonly string[]).includes(code)

/**
 * Kết quả AI → trạng thái soạn: trang `ok` nhận caption mới (nhãn "AI tạo", chưa sửa) + cụm vi phạm; trang lỗi giữ
 * nguyên caption, chỉ ghi mã lỗi. `lockCode` = mã khoá đầu tiên gặp (để khoá nút AI).
 */
export function applyComposeResults(
  drafts: Drafts,
  notes: AiNotes,
  results: readonly ComposeCaptionResult[],
): { drafts: Drafts; notes: AiNotes; written: number; failed: number; lockCode: ComposeLockCode | null } {
  const nextDrafts = { ...drafts }
  const nextNotes = { ...notes }
  let written = 0
  let failed = 0
  let lockCode: ComposeLockCode | null = null
  for (const r of results) {
    if (r.status === 'ok') {
      nextDrafts[r.pageId] = { ...draftOf(drafts, r.pageId), caption: r.caption, ai: true, edited: false }
      nextNotes[r.pageId] = { violations: r.violations }
      written++
    } else {
      nextNotes[r.pageId] = { errorCode: r.errorCode }
      failed++
      if (!lockCode && isComposeLockCode(r.errorCode)) lockCode = r.errorCode
    }
  }
  return { drafts: nextDrafts, notes: nextNotes, written, failed, lockCode }
}

/**
 * Câu toast sau một lần AI viết: "AI đã viết cho N trang" (+ số trang chưa viết được); không trang nào viết được → lý do
 * của trang đầu tiên (vd hết hạn mức, chưa có hồ sơ).
 */
export function composeToast(results: readonly ComposeCaptionResult[]): string {
  const written = results.filter((r) => r.status === 'ok').length
  const failed = results.length - written
  if (written === 0) {
    const first = results.find((r) => r.status === 'error')
    return first?.status === 'error' ? aiErrorText(first.errorCode) : 'AI chưa viết được bài nào'
  }
  return failed ? `AI đã viết cho ${written} trang · ${failed} trang chưa viết được` : `AI đã viết cho ${written} trang`
}

/** Mã khoá trong lỗi của cả request (vd mạng vẫn ổn nhưng server trả mã khoá); lỗi khác → `null`. */
export function composeLockCodeOf(err: unknown): ComposeLockCode | null {
  return isApiError(err) && isComposeLockCode(err.code) ? err.code : null
}

/** Khoá nút AI ở Soạn bài: khoá OpenAI (AiLock) → hạn mức `blocked` → mã khoá lần gọi trước. Ô caption luôn sửa được. */
export function composeLock(input: { key: AiLock; budgetBlocked: boolean; serverCode: ComposeLockCode | null }): SuggestLock {
  return suggestLock({ ...input, configMissing: false, pageId: '' })
}

/** Liên kết tạo hồ sơ cho trang (Chi tiết trang › Hồ sơ thương hiệu). */
export const brandProfileLink = (pageId: string) => ({ to: `/trang-nhom/trang/${pageId}`, label: 'Tạo hồ sơ' })

/** Câu ghi chú trên tab khi AI chưa viết được cho trang đó. */
export function aiErrorText(code: ErrorCode): string {
  return code === 'CONFIG_MISSING' ? 'Trang chưa có hồ sơ thương hiệu — tạo hồ sơ để AI viết đúng giọng trang này.' : errorMessage(code)
}

/**
 * Cụm vi phạm của caption AI còn trong chữ đang sửa: từ cấm / URL lạ còn xuất hiện; `too_long` ("N/Max") còn khi chữ
 * vẫn dài hơn Max — đếm như nền tảng (`captionLength`, Threads tính emoji theo byte) giống server.
 */
export function captionViolations(caption: string, platform: Platform, violations: readonly AiViolation[]): AiViolation[] {
  const phrases = remainingViolations(caption, violations.filter((v) => v.kind !== 'too_long'))
  const long = violations.filter((v) => {
    if (v.kind !== 'too_long') return false
    const max = Number(v.text.split('/')[1])
    return Number.isFinite(max) && captionLength(caption.trim(), platform) > max
  })
  return [...phrases, ...long]
}

/* ---------- Sinh ảnh AI (Story 6.3) ---------- */

export const IMAGE_STYLE_OPTIONS: { value: ImageStyle; label: string }[] = [
  { value: 'product', label: 'Ảnh sản phẩm' },
  { value: 'lifestyle', label: 'Phong cách sống' },
  { value: 'minimal', label: 'Tối giản' },
  { value: 'illustration', label: 'Minh hoạ' },
]

/** Mô tả gửi AI: ô "Mô tả ảnh" nếu có, không thì ý tưởng bài. Cả hai trống → chuỗi rỗng (nút khoá). */
export const imagePrompt = (description: string, idea: string): string => description.trim() || idea.trim()

/** Body `POST /media-assets/generate`; `null` khi chưa có gì để mô tả. */
export function buildImageBody(description: string, idea: string, style: ImageStyle): GenerateImagesRequest | null {
  const prompt = imagePrompt(description, idea)
  return prompt ? { prompt, style } : null
}

/** Một ô của lưới ảnh: ô AI đang sinh, ô AI lỗi, hoặc ảnh chọn được (AI đã xong / tải lên / đang gắn). */
export type ImageTile = { kind: 'pending'; id: string } | { kind: 'failed'; id: string; errorCode: ImageErrorCode } | { kind: 'image'; asset: MediaAssetDto }

/**
 * Lưới ảnh: các ô AI của lần sinh hiện tại theo thứ tự `genIds` (chưa có trạng thái → coi như đang sinh; ô đã bị dọn
 * → bỏ), rồi kho ảnh của bài không trùng.
 */
export function imageTiles(genIds: readonly string[], generated: readonly GeneratedImageDto[] | undefined, pool: readonly MediaAssetDto[]): ImageTile[] {
  const byId = new Map((generated ?? []).map((g) => [g.id, g]))
  const tiles: ImageTile[] = []
  const seen = new Set<string>()
  for (const id of genIds) {
    const g = byId.get(id)
    if (!g) {
      if (!generated) tiles.push({ kind: 'pending', id })
      continue
    }
    if (g.status === 'ready' && g.asset) {
      tiles.push({ kind: 'image', asset: g.asset })
      seen.add(g.asset.id)
    } else if (g.status === 'failed') tiles.push({ kind: 'failed', id, errorCode: g.errorCode ?? 'IMAGE_FAILED' })
    else tiles.push({ kind: 'pending', id })
  }
  for (const m of pool) {
    if (!seen.has(m.id)) {
      tiles.push({ kind: 'image', asset: m })
      seen.add(m.id)
    }
  }
  return tiles
}

/** Ảnh chọn được trong lưới (để tìm ảnh đang gắn của tab, xem trước). */
export const tileImages = (tiles: readonly ImageTile[]): MediaAssetDto[] => tiles.flatMap((t) => (t.kind === 'image' ? [t.asset] : []))

/** Số ô AI còn đang sinh (khoá nút "Tạo ảnh AI" cho tới khi xong). */
export const pendingTiles = (tiles: readonly ImageTile[]): number => tiles.filter((t) => t.kind === 'pending').length

/**
 * "Tạo lại ảnh": bộ ảnh AI cũ rời lưới, trừ ảnh đã xong đang gắn cho một tab nào đó — ảnh đó vào kho của bài (không
 * thì tab trỏ tới ảnh không còn hiển thị).
 */
export function keepAttachedGenerated(pool: readonly MediaAssetDto[], generated: readonly GeneratedImageDto[] | undefined, drafts: Drafts): MediaAssetDto[] {
  const attached = new Set(Object.values(drafts).flatMap((d) => d.mediaIds))
  const keep = (generated ?? []).flatMap((g) => (g.status === 'ready' && g.asset && attached.has(g.asset.id) ? [g.asset] : []))
  const known = new Set(pool.map((m) => m.id))
  return [...keep.filter((m) => !known.has(m.id)), ...pool]
}

/** "Thử mô tả khác": bỏ các ô lỗi khỏi lưới (ô đang sinh / đã xong giữ nguyên). */
export function dismissFailed(genIds: readonly string[], generated: readonly GeneratedImageDto[] | undefined): string[] {
  const failed = new Set((generated ?? []).filter((g) => g.status === 'failed').map((g) => g.id))
  return genIds.filter((id) => !failed.has(id))
}

/** Lý do dưới "Không tạo được ảnh này". */
export function imageFailureText(code: ImageErrorCode): string {
  return code === 'IMAGE_REJECTED' ? 'OpenAI từ chối mô tả này.' : 'AI gặp lỗi khi tạo ảnh.'
}

/* ---------- Hook React Query ---------- */

export const postKey = (id: string) => ['posts', id] as const

/**
 * Bài đang mở; `null` → không tải. `poll` (Story 6.4): khoảng hỏi lại theo dữ liệu hiện tại (còn trang đang đăng → hỏi
 * định kỳ phòng lỡ sự kiện realtime), `false` = không hỏi.
 */
export function usePost(id: string | null, poll?: (post: PostDto | undefined) => number | false) {
  return useQuery({
    queryKey: postKey(id ?? ''),
    queryFn: ({ signal }) => apiFetch(`/posts/${id}`, { schema: PostDto, signal }),
    enabled: id !== null,
    retry: false,
    ...(poll ? { refetchInterval: (q: { state: { data: PostDto | undefined } }) => poll(q.state.data) } : {}),
  })
}

/** Lưu nháp: chưa có id → tạo (`POST`), có id → thay toàn bộ đích (`PUT`). */
export function useSavePost() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: SavePostRequest }) =>
      id ? apiFetch(`/posts/${id}`, { method: 'PUT', body, schema: PostDto }) : apiFetch('/posts', { method: 'POST', body, schema: PostDto }),
    onSuccess: (post) => qc.setQueryData(postKey(post.id), post),
  })
}

export function useUploadPostImage() {
  return useMutation({
    mutationFn: (file: File) =>
      apiFetch('/media-assets', { method: 'POST', raw: { data: file, contentType: file.type as PostImageMime }, schema: MediaAssetDto }),
  })
}

/** "Tạo bằng AI" (Story 6.2): JSON một lần, không cache; `signal` để nút "Dừng" huỷ request thật. */
export function useComposeCaptions() {
  return useMutation({
    mutationFn: ({ body, signal }: { body: ComposeCaptionsRequest; signal?: AbortSignal }) =>
      apiFetch('/posts/compose', { method: 'POST', body, schema: ComposeCaptionsResponse, ...(signal ? { signal } : {}) }),
  })
}

/** Trạng thái các ô ảnh AI — khoá gốc `media_assets` để SSE `media_asset.*` làm cũ (realtime.ts). */
export const generatedImagesKey = (ids: readonly string[]) => ['media_assets', 'generated', ids.join(',')] as const

/** Đang có ô chờ → hỏi lại mỗi 10 giây phòng khi lỡ sự kiện realtime (SSE vẫn là đường chính). */
export const GENERATED_POLL_MS = 10_000

export function useGeneratedImages(ids: readonly string[]) {
  return useQuery({
    queryKey: generatedImagesKey(ids),
    queryFn: ({ signal }) => apiFetch(`/media-assets/generated?ids=${ids.join(',')}`, { schema: GeneratedImagesResponse, signal }),
    enabled: ids.length > 0,
    refetchInterval: (q) => (q.state.data?.images.some((i) => i.status === 'pending') ? GENERATED_POLL_MS : false),
  })
}

/** "Tạo ảnh AI": 202 với 4 ô đang sinh — ghi sẵn vào cache để lưới hiện ngay, sau đó SSE cập nhật từng ô. */
export function useGenerateImages() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: GenerateImagesRequest) => apiFetch('/media-assets/generate', { method: 'POST', body, schema: GeneratedImagesResponse }),
    onSuccess: (res) =>
      qc.setQueryData(
        generatedImagesKey(res.images.map((i) => i.id)),
        res,
      ),
  })
}
