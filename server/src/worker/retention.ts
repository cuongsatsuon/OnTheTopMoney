// Dọn dữ liệu theo thời hạn (Story 9.3, AD-22, AD-1) — entrypoint ghép, vì `privacy` chỉ được gọi module nền còn việc dọn
// chạm bảng của nhiều module. Mỗi module chủ bảng tự dọn qua hàm export của nó; file này chỉ gọi lần lượt và gom số đếm.
// - `runRetention` (cron `privacy.retention`): payload thô webhook → null, lượt AI cũ, tham chiếu chi phí AI cũ, phiên hết
//   hạn — theo bảng `RETENTION` của `packages/shared`. Một bước lỗi không chặn bước khác; cuối lượt ném lỗi gộp (retry 1).
// - `sweepOrphanFiles` (cron `privacy.orphan_files`): liệt kê file của app trên Cloudinary theo prefix, so với tham chiếu của
//   `content` (ảnh bài), `inbox` (đính kèm), `profiles` (file kho kiến thức, logo), xoá file mồ côi. Chốt an toàn: chỉ file
//   ≥ `RETENTION.orphanFileMinAgeDays` tuổi, trần số file xoá / số trang mỗi lượt, cầu dao khi tỉ lệ mồ côi bất thường (DB
//   không khớp kho), kiểm lại tham chiếu ngay trước khi xoá, chế độ `MEDIA_ORPHAN_SWEEP`. Con trỏ trang lưu ở `settings`.
// Log chỉ số đếm (+ prefix theo loại cho báo cáo dry_run) — không public_id đầy đủ, không nội dung.
import { DAY_MS, RETENTION, type MediaOrphanSweepMode } from '@ottm/shared'
import { STORED_FILE_KINDS, type MediaStores, type StoredFileKind } from '../adapters/media/index.ts'
import { clearExpiredRefs } from '../modules/ai/index.ts'
import { purgeExpiredRuns } from '../modules/autoreply/index.ts'
import { referencedMediaFiles } from '../modules/content/index.ts'
import { referencedAttachmentFiles } from '../modules/inbox/index.ts'
import { referencedProfileFiles } from '../modules/profiles/index.ts'
import { deleteExpiredSessions, getStateValue, setStateValue } from '../modules/settings/index.ts'
import { purgeExpiredPayloads } from '../modules/webhooks/index.ts'
import type { BatchOptions, BatchResult, Db } from '../platform/db/index.ts'
import type { Logger } from '../platform/log/index.ts'

// ---------------------------------------------------------------------------------------------------------
// Dọn DB theo hạn
// ---------------------------------------------------------------------------------------------------------

export interface RetentionDeps {
  db: Db
  log?: Logger
  now?: () => Date
  batch?: BatchOptions
}

export interface RetentionRunResult {
  webhookPayloads: BatchResult
  autoreplyRuns: BatchResult
  aiUsageRefs: BatchResult
  sessions: number
  /** Tên bước lỗi (đã log); rỗng = lượt trọn vẹn. */
  failed: string[]
}

export class RetentionStepsError extends Error {
  readonly steps: string[]
  constructor(steps: string[], cause: unknown) {
    super(`privacy.retention: bước lỗi ${steps.join(', ')}`, { cause })
    this.name = 'RetentionStepsError'
    this.steps = steps
  }
}

const EMPTY: BatchResult = { count: 0, done: true }

/** Một lượt dọn theo hạn. Ném `RetentionStepsError` khi có bước lỗi — SAU khi đã chạy mọi bước còn lại. */
export async function runRetention(deps: RetentionDeps): Promise<RetentionRunResult> {
  const now = deps.now?.() ?? new Date()
  const opts = { ...deps.batch, now }
  const result: RetentionRunResult = { webhookPayloads: EMPTY, autoreplyRuns: EMPTY, aiUsageRefs: EMPTY, sessions: 0, failed: [] }
  let firstError: unknown
  const step = async <T>(name: string, run: () => Promise<T>, apply: (value: T) => void) => {
    try {
      apply(await run())
    } catch (err) {
      result.failed.push(name)
      firstError ??= err
      deps.log?.error({ err, step: name }, 'privacy.retention: bước dọn lỗi')
    }
  }
  await step('webhooks', () => purgeExpiredPayloads(deps.db, opts), (v) => (result.webhookPayloads = v))
  await step('autoreply', () => purgeExpiredRuns(deps.db, opts), (v) => (result.autoreplyRuns = v))
  await step('ai', () => clearExpiredRefs(deps.db, opts), (v) => (result.aiUsageRefs = v))
  await step('settings', () => deleteExpiredSessions(deps.db), (v) => (result.sessions = v))
  if (result.failed.length > 0) throw new RetentionStepsError(result.failed, firstError)
  return result
}

