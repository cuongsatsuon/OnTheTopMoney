---
title: 'Story 4.7 — Gửi tin từ Hộp thư đúng luật 24 giờ'
type: 'feature'
created: '2026-10-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '5e0afe244453cf9a3a77e55837f35791db249612'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 4.7 (PM duyệt), AD-9, AD-10, AD-11, AD-20, AD-24; chủ dự án cho tự duyệt spec">

## Intent

**Problem:** Hộp thư đã nhận tin (4.3, 4.4) và đổi trạng thái (4.6) nhưng ô soạn còn khoá: chủ shop phải mở Messenger/Instagram/Threads để trả lời, và chưa có chỗ nào kiểm luật 24 giờ / nhắn riêng 7 ngày hay giữ lại tin gửi lỗi.

**Approach:** `inbox` thêm `canSend` (chỗ duy nhất tính cửa sổ gửi), lệnh gửi / gửi lại ghi tin outbound `pending` + enqueue `inbox.send` cùng transaction (từ chối sớm thì vẫn lưu `failed` kèm mã), job `inbox.send` gửi qua `adapters/meta` ngoài transaction, ánh xạ lỗi Meta về mã gửi tin; cron dọn tin kẹt `sending`. Web mở ô soạn (`⌘↵`, chọn Trả lời công khai / Nhắn riêng), bong bóng hiện trạng thái gửi, lỗi + "Gửi lại".

## Boundaries & Constraints

**Always:**
- `inbox.canSend(db, conversationId, mode, {now, excludeMessageId?})`, `mode ∈ dm|public_reply|private_reply` → `{ok:true, replyTo}` | `{ok:false, code}`:
  - trang đã gỡ / hội thoại không còn → `PAGE_REMOVED`; trang `disconnected` → `PAGE_DISCONNECTED`;
  - `dm`: `last_customer_message_at` ≥ now − 24 giờ, ngược lại (kể cả null) `OUTSIDE_24H`;
  - `public_reply`: đích = bình luận gốc (`thread_key`); bình luận gốc đã bị khách xoá → `SEND_REJECTED`;
  - `private_reply` (chỉ FB/IG; Threads → `PRIVATE_REPLY_INVALID`): đích = bình luận mới nhất chưa bị xoá của chính khách của hội thoại; không có hoặc cũ hơn 7 ngày → `PRIVATE_REPLY_INVALID`; đã có tin `private_reply` không `failed` cho đúng bình luận đó (trừ `excludeMessageId`) → `PRIVATE_REPLY_USED`.
- Mode hợp lệ theo kênh (`sendModesFor` ở shared): DM → `dm`; bình luận FB/IG → `public_reply|private_reply` (mặc định `public_reply`); Threads → `public_reply`. Sai kênh / chữ rỗng / quá giới hạn nền tảng (`sendTextLimit`: Threads 500, IG nhắn 1000, còn lại 2000) → 400 `VALIDATION_FAILED`, không lưu gì.
- `POST /api/v1/conversations/:id/messages {text, mode?}` và `POST /api/v1/messages/:id/resend` (dưới phiên, kiểm Origin), mỗi lệnh MỘT transaction sau khoá luồng hội thoại:
  - `canSend` cho phép → tin `direction=outbound`, `origin=app_human`, `status=pending`, `delivery=mode`, `reply_to_platform_id`, `queued_at=now`, `platform_timestamp` = max(now, `last_message_at`) + job `inbox.send {messageId}` cùng transaction; cập nhật `last_message_at`; xoá tin `app_ai` `pending`; `triage|ai|handoff → human` (`HUMAN_REPLIED`, `ai_enabled=false`, tin `system`, `state_changed`); `waiting_since=null`. Trả 201 `MessageDto` (resend: 200).
  - `canSend` từ chối → tin vẫn lưu `status=failed` + `error_code` (resend: giữ `failed`, đổi mã), phát `message.failed`, không đổi trạng thái hội thoại; trả 409 với `code` = mã đó, `details.messageId`.
  - Resend chỉ cho tin `app_human` đang `failed` (khác → 409 `VERSION_CONFLICT`), đặt `pending`, xoá `error_code`, dời `platform_timestamp` về cuối, enqueue job MỚI.
