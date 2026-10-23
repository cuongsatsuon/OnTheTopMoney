// Module `autoreply` (AD-1, AD-16): AI trả lời tự động. Public API chỉ export từ file này.
// Gọi: `inbox` (áp quyết định), `profiles`, `ai` (Epic 5). Chỉ entrypoint (worker) gọi module này.
// Story 4.3: chỉ có bước triage (luôn `AI_OFF` → `human` tới khi Epic 5 có cấu hình AI).
export const MODULE = 'autoreply'

export { decideTriage, handleTriageEvent, type TriageDeps, type TriageOutcome } from './triage.ts'
