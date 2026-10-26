// Soạn bài (Story 6.1, AD-13, AD-14, module `content`). Một bài thủ công = một `posts` + n `post_targets` (mỗi trang
// một đích, caption/ảnh có thể riêng). Bảng ràng buộc nền tảng ở đây là nguồn DUY NHẤT: FE báo ngay trên tab trang,
// server (`content.assertPublishable`) chặn khi lên lịch (Story 6.4). Nháp được lưu cả khi còn vi phạm.
import { z } from 'zod'
import { AiViolation } from './ai.ts'
import { MediaAssetSource, MediaAssetStatus, Platform, PostSource, PostTargetStatus } from './enums.ts'
import { ErrorCode } from './errors.ts'
import { ScopeParam } from './scope.ts'

const IsoDateTime = z.iso.datetime({ offset: false })

/* ---------- Ràng buộc nền tảng ---------- */

export interface PlatformRule {
  /** Số ký tự tối đa của caption (đếm như `captionLength`). */
  captionMax: number
  /** Số hashtag tối đa; `null` = nền tảng không giới hạn riêng. */
  hashtagMax: number | null
  /** Bài phải có ít nhất 1 ảnh. */
  mediaRequired: boolean
  /**
   * Số bài đăng qua API tối đa trong 24 giờ trượt của một trang (Story 6.4, `PUBLISH_LIMIT_REACHED`); `null` = Meta
   * không công bố. Server kiểm bảo thủ trên bài của app khi lên lịch; hạn mức thật (gồm bài đăng ngoài app) kiểm lại
   * bằng API trong job đăng.
   */
  dailyPublishMax: number | null
}

/**
 * Facebook: giới hạn chữ của bài Page; Instagram: 2.200 ký tự, 30 hashtag, bắt buộc ảnh, 100 bài API/24h; Threads: 500
 * ký tự, 250 bài/24h (tài liệu Meta "Content Publishing" / "Threads Posts").
 */
export const PLATFORM_RULES: Record<Platform, PlatformRule> = {
  facebook: { captionMax: 63_206, hashtagMax: null, mediaRequired: false, dailyPublishMax: null },
  instagram: { captionMax: 2_200, hashtagMax: 30, mediaRequired: true, dailyPublishMax: 100 },
  threads: { captionMax: 500, hashtagMax: null, mediaRequired: false, dailyPublishMax: 250 },
}

/** Khung tỉ lệ ảnh feed Instagram (rộng / cao): dọc nhất 4:5, ngang nhất 1,91:1. */
export const INSTAGRAM_ASPECT = { min: 4 / 5, max: 1.91 } as const

/**
 * Ảnh có vừa khung feed Instagram không (Story 6.4): `pad_tall` = dọc hơn 4:5 (ảnh điện thoại 3:4, 9:16), `pad_wide` =
 * ngang hơn 1,91:1. Ngoài khung thì lúc đăng ảnh được ĐỆM nền trắng vào khung gần nhất (không cắt — giữ trọn sản
 * phẩm); xem trước IG ở Soạn bài hiện đúng như vậy. Kích thước không hợp lệ → `ok` (không đoán).
 */
export function instagramImageFit(width: number, height: number): 'ok' | 'pad_tall' | 'pad_wide' {
  if (!(width > 0 && height > 0)) return 'ok'
  const ratio = width / height
  // Sai số làm tròn của ảnh đúng 4:5 (vd 1080×1350) không được tính là ngoài khung.
  if (ratio < INSTAGRAM_ASPECT.min - 1e-3) return 'pad_tall'
  if (ratio > INSTAGRAM_ASPECT.max + 1e-3) return 'pad_wide'
  return 'ok'
}

/** Caption dài nhất lưu được (nháp) — lớn nhất trong các nền tảng; luật riêng từng nền tảng chỉ chặn khi lên lịch. */
export const POST_CAPTION_MAX = Math.max(...Object.values(PLATFORM_RULES).map((r) => r.captionMax))
/** Ảnh mỗi trang [ASSUMPTION theo UX "chọn 1 ảnh"]; danh sách để mở carousel sau mà không đổi hợp đồng. */
export const POST_TARGET_MEDIA_MAX = 1
/** Số trang đích tối đa của một bài [ASSUMPTION]. */
export const POST_TARGETS_MAX = 50
/** Ý tưởng bài (ô "Ý tưởng bài viết"). */
export const POST_TOPIC_MAX = 1000

