// Tìm không dấu (Story 4.10, AD-18): helper SQL dùng chung cho `pages.search`, `inbox.searchContacts` và lọc `q` của
// danh sách khách. Dựa vào hai hàm IMMUTABLE tạo ở migration 0021 (kèm index GIN `gin_trgm_ops` trên đúng biểu thức):
// - `search_norm(text)`: `unaccent` (từ điển cố định) rồi `lower(… collate pg_c_utf8)` — "Nguyễn Thu Hà" → "nguyen thu ha";
// - `search_phone(text)`: chỉ chữ số, `84` + 9 số → `0` + 9 số — "+84 912 345 678" → "0912345678".
// Biểu thức trong truy vấn phải trùng biểu thức của index (`search_norm(cột)`) thì planner mới dùng index.
// Từ khoá tìm có thể là SĐT: không log.
import { sql, type AnyColumn, type SQL } from 'drizzle-orm'

export type SearchExpr = AnyColumn | SQL

/** Số từ tối đa của một truy vấn (bỏ phần thừa). */
const MAX_TOKENS = 8
/** Khớp gần đúng (`<%`) chỉ khi truy vấn đủ dài — ngắn hơn thì trigram gần như khớp lung tung. */
const FUZZY_MIN_LENGTH = 4
/** Khớp SĐT khi truy vấn có ít nhất ngần này chữ số. */
const PHONE_MIN_DIGITS = 3

export const searchNorm = (x: SearchExpr | string): SQL => sql`search_norm(${x})`
export const searchPhone = (x: SearchExpr | string): SQL => sql`search_phone(${x})`

export interface SearchTerms {
  /** Truy vấn đã NFC, cắt và gộp khoảng trắng — chưa bỏ dấu (Postgres bỏ bằng `search_norm`). */
  text: string
  /** Từ của truy vấn (tối đa 8), đã thoát ký tự đại diện của LIKE. */
  tokens: string[]
  /** Chữ số đã chuẩn hoá như `search_phone`; rỗng khi ít hơn 3 chữ số. */
  digits: string
}

/** Thoát ký tự đại diện của LIKE (escape mặc định của Postgres là `\`). */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Chữ số của SĐT, cùng luật với hàm SQL `search_phone` (giữ hai bên khớp nhau). */
export function phoneDigits(s: string): string {
  const d = s.replace(/\D/g, '')
  return /^84\d{9}$/.test(d) ? `0${d.slice(2)}` : d
}

/** Tách truy vấn; `null` khi không còn chữ nào (bên gọi trả rỗng). */
export function searchTerms(q: string): SearchTerms | null {
  const text = q.normalize('NFC').trim().replace(/\s+/g, ' ')
  if (!text) return null
  const digits = phoneDigits(text)
  return {
    text,
    tokens: text.split(' ').slice(0, MAX_TOKENS).map(likeEscape),
    digits: digits.length >= PHONE_MIN_DIGITS ? digits : '',
  }
}

/** Mọi từ là chuỗi con của `search_norm(expr)` (không dấu, không phân biệt hoa thường, thứ tự tự do). */
function allTokens(expr: SearchExpr, terms: SearchTerms): SQL {
  const norm = searchNorm(expr)
  return sql`(${sql.join(
    terms.tokens.map((t) => sql`${norm} like ${searchNorm(`%${t}%`)}`),
    sql` and `,
  )})`
}

/** Có dùng khớp gần đúng cho truy vấn này không. */
const fuzzyOn = (terms: SearchTerms, fuzzy: boolean) => fuzzy && terms.text.length >= FUZZY_MIN_LENGTH

/**
 * Điều kiện khớp chữ trên `expr`: mọi từ là chuỗi con; `fuzzy` → thêm khớp gần đúng của cả truy vấn
 * (`word_similarity` ≥ ngưỡng `pg_trgm.word_similarity_threshold`, mặc định 0.6) để chịu lỗi gõ.
 */
export function textMatch(expr: SearchExpr, terms: SearchTerms, options: { fuzzy?: boolean } = {}): SQL {
  if (!fuzzyOn(terms, options.fuzzy ?? false)) return allTokens(expr, terms)
  return sql`(${allTokens(expr, terms)} or ${searchNorm(terms.text)} <% ${searchNorm(expr)})`
}

/**
 * Khoá xếp hạng (đưa thẳng vào `orderBy`, rồi thêm khoá phụ của bên gọi): khớp đủ từ trước khớp gần đúng; trùng hẳn >
 * bắt đầu bằng truy vấn > còn lại; `word_similarity` giảm dần.
 */
export function textRank(expr: SearchExpr, terms: SearchTerms): SQL[] {
  const norm = searchNorm(expr)
  const q = searchNorm(terms.text)
  return [
    sql`case when ${allTokens(expr, terms)} then 0 else 1 end`,
    sql`case when ${norm} = ${q} then 0 when ${norm} like ${searchNorm(`${likeEscape(terms.text)}%`)} then 1 else 2 end`,
    sql`word_similarity(${q}, ${norm}) desc`,
  ]
}

/** SĐT chứa chữ số của truy vấn (sau `search_phone`); `undefined` khi truy vấn ít hơn 3 chữ số. */
export function phoneMatch(expr: SearchExpr, terms: SearchTerms): SQL | undefined {
  if (!terms.digits) return undefined
  return sql`${searchPhone(expr)} like ${`%${terms.digits}%`}`
}
