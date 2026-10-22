// Kênh realtime của api (AD-3): MỘT kết nối `LISTEN realtime`, phát gợi ý tới mọi tab qua SSE.
// - NOTIFY do `platform/events` gửi trong transaction → chỉ tới đây khi commit.
// - Ping `event: ping` mỗi 10 giây (client coi mất kết nối sau 25 giây im lặng).
// - LISTEN rớt: postgres.js tự LISTEN lại; ngoài ra cứ mỗi `probeIntervalMs` tự NOTIFY một gói dò,
//   không nhận lại trong `probeTimeoutMs` → đăng ký LISTEN mới. Mỗi lần nối lại: log `warn` và gửi
//   `event: resync` để client refetch (NOTIFY trong lúc rớt đã mất).
// - Mỗi nhịp ping kiểm lại client bằng `isAlive` (vd phiên còn hạn) — sai thì đóng response.
import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { RealtimeHint, isEventName } from '@ottm/shared'
import type { Sql } from '../db/index.ts'
import { REALTIME_CHANNEL } from '../events/index.ts'
import type { Logger } from '../log/index.ts'

export const SSE_PING_INTERVAL_MS = 10_000
export const SSE_RETRY_MS = 3_000
/** Client chậm đọc tới mức đệm quá ngưỡng này → ngắt (nó sẽ tự nối lại và refetch). */
const MAX_BUFFERED_BYTES = 1_000_000
const PROBE_TYPE = '__probe'

export interface RealtimeHubOptions {
  sql: Sql
  log: Logger
  pingIntervalMs?: number
  probeIntervalMs?: number
  probeTimeoutMs?: number
}

export interface RealtimeHub {
  /** Mở LISTEN và bắt đầu ping/dò. Gọi một lần trước khi nhận client. */
  start(): Promise<void>
  /**
   * Gắn một response SSE đã ghi header; trả hàm gỡ. Tự gỡ khi kết nối đóng. `isAlive` chạy mỗi nhịp
   * ping, trả false → đóng response. Hub đã đóng → đóng response ngay.
   */
  addClient(res: ServerResponse, isAlive?: () => Promise<boolean>): () => void
  /** Đóng mọi stream SSE (để server dừng được) và bỏ LISTEN. */
  close(): Promise<void>
  readonly clientCount: number
}