/** Code point thuộc emoji: hình, bổ trợ màu da, cờ, ZWJ, VS16, keycap, tag (cờ vùng). Chữ số / `#` không tính. */
const EMOJI_PART_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}]/u
/** Ký tự nối của chuỗi emoji: ZWJ, VS16, keycap; tag U+E0020–E007F xét theo khoảng. */
const EMOJI_JOINERS = new Set([0x200d, 0xfe0f, 0x20e3])
const isEmojiPart = (ch: string, cp: number) => EMOJI_JOINERS.has(cp) || (cp >= 0xe0020 && cp <= 0xe007f) || EMOJI_PART_RE.test(ch)

const utf8Bytes = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4)

/**
 * Số ký tự như nền tảng đếm: theo code point (chữ tiếng Việt dựng sẵn = 1). Riêng Threads: tài liệu Meta ghi "emoji
 * được tính bằng số byte UTF-8" — mỗi code point emoji tính theo byte (😍 = 4, 👍🏻 = 8, gia đình 4 người = 25), không
 * thì bài qua kiểm ở đây vẫn bị Threads từ chối. FE (bộ đếm tab) và server (`publishIssues`) cùng gọi.
 */
export function captionLength(caption: string, platform?: Platform): number {
  if (platform !== 'threads') return [...caption].length
  let n = 0
  for (const ch of caption) {
    const cp = ch.codePointAt(0)!
    n += isEmojiPart(ch, cp) ? utf8Bytes(cp) : 1
  }
  return n
}

const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu

/** Số hashtag (`#` + chữ/số/gạch dưới, có dấu tiếng Việt). */
export function countHashtags(caption: string): number {
  return caption.match(HASHTAG_RE)?.length ?? 0
}

export const PUBLISH_ISSUE_CODES = ['POST_EMPTY', 'MEDIA_REQUIRED', 'CAPTION_TOO_LONG', 'TOO_MANY_HASHTAGS'] as const satisfies readonly ErrorCode[]
export const PublishIssueCode = z.enum(PUBLISH_ISSUE_CODES)
export type PublishIssueCode = z.infer<typeof PublishIssueCode>

/** Một vi phạm luật nền tảng; `limit`/`actual` có với độ dài và hashtag. */
export const PublishIssue = z.object({
  code: PublishIssueCode,
  limit: z.number().int().nonnegative().optional(),
  actual: z.number().int().nonnegative().optional(),
})
export type PublishIssue = z.infer<typeof PublishIssue>

/**
 * Vi phạm của bài trên một nền tảng, theo thứ tự: trống (không chữ, không ảnh) → thiếu ảnh → quá dài → quá nhiều
 * hashtag. Rỗng = đăng được (về mặt nội dung). FE (tab trang) và server (`assertPublishable`) cùng gọi.
 */
export function publishIssues(input: { platform: Platform; caption: string; mediaCount: number }): PublishIssue[] {
  const rule = PLATFORM_RULES[input.platform]
  const issues: PublishIssue[] = []
  if (input.caption.trim() === '' && input.mediaCount === 0) issues.push({ code: 'POST_EMPTY' })
  if (rule.mediaRequired && input.mediaCount === 0) issues.push({ code: 'MEDIA_REQUIRED' })
  const length = captionLength(input.caption, input.platform)
  if (length > rule.captionMax) issues.push({ code: 'CAPTION_TOO_LONG', limit: rule.captionMax, actual: length })
  if (rule.hashtagMax !== null) {
    const tags = countHashtags(input.caption)
    if (tags > rule.hashtagMax) issues.push({ code: 'TOO_MANY_HASHTAGS', limit: rule.hashtagMax, actual: tags })
  }
  return issues
}

/* ---------- Ảnh bài (media_assets) ---------- */

