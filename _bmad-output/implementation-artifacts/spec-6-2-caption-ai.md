---
title: 'Story 6.2 — Viết caption bằng AI theo hồ sơ từng trang'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'f72bbdda427e54fd1999c26dbad2d9433217f9f9'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 6.2, UX F4 b2–b3, AD-2, AD-7, AD-8, AD-21; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Ở Soạn bài, "Tạo bằng AI", "Viết bằng AI cho N trang", "Viết lại / Ngắn hơn / Thêm CTA" vẫn là bộ sinh mô phỏng phía web: không gọi OpenAI, không theo hồ sơ thương hiệu, không hậu kiểm, không tính hạn mức. Caption AI cho Threads cũng chưa được kiểm theo cách Threads đếm emoji (việc hoãn của 6.1).

**Approach:**
- Endpoint tương tác `POST /api/v1/posts/compose` (chạy trong request, trả JSON một lần, như Viết thử 3.4 / Gợi ý 4.8).
- `content.composeCaptions` giải hồ sơ hiệu lực từng trang (`profiles.resolveEffectiveOrNull`), dựng prompt chung ở `ai/prompts/compose.ts`, gọi gateway `feature=compose_caption`, hậu kiểm `ai.checkOutput` theo nền tảng (sinh lại một lần), trả kết quả riêng từng trang.
- Composer gọi endpoint thật, có Dừng, khoá nút theo mã lỗi, đánh dấu cụm vi phạm và báo "cần hồ sơ" ngay trên tab của trang.

## Boundaries & Constraints

**Always:**
- **Hợp đồng (shared `content.ts`):**
  - `ComposeCaptionsRequest` (strict): `topic` (trim, ≤ `POST_TOPIC_MAX`), `goal` `sales|engagement|announce` (mặc định `sales`), `length` `short|medium|long` (mặc định `medium`), `pageIds` 1–`POST_TARGETS_MAX` không trùng, `revise?` `{action: rewrite|shorter|cta, caption ≤ 5.000}`.
  - Ràng buộc: không `revise` hoặc `rewrite` → `topic` không rỗng; có `revise` → đúng 1 trang; `shorter`/`cta` → `caption` không rỗng. Lỗi → 400 `VALIDATION_FAILED` + `path`.
  - `ComposeCaptionsResponse`: `results[]` theo đúng thứ tự `pageIds`; mỗi phần tử `{pageId, status:'ok', caption, violations}` hoặc `{pageId, status:'error', errorCode}`.
- **Thứ tự xử lý:**
  - Trang không có / đã gỡ → 400 `VALIDATION_FAILED` path `pageIds.i`, không gọi AI. Trang `disconnected` vẫn viết được.
  - Trang không có hồ sơ hiệu lực → kết quả `CONFIG_MISSING` cho trang đó, không gọi AI; các trang khác vẫn được viết.
  - Sinh song song tối đa 3 trang một lúc [ASSUMPTION].
- **Gateway (AD-7):** `feature='compose_caption'`, `pageId`, `signal`, `store:false` (gateway lo). Mẫu prompt ở `modules/ai/prompts/compose.ts`, export qua `ai/index.ts`, dùng lại `EMOJI_GUIDE`, `formalityGuide`, phần dữ liệu hồ sơ và ràng buộc từ cấm/link của mẫu caption.
- **Prompt:** nền tảng (cách viết + giới hạn ký tự = min(luật nền tảng, 2.200); Threads: ít emoji vì emoji tính theo byte, tối đa 1 hashtag), mục tiêu, độ dài, giọng/xưng hô/emoji, sản phẩm, hashtag gợi ý, từ cấm, domain. Có `revise` thì đưa caption hiện tại và yêu cầu viết bản khác / rút gọn / thêm lời kêu gọi.
- **Hậu kiểm (AD-21):**
  - `checkOutput(caption, {brand, kind:'caption', maxChars: luật nền tảng, platform})`.
  - `checkOutput` nhận thêm `platform` và đếm độ dài bằng `captionLength(text, platform)`; Threads tính emoji theo byte UTF-8 (đóng việc hoãn của 6.1).
  - Vi phạm → sinh lại đúng một lần, kèm ghi chú vi phạm (`retryNote`). Vẫn vi phạm → `ok` kèm `violations`. Tối đa 2 lời gọi mỗi trang.
