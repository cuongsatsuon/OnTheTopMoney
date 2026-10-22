// Hậu kiểm đầu ra AI (AD-21): hàm DUY NHẤT kiểm chữ AI sinh trước khi gửi / tự đăng / trả cho FE.
// Thuần, xác định (không gọi mạng, không DB): từ cấm của hồ sơ (không phân biệt hoa thường, chuẩn hoá dấu),
// URL ngoài `allowedDomains`, độ dài tối đa theo `kind`. Mọi luồng AI (autoreply, content, campaigns, composer)
// gọi đúng hàm này — không nhân bản luật ở chỗ khác (Boundaries "Never").
import { AI_OUTPUT_MAX_CHARS, type AiOutputKind, type AiViolation } from '@ottm/shared'

/** Phần hồ sơ mà hậu kiểm cần (hồ sơ hiệu lực hoặc hồ sơ nháp). */
export interface CheckBrand {
  bannedWords: readonly string[]
  allowedDomains: readonly string[]
}

export interface CheckOutputResult {
  /** Không vi phạm. */
  clean: boolean
  /** Các cụm vi phạm (từ cấm, URL lạ, quá dài) để FE đánh dấu. Rỗng khi sạch. */
  violations: AiViolation[]
}

/**
 * Chuẩn hoá một ký tự để so khớp không dấu, không phân biệt hoa thường: bỏ dấu kết hợp (NFD) và hạ thường;
 * `đ/Đ → d`. Vietnamese + ASCII luôn cho đúng một ký tự nền → giữ ánh xạ vị trí 1–1 với chuỗi gốc.
 */
function foldChar(ch: string): string {
  return ch
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
}

/**
 * Chuỗi đã chuẩn hoá + mảng `offsets` (vị trí ký tự đã gấp → vị trí ký tự gốc) để trích đúng cụm gốc khi khớp.
 * Duyệt theo code point (`[...text]`) nên emoji / ký tự ngoài BMP không làm lệch vị trí. Mọi khoảng trắng nội bộ
 * (nhiều space / newline / tab) được gom thành MỘT space ở chuỗi gấp để "giảm  giá" khớp "giảm giá".
 */
function fold(text: string): { folded: string; offsets: number[] } {
  let folded = ''
  const offsets: number[] = []
  let origIndex = 0
  let prevSpace = false
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        folded += ' '
        offsets.push(origIndex)
        prevSpace = true
      }
      origIndex += ch.length
      continue
    }
    prevSpace = false
    const f = foldChar(ch)
    for (const _ of f) offsets.push(origIndex)
    folded += f
    origIndex += ch.length
  }
  offsets.push(origIndex) // chốt cuối để map được vị trí kết thúc
  return { folded, offsets }
}

/** Ký tự "chữ" ở chuỗi đã gấp (a–z sau khi bỏ dấu, 0–9). Dùng để chặn khớp từ cấm nằm giữa một chuỗi chữ-số lớn hơn. */
const isFoldedWordChar = (ch: string | undefined): boolean => ch !== undefined && /[a-z0-9]/.test(ch)

/** Trích cụm gốc ứng với [start, end) trong chuỗi đã gấp. */
function sliceOriginal(text: string, offsets: number[], start: number, end: number): string {
  return text.slice(offsets[start] ?? 0, offsets[end] ?? text.length)
}

/**
 * Từ cấm xuất hiện trong text (so khớp đã chuẩn hoá: không dấu, hoa thường, gom khoảng trắng) → một vi phạm mỗi từ
 * cấm (trích cụm gốc ở lần khớp HỢP LỆ đầu tiên). Chỉ khớp khi hai biên không nằm trong một chuỗi chữ-số lớn hơn
 * (vd "giá" KHÔNG khớp "giákhuyến"), nhưng vẫn khớp khi tách bởi khoảng trắng / dấu câu.
 */
