// Story 5.2 — phần thuần của kho kiến thức: nhận dạng loại file bằng magic bytes, đọc zip/docx (chống zip bomb, nén
// store/deflate), giải mã txt (UTF-8 / UTF-16 BOM, từ chối nhị phân), chuẩn hoá văn bản (NFC, khoảng trắng), tên file
// từ header, kiểm bytes trước khi tải lên, ánh xạ lỗi adapter media dùng chung (logo + kho).
import { describe, expect, it } from 'vitest'
import { parseFileNameHeader } from '../src/app/knowledge-items.ts'
import { mediaAppError } from '../src/app/media-errors.ts'
import { detectKnowledgeMime, extractKnowledgeText, validateKnowledgeFile } from '../src/modules/profiles/index.ts'
import { AppError } from '../src/platform/errors/index.ts'
import { decodeText, docxXmlText, normalizeKnowledgeText, readZipEntry, zipEntries } from '../src/modules/profiles/knowledge-files.ts'
import { buildDocx, buildPdf, buildZip } from './helpers/files.ts'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

describe('detectKnowledgeMime', () => {
  it('pdf (kể cả rác trước header ≤1024 byte), docx, txt UTF-8/UTF-16', () => {
    expect(detectKnowledgeMime(buildPdf(['x']))).toBe('application/pdf')
    expect(detectKnowledgeMime(Buffer.concat([Buffer.alloc(100, 0x20), Buffer.from('%PDF-1.7')]))).toBe('application/pdf')
    expect(detectKnowledgeMime(buildDocx(['Xin chào']))).toBe(DOCX)
    expect(detectKnowledgeMime(Buffer.from('﻿Bảng giá: 100.000đ\n'))).toBe('text/plain')
    expect(detectKnowledgeMime(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Giá', 'utf16le').swap16()]))).toBe('text/plain')
  })

  it('từ chối: rỗng, exe, ảnh, xlsx (zip không có word/document.xml), zip hỏng, UTF-8 sai, nhị phân có NUL', () => {
    expect(detectKnowledgeMime(Buffer.alloc(0))).toBeNull()
    expect(detectKnowledgeMime(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBeNull()
    expect(detectKnowledgeMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull()
    expect(detectKnowledgeMime(buildZip([{ name: 'xl/workbook.xml', data: '<x/>' }]))).toBeNull()
    expect(detectKnowledgeMime(buildDocx(['x']).subarray(0, 40))).toBeNull()
    expect(detectKnowledgeMime(Buffer.from([0xc3, 0x28, 0x61]))).toBeNull()
    expect(detectKnowledgeMime(Buffer.from('abc\u0000def'))).toBeNull()
    expect(decodeText(Buffer.from('a\u0001b'))).toBeNull()
  })
})

describe('zip / docx', () => {
  it('đọc mục store và deflate; mục vượt giới hạn giải nén (zip bomb) → null', () => {
    const zip = buildZip([
      { name: 'a.txt', data: 'store', store: true },
      { name: 'b.txt', data: 'deflate '.repeat(100) },
    ])
    const entries = zipEntries(zip)!
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt'])
    expect(readZipEntry(zip, entries[0]!)!.toString()).toBe('store')
    expect(readZipEntry(zip, entries[1]!)!.toString()).toBe('deflate '.repeat(100))
    expect(readZipEntry(zip, { ...entries[1]!, size: 65 * 1024 * 1024 })).toBeNull()
    expect(readZipEntry(zip, { ...entries[1]!, method: 12 })).toBeNull()
  })

  it('docxXmlText: entity, tab, xuống dòng, bảng; bỏ chữ đã xoá (w:delText)', () => {
    const xml =
      '<w:p><w:r><w:t>Giá &amp; phí &#273;&#x1ED3;ng</w:t><w:tab/><w:t xml:space="preserve"> ok</w:t><w:br/><w:t>dòng 2</w:t></w:r></w:p>' +
      '<w:p><w:r><w:delText>đã xoá</w:delText></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    expect(docxXmlText(xml)).toBe('Giá & phí đồng\t ok\ndòng 2\n\nA A2  | B \n')
    expect(normalizeKnowledgeText(docxXmlText(xml))).toBe('Giá & phí đồng ok\ndòng 2\n\nA A2 | B')
  })

  it('docx hỏng (thiếu document.xml) → UNREADABLE; tài liệu trống → NO_TEXT', async () => {
    expect(await extractKnowledgeText(buildZip([{ name: '[Content_Types].xml', data: '<x/>' }]), DOCX)).toEqual({ ok: false, reason: 'UNREADABLE' })
    expect(await extractKnowledgeText(buildDocx(['   ']), DOCX)).toEqual({ ok: false, reason: 'NO_TEXT' })
  })
})

describe('normalizeKnowledgeText', () => {
  it('NFC (dấu tách rời của PDF), CRLF, ký tự điều khiển, khoảng trắng, nhiều dòng trống', () => {
    const decomposed = 'Già cả'
    expect(normalizeKnowledgeText(`  ${decomposed}\r\n\r\n\r\n​dòng\u0007  hai\t  \n`)).toBe('Già cả\n\ndòng hai')
  })
})

describe('validateKnowledgeFile + tên file', () => {
  it('kích thước, loại, khớp MIME khai báo', () => {
    expect(validateKnowledgeFile(buildPdf(['x']), 'application/pdf')).toEqual({ ok: true, mime: 'application/pdf' })
    expect(validateKnowledgeFile(Buffer.alloc(0), 'text/plain')).toEqual({ ok: false, message: 'File tối đa 10 MB' })
    expect(validateKnowledgeFile(buildDocx(['x']), 'application/pdf')).toEqual({ ok: false, message: 'Định dạng file không khớp với đuôi file' })
    expect(validateKnowledgeFile(Buffer.from([0x4d, 0x5a, 0, 1]), 'text/plain')).toEqual({ ok: false, message: 'Chỉ nhận file PDF, DOCX hoặc TXT' })
  })

  it('parseFileNameHeader: giải mã %, bỏ đường dẫn và ký tự điều khiển; thiếu/hỏng/quá dài → AppError dưới ô file', () => {
    expect(parseFileNameHeader(encodeURIComponent('Bảng giá.pdf'))).toBe('Bảng giá.pdf')
    expect(parseFileNameHeader(encodeURIComponent('../../etc/b\u0007ad.txt'))).toBe('bad.txt')
    for (const raw of [undefined, '', '%E0%A4%A', encodeURIComponent('/'), 'a'.repeat(256)]) {
      expect(() => parseFileNameHeader(raw)).toThrow(AppError)
    }
  })
})

describe('mediaAppError (logo + kho kiến thức)', () => {
  const opts = { field: 'file', invalidMessage: 'File không hợp lệ', failCode: 'UPLOAD_FAILED' } as const
  it('ánh xạ đủ mọi MediaErrorKind', () => {
    const cases = [
      ['MEDIA_NOT_CONFIGURED', 500, 'MEDIA_NOT_CONFIGURED'],
      ['INVALID_REQUEST', 400, 'VALIDATION_FAILED'],
      ['RATE_LIMITED', 429, 'RATE_LIMITED'],
      ['AUTH_FAILED', 502, 'UPLOAD_FAILED'],
      ['NOT_FOUND', 502, 'UPLOAD_FAILED'],
      ['TRANSIENT', 502, 'UPLOAD_FAILED'],
    ] as const
    for (const [kind, status, code] of cases) {
      const err = mediaAppError(kind, opts)
      expect([err.statusCode, err.code]).toEqual([status, code])
    }
    expect(mediaAppError('INVALID_REQUEST', opts).details).toEqual([{ path: ['file'], message: 'File không hợp lệ' }])
    expect(mediaAppError('TRANSIENT', { ...opts, failCode: 'IMAGE_FAILED' }).code).toBe('IMAGE_FAILED')
  })
})
