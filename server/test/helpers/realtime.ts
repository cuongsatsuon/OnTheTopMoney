import type { Sql } from '../../src/platform/db/index.ts'
import { REALTIME_CHANNEL } from '../../src/platform/events/index.ts'

/** Chờ tới khi `check` trả giá trị truthy (hoặc hết giờ → ném lỗi). */
export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 3_000, stepMs = 25): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`waitFor: hết ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Nghe kênh NOTIFY `realtime`, gom payload đã parse (bỏ gói dò của hub). */
export async function listenRealtime(sql: Sql): Promise<{ messages: Record<string, unknown>[]; stop(): Promise<void> }> {
  const messages: Record<string, unknown>[] = []
  const { unlisten } = await sql.listen(REALTIME_CHANNEL, (raw) => {
    const data = JSON.parse(raw) as Record<string, unknown>
    if (data.type !== '__probe') messages.push(data)
  })
  return { messages, stop: () => unlisten() }
}
