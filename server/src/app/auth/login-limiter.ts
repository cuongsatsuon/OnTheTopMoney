// Bộ đếm đăng nhập sai theo IP, cửa sổ trượt (AD-19: 5 lần / 15 phút / IP).
// Để trong bộ nhớ vì chỉ có một bản api; khởi động lại thì bộ đếm về 0 (chấp nhận được).

export const LOGIN_MAX_FAILURES = 5
export const LOGIN_WINDOW_MS = 15 * 60_000
const SWEEP_ABOVE = 1_000

export class LoginLimiter {
  private readonly failures = new Map<string, number[]>()
  private readonly max: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options: { max?: number; windowMs?: number; now?: () => number } = {}) {
    this.max = options.max ?? LOGIN_MAX_FAILURES
    this.windowMs = options.windowMs ?? LOGIN_WINDOW_MS
    this.now = options.now ?? Date.now
  }

  /** Số lần sai còn trong cửa sổ của IP (đồng thời bỏ mốc cũ). */
  private recent(ip: string): number[] {
    const cutoff = this.now() - this.windowMs
    const list = (this.failures.get(ip) ?? []).filter((t) => t > cutoff)
    if (list.length) this.failures.set(ip, list)
    else this.failures.delete(ip)
    return list
  }

  /** true khi IP đã sai đủ `max` lần trong cửa sổ — chặn cả mật khẩu đúng. */
  isBlocked(ip: string): boolean {
    return this.recent(ip).length >= this.max
  }

  /**
   * Ghi một lần thử (gọi TRƯỚC khi verify để request song song thấy ngay); trả số lần trong cửa sổ.
   * Đăng nhập đúng thì `reset` xoá bộ đếm.
   */
  recordAttempt(ip: string): number {
    const list = this.recent(ip)
    list.push(this.now())
    this.failures.set(ip, list)
    if (this.failures.size > SWEEP_ABOVE) this.sweep()
    return list.length
  }

  /** Đăng nhập đúng → xoá bộ đếm của IP. */
  reset(ip: string): void {
    this.failures.delete(ip)
  }

  private sweep(): void {
    // Xoá mục trong lúc duyệt Map là an toàn.
    for (const ip of this.failures.keys()) this.recent(ip)
  }
}
