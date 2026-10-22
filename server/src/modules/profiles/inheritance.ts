// Kế thừa cấu hình Nhóm→Trang giải ở MỘT chỗ (AD-8, Story 3.2 + 3.3).
// - `resolveEffective` là hàm DUY NHẤT giải "trang dùng cấu hình nào" → `{config, source}` hoặc `CONFIG_MISSING`.
// - "Registry loại cấu hình" (`REGISTRY`): mỗi loại (nay `brand`; AI đăng ký ở Epic 5) khai các thao tác
//   `exists/get/copy/remove`, nhờ đó mọi luật kế thừa + xử lý đổi nhóm viết MỘT lần, chạy cho mọi loại.
// - `applyGroupChange`/`onGroupProfileSaved`: các chuyển đổi 3.3, idempotent (sự kiện có thể tới hai lần).
// Không nhân bản luật kế thừa ở nơi khác. Mọi hàm nhận executor (tx) để chạy trong transaction của bên gọi (AD-3).
import type { BrandProfileDto, ConfigKind, ConfigSource, EffectiveConfig } from '@ottm/shared'
import { CONFIG_KINDS } from '@ottm/shared'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { DbExecutor } from '../../platform/db/index.ts'
import { AppError } from '../../platform/errors/index.ts'
import { getGroup, getPage, pagesTable } from '../pages/index.ts'
import { brandOwnerWhere, toBrandDto, type ProfileOwner } from './row.ts'
import { brandProfiles, pageConfigState } from './schema.ts'

/* ---------- Registry loại cấu hình ---------- */

/**
 * Thao tác một loại cấu hình cần cung cấp để dùng chung luật kế thừa. `config` để `unknown` ở lớp generic;
 * mỗi loại trả DTO riêng (brand → `BrandProfileDto`). Mọi thao tác ghi nhận executor của transaction bên gọi.
 */
export interface ConfigKindOps {
  /** Chủ (group|page) đã có cấu hình loại này chưa. */
  exists(db: DbExecutor, owner: ProfileOwner): Promise<boolean>
  /** Cấu hình của chủ, hoặc `null` khi chưa có. */
  get(db: DbExecutor, owner: ProfileOwner): Promise<unknown | null>
  /** Sao chép cấu hình `from` → `to` (điểm xuất phát). No-op khi `from` chưa có cấu hình. */
  copy(tx: DbExecutor, from: ProfileOwner, to: ProfileOwner): Promise<void>
  /** Xoá cấu hình riêng của chủ. No-op khi chưa có (idempotent). */
  remove(tx: DbExecutor, owner: ProfileOwner): Promise<void>
}

const brandOps: ConfigKindOps = {
  async exists(db, owner) {
    const [row] = await db.select({ id: brandProfiles.id }).from(brandProfiles).where(brandOwnerWhere(owner))
    return !!row
  },
  async get(db, owner): Promise<BrandProfileDto | null> {
    const [row] = await db.select().from(brandProfiles).where(brandOwnerWhere(owner))
    return row ? toBrandDto(row) : null
  },
  async copy(tx, from, to) {
    const [src] = await tx.select().from(brandProfiles).where(brandOwnerWhere(from))
    if (!src) return
    // Sao chép cả phần chữ lẫn logo làm điểm xuất phát cho `to`; upsert để idempotent khi sự kiện tới hai lần.
    const values = {
      ownerType: to.ownerType,
      ownerId: to.ownerId,
      name: src.name,
      slogan: src.slogan,
      industry: src.industry,
      tones: src.tones,
      formality: src.formality,
      pronoun: src.pronoun,
      emoji: src.emoji,
      products: src.products,
      audience: src.audience,
      colors: src.colors,
      hashtags: src.hashtags,
      bannedWords: src.bannedWords,
      allowedDomains: src.allowedDomains,
      logoPath: src.logoPath,
    }
    await tx
      .insert(brandProfiles)
      .values(values)
      .onConflictDoUpdate({ target: [brandProfiles.ownerType, brandProfiles.ownerId], set: { ...values, updatedAt: sql`now()` } })
  },
  async remove(tx, owner) {
    await tx.delete(brandProfiles).where(brandOwnerWhere(owner))
  },
}

/** Registry: brand đăng ký ở Story 3.2/3.3; `autoreply` (AI) sẽ thêm ở Epic 5 mà không đổi luật kế thừa. */
export const REGISTRY: Record<ConfigKind, ConfigKindOps> = {
  brand: brandOps,
}

const pageOwner = (pageId: string): ProfileOwner => ({ ownerType: 'page', ownerId: pageId })
const groupOwner = (groupId: string): ProfileOwner => ({ ownerType: 'group', ownerId: groupId })