function bannedViolations(text: string, folded: string, offsets: number[], banned: readonly string[]): AiViolation[] {
  const out: AiViolation[] = []
  const seen = new Set<string>()
  for (const word of banned) {
    const needle = fold(word.trim()).folded.trim()
    if (!needle || seen.has(needle)) continue
    seen.add(needle)
    let at = folded.indexOf(needle)
    while (at !== -1) {
      const end = at + needle.length
      // Biên: ký tự ngay trước / sau cụm không phải chữ-số → đứng tách, là một vi phạm thực sự.
      if (!isFoldedWordChar(folded[at - 1]) && !isFoldedWordChar(folded[end])) {
        out.push({ kind: 'banned_word', text: sliceOriginal(text, offsets, at, end) })
        break
      }
      at = folded.indexOf(needle, at + 1)
    }
  }
  return out
}

// Cụm giống URL, ba dạng: (1) có scheme http(s):// ...; (2) host nhiều nhãn kết thúc bằng TLD chữ (2–24) +
// đường dẫn tuỳ chọn; (3) IPv4 literal KÈM đường dẫn (vd 1.2.3.4/promo) — tránh nhầm chuỗi số như version.
// [defer] host IDN / unicode (vd shop.vn có dấu, .công-ty) để sau.
const URL_RE =
  /(?:https?:\/\/\S+)|(?:(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d+)?(?:\/[^\s)<>"']*)?)|(?:(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\/[^\s)<>"']*)/gi

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** Host của một cụm URL (bỏ scheme, đường dẫn, cổng, `www.`), đã hạ thường; `null` nếu không phải host hợp lệ. */
function hostOf(token: string): string | null {
  let host = token.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').toLowerCase()
  if (host.startsWith('www.')) host = host.slice(4)
  if (IPV4_RE.test(host)) return host // IP literal (vd http://1.2.3.4/…) vẫn phải nằm trong allowlist
  const labels = host.split('.')
  if (labels.length < 2) return null
  const tld = labels[labels.length - 1]!
  const sld = labels[labels.length - 2]!
  // TLD phải toàn chữ (loại "100.000", "2.5"); nhãn trước TLD phải có ít nhất một chữ (loại "2.5kg").
  if (!/^[a-z]{2,24}$/.test(tld) || !/[a-z]/.test(sld)) return null
  return host
}

/** Host thuộc allowlist khi trùng domain hoặc là tên con của một domain cho phép. */
function isAllowedHost(host: string, allowed: readonly string[]): boolean {
  for (const raw of allowed) {
    const d = raw
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/[/?#].*$/, '')
      .replace(/^www\./i, '')
      .toLowerCase()
    if (!d) continue
    if (host === d || host.endsWith(`.${d}`)) return true
  }
  return false
}

/** URL có host ngoài allowlist (allowlist rỗng → mọi URL là vi phạm) → một vi phạm mỗi cụm gốc (đã lọc trùng). */
function urlViolations(text: string, allowed: readonly string[]): AiViolation[] {
  const out: AiViolation[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(URL_RE)) {
    const token = match[0]
    // Ngay sau '@' = phần domain của địa chỉ email → không phải URL ngoài allowlist.
    if (match.index > 0 && text[match.index - 1] === '@') continue
    const host = hostOf(token)
    if (!host || isAllowedHost(host, allowed)) continue
    const phrase = token.replace(/[.,;:)]+$/, '') // bỏ dấu câu cuối dính vào URL
    if (seen.has(phrase)) continue
    seen.add(phrase)
    out.push({ kind: 'disallowed_url', text: phrase })
  }
  return out
}

/**
 * Hậu kiểm AD-21. Thứ tự vi phạm: từ cấm → URL lạ → quá dài. Trả `{clean, violations}`; caller (composer) trả
 * nguyên văn kèm `violations` cho FE đánh dấu, autoreply/campaigns dùng `clean` để quyết định handoff / chờ duyệt.
 */
export function checkOutput(text: string, opts: { brand: CheckBrand; kind: AiOutputKind }): CheckOutputResult {
  const { brand, kind } = opts
  const { folded, offsets } = fold(text)
  const violations: AiViolation[] = [
    ...bannedViolations(text, folded, offsets, brand.bannedWords),
    ...urlViolations(text, brand.allowedDomains),
  ]
  const length = [...text].length
  const max = AI_OUTPUT_MAX_CHARS[kind]
  if (length > max) violations.push({ kind: 'too_long', text: `${length}/${max}` })
  return { clean: violations.length === 0, violations }
}
