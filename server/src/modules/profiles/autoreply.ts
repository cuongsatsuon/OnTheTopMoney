// Nghiệp vụ cấu hình AI trả lời tự động (Story 5.1, AD-8). `autoreply` là loại cấu hình thứ hai của registry kế
// thừa (`inheritance.ts`): giải hiệu lực chỉ qua `resolveEffective`, bật/tắt dùng riêng qua `setUseOwn`, đổi nhóm do
// consumer `events.profiles` lo (Story 3.3) — file này không lặp lại luật nào trong số đó.
// Luật hợp lệ (bật cần kịch bản + kênh…) lấy từ shared (`SaveAutoreplyConfigRequest`, `autoreplyEnableIssues`).
// Story 5.2: lưu ở trạng thái bật (kể cả hàng loạt) khi kho kiến thức vượt giới hạn token → `KNOWLEDGE_TOO_LARGE`.
// Story 5.4: `autoreplyRunSources` — nguồn prompt (cấu hình hiệu lực, hồ sơ, kho) cho lượt AI trả lời thật.
import type {
  AutoreplyConfigDto,
  AutoreplyOverviewResponse,
  AutoreplyScriptTemplateRequest,
  AutoreplyScriptTemplateResponse,
  BrandProfileDto,
  BulkSetAutoreplyResponse,
  ConfigSource,
  EffectiveAutoreplyConfigResponse,
  EffectiveConfig,
  ParsedAutoreplyConfig,
  Platform,
} from '@ottm/shared'
import { KNOWLEDGE_MAX_TOKENS, autoreplyEnableIssues } from '@ottm/shared'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { getGroup, getPage, listGroups, listPages } from '../pages/index.ts'
import { autoreplyValues, getAutoreplyRow, upsertAutoreplyRow } from './autoreply-row.ts'
import { scriptForIndustry, scriptFromBrand } from './autoreply-template.ts'
import { getPageConfigState, onGroupProfileSaved, resolveEffective, setUseOwn } from './inheritance.ts'
import { assertKnowledgeFits, tooLarge } from './knowledge.ts'
import { listReadyKnowledge, readyKnowledgeTokens, type ReadyKnowledgeEntry } from './knowledge-row.ts'
import type { ProfileOwner } from './row.ts'
import { assertOwnerExists, getProfile } from './service.ts'

const pageOwner = (pageId: string): ProfileOwner => ({ ownerType: 'page', ownerId: pageId })

/** Cấu hình RIÊNG của chủ (nhóm/trang); `null` khi chưa có (FE dùng mặc định). Không kiểm owner tồn tại. */
export function getAutoreplyConfig(db: DbExecutor, owner: ProfileOwner): Promise<AutoreplyConfigDto | null> {
  return getAutoreplyRow(db, owner)
}

/**
 * Lưu cấu hình của chủ trong MỘT transaction (AD-3). Owner phải tồn tại (404).
 * - Trang đang theo nhóm: `setUseOwn(true)` trước (sao chép cấu hình nhóm làm điểm xuất phát, `use_own=true`) rồi
 *   ghi đè bằng body — "bật Dùng cấu hình AI riêng + Lưu" là một request.
 * - Nhóm: sau khi lưu, các trang đang chờ nhóm (`awaiting_group_default`) chuyển về "Theo nhóm".
 * - Lưu ở trạng thái bật: kho kiến thức của chủ (đã sao chép nếu trang vừa chuyển sang riêng) phải vừa giới hạn.
 */
export async function saveAutoreplyConfig(db: Db, owner: ProfileOwner, input: ParsedAutoreplyConfig): Promise<AutoreplyConfigDto> {
  return db.transaction(async (tx) => {
    await assertOwnerExists(tx, owner)
    if (owner.ownerType === 'page') {
      const page = await getPage(tx, owner.ownerId)
      const state = await getPageConfigState(tx, owner.ownerId, 'autoreply')
      if (page?.groupId && !state.useOwn) await setUseOwn(tx, owner.ownerId, 'autoreply', true)
    }
    if (input.enabled) await assertKnowledgeFits(tx, owner)
    const dto = await upsertAutoreplyRow(tx, autoreplyValues(owner, input))
    if (owner.ownerType === 'group') await onGroupProfileSaved(tx, owner.ownerId, 'autoreply')
    return dto
  })
}