/* ---------- Trạng thái kế thừa của trang (page_config_state) ---------- */

interface PageConfigState {
  useOwn: boolean
  awaitingGroupDefault: boolean
}

/** Trạng thái `(pageId, kind)`; mặc định (không có dòng) = theo nhóm (`use_own=false`, không chờ). */
export async function getPageConfigState(db: DbExecutor, pageId: string, kind: ConfigKind): Promise<PageConfigState> {
  const [row] = await db
    .select({ useOwn: pageConfigState.useOwn, awaiting: pageConfigState.awaitingGroupDefault })
    .from(pageConfigState)
    .where(and(eq(pageConfigState.pageId, pageId), eq(pageConfigState.kind, kind)))
  return { useOwn: row?.useOwn ?? false, awaitingGroupDefault: row?.awaiting ?? false }
}

async function setPageConfigState(tx: DbExecutor, pageId: string, kind: ConfigKind, next: PageConfigState): Promise<void> {
  const values = { pageId, kind, useOwn: next.useOwn, awaitingGroupDefault: next.awaitingGroupDefault }
  await tx
    .insert(pageConfigState)
    .values(values)
    .onConflictDoUpdate({ target: [pageConfigState.pageId, pageConfigState.kind], set: { useOwn: next.useOwn, awaitingGroupDefault: next.awaitingGroupDefault, updatedAt: sql`now()` } })
}

/* ---------- Giải kế thừa (hàm DUY NHẤT) ---------- */

/**
 * Hồ sơ/cấu hình hiệu lực của trang cho `kind` (AD-8): `use_own=true` → cấu hình của trang; else có nhóm &
 * nhóm có cấu hình → cấu hình nhóm kèm `source{ownerType:group}`; không có → ném `CONFIG_MISSING`.
 * ĐÂY là nơi DUY NHẤT giải kế thừa — consumer (autoreply/composer/campaigns) chỉ gọi hàm này.
 */
export async function resolveEffective<T = unknown>(db: DbExecutor, pageId: string, kind: ConfigKind): Promise<EffectiveConfig<T>> {
  const page = await getPage(db, pageId)
  if (!page) throw new AppError('NOT_FOUND', 404, { message: 'Trang không tồn tại', details: { pageId } })
  const ops = REGISTRY[kind]
  const state = await getPageConfigState(db, pageId, kind)
  if (state.useOwn) {
    const config = await ops.get(db, pageOwner(pageId))
    if (config) return { config: config as T, source: sourceOf('page', pageId, page.name) }
    // Vừa bật "dùng riêng" nhưng chưa lưu phần chữ (hoặc nhóm trống lúc copy) → chưa có cấu hình để dùng.
    throw configMissing(pageId, kind)
  }
  if (page.groupId) {
    // Theo nhóm: dùng hồ sơ nhóm; nhóm chưa có → CONFIG_MISSING (không rơi về cấu hình riêng còn sót).
    const group = await getGroup(db, page.groupId)
    const config = group ? await ops.get(db, groupOwner(group.id)) : null
    if (group && config) return { config: config as T, source: sourceOf('group', group.id, group.name) }
    throw configMissing(pageId, kind)
  }
  // Trang không nhóm: không có gì để kế thừa — dùng hồ sơ riêng của trang nếu đã tạo (AC4), else CONFIG_MISSING.
  const own = await ops.get(db, pageOwner(pageId))
  if (own) return { config: own as T, source: sourceOf('page', pageId, page.name) }
  throw configMissing(pageId, kind)
}

const sourceOf = (ownerType: ConfigSource['ownerType'], ownerId: string, name: string): ConfigSource => ({ ownerType, ownerId, name })

function configMissing(pageId: string, kind: ConfigKind): AppError {
  return new AppError('CONFIG_MISSING', 422, { message: `Trang chưa có cấu hình "${kind}"`, details: { pageId, kind } })
}

/* ---------- Bật/tắt "Dùng cấu hình riêng" (áp khi Lưu) ---------- */

/**
 * Bật/tắt dùng cấu hình riêng cho trang (Story 3.2). `true`: nếu trang chưa có cấu hình riêng và nhóm có cấu
 * hình → sao chép nhóm→trang làm điểm xuất phát, rồi `use_own=true`. `false`: xoá cấu hình riêng, `use_own=false`
 * (trang quay về hồ sơ nhóm). Chạy trong transaction của bên gọi (AD-3).
 */