export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function createRealtimeHub(options: RealtimeHubOptions): RealtimeHub {
  const { sql, log } = options
  const pingIntervalMs = options.pingIntervalMs ?? SSE_PING_INTERVAL_MS
  const probeIntervalMs = options.probeIntervalMs ?? 30_000
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000

  const clients = new Map<ServerResponse, (() => Promise<boolean>) | undefined>()
  let generation = 0
  let unlisten: (() => Promise<void>) | undefined
  let pingTimer: NodeJS.Timeout | undefined
  let probeTimer: NodeJS.Timeout | undefined
  let pendingProbe: { nonce: string; resolve: () => void } | undefined
  let closed = false
  let relistening = false

  function write(res: ServerResponse, frame: string): void {
    if (res.writableEnded || res.destroyed) {
      clients.delete(res)
      return
    }
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      log.warn({ buffered: res.writableLength }, 'SSE client đọc quá chậm — ngắt')
      clients.delete(res)
      res.destroy()
      return
    }
    res.write(frame)
  }

  function broadcast(frame: string): void {
    for (const res of clients.keys()) write(res, frame)
  }

  /** Ping + kiểm lại từng client (phiên hết hạn / đăng xuất → đóng stream). */
  function tick(): void {
    broadcast(sseFrame('ping', {}))
    for (const [res, isAlive] of clients) {
      if (!isAlive) continue
      isAlive().then(
        (alive) => {
          if (alive || !clients.has(res)) return
          clients.delete(res)
          res.end()
        },
        (err: unknown) => log.warn({ err }, 'không kiểm lại được client SSE — giữ kết nối'),
      )
    }
  }

  function onNotify(gen: number, raw: string): void {
    if (gen !== generation) return // listener của lần đăng ký cũ (postgres.js tự LISTEN lại) — bỏ
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      log.warn('NOTIFY realtime không phải JSON — bỏ qua')
      return
    }
    if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === PROBE_TYPE) {
      const nonce = (data as { nonce?: unknown }).nonce
      if (pendingProbe && pendingProbe.nonce === nonce) pendingProbe.resolve()
      return
    }
    const hint = RealtimeHint.safeParse(data)
    if (!hint.success || !isEventName(hint.data.type)) {
      log.warn('NOTIFY realtime sai định dạng — bỏ qua')
      return
    }
    broadcast(sseFrame(hint.data.type, hint.data))
  }

  async function listen(): Promise<void> {
    const gen = ++generation
    let listens = 0
    const handle = await sql.listen(
      REALTIME_CHANNEL,
      (raw) => onNotify(gen, raw),
      () => {
        listens += 1
        // Lần gọi thứ hai trở đi của cùng một đăng ký = postgres.js vừa LISTEN lại sau khi kết nối rớt.
        if (listens > 1 && gen === generation && !closed) reconnected('postgres.js')
      },
    )
    unlisten = handle.unlisten
  }

  function reconnected(how: string): void {
    log.warn({ how }, 'LISTEN realtime đã nối lại — gửi resync cho client')
    broadcast(sseFrame('resync', {}))
  }

  async function relisten(): Promise<void> {
    if (relistening || closed) return
    relistening = true
    try {
      const old = unlisten
      // LISTEN mới trước (generation mới, listener cũ bị bỏ qua), rồi mới gỡ cái cũ: tránh UNLISTEN
      // tới sau LISTEN làm mất đăng ký. Không chờ: trên kết nối đã chết lệnh UNLISTEN có thể treo.
      await listen()
      old?.().catch(() => {})
      reconnected('probe')
    } catch (err) {
      log.warn({ err }, 'LISTEN realtime chưa nối lại được — thử lại ở lần dò sau')
    } finally {
      relistening = false
    }
  }

  async function probe(): Promise<void> {
    // Một gói dò mỗi lúc: hai gói chồng nhau sẽ dùng chung `pendingProbe` và kết luận sai.
    if (closed || relistening || pendingProbe) return
    const nonce = randomUUID()
    let resolveReceived!: (ok: boolean) => void
    const received = new Promise<boolean>((resolve) => {
      resolveReceived = resolve
    })
    pendingProbe = { nonce, resolve: () => resolveReceived(true) }
    try {
      await sql`select pg_notify(${REALTIME_CHANNEL}, ${JSON.stringify({ type: PROBE_TYPE, nonce })})`
    } catch (err) {
      // DB không tới được: không kết luận gì về LISTEN, lần dò sau thử lại.
      pendingProbe = undefined
      log.warn({ err }, 'không gửi được gói dò realtime')
      return
    }
    // Hẹn giờ chỉ bắt đầu khi NOTIFY đã commit — pg_notify chậm không bị tính là LISTEN chết.
    const timer = setTimeout(() => resolveReceived(false), probeTimeoutMs)
    const ok = await received
    clearTimeout(timer)
    pendingProbe = undefined
    if (!ok && !closed) {
      log.warn('LISTEN realtime không nhận gói dò — đăng ký lại')
      await relisten()
    }
  }

  return {
    get clientCount() {
      return clients.size
    },

    async start() {
      await listen()
      pingTimer = setInterval(tick, pingIntervalMs)
      pingTimer.unref()
      probeTimer = setInterval(() => void probe(), probeIntervalMs)
      probeTimer.unref()
    },

    addClient(res, isAlive) {
      if (closed) {
        res.end()
        return () => {}
      }
      clients.set(res, isAlive)
      const remove = () => {
        clients.delete(res)
      }
      res.on('close', remove)
      return remove
    },

    async close() {
      closed = true
      clearInterval(pingTimer)
      clearInterval(probeTimer)
      for (const res of clients.keys()) res.end()
      clients.clear()
      await unlisten?.().catch(() => {})
      unlisten = undefined
    },
  }
}
