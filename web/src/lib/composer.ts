// Soạn bài (Story 6.1) phía web: nháp nhiều trang với caption/ảnh riêng từng trang. Nối Composer vào API thật:
// tải ảnh lên (`POST /media-assets`), lưu nháp (`POST /posts`, sau đó `PUT /posts/:id`), mở lại nháp (`?bai=<id>`).
// Luật nền tảng lấy đúng bảng `publishIssues` của `@ottm/shared` mà server dùng khi lên lịch (AD-13).
// Phần thuần (chọn đích, gắn ảnh, dựng body, nạp nháp, câu lỗi) tách khỏi hook để test được (composer.test.ts).
// Story 6.2: viết caption bằng AI theo hồ sơ từng trang (`POST /posts/compose`, huỷ bằng `signal`) — áp kết quả từng tab
// (`applyComposeResults`), ghi chú lỗi / cụm vi phạm trên tab, khoá nút AI theo khoá OpenAI / hạn mức / mã lỗi (`composeLock`).
import {
  ComposeCaptionsResponse,
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

/** Body lưu nháp: đúng thứ tự tab; ý tưởng trống → `null`. */
export function buildSaveBody(topic: string, targets: readonly Pick<PageDto, 'id'>[], drafts: Drafts): SavePostRequest {
  return {
    topic: topic.trim() || null,
    targets: targets.map((p) => {
      const d = draftOf(drafts, p.id)
      return { pageId: p.id, caption: d.caption, mediaIds: [...d.mediaIds] }
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
    drafts[t.pageId] = { caption: t.caption, mediaIds: t.media.map((m) => m.id), ai: false, edited: false }
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

/* ---------- Hook React Query ---------- */

export const postKey = (id: string) => ['posts', id] as const

/** Nháp đang mở; `null` → không tải. */
export function usePost(id: string | null) {
  return useQuery({
    queryKey: postKey(id ?? ''),
    queryFn: ({ signal }) => apiFetch(`/posts/${id}`, { schema: PostDto, signal }),
    enabled: id !== null,
    retry: false,
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