/** Ảnh tải lên: PNG/JPEG/WebP (magic bytes kiểm ở server; SVG/GIF bị từ chối), lưu dạng JPEG sRGB không EXIF. */
export const POST_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const PostImageMime = z.enum(POST_IMAGE_MIMES)
export type PostImageMime = z.infer<typeof PostImageMime>
/** Giới hạn ảnh của gói Cloudinary Free (AD-14). */
export const POST_IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** `POST /api/v1/media-assets` (body = bytes của ảnh, `Content-Type` = MIME) → 201. URL công khai `res.cloudinary.com`. */
export const MediaAssetDto = z.object({
  id: z.uuid(),
  source: MediaAssetSource,
  url: z.url(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  createdAt: IsoDateTime,
})
export type MediaAssetDto = z.infer<typeof MediaAssetDto>

/* ---------- Sinh ảnh AI (Story 6.3, AD-14) ---------- */

/** Số ảnh mỗi lần bấm "Tạo ảnh AI" (UX F4: "sinh 4 ảnh; chọn 1"). Mỗi ảnh một job `content.image.generate`. */
export const IMAGE_GENERATE_COUNT = 4
/** Ô đang sinh quá lâu (job mất, worker chết) thì đọc ra `failed IMAGE_FAILED` [ASSUMPTION 15 phút > 3 lượt job]. */
export const IMAGE_PENDING_MS = 15 * 60_000
/** Số id tối đa khi hỏi trạng thái ô ảnh (`GET /media-assets/generated`). */
export const GENERATED_IMAGES_QUERY_MAX = 40

/**
 * Mục tiêu bài (ô "Mục tiêu" ở Soạn bài): bán hàng, tương tác, thông báo. Story 6.7: cũng là "mục đích" của ảnh AI
 * (khai báo trước hợp đồng ảnh vì `GenerateImagesRequest` dùng).
 */
export const COMPOSE_GOALS = ['sales', 'engagement', 'announce'] as const
export const ComposeGoal = z.enum(COMPOSE_GOALS)
export type ComposeGoal = z.infer<typeof ComposeGoal>

/**
 * Phong cách ảnh (ô "Phong cách" ở mục Ảnh): ảnh sản phẩm, phong cách sống, tối giản, minh hoạ. Story 6.7 thêm premium,
 * studio, trẻ trung, năng động, 3D (theo FlowMate). Phong cách không lưu DB (chỉ prompt đã dựng) — thêm giá trị không
 * làm hỏng dữ liệu cũ.
 */
export const IMAGE_STYLES = ['product', 'lifestyle', 'minimal', 'illustration', 'premium', 'studio', 'youthful', 'dynamic', 'render_3d'] as const
export const ImageStyle = z.enum(IMAGE_STYLES)
export type ImageStyle = z.infer<typeof ImageStyle>

/**
 * Kiểu ảnh AI (Story 6.8, theo hướng TNUT Media): `ad` = ảnh quảng cáo dựng theo ý tưởng bài, được có tiêu đề / câu ngắn
 * tiếng Việt và bố cục poster / collage (mặc định); `clean` = ảnh chụp sạch, không chữ (gần hành vi 6.3–6.7). Không lưu
 * DB (chỉ prompt đã dựng) — body cũ thiếu trường hiểu là `ad`.
 */
export const IMAGE_MODES = ['ad', 'clean'] as const
export const ImageMode = z.enum(IMAGE_MODES)
export type ImageMode = z.infer<typeof ImageMode>

/** Story 6.8: số ký tự tối đa của đoạn caption (tóm ý, bỏ hashtag / URL) đưa vào brief ảnh [ASSUMPTION]. */
export const IMAGE_BRIEF_CAPTION_MAX = 400

/** Lý do một ô ảnh không tạo được: OpenAI từ chối nội dung / lỗi khác (hết hạn mức giữa chừng, kho lỗi…). */
export const IMAGE_ERROR_CODES = ['IMAGE_REJECTED', 'IMAGE_FAILED'] as const satisfies readonly ErrorCode[]
export const ImageErrorCode = z.enum(IMAGE_ERROR_CODES)
export type ImageErrorCode = z.infer<typeof ImageErrorCode>

/**
 * Cạnh dài tối đa (px) của ảnh server gửi cho OpenAI (Story 6.6: ảnh tham khảo, ảnh caption đọc) — tải bản thu nhỏ từ
 * kho, đủ cho model đọc / giữ chi tiết sản phẩm mà không đội token ảnh vào [ASSUMPTION].
 */
export const AI_INPUT_IMAGE_MAX_SIDE = 1024

/** Trang đích gửi kèm yêu cầu ảnh (Story 6.7) — server tìm hồ sơ thương hiệu chung để lấy tông màu. */
const ImagePageIds = z.array(z.uuid()).max(POST_TARGETS_MAX, `Tối đa ${POST_TARGETS_MAX} trang`)

/**
 * Body `POST /api/v1/media-assets/generate`: mô tả ảnh (Composer gửi "Mô tả ảnh", trống thì ý tưởng bài) + phong cách.
 * Story 6.6: có `referenceId` (ảnh đã có trong kho, `ready`) → AI giữ đúng sản phẩm trong ảnh đó, `prompt` là yêu cầu
 * bối cảnh, `style` không dùng.
 * Story 6.7: `goal` (mục tiêu bài → mục đích ảnh) và `pageIds` (trang đích; cùng một hồ sơ thương hiệu → thêm tông màu
 * thương hiệu vào prompt). Cả hai tuỳ chọn, không mặc định — body cũ giữ nguyên nghĩa.
 * Story 6.8: `imageMode` (mặc định `ad`); `topic` (ý tưởng bài) + `caption` (caption bài, server cắt tóm ý) làm brief ý
 * tưởng cho ảnh — tuỳ chọn, `prompt` vẫn là phần chính (mô tả của chủ shop, trống thì ý tưởng).
 */
export const GenerateImagesRequest = z
  .object({
    prompt: z.string().trim().min(1, 'Nhập mô tả ảnh hoặc ý tưởng bài').max(POST_TOPIC_MAX, `Mô tả tối đa ${POST_TOPIC_MAX} ký tự`),
    style: ImageStyle.default('product'),
    referenceId: z.uuid().optional(),
    goal: ComposeGoal.optional(),
    pageIds: ImagePageIds.optional(),
    imageMode: ImageMode.default('ad'),
    topic: z.string().trim().max(POST_TOPIC_MAX, `Ý tưởng tối đa ${POST_TOPIC_MAX} ký tự`).optional(),
    caption: z.string().trim().max(POST_CAPTION_MAX, `Nội dung tối đa ${POST_CAPTION_MAX} ký tự`).optional(),
  })
  .strict()
export type GenerateImagesRequest = z.input<typeof GenerateImagesRequest>
export type ParsedGenerateImagesRequest = z.output<typeof GenerateImagesRequest>

/* ---------- AI viết mô tả ảnh (Story 6.7) ---------- */

/**
 * Hướng viết mô tả (chip "AI viết mô tả" ở mục Ảnh, theo "Gợi ý prompt nhanh" của FlowMate): chi tiết hơn, ảnh sản
 * phẩm, banner khuyến mãi, lifestyle, feedback khách hàng, mùa lễ. Enum — không nhận "hướng" chữ tự do.
 */
export const IMAGE_PROMPT_DIRECTIONS = ['detail', 'product', 'promo', 'lifestyle', 'feedback', 'seasonal'] as const
export const ImagePromptDirection = z.enum(IMAGE_PROMPT_DIRECTIONS)
export type ImagePromptDirection = z.infer<typeof ImagePromptDirection>

/**
 * Body `POST /api/v1/media-assets/image-prompt`: AI viết lại "Mô tả ảnh" đang có (trống thì từ ý tưởng bài) thành mô tả
 * chi tiết theo `direction`; không lưu gì. `withReference` = đang dùng ảnh tham khảo (chỉ tả bối cảnh). Cần ít nhất
 * mô tả hoặc ý tưởng. Story 6.8: `imageMode` (mặc định `ad`) — `ad` viết brief ảnh quảng cáo, `clean` tả cảnh không chữ.
 */
export const ImagePromptRequest = z
  .object({
    description: z.string().trim().max(POST_TOPIC_MAX, `Mô tả tối đa ${POST_TOPIC_MAX} ký tự`).default(''),
    topic: z.string().trim().max(POST_TOPIC_MAX, `Ý tưởng tối đa ${POST_TOPIC_MAX} ký tự`).default(''),
    direction: ImagePromptDirection,
    goal: ComposeGoal.optional(),
    style: ImageStyle.optional(),
    withReference: z.boolean().default(false),
    pageIds: ImagePageIds.optional(),
    imageMode: ImageMode.default('ad'),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!body.description && !body.topic) ctx.addIssue({ code: 'custom', path: ['description'], message: 'Nhập mô tả ảnh hoặc ý tưởng bài' })
  })
