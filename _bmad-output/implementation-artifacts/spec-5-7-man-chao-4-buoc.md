---
title: 'Story 5.7 — Màn chào 4 bước chạy trọn'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '8e7947e34e911c5a612093400dce28634f98f666'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 5.7, UX Flow 7, AD-18, AD-8; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Màn chào `/bat-dau` mới nối thật bước 1 (trang) và bước 2 (khoá OpenAI). Bước 3–4 không bao giờ "Xong", không có cao trào "AI đã trả lời khách đầu tiên", và app không tự đưa chủ shop chưa có trang nào tới màn chào.

**Approach:** Thêm read-model `GET /api/v1/onboarding`: 4 cờ bước (có trang, khoá hợp lệ, có hồ sơ hiệu lực, có cấu hình AI đang bật) và tin AI đã gửi gần nhất. Logic giải kế thừa, trạng thái khoá và truy vấn tin lấy từ module sở hữu. Web đánh dấu bước theo endpoint này. Khi đủ 4 bước, màn chào hiện "Đang chờ tin đầu tiên" theo sức khoẻ webhook. Có tin AI thì hiện cao trào kèm nút "Mở Hộp thư". Mở app ở `/` khi chưa có trang thì chuyển tới `/bat-dau`.

## Boundaries & Constraints

**Always:**
- **Read-model** `app/read-models/onboarding.ts`. Chỉ đọc, chỉ gọi `index.ts` của module (AD-1):
  - Trang = `pages.listPages` (chưa gỡ, mọi trạng thái kết nối).
  - Khoá = `ai.getOpenAiKeyStatus` có `status='valid'`.
  - Hồ sơ = có ít nhất một trang mà `profiles.resolveEffective(pageId,'brand')` có cấu hình.
  - AI = có ít nhất một trang mà cấu hình `autoreply` hiệu lực có `enabled=true`.
  - `CONFIG_MISSING` → bước chưa xong. Gom các bản sao `effectiveOrNull` về một hàm export của `profiles`.
- **Tin AI** = tin `origin='app_ai'`, `status ∈ sent|delivered|read`, thuộc trang chưa gỡ, lấy tin có `sent_at` mới nhất. Trả `{conversationId, pageId, sentAt}` hoặc `null`. Hàm nằm ở `inbox`.
- Hợp đồng `OnboardingStatusResponse` ở `packages/shared`. Route dưới `/api/v1`, nên phải có phiên.
- **Web** dùng `useOnboardingStatus` (khoá `['onboarding']`). Helper thuần ở `web/src/lib/onboarding.ts` lo: số bước xong, bước đang làm, khoá nút bước 3–4, pha `setup|waiting|climax`, trang dùng cho bước 3–4, điều kiện chuyển tới màn chào.
  - Realtime: `page.*`, `settings.updated`, `openai_key.invalidated`, `message.*` làm cũ `['onboarding']`. `message.*` làm cũ cả `['webhooks', …]`, để Cài đặt › Webhook đổi sang "vừa xong" ngay khi có tin.
- Bước 3 mở Chi tiết trang (tab Hồ sơ). Bước 4 mở `/ai-tra-loi?muc=page:<id>`. Trang được chọn theo thứ tự ưu tiên Fanpage → IG → Threads.
- Pha `waiting` hiện nhãn `lastEventLabel` của sản phẩm `meta` (dùng lại `useWebhookHealth`), hướng dẫn nhắn thử, gợi ý tắt Trả lời tức thì của Meta, kèm liên kết Hộp thư. Pha `climax` hiện "AI đã trả lời khách đầu tiên", nút "Mở Hộp thư" tới `/hop-thu?c=<conversationId>`.
- **Chuyển tới màn chào:** chỉ khi đang ở `/`, danh sách trang thật (`usePages`) đã tải xong và rỗng, và màn chào chưa mở lần nào trong lần tải app này. Mở `/bat-dau` bất kỳ lúc nào cũng đánh dấu đã mở, nhờ vậy "Bỏ qua" vẫn vào được Tổng quan.