/** `resolveEffective` nhưng `CONFIG_MISSING` → `null` (lỗi khác ném tiếp). */
async function effectiveOrNull<T>(db: DbExecutor, pageId: string, kind: 'autoreply' | 'brand'): Promise<EffectiveConfig<T> | null> {
  try {
    return await resolveEffective<T>(db, pageId, kind)
  } catch (err) {
    if (err instanceof AppError && err.code === 'CONFIG_MISSING') return null
    throw err
  }
}

/** Trang dùng cấu hình riêng: cờ `use_own`, hoặc trang không nhóm (không có gì để kế thừa). */
async function usesOwn(db: DbExecutor, page: { id: string; groupId: string | null }): Promise<boolean> {
  return !page.groupId || (await getPageConfigState(db, page.id, 'autoreply')).useOwn
}

/** Cấu hình hiệu lực của trang (đã giải kế thừa) kèm `useOwn`. Trang không tồn tại/đã gỡ → 404. */
export async function getEffectiveAutoreply(db: DbExecutor, pageId: string): Promise<EffectiveAutoreplyConfigResponse> {
  const page = await getPage(db, pageId)
  if (!page) throw new AppError('NOT_FOUND', 404, { message: 'Trang không tồn tại', details: { pageId } })
  return { effective: await effectiveOrNull<AutoreplyConfigDto>(db, pageId, 'autoreply'), useOwn: await usesOwn(db, page) }
}

/** Bật/tắt "Dùng cấu hình AI riêng" (áp khi Lưu) — luật ở `setUseOwn`; trả hiệu lực mới. */
export async function setAutoreplyUseOwn(db: Db, pageId: string, useOwn: boolean): Promise<EffectiveAutoreplyConfigResponse> {
  await db.transaction((tx) => setUseOwn(tx, pageId, 'autoreply', useOwn))
  return getEffectiveAutoreply(db, pageId)
}

/**
 * Kịch bản dựng sẵn (AD-2: template xác định, không gọi AI). `industry` → mẫu theo ngành. `brand` → hồ sơ HIỆU LỰC
 * của chủ: nhóm dùng hồ sơ của nhóm; trang dùng `resolveEffective(pageId, 'brand')`. Không có hồ sơ → `CONFIG_MISSING`.
 */
export async function buildAutoreplyScript(db: DbExecutor, req: AutoreplyScriptTemplateRequest): Promise<AutoreplyScriptTemplateResponse> {
  if (req.source === 'industry') return { script: scriptForIndustry(req.industry), brandSource: null }
  const owner: ProfileOwner = { ownerType: req.ownerType, ownerId: req.ownerId }
  await assertOwnerExists(db, owner)
  if (owner.ownerType === 'group') {
    const profile = await getProfile(db, owner)
    const group = await getGroup(db, owner.ownerId)
    if (!profile || !group) throw brandMissing(owner)
    return { script: scriptFromBrand(profile), brandSource: { ownerType: 'group', ownerId: group.id, name: group.name } }
  }
  const effective = await effectiveOrNull<BrandProfileDto>(db, owner.ownerId, 'brand')
  if (!effective) throw brandMissing(owner)
  return { script: scriptFromBrand(effective.config), brandSource: effective.source }
}

function brandMissing(owner: ProfileOwner): AppError {
  return new AppError('CONFIG_MISSING', 422, { message: 'Chưa có hồ sơ thương hiệu để dựng kịch bản', details: { ...owner, kind: 'brand' } })
}

/**
 * Tổng quan cho cây nhóm/trang và `Page.autoReply` (dẫn xuất, AD-8). Trạng thái từng trang đi qua `resolveEffective`
 * (một lần mỗi trang — app một chủ, vài chục trang).
 */
