import type { Notification } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import { applyMarkRead, markItemsRead, pickToasts, toastText } from './notifications'

let seq = 0
function n(overrides: Partial<Notification> = {}): Notification {
  seq += 1
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    type: 'ai_handoff',
    title: `T${seq}`,
    body: '',
    entity: 'conversation',
    entityId: 'c',
    pageId: null,
    readAt: null,
    createdAt: '2026-10-22T00:00:00.000Z',
    ...overrides,
  }
}

describe('pickToasts', () => {
  it('mục mới toast đúng một lần; mục đã thấy không toast lại', () => {
    const old = n()
    let seen = new Set([old.id])
    const fresh = n()
    const first = pickToasts([fresh, old], seen)
    expect(first.toast).toEqual([fresh])
    seen = first.seen
    expect(pickToasts([fresh, old], seen).toast).toEqual([])
  })

  it('createdAt lệch thứ tự / cùng mili giây vẫn toast (so theo id, không theo thời gian)', () => {
    const seenItem = n({ createdAt: '2026-10-22T10:00:00.000Z' })
    const sameMs = n({ createdAt: '2026-10-22T10:00:00.000Z' })
    const older = n({ createdAt: '2026-10-22T09:00:00.000Z' }) // commit muộn hơn nhưng now() sớm hơn
    const { toast } = pickToasts([sameMs, seenItem, older], new Set([seenItem.id]))
    expect(toast.map((x) => x.id)).toEqual([sameMs.id, older.id])
  })

  it('không toast mục đã đọc (vd đọc ở tab khác)', () => {
    const read = n({ readAt: '2026-10-22T00:00:01.000Z' })
    expect(pickToasts([read], new Set()).toast).toEqual([])
  })

  it('chưa có mốc (seen = null) → chỉ toast mục chưa đọc mới nhất, còn lại coi như đã thấy', () => {
    const [a, b] = [n(), n()]
    const { toast, seen } = pickToasts([a, b], null)
    expect(toast).toEqual([a])
    expect([...seen].sort()).toEqual([a.id, b.id].sort())
  })

  it('giới hạn số id đã thấy, bỏ id cũ nhất trước', () => {
    const items = [n(), n(), n()]
    const { seen } = pickToasts(items, new Set(['x1', 'x2']), 3)
    expect([...seen]).toEqual(items.map((i) => i.id))
  })
})

describe('markItemsRead (cập nhật cache sau POST /notifications/read)', () => {
  const now = '2026-10-22T01:00:00.000Z'
  it('{ids} → chỉ các mục đó; mục khác giữ chưa đọc', () => {
    const [a, b] = [n(), n()]
    const out = markItemsRead([a, b], { ids: [a.id] }, now)
    expect(out.map((x) => x.readAt)).toEqual([now, null])
  })

  it('{all} → mọi mục chưa đọc; mục đã đọc giữ nguyên thời điểm cũ', () => {
    const a = n()
    const b = n({ readAt: '2026-10-21T00:00:00.000Z' })
    expect(markItemsRead([a, b], { all: true }, now).map((x) => x.readAt)).toEqual([now, '2026-10-21T00:00:00.000Z'])
  })
})

describe('applyMarkRead (cache danh sách)', () => {
  it('unreadCount lấy từ server, không đếm lại trên trang (còn mục chưa đọc ngoài trang / mới tới)', () => {
    const [a, b] = [n(), n()]
    const next = applyMarkRead({ items: [a, b], nextCursor: 'x', unreadCount: 9 }, { ids: [a.id] }, 4, '2026-10-22T01:00:00.000Z')
    expect(next.unreadCount).toBe(4)
    expect(next.nextCursor).toBe('x')
    expect(next.items.map((x) => x.readAt === null)).toEqual([false, true])
  })
})

describe('toastText', () => {
  it('một thông báo → tiêu đề; nhiều → kèm số còn lại; rỗng → null', () => {
    const [a, b, c] = [n({ title: 'A' }), n({ title: 'B' }), n({ title: 'C' })]
    expect(toastText([a])).toBe('A')
    expect(toastText([a, b, c])).toBe('A (và 2 thông báo khác)')
    expect(toastText([])).toBeNull()
  })
})
