import { describe, expect, it } from 'vitest'
import type { Group, Page } from '../data/mock'
import {
  deriveScopeView,
  effectiveScope,
  intersectsScope,
  matchesQuery,
  normalizeText,
  pagesInScope,
  parseStoredScope,
  scopeExists,
} from './scope'

const page = (id: string, groupId: string | null = null): Page => ({
  id,
  name: id,
  handle: id,
  platform: 'facebook',
  groupId,
  followers: 0,
  status: 'active',
  autoReply: false,
  brandSource: 'own',
  avatarColor: '#000',
})
const group = (id: string): Group => ({ id, name: id, color: '#000', autoReply: false, activeCampaigns: 0 })

describe('normalizeText / matchesQuery (tìm không dấu)', () => {
  it('bỏ dấu, thường hoá, đổi đ→d', () => {
    expect(normalizeText('Mỹ phẩm')).toBe('my pham')
    expect(normalizeText('  Đồ Gia Dụng  ')).toBe('do gia dung')
  })

  it('gõ "my pham" khớp "Mỹ phẩm"; truy vấn có dấu cũng khớp', () => {
    expect(matchesQuery('Mỹ phẩm Lan Anh', 'my pham')).toBe(true)
    expect(matchesQuery('Mỹ phẩm Lan Anh', 'Mỹ phẩm')).toBe(true)
    expect(matchesQuery('Nhóm Gia dụng', 'gia dung')).toBe(true)
  })

  it('không khớp → false; truy vấn rỗng → luôn khớp', () => {
    expect(matchesQuery('Mỹ phẩm', 'thoi trang')).toBe(false)
    expect(matchesQuery('Bất kỳ', '')).toBe(true)
  })
})

describe('parseStoredScope (khôi phục an toàn từ localStorage)', () => {
  it('thiếu / JSON hỏng / sai shape → all', () => {
    expect(parseStoredScope(null)).toEqual({ kind: 'all' })
    expect(parseStoredScope('{khong-phai-json')).toEqual({ kind: 'all' })
    expect(parseStoredScope(JSON.stringify({ kind: 'team', id: 'x' }))).toEqual({ kind: 'all' })
    expect(parseStoredScope(JSON.stringify({ kind: 'group' }))).toEqual({ kind: 'all' })
  })

  it('object hợp lệ → giữ nguyên (id string, hợp cả id kho mẫu)', () => {
    expect(parseStoredScope(JSON.stringify({ kind: 'all' }))).toEqual({ kind: 'all' })
    expect(parseStoredScope(JSON.stringify({ kind: 'group', id: 'g-beauty' }))).toEqual({ kind: 'group', id: 'g-beauty' })
    expect(parseStoredScope(JSON.stringify({ kind: 'page', id: 'p1' }))).toEqual({ kind: 'page', id: 'p1' })
  })
})

describe('scopeExists / effectiveScope (id biến mất → all)', () => {
  const groups = [group('g1')]
  const pages = [page('p1')]

  it('all luôn tồn tại', () => {
    expect(scopeExists({ kind: 'all' }, groups, pages)).toBe(true)
  })

  it('nhóm/trang còn tồn tại → giữ; đã biến mất → về all', () => {
    expect(effectiveScope({ kind: 'group', id: 'g1' }, groups, pages)).toEqual({ kind: 'group', id: 'g1' })
    expect(effectiveScope({ kind: 'page', id: 'p1' }, groups, pages)).toEqual({ kind: 'page', id: 'p1' })
    expect(effectiveScope({ kind: 'group', id: 'da-xoa' }, groups, pages)).toEqual({ kind: 'all' })
    expect(effectiveScope({ kind: 'page', id: 'da-go' }, groups, pages)).toEqual({ kind: 'all' })
  })
})

describe('pagesInScope / intersectsScope (giao tập)', () => {
  const pages = [page('p1', 'g1'), page('p2', 'g1'), page('p3', 'g2'), page('p4', null)]

  it('all → mọi trang; group → trang của nhóm; page → một trang', () => {
    expect(pagesInScope({ kind: 'all' }, pages).map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(pagesInScope({ kind: 'group', id: 'g1' }, pages).map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(pagesInScope({ kind: 'page', id: 'p3' }, pages).map((p) => p.id)).toEqual(['p3'])
  })

  it('thực thể nhiều trang thuộc phạm vi khi tập trang giao tập phạm vi khác rỗng', () => {
    const scoped = new Set(pagesInScope({ kind: 'group', id: 'g1' }, pages).map((p) => p.id))
    expect(intersectsScope(['p2', 'pX'], scoped)).toBe(true) // có p2 trong nhóm
    expect(intersectsScope(['p3', 'p4'], scoped)).toBe(false) // không trang nào trong nhóm
    expect(intersectsScope([], scoped)).toBe(false)
  })
})

describe('deriveScopeView (dẫn xuất giá trị provider, thuần)', () => {
  const groups = [group('g1')]
  const pages = [page('p1', 'g1'), page('p2', null)]

  it('phạm vi hợp lệ → scope/scopedPages/nhãn khớp nhau', () => {
    expect(deriveScopeView({ kind: 'all' }, pages, groups)).toEqual({
      scope: { kind: 'all' },
      scopedPages: pages,
      scopeLabel: 'Tất cả trang',
    })
    const g = deriveScopeView({ kind: 'group', id: 'g1' }, pages, groups)
    expect(g.scope).toEqual({ kind: 'group', id: 'g1' })
    expect(g.scopedPages.map((p) => p.id)).toEqual(['p1'])
    expect(g.scopeLabel).toBe('g1')
    const p = deriveScopeView({ kind: 'page', id: 'p2' }, pages, groups)
    expect(p.scope).toEqual({ kind: 'page', id: 'p2' })
    expect(p.scopeLabel).toBe('p2')
  })

  it('lựa chọn lưu trỏ page/group đã xoá → hạ về all, nhãn không lỗi', () => {
    for (const stale of [{ kind: 'group', id: 'da-xoa' }, { kind: 'page', id: 'da-go' }] as const) {
      const view = deriveScopeView(stale, pages, groups)
      expect(view.scope).toEqual({ kind: 'all' })
      expect(view.scopedPages).toEqual(pages)
      expect(view.scopeLabel).toBe('Tất cả trang')
    }
  })
})