export type ImagePromptRequest = z.input<typeof ImagePromptRequest>
export type ParsedImagePromptRequest = z.output<typeof ImagePromptRequest>

/** `POST /media-assets/image-prompt` → 200: mô tả mới (một đoạn, ≤ `POST_TOPIC_MAX` — gửi thẳng được cho "Tạo ảnh AI"). */
export const ImagePromptResponse = z.object({ description: z.string().min(1).max(POST_TOPIC_MAX) })
export type ImagePromptResponse = z.infer<typeof ImagePromptResponse>

/** Một ô ảnh AI: `asset` có khi `ready`; `errorCode` có khi `failed`. */
export const GeneratedImageDto = z.object({
  id: z.uuid(),
  status: MediaAssetStatus,
  errorCode: ImageErrorCode.nullable(),
  asset: MediaAssetDto.nullable(),
  createdAt: IsoDateTime,
})
export type GeneratedImageDto = z.infer<typeof GeneratedImageDto>

/** `POST /media-assets/generate` → 202 (4 ô `pending`); `GET /media-assets/generated?ids=` → 200 theo thứ tự `ids`. */
export const GeneratedImagesResponse = z.object({ images: z.array(GeneratedImageDto) })
export type GeneratedImagesResponse = z.infer<typeof GeneratedImagesResponse>