**Never:**
- Không lưu tiến độ onboarding vào DB. Trạng thái dẫn xuất từ dữ liệu thật.
- Không đổi luồng kết nối OAuth, lưu khoá, hồ sơ, cấu hình AI. Không chuyển hướng ở deep link khác `/` (callback `/trang-nhom?ket-noi=…`, `/cai-dat`…).
- Không migration, không queue mới. Không gọi Meta/OpenAI. Không log nội dung tin.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mới tinh | không trang, không khoá | 4 cờ `false`, `lastAiReply=null` | |
| Có trang | 1 trang chưa gỡ (kể cả `disconnected`) | `pageConnected=true`; chỉ trang đã gỡ → `false` | |
| Khoá | `valid` / `invalid` / chưa có | `true` / `false` / `false` | |
| Hồ sơ | trang theo nhóm có hồ sơ nhóm, hoặc trang có hồ sơ riêng | `brandProfile=true`; nhóm không hồ sơ / chỉ trang đã gỡ có hồ sơ → `false` | `CONFIG_MISSING` nuốt |
| AI | cấu hình hiệu lực bật (nhóm hoặc riêng) | `autoreplyEnabled=true`; có cấu hình nhưng tắt → `false` | |
| Tin AI | `app_ai` `sent` trên trang chưa gỡ (2 tin) | tin `sent_at` mới nhất; `pending`/`failed`, `app_human`, trang đã gỡ → `null` | |
| Chưa đăng nhập | không cookie | 401 | |
| Pha | thiếu ≥1 bước / đủ 4 không tin AI / đủ 4 có tin AI | `setup` / `waiting` / `climax`; thiếu bước mà có tin AI vẫn `setup` | |
| Bước đang làm | cờ theo thứ tự | bước chưa xong đầu tiên; đủ 4 → không bước nào | |
| Khoá nút | chưa trang / chưa khoá | bước 3 khoá khi chưa trang; bước 4 khoá khi chưa trang hoặc chưa khoá, có câu lý do | |
| Trang cho bước 3–4 | [threads, ig, fb] / không trang | chọn fb; `null` → `/trang-nhom` và `/ai-tra-loi` | |
| Chuyển tới màn chào | `/`, trang `[]`, chưa mở | chuyển `/bat-dau` (replace) | đang tải / lỗi tải / có trang / path khác / đã mở → không |
| Realtime | `message.sent` | làm cũ `onboarding` + `webhooks`; `settings.updated` làm cũ `onboarding` | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/onboarding.ts` (MỚI) + `index.ts` -- `OnboardingSteps`, `OnboardingAiReply`, `OnboardingStatusResponse`.
- `server/src/modules/profiles/inheritance.ts` + `index.ts` -- `resolveEffectiveOrNull`; `profiles/autoreply.ts` và `app/brand-profiles.ts` dùng hàm này thay bản sao cục bộ.
- `server/src/modules/inbox/queries.ts` + `index.ts` -- `latestAiReply(db, pageIds)`.
- `server/src/app/read-models/onboarding.ts` (MỚI) -- `onboardingStatus(deps {db, cipher})`.
- `server/src/app/onboarding.ts` (MỚI) + `app.ts` -- `GET /api/v1/onboarding`, nhận `cipher` từ `ai?.cipher`.
- `server/test/onboarding.test.ts` (MỚI) -- ma trận phía server (Postgres thật, cipher thật, `events` giả no-op).
- `web/src/lib/onboarding.ts` (MỚI) + `onboarding.test.ts` -- hook + helper thuần + cờ đã mở màn chào.
- `web/src/lib/realtime.ts` -- thêm `onboarding`, `webhook` vào `ENTITY_ALSO_INVALIDATES`.
- `web/src/screens/Welcome.tsx` -- bước theo endpoint, bước 3–4 thật, pha chờ / cao trào, đánh dấu đã mở.
- `web/src/components/AppShell.tsx` -- chuyển tới `/bat-dau` theo `shouldOpenWelcome`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/onboarding.ts`, `index.ts` -- schema hợp đồng -- AD-18.
- [x] `server/src/modules/profiles/*`, `server/src/app/brand-profiles.ts` -- `resolveEffectiveOrNull` dùng chung -- bỏ ba bản sao.
- [x] `server/src/modules/inbox/queries.ts`, `index.ts` -- `latestAiReply` -- `inbox` sở hữu tin.
- [x] `server/src/app/read-models/onboarding.ts`, `server/src/app/onboarding.ts`, `app.ts` -- read-model + route.
- [x] `server/test/onboarding.test.ts` -- phủ các dòng server của ma trận.
- [x] `web/src/lib/onboarding.ts`, `onboarding.test.ts`, `realtime.ts` -- hook, helper, làm cũ realtime + test các dòng web của ma trận (test làm cũ nằm trong `onboarding.test.ts`).
- [x] `web/src/screens/Welcome.tsx`, `web/src/components/AppShell.tsx` -- giao diện + chuyển hướng.

