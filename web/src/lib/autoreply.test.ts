// Helper thuần của cấu hình AI trả lời (Story 5.1): map DTO ↔ form, luật bật dùng chung với server, lỗi dưới ô,
// chữ xác nhận/kết quả Bật/Tắt hàng loạt, nhãn cây và chép `autoReply` dẫn xuất vào kho mẫu.
import { DEFAULT_HANDOFF_MESSAGE, SaveAutoreplyConfigRequest, type AutoreplyConfigDto } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import type { Group, Page } from '../data/mock'
import { ApiError } from './api'
import {
  BRAND_MISSING_MESSAGE,
  autoReplyFieldErrorsOf,
  autoReplyIssuesOf,
  autoReplyOf,
  blankAutoReply,
  bulkConfirmText,
  bulkResultMessage,
  mirrorAutoreplyOverview,
  scriptTemplateErrorMessage,
  toSaveAutoreplyRequest,
  treePageLabel,
} from './autoreply'

const UUID = '018f3e2a-7c1d-7a2b-9c3d-4e5f60718293'
const UUID2 = '018f3e2a-7c1d-7a2b-9c3d-4e5f60718294'

const DTO: AutoreplyConfigDto = {
  ownerType: 'group',
  ownerId: UUID,
  enabled: true,
  schedule: 'offhours',
  hours: Array.from({ length: 7 }, (_, i) => ({ on: i < 5, from: '08:00', to: '18:00' })),
  script: 'Bạn là nhân viên bán hàng.',
  handoffKeywords: ['đổi trả'],
  handoffOnCustomerAsk: false,
  handoffOnUncertain: true,
  handoffMessage: 'Shop chuyển nhân viên ạ',
  channels: ['messenger', 'comment_public'],
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
}

describe('map DTO ↔ form', () => {
  it('chưa có cấu hình → mặc định: tắt, luôn bật, kênh tin nhắn + bình luận công khai, câu chuyển tiếp mặc định', () => {
    const f = autoReplyOf(null)
    expect(f).toEqual(blankAutoReply())
    expect(f.enabled).toBe(false)
    expect(f.channels).toEqual({ messenger: true, ig_direct: true, comment_public: true, comment_private: false })
    expect(f.ranges.map((r) => r.day)).toEqual(['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'])
    expect(f.handoffMessage).toBe(DEFAULT_HANDOFF_MESSAGE)
  })

  it('DTO → form → request giữ đúng giá trị và hợp lệ theo schema server', () => {
    const req = toSaveAutoreplyRequest(autoReplyOf(DTO))
    expect(req).toEqual({
      enabled: true,
      schedule: 'offhours',
      hours: DTO.hours,
      script: DTO.script,
      handoffKeywords: ['đổi trả'],
      handoffOnCustomerAsk: false,
      handoffOnUncertain: true,
      handoffMessage: 'Shop chuyển nhân viên ạ',
      channels: ['messenger', 'comment_public'],
    })
    expect(SaveAutoreplyConfigRequest.safeParse(req).success).toBe(true)
  })
})

describe('luật bật (cùng luật server)', () => {
  it('bật với kịch bản trống / không kênh / tuỳ chỉnh không ngày nào → lỗi đúng ô', () => {
    const base = { ...blankAutoReply(), enabled: true, prompt: '  ' }
    expect(autoReplyIssuesOf(base).script).toBeTruthy()
    const noChannel = { ...base, prompt: 'Kịch bản', channels: { messenger: false, ig_direct: false, comment_public: false, comment_private: false } }
    expect(autoReplyIssuesOf(noChannel)).toEqual({ channels: expect.any(String) })
    const noDay = { ...base, prompt: 'Kịch bản', schedule: 'custom' as const, ranges: base.ranges.map((r) => ({ ...r, on: false })) }
    expect(autoReplyIssuesOf(noDay)).toEqual({ hours: expect.any(String) })
  })

  it('đang tắt → không bắt kịch bản/kênh; câu chuyển tiếp trống luôn lỗi', () => {
    expect(autoReplyIssuesOf({ ...blankAutoReply(), prompt: '' })).toEqual({})
    expect(autoReplyIssuesOf({ ...blankAutoReply(), handoffMessage: ' ' })).toEqual({ handoffMessage: expect.any(String) })
  })
})