/* ---------- Bài + đích ---------- */

export const SavePostTarget = z
  .object({
    pageId: z.uuid(),
    caption: z.string().max(POST_CAPTION_MAX, `Nội dung tối đa ${POST_CAPTION_MAX} ký tự`),
    mediaIds: z.array(z.uuid()).max(POST_TARGET_MEDIA_MAX, `Mỗi trang tối đa ${POST_TARGET_MEDIA_MAX} ảnh`),
    /** Caption do AI viết (nhãn "AI tạo" của tab, kể cả khi chủ shop sửa lại) — Story 6.5, UX-DR10. */
    aiCaption: z.boolean().default(false),
  })
  .strict()
export type SavePostTarget = z.input<typeof SavePostTarget>

/**
 * Body `POST /api/v1/posts` (tạo nháp thủ công) và `PUT /api/v1/posts/:id` (thay toàn bộ đích của nháp). `topic` =
 * ý tưởng; trống → `null`. Thứ tự `targets` = thứ tự tab. Trang trùng → lỗi dưới đúng dòng.
 */
export const SavePostRequest = z
  .object({
    topic: z
      .string()
      .trim()
      .max(POST_TOPIC_MAX, `Ý tưởng tối đa ${POST_TOPIC_MAX} ký tự`)
      .nullish()
      .transform((v) => (v ? v : null)),
    targets: z.array(SavePostTarget).min(1, 'Chọn ít nhất 1 trang').max(POST_TARGETS_MAX, `Tối đa ${POST_TARGETS_MAX} trang`),
  })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>()
    body.targets.forEach((t, i) => {
      if (seen.has(t.pageId)) ctx.addIssue({ code: 'custom', path: ['targets', i, 'pageId'], message: 'Trang bị chọn hai lần' })
      seen.add(t.pageId)
    })
  })
export type SavePostRequest = z.input<typeof SavePostRequest>
export type ParsedSavePostRequest = z.output<typeof SavePostRequest>

export const PostTargetDto = z.object({
  id: z.uuid(),
  pageId: z.uuid(),
  status: PostTargetStatus,
  caption: z.string(),
  /** Caption do AI viết (Story 6.5) — Soạn bài mở lại nháp vẫn giữ nhãn "AI tạo". */
  aiCaption: z.boolean(),
  /** Ảnh theo thứ tự đăng. */
  media: z.array(MediaAssetDto),
  /** Khoá lạc quan (AD-13) — tăng mỗi lần target đổi. */
  version: z.number().int().nonnegative(),
  scheduledAt: IsoDateTime.nullable(),
  /** `ErrorCode` khi `failed` (Story 6.4: `PUBLISH_*`, `PAGE_DISCONNECTED`, luật nền tảng lúc đăng…). */
  errorCode: ErrorCode.nullable(),
  /** Lúc bài lên trang (`published`). */
  publishedAt: IsoDateTime.nullable(),
  /** Đường dẫn bài trên nền tảng ("Xem bài"); có thể thiếu cả khi đã đăng (Meta không trả). */
  permalink: z.string().nullable(),
})
export type PostTargetDto = z.infer<typeof PostTargetDto>

