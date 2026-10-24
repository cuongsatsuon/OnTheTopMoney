import { PerformanceResponse, type PagePerformanceDto } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import {
  INSUFFICIENT_DATA_TEXT,
  deltaPct,
  emptyPerformance,
  engagementRate,
  formatDay,
  formatMetric,
  formatRate,
  hasSeriesData,
  metricsStateText,
  sortPageRows,
} from './performance'

const row = (pageId: string, over: Partial<PagePerformanceDto> = {}): PagePerformanceDto => ({
  pageId,
  views: null,
  reach: null,
  engagement: null,
  followersDelta: null,
  posts: 0,
  trend: [],
  insufficientData: false,
  metricsState: 'ok',
  missingScopes: [],
  ...over,
})

describe('KPI', () => {
  it('null → "—" không mũi tên; 0 vẫn là số', () => {
    expect(formatMetric(null)).toBe('—')
    expect(formatMetric(0)).toBe('0')
    expect(formatMetric(12345)).toBe((12345).toLocaleString('vi-VN'))
    expect(deltaPct({ current: null, previous: 10 })).toBeUndefined()
    expect(deltaPct({ current: 10, previous: null })).toBeUndefined()
  })

  it('% so kỳ trước chỉ khi kỳ trước > 0; làm tròn 1 chữ số', () => {
    expect(deltaPct({ current: 5, previous: 0 })).toBeUndefined()
    expect(deltaPct({ current: 150, previous: 100 })).toBe(50)
    expect(deltaPct({ current: 2, previous: 3 })).toBe(-33.3)
    expect(deltaPct({ current: 0, previous: 4 })).toBe(-100)
  })

  it('tỉ lệ tương tác = tương tác / tiếp cận; thiếu hoặc tiếp cận 0 → null', () => {
    expect(engagementRate(13, 260)).toBe(5)
    expect(engagementRate(null, 10)).toBeNull()
    expect(engagementRate(5, null)).toBeNull()
    expect(engagementRate(5, 0)).toBeNull()
    expect(formatRate(null)).toBe('—')
    expect(formatRate(4.56)).toBe(`${(4.56).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`)
    expect(emptyPerformance('30d').kpis.engagementRate).toEqual({ current: null, previous: null })
  })
})

describe('bảng trang', () => {
  const rows = [
    row('a', { engagement: 5, reach: 100 }),
    row('b', { engagement: null }),
    row('c', { engagement: 20, reach: 100 }),
    row('d', { engagement: 5, reach: 50 }),
    row('e', { engagement: null }),
  ]

  it('null luôn ở cuối cả hai chiều; bằng nhau giữ thứ tự server', () => {
    expect(sortPageRows(rows, 'engagement', false).map((r) => r.pageId)).toEqual(['c', 'a', 'd', 'b', 'e'])
    expect(sortPageRows(rows, 'engagement', true).map((r) => r.pageId)).toEqual(['a', 'd', 'c', 'b', 'e'])
  })

  it('sắp theo tỉ lệ dẫn xuất', () => {
    expect(sortPageRows(rows, 'rate', false).map((r) => r.pageId)).toEqual(['c', 'd', 'a', 'b', 'e'])
  })

  it('câu trạng thái: thiếu quyền / lỗi / chờ; ổn → không có', () => {
    expect(metricsStateText('permissions_missing')).toBe('Thiếu quyền thống kê')
    expect(metricsStateText('failed')).toBe('Chưa lấy được số liệu')
    expect(metricsStateText('pending')).toBe('Đang chờ số liệu đầu tiên')
    expect(metricsStateText('ok')).toBeNull()
    expect(INSUFFICIENT_DATA_TEXT).toBe('Cần thêm vài ngày dữ liệu')
  })
})

describe('biểu đồ', () => {
  it('có dữ liệu khi một nền tảng hoặc kỳ trước có số; toàn null → không', () => {
    const p = { date: '2026-10-23', facebook: null, instagram: null, threads: null, previous: null }
    expect(hasSeriesData([p, p])).toBe(false)
    expect(hasSeriesData([p, { ...p, threads: 0 }])).toBe(true)
    expect(hasSeriesData([{ ...p, previous: 3 }])).toBe(true)
    expect(formatDay('2026-09-04')).toBe('04/09')
  })

  it('phạm vi chỉ có id kho mẫu → rỗng, đúng schema', () => {
    const empty = emptyPerformance('7d')
    expect(empty).toMatchObject({ range: '7d', platforms: [], pages: [], topPosts: [], series: [], insufficientData: false })
    expect(() => PerformanceResponse.parse({ ...empty, from: '2026-10-17', to: '2026-10-23' })).not.toThrow()
  })
})
