import { AiBudgetSummary } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import { BUDGET_TOAST_80, budgetToneOf, budgetView, categoryRows, formatVnd, thresholdToast } from './ai-budget'
import { ERROR_MESSAGES, errorMessageOf } from './error-messages'

const summary = (patch: Partial<AiBudgetSummary> = {}): AiBudgetSummary =>
  AiBudgetSummary.parse({
    month: '2026-10',
    limitVnd: 1_000_000,
    spentVnd: 312_000,
    reservedVnd: 0,
    percent: 31,
    state: 'ok',
    warn80: true,
    byCategory: [
      { category: 'reply', costVnd: 148_000, count: 912 },
      { category: 'content', costVnd: 61_000, count: 214 },
      { category: 'image', costVnd: 103_000, count: 52 },
    ],
    ...patch,
  })

describe('budgetView (chip sidebar / banner)', () => {
  it('ok → bình thường, không chữ trạng thái, không banner', () => {
    expect(budgetView(summary())).toEqual({ percent: 31, barPercent: 31, tone: 'normal', status: null, banner: false, usedText: '312.000đ / 1.000.000đ' })
  })
  it('warn → chip vàng có chữ, không banner', () => {
    expect(budgetView(summary({ spentVnd: 850_000, percent: 85, state: 'warn' }))).toMatchObject({ tone: 'warn', status: 'Sắp chạm hạn mức', banner: false })
  })
  it('blocked → chip đỏ + banner; thanh không vượt 100%', () => {
    expect(budgetView(summary({ spentVnd: 1_050_000, percent: 105, state: 'blocked' }))).toMatchObject({
      percent: 105,
      barPercent: 100,
      tone: 'blocked',
      status: 'Đã hết hạn mức',
      banner: true,
      usedText: '1.050.000đ / 1.000.000đ',
    })
  })
  it('đã ≥80% nhưng tắt cảnh báo (server trả ok) → không chip vàng', () => {
    expect(budgetView(summary({ spentVnd: 900_000, percent: 90, state: 'ok', warn80: false }))).toMatchObject({ tone: 'normal', status: null })
  })
})

describe('thresholdToast', () => {
  it('chỉ toast khi warn; blocked đã có banner; ok (vừa tăng hạn mức) thì thôi', () => {
    expect(thresholdToast(summary({ state: 'warn' }))).toBe(BUDGET_TOAST_80)
    expect(thresholdToast(summary({ state: 'blocked' }))).toBeNull()
    expect(thresholdToast(summary({ state: 'ok' }))).toBeNull()
  })
})

describe('categoryRows (bảng chi phí theo hạng mục)', () => {
  it('nhãn tiếng Việt, số lượng có đơn vị, tỉ trọng theo tổng', () => {
    const rows = categoryRows(summary())
    expect(rows.map((r) => [r.label, r.amount, r.costVnd])).toEqual([
      ['Trả lời tin nhắn', '912 tin', 148_000],
      ['Sinh bài viết', '214 lượt', 61_000],
      ['Sinh ảnh', '52 ảnh', 103_000],
    ])
    expect(rows.reduce((n, r) => n + r.share, 0)).toBeCloseTo(100)
    expect(rows[0]!.share).toBeCloseTo((148_000 / 312_000) * 100)
  })
  it('chưa có chi phí → tỉ trọng 0, không chia cho 0', () => {
    const rows = categoryRows(summary({ spentVnd: 0, byCategory: [{ category: 'reply', costVnd: 0, count: 0 }] }))
    expect(rows).toEqual([{ category: 'reply', label: 'Trả lời tin nhắn', amount: '0 tin', costVnd: 0, share: 0 }])
  })
})

it('formatVnd', () => {
  expect(formatVnd(1_234_567)).toBe('1.234.567đ')
})

describe('budgetToneOf (màu % ở Cài đặt, cùng luật với chip)', () => {
  it('tính cả công tắc 80%', () => {
    expect(budgetToneOf({ spentVnd: 850, limitVnd: 1_000, warn80: true })).toBe('warn')
    expect(budgetToneOf({ spentVnd: 850, limitVnd: 1_000, warn80: false })).toBe('normal')
    expect(budgetToneOf({ spentVnd: 1_000, limitVnd: 1_000, warn80: false })).toBe('blocked')
  })
})

describe('AI_BUDGET_EXCEEDED microcopy', () => {
  it('còn hạn mức nhưng không đủ cho thao tác → nói rõ còn bao nhiêu; hết hẳn → câu chung', () => {
    const partial = new ApiError('AI_BUDGET_EXCEEDED', 402, 'x', { remainingVnd: 90_000, estimateVnd: 130_000 })
    expect(errorMessageOf(partial)).toBe('Hạn mức AI còn lại không đủ cho thao tác này (còn 90.000đ) — Tăng hạn mức ở Cài đặt.')
    const none = new ApiError('AI_BUDGET_EXCEEDED', 402, 'x', { remainingVnd: 0, estimateVnd: 100 })
    expect(errorMessageOf(none)).toBe(ERROR_MESSAGES.AI_BUDGET_EXCEEDED)
    expect(errorMessageOf(new ApiError('AI_BUDGET_EXCEEDED', 402, 'x'))).toBe(ERROR_MESSAGES.AI_BUDGET_EXCEEDED)
  })
})
