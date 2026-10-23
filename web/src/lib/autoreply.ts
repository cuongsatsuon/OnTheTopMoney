// Cấu hình AI trả lời tự động (Story 5.1) phía web. Nối `AutoReplyForm` (màn /ai-tra-loi + tab "AI trả lời" của
// Chi tiết trang/nhóm), cây nhóm/trang và Bật/Tắt AI hàng loạt ở Trang & Nhóm vào API thật. Phần thuần (map DTO ↔
// form, lỗi dưới ô, chữ xác nhận/kết quả hàng loạt) tách khỏi hook để test được (autoreply.test.ts).
// Như hồ sơ thương hiệu: chủ thật (id uuid) mới gọi server; id kho mẫu (g-home, p6…) vẫn chạy dữ liệu mẫu.
import {
  AUTOREPLY_CHANNELS,
  AutoreplyConfigDto,
  AutoreplyConfigResponse,
  AutoreplyOverviewResponse,
  AutoreplyScriptTemplateResponse,
  BulkSetAutoreplyResponse,
  DEFAULT_AUTOREPLY_CHANNELS,
  DEFAULT_HANDOFF_MESSAGE,
  EffectiveAutoreplyConfigResponse,
  autoreplyEnableIssues,
  defaultAutoreplyHours,
  type AutoreplyChannel,
  type AutoreplyEnableIssue,
  type AutoreplyIndustry,
  type AutoreplyPageStatus,
  type AutoreplySchedule,
  type AutoreplyScriptTemplateRequest,
  type ConfigOwnerType,
  type SaveAutoreplyConfigRequest,
} from '@ottm/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { groups as mockGroups, pages as mockPages, type Group, type Page } from '../data/mock'
import { apiFetch, isApiError } from './api'
import { errorMessageOf } from './error-messages'
import { KNOWLEDGE_KEY, KNOWLEDGE_TOO_LARGE_MESSAGE } from './knowledge'

/* ---------- Dạng form (giữ nguyên UX của AutoReplyForm) ---------- */

export const DAY_LABELS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'] as const

export interface DayRange {
  day: string
  on: boolean
  from: string
  to: string
}

/** Mục kho kiến thức của KHO MẪU (id mẫu). Chủ thật đọc/ghi kho qua API — `lib/knowledge.ts` (Story 5.2). */
export interface KnowledgeItem {
  id: string
  kind: 'faq' | 'file'
  title: string
  detail: string
}

export interface AutoReplyConfig {
  enabled: boolean
  schedule: AutoreplySchedule
  ranges: DayRange[]
  channels: Record<AutoreplyChannel, boolean>
  prompt: string
  knowledge: KnowledgeItem[]
  keywords: string[]
  uncertain: boolean
  askHuman: boolean
  handoffMessage: string
}

const channelRecord = (on: readonly AutoreplyChannel[]): Record<AutoreplyChannel, boolean> =>
  Object.fromEntries(AUTOREPLY_CHANNELS.map((c) => [c, on.includes(c)])) as Record<AutoreplyChannel, boolean>

const rangesOf = (hours: readonly { on: boolean; from: string; to: string }[]): DayRange[] =>
  DAY_LABELS.map((day, i) => ({ day, on: hours[i]?.on ?? false, from: hours[i]?.from ?? '08:00', to: hours[i]?.to ?? '18:00' }))

/** Cấu hình mặc định cho chủ chưa có cấu hình (AI tắt, kịch bản trống). */
export function blankAutoReply(): AutoReplyConfig {
  return {
    enabled: false,
    schedule: 'always',
    ranges: rangesOf(defaultAutoreplyHours()),
    channels: channelRecord(DEFAULT_AUTOREPLY_CHANNELS),
    prompt: '',
    knowledge: [],
    keywords: [],
    uncertain: true,
    askHuman: true,
    handoffMessage: DEFAULT_HANDOFF_MESSAGE,
  }
}

/** DTO server → form. `null` (chưa có cấu hình) → mặc định. */
export function autoReplyOf(dto: AutoreplyConfigDto | null): AutoReplyConfig {
  if (!dto) return blankAutoReply()
  return {
    enabled: dto.enabled,
    schedule: dto.schedule,
    ranges: rangesOf(dto.hours),
    channels: channelRecord(dto.channels),
    prompt: dto.script,
    knowledge: [],
    keywords: dto.handoffKeywords,
    uncertain: dto.handoffOnUncertain,
    askHuman: dto.handoffOnCustomerAsk,
    handoffMessage: dto.handoffMessage,
  }
}

