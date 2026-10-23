// Cấu hình AI trả lời tự động (Story 5.1, AD-8, AD-16). Một cấu hình cho mỗi `(ownerType, ownerId)` (nhóm/trang),
// kế thừa Nhóm→Trang qua `profiles.resolveEffective(pageId, 'autoreply')` như hồ sơ thương hiệu. Schema ở đây là
// nguồn DUY NHẤT của luật hợp lệ: BE validate bằng nó, FE dựng request và báo lỗi dưới ô từ cùng luật.
import { z } from 'zod'
import { ConfigOwnerType, AutoreplyChannel, AUTOREPLY_CHANNELS } from './enums.ts'
import { ErrorCode } from './errors.ts'
import { ConfigSource } from './profiles.ts'

const IsoDateTime = z.iso.datetime({ offset: false })

/** Giờ hoạt động: luôn bật / chỉ ngoài giờ làm việc / theo khung giờ. FE hiển thị nhãn tiếng Việt. */
export const AUTOREPLY_SCHEDULES = ['always', 'offhours', 'custom'] as const
export const AutoreplySchedule = z.enum(AUTOREPLY_SCHEDULES)
export type AutoreplySchedule = z.infer<typeof AutoreplySchedule>

export const AUTOREPLY_SCRIPT_MAX = 8000
export const AUTOREPLY_KEYWORDS_MAX = 50
export const AUTOREPLY_KEYWORD_MAX = 80
export const AUTOREPLY_HANDOFF_MESSAGE_MAX = 500
/** Câu chuyển tiếp mặc định khi AI chuyển cho người theo luật [ASSUMPTION AD-16]. */
export const DEFAULT_HANDOFF_MESSAGE = 'Shop sẽ kiểm tra và phản hồi ngay ạ'
/** Kênh bật sẵn cho cấu hình mới: tin nhắn + trả lời bình luận công khai (nhắn riêng người bình luận tắt). */
export const DEFAULT_AUTOREPLY_CHANNELS: readonly AutoreplyChannel[] = ['messenger', 'ig_direct', 'comment_public']

/** Số ngày trong `hours`: phần tử 0 = Thứ Hai … 6 = Chủ nhật. */
export const AUTOREPLY_WEEK_DAYS = 7
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Khung giờ một ngày. `on=false` = ngày nghỉ (với `offhours`: AI trả lời cả ngày; với `custom`: AI không trả lời).
 * `from > to` = khung qua nửa đêm (vd 22:00–06:00). `from = to` khi `on` là vô nghĩa → lỗi.
 */
export const AutoreplyDayHours = z
  .object({
    on: z.boolean(),
    from: z.string().regex(HHMM, 'Giờ phải có dạng HH:MM'),
    to: z.string().regex(HHMM, 'Giờ phải có dạng HH:MM'),
  })
  .strict()
  .refine((d) => !d.on || d.from !== d.to, { message: 'Giờ bắt đầu và kết thúc phải khác nhau', path: ['to'] })
export type AutoreplyDayHours = z.infer<typeof AutoreplyDayHours>

/** Mặc định: T2–T7 08:00–18:00, CN nghỉ. */
export function defaultAutoreplyHours(): AutoreplyDayHours[] {
  return Array.from({ length: AUTOREPLY_WEEK_DAYS }, (_, i) => ({ on: i < 6, from: '08:00', to: '18:00' }))
}

/** Bỏ trùng giữ thứ tự (từ khoá so không phân biệt hoa thường). */
const uniqueBy = <T>(xs: readonly T[], key: (x: T) => string): T[] => {
  const seen = new Set<string>()
  return xs.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)))
}

