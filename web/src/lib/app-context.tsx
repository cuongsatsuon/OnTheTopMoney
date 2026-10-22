import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { groupById, pageById, pages, type Page } from '../data/mock'
import { Toast } from '../components/ui'
import { aiLock as aiLockOf, openAiKeyStatusOf, useOpenAiSettings, type AiKeyState, type AiLock } from './openai'
import { useMe } from './session'

/** Phạm vi: tất cả trang, một nhóm, hoặc một trang (EXPERIENCE.md › Mô hình khái niệm). */
export type Scope = { kind: 'all' } | { kind: 'group'; id: string } | { kind: 'page'; id: string }

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

function loadScope(): Scope {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Scope
  } catch {
    /* bỏ qua */
  }
  return { kind: 'all' }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [scope, setScopeState] = useState<Scope>(loadScope)
  const [toast, setToast] = useState<string | null>(null)
  // Trạng thái khoá OpenAI lấy từ server; `settings.updated` (realtime) vô hiệu hoá query → refetch.
  // Chỉ hỏi khi đã đăng nhập để màn đăng nhập không gọi route cần phiên.
  const me = useMe()
  const openAi = useOpenAiSettings({ enabled: Boolean(me.data) })
  const openAiKeyStatus = openAiKeyStatusOf(openAi)

  const setScope = useCallback((s: Scope) => {
    setScopeState(s)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    } catch {
      /* bỏ qua */
    }
  }, [])

  const value = useMemo<AppState>(() => {
    const scopedPages =
      scope.kind === 'all' ? pages : scope.kind === 'group' ? pages.filter((p) => p.groupId === scope.id) : pages.filter((p) => p.id === scope.id)
    const ids = new Set(scopedPages.map((p) => p.id))
    const scopeLabel =
      scope.kind === 'all' ? 'Tất cả trang' : scope.kind === 'group' ? (groupById(scope.id)?.name ?? '') : pageById(scope.id).name
    return {
      scope,
      setScope,
      scopeLabel,
      scopedPages,
      inScope: (pageIds) => pageIds.some((id) => ids.has(id)),
      notify: setToast,
      openAiKeySet: openAiKeyStatus === 'valid',
      openAiKeyStatus,
      aiLock: aiLockOf(openAiKeyStatus),
    }
  }, [scope, setScope, openAiKeyStatus])

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
