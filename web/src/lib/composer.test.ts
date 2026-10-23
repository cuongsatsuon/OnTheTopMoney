// Story 6.1 — helper thuần của Soạn bài: chọn đích theo Phạm vi / nhóm, luật nền tảng trên tab (cùng bảng với server),
// chép caption, gắn ảnh, body lưu nháp, nạp nháp, kiểm file ảnh, câu lỗi.
// Story 6.2 — caption AI: body gọi AI, áp kết quả từng tab, khoá nút AI, cụm vi phạm còn trong chữ, câu ghi chú / toast.
import { ComposeCaptionsRequest, SavePostRequest, type ComposeCaptionResult, type MediaAssetDto, type PageDto, type PostDto } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { SUGGEST_HINTS } from './inbox'
import { AI_LOCK_HINTS } from './openai'
import {
  EMPTY_DRAFT,
  aiErrorText,
  applyComposeResults,
  applyImageToAll,
  assignImage,
  assignUploaded,
  blockingIssues,
  buildComposeBody,
  buildSaveBody,
  captionCounter,
  captionViolations,
  clearImage,
  composeLock,
  composeLockCodeOf,
  composeToast,
  composerErrorMessage,
  copyCaptionToEmpty,
  draftFromPost,
  imageFileIssue,
  initialSelection,
  issueText,
  issuesFor,
  orderedTargets,
  toggleGroupSelection,
  type Drafts,
} from './composer'

const id = (n: number) => `0199c0de-0000-7000-8000-${String(n).padStart(12, '0')}`
const G1 = id(100)
const G2 = id(101)
const page = (n: number, platform: PageDto['platform'], groupId: string | null, connectionStatus: PageDto['connectionStatus'] = 'active'): PageDto => ({
  id: id(n),
  platform,
  name: `Trang ${n}`,
  handle: null,
  avatarUrl: null,
  groupId,
  connectionStatus,
  connectedAt: '2026-10-01T00:00:00.000Z',
})
const FB = page(1, 'facebook', G1)
const IG = page(2, 'instagram', G1)
const TH = page(3, 'threads', G1, 'disconnected')
const SOLO = page(4, 'threads', null)
const PAGES = [FB, IG, TH, SOLO]

const draft = (caption: string, mediaIds: string[] = []) => ({ ...EMPTY_DRAFT, caption, mediaIds })

describe('chọn đích', () => {
  it('Phạm vi nhóm → trang chọn được của nhóm (bỏ trang mất kết nối); trang → trang đó; tất cả → không chọn', () => {
    expect(initialSelection({ kind: 'group', id: G1 }, PAGES)).toEqual([FB.id, IG.id])
    expect(initialSelection({ kind: 'group', id: G2 }, PAGES)).toEqual([])
    expect(initialSelection({ kind: 'page', id: SOLO.id }, PAGES)).toEqual([SOLO.id])
    expect(initialSelection({ kind: 'page', id: TH.id }, PAGES)).toEqual([])
    expect(initialSelection({ kind: 'all' }, PAGES)).toEqual([])
  })

  it('bấm nhóm: thêm trang chọn được còn thiếu; đã đủ → bỏ cả nhóm; trang khác giữ nguyên', () => {
    const group = [FB, IG, TH]
    const added = toggleGroupSelection(new Set([IG.id, SOLO.id]), group)
    expect([...added].sort()).toEqual([FB.id, IG.id, SOLO.id].sort())
    expect([...toggleGroupSelection(added, group)]).toEqual([SOLO.id])
  })

  it('tab theo thứ tự danh sách trang', () => {
    expect(orderedTargets(PAGES, new Set([SOLO.id, FB.id])).map((p) => p.id)).toEqual([FB.id, SOLO.id])
  })
})