export async function autoreplyOverview(db: DbExecutor): Promise<AutoreplyOverviewResponse> {
  const groups = await listGroups(db)
  const pages = await listPages(db)
  const groupRows: AutoreplyOverviewResponse['groups'] = []
  for (const g of groups) {
    const cfg = await getAutoreplyRow(db, { ownerType: 'group', ownerId: g.id })
    groupRows.push({ groupId: g.id, configured: !!cfg, enabled: cfg?.enabled ?? false })
  }
  const pageRows: AutoreplyOverviewResponse['pages'] = []
  for (const p of pages) {
    const effective = await effectiveOrNull<AutoreplyConfigDto>(db, p.id, 'autoreply')
    pageRows.push({
      pageId: p.id,
      groupId: p.groupId,
      mode: (await usesOwn(db, p)) ? 'own' : 'group',
      configured: !!effective,
      enabled: effective?.config.enabled ?? false,
    })
  }
  return { groups: groupRows, pages: pageRows }
}

type BulkOutcome = 'updated' | 'unchanged'

/**
 * Bật/Tắt AI hàng loạt (Bảng trang, AD-8). Mỗi trang một transaction — trang lỗi không chặn trang khác:
 * - Cấu hình hiệu lực đã đúng trạng thái đích → không đổi gì (trang theo nhóm vẫn "Theo nhóm").
 * - Trang theo nhóm cần đổi → `setUseOwn(true)` (sao chép cấu hình nhóm) rồi đổi `enabled` trên bản riêng.
 * - Bật mà không có cấu hình hiệu lực → `CONFIG_MISSING`; cấu hình không đủ điều kiện bật → `VALIDATION_FAILED`
 *   (rollback: trang không bị chuyển sang riêng). Tắt trang chưa có cấu hình = đã tắt → `unchanged`.
 * - Bật mà kho kiến thức của cấu hình hiệu lực vượt giới hạn → `KNOWLEDGE_TOO_LARGE` (Story 5.2).
 */
export async function bulkSetAutoreplyEnabled(db: Db, pageIds: readonly string[], enabled: boolean): Promise<BulkSetAutoreplyResponse> {
  const result: BulkSetAutoreplyResponse = { updated: [], unchanged: [], failed: [] }
  for (const pageId of new Set(pageIds)) {
    try {
      const outcome = await db.transaction(async (tx): Promise<BulkOutcome> => {
        const effective = await effectiveOrNull<AutoreplyConfigDto>(tx, pageId, 'autoreply')
        if (!effective) {
          if (!enabled) return 'unchanged'
          throw new AppError('CONFIG_MISSING', 422, { message: 'Trang chưa có cấu hình AI', details: { pageId } })
        }
        if (effective.config.enabled === enabled) return 'unchanged'
        const next = { ...effective.config, enabled }
        const issues = autoreplyEnableIssues(next)
        if (issues.length > 0) throw new AppError('VALIDATION_FAILED', 400, { details: issues.map((i) => ({ path: [i.path], message: i.message })) })
        if (enabled) await assertKnowledgeFits(tx, { ownerType: effective.source.ownerType, ownerId: effective.source.ownerId })
        if (effective.source.ownerType === 'group') await setUseOwn(tx, pageId, 'autoreply', true)
        await upsertAutoreplyRow(tx, autoreplyValues(pageOwner(pageId), next))
        return 'updated'
      })
      result[outcome].push(pageId)
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      result.failed.push({ pageId, code: err.code })
    }
  }
  return result
}

/* ---------- Thử AI (Story 5.3) ---------- */

/** Dữ liệu prompt của "Thử AI" cho một chủ — giải giống form (hồ sơ hiệu lực, kho đang hiển thị). */
export interface AutoreplyTestSources {
  /** Tên nhóm/trang — prompt dùng khi hồ sơ chưa đặt tên thương hiệu. */
  name: string
  /** Trang được thử (`ai_usage.page_id`); `null` khi thử cho cả nhóm. */
  pageId: string | null
  /** Nền tảng của trang; nhóm → nền tảng các trang trong nhóm (có thể rỗng). */
  platforms: Platform[]
  /** Hồ sơ hiệu lực: nhóm → hồ sơ nhóm; trang → `resolveEffective(page,'brand')`. `null` = chưa có (vẫn thử được). */
  brand: BrandProfileDto | null
  /** Văn bản kho `ready` mà prompt nhét vào. */
  knowledge: ReadyKnowledgeEntry[]
}