export async function setUseOwn(tx: DbExecutor, pageId: string, kind: ConfigKind, useOwn: boolean): Promise<void> {
  const page = await getPage(tx, pageId)
  if (!page) throw new AppError('NOT_FOUND', 404, { message: 'Trang không tồn tại', details: { pageId } })
  const ops = REGISTRY[kind]
  // Trang không thuộc nhóm thì không có gì để kế thừa — tắt "dùng riêng" sẽ xoá hồ sơ DUY NHẤT của trang.
  // Từ chối (VALIDATION_FAILED): FE không hiện công tắc cho trang không nhóm; đây là chốt chặn phía server.
  if (!useOwn && !page.groupId) {
    throw new AppError('VALIDATION_FAILED', 400, { message: 'Trang không thuộc nhóm — không thể tắt hồ sơ riêng', details: { pageId, kind } })
  }
  if (useOwn) {
    const hasOwn = await ops.exists(tx, pageOwner(pageId))
    if (!hasOwn && page.groupId && (await ops.exists(tx, groupOwner(page.groupId)))) {
      await ops.copy(tx, groupOwner(page.groupId), pageOwner(pageId))
    }
    await setPageConfigState(tx, pageId, kind, { useOwn: true, awaitingGroupDefault: false })
  } else {
    await ops.remove(tx, pageOwner(pageId))
    await setPageConfigState(tx, pageId, kind, { useOwn: false, awaitingGroupDefault: false })
  }
}

/* ---------- Phản ứng đổi nhóm (Story 3.3), idempotent ---------- */

/**
 * Áp một lần đổi nhóm của trang cho một loại cấu hình (Story 3.3). Idempotent: dựa trên "trang có cấu hình riêng
 * chưa" (`exists`) nên chạy lại cho cùng sự kiện không nhân đôi/không hỏng.
 * - Rời mọi nhóm (`toGroupId=null`): chưa có riêng → sao chép cấu hình nhóm cũ thành riêng; `use_own` theo việc
 *   trang có cấu hình riêng sau đó.
 * - Vào nhóm đã có cấu hình loại này: xoá cấu hình riêng, `use_own=false` (theo nhóm).
 * - Vào nhóm CHƯA có cấu hình loại này: giữ/sao chép cấu hình (để không mất hành vi), đánh dấu `awaiting`.
 */
export async function applyGroupChange(
  tx: DbExecutor,
  pageId: string,
  kind: ConfigKind,
  fromGroupId: string | null,
  toGroupId: string | null,
): Promise<void> {
  const ops = REGISTRY[kind]
  const copyFromOld = async () => {
    if (fromGroupId && (await ops.exists(tx, groupOwner(fromGroupId)))) {
      await ops.copy(tx, groupOwner(fromGroupId), pageOwner(pageId))
    }
  }
  if (toGroupId === null) {
    if (!(await ops.exists(tx, pageOwner(pageId)))) await copyFromOld()
    await setPageConfigState(tx, pageId, kind, { useOwn: await ops.exists(tx, pageOwner(pageId)), awaitingGroupDefault: false })
    return
  }
  if (await ops.exists(tx, groupOwner(toGroupId))) {
    await ops.remove(tx, pageOwner(pageId))
    await setPageConfigState(tx, pageId, kind, { useOwn: false, awaitingGroupDefault: false })
    return
  }
  // Nhóm mới chưa có cấu hình loại này → giữ hành vi: sao chép cấu hình nhóm cũ nếu trang chưa có riêng.
  if (!(await ops.exists(tx, pageOwner(pageId)))) await copyFromOld()
  await setPageConfigState(tx, pageId, kind, { useOwn: await ops.exists(tx, pageOwner(pageId)), awaitingGroupDefault: true })
}

/**
 * Nhóm vừa lưu cấu hình loại `kind` → các trang trong nhóm đang `awaiting` chuyển về "Theo nhóm"
 * (`use_own=false`, bỏ cờ, xoá cấu hình riêng đã giữ tạm). Idempotent: lần lưu sau không còn trang awaiting.
 */
export async function onGroupProfileSaved(tx: DbExecutor, groupId: string, kind: ConfigKind): Promise<void> {
  const rows = await tx
    .select({ pageId: pageConfigState.pageId })
    .from(pageConfigState)
    .innerJoin(pagesTable, eq(pagesTable.id, pageConfigState.pageId))
    .where(
      and(
        eq(pageConfigState.kind, kind),
        eq(pageConfigState.awaitingGroupDefault, true),
        eq(pagesTable.groupId, groupId),
        isNull(pagesTable.removedAt),
      ),
    )
  const ops = REGISTRY[kind]
  for (const { pageId } of rows) {
    await ops.remove(tx, pageOwner(pageId))
    await setPageConfigState(tx, pageId, kind, { useOwn: false, awaitingGroupDefault: false })
  }
}

/** Loại cấu hình đã đăng ký (để consumer lặp qua mọi loại). */
export const REGISTERED_KINDS = CONFIG_KINDS
