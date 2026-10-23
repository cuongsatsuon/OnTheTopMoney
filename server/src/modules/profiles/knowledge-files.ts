// File kho kiến thức (Story 5.2, AD-14): nhận dạng loại bằng magic bytes + trích văn bản. Thuần (không DB, không
// mạng), chạy được cả trong api (nhận dạng lúc tải lên) lẫn trong thread trích văn bản của worker
// (`knowledge-extract-thread.ts`). pdf đọc bằng `unpdf` (pdf.js gói sẵn, nạp động — api không nạp); docx là zip:
// đọc central directory + `inflateRaw` của Node (không thêm thư viện zip); txt giải mã UTF-8 hoặc UTF-16 có BOM.
// Không log nội dung file.
import { inflateRawSync } from 'node:zlib'

/** Giữ khớp `KNOWLEDGE_FILE_MIMES` của shared (file này không import shared để thread nạp nhẹ). */
export const PDF_MIME = 'application/pdf'
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const TXT_MIME = 'text/plain'
export type KnowledgeFileMime = typeof PDF_MIME | typeof DOCX_MIME | typeof TXT_MIME

/** Lý do trích thất bại — trùng tên `KnowledgeError` của shared. */
export type ExtractFailure = 'UNREADABLE' | 'NO_TEXT' | 'PASSWORD_PROTECTED' | 'EXTRACT_TIMEOUT'
export type ExtractResult = { ok: true; text: string } | { ok: false; reason: ExtractFailure }

/** Giải nén tối đa mỗi phần trong docx (chống zip bomb): `word/document.xml` của tài liệu thật cỡ vài MB. */
const ZIP_ENTRY_MAX_BYTES = 64 * 1024 * 1024
const DOCX_MAIN_PART = 'word/document.xml'

/* ---------- ZIP (đủ cho docx: không zip64, không mã hoá) ---------- */

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localHeaderOffset: number
}

/** Danh sách mục trong central directory; `null` khi không phải zip đọc được (hỏng, zip64, cắt cụt). */
export function zipEntries(buf: Buffer): ZipEntry[] | null {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return null
  // EOCD nằm cuối file, sau nó có thể có comment ≤ 65535 byte.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) return null
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    if (p + 46 + nameLen > buf.length) return null
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localHeaderOffset: buf.readUInt32LE(p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Bytes đã giải nén của một mục; `null` khi hỏng, phương thức nén lạ hoặc vượt giới hạn. */
export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer | null {
  const lh = entry.localHeaderOffset
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) return null
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28)
  const end = start + entry.compressedSize
  if (end > buf.length || entry.size > ZIP_ENTRY_MAX_BYTES) return null
  const data = buf.subarray(start, end)
  if (entry.method === 0) return data
  if (entry.method !== 8) return null
  try {
    return inflateRawSync(data, { maxOutputLength: ZIP_ENTRY_MAX_BYTES })
  } catch {
    return null
  }
}

/* ---------- Nhận dạng loại ---------- */

/** UTF-16 (có BOM) hoặc UTF-8 (BOM tuỳ chọn) không có byte NUL/ký tự điều khiển lạ → chuỗi; còn lại `null`. */
export function decodeText(buf: Buffer): string | null {
  let text: string
  try {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(buf.subarray(2))
    else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(buf.subarray(2))
    else {
      if (buf.includes(0)) return null
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf)
    }
  } catch {
    return null
  }
  // File nhị phân giải mã "may mắn" thành UTF-8 vẫn có nhiều ký tự điều khiển — từ chối.
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(text)) return null
  return text
}

/**
 * Loại file theo nội dung (AD-14: allowlist bằng magic bytes): `%PDF-` trong 1024 byte đầu; zip có
 * `word/document.xml` (docx); văn bản UTF-8/UTF-16. Không khớp → `null` (exe, ảnh, xlsx, zip khác…).
 */
export function detectKnowledgeMime(buf: Buffer): KnowledgeFileMime | null {
  if (buf.length === 0) return null
  if (buf.subarray(0, 1024).includes('%PDF-')) return PDF_MIME
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    return zipEntries(buf)?.some((e) => e.name === DOCX_MAIN_PART) ? DOCX_MIME : null
  }
  return decodeText(buf) !== null ? TXT_MIME : null
}