/**
 * Nguồn prompt cho "Thử AI" (Story 5.3). Owner lạ → 404. Kho: nhóm → kho nhóm; trang dùng riêng (đã lưu) hoặc không
 * nhóm → kho trang; trang đang theo nhóm → kho nhóm (đúng kho form đang hiển thị — Story 5.2). Tổng token `ready` vượt
 * giới hạn → `KNOWLEDGE_TOO_LARGE` (prompt quá lớn, không gọi AI) kể cả khi cấu hình đang tắt.
 */
export async function autoreplyTestSources(db: DbExecutor, owner: ProfileOwner): Promise<AutoreplyTestSources> {
  await assertOwnerExists(db, owner)
  let sources: Omit<AutoreplyTestSources, 'knowledge'>
  let kbOwner: ProfileOwner
  if (owner.ownerType === 'group') {
    const group = (await getGroup(db, owner.ownerId))!
    const members = (await listPages(db)).filter((p) => p.groupId === group.id)
    sources = { name: group.name, pageId: null, platforms: [...new Set(members.map((p) => p.platform))], brand: await getProfile(db, owner) }
    kbOwner = owner
  } else {
    const page = (await getPage(db, owner.ownerId))!
    const brand = await effectiveOrNull<BrandProfileDto>(db, page.id, 'brand')
    sources = { name: page.name, pageId: page.id, platforms: [page.platform], brand: brand?.config ?? null }
    kbOwner = (await usesOwn(db, page)) ? owner : { ownerType: 'group', ownerId: page.groupId! }
  }
  const tokens = await readyKnowledgeTokens(db, kbOwner)
  if (tokens > KNOWLEDGE_MAX_TOKENS) throw tooLarge(tokens)
  return { ...sources, knowledge: await listReadyKnowledge(db, kbOwner) }
}

/* ---------- Lượt AI trả lời thật (Story 5.4) ---------- */

/** Nguồn prompt cho một lượt AI trả lời tin của trang — cấu hình HIỆU LỰC (đã lưu), hồ sơ hiệu lực, kho của cấu hình. */
export interface AutoreplyRunSources {
  config: AutoreplyConfigDto
  /** Cấu hình đã dùng (AD-8) — lưu vào `autoreply_runs`. */
  source: ConfigSource
  /** Hồ sơ hiệu lực `resolveEffective(page,'brand')`; `null` = chưa có (vẫn trả lời theo kịch bản + kho). */
  brand: BrandProfileDto | null
  /** Văn bản kho `ready` của CHỦ cấu hình hiệu lực (nhóm khi trang theo nhóm). */
  knowledge: ReadyKnowledgeEntry[]
  pageName: string
}

/**
 * Nguồn cho lượt chạy thật: cấu hình hiệu lực qua `resolveEffective` (không có → ném `CONFIG_MISSING`), kho kiến thức
 * của đúng chủ cấu hình đó. Không chặn kho vượt giới hạn ở đây — đã chặn lúc bật/lưu (Story 5.2).
 */
export async function autoreplyRunSources(db: DbExecutor, pageId: string): Promise<AutoreplyRunSources> {
  const effective = await resolveEffective<AutoreplyConfigDto>(db, pageId, 'autoreply')
  const page = await getPage(db, pageId)
  const brand = await effectiveOrNull<BrandProfileDto>(db, pageId, 'brand')
  const kbOwner: ProfileOwner = { ownerType: effective.source.ownerType, ownerId: effective.source.ownerId }
  return {
    config: effective.config,
    source: effective.source,
    brand: brand?.config ?? null,
    knowledge: await listReadyKnowledge(db, kbOwner),
    pageName: page?.name ?? effective.source.name,
  }
}
