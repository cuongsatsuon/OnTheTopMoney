// Bảng lệnh ⌘K / Ctrl+K (Story 4.10, EXPERIENCE › Interaction Primitives): tìm trang, nhóm, khách (gõ không dấu vẫn ra —
// server so khớp) và chạy lệnh FE "Tạo bài viết", "Đổi phạm vi". ↑/↓ chọn, ↵ mở, Esc đóng; chọn kết quả thì mở đúng chỗ
// (`itemHref`). Trang luôn kèm icon nền tảng + nhãn chữ. Helper thuần ở `lib/search.ts`.
import { GROUP_COLOR_HEX } from '@ottm/shared'
import { ArrowRight, Layers, PenSquare, Search } from 'lucide-react'
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { pages as pageStore } from '../data/mock'
import { CONTACT_STAGE_LABEL, avatarColorOf } from '../lib/contacts'
import { errorMessageOf } from '../lib/error-messages'
import { contactLabel } from '../lib/inbox'
import { SECTION_LABEL, itemHref, moveActive, paletteItems, useSearch, type PaletteItem } from '../lib/search'
import { Avatar, PlatformIcon, cn, platformLabel } from './ui'

/** Chờ người dùng ngừng gõ một nhịp rồi mới gọi API. */
const DEBOUNCE_MS = 150

function useDebounced<T>(value: T, ms = DEBOUNCE_MS): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

export function CommandPalette({ open, onClose, onChangeScope }: { open: boolean; onClose: () => void; onChangeScope: () => void }) {
  if (!open) return null
  return <PaletteDialog onClose={onClose} onChangeScope={onChangeScope} />
}

/** Thân hộp thoại — gắn lại mỗi lần mở nên truy vấn và mục chọn luôn bắt đầu trống. */
function PaletteDialog({ onClose, onChangeScope }: { onClose: () => void; onChangeScope: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState(0)
  const q = useDebounced(query)
  const search = useSearch(q)
  const items = paletteItems(query, query.trim() ? search.data : undefined)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const typing = query.trim() !== ''
  // Kết quả tới sau có thể ngắn hơn → kẹp vào cuối danh sách.
  const active = Math.min(picked, items.length - 1)
  // Mục đang chọn luôn nằm trong vùng nhìn thấy khi đi bằng ↑/↓.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (item: PaletteItem | undefined) => {
    if (!item) return
    onClose()
    const href = itemHref(item)
    if (href) navigate(href)
    else onChangeScope()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setPicked(moveActive(active, e.key === 'ArrowDown' ? 1 : -1, items.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(items[active])
    } else if (e.key === 'Escape') {
      // Chặn để ngăn kéo / hộp thoại bên dưới (nghe Esc ở `window`) không đóng theo.
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  // Trạng thái phần kết quả tìm (lệnh luôn hiện, kể cả khi API lỗi).
  const waiting = typing && (q !== query || (search.isFetching && !search.data))
  const results = items.filter((i) => i.kind !== 'command').length
  let status: ReactNode = null
  if (!typing) status = 'Gõ tên trang, nhóm, khách hàng hoặc số điện thoại — không cần dấu.'
  else if (search.isError) status = <span className="text-danger">{errorMessageOf(search.error)}</span>
  else if (waiting) status = 'Đang tìm…'
  else if (results === 0) status = `Không tìm thấy trang, nhóm hay khách nào khớp “${query.trim()}”.`

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/30 p-4 pt-[12vh]" onClick={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-lg bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal aria-label="Tìm nhanh">
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search size={17} className="shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPicked(0) // truy vấn đổi → về mục đầu
            }}
            onKeyDown={onKeyDown}
            placeholder="Tìm trang, nhóm, khách hàng hoặc gõ lệnh…"
            className="h-12 flex-1 bg-transparent text-sm focus:outline-none"
            role="combobox"
            aria-expanded={true}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
            aria-label="Tìm nhanh"
          />
          <kbd className="rounded border border-border px-1.5 text-[11px] text-muted-foreground">Esc</kbd>
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Kết quả" className="max-h-[60vh] overflow-y-auto p-2">
          {items.map((item, i) => (
            <Fragment key={`${item.kind}:${item.id}`}>
              {item.kind !== items[i - 1]?.kind && (
                <div className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase" aria-hidden>
                  {SECTION_LABEL[item.kind]}
                </div>
              )}
              <div
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => i !== active && setPicked(i)}
                onClick={() => run(item)}
                className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm', i === active && 'bg-primary-soft/60')}
              >
                <ItemBody item={item} />
                {i === active && <ArrowRight size={14} className="ml-auto shrink-0 text-muted-foreground" aria-hidden />}
              </div>
            </Fragment>
          ))}
          {status && (
            <p className="px-2 py-3 text-[13px] text-muted-foreground" role="status">
              {status}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function ItemBody({ item }: { item: PaletteItem }) {
  switch (item.kind) {
    case 'command':
      return (
        <>
          {item.id === 'create-post' ? <PenSquare size={16} className="text-muted-foreground" aria-hidden /> : <Layers size={16} className="text-muted-foreground" aria-hidden />}
          <span>{item.label}</span>
        </>
      )
    case 'page':
      return (
        <>
          <PlatformIcon platform={item.page.platform} size={18} />
          <span className="truncate">{item.page.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{platformLabel[item.page.platform]}</span>
        </>
      )
    case 'group':
      return (
        <>
          <span className="ml-1 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: GROUP_COLOR_HEX[item.group.color] }} aria-hidden />
          <span className="ml-1 truncate">{item.group.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{item.group.pageCount} trang</span>
        </>
      )
    case 'contact': {
      const c = item.contact
      const platform = pageStore.find((p) => p.id === c.pageIds[0])?.platform
      const name = contactLabel(c, platform)
      return (
        <>
          <Avatar name={name} color={avatarColorOf(c.id)} size={22} />
          <span className="truncate">{name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{[c.phone, CONTACT_STAGE_LABEL[c.stage]].filter(Boolean).join(' · ')}</span>
        </>
      )
    }
  }
}