describe('luật nền tảng trên tab', () => {
  it('Threads 520 ký tự → dòng lỗi có tên nền tảng; bộ đếm n/500 đỏ', () => {
    const issues = issuesFor('threads', draft('a'.repeat(520)))
    expect(issues.map((i) => issueText(i, 'threads'))).toEqual(['Threads tối đa 500 ký tự (đang 520)'])
    expect(captionCounter('threads', 'a'.repeat(520))).toEqual({ text: '520/500', over: true })
    expect(captionCounter('instagram', '🔥ab')).toEqual({ text: '3/2.200', over: false })
    // Threads đếm emoji theo byte UTF-8 (🔥 = 4, 👍🏻 = 8); chữ tiếng Việt dựng sẵn vẫn 1.
    expect(captionCounter('threads', '🔥ab')).toEqual({ text: '6/500', over: false })
    expect(captionCounter('threads', 'Việt 👍🏻')).toEqual({ text: '13/500', over: false })
    expect(captionCounter('threads', `${'a'.repeat(493)}🔥😍`)).toEqual({ text: '501/500', over: true })
    expect(captionCounter('facebook', 'abc')).toEqual({ text: '3 ký tự', over: false })
  })

  it('Instagram chưa ảnh → "Instagram cần ít nhất 1 ảnh"; quá 30 hashtag', () => {
    expect(issuesFor('instagram', draft('chào')).map((i) => issueText(i, 'instagram'))).toEqual(['Instagram cần ít nhất 1 ảnh'])
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ')
    expect(issuesFor('instagram', draft(tags, [id(9)])).map((i) => issueText(i, 'instagram'))).toEqual(['Instagram tối đa 30 hashtag (đang 31)'])
  })

  it('tab trống: chỉ gợi ý xám (không chặn); IG trống vẫn chặn vì thiếu ảnh', () => {
    const fb = issuesFor('facebook', draft(''))
    expect(fb.map((i) => i.code)).toEqual(['POST_EMPTY'])
    expect(blockingIssues(fb)).toEqual([])
    expect(blockingIssues(issuesFor('instagram', draft(''))).map((i) => i.code)).toEqual(['MEDIA_REQUIRED'])
    expect(issuesFor('facebook', draft('', [id(9)]))).toEqual([])
  })
})

describe('nội dung và ảnh', () => {
  const ids = [FB.id, IG.id, SOLO.id]

  it('chép caption sang tab còn trống (không đè tab đã viết)', () => {
    const drafts: Drafts = { [FB.id]: draft('Bài gốc'), [IG.id]: draft('Đã viết') }
    const { drafts: next, count } = copyCaptionToEmpty(drafts, ids, FB.id)
    expect(count).toBe(1)
    expect([next[FB.id]!.caption, next[IG.id]!.caption, next[SOLO.id]!.caption]).toEqual(['Bài gốc', 'Đã viết', 'Bài gốc'])
    expect(copyCaptionToEmpty({}, ids, FB.id).count).toBe(0)
  })

  it('tải ảnh khi 2/3 tab chưa ảnh → gắn cho tab đang mở + tab trống; dùng cho mọi trang; bỏ ảnh', () => {
    const [a, b] = [id(50), id(51)]
    const drafts: Drafts = { [IG.id]: draft('ig', [a]) }
    const uploaded = assignUploaded(drafts, ids, FB.id, b)
    expect(ids.map((x) => uploaded[x]?.mediaIds)).toEqual([[b], [a], [b]])
    const onIg = assignUploaded(drafts, ids, IG.id, b)
    expect(ids.map((x) => onIg[x]?.mediaIds)).toEqual([[b], [b], [b]])
    expect(ids.map((x) => applyImageToAll(drafts, ids, [a])[x]?.mediaIds)).toEqual([[a], [a], [a]])
    expect(assignImage(drafts, FB.id, a)[FB.id]?.mediaIds).toEqual([a])
    expect(clearImage(drafts, IG.id)[IG.id]).toEqual(draft('ig'))
  })
})

