// Đăng nhập chủ sở hữu (AD-19): hash mật khẩu argon2id, phiên 30 ngày trượt lưu trong `sessions`.
// Token phiên chỉ sống trong cookie; DB giữ sha256 của nó. Không log mật khẩu hay token (AD-12).
import { createHash, randomBytes } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import { and, eq, gt, lte, sql } from 'drizzle-orm'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import { secrets, sessions } from './schema.ts'

export const OWNER_PASSWORD_SECRET = 'owner_password'
export const SESSION_TTL_DAYS = 30
/** Chỉ ghi DB để gia hạn khi phiên còn ít hơn mức này (tránh ghi mỗi request). */
export const SESSION_RENEW_BELOW_DAYS = 29
const DAY_MS = 86_400_000

// @node-rs/argon2 khai `Algorithm` là const enum (không dùng được khi xoá kiểu) — 2 = Argon2id.
const ARGON2ID = 2
const ARGON2_OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

export interface OwnerSession {
  id: string
  expiresAt: Date
  /** true khi lần resolve này vừa gia hạn `expires_at` — cookie cần đặt lại Max-Age. */
  renewed: boolean
}

/** Chuẩn hoá Unicode trước khi hash/verify: terminal có thể gõ NFD, trình duyệt gửi NFC. */
export function normalizePassword(password: string): string {
  return password.normalize('NFC')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Lưu hash argon2id mới và xoá mọi phiên cũ trong cùng transaction. */
export async function setOwnerPassword(db: Db, password: string): Promise<void> {
  const value = await hash(normalizePassword(password), ARGON2_OPTIONS)
  await db.transaction(async (tx) => {
    await tx
      .insert(secrets)
      .values({ name: OWNER_PASSWORD_SECRET, kind: 'argon2id', value })
      .onConflictDoUpdate({ target: secrets.name, set: { kind: 'argon2id', value, updatedAt: sql`now()` } })
    await tx.delete(sessions)
  })
}

let dummyHash: Promise<string> | undefined

/**
 * true khi khớp hash đã lưu. Chưa đặt mật khẩu → vẫn chạy verify trên hash giả để thời gian
 * phản hồi không lộ việc đã đặt mật khẩu hay chưa, rồi trả false.
 */
export async function verifyOwnerPassword(db: Db, password: string): Promise<boolean> {
  const [row] = await db
    .select({ kind: secrets.kind, value: secrets.value })
    .from(secrets)
    .where(eq(secrets.name, OWNER_PASSWORD_SECRET))
  const normalized = normalizePassword(password)
  if (!row || row.kind !== 'argon2id') {
    dummyHash ??= hash(randomBytes(16).toString('hex'), ARGON2_OPTIONS)
    await verify(await dummyHash, normalized).catch(() => false)
    return false
  }
  try {
    return await verify(row.value, normalized)
  } catch {
    return false
  }
}

/** Tạo phiên mới; trả token thô (chỉ để đặt cookie) — DB lưu sha256. */
export async function createSession(db: Db): Promise<{ token: string; session: OwnerSession }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * DAY_MS)
  // Một chủ sở hữu → bảng nhỏ; dọn phiên hết hạn mỗi lần đăng nhập (và hằng ngày qua `deleteExpiredSessions`).
  await deleteExpiredSessions(db)
  const [row] = await db
    .insert(sessions)
    .values({ tokenHash: hashToken(token), expiresAt })
    .returning({ id: sessions.id, expiresAt: sessions.expiresAt })
  return { token, session: { id: row!.id, expiresAt: row!.expiresAt, renewed: false } }
}

/** Phiên còn hạn ứng với token, gia hạn trượt khi còn < 29 ngày; null nếu không có/hết hạn. */
export async function resolveSession(db: Db, token: string | undefined): Promise<OwnerSession | null> {
  if (!token) return null
  const tokenHash = hashToken(token)
  const [row] = await db
    .select({ id: sessions.id, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, sql`now()`)))
  if (!row) return null
  if (row.expiresAt.getTime() - Date.now() >= SESSION_RENEW_BELOW_DAYS * DAY_MS) {
    return { id: row.id, expiresAt: row.expiresAt, renewed: false }
  }
  const [renewed] = await db
    .update(sessions)
    .set({
      expiresAt: sql`now() + make_interval(days => ${SESSION_TTL_DAYS})`,
      lastSeenAt: sql`now()`,
    })
    .where(eq(sessions.id, row.id))
    .returning({ id: sessions.id, expiresAt: sessions.expiresAt })
  if (!renewed) return null // bị xoá giữa chừng (đăng xuất / đặt mật khẩu)
  return { id: renewed.id, expiresAt: renewed.expiresAt, renewed: true }
}

/** Phiên của token còn hạn? Chỉ đọc, không gia hạn (dùng để kiểm lại stream SSE đang mở). */
export async function isSessionValid(db: Db, token: string | undefined): Promise<boolean> {
  if (!token) return false
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, sql`now()`)))
  return row !== undefined
}

/** Xoá phiên ứng với token (đăng xuất, xoay phiên khi đăng nhập). Không có → bỏ qua. */
export async function deleteSession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}

export async function deleteAllSessions(db: Db): Promise<void> {
  await db.delete(sessions)
}

/**
 * Story 9.3 (AD-22 "session hết hạn xoá ngay"): xoá mọi phiên đã hết hạn — cron `privacy.retention` gọi hằng ngày, đăng
 * nhập cũng gọi. Một chủ sở hữu nên bảng nhỏ, một câu lệnh. Trả số phiên đã xoá.
 */
export async function deleteExpiredSessions(db: DbExecutor): Promise<number> {
  const rows = await db.delete(sessions).where(lte(sessions.expiresAt, sql`now()`)).returning({ id: sessions.id })
  return rows.length
}