/** Form → body `PUT /autoreply-configs/:ownerType/:ownerId` (kho kiến thức không nằm ở đây — Story 5.2). */
export function toSaveAutoreplyRequest(form: AutoReplyConfig): SaveAutoreplyConfigRequest {
  return {
    enabled: form.enabled,
    schedule: form.schedule,
    hours: form.ranges.map((r) => ({ on: r.on, from: r.from, to: r.to })),
    script: form.prompt.trim(),
    handoffKeywords: form.keywords,
    handoffOnCustomerAsk: form.askHuman,
    handoffOnUncertain: form.uncertain,
    handoffMessage: form.handoffMessage.trim(),
    channels: AUTOREPLY_CHANNELS.filter((c) => form.channels[c]),
  }
}

export type AutoReplyField = AutoreplyEnableIssue['path'] | 'handoffMessage' | 'knowledge'
export type AutoReplyFieldErrors = Partial<Record<AutoReplyField, string>>

/** Kiểm sớm phía web bằng CÙNG luật bật của server (`autoreplyEnableIssues`) + câu chuyển tiếp bắt buộc. */
export function autoReplyIssuesOf(form: AutoReplyConfig): AutoReplyFieldErrors {
  const req = toSaveAutoreplyRequest(form)
  const issues = autoreplyEnableIssues({ enabled: form.enabled, script: req.script ?? '', channels: req.channels ?? [], schedule: form.schedule, hours: form.ranges })
  const out: AutoReplyFieldErrors = Object.fromEntries(issues.map((i) => [i.path, i.message]))
  if (!form.handoffMessage.trim()) out.handoffMessage = 'Nhập câu AI nói trước khi chuyển cho bạn.'
  return out
}

const FIELDS: readonly AutoReplyField[] = ['script', 'channels', 'hours', 'handoffMessage']

/**
 * Lỗi từ server → lỗi dưới ô: `VALIDATION_FAILED` theo field; `KNOWLEDGE_TOO_LARGE` (lưu bật khi kho vượt giới hạn,
 * Story 5.2) dưới mục Kho kiến thức. Mã khác → `{}` (toast chung).
 */
export function autoReplyFieldErrorsOf(err: unknown): AutoReplyFieldErrors {
  if (isApiError(err) && err.code === 'KNOWLEDGE_TOO_LARGE') return { knowledge: KNOWLEDGE_TOO_LARGE_MESSAGE }
  if (!isApiError(err) || err.code !== 'VALIDATION_FAILED' || !Array.isArray(err.details)) return {}
  const out: AutoReplyFieldErrors = {}
  for (const d of err.details as unknown[]) {
    const path = d && typeof d === 'object' ? (d as { path?: unknown }).path : undefined
    const field = Array.isArray(path) ? FIELDS.find((f) => path[0] === f) : undefined
    const message = (d as { message?: unknown }).message
    if (field && !out[field]) out[field] = typeof message === 'string' ? message : 'Kiểm tra lại ô này.'
  }
  return out
}

/** Mẫu kịch bản theo ngành (nhãn hiển thị). */
export const INDUSTRY_OPTIONS: readonly { id: AutoreplyIndustry; label: string }[] = [
  { id: 'cosmetics', label: 'Mỹ phẩm' },
  { id: 'home', label: 'Gia dụng' },
  { id: 'fashion', label: 'Thời trang' },
  { id: 'food', label: 'Thực phẩm' },
  { id: 'baby', label: 'Mẹ & bé' },
  { id: 'general', label: 'Bán lẻ chung' },
]

export const BRAND_MISSING_MESSAGE = 'Chưa có hồ sơ thương hiệu để lấy kịch bản. Điền Hồ sơ thương hiệu trước, hoặc chọn mẫu theo ngành.'

/** Lỗi "Lấy từ Hồ sơ thương hiệu": thiếu hồ sơ hiệu lực có câu riêng; còn lại theo bản đồ mã lỗi chung. */
export function scriptTemplateErrorMessage(err: unknown): string {
  return isApiError(err) && err.code === 'CONFIG_MISSING' ? BRAND_MISSING_MESSAGE : errorMessageOf(err)
}