- Job `inbox.send` (queue standard, retry 5 backoff, concurrency 5, `critical`):
  - chiếm bằng `UPDATE … SET status='sending', sending_at=now WHERE id=? AND status='pending'`; không thấy dòng → coi là đã huỷ (Tiếp quản xoá tin AI `pending`), kết thúc êm; dòng ở trạng thái khác → bỏ qua;
  - token qua `connections.getAccessToken` ngay trước khi gọi; hạng `interactive`; Messenger gửi kèm `metadata = messages.id`;
  - thành công → `sent` + `platform_message_id`, phát `message.sent`; nhắn riêng có `recipient_id` → gắn định danh `(page, recipient_id)` vào cùng contact của người bình luận (định danh đã thuộc khách khác → giữ nguyên, chỉ log);
  - ánh xạ lỗi: `TOKEN_INVALID` → `markDisconnected` (trang giữ token) + `PAGE_DISCONNECTED`; `OUTSIDE_WINDOW` → `OUTSIDE_24H` (nhắn riêng: `PRIVATE_REPLY_INVALID`); `RECIPIENT_UNAVAILABLE`; `PRIVATE_REPLY_INVALID`; `PERMISSION_DENIED|REJECTED` → `SEND_REJECTED`; trang gỡ/mất kết nối lúc gửi → `PAGE_REMOVED|PAGE_DISCONNECTED`;
  - `RATE_LIMITED` → trả `pending` + job mới `startAfter = now + retryAfter` (không tính retry), trừ khi quá 30 phút từ `queued_at` → `failed` `RATE_LIMITED`; `TRANSIENT` → trả `pending` rồi ném (retry), lần thử cuối → `failed` `SEND_FAILED`;
  - mọi `failed` phát `message.failed {errorCode}`.
- Cron `inbox.send_sweep` mỗi 5 phút: tin `sending` có `sending_at` cũ hơn 15 phút → `failed` `SEND_UNKNOWN`, phát `message.failed`; không tự gửi lại.
- Tin `failed` không tính là "đã trả lời": điều kiện "Cần xử lý" và xem trước danh sách bỏ qua tin outbound `failed`.
- `TOKEN_INVALID` ở `inbox.fetch_profile` / `inbox.fetch_post_text` cũng `markDisconnected` qua cùng helper (việc hoãn từ 4.3).
- Web: ô soạn theo kênh (DM: Gửi; bình luận FB/IG: chọn "Trả lời công khai" / "Nhắn riêng"; Threads: chỉ "Trả lời công khai"), `⌘↵`/`Ctrl+↵` gửi, đếm ký tự theo `sendTextLimit`; bong bóng outbound hiện "Đang gửi…" / lỗi (icon đỏ + câu theo mã + gợi ý với `OUTSIDE_24H`) + "Gửi lại"; tin nhắn riêng có nhãn "Nhắn riêng". Từ chối gửi (409 mã gửi tin) → chỉ làm cũ tin (bong bóng lỗi), không toast; lỗi khác → toast.

