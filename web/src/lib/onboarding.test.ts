// Story 5.7 — helper thuần của Màn chào 4 bước: số bước xong, bước đang làm, pha chờ / cao trào, khoá nút bước 3–4,
// trang dùng cho bước 3–4, đường dẫn, điều kiện chuyển tới màn chào, làm cũ realtime.
import type { OnboardingStatusResponse, OnboardingSteps } from '@ottm/shared'
import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_KEY,
  activeStep,
  autoreplyPath,
  brandProfilePath,
  doneCount,
  inboxPathOf,
  markWelcomeOpened,
  setupPageId,
  shouldOpenWelcome,
  stepLock,
  welcomeOpenedThisLoad,
  welcomePhase,
} from './onboarding'
import { hintInvalidates } from './realtime'
import { WEBHOOK_HEALTH_KEY } from './webhooks'

const NONE: OnboardingSteps = { pageConnected: false, openAiKeyValid: false, brandProfile: false, autoreplyEnabled: false }
const ALL: OnboardingSteps = { pageConnected: true, openAiKeyValid: true, brandProfile: true, autoreplyEnabled: true }
const REPLY = { conversationId: '0199c0de-0000-7000-8000-000000000001', pageId: '0199c0de-0000-7000-8000-000000000002', sentAt: '2026-10-24T03:05:00.000Z' }
const status = (steps: OnboardingSteps, withReply = false): OnboardingStatusResponse => ({ steps, lastAiReply: withReply ? REPLY : null })

describe('doneCount / activeStep', () => {
  it('đếm bước xong; bước đang làm là bước chưa xong đầu tiên', () => {
    expect(doneCount(NONE)).toBe(0)
    expect(activeStep(NONE)).toBe('pageConnected')
    const two = { ...NONE, pageConnected: true, openAiKeyValid: true }
    expect(doneCount(two)).toBe(2)
    expect(activeStep(two)).toBe('brandProfile')
    // Bước sau xong trước bước trước (vd đã có khoá từ Cài đặt) → vẫn chỉ bước chưa xong đầu tiên.
    expect(activeStep({ ...NONE, openAiKeyValid: true })).toBe('pageConnected')
  })

  it('đủ 4 bước → 4/4, không bước nào đang làm', () => {
    expect(doneCount(ALL)).toBe(4)
    expect(activeStep(ALL)).toBeNull()
  })
})

describe('welcomePhase', () => {
  it('chưa tải / thiếu bước → setup; thiếu bước mà đã có tin AI vẫn setup', () => {
    expect(welcomePhase(undefined)).toBe('setup')
    expect(welcomePhase(status({ ...ALL, autoreplyEnabled: false }))).toBe('setup')
    expect(welcomePhase(status({ ...ALL, autoreplyEnabled: false }, true))).toBe('setup')
  })

  it('đủ 4 bước: chưa có tin AI → waiting; có tin AI → climax', () => {
    expect(welcomePhase(status(ALL))).toBe('waiting')
    expect(welcomePhase(status(ALL, true))).toBe('climax')
  })
})

describe('stepLock', () => {
  it('chưa có trang → khoá bước 3 và 4', () => {
    expect(stepLock('brandProfile', NONE)).toBe('Kết nối trang ở bước 1 trước')
    expect(stepLock('autoreplyEnabled', { ...NONE, openAiKeyValid: true })).toBe('Kết nối trang ở bước 1 trước')
  })

  it('có trang chưa có khoá → chỉ khoá bước 4', () => {
    const pageOnly = { ...NONE, pageConnected: true }
    expect(stepLock('brandProfile', pageOnly)).toBeNull()
    expect(stepLock('autoreplyEnabled', pageOnly)).toBe('Thêm khoá OpenAI ở bước 2')
    expect(stepLock('autoreplyEnabled', { ...pageOnly, openAiKeyValid: true })).toBeNull()
  })
})

describe('setupPageId và đường dẫn bước 3–4', () => {
  it('ưu tiên Fanpage, rồi Instagram, rồi Threads; không có trang → null', () => {
    expect(setupPageId([{ id: 't', platform: 'threads' }, { id: 'i', platform: 'instagram' }, { id: 'f', platform: 'facebook' }])).toBe('f')
    expect(setupPageId([{ id: 't', platform: 'threads' }, { id: 'i', platform: 'instagram' }])).toBe('i')
    expect(setupPageId([{ id: 't', platform: 'threads' }])).toBe('t')
    expect(setupPageId([])).toBeNull()
  })

  it('có trang → Chi tiết trang / AI trả lời chọn sẵn trang; không trang → màn chung', () => {
    expect(brandProfilePath('f')).toBe('/trang-nhom/trang/f')
    expect(autoreplyPath('f')).toBe('/ai-tra-loi?muc=page:f')
    expect(brandProfilePath(null)).toBe('/trang-nhom')
    expect(autoreplyPath(null)).toBe('/ai-tra-loi')
  })

  it('cao trào dẫn vào đúng hội thoại ở Hộp thư', () => {
    expect(inboxPathOf(REPLY)).toBe(`/hop-thu?c=${REPLY.conversationId}`)
  })
})

describe('shouldOpenWelcome', () => {
  const base = { pathname: '/', pages: [] as unknown[], opened: false }

  it('mở app ở / khi danh sách trang đã tải và rỗng → chuyển tới màn chào', () => {
    expect(shouldOpenWelcome(base)).toBe(true)
  })

  it('đang tải / lỗi tải (chưa có dữ liệu), đã có trang, deep link khác /, màn chào đã mở → không chuyển', () => {
    expect(shouldOpenWelcome({ ...base, pages: undefined })).toBe(false)
    expect(shouldOpenWelcome({ ...base, pages: [{ id: 'p1' }] })).toBe(false)
    expect(shouldOpenWelcome({ ...base, pathname: '/trang-nhom' })).toBe(false)
    expect(shouldOpenWelcome({ ...base, pathname: '/cai-dat' })).toBe(false)
    expect(shouldOpenWelcome({ ...base, opened: true })).toBe(false)
  })

  it('cờ "đã mở màn chào" giữ trong lần tải app', () => {
    expect(welcomeOpenedThisLoad()).toBe(false)
    markWelcomeOpened()
    expect(welcomeOpenedThisLoad()).toBe(true)
  })
})

describe('realtime làm cũ trạng thái Màn chào', () => {
  it('message.* làm cũ ["onboarding"] và sức khoẻ webhook; page / settings / openai_key làm cũ ["onboarding"]', () => {
    expect(hintInvalidates(ONBOARDING_KEY[0], 'message', 'message.sent')).toBe(true)
    expect(hintInvalidates(WEBHOOK_HEALTH_KEY[0], 'message', 'message.received')).toBe(true)
    expect(hintInvalidates(ONBOARDING_KEY[0], 'page', 'page.connected')).toBe(true)
    expect(hintInvalidates(ONBOARDING_KEY[0], 'settings', 'settings.updated')).toBe(true)
    expect(hintInvalidates(ONBOARDING_KEY[0], 'openai_key', 'openai_key.invalidated')).toBe(true)
    expect(hintInvalidates(ONBOARDING_KEY[0], 'notification', 'notification.created')).toBe(false)
  })
})