/* ---------- Trích văn bản ---------- */

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(Number.parseInt(e.slice(2), 16))
    if (e.startsWith('#')) return String.fromCodePoint(Number.parseInt(e.slice(1), 10))
    return XML_ENTITIES[e]!
  })
}

/**
 * Chữ của `word/document.xml`: nối `<w:t>`, xuống dòng ở cuối đoạn/`<w:br/>`, ô bảng ngăn bằng " | ", hết hàng xuống
 * dòng. Bỏ chữ đã xoá trong theo dõi thay đổi (`<w:delText>` không khớp `<w:t>`).
 */
export function docxXmlText(xml: string): string {
  const out: string[] = []
  let cellDepth = 0
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>|<w:tc(?:\s[^>]*)?>|<\/w:tc>|<\/w:tr>|<\/w:p>/g
  for (const m of xml.matchAll(re)) {
    const tag = m[0]
    if (m[1] !== undefined) out.push(decodeXmlEntities(m[1]))
    else if (tag === '<w:tab/>') out.push('\t')
    else if (tag.startsWith('<w:br') || tag.startsWith('<w:cr')) out.push('\n')
    else if (tag.startsWith('<w:tc')) cellDepth++
    else if (tag === '</w:tc>') {
      cellDepth = Math.max(0, cellDepth - 1)
      out.push(' | ')
    } else if (tag === '</w:tr>') {
      // Hết hàng: thay dấu ngăn ô cuối bằng xuống dòng.
      if (out.at(-1) === ' | ') out[out.length - 1] = '\n'
      else out.push('\n')
    }
    else out.push(cellDepth > 0 ? ' ' : '\n')
  }
  return out.join('')
}

/** Chuẩn hoá: NFC (PDF hay tách dấu tiếng Việt), bỏ ký tự điều khiển, gộp khoảng trắng, tối đa một dòng trống. */
export function normalizeKnowledgeText(text: string): string {
  return (
    text
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​﻿]/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

async function pdfText(buf: Buffer): Promise<ExtractResult> {
  const { getDocumentProxy, extractText } = await import('unpdf')
  let doc: Awaited<ReturnType<typeof getDocumentProxy>> | undefined
  try {
    // `verbosity: 0`: pdf.js không in cảnh báo (có thể kèm nội dung) ra console.
    doc = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 })
    const { text } = await extractText(doc, { mergePages: true })
    return { ok: true, text }
  } catch (err) {
    return { ok: false, reason: (err as { name?: unknown } | null)?.name === 'PasswordException' ? 'PASSWORD_PROTECTED' : 'UNREADABLE' }
  } finally {
    // Giải phóng tài nguyên pdf.js (kiểu của unpdf không khai `destroy`, nhưng PDFDocumentProxy có).
    await (doc as { destroy?: () => Promise<void> } | undefined)?.destroy?.().catch(() => {})
  }
}

function docxText(buf: Buffer): ExtractResult {
  const entry = zipEntries(buf)?.find((e) => e.name === DOCX_MAIN_PART)
  const xml = entry ? readZipEntry(buf, entry) : null
  if (!xml) return { ok: false, reason: 'UNREADABLE' }
  return { ok: true, text: docxXmlText(xml.toString('utf8')) }
}

/**
 * Văn bản của file đã nhận dạng (chạy trong thread trích — xem `runExtraction`). Văn bản rỗng sau chuẩn hoá →
 * `NO_TEXT` (vd PDF chỉ có ảnh scan — không OCR).
 */
export async function extractKnowledgeText(buf: Buffer, mime: KnowledgeFileMime): Promise<ExtractResult> {
  let raw: ExtractResult
  if (mime === PDF_MIME) raw = await pdfText(buf)
  else if (mime === DOCX_MIME) raw = docxText(buf)
  else {
    const text = decodeText(buf)
    raw = text === null ? { ok: false, reason: 'UNREADABLE' } : { ok: true, text }
  }
  if (!raw.ok) return raw
  const text = normalizeKnowledgeText(raw.text)
  return text ? { ok: true, text } : { ok: false, reason: 'NO_TEXT' }
}
