// Skeleton dùng chung khi đang tải (EXPERIENCE.md: skeleton đúng bố cục ở mọi màn).
import { cn } from './ui'

/** Khối xám nhấp nháy; đặt kích thước bằng className (h-8 w-56, rounded-lg…). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-slate-200', className)} />
}

/** Bố cục chung của một màn trong AppShell: tiêu đề, hàng KPI, khối nội dung. */
export function ScreenSkeleton({ label = 'Đang tải…' }: { label?: string }) {
  return (
    <div className="mx-auto max-w-[1440px] space-y-4 p-6" aria-busy="true" role="status">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-8 w-56" />
      <div className="grid grid-cols-4 gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-lg" />
    </div>
  )
}