**Acceptance Criteria:**
- Given chưa có trang nào, when mở app ở `/`, then chuyển tới `/bat-dau`, mỗi bước "Xong" theo endpoint tổng hợp.
- Given đủ 4 bước và khách đầu tiên nhắn Fanpage, when AI gửi xong, then màn chào (qua realtime, không cần tải lại) hiện cao trào và dẫn vào hội thoại đó ở Hộp thư; Cài đặt › Webhook hiện "Nhận tin gần nhất: vừa xong".
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Server:** `GET /api/v1/onboarding` (`app/onboarding.ts` → `read-models/onboarding.ts`) đăng ký luôn, không cần `events`; `cipher` lấy từ `ai?.cipher`. Hồ sơ / AI dừng ở trang đầu tiên thoả. `profiles.resolveEffectiveOrNull` thay ba bản sao `effectiveOrNull` (`profiles/autoreply.ts`, `app/brand-profiles.ts`). `inbox.latestAiReply` lấy tin `app_ai` đã gửi có `sent_at` mới nhất. Không có index riêng: chỉ màn chào gọi.
- **Web:** `lib/onboarding.ts` (hook + helper + cờ "đã mở màn chào" trong bộ nhớ tab). `Welcome.tsx`:
  - bước theo endpoint, chưa tải được thì có "Thử lại";
  - bước 3 mở Chi tiết trang, bước 4 mở `/ai-tra-loi?muc=page:<id>`, nút khoá kèm tooltip lý do;
  - pha chờ: nhãn webhook `meta`, hướng dẫn nhắn thử, nhắc tắt Trả lời tức thì (việc hoãn 4.5), "Mở Hộp thư";
  - cao trào tím: "AI đã trả lời khách đầu tiên" → `/hop-thu?c=<id>`.
  Lưu khoá / xác nhận trang làm cũ `['onboarding']` ngay, không chờ realtime. `AppShell` chuyển tới `/bat-dau` theo `shouldOpenWelcome`.
- **Ngoài Code Map:** `server/test/autoreply-comment.test.ts` `sendJobs` thêm khoá phụ `data->>'messageId'`. Hai job cùng transaction trùng `created_on`, nên test này lỗi ngẫu nhiên khi chạy cả bộ; đã thấy 2/4 lần, có cả ở trước story này.
- **Kiểm tra:** `npm run check` thoát 0: depcruise sạch, server 58 file / 1211 test, web 18 file / 249 test. Chưa thử bằng trình duyệt vì dev không có mật khẩu mẫu để đăng nhập; đã ghi việc hoãn.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| `onboardingStatus` giải kế thừa tuần tự từng trang (`resolveEffectiveOrNull` ~3–4 truy vấn/trang × 2 loại) cho tới trang đầu tiên thoả; shop nhiều trang chưa có hồ sơ / AI bật → hàng trăm truy vấn mỗi lần gọi, và Màn chào gọi lại ở mọi `message.*`. Chỉ Màn chào dùng (query không hoạt động ở màn khác) nên chưa đáng gộp truy vấn lúc này. | real (medium, chỉ khi nhiều trang) | defer |
| `sendJobs` thêm khoá phụ `data->>'messageId'`: hai job `inbox.send` cùng transaction trùng `created_on`; worker gửi song song (concurrency 5) nên production không dựa vào thứ tự job, test chỉ cần thứ tự ổn định. | không phải lỗi production | dismiss |

## Verification

**Commands:**
- `npm run check` -- expected: thoát 0 (typecheck, lint, depcruise sạch, test server + web xanh).

**Manual checks (if no CLI):**
- `META_FAKE=1`: DB không trang → mở `/` thấy `/bat-dau`. Làm đủ 4 bước → "Đang chờ tin đầu tiên". `npm run simulate-dm -w server` + worker → cao trào, "Mở Hộp thư" mở đúng hội thoại.