describe('lỗi server → dưới ô', () => {
  it('VALIDATION_FAILED details theo path → ô tương ứng', () => {
    const err = new ApiError('VALIDATION_FAILED', 400, 'x', [
      { path: ['script'], message: 'Viết kịch bản trước khi bật AI.' },
      { path: ['channels'], message: 'Chọn kênh' },
      { path: ['hours', 0, 'to'], message: 'Giờ sai' },
    ])
    expect(autoReplyFieldErrorsOf(err)).toEqual({ script: 'Viết kịch bản trước khi bật AI.', channels: 'Chọn kênh', hours: 'Giờ sai' })
  })

  it('mã khác hoặc lỗi lạ → {}', () => {
    expect(autoReplyFieldErrorsOf(new ApiError('INTERNAL', 500, 'x'))).toEqual({})
    expect(autoReplyFieldErrorsOf(new Error('x'))).toEqual({})
  })

  it('template thiếu hồ sơ → câu riêng; lỗi khác → bản đồ chung', () => {
    expect(scriptTemplateErrorMessage(new ApiError('CONFIG_MISSING', 422, 'x'))).toBe(BRAND_MISSING_MESSAGE)
    expect(scriptTemplateErrorMessage(new ApiError('NOT_FOUND', 404, 'x'))).toMatch(/Không tìm thấy/)
  })
})

describe('Bật/Tắt hàng loạt', () => {
  const following = { mode: 'group' as const, configured: true, enabled: true }

  it('xác nhận nêu số trang theo nhóm sẽ chuyển sang cấu hình riêng (chỉ trang cần đổi)', () => {
    const t = bulkConfirmText(
      [
        { name: 'A', status: following },
        { name: 'B', status: following },
        { name: 'C', status: { mode: 'own', configured: true, enabled: true } },
      ],
      false,
    )
    expect(t.title).toBe('Tắt AI trả lời?')
    expect(t.body).toContain('3 trang')
    expect(t.body).toContain('2 trang đang theo cấu hình nhóm sẽ chuyển sang cấu hình AI riêng')
    expect(t.confirmLabel).toBe('Tắt AI trả lời')
  })

  it('trang theo nhóm đã đúng trạng thái → không nhắc chuyển riêng; một trang → nêu tên', () => {
    const t = bulkConfirmText([{ name: 'minhphat.store', status: following }], true)
    expect(t.body).toBe('Bật AI trả lời tự động cho “minhphat.store”.')
    expect(bulkConfirmText([{ name: 'X', status: following }], false).body).toContain('Trang này đang theo cấu hình nhóm')
  })

  it('kết quả: số trang đã đổi + lý do theo mã', () => {
    const msg = bulkResultMessage(
      { updated: [UUID], unchanged: [UUID2], failed: [{ pageId: UUID, code: 'CONFIG_MISSING' }, { pageId: UUID2, code: 'VALIDATION_FAILED' }] },
      true,
    )
    expect(msg).toBe('Đã bật AI trả lời cho 2 trang. 1 trang chưa bật được: chưa có cấu hình AI. 1 trang chưa bật được: cấu hình chưa đủ (kịch bản hoặc kênh).')
  })
})

describe('cây và kho mẫu', () => {
  it('nhãn cây: Theo nhóm / Riêng · Bật / Riêng · Tắt', () => {
    expect(treePageLabel({ mode: 'group', enabled: true })).toBe('Theo nhóm')
    expect(treePageLabel({ mode: 'own', enabled: true })).toBe('Riêng · Bật')
    expect(treePageLabel({ mode: 'own', enabled: false })).toBe('Riêng · Tắt')
  })

  it('chép autoReply dẫn xuất vào kho mẫu, không đụng trang/nhóm mẫu', () => {
    const page = (id: string): Page => ({ id, name: id, handle: id, platform: 'facebook', groupId: null, followers: 0, status: 'active', autoReply: false, brandSource: 'own', avatarColor: '#000' })
    const pages = [page(UUID), page('p1')]
    const groups: Group[] = [{ id: UUID2, name: 'G', color: '#000', autoReply: false, activeCampaigns: 0 }]
    mirrorAutoreplyOverview(
      { groups: [{ groupId: UUID2, configured: true, enabled: true }], pages: [{ pageId: UUID, groupId: null, mode: 'own', configured: true, enabled: true }] },
      pages,
      groups,
    )
    expect(pages[0]!.autoReply).toBe(true)
    expect(pages[1]!.autoReply).toBe(false)
    expect(groups[0]!.autoReply).toBe(true)
  })
})
