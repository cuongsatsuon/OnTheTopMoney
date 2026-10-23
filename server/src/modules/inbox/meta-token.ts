// Lỗi token khi `inbox` gọi Meta (AD-10, AD-5): MỘT chỗ cho mọi lời gọi Meta của `inbox` (gửi tin, tên khách, caption).
// `TOKEN_INVALID` → `connections.markDisconnected` cho trang GIỮ token (IG → Fanpage nguồn), để Fanpage và mọi IG dùng
// chung token cùng chuyển `disconnected` + phát `page.disconnected` (chủ shop thấy "Kết nối lại"). Lỗi khi đánh dấu
// không được che lỗi gốc của job → chỉ log.
import type { Db } from '../../platform/db/index.ts'
import type { EventPublisher } from '../../platform/events/index.ts'
import { markDisconnected, tokenOwnerPageId } from '../connections/index.ts'

export interface TokenInvalidDeps {
  db: Db
  events: EventPublisher
  log?: { warn(obj: Record<string, unknown>, msg: string): void } | undefined
}

export async function reportTokenInvalid(deps: TokenInvalidDeps, pageId: string): Promise<void> {
  try {
    const owner = await tokenOwnerPageId(deps.db, pageId)
    await markDisconnected({ db: deps.db, events: deps.events }, owner)
  } catch (err) {
    deps.log?.warn({ pageId, err }, 'inbox: không đánh dấu được trang mất kết nối sau TOKEN_INVALID')
  }
}
