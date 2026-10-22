import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { ALL_SCOPE, type Scope } from '@ottm/shared'
import { groups, pages, type Page } from '../data/mock'
import { Toast } from '../components/ui'
import { usePages } from './connections'
import { useGroups } from './groups'
import { aiLock as aiLockOf, openAiKeyStatusOf, useOpenAiSettings, type AiKeyState, type AiLock } from './openai'
import { deriveScopeView, parseStoredScope } from './scope'
import { useMe } from './session'

/** Phạm vi: tất cả trang, một nhóm, hoặc một trang (EXPERIENCE.md › Mô hình khái niệm). Kiểu dùng chung ở `@ottm/shared`. */
export type { Scope }

interface AppState {
  scope: Scope
  setScope: (s: Scope) => void
  scopeLabel: string
  scopedPages: Page[]
  inScope: (pageIds: string[]) => boolean
  notify: (msg: string) => void
  /** Có khoá OpenAI hợp lệ (trạng thái từ server). Đang tải / lỗi / khoá sai → false (nút AI mờ). */
  openAiKeySet: boolean
  /** `loading` khi chưa có phản hồi đầu tiên, `error` khi tải lỗi mà chưa có dữ liệu. */
  openAiKeyStatus: AiKeyState
  /** Khoá nút AI + câu gợi ý (AiLockHint dùng). */
  aiLock: AiLock
}

const AppContext = createContext<AppState | null>(null)

const STORAGE_KEY = 'ottm.scope'

/**
 * Lựa chọn đã nhớ (chỉ kiểm shape; id đã biến mất hạ về `all` ở `deriveScopeView` khi đã có danh sách).
 * `parseStoredScope` không ném — try/catch chỉ để chắn `localStorage.getItem` (có thể ném ở chế độ riêng tư).
 */
function loadScope(): Scope {
  try {
    return parseStoredScope(localStorage.getItem(STORAGE_KEY))
  } catch {
    return ALL_SCOPE
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [scope, setScopeState] = useState<Scope>(loadScope)
  const [toast, setToast] = useState<string | null>(null)
  // Trạng thái khoá OpenAI lấy từ server; `settings.updated` (realtime) vô hiệu hoá query → refetch.
  // Chỉ hỏi khi đã đăng nhập để màn đăng nhập không gọi route cần phiên.
  const me = useMe()
  const authed = Boolean(me.data)
  const openAi = useOpenAiSettings({ enabled: authed })
  const openAiKeyStatus = openAiKeyStatusOf(openAi)
  // Danh sách trang/nhóm thật (đã chép vào kho mẫu) cho bộ chọn phạm vi và khôi phục an toàn; chỉ hỏi khi đã
  // đăng nhập. `.data` đưa vào deps để `useMemo` tính lại phạm vi sau khi danh sách cập nhật.
  const pagesQuery = usePages({ enabled: authed })
  const groupsQuery = useGroups({ enabled: authed })

  const setScope = useCallback((s: Scope) => {
    setScopeState(s)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    } catch {
      /* bỏ qua */
    }
  }, [])

  const value = useMemo<AppState>(() => {
    // Lựa chọn cũ trỏ tới trang/nhóm đã biến mất → về `all` (dữ liệu không bị lọc rỗng); nhãn luôn khớp scope.
    const { scope: eff, scopedPages, scopeLabel } = deriveScopeView(scope, pages, groups)
    const ids = new Set(scopedPages.map((p) => p.id))
    return {
      scope: eff,
      setScope,
      scopeLabel,
      scopedPages,
      inScope: (pageIds) => pageIds.some((id) => ids.has(id)),
      notify: setToast,
      openAiKeySet: openAiKeyStatus === 'valid',
      openAiKeyStatus,
      aiLock: aiLockOf(openAiKeyStatus),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pages`/`groups` là kho mẫu bị biến đổi tại chỗ; `*.data` là tín hiệu đã cập nhật.
  }, [scope, setScope, openAiKeyStatus, pagesQuery.data, groupsQuery.data])

  return (
    <AppContext.Provider value={value}>
      {children}
      <Toast message={toast} onDone={() => setToast(null)} />
    </AppContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}