export const PostDto = z.object({
  id: z.uuid(),
  source: PostSource,
  topic: z.string().nullable(),
  /** Theo thứ tự tab lúc lưu. */
  targets: z.array(PostTargetDto),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type PostDto = z.infer<typeof PostDto>

/* ---------- Lên lịch và đăng (Story 6.4, AD-13) ---------- */

/**
 * Hành động của chủ shop trên target (bảng chuyển trạng thái AD-13): `schedule` nháp → đã lên lịch (lên lịch / đăng
 * ngay), `reschedule` đổi giờ bài đã lên lịch (Lịch nội dung: kéo thả), `unschedule` bỏ lịch (về nháp, sửa lại được),
 * `retry` "Đăng lại" bài lỗi, `cancel` xoá bài chưa đăng khỏi lịch (Story 6.5: mọi trạng thái trước `publishing`, và
 * `failed` → `cancelled` + `cancel_reason`).
 */
export const TARGET_ACTIONS = ['schedule', 'reschedule', 'unschedule', 'retry', 'cancel'] as const
/** Hành động không mang thời gian (cấm `scheduledAt`). */
export const UNTIMED_TARGET_ACTIONS = ['unschedule', 'cancel'] as const satisfies readonly (typeof TARGET_ACTIONS)[number][]
export const TargetAction = z.enum(TARGET_ACTIONS)
export type TargetAction = z.infer<typeof TargetAction>

/** Lên lịch xa nhất [ASSUMPTION]: chặn gõ nhầm năm. */
export const SCHEDULE_MAX_AHEAD_MS = 366 * 24 * 60 * 60_000

/**
 * Body `POST /api/v1/posts/:id/targets/transition` — một hành động cho một hoặc nhiều target của bài, tất cả hoặc không.
 * `scheduledAt` (ISO UTC; FE đổi từ giờ VN): bắt buộc với mọi hành động trừ `unschedule` / `cancel` (cấm); `null` =
 * đăng ngay. `version`
 * = khoá lạc quan của từng target (AD-13).
 */
export const TransitionTargetsRequest = z
  .object({
    action: TargetAction,
    scheduledAt: IsoDateTime.nullable().optional(),
    targets: z
      .array(z.object({ id: z.uuid(), version: z.number().int().nonnegative() }).strict())
      .min(1, 'Chọn ít nhất 1 trang')
      .max(POST_TARGETS_MAX, `Tối đa ${POST_TARGETS_MAX} trang`),
  })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>()
    body.targets.forEach((t, i) => {
      if (seen.has(t.id)) ctx.addIssue({ code: 'custom', path: ['targets', i, 'id'], message: 'Trang bị chọn hai lần' })
      seen.add(t.id)
    })
    const untimed = (UNTIMED_TARGET_ACTIONS as readonly string[]).includes(body.action)
    if (untimed && body.scheduledAt !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: body.action === 'cancel' ? 'Xoá bài không cần thời gian' : 'Bỏ lịch không cần thời gian' })
    }
    if (!untimed && body.scheduledAt === undefined) {
      ctx.addIssue({ code: 'custom', path: ['scheduledAt'], message: 'Chọn thời gian đăng' })
    }
  })
export type TransitionTargetsRequest = z.input<typeof TransitionTargetsRequest>
export type ParsedTransitionTargetsRequest = z.output<typeof TransitionTargetsRequest>

/* ---------- Lịch nội dung (Story 6.5, AD-13, AD-18) ---------- */

/** Khoảng đọc lịch dài nhất: lưới tháng 6 tuần (42 ngày) + 1 ngày dư. */
export const CALENDAR_RANGE_MAX_MS = 43 * 24 * 60 * 60_000
/** Số target tối đa một lần đọc lịch [ASSUMPTION]; vượt → `truncated`. */
export const CALENDAR_ITEMS_MAX = 2_000
/** Độ dài tiêu đề ô lịch (code point đầu của caption). */
export const CALENDAR_TITLE_MAX = 120

/* ---------- Kế hoạch nội dung của slot chiến dịch (Story 7.8) ---------- */

/**
 * Định dạng bài của kế hoạch nội dung (model chữ lên brief cho từng slot trước khi viết — Story 7.8). `promo` /
 * `feedback` chỉ được chọn khi dữ liệu của shop có ưu đãi / phản hồi thật (luật ở prompt).
 */
export const CONTENT_FORMATS = ['tip', 'product', 'how_to', 'comparison', 'question', 'behind_scenes', 'feedback', 'story', 'promo'] as const
export const ContentFormat = z.enum(CONTENT_FORMATS)
export type ContentFormat = z.infer<typeof ContentFormat>

/** Nhãn ngắn của định dạng (chip trên thẻ bài, Lịch). */
export const CONTENT_FORMAT_LABEL: Record<ContentFormat, string> = {
  tip: 'Mẹo',
  product: 'Giới thiệu SP',
  how_to: 'Hướng dẫn',
  comparison: 'So sánh',
  question: 'Hỏi đáp',
  behind_scenes: 'Hậu trường',
  feedback: 'Feedback',
  story: 'Câu chuyện',
  promo: 'Khuyến mãi',
}

/** Giai đoạn phễu của bài: nhận biết → cân nhắc → chuyển đổi. */
export const FUNNEL_STAGES = ['awareness', 'consideration', 'conversion'] as const
export const FunnelStage = z.enum(FUNNEL_STAGES)
export type FunnelStage = z.infer<typeof FunnelStage>