**Never:**
- Không gọi Meta trong request API hay trong transaction; không message tag (HUMAN_AGENT).
- Không tự gửi lại tin `SEND_UNKNOWN`; không tự gộp khách khi định danh `recipient_id` đã thuộc khách khác.
- Không cập nhật `delivered/read` từ webhook (field `message_deliveries|message_reads` chưa đăng ký), không nhận diện echo (Story 4.5), không tạo hội thoại `dm` sẵn / `origin_conversation_id` cho nhắn riêng, không "Gợi ý bằng AI" (4.8), không gửi đính kèm.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|---|---|---|---|
| Gửi DM trong 24h | hội thoại `ai`, tin khách 1 giờ trước | 201 tin `pending` + job cùng tx; `human` `HUMAN_REPLIED`, `ai_enabled=false`, tin AI `pending` bị xoá; job → `sent`, `platform_message_id`, `metadata`=id tin, `message.sent` | |
| Gửi ở `human` | khách đang chờ | không chuyển trạng thái, `waiting_since=null`, rời "Cần xử lý" | |
| Quá 24h | tin khách 25 giờ trước / chưa có | 409 `OUTSIDE_24H`; tin lưu `failed` `OUTSIDE_24H`, `message.failed`; trạng thái không đổi; vẫn ở "Cần xử lý" | |
| Đầu vào sai | chữ rỗng, quá giới hạn, `private_reply` ở DM, `dm` ở bình luận, Threads `private_reply` qua mode sai kênh | 400, không lưu | `VALIDATION_FAILED` |
| Trả lời công khai | bình luận FB / IG / Threads | FB `POST /{comment}/comments`, IG `POST /{comment}/replies`, Threads tạo container `reply_to_id` rồi `threads_publish`; `sent` + id trả về | |
| Bình luận gốc đã xoá | `public_reply` | 409, tin `failed` `SEND_REJECTED` | |
| Nhắn riêng lần đầu | bình luận FB/IG < 7 ngày | `POST /me/messages {recipient:{comment_id}}`; `sent`; `recipient_id` gắn vào cùng contact; `delivery=private_reply` trong hội thoại `comment` | định danh đã thuộc khách khác → giữ nguyên |
| Nhắn riêng lần hai / quá 7 ngày / Threads | | 409 `PRIVATE_REPLY_USED` / `PRIVATE_REPLY_INVALID` / `PRIVATE_REPLY_INVALID`, tin `failed` | |
| Lỗi Meta không retry | `TOKEN_INVALID`, `OUTSIDE_WINDOW`, `RECIPIENT_UNAVAILABLE`, `REJECTED`, 100/2534025 | `failed` `PAGE_DISCONNECTED` (+ trang `disconnected`) / `OUTSIDE_24H` / `RECIPIENT_UNAVAILABLE` / `SEND_REJECTED` / `PRIVATE_REPLY_INVALID`; job kết thúc êm | |
| `TRANSIENT` | lần thử thường / cuối | trả `pending` rồi ném / `failed` `SEND_FAILED` | |
| `RATE_LIMITED` | retryAfter 60s / quá 30 phút từ `queued_at` | `pending` + job mới `startAfter`, job hiện tại xong êm / `failed` `RATE_LIMITED` | |
| Trang gỡ/mất kết nối lúc gửi | | `failed` `PAGE_REMOVED` / `PAGE_DISCONNECTED` | |
| Tin bị huỷ | Tiếp quản xoá tin AI `pending` trước khi job chạy | job kết thúc êm, không gọi Meta, không lỗi | |
| Job chạy hai lần | tin đã `sending`/`sent` | lần sau bỏ qua, không gọi Meta | |
| Kẹt `sending` | `sending_at` 16 phút trước / 10 phút trước | `failed` `SEND_UNKNOWN` + `message.failed` / giữ nguyên | |
| Gửi lại | tin `failed` `RATE_LIMITED` | `pending`, mã xoá, job mới, 200; lại bị từ chối → 409 + mã mới | tin không `failed` / không phải `app_human` → 409 `VERSION_CONFLICT`; không có → 404 |
| Phiên / Origin / không có | | | 401 / 403 / 404 |
| `TOKEN_INVALID` ở job tên khách / caption | | trang `disconnected`, job bỏ qua | |
| Web | 5 trạng thái tin outbound, 3 loại kênh, phím `⌘↵` | nhãn trạng thái, câu lỗi theo mã, "Gửi lại", mode theo kênh, giới hạn ký tự | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/inbox.ts` -- `SEND_ERROR_CODES`, `SendMessageBody`, `sendModesFor`, `sendTextLimit`; `MessageDto.delivery|errorCode`.
- `server/src/adapters/meta/errors.ts` -- kind `PRIVATE_REPLY_INVALID` cho 100/2534025.
- `server/src/modules/connections/credentials.ts` -- `tokenOwnerPageId` (IG → Fanpage nguồn) để `markDisconnected` đúng trang giữ token.
- `server/src/modules/inbox/schema.ts` -- cột `delivery`, `error_code`, `reply_to_platform_id`, `queued_at`, `sending_at` + check; migration `drizzle-kit generate`.
- `server/src/modules/inbox/send.ts` (MỚI) -- `canSend`, `sendMessage`, `resendMessage`, job `inbox.send`, cron sweep.
- `server/src/modules/inbox/meta-token.ts` (MỚI) -- `reportTokenInvalid` dùng chung cho send/profile/post-text.
- `server/src/modules/inbox/state.ts` -- export `lockConversation`; `applyHumanReply`; takeover bỏ qua tin `failed`.
- `server/src/modules/inbox/queries.ts` -- `getMessage`, DTO mới; "Cần xử lý" + xem trước bỏ qua tin `failed`.
- `server/src/app/inbox.ts` -- route gửi / gửi lại (cần `jobs`); `app.ts` truyền `jobs`.
- `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts` -- `inbox.send`, `inbox.send_sweep`.
- `server/src/modules/connections/fake-meta.ts` -- Meta giả trả id cho đường gửi (dev `META_FAKE=1`).
- `web/src/lib/inbox.ts`, `web/src/screens/Inbox.tsx` -- ô soạn, `useSendMessage`/`useResendMessage`, bong bóng trạng thái/lỗi.

## Tasks & Acceptance

**Execution:**
- [x] shared: mã lỗi gửi, body gửi, mode/giới hạn theo kênh, DTO tin.
- [x] adapters/connections: kind `PRIVATE_REPLY_INVALID`; `tokenOwnerPageId`; Meta giả cho đường gửi.
- [x] inbox: schema + migration; `canSend`, gửi / gửi lại, job `inbox.send`, sweep; `applyHumanReply`; truy vấn bỏ qua tin `failed`; `reportTokenInvalid` cho profile/post-text.
- [x] app + worker + queues: route, handler, cron.
- [x] web: ô soạn, bong bóng trạng thái/lỗi, "Gửi lại", `⌘↵`.
- [x] Test server phủ mọi dòng matrix; test helper web; cập nhật test cũ theo DTO/kind mới.
- [x] deferred-work: gỡ mục `TOKEN_INVALID` của fetch_profile; ghi việc hoãn mới.

**Acceptance Criteria:**
- Given 4 AC của epics.md Story 4.7, when `npm run check`, then đều có test và xanh.
- Given Hộp thư mở ở hai tab trình duyệt, when một tab gửi tin, then hint `message.sent|failed` / `conversation.state_changed` làm cũ khung chat và danh sách ở tab kia.

## Implementation Notes

- **Migration** `server/drizzle/0018_tearful_the_leader.sql` (`drizzle-kit generate`): `messages.delivery|error_code|reply_to_platform_id|queued_at|sending_at`, check `(status='failed') = (error_code is not null)`, index một phần `sending_at WHERE status='sending'` cho cron.
- **`canSend`** (`inbox/send.ts`) chạy trong transaction gửi, sau khoá luồng → hai lần nhắn riêng song song không cùng qua kiểm "đã dùng". Mode lệch kênh: route trả 400 trước; gọi thẳng `canSend` (Epic 5) thì Threads nhắn riêng → `PRIVATE_REPLY_INVALID`, lệch kênh khác → `SEND_REJECTED`.
- **Từ chối sớm** trả 409 (mã gửi tin, `details.messageId`) và vẫn lưu tin `failed` + phát `message.failed`; không đổi trạng thái hội thoại, không đẩy `last_message_at`. Tin `failed` bị loại khỏi điều kiện "Cần xử lý" (subquery `lastNonSystemOrigin`) và xem trước (`effectiveMessage` ở `state.ts`, dùng chung cho Tiếp quản) → gửi lỗi không làm khách rơi khỏi hàng đợi.
- **`applyHumanReply`** (`state.ts`): huỷ tin AI `pending`, `triage|ai|handoff|done → human` `HUMAN_REPLIED` (tin `system` đứng ngay sau tin vừa gửi), `ai_enabled=false` (cả khi đã ở `human`), xoá `waiting_since`. `done` cũng chuyển (review lượt 1, theo AD-9: người gửi tin → `human`, tắt AI).
- **Job:** Messenger gửi `metadata = messages.id`; IG không gửi `metadata` (Send API IG không nêu). DM/nhắn riêng `POST /me/messages` bằng token Page (IG: token Fanpage nguồn); FB trả lời `/{gốc}/comments`, IG `/{gốc}/replies`; Threads `/me/threads` (`reply_to_id`) rồi `/me/threads_publish`. Lỗi bất ngờ trước lời gọi Meta → trả `pending` rồi ném. Meta trả 200 mà thiếu id → vẫn `sent`, log cảnh báo.
- **`RATE_LIMITED`** không ném: trả `pending` + job mới `startAfter = now + retryAfter` (pg-boss không có "retry không tính lượt"); quá 30 phút từ `queued_at` → `failed` `RATE_LIMITED`. Queue `inbox.send` `critical: true` (handler chỉ ném ở lần cuối khi lỗi bất ngờ → thông báo `system_error`).
- **Adapter:** thêm kind `PRIVATE_REPLY_INVALID` cho `100/2534025` (trước là `REJECTED`), vẫn chỉ ở `errors.ts`. `connections.tokenOwnerPageId` để `TOKEN_INVALID` đánh dấu đúng Fanpage giữ token (IG → nguồn); `inbox/meta-token.ts` dùng chung cho gửi tin, tên khách, caption (gỡ việc hoãn của 4.3).
- **Meta giả (dev `META_FAKE=1`):** `/me/messages`, trả lời bình luận (fallback theo path), Threads container/publish trả id giả.
- **App:** `buildApp` nhận `jobs` (main.ts `createJobSender(boss)`); route gửi chỉ đăng ký khi có `events` + `jobs`.
- **Web:** ô soạn thay ghi chú "Sắp có" (chọn Trả lời công khai / Nhắn riêng theo `sendModesFor`, đếm ký tự khi >80% giới hạn, `⌘↵`/`Ctrl+↵`, "Gợi ý bằng AI" vẫn khoá). Bong bóng outbound: "Đang gửi…/Đã gửi", nhãn "Nhắn riêng", lỗi → khung đỏ + câu theo mã + gợi ý (`OUTSIDE_24H` ở DM: trả lời qua bình luận hoặc gọi điện) + "Gửi lại". Từ chối 409 mã gửi tin → chỉ làm cũ tin, xoá ô soạn; lỗi khác → toast, giữ chữ.
- **Việc hoãn:** gỡ mục `TOKEN_INVALID` của `inbox.fetch_profile`; thêm 4 mục (trạng thái delivered/read, hội thoại `dm` từ nhắn riêng + gộp, gửi lại tin AI, xác nhận đường gửi với Meta thật).
- Chưa kiểm bằng trình duyệt (cùng lý do 4.3–4.6: cần mật khẩu chủ shop + trang đã kết nối); màn qua typecheck, lint, test helper.
- `npm run check`: server 971 test (33 mới ở `inbox-send.test.ts`), web 187 test, depcruise sạch.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|---|---|---|
| Job `inbox.send`: lỗi bất ngờ trước lời gọi Meta (vd thiếu `APP_ENCRYPTION_KEYS`, lỗi DB khi đọc trang/token) ở lần thử CUỐI vẫn trả tin về `pending` rồi ném → không còn job nào chiếm lại, tin kẹt "Đang gửi…" mãi (cron chỉ quét `sending`, "Gửi lại" chỉ cho `failed`) — mất tin mà chủ shop không biết. Sửa: lần cuối ghi `failed` `SEND_FAILED` rồi vẫn ném (báo `system_error`); thêm test. | thật, trung bình | patch |
| `applyHumanReply` giữ nguyên `done` (và không tắt AI khi đã ở `human` mà `ai_enabled` còn `true`, vd sau `AI_OFF`) — trái AD-9 "người dùng gửi tin → `human`, `ai_enabled=false`": chủ shop chủ động nhắn lại hội thoại đã xong thì tin khách sau đó mở lại `triage` và (Epic 5) AI tự trả lời. Sửa: `done` vào danh sách chuyển `human` `HUMAN_REPLIED`, mọi lần gửi đặt `ai_enabled=false`; thêm test. (Dòng `triage|ai|handoff → human` ở phần frozen giữ nguyên chữ; AD-9 ưu tiên.) | thật, trung bình | patch |
| `TRANSIENT` gồm cả hết giờ / lỗi mạng (không có HTTP status) và 5xx: Meta có thể đã nhận tin nhưng job trả `pending` rồi retry (tới 5 lần) → khách nhận trùng tin; Threads `threads_publish` hết giờ mà đã đăng → retry tạo container mới, trả lời trùng. Send API không có khoá idempotent; AD-10 + spec hiện quy định retry lỗi tạm. | thật, trung bình (đúng spec hiện tại) | defer |

## Design Notes

Nhắn riêng nhắm bình luận mới nhất của chính khách (không phải bình luận gốc) vì "một lần mỗi bình luận" tính theo bình luận; khách bình luận thêm trong luồng thì nhắn riêng được tiếp. Trả lời công khai nhắm bình luận gốc (FB làm phẳng luồng về gốc, IG chỉ trả lời được bình luận cấp một).

`RATE_LIMITED` không ném lỗi mà tự enqueue job mới có `startAfter`: pg-boss không có "retry không tính lượt", còn job mới thì không đốt `retryLimit`. Mốc chặn 30 phút từ `queued_at` để tin không treo "Đang gửi…" vô hạn.

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, lint, depcruise, test đều xanh.
