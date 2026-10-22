// Mở kênh realtime cho vùng đã đăng nhập và chia trạng thái kết nối qua context.
import type { ReactNode } from 'react'
import { RealtimeContext, useRealtime } from '../lib/realtime'

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const state = useRealtime()
  return <RealtimeContext.Provider value={state}>{children}</RealtimeContext.Provider>
}