/** Phần kế hoạch của slot trả cho FE (Story 7.8): định dạng, giai đoạn phễu, tiêu đề ngắn, góc nội dung. */
export const SlotPlanSummary = z.object({
  format: ContentFormat,
  funnelStage: FunnelStage,
  title: z.string(),
  angle: z.string(),
})
export type SlotPlanSummary = z.infer<typeof SlotPlanSummary>

/**
 * Query `GET /api/v1/calendar`: phạm vi (`all|group:<id>|page:<id>`, mặc định `all`) + khoảng `[from, to)` ISO UTC (FE
 * đổi từ lưới ngày giờ VN). `from < to`, dài tối đa `CALENDAR_RANGE_MAX_MS`.
 */
export const CalendarQuery = z
  .object({ scope: ScopeParam.optional(), from: IsoDateTime, to: IsoDateTime })
  .strict()
  .superRefine((q, ctx) => {
    const span = Date.parse(q.to) - Date.parse(q.from)
    if (span <= 0) ctx.addIssue({ code: 'custom', path: ['to'], message: 'Khoảng thời gian không hợp lệ' })
    else if (span > CALENDAR_RANGE_MAX_MS) ctx.addIssue({ code: 'custom', path: ['to'], message: 'Chỉ xem tối đa 6 tuần một lần' })
  })
export type CalendarQuery = z.input<typeof CalendarQuery>

/**
 * Một target trên lịch (mỗi trang một dòng; FE gom thành "bài trên lịch"). `ai` = nội dung do AI sinh (caption AI, ảnh
 * AI hoặc slot chiến dịch) → nhãn chữ "AI tạo" (UX-DR10). `campaignId` có từ Epic 7 (slot 1 post : 1 target, FE gom
 * theo giờ). `title` = đầu caption của trang đó (trống → `null`).
 */
export const CalendarItemDto = z.object({
  id: z.uuid(),
  postId: z.uuid(),
  pageId: z.uuid(),
  status: PostTargetStatus,
  /** Khoá lạc quan (AD-13) — body của `POST /posts/:id/targets/transition`. */
  version: z.number().int().nonnegative(),
  scheduledAt: IsoDateTime,
  publishedAt: IsoDateTime.nullable(),
  errorCode: ErrorCode.nullable(),
  permalink: z.string().nullable(),
  ai: z.boolean(),
  source: PostSource,
  campaignId: z.uuid().nullable(),
  title: z.string().nullable(),
  /** Story 7.3: ý tưởng / chủ đề của bài — slot chiến dịch chưa viết (`planned`, caption rỗng) hiện "AI sẽ viết · <chủ đề>". */
  topic: z.string().nullable(),
  thumbnailUrl: z.url().nullable(),
  /** Story 7.5: bài bị giữ không đăng (chiến dịch tạm dừng) — Lịch ghi "Tạm dừng". */
  held: z.boolean(),
  /** Story 7.8: tiêu đề kế hoạch của slot chiến dịch (bài chưa viết hiện "AI sẽ viết · <tiêu đề>"); `null` = chưa có. */
  planTitle: z.string().nullable(),
  /** Story 7.8: định dạng bài theo kế hoạch; `null` = chưa có / không phải slot. */
  planFormat: ContentFormat.nullable(),
})
export type CalendarItemDto = z.infer<typeof CalendarItemDto>

/** `GET /api/v1/calendar` → 200, theo `scheduledAt` tăng dần. `truncated` = còn target ngoài `CALENDAR_ITEMS_MAX`. */
export const CalendarResponse = z.object({ items: z.array(CalendarItemDto), truncated: z.boolean() })
export type CalendarResponse = z.infer<typeof CalendarResponse>

/* ---------- Viết caption bằng AI (Story 6.2, AD-7, AD-21) ---------- */

/** Độ dài mong muốn (ô "Độ dài"): ngắn, vừa, dài. */
export const COMPOSE_LENGTHS = ['short', 'medium', 'long'] as const
export const ComposeLength = z.enum(COMPOSE_LENGTHS)
export type ComposeLength = z.infer<typeof ComposeLength>

/** Sửa caption của MỘT tab: viết bản khác, rút gọn, thêm lời kêu gọi hành động. */
export const COMPOSE_REVISE_ACTIONS = ['rewrite', 'shorter', 'cta'] as const
export const ComposeReviseAction = z.enum(COMPOSE_REVISE_ACTIONS)
export type ComposeReviseAction = z.infer<typeof ComposeReviseAction>

