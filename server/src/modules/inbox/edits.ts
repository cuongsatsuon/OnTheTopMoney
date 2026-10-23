// Tin bị sửa / xoá / ẩn trên nền tảng (Story 4.4, AD-4): `webhook.route` ánh xạ bình luận `edited` →
// `updateMessageText`, `remove`/`hide` → `markMessageRemoved`, `unhide` → `markMessageUnhidden`. Tìm tin theo
// `(page_id, platform_message_id)` và đổi đúng tin đó — KHÔNG tạo tin mới:
// - Không có tin (sự kiện tới trước lần thêm, hoặc lần thêm đã bị bỏ qua) → `missing`, bên gọi đánh `ignored`.
// - Lặp lại / không đổi gì → `unchanged`, không phát sự kiện (route chạy lại an toàn).
// - Đổi → phát `message.updated` (web làm cũ khung chat + danh sách) trong cùng transaction.
// `deleted` mạnh hơn `hidden`: ẩn sau khi xoá không đổi gì; bỏ ẩn chỉ gỡ `hidden`. Nội dung tin được giữ để chủ shop
// biết khách đã viết gì. Không log nội dung.
import type { MessageRemoval } from '@ottm/shared'
import { and, eq } from 'drizzle-orm'
import type { Db, DbExecutor } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { messages } from './schema.ts'

export interface EditDeps {
  db: Db
  events: EventPublisher
}

export type EditResult = 'updated' | 'unchanged' | 'missing'

interface MessageRef {
  pageId: string
  platformMessageId: string
}

async function lockMessage(tx: DbExecutor, ref: MessageRef) {
  const [row] = await tx
    .select({ id: messages.id, conversationId: messages.conversationId, text: messages.text, editedAt: messages.editedAt, removal: messages.removal })
    .from(messages)
    .where(and(eq(messages.pageId, ref.pageId), eq(messages.platformMessageId, ref.platformMessageId)))
    .for('update')
  return row ?? null
}

/**
 * Nội dung mới của tin. Sự kiện sửa không mang thời điểm sửa → bên gọi truyền lúc nhận webhook; lần sửa cũ hơn lần
 * đã áp (tới lệch thứ tự) bị bỏ qua.
 */
export async function updateMessageText(
  deps: EditDeps,
  input: MessageRef & { text: string | null; editedAt: Date },
): Promise<EditResult> {
  return deps.db.transaction(async (tx) => {
    const msg = await lockMessage(tx, input)
    if (!msg) return 'missing'
    if (msg.text === input.text || (msg.editedAt && msg.editedAt > input.editedAt)) return 'unchanged'
    await tx.update(messages).set({ text: input.text, editedAt: input.editedAt }).where(eq(messages.id, msg.id))
    await deps.events.publishEvent(tx, 'message.updated', { id: msg.id, pageId: input.pageId, conversationId: msg.conversationId })
    return 'updated'
  })
}

/** Tin bị khách xoá (`deleted`) hoặc trang ẩn (`hidden`). */
export async function markMessageRemoved(
  deps: EditDeps,
  input: MessageRef & { removal: MessageRemoval; at: Date },
): Promise<EditResult> {
  return deps.db.transaction(async (tx) => {
    const msg = await lockMessage(tx, input)
    if (!msg) return 'missing'
    if (msg.removal === input.removal || msg.removal === 'deleted') return 'unchanged'
    await tx.update(messages).set({ removal: input.removal, removedAt: input.at }).where(eq(messages.id, msg.id))
    await deps.events.publishEvent(tx, 'message.updated', { id: msg.id, pageId: input.pageId, conversationId: msg.conversationId })
    return 'updated'
  })
}

/** Trang bỏ ẩn bình luận → tin hiện lại. Tin đã bị xoá hoặc chưa ẩn → không đổi. */
export async function markMessageUnhidden(deps: EditDeps, input: MessageRef): Promise<EditResult> {
  return deps.db.transaction(async (tx) => {
    const msg = await lockMessage(tx, input)
    if (!msg) return 'missing'
    if (msg.removal !== 'hidden') return 'unchanged'
    await tx.update(messages).set({ removal: null, removedAt: null }).where(eq(messages.id, msg.id))
    await deps.events.publishEvent(tx, 'message.updated', { id: msg.id, pageId: input.pageId, conversationId: msg.conversationId })
    return 'updated'
  })
}