const ConfigFields = z
  .object({
    enabled: z.boolean().default(false),
    schedule: AutoreplySchedule.default('always'),
    hours: z.array(AutoreplyDayHours).length(AUTOREPLY_WEEK_DAYS, 'Cần đủ 7 ngày trong tuần').default(defaultAutoreplyHours),
    script: z.string().trim().max(AUTOREPLY_SCRIPT_MAX, `Kịch bản tối đa ${AUTOREPLY_SCRIPT_MAX} ký tự`).default(''),
    handoffKeywords: z
      .array(z.string().trim().min(1).max(AUTOREPLY_KEYWORD_MAX))
      .max(AUTOREPLY_KEYWORDS_MAX, `Tối đa ${AUTOREPLY_KEYWORDS_MAX} từ khoá`)
      .default([])
      .transform((ks) => uniqueBy(ks, (k) => k.toLocaleLowerCase('vi'))),
    handoffOnCustomerAsk: z.boolean().default(true),
    handoffOnUncertain: z.boolean().default(true),
    handoffMessage: z
      .string()
      .trim()
      .min(1, 'Nhập câu AI nói trước khi chuyển cho bạn')
      .max(AUTOREPLY_HANDOFF_MESSAGE_MAX, `Tối đa ${AUTOREPLY_HANDOFF_MESSAGE_MAX} ký tự`)
      .default(DEFAULT_HANDOFF_MESSAGE),
    channels: z
      .array(AutoreplyChannel)
      .max(AUTOREPLY_CHANNELS.length)
      .default(() => [...DEFAULT_AUTOREPLY_CHANNELS])
      .transform((cs) => uniqueBy(cs, (c) => c)),
  })
  .strict()

/** Ô có lỗi khi bật AI. `path` khớp tên field để FE báo dưới đúng ô. */
export interface AutoreplyEnableIssue {
  path: 'script' | 'channels' | 'hours'
  message: string
}

export const AUTOREPLY_ISSUE_MESSAGES = {
  script: 'Viết kịch bản trước khi bật AI.',
  channels: 'Chọn ít nhất một kênh để AI có thể trả lời.',
  hours: 'Chọn ít nhất một ngày AI được trả lời.',
} as const

/**
 * Điều kiện để AI được BẬT (Story 5.1 AC3): kịch bản không rỗng, có ít nhất một kênh, và chế độ "theo khung giờ" có
 * ít nhất một ngày bật. Cấu hình đang tắt thì không bắt (lưu nháp được). Dùng chung cho validate request, bật hàng
 * loạt ở server và kiểm sớm ở FE.
 */
export function autoreplyEnableIssues(cfg: {
  enabled: boolean
  script: string
  channels: readonly string[]
  schedule: AutoreplySchedule
  hours: readonly { on: boolean }[]
}): AutoreplyEnableIssue[] {
  if (!cfg.enabled) return []
  const issues: AutoreplyEnableIssue[] = []
  if (!cfg.script.trim()) issues.push({ path: 'script', message: AUTOREPLY_ISSUE_MESSAGES.script })
  if (cfg.channels.length === 0) issues.push({ path: 'channels', message: AUTOREPLY_ISSUE_MESSAGES.channels })
  if (cfg.schedule === 'custom' && !cfg.hours.some((h) => h.on)) issues.push({ path: 'hours', message: AUTOREPLY_ISSUE_MESSAGES.hours })
  return issues
}

/** Body `PUT /api/v1/autoreply-configs/:ownerType/:ownerId` — toàn bộ cấu hình (mặc định điền khi thiếu). */
export const SaveAutoreplyConfigRequest = ConfigFields.superRefine((cfg, ctx) => {
  for (const issue of autoreplyEnableIssues(cfg)) ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message })
})
export type SaveAutoreplyConfigRequest = z.input<typeof SaveAutoreplyConfigRequest>
/** Dạng đã parse (mọi mặc định đã điền, từ khoá/kênh đã bỏ trùng) — service nhận kiểu này. */
export type ParsedAutoreplyConfig = z.output<typeof SaveAutoreplyConfigRequest>

/** Cấu hình trả về (đọc). */
export const AutoreplyConfigDto = z.object({
  ownerType: ConfigOwnerType,
  ownerId: z.uuid(),
  enabled: z.boolean(),
  schedule: AutoreplySchedule,
  hours: z.array(AutoreplyDayHours),
  script: z.string(),
  handoffKeywords: z.array(z.string()),
  handoffOnCustomerAsk: z.boolean(),
  handoffOnUncertain: z.boolean(),
  handoffMessage: z.string(),
  channels: z.array(AutoreplyChannel),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
})
export type AutoreplyConfigDto = z.infer<typeof AutoreplyConfigDto>

/** `GET …/:ownerType/:ownerId` — cấu hình RIÊNG của chủ, hoặc `null` (chưa có → FE dùng mặc định). */
export const AutoreplyConfigResponse = z.object({ config: AutoreplyConfigDto.nullable() })
export type AutoreplyConfigResponse = z.infer<typeof AutoreplyConfigResponse>

/**
 * `GET …/effective/page/:id` (và kết quả `PUT …/use-own/page/:id`) — cấu hình hiệu lực của trang hoặc `null`
 * (`CONFIG_MISSING`), kèm `useOwn`: trang đang dùng cấu hình riêng (trang không nhóm luôn `true`).
 */
