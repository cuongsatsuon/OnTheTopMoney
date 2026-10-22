// Chặn route khi chưa đăng nhập (AD-19). Hook và tiện ích phiên ở `session.ts`.
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { RealtimeProvider } from '../components/RealtimeProvider'
import { ScreenSkeleton } from '../components/Skeleton'
import { Button } from '../components/ui'
import { errorMessageOf } from './error-messages'
import { loginUrl, useMe } from './session'

/**
 * Bọc các route cần phiên: đang tải → skeleton; chưa đăng nhập → `/dang-nhap?next=…`.
 * Đã đăng nhập → mở kênh realtime (SSE) cho mọi màn bên trong.
 */
export function RequireAuth() {
  const me = useMe()
  const location = useLocation()

  if (me.isPending) return <ScreenSkeleton label="Đang kiểm tra phiên đăng nhập…" />
  // Refetch nền lỗi khi đã có dữ liệu cache → giữ app, không thay bằng màn lỗi.
  if (me.isError && me.data === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center" role="alert">
          <p className="text-sm">{errorMessageOf(me.error)}</p>
          <Button className="mt-4" onClick={() => void me.refetch()}>
            Thử lại
          </Button>
        </div>
      </div>
    )
  }
  if (!me.data) {
    return <Navigate to={loginUrl(`${location.pathname}${location.search}${location.hash}`)} replace />
  }
  return (
    <RealtimeProvider>
      <Outlet />
    </RealtimeProvider>
  )
}
