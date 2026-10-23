// Màn chào 4 bước phía web (Story 5.7, UX Flow 7): đọc `GET /onboarding` (4 cờ bước + tin AI đã gửi gần nhất), không
// lưu tiến độ ở client. Khoá `['onboarding']` — realtime `page.*`, `settings.updated`, `openai_key.invalidated`,
// `message.*` làm cũ (lib/realtime.ts). Helper thuần (bước, pha, khoá nút, đường dẫn, chuyển tới màn chào) tách để test.
import { OnboardingStatusResponse, type OnboardingAiReply, type OnboardingSteps, type PageDto, type Platform } from '@ottm/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './api'

export const ONBOARDING_KEY = ['onboarding'] as const
export const WELCOME_PATH = '/bat-dau'

export function useOnboardingStatus() {
  return useQuery({
    queryKey: ONBOARDING_KEY,
    queryFn: ({ signal }) => apiFetch('/onboarding', { schema: OnboardingStatusResponse, signal }),
  })
}

/** Thứ tự 4 bước trên màn chào. */
export const STEP_ORDER = ['pageConnected', 'openAiKeyValid', 'brandProfile', 'autoreplyEnabled'] as const satisfies readonly (keyof OnboardingSteps)[]
export type StepKey = (typeof STEP_ORDER)[number]

export function doneCount(steps: OnboardingSteps): number {
  return STEP_ORDER.filter((k) => steps[k]).length
}

/** Bước chưa xong đầu tiên (viền nổi bật); `null` khi đủ 4 bước. */
export function activeStep(steps: OnboardingSteps): StepKey | null {
  return STEP_ORDER.find((k) => !steps[k]) ?? null
}

/**
 * Pha của màn chào: còn bước chưa xong → `setup`; đủ 4 bước, AI chưa gửi tin nào → `waiting` ("Đang chờ tin đầu
 * tiên"); đủ 4 bước và đã có tin AI → `climax`. Có tin AI mà thiếu bước (vd đã tắt AI) vẫn là `setup`.
 */
export type WelcomePhase = 'setup' | 'waiting' | 'climax'

export function welcomePhase(status: OnboardingStatusResponse | undefined): WelcomePhase {
  if (!status || activeStep(status.steps) !== null) return 'setup'
  return status.lastAiReply ? 'climax' : 'waiting'
}

/** Lý do nút của bước 3–4 bị khoá (hiện ở tooltip); `null` = bấm được. */
export function stepLock(step: 'brandProfile' | 'autoreplyEnabled', steps: OnboardingSteps): string | null {
  if (!steps.pageConnected) return 'Kết nối trang ở bước 1 trước'
  if (step === 'autoreplyEnabled' && !steps.openAiKeyValid) return 'Thêm khoá OpenAI ở bước 2'
  return null
}

/** Fanpage trước (cao trào là khách nhắn Fanpage), rồi Instagram, rồi Threads. */
const SETUP_PLATFORM_ORDER: readonly Platform[] = ['facebook', 'instagram', 'threads']

/** Trang để điền hồ sơ và bật AI ở bước 3–4; `null` khi chưa có trang. */
export function setupPageId(pages: readonly Pick<PageDto, 'id' | 'platform'>[]): string | null {
  for (const platform of SETUP_PLATFORM_ORDER) {
    const page = pages.find((p) => p.platform === platform)
    if (page) return page.id
  }
  return pages[0]?.id ?? null
}

/** Bước 3: Chi tiết trang (tab Hồ sơ thương hiệu là tab mặc định); chưa có trang → Trang & Nhóm. */
export function brandProfilePath(pageId: string | null): string {
  return pageId ? `/trang-nhom/trang/${pageId}` : '/trang-nhom'
}

/** Bước 4: màn AI trả lời tự động, chọn sẵn trang. */
export function autoreplyPath(pageId: string | null): string {
  return pageId ? `/ai-tra-loi?muc=page:${pageId}` : '/ai-tra-loi'
}

/** Cao trào dẫn vào đúng hội thoại AI vừa trả lời ở Hộp thư. */
export function inboxPathOf(reply: Pick<OnboardingAiReply, 'conversationId'>): string {
  return `/hop-thu?c=${encodeURIComponent(reply.conversationId)}`
}

/**
 * Mở app khi chưa có trang nào → chuyển tới màn chào. Chỉ ở `/` (deep link như callback `/trang-nhom?ket-noi=…` hay
 * `/cai-dat` giữ nguyên), chỉ khi danh sách trang thật đã tải xong (`pages` khác `undefined`) và rỗng, và màn chào chưa
 * mở lần nào trong lần tải app này (để "Bỏ qua, vào bảng điều khiển" vào được Tổng quan).
 */
export function shouldOpenWelcome(input: { pathname: string; pages: readonly unknown[] | undefined; opened: boolean }): boolean {
  return input.pathname === '/' && input.pages !== undefined && input.pages.length === 0 && !input.opened
}

/** Màn chào đã mở trong lần tải app này (bộ nhớ của tab — tải lại trang thì tính lại). */
let welcomeOpened = false

export function markWelcomeOpened(): void {
  welcomeOpened = true
}

export function welcomeOpenedThisLoad(): boolean {
  return welcomeOpened
}