export const EffectiveAutoreplyConfigResponse = z.object({
  effective: z.object({ config: AutoreplyConfigDto, source: ConfigSource }).nullable(),
  useOwn: z.boolean(),
})
export type EffectiveAutoreplyConfigResponse = z.infer<typeof EffectiveAutoreplyConfigResponse>

/* ---------- Kịch bản dựng từ template (AD-2: xác định, không gọi AI) ---------- */

/** Mẫu kịch bản theo ngành. FE hiển thị nhãn tiếng Việt (`web/src/lib/autoreply.ts`). */
export const AUTOREPLY_INDUSTRIES = ['cosmetics', 'home', 'fashion', 'food', 'baby', 'general'] as const
export const AutoreplyIndustry = z.enum(AUTOREPLY_INDUSTRIES)
export type AutoreplyIndustry = z.infer<typeof AutoreplyIndustry>

/** Body `POST /api/v1/autoreply-configs/script-template`: lấy từ hồ sơ hiệu lực của chủ, hoặc mẫu theo ngành. */
export const AutoreplyScriptTemplateRequest = z.discriminatedUnion('source', [
  z.object({ source: z.literal('brand'), ownerType: ConfigOwnerType, ownerId: z.uuid() }).strict(),
  z.object({ source: z.literal('industry'), industry: AutoreplyIndustry }).strict(),
])
export type AutoreplyScriptTemplateRequest = z.infer<typeof AutoreplyScriptTemplateRequest>

/** Kịch bản dựng sẵn; `brandSource` = hồ sơ đã dùng (khi `source=brand`) để FE báo "Đã lấy từ hồ sơ của …". */
export const AutoreplyScriptTemplateResponse = z.object({ script: z.string(), brandSource: ConfigSource.nullable() })
export type AutoreplyScriptTemplateResponse = z.infer<typeof AutoreplyScriptTemplateResponse>

/* ---------- Tổng quan (cây nhóm/trang, `Page.autoReply` dẫn xuất) ---------- */

/**
 * `GET /api/v1/autoreply-configs/overview` — trạng thái AI của mọi nhóm và trang (chưa gỡ).
 * Nhóm: `configured` = đã lưu cấu hình; `enabled` = cấu hình nhóm đang bật.
 * Trang: `mode` = `group` (theo nhóm) | `own` (cấu hình riêng; trang không nhóm luôn `own`); `enabled` = cấu hình
 * HIỆU LỰC đang bật (đây là `Page.autoReply`); `configured=false` = `CONFIG_MISSING`.
 */
export const AutoreplyOverviewResponse = z.object({
  groups: z.array(z.object({ groupId: z.uuid(), configured: z.boolean(), enabled: z.boolean() })),
  pages: z.array(
    z.object({
      pageId: z.uuid(),
      groupId: z.uuid().nullable(),
      mode: z.enum(['group', 'own']),
      configured: z.boolean(),
      enabled: z.boolean(),
    }),
  ),
})
export type AutoreplyOverviewResponse = z.infer<typeof AutoreplyOverviewResponse>
export type AutoreplyPageStatus = AutoreplyOverviewResponse['pages'][number]

/* ---------- Bật/Tắt hàng loạt (Bảng trang) ---------- */

export const AUTOREPLY_BULK_MAX = 200

/** Body `POST /api/v1/autoreply-configs/bulk-enabled`. */
export const BulkSetAutoreplyRequest = z
  .object({ pageIds: z.array(z.uuid()).min(1).max(AUTOREPLY_BULK_MAX), enabled: z.boolean() })
  .strict()
export type BulkSetAutoreplyRequest = z.infer<typeof BulkSetAutoreplyRequest>

/**
 * Kết quả từng trang: `updated` = trang đã đổi `enabled` (trang theo nhóm thì đã chuyển sang cấu hình riêng);
 * `unchanged` = đã đúng trạng thái, không đổi gì (giữ "Theo nhóm"); `failed` = không đổi được (mã lỗi theo trang).
 */
export const BulkSetAutoreplyResponse = z.object({
  updated: z.array(z.uuid()),
  unchanged: z.array(z.uuid()),
  failed: z.array(z.object({ pageId: z.uuid(), code: ErrorCode })),
})
export type BulkSetAutoreplyResponse = z.infer<typeof BulkSetAutoreplyResponse>