- **Lỗi theo trang:**
  - `AppError` của gateway → `errorCode` của trang đó. AbortError khi client còn kết nối → `AI_PROVIDER_ERROR`.
  - Gặp mã dừng (`OPENAI_KEY_MISSING|INVALID|RESTRICTED`, `AI_BUDGET_EXCEEDED`, `ENCRYPTION_NOT_CONFIGURED`) → các trang chưa bắt đầu nhận cùng mã, không gọi AI. Trang đã xong giữ kết quả.
  - Lỗi không phải `AppError` → ném lên (500).
- **Dừng:** client đóng kết nối → `AbortSignal` sang OpenAI qua `runAbortable`; gateway release, không settle phần chưa chạy; không 500.
- **Web (`lib/composer.ts`, `Composer.tsx`):**
  - "Tạo bằng AI" (mọi tab), "Viết bằng AI cho N trang" (tab trống), "Viết lại / Ngắn hơn / Thêm CTA" (tab đang mở) đều gọi endpoint thật với ý tưởng, mục tiêu, độ dài.
  - Đang chạy → "AI đang viết…" + Dừng (abort fetch, giữ nguyên nội dung).
  - Kết quả `ok` thay caption của tab, nhãn "AI tạo", sửa được. Kết quả lỗi giữ caption cũ và ghi chú trên tab: `CONFIG_MISSING` → "Trang chưa có hồ sơ thương hiệu" + liên kết "Tạo hồ sơ"; mã khác → câu theo mã + "Thử lại".
  - Cụm vi phạm còn trong chữ được đánh dấu dưới ô của tab (`markViolations`); `too_long` tính bằng `captionLength` theo nền tảng.
  - Khoá mọi nút AI (tooltip, vẫn soạn tay) theo thứ tự: khoá OpenAI → hạn mức `blocked` → mã khoá lần gọi trước (giữ tới khi khoá/hạn mức đổi).
  - Bỏ ô "Dùng hồ sơ thương hiệu của từng trang" (luôn theo hồ sơ), thay bằng một dòng ghi chú.