/** Nhãn cạnh trang trong cây: "Theo nhóm" hoặc "Riêng · Bật/Tắt" (trang không nhóm chỉ hiện Bật/Tắt ở chỗ gọi). */
export function treePageLabel(status: Pick<AutoreplyPageStatus, 'mode' | 'enabled'>): string {
  return status.mode === 'group' ? 'Theo nhóm' : `Riêng · ${status.enabled ? 'Bật' : 'Tắt'}`
}

/* ---------- Bật/Tắt hàng loạt (Bảng trang) ---------- */

/** Trang trong lựa chọn hàng loạt, kèm trạng thái AI dẫn xuất (từ tổng quan). */
export interface BulkPage {
  name: string
  status: Pick<AutoreplyPageStatus, 'mode' | 'configured' | 'enabled'> | undefined
}

/** Trang theo nhóm có cấu hình mà trạng thái khác đích → server sẽ chuyển sang cấu hình riêng (sao chép). */
const willConvert = (p: BulkPage, on: boolean): boolean => !!p.status && p.status.mode === 'group' && p.status.configured && p.status.enabled !== on

/**
 * Hộp xác nhận trước khi Bật/Tắt AI hàng loạt (AC5). Nêu số trang đang theo nhóm sẽ chuyển sang cấu hình riêng
 * (sao chép cấu hình nhóm) — đó là thay đổi chủ shop cần biết trước.
 */
export function bulkConfirmText(pages: readonly BulkPage[], on: boolean): { title: string; body: string; confirmLabel: string } {
  const verb = on ? 'Bật' : 'Tắt'
  const converting = pages.filter((p) => willConvert(p, on)).length
  const target = pages.length === 1 ? `“${pages[0]!.name}”` : `${pages.length} trang`
  const note =
    converting === 0
      ? ''
      : pages.length === 1
        ? ' Trang này đang theo cấu hình nhóm nên sẽ chuyển sang cấu hình AI riêng (sao chép từ nhóm) và không theo các thay đổi sau này của nhóm.'
        : ` ${converting} trang đang theo cấu hình nhóm sẽ chuyển sang cấu hình AI riêng (sao chép từ nhóm) và không theo các thay đổi sau này của nhóm.`
  return { title: `${verb} AI trả lời?`, body: `${verb} AI trả lời tự động cho ${target}.${note}`, confirmLabel: `${verb} AI trả lời` }
}

const FAIL_REASONS: Partial<Record<string, string>> = {
  CONFIG_MISSING: 'chưa có cấu hình AI',
  VALIDATION_FAILED: 'cấu hình chưa đủ (kịch bản hoặc kênh)',
  KNOWLEDGE_TOO_LARGE: 'kho kiến thức vượt giới hạn',
  NOT_FOUND: 'trang không còn',
}

/** Toast kết quả hàng loạt: số trang đã đổi + lý do từng nhóm trang không đổi được. */
export function bulkResultMessage(res: BulkSetAutoreplyResponse, on: boolean): string {
  const done = res.updated.length + res.unchanged.length
  const parts: string[] = []
  if (done > 0) parts.push(`Đã ${on ? 'bật' : 'tắt'} AI trả lời cho ${done} trang.`)
  const byCode = new Map<string, number>()
  for (const f of res.failed) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1)
  for (const [code, n] of byCode) parts.push(`${n} trang chưa ${on ? 'bật' : 'tắt'} được: ${FAIL_REASONS[code] ?? errorMessageOf({ code }).replace(/\.$/, '').toLowerCase()}.`)
  return parts.join(' ')
}

/* ---------- Chép trạng thái AI vào kho mẫu (`Page.autoReply` dẫn xuất) ---------- */

/**
 * Ghi `autoReply` dẫn xuất từ server vào kho mẫu để các màn còn đọc dữ liệu mẫu (Tổng quan, Chi tiết nhóm…) thấy
 * đúng. Chỉ đụng trang/nhóm thật có trong tổng quan; trang/nhóm mẫu giữ nguyên.
 */