/** Caption hiện tại dài nhất gửi cho AI sửa [ASSUMPTION] — chặn prompt phình (caption AI tối đa 2.200 ký tự). */
export const COMPOSE_REVISE_CAPTION_MAX = 5_000

/**
 * Body `POST /api/v1/posts/compose` — AI viết caption cho từng trang theo hồ sơ hiệu lực của trang đó (không lưu bài).
 * Không `revise` = viết mới cho mọi trang trong `pageIds` (cần ý tưởng). Có `revise` = sửa caption của đúng một trang.
 */
export const ComposeCaptionsRequest = z
  .object({
    topic: z.string().trim().max(POST_TOPIC_MAX, `Ý tưởng tối đa ${POST_TOPIC_MAX} ký tự`).default(''),
    goal: ComposeGoal.default('sales'),
    length: ComposeLength.default('medium'),
    pageIds: z.array(z.uuid()).min(1, 'Chọn ít nhất 1 trang').max(POST_TARGETS_MAX, `Tối đa ${POST_TARGETS_MAX} trang`),
    revise: z
      .object({
        action: ComposeReviseAction,
        caption: z.string().max(COMPOSE_REVISE_CAPTION_MAX, `Nội dung quá dài để AI sửa (tối đa ${COMPOSE_REVISE_CAPTION_MAX} ký tự)`),
      })
      .strict()
      .optional(),
    /** Story 6.6: ảnh đang gắn tab (tối đa 1 ảnh mỗi trang) — AI xem ảnh để caption bám theo ảnh. */
    images: z
      .array(z.object({ pageId: z.uuid(), mediaId: z.uuid() }).strict())
      .max(POST_TARGETS_MAX, `Tối đa ${POST_TARGETS_MAX} ảnh`)
      .default([]),
  })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>()
    body.pageIds.forEach((id, i) => {
      if (seen.has(id)) ctx.addIssue({ code: 'custom', path: ['pageIds', i], message: 'Trang bị chọn hai lần' })
      seen.add(id)
    })
    const withImage = new Set<string>()
    body.images.forEach((img, i) => {
      if (!seen.has(img.pageId)) ctx.addIssue({ code: 'custom', path: ['images', i, 'pageId'], message: 'Trang của ảnh không nằm trong danh sách viết' })
      else if (withImage.has(img.pageId)) ctx.addIssue({ code: 'custom', path: ['images', i, 'pageId'], message: `Mỗi trang tối đa ${POST_TARGET_MEDIA_MAX} ảnh` })
      withImage.add(img.pageId)
    })
    const action = body.revise?.action
    if ((!action || action === 'rewrite') && !body.topic) ctx.addIssue({ code: 'custom', path: ['topic'], message: 'Nhập ý tưởng để AI viết' })
    if (action && body.pageIds.length !== 1) ctx.addIssue({ code: 'custom', path: ['pageIds'], message: 'Chỉ sửa được caption của một trang mỗi lần' })
    if ((action === 'shorter' || action === 'cta') && !body.revise?.caption.trim()) {
      ctx.addIssue({ code: 'custom', path: ['revise', 'caption'], message: 'Chưa có nội dung để AI sửa' })
    }
  })
export type ComposeCaptionsRequest = z.input<typeof ComposeCaptionsRequest>
export type ParsedComposeCaptionsRequest = z.output<typeof ComposeCaptionsRequest>

/**
 * Kết quả của một trang: `ok` = caption AI (kèm cụm vi phạm hậu kiểm còn lại sau một lần sinh lại, FE đánh dấu);
 * `error` = trang đó không viết được (`CONFIG_MISSING` = chưa có hồ sơ thương hiệu; mã AI như `AI_BUDGET_EXCEEDED`).
 * `imageUsed` (Story 6.6): AI đã xem ảnh của trang khi viết (false khi trang không gửi ảnh, hoặc tải ảnh từ kho lỗi).
 */
export const ComposeCaptionResult = z.discriminatedUnion('status', [
  z.object({ pageId: z.uuid(), status: z.literal('ok'), caption: z.string(), violations: z.array(AiViolation), imageUsed: z.boolean() }),
  z.object({ pageId: z.uuid(), status: z.literal('error'), errorCode: ErrorCode }),
])
export type ComposeCaptionResult = z.infer<typeof ComposeCaptionResult>

/** `POST /api/v1/posts/compose` → 200. `results` đúng thứ tự `pageIds`; một trang lỗi không chặn trang khác. */
export const ComposeCaptionsResponse = z.object({ results: z.array(ComposeCaptionResult) })
export type ComposeCaptionsResponse = z.infer<typeof ComposeCaptionsResponse>
