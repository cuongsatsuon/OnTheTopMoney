// Helper thuần của kho kiến thức (Story 5.2): MIME theo đuôi, kiểm file trước khi gửi, chữ từng dòng theo trạng thái,
// mức dùng token, câu lỗi; khoá query bị realtime `knowledge_item.processed` làm cũ; lỗi lưu bật dưới mục kho.
import type { KnowledgeItemDto } from '@ottm/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch } from './api'
import { autoReplyFieldErrorsOf, bulkResultMessage } from './autoreply'
import {
  KNOWLEDGE_TOO_LARGE_MESSAGE,
  knowledgeErrorMessage,
  knowledgeFileIssue,
  knowledgeItemLine,
  knowledgeKey,
  knowledgeMimeOf,
  knowledgeUsage,
} from './knowledge'
import { hintInvalidates } from './realtime'

const UUID = '018f3e2a-7c1d-7a2b-9c3d-4e5f60718293'

const item = (patch: Partial<KnowledgeItemDto>): KnowledgeItemDto => ({
  id: UUID,
  ownerType: 'group',
  ownerId: UUID,
  kind: 'file',
  title: 'Bảng giá.pdf',
  answer: null,
  status: 'ready',
  tokenCount: 3200,
  errorCode: null,
  fileMime: 'application/pdf',
  fileBytes: 245_760,
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
  ...patch,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('file trước khi gửi', () => {
  it('MIME theo đuôi (không phân biệt hoa thường); loại khác → null', () => {
    expect(knowledgeMimeOf('Bảng giá.PDF')).toBe('application/pdf')
    expect(knowledgeMimeOf('chinh-sach.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(knowledgeMimeOf('faq.txt')).toBe('text/plain')
    expect(knowledgeMimeOf('gia.xlsx')).toBeNull()
    expect(knowledgeMimeOf('khongduoi')).toBeNull()
  })

  it('kiểm loại, rỗng, quá 10 MB', () => {
    expect(knowledgeFileIssue({ name: 'a.pdf', size: 1000 })).toBeNull()
    expect(knowledgeFileIssue({ name: 'a.csv', size: 1000 })).toBe('Chỉ nhận file PDF, DOCX hoặc TXT.')
    expect(knowledgeFileIssue({ name: 'a.txt', size: 0 })).toBe('File đang trống.')
    expect(knowledgeFileIssue({ name: 'a.pdf', size: 10 * 1024 * 1024 + 1 })).toMatch(/tối đa 10 MB/)
  })

  it('apiFetch gửi nguyên bytes với Content-Type và header riêng', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const blob = new Blob(['%PDF-1.4'])
    await apiFetch('/knowledge-items/group/x/files', { method: 'POST', raw: { data: blob, contentType: 'application/pdf', headers: { 'x-file-name': 'B%E1%BA%A3ng.pdf' } } })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBe(blob)
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/pdf', 'x-file-name': 'B%E1%BA%A3ng.pdf', Accept: 'application/json' })
  })
})

describe('dòng kho kiến thức', () => {
  it('FAQ hiện câu trả lời; file ready hiện loại · kích thước · token', () => {
    expect(knowledgeItemLine(item({ kind: 'faq', title: 'Phí giao hàng?', answer: 'Nội thành miễn phí.', fileMime: null, fileBytes: null }))).toEqual({
      text: 'Nội thành miễn phí.',
      tone: 'normal',
    })
    expect(knowledgeItemLine(item({}))).toEqual({ text: 'PDF · 240 KB · ~3.200 token', tone: 'normal' })
  })

  it('đang đọc / lỗi theo lý do / quá lớn', () => {
    expect(knowledgeItemLine(item({ status: 'processing', tokenCount: null }))).toEqual({ text: 'PDF · 240 KB · AI đang đọc nội dung…', tone: 'busy' })
    expect(knowledgeItemLine(item({ status: 'failed', tokenCount: null, errorCode: 'PASSWORD_PROTECTED' })).text).toBe('PDF · 240 KB · File có mật khẩu. Bỏ mật khẩu rồi tải lại.')
    expect(knowledgeItemLine(item({ status: 'failed', tokenCount: null, errorCode: 'NO_TEXT' })).tone).toBe('danger')
    const big = knowledgeItemLine(item({ status: 'too_large', tokenCount: 52_000, errorCode: 'KNOWLEDGE_TOO_LARGE', fileBytes: 3 * 1024 * 1024 }))
    expect(big).toEqual({ text: 'PDF · 3 MB · ~52.000 token · Vượt giới hạn kho kiến thức. Rút gọn file hoặc xoá bớt mục khác rồi tải lại.', tone: 'warning' })
  })

  it('mức dùng token: dưới / vượt giới hạn', () => {
    expect(knowledgeUsage({ readyTokens: 12_300, maxTokens: 40_000 })).toEqual({ text: 'Đang dùng ~12.300 token / 40.000', over: false, ratio: 12_300 / 40_000 })
    expect(knowledgeUsage({ readyTokens: 40_001, maxTokens: 40_000 })).toMatchObject({ over: true, ratio: 1 })
  })
})

describe('lỗi', () => {
  it('thêm mục: vượt khi đang bật / lỗi dưới ô / mã khác', () => {
    expect(knowledgeErrorMessage(new ApiError('KNOWLEDGE_TOO_LARGE', 422, 'x'))).toMatch(/vượt giới hạn/)
    expect(knowledgeErrorMessage(new ApiError('VALIDATION_FAILED', 400, 'x', [{ path: ['file'], message: 'File tối đa 10 MB' }]))).toBe('File tối đa 10 MB.')
    expect(knowledgeErrorMessage(new ApiError('UPLOAD_FAILED', 502, 'x'))).toBe('Tải file lên chưa được. Thử lại sau ít phút.')
  })

  it('lưu bật khi kho vượt → lỗi dưới mục Kho kiến thức; hàng loạt nêu lý do', () => {
    expect(autoReplyFieldErrorsOf(new ApiError('KNOWLEDGE_TOO_LARGE', 422, 'x'))).toEqual({ knowledge: KNOWLEDGE_TOO_LARGE_MESSAGE })
    expect(KNOWLEDGE_TOO_LARGE_MESSAGE).toMatch(/rút gọn kho kiến thức/)
    expect(bulkResultMessage({ updated: [], unchanged: [], failed: [{ pageId: UUID, code: 'KNOWLEDGE_TOO_LARGE' }] }, true)).toBe(
      '1 trang chưa bật được: kho kiến thức vượt giới hạn.',
    )
  })

  it('realtime knowledge_item.processed làm cũ khoá kho kiến thức', () => {
    expect(hintInvalidates(knowledgeKey({ ownerType: 'group', ownerId: UUID })[0], 'knowledge_item')).toBe(true)
  })
})