describe('lưu / nạp nháp', () => {
  const asset = (n: number): MediaAssetDto => ({ id: id(n), source: 'upload', url: `https://res.cloudinary.com/demo/image/upload/v1/${n}.jpg`, width: 1, height: 1, createdAt: '2026-10-24T00:00:00.000Z' })

  it('body đúng thứ tự tab, ý tưởng trống → null, hợp lệ với schema server', () => {
    const body = buildSaveBody('   ', [FB, SOLO], { [FB.id]: draft('fb', [id(50)]) })
    expect(body).toEqual({
      topic: null,
      targets: [
        { pageId: FB.id, caption: 'fb', mediaIds: [id(50)] },
        { pageId: SOLO.id, caption: '', mediaIds: [] },
      ],
    })
    expect(SavePostRequest.safeParse(body).success).toBe(true)
    expect(buildSaveBody(' Ý tưởng ', [FB], {}).topic).toBe('Ý tưởng')
  })

  it('nạp PostDto → state; bỏ target của trang không còn; kho ảnh không trùng', () => {
    const t = (pageId: string, caption: string, media: MediaAssetDto[]) => ({ id: id(70 + caption.length), pageId, status: 'draft' as const, caption, media, version: 0, scheduledAt: null, errorCode: null })
    const post: PostDto = {
      id: id(60),
      source: 'manual',
      topic: null,
      targets: [t(FB.id, 'fb', [asset(50)]), t(IG.id, 'ig', [asset(50)]), t(id(99), 'gone', [asset(51)])],
      createdAt: '2026-10-24T00:00:00.000Z',
      updatedAt: '2026-10-24T00:00:00.000Z',
    }
    const loaded = draftFromPost(post, new Set(PAGES.map((p) => p.id)))
    expect(loaded.topic).toBe('')
    expect([...loaded.selected]).toEqual([FB.id, IG.id])
    expect(loaded.drafts[IG.id]).toEqual(draft('ig', [id(50)]))
    expect(loaded.pool.map((m) => m.id)).toEqual([id(50)])
  })
})

describe('file ảnh và câu lỗi', () => {
  it('gif / 11 MB / rỗng → báo trước khi gửi; png 1 MB → được', () => {
    expect(imageFileIssue({ type: 'image/gif', size: 100 })).toBe('Chỉ nhận ảnh PNG, JPEG hoặc WebP')
    expect(imageFileIssue({ type: 'image/png', size: 11 * 1024 * 1024 })).toBe('Ảnh tối đa 10MB')
    expect(imageFileIssue({ type: 'image/jpeg', size: 0 })).toBe('Ảnh tối đa 10MB')
    expect(imageFileIssue({ type: 'image/png', size: 1024 * 1024 })).toBeNull()
  })

  it('lỗi dưới ô (details) ưu tiên; mã khác → câu chung', () => {
    expect(composerErrorMessage(new ApiError('VALIDATION_FAILED', 400, 'x', [{ path: ['image'], message: 'Định dạng ảnh không khớp' }]))).toBe('Định dạng ảnh không khớp')
    expect(composerErrorMessage(new ApiError('MEDIA_NOT_CONFIGURED', 500, 'x'))).toMatch(/Cloudinary/)
  })
})

