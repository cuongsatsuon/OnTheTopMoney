// Đọc dòng nhập từ terminal; chế độ ẩn không in ký tự (dùng cho mật khẩu).
// Không phải TTY (pipe, test) → đọc tuần tự từng dòng của stdin.
import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'

let lines: AsyncIterator<string> | undefined

async function readPipedLine(): Promise<string> {
  lines ??= createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]()
  const next = await lines.next()
  if (next.done) throw new Error('Hết dữ liệu nhập')
  return next.value
}

/**
 * Bộ lọc phím cho chế độ ẩn. Giữ trạng thái giữa các chunk: StringDecoder ghép ký tự nhiều byte
 * bị cắt đôi; chuỗi escape (CSI `ESC [ … final`, SS3 `ESC O x`, `ESC x`) bị bỏ trọn vẹn
 * thay vì để lại `[A` khi bấm phím mũi tên.
 */
export class HiddenInput {
  value = ''
  private readonly decoder = new StringDecoder('utf8')
  private esc: 'none' | 'start' | 'csi' | 'ss3' = 'none'

  /** Đưa một chunk vào; trả 'enter' | 'cancel' khi gặp phím kết thúc, ngược lại undefined. */
  feed(chunk: Buffer): 'enter' | 'cancel' | undefined {
    for (const ch of this.decoder.write(chunk)) {
      const code = ch.codePointAt(0)!
      if (this.esc === 'start') {
        this.esc = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'none'
        continue
      }
      if (this.esc === 'csi') {
        if (code >= 0x40 && code <= 0x7e) this.esc = 'none' // byte kết thúc CSI
        continue
      }
      if (this.esc === 'ss3') {
        this.esc = 'none'
        continue
      }
      if (ch === '\u001b') this.esc = 'start'
      else if (ch === '\r' || ch === '\n') return 'enter'
      else if (ch === '\u0003') return 'cancel'
      else if (ch === '\u007f' || ch === '\b') this.value = [...this.value].slice(0, -1).join('')
      else if (code >= 0x20) this.value += ch
    }
    return undefined
  }
}

function readTtyHidden(): Promise<string> {
  const stdin = process.stdin
  const input = new HiddenInput()
  return new Promise((resolve, reject) => {
    const done = (err?: Error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off('data', onData)
      process.stdout.write('\n')
      if (err) reject(err)
      else resolve(input.value)
    }
    const onData = (buf: Buffer) => {
      const result = input.feed(buf)
      if (result === 'enter') done()
      else if (result === 'cancel') done(new Error('Đã huỷ'))
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

export async function promptHidden(label: string): Promise<string> {
  process.stdout.write(label)
  if (!process.stdin.isTTY) {
    const line = await readPipedLine()
    process.stdout.write('\n')
    return line
  }
  return readTtyHidden()
}

export function closePrompt(): void {
  process.stdin.destroy()
}