// ---------------------------------------------------------------------------------------------------------
// Dọn file mồ côi trên Cloudinary
// ---------------------------------------------------------------------------------------------------------

export const ORPHAN_SWEEP_LIMITS = {
  /** File xoá tối đa mỗi lượt (mọi loại cộng lại). */
  maxDeletes: 100,
  /** Trang liệt kê tối đa mỗi loại mỗi lượt. */
  maxPages: 5,
  pageSize: 500,
  /** Cầu dao: xét khi đã quét ít nhất ngần này file cũ… */
  breakerMinOld: 20,
  /** …và tỉ lệ mồ côi trong số đó vượt mức này → không xoá gì. */
  breakerRatio: 0.5,
}
export type OrphanSweepLimits = typeof ORPHAN_SWEEP_LIMITS

/** Khoá `settings` giữ con trỏ trang của từng loại giữa hai lượt (`null` = từ đầu). */
export const ORPHAN_CURSORS_KEY = 'media_orphan_cursors'

/**
 * Chế độ hiệu lực: env tường minh, không thì `dry_run` ở MỌI môi trường (kể cả production — quyết định của chủ dự án,
 * review 9.3: đường Admin API chưa từng chạy với Cloudinary thật; người vận hành đối chiếu báo cáo dry_run với kho thật
 * rồi mới đặt `on`).
 */
export function resolveSweepMode(config: { MEDIA_ORPHAN_SWEEP?: MediaOrphanSweepMode | undefined }): MediaOrphanSweepMode {
  return config.MEDIA_ORPHAN_SWEEP ?? 'dry_run'
}

export interface OrphanSweepDeps {
  db: Db
  media: Pick<MediaStores, 'configured' | 'inventory'>
  mode: MediaOrphanSweepMode
  log?: Logger
  now?: () => Date
  limits?: Partial<OrphanSweepLimits>
}

export interface OrphanSweepResult {
  mode: MediaOrphanSweepMode
  /** Lượt bỏ qua hẳn: chế độ `off` hoặc kho chưa cấu hình. */
  skipped: 'off' | 'not_configured' | null
  scanned: number
  /** File đủ tuổi (≥ hạn tối thiểu) trong số đã quét. */
  old: number
  orphans: number
  deleted: number
  /** File xoá lỗi (để lượt sau). */
  fileErrors: number
  /** Lỗi liệt kê (loại đó dừng ở lượt này). */
  storeErrors: number
  /** Cầu dao bật: tỉ lệ mồ côi bất thường, không xoá gì, con trỏ giữ nguyên. */
  tripped: boolean
  /**
   * Số đếm theo loại kèm prefix đã quét (review 9.3) — để người vận hành đối chiếu báo cáo `dry_run` với thư mục trên
   * Cloudinary thật. Chỉ prefix + số đếm, không public_id đầy đủ (AD-12).
   */
  byKind: Partial<Record<StoredFileKind, KindCounts>>
}

export interface KindCounts {
  prefix: string
  scanned: number
  old: number
  orphans: number
}

type Cursors = Partial<Record<StoredFileKind, string | null>>

function parseCursors(value: unknown): Cursors {
  const out: Cursors = {}
  if (typeof value !== 'object' || value === null) return out
  for (const kind of STORED_FILE_KINDS) {
    const c = (value as Record<string, unknown>)[kind]
    if (typeof c === 'string' && c !== '') out[kind] = c
  }
  return out
}

/** public_id còn được dòng nào ở `content` / `inbox` / `profiles` tham chiếu. */
async function referencedFiles(db: Db, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>()
  if (ids.length === 0) return found
  for (const lookup of [referencedMediaFiles, referencedAttachmentFiles, referencedProfileFiles]) {
    for (const id of await lookup(db, ids)) found.add(id)
  }
  return found
}

interface ScannedPage {
  /** Con trỏ dùng để tải trang này (để lượt sau tải lại trang khi còn file chưa xoá). */
  cursor: string | null
  orphans: string[]
}

interface ScannedKind {
  kind: StoredFileKind
  pages: ScannedPage[]
  /** Con trỏ cho lượt sau nếu mọi file mồ côi đã xử lý xong (`null` = hết danh sách, quay về đầu). */
  endCursor: string | null
}

/** Lỗi kho mà gọi tiếp ngay trong lượt cũng vô ích. */
const STOP_KINDS = new Set(['RATE_LIMITED', 'AUTH_FAILED', 'TRANSIENT', 'MEDIA_NOT_CONFIGURED'])

