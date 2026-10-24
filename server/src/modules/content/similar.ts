// Ý tưởng cho "Tạo bài tương tự" (Story 8.4, UX F5 b4): tóm caption đã đăng thành vài câu chữ thường. Thuần, xác định,
// KHÔNG gọi AI (AC: chưa gọi AI tới khi chủ shop bấm "Tạo bằng AI"). Bỏ những thứ Soạn bài tự thêm theo hồ sơ (hashtag,
// link, emoji) và ký tự vô hình; giữ trọn câu để không mất giá / ưu đãi giữa chừng. Chủ shop thấy và sửa ý tưởng trước
// khi gửi AI; mẫu prompt Soạn bài coi ý tưởng là dữ liệu (`ai/prompts/compose.ts`).

/** Độ dài tối đa của ý tưởng (code point) [ASSUMPTION]: đủ sản phẩm + ưu đãi + thời gian, xa dưới `POST_TOPIC_MAX`. */
export const SIMILAR_IDEA_MAX = 300

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/u
/** Liên kết; dấu câu dính cuối (`shop.vn/abc.`) thuộc câu, không thuộc link. */
const LINK = /(?:https?:\/\/|www\.)\S*[^\s.,!?…:;)"'»]/giu
/** Hashtag / mention: `#` / `@` ở đầu từ (email `a@b.vn` không khớp vì `@` đứng sau chữ). */
const TAG = /(^|[^\p{L}\p{M}\p{N}_])[#@][\p{L}\p{M}\p{N}_]+/gu
/** Emoji: hình, cờ, tông da, keycap, variation selector (ZWJ thuộc nhóm vô hình bên dưới). */
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0E}|\u{FE0F}|\u{20E3}/gu
/** Ký tự định dạng vô hình (ZWSP, ZWJ, đảo chiều RLO…, BOM, gạch nối mềm). */
const INVISIBLE = /\p{Cf}/gu
const CONTROL = /\p{Cc}/gu
/** Ký hiệu gạch đầu dòng: dấu chấm tròn / mũi tên (dính chữ cũng bỏ); gạch / sao / cộng chỉ khi theo sau là khoảng trắng (giữ "-20%"). */
const BULLET = /^(?:[•·▪►→●◦]+\s*|[-–—*+>]+\s+)/u
const HAS_TEXT = /[\p{L}\p{N}]/u
const ENDS_CLAUSE = /[.!?…:;,]$/u
const SENTENCE_SPLIT = /(?<=[.!?…])\s+/u

/** Một dòng caption → chữ thường (rỗng khi chỉ còn ký hiệu / dấu câu). */
function cleanLine(line: string): string {
  const text = line
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(LINK, ' ')
    .replace(TAG, '$1')
    .replace(EMOJI, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(BULLET, '')
    .replace(/\s+([.,!?…:;])/gu, '$1')
    .trim()
  return HAS_TEXT.test(text) ? text : ''
}

/** Cắt theo câu cho vừa `max` code point; câu đầu đã quá dài → cắt ở khoảng trắng cuối cùng trước giới hạn + `…`. */
function fitSentences(text: string, max: number): string {
  if ([...text].length <= max) return text
  let out = ''
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    const next = out ? `${out} ${sentence}` : sentence
    if ([...next].length > max) break
    out = next
  }
  if (out) return out
  const head = [...text].slice(0, max - 1).join('')
  const space = head.lastIndexOf(' ')
  const cut = space > max / 2 ? head.slice(0, space) : head
  return `${cut.replace(/[\s.,!?…:;]+$/u, '')}…`
}

/** Ý tưởng tóm từ caption gốc; không còn chữ (caption rỗng / chỉ hashtag, emoji, link) → `null`. */
export function similarIdea(caption: string, max = SIMILAR_IDEA_MAX): string | null {
  const lines = caption
    .split(LINE_BREAK)
    .map(cleanLine)
    .filter(Boolean)
    .map((l) => (ENDS_CLAUSE.test(l) ? l : `${l}.`))
  if (!lines.length) return null
  return fitSentences(lines.join(' '), max)
}
