// Dựng file mẫu cho test kho kiến thức (Story 5.2) — không cần file nhị phân trong repo.
// - `buildPdf(lines)`: PDF 1 trang, font Helvetica chuẩn, xref đúng offset (pdf.js đọc không cần sửa).
// - `buildZip(entries)` / `buildDocx(paragraphs)`: zip nén deflate (store khi `store: true`) bằng zlib của Node.
import { deflateRawSync } from 'node:zlib'

/** PDF tối giản; `lines` là chữ Latin (WinAnsi). `encrypt: true` thêm từ điển `/Encrypt` (pdf.js đòi mật khẩu). */
export function buildPdf(lines: readonly string[], opts: { encrypt?: boolean; noText?: boolean } = {}): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)
  const content = opts.noText ? '0 0 m 100 100 l S' : `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  if (opts.encrypt) objs.push('<< /Filter /Standard /V 1 /R 2 /O (0123456789abcdef0123456789abcdef) /U (0123456789abcdef0123456789abcdef) /P -4 >>')
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  const encrypt = opts.encrypt ? ` /Encrypt ${objs.length} 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]` : ''
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${encrypt} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

export function buildZip(entries: readonly { name: string; data: Buffer | string; store?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const body = e.store ? raw : deflateRawSync(raw)
    const name = Buffer.from(e.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(e.store ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(e.store ? 0 : 8, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** docx tối giản: `[Content_Types].xml` + `word/document.xml`; mỗi phần tử một đoạn, mảng con = một hàng bảng. */
export function buildDocx(blocks: readonly (string | string[])[]): Buffer {
  const body = blocks
    .map((b) =>
      typeof b === 'string'
        ? `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(b)}</w:t></w:r></w:p>`
        : `<w:tbl><w:tr>${b.map((c) => `<w:tc><w:p><w:r><w:t>${xmlEscape(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr></w:tbl>`,
    )
    .join('')
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  return buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: doc },
  ])
}