describe('Viết caption bằng AI (Story 6.2)', () => {
  const A = id(1)
  const B = id(2)
  const C = id(3)

  it('buildComposeBody: viết mới / sửa một tab; body hợp lệ với hợp đồng server', () => {
    const write = buildComposeBody({ topic: '  Khuyến mãi nồi chiên  ', goal: 'sales', length: 'short', pageIds: [A, B] })
    expect(write).toEqual({ topic: 'Khuyến mãi nồi chiên', goal: 'sales', length: 'short', pageIds: [A, B] })
    expect(ComposeCaptionsRequest.safeParse(write).success).toBe(true)
    const shorter = buildComposeBody({ topic: '', goal: 'announce', length: 'medium', pageIds: [A], revise: { action: 'shorter', caption: 'Bản cũ' } })
    expect(ComposeCaptionsRequest.safeParse(shorter).success).toBe(true)
    // Viết mới khi chưa có ý tưởng → server từ chối đúng ô.
    const bad = ComposeCaptionsRequest.safeParse(buildComposeBody({ topic: ' ', goal: 'sales', length: 'medium', pageIds: [A] }))
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.path).toEqual(['topic'])
  })

  it('applyComposeResults: tab ok đổi caption + nhãn AI; tab lỗi giữ caption + ghi mã; mã khoá đầu tiên', () => {
    const drafts: Drafts = {
      [A]: { ...EMPTY_DRAFT, caption: 'cũ A', edited: true, ai: true, mediaIds: ['m1'] },
      [B]: { ...EMPTY_DRAFT, caption: 'cũ B' },
    }
    const results: ComposeCaptionResult[] = [
      { pageId: A, status: 'ok', caption: 'Mới A', violations: [{ kind: 'banned_word', text: 'rẻ nhất' }] },
      { pageId: B, status: 'error', errorCode: 'CONFIG_MISSING' },
      { pageId: C, status: 'error', errorCode: 'AI_PROVIDER_ERROR' },
    ]
    const r = applyComposeResults(drafts, { [B]: { violations: [] } }, results)
    expect(r.drafts[A]).toEqual({ caption: 'Mới A', mediaIds: ['m1'], ai: true, edited: false })
    expect(r.drafts[B]).toEqual(drafts[B])
    expect(r.drafts[C]).toBeUndefined()
    expect(r.notes).toEqual({
      [A]: { violations: [{ kind: 'banned_word', text: 'rẻ nhất' }] },
      [B]: { errorCode: 'CONFIG_MISSING' },
      [C]: { errorCode: 'AI_PROVIDER_ERROR' },
    })
    expect(r).toMatchObject({ written: 1, failed: 2, lockCode: null })
    const budget = applyComposeResults({}, {}, [
      { pageId: A, status: 'ok', caption: 'x', violations: [] },
      { pageId: B, status: 'error', errorCode: 'AI_BUDGET_EXCEEDED' },
      { pageId: C, status: 'error', errorCode: 'OPENAI_KEY_INVALID' },
    ])
    expect(budget.lockCode).toBe('AI_BUDGET_EXCEEDED')
  })

  it('composeLock: mở khi mọi nguồn ổn; khoá theo khoá OpenAI → hạn mức → mã lần trước (không có liên kết hồ sơ)', () => {
    const key = { locked: false, hint: null }
    expect(composeLock({ key, budgetBlocked: false, serverCode: null })).toEqual({ locked: false, hint: null, link: null })
    expect(composeLock({ key: { locked: true, hint: AI_LOCK_HINTS.invalid }, budgetBlocked: true, serverCode: null })).toEqual({ locked: true, hint: AI_LOCK_HINTS.invalid, link: null })
    expect(composeLock({ key, budgetBlocked: true, serverCode: null })).toEqual({ locked: true, hint: SUGGEST_HINTS.budget, link: null })
    expect(composeLock({ key, budgetBlocked: false, serverCode: 'OPENAI_KEY_MISSING' }).hint).toBe(AI_LOCK_HINTS.missing)
    expect(composeLock({ key, budgetBlocked: false, serverCode: 'AI_BUDGET_EXCEEDED' }).hint).toBe(SUGGEST_HINTS.budget)
    expect(composeLockCodeOf(new ApiError('OPENAI_KEY_INVALID', 400, 'x'))).toBe('OPENAI_KEY_INVALID')
    expect(composeLockCodeOf(new ApiError('CONFIG_MISSING', 422, 'x'))).toBeNull()
    expect(composeLockCodeOf(new Error('x'))).toBeNull()
  })

  it('captionViolations: cụm còn trong chữ (không phân biệt hoa thường); too_long đếm như nền tảng (Threads: emoji theo byte)', () => {
    const v = [
      { kind: 'banned_word', text: 'rẻ nhất' },
      { kind: 'disallowed_url', text: 'evil.com' },
      { kind: 'too_long', text: '506/500' },
    ] as const
    const threads = `${'a'.repeat(490)} RẺ NHẤT😍`
    expect(captionViolations(threads, 'threads', v).map((x) => x.kind)).toEqual(['banned_word', 'too_long']) // 490+1+7+4 = 502
    expect(captionViolations(`${'a'.repeat(495)}😍`, 'threads', v)).toEqual([]) // 495 + 4 = 499
    expect(captionViolations(`${'a'.repeat(495)}😍😍`, 'facebook', v)).toEqual([]) // code point: 497
  })

  it('aiErrorText / composeToast: câu theo mã; tóm tắt số trang viết được / chưa', () => {
    expect(aiErrorText('CONFIG_MISSING')).toContain('chưa có hồ sơ thương hiệu')
    expect(aiErrorText('AI_PROVIDER_ERROR')).not.toBe('')
    expect(composeToast([{ pageId: A, status: 'ok', caption: 'x', violations: [] }])).toBe('AI đã viết cho 1 trang')
    expect(
      composeToast([
        { pageId: A, status: 'ok', caption: 'x', violations: [] },
        { pageId: B, status: 'error', errorCode: 'CONFIG_MISSING' },
      ]),
    ).toBe('AI đã viết cho 1 trang · 1 trang chưa viết được')
    expect(composeToast([{ pageId: B, status: 'error', errorCode: 'CONFIG_MISSING' }])).toBe(aiErrorText('CONFIG_MISSING'))
  })
})
