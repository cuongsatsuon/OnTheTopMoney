// Gợi ý khi nút AI bị khoá vì chưa có khoá OpenAI hợp lệ (UX-DR2): rê chuột, focus hoặc chạm thấy câu
// gợi ý theo trạng thái (vd "Thêm khoá OpenAI ở Cài đặt") kèm liên kết "Mở Cài đặt" tới /cai-dat.
// Nút bị `disabled` không nhận focus/click, nên khi khoá: vỏ bọc nhận focus (role="group", tên = câu gợi ý),
// một lớp phủ trong suốt nhận click/chạm để bật/tắt gợi ý. Esc ẩn gợi ý (chỉ chặn Esc khi gợi ý đang hiện,
// để Esc vẫn đóng Modal/Drawer bao ngoài). Đang tải trạng thái → nút mờ, không hiện gợi ý (tránh nháy).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../lib/app-context'
import { cn } from './ui'

export const AI_LOCK_LINK = 'Mở Cài đặt'
export const SETTINGS_PATH = '/cai-dat'

export function AiLockHint({
  locked,
  children,
  className,
  align = 'center',
  placement = 'top',
}: {
  /** true → bọc nút và hiện gợi ý; false → trả nguyên `children`. */
  locked: boolean
  children: ReactNode
  /** Lớp của vỏ bọc (mặc định `inline-flex`; nút rộng hết khung thì truyền `flex w-full`). */
  className?: string
  align?: 'start' | 'center' | 'end'
  placement?: 'top' | 'bottom'
}) {
  const { aiLock } = useApp()
  const hint = aiLock.hint
  const id = useId()
  const wrapper = useRef<HTMLSpanElement>(null)
  // Hover/focus hiện bằng CSS (`group-hover`, `group-focus-within`); chạm/click ghim gợi ý (`pinned`).
  // Esc ẩn gợi ý tới khi rời chuột / focus lại.
  const [dismissed, setDismissed] = useState(false)
  const [pinned, setPinned] = useState(false)

  // Gợi ý đã ghim: chạm/click ra ngoài thì ẩn.
  useEffect(() => {
    if (!pinned) return
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setPinned(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [pinned])

  if (!locked || !hint) return <>{children}</>

  /** Gợi ý đang hiện? (CSS hover/focus hoặc ghim, và chưa bị Esc ẩn.) */
  const isVisible = () => {
    const el = wrapper.current
    if (!el || dismissed) return false
    return pinned || el.matches(':hover') || el.matches(':focus-within')
  }

  return (
    <span
      ref={wrapper}
      tabIndex={0}
      role="group"
      aria-label={hint}
      aria-describedby={id}
      className={cn('group relative inline-flex rounded-md focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none', className)}
      onFocus={(e) => {
        if (e.target === e.currentTarget) setDismissed(false)
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDismissed(false)
          setPinned(false)
        }
      }}
      onMouseLeave={() => setDismissed(false)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !isVisible()) return
        e.stopPropagation()
        // Focus đang ở liên kết sắp bị ẩn → đưa về vỏ bọc để không mất vị trí focus.
        // (focus trước: onFocus của vỏ bọc đặt lại `dismissed`, lệnh sau cùng thắng)
        if (e.target !== wrapper.current) wrapper.current?.focus()
        setPinned(false)
        setDismissed(true)
      }}
    >
      {children}
      {/* Nhận click/chạm thay cho nút disabled (không phát click). */}
      <span
        aria-hidden
        className="absolute inset-0 cursor-not-allowed"
        onClick={() => {
          wrapper.current?.focus()
          setDismissed(false)
          setPinned((v) => !v)
        }}
      />
      <span
        id={id}
        className={cn(
          'absolute z-40',
          dismissed ? 'hidden' : pinned ? 'block' : 'hidden group-focus-within:block group-hover:block',
          placement === 'top' ? 'bottom-full pb-2' : 'top-full pt-2',
          align === 'start' && 'left-0',
          align === 'center' && 'left-1/2 -translate-x-1/2',
          align === 'end' && 'right-0',
        )}
      >
        <span className="flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-xs font-normal whitespace-nowrap text-white shadow-lg">
          {hint}
          <Link to={SETTINGS_PATH} className="rounded-sm font-semibold text-violet-200 underline underline-offset-2 hover:text-white focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none">
            {AI_LOCK_LINK}
          </Link>
        </span>
      </span>
    </span>
  )
}
