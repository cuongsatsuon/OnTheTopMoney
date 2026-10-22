import { describe, expect, it } from 'vitest'
import { HiddenInput } from '../scripts/lib/prompt.ts'

describe('scripts/lib/prompt — HiddenInput', () => {
  it('ghép ký tự nhiều byte bị cắt giữa hai chunk', () => {
    const input = new HiddenInput()
    const bytes = Buffer.from('ặb', 'utf8') // 'ặ' = 3 byte
    expect(input.feed(bytes.subarray(0, 2))).toBeUndefined()
    expect(input.feed(bytes.subarray(2))).toBeUndefined()
    expect(input.feed(Buffer.from('\r'))).toBe('enter')
    expect(input.value).toBe('ặb')
  })

  it('bỏ trọn chuỗi escape (mũi tên, CSI có tham số, SS3), kể cả khi bị cắt giữa chunk', () => {
    const input = new HiddenInput()
    input.feed(Buffer.from('a\u001b[A\u001b'))
    input.feed(Buffer.from('[1;5Cb\u001bOPc'))
    expect(input.feed(Buffer.from('\n'))).toBe('enter')
    expect(input.value).toBe('abc')
  })

  it('backspace xoá một ký tự, Ctrl-C huỷ', () => {
    const input = new HiddenInput()
    input.feed(Buffer.from('abđ\u007f'))
    expect(input.value).toBe('ab')
    expect(input.feed(Buffer.from('\u0003'))).toBe('cancel')
  })
})