export function mirrorAutoreplyOverview(res: AutoreplyOverviewResponse, pages: Page[] = mockPages, groups: Group[] = mockGroups): void {
  const byPage = new Map(res.pages.map((p) => [p.pageId, p.enabled]))
  const byGroup = new Map(res.groups.map((g) => [g.groupId, g.enabled]))
  for (let i = 0; i < pages.length; i++) {
    const on = byPage.get(pages[i]!.id)
    if (on !== undefined && pages[i]!.autoReply !== on) pages[i] = { ...pages[i]!, autoReply: on }
  }
  for (let i = 0; i < groups.length; i++) {
    const on = byGroup.get(groups[i]!.id)
    if (on !== undefined && groups[i]!.autoReply !== on) groups[i] = { ...groups[i]!, autoReply: on }
  }
}

/* ---------- Hook React Query ---------- */

export interface AutoreplyOwner {
  ownerType: ConfigOwnerType
  ownerId: string
}

/** Mọi khoá cấu hình AI bắt đầu bằng `autoreply` → lưu/hàng loạt vô hiệu hoá một lần là đủ. */
export const AUTOREPLY_KEY = ['autoreply'] as const
export const autoreplyOverviewKey = ['autoreply', 'overview'] as const
export const autoreplyConfigKey = (owner: AutoreplyOwner) => ['autoreply', 'config', owner.ownerType, owner.ownerId] as const
export const effectiveAutoreplyKey = (pageId: string) => ['autoreply', 'effective', pageId] as const
const configPath = (owner: AutoreplyOwner) => `/autoreply-configs/${owner.ownerType}/${owner.ownerId}`

/** Trạng thái AI mọi nhóm/trang (cây, cột AI). Mỗi lần tải xong chép `autoReply` vào kho mẫu. */
export function useAutoreplyOverview(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: autoreplyOverviewKey,
    queryFn: async ({ signal }) => {
      const data = await apiFetch('/autoreply-configs/overview', { schema: AutoreplyOverviewResponse, signal })
      mirrorAutoreplyOverview(data)
      return data
    },
    enabled: options.enabled ?? true,
  })
}

export function useAutoreplyConfig(owner: AutoreplyOwner, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: autoreplyConfigKey(owner),
    queryFn: ({ signal }) => apiFetch(configPath(owner), { schema: AutoreplyConfigResponse, signal }),
    enabled: options.enabled ?? true,
  })
}

export function useEffectiveAutoreply(pageId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: effectiveAutoreplyKey(pageId),
    queryFn: ({ signal }) => apiFetch(`/autoreply-configs/effective/page/${pageId}`, { schema: EffectiveAutoreplyConfigResponse, signal }),
    enabled: options.enabled ?? true,
  })
}

/** Làm mới mọi khoá AI + kho kiến thức (chuyển sang/bỏ cấu hình riêng sao chép/xoá kho — Story 5.2). */
const invalidateAutoreply = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all([qc.invalidateQueries({ queryKey: AUTOREPLY_KEY }), qc.invalidateQueries({ queryKey: KNOWLEDGE_KEY })])

/** Lưu cấu hình (trang đang theo nhóm → server chuyển sang riêng trong cùng request). Làm mới mọi khoá AI. */
export function useSaveAutoreplyConfig(owner: AutoreplyOwner) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SaveAutoreplyConfigRequest) => apiFetch(configPath(owner), { method: 'PUT', body, schema: AutoreplyConfigDto }),
    onSuccess: () => invalidateAutoreply(qc),
  })
}

/** Bật/tắt "Dùng cấu hình AI riêng" (áp khi Lưu). */
export function useSetAutoreplyUseOwn(pageId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (useOwn: boolean) =>
      apiFetch(`/autoreply-configs/use-own/page/${pageId}`, { method: 'PUT', body: { useOwn }, schema: EffectiveAutoreplyConfigResponse }),
    onSuccess: () => invalidateAutoreply(qc),
  })
}

/** "Lấy từ Hồ sơ thương hiệu" / "Mẫu theo ngành": server dựng kịch bản xác định (không gọi AI, không lưu). */
export function useAutoreplyScriptTemplate() {
  return useMutation({
    mutationFn: (body: AutoreplyScriptTemplateRequest) =>
      apiFetch('/autoreply-configs/script-template', { method: 'POST', body, schema: AutoreplyScriptTemplateResponse }),
  })
}

/** Bật/Tắt AI hàng loạt (FE đã xác nhận). */
export function useBulkSetAutoreply() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { pageIds: string[]; enabled: boolean }) =>
      apiFetch('/autoreply-configs/bulk-enabled', { method: 'POST', body, schema: BulkSetAutoreplyResponse }),
    onSuccess: () => invalidateAutoreply(qc),
  })
}
