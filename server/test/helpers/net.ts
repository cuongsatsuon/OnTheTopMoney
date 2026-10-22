import net from 'node:net'

/** Cổng TCP đang trống trên 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

/** Server TCP nhận kết nối nhưng không bao giờ trả lời — giả Postgres treo. */
export async function blackholeServer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const srv = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address() as net.AddressInfo
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        srv.close(() => resolve())
      }),
  }
}