**Never:** Không stream, không job, không lưu bài khi viết (caption chỉ vào state; Lưu nháp vẫn là thao tác riêng). Không log prompt / ý tưởng / caption. Không nhân bản luật hậu kiểm ngoài `checkOutput`. `content` không import route; không gọi OpenAI thật ở test. Không sinh ảnh (6.3), không lên lịch (6.4).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ba trang sạch | ý tưởng nồi chiên, FB + IG + Threads có hồ sơ (một trang theo nhóm) | 200, 3 kết quả `ok` đúng thứ tự; 3 lời gọi `compose_caption` có `page_id`; prompt mỗi trang có tên/giọng/từ cấm của hồ sơ hiệu lực (nhóm với trang theo nhóm), nền tảng, ý tưởng, mục tiêu, độ dài | |
| CONFIG_MISSING một trang | 1 trang không hồ sơ + 2 trang có | trang đó `error CONFIG_MISSING`, 2 trang `ok`, chỉ 2 lời gọi | |
| Vi phạm rồi sạch | lần 1 có từ cấm | sinh lại kèm ghi chú vi phạm → `ok`, `violations:[]`, 2 lời gọi | |
| Vẫn vi phạm | từ cấm + URL lạ cả hai lần | `ok` kèm `banned_word`, `disallowed_url` | |
| Threads emoji | 498 chữ + 2 emoji 😍 | `too_long` "506/500" (đếm byte emoji) | |
| checkOutput đơn vị | `platform` threads / không có | đếm như `captionLength(text, platform)` / như cũ | |
| Revise | `shorter` + caption / `rewrite` / `cta` | prompt có caption hiện tại + yêu cầu tương ứng; 1 trang | |
| Body sai | topic rỗng không revise; `revise` + 2 trang; `shorter` caption rỗng; trang trùng; khoá thừa; `pageIds` rỗng | 400 `VALIDATION_FAILED` + `path` | không gọi AI |
| Trang lạ / đã gỡ | | 400 `VALIDATION_FAILED` path `pageIds.i` | không gọi AI |
| Thiếu khoá / hết hạn mức | khoá chưa nhập; hạn mức 100% | mọi trang có hồ sơ `error OPENAI_KEY_MISSING` / `AI_BUDGET_EXCEEDED`; trang không hồ sơ vẫn `CONFIG_MISSING` | không gọi OpenAI |
| Hết hạn mức giữa chừng | trang 1 xong, trang 2 gặp `AI_BUDGET_EXCEEDED` | trang 1 `ok`, các trang sau cùng mã dừng | |
| Lỗi provider một trang | OpenAI lỗi 5xx ở 1 trang | trang đó `AI_PROVIDER_ERROR`, trang khác `ok` | |
| Dừng | client huỷ giữa chừng | AbortSignal tới OpenAI, reservation release, không `ai_usage`, không 500 | |
| Chưa đăng nhập | | 401 | |
| Web khoá | khoá OpenAI hỏng / hạn mức blocked / mã khoá từ kết quả | nút AI khoá đúng câu; ô caption vẫn sửa được | |
| Web áp kết quả | 3 kết quả (ok, CONFIG_MISSING, AI_PROVIDER_ERROR) | tab ok đổi caption + nhãn AI; tab lỗi giữ caption + ghi chú đúng mã; vi phạm còn trong chữ được đánh dấu | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/content.ts` -- `ComposeGoal`, `ComposeLength`, `ComposeReviseAction`, `ComposeCaptionsRequest/Response`.
- `server/src/modules/ai/check-output.ts` -- thêm `platform`, đếm bằng `captionLength`.
- `server/src/modules/ai/prompts/{caption,compose,reply,index}.ts`, `ai/index.ts` -- mẫu prompt Soạn bài; tách phần dùng chung của mẫu caption; `retryNote` nhận nhãn.
- `server/src/modules/content/compose.ts` (MỚI), `content/index.ts` -- `composeCaptions`.
- `server/src/app/posts-compose.ts` (MỚI), `app.ts` -- route, đăng ký cùng các route AI.
- `server/test/content-compose.test.ts` (MỚI), `check-output.test.ts` -- ma trận server.
- `web/src/lib/composer.ts` + `composer.test.ts` -- hook `useComposeCaptions`, `applyComposeResults`, `composeLock`, `captionViolations`, câu lỗi.
- `web/src/screens/Composer.tsx` -- bỏ bộ sinh mô phỏng, nối endpoint thật.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/content.ts` -- hợp đồng compose -- AD-18.
- [x] `server/src/modules/ai/*` -- `checkOutput({platform})`, mẫu prompt compose, export -- AD-7, AD-21, việc hoãn 6.1.
- [x] `server/src/modules/content/compose.ts`, `index.ts` -- `composeCaptions` -- AD-1 (`content → profiles | ai`), AD-8.
- [x] `server/src/app/posts-compose.ts`, `app.ts` -- route + `runAbortable`.
- [x] `server/test/content-compose.test.ts`, `check-output.test.ts` -- phủ các dòng server của ma trận.
- [x] `web/src/lib/composer.ts`, `composer.test.ts` -- hook + helper thuần + test các dòng web.
- [x] `web/src/screens/Composer.tsx` -- giao diện nối API, bỏ mô phỏng.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- gỡ mục Threads của 6.1, thêm mục kiểm bằng trình duyệt.

**Acceptance Criteria:**
- Given ý tưởng "Khuyến mãi nồi chiên không dầu 20% cuối tuần" và 3 trang đích, when bấm "Tạo bằng AI", then mỗi tab nhận caption riêng theo hồ sơ hiệu lực của trang, sửa được, và Dừng huỷ request thật.
- Given hết hạn mức hoặc khoá lỗi, when mở Soạn bài, then mọi nút AI khoá kèm câu theo mã, ô caption vẫn soạn tay được.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `content.ts` thêm `ComposeGoal` / `ComposeLength` / `ComposeReviseAction`, `ComposeCaptionsRequest` (ràng buộc ý tưởng / một trang khi sửa / caption khi rút gọn–thêm CTA, `COMPOSE_REVISE_CAPTION_MAX` 5.000 [ASSUMPTION]), `ComposeCaptionsResponse` (union `ok` / `error` theo trang).
- **ai:**
  - `checkOutput` nhận `platform`, đếm bằng `captionLength` — đóng việc hoãn Threads của 6.1. Chỉ Soạn bài truyền `platform`; Gợi ý / AI trả lời giữ cách đếm cũ (ghi ở deferred-work).
  - `prompts/compose.ts` (`buildComposePrompt`, `COMPOSE_MAX_OUTPUT_TOKENS` 1.200). Tách `brandFactLines` / `captionGuardLines` khỏi `caption.ts` để dùng chung (chữ của Viết thử không đổi). `retryNote(violations, subject)` để lần sinh lại ghi "Bản caption trước bị chặn".