export async function sweepOrphanFiles(deps: OrphanSweepDeps): Promise<OrphanSweepResult> {
  const limits = { ...ORPHAN_SWEEP_LIMITS, ...deps.limits }
  const result: OrphanSweepResult = {
    mode: deps.mode,
    skipped: null,
    scanned: 0,
    old: 0,
    orphans: 0,
    deleted: 0,
    fileErrors: 0,
    storeErrors: 0,
    tripped: false,
    byKind: {},
  }
  if (deps.mode === 'off') return { ...result, skipped: 'off' }
  if (!deps.media.configured) return { ...result, skipped: 'not_configured' }

  const cutoff = (deps.now?.() ?? new Date()).getTime() - RETENTION.orphanFileMinAgeDays * DAY_MS
  const cursors = parseCursors(await getStateValue(deps.db, ORPHAN_CURSORS_KEY))

  // Giai đoạn 1 — quét: mỗi loại tối đa `maxPages` trang từ con trỏ đã lưu. Chưa xoá gì để cầu dao xét trên cả lượt.
  const scanned: ScannedKind[] = []
  for (const kind of STORED_FILE_KINDS) {
    let cursor = cursors[kind] ?? null
    const pages: ScannedPage[] = []
    const counts: KindCounts = { prefix: deps.media.inventory.prefix(kind), scanned: 0, old: 0, orphans: 0 }
    result.byKind[kind] = counts
    for (let p = 0; p < limits.maxPages; p++) {
      const res = await deps.media.inventory.list(kind, cursor, limits.pageSize)
      if (!res.ok) {
        result.storeErrors++
        deps.log?.warn({ kind, error: res.kind }, 'privacy.orphan_files: không liệt kê được file trên kho')
        // Con trỏ hỏng / hết hiệu lực → lượt sau quét lại từ đầu; lỗi khác → giữ chỗ cũ.
        if (res.kind === 'INVALID_REQUEST' && cursor !== null) cursor = null
        break
      }
      result.scanned += res.files.length
      const old = res.files.filter((f) => f.createdAt !== null && f.createdAt.getTime() < cutoff).map((f) => f.publicId)
      const refs = await referencedFiles(deps.db, old)
      const orphans = old.filter((id) => !refs.has(id))
      result.old += old.length
      result.orphans += orphans.length
      counts.scanned += res.files.length
      counts.old += old.length
      counts.orphans += orphans.length
      pages.push({ cursor, orphans })
      cursor = res.nextCursor
      if (cursor === null) break
    }
    scanned.push({ kind, pages, endCursor: cursor })
  }

  const ratio = result.old > 0 ? result.orphans / result.old : 0
  if (deps.mode !== 'force' && result.old >= limits.breakerMinOld && ratio > limits.breakerRatio) {
    deps.log?.warn(
      { old: result.old, orphans: result.orphans, byKind: result.byKind },
      'privacy.orphan_files: tỉ lệ file mồ côi bất thường (DB không khớp kho?) — không xoá; kiểm cấu hình hoặc đặt MEDIA_ORPHAN_SWEEP=force',
    )
    return { ...result, tripped: true }
  }

  // Giai đoạn 2 — xoá (bỏ qua khi `dry_run`). Con trỏ mới của loại = trang đầu tiên còn file chưa xoá (hết trần / lỗi tạm),
  // không thì `endCursor`.
  let budget = deps.mode === 'dry_run' ? 0 : limits.maxDeletes
  let stopped = deps.mode === 'dry_run'
  const next: Cursors = {}
  for (const { kind, pages, endCursor } of scanned) {
    let hold: string | null | undefined
    for (const page of pages) {
      for (const id of page.orphans) {
        if (stopped || budget <= 0) {
          // `dry_run`: chỉ đếm, con trỏ vẫn đi tiếp để lượt sau đếm phần còn lại.
          if (deps.mode !== 'dry_run' && hold === undefined) hold = page.cursor
          break
        }
        // Kiểm lại ngay trước khi xoá: file vừa được một dòng mới trỏ tới thì giữ.
        if ((await referencedFiles(deps.db, [id])).has(id)) continue
        const res = await deps.media.inventory.delete(kind, id)
        if (res.ok) {
          result.deleted++
          budget--
          continue
        }
        result.fileErrors++
        if (STOP_KINDS.has(res.kind)) {
          stopped = true
          if (hold === undefined) hold = page.cursor
          deps.log?.warn({ kind, error: res.kind }, 'privacy.orphan_files: xoá file trên kho lỗi — dừng lượt')
          break
        }
      }
    }
    next[kind] = hold !== undefined ? hold : endCursor
  }
  await setStateValue(deps.db, ORPHAN_CURSORS_KEY, next)
  return result
}