- **content:** `compose.ts` `composeCaptions`:
  - kiểm trang → hồ sơ hiệu lực từng trang → tối đa 3 trang song song (`COMPOSE_CONCURRENCY`);
  - mã dừng (`OPENAI_KEY_*`, `AI_BUDGET_EXCEEDED`, `ENCRYPTION_NOT_CONFIGURED`) gán cho các trang chưa bắt đầu;
  - AbortError khi client còn kết nối → `AI_PROVIDER_ERROR` của trang;
  - lỗi không phải `AppError` ném lên.
  - `content` gọi `profiles` + `ai` + `pages` (đúng AD-1, depcruise sạch).
- **Route:** `app/posts-compose.ts` `POST /api/v1/posts/compose`, đăng ký cạnh các route AI (cần `events`), dùng `runAbortable`.
- **Web:**
  - `lib/composer.ts`: `useComposeCaptions`, `buildComposeBody`, `applyComposeResults`, `composeLock` (bọc `suggestLock` của 4.8, bỏ nhánh hồ sơ), `composeLockCodeOf`, `captionViolations` (too_long đếm theo nền tảng), `aiErrorText`, `composeToast`, `GOAL_OPTIONS` / `LENGTH_OPTIONS`.
  - `Composer.tsx`: bỏ toàn bộ bộ sinh mô phỏng; mọi nút AI gọi API thật với Dừng; khoá theo khoá OpenAI / hạn mức (`useAiBudget`) / mã lần trước; tab lỗi có dấu cam + ghi chú ("Tạo hồ sơ" hoặc "Thử lại"); cụm vi phạm đánh dấu bằng `markViolations`; Viết lại / Ngắn hơn / Thêm CTA có Dừng ngay trong ô của tab.
  - Bỏ ô "Dùng hồ sơ thương hiệu của từng trang", thay bằng dòng ghi chú (AC luôn theo hồ sơ).
- **Test:** `server/test/content-compose.test.ts` (15, phủ mọi dòng server của ma trận, fake OpenAI, Postgres thật); `check-output.test.ts` (+5: đếm Threads, mẫu prompt compose); `web/src/lib/composer.test.ts` (+5).
- **Kiểm tra:** `npm run check` thoát 0: depcruise sạch (178 module), server 60 file / 1248 test, web 19 file / 266 test. Chưa thử bằng trình duyệt (dev không có mật khẩu mẫu, cần khoá OpenAI thật) — ghi ở deferred-work.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Model trả chữ rỗng (vd hết token đầu ra) → `ok` với caption rỗng, FE đè mất caption của tab (nhất là Ngắn hơn / Thêm CTA). Sửa: `composeOne` trả `AI_PROVIDER_ERROR` cho riêng trang đó; test "model trả rỗng". | real, medium | patch |
| Đang AI viết mà nạp nháp khác cùng màn (`?bai=` từ tìm kiếm, bấm "Soạn bài" mới) → kết quả đổ caption AI vào nháp mới. Sửa: `session` tăng mỗi lần nạp nháp, effect huỷ request khi đổi; `onSuccess` bỏ kết quả khi `signal` đã huỷ (cũng che khe Dừng đúng lúc kết quả về). | real, medium | patch |
| Song song 3 trang gần sát hạn mức: chỗ giữ của trang đang chạy làm trang sau gặp `AI_BUDGET_EXCEEDED` (`remainingVnd > 0`) → thành mã dừng cho các trang còn lại và khoá nút AI ở FE tới khi trạng thái hạn mức đổi. | real, low–medium | defer |

## Verification

**Commands:**
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `/soan-bai` với khoá OpenAI thật: chọn 3 trang (1 trang chưa có hồ sơ) → "Tạo bằng AI" → 2 tab có caption khác giọng, tab còn lại báo cần hồ sơ; bấm Dừng giữa chừng thì nội dung giữ nguyên.
