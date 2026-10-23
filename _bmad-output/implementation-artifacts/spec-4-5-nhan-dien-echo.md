---
title: 'Story 4.5 — Nhận diện tin của chính trang (echo)'
type: 'feature'
created: '2026-10-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '4d3dda5dca257e194bbef2e4fe45adfecdfd823c'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 4.5 (PM duyệt), AD-20, AD-9, AD-4, AD-24; chủ dự án cho tự duyệt spec">

## Intent

**Problem:** Tin/bình luận do chính trang viết (echo Messenger/IG, bình luận của trang trên FB/IG, trả lời Threads của tài khoản) đang bị `ignored`: tin app gửi không được xác nhận qua echo, còn chủ shop trả lời từ Meta Business Suite / điện thoại thì Hộp thư không thấy và AI (Epic 5) vẫn chen vào. Tin outbound cũng dừng ở `sent` vì webhook "đã nhận / đã xem" chưa được xử lý (việc hoãn của 4.7, AD-4).

**Approach:** `adapters/meta` trả dạng chuẩn cho tin của chính trang (thay `skip`). `inbox.ingestEcho` phân loại trước khi upsert: khớp tin của app (id nền tảng, `metadata`, nội dung trong 120 giây) → gắn id, `sent`; chưa khớp → job `inbox.echo_match` thử lại 5 giây × 3 rồi chèn `app_unmatched`; của app khác (Business Suite…) → `external_human` + `HUMAN_REPLIED`. Thêm nhánh `message_deliveries|message_reads` → `delivered|read`, đăng ký thêm field và đăng ký lại các trang đã kết nối.

## Boundaries & Constraints

**Always:**
- Nhận diện tác giả là trang ở `adapters/meta` (hàm thuần): DM `is_echo` hoặc `sender.id` = id trang → `echo {customerId = recipient.id, mid, timestamp, text, attachments, appId, metadata}` (`recipient.id` thiếu / = id trang → `malformed`); bình luận FB/IG `from.id` = id trang hoặc username = handle, Threads username = handle → `page_comment {commentId, parentId, platformPostId, text, timestamp, attachments}`.
- `inbox.ingestEcho(deps, {pageId, echo}, attempt)` — `attempt ∈ first|retry|final`; MỘT transaction sau khoá luồng (DM: `thread_key` = khách; bình luận: luồng của `parentId` tra như `ingestComment`). Thứ tự khớp:
  1. đã có tin `(page_id, platform_message_id = mid)` → `duplicate`, không đổi gì;
  2. `metadata` là id một tin outbound `app_human|app_ai` của cùng trang (bất kể hội thoại — nhắn riêng nằm ở hội thoại bình luận);
  3. nội dung: tin outbound `app_human|app_ai` cùng trang, `platform_message_id` null, `status ∈ pending|sending|sent`, cùng chữ (đã trim), `coalesce(sending_at, queued_at)` cách `timestamp` của echo ≤120 giây; phạm vi: DM → hội thoại DM của khách (`delivery=dm`) hoặc mọi tin `private_reply` của trang; bình luận → hội thoại của luồng (`public_reply`). Nhiều tin → tin vào hàng sớm nhất.
- Khớp → gắn `platform_message_id`; `pending|sending|failed → sent` (xoá `error_code`) + phát `message.sent`; đã `sent|delivered|read` → chỉ gắn id (`message.updated` nếu đổi). Không tạo tin, không phát `message.received`, không đổi trạng thái hội thoại.
- Không khớp:
  - luồng chưa có hội thoại (hoặc bình luận của trang không trả lời bình luận nào) → `no_conversation`, không tạo gì;
  - `appId` có, danh sách app của mình không rỗng và `appId` không thuộc danh sách → `external_human` ngay;
  - còn lại: `first` → enqueue `inbox.echo_match {pageId, echo}` `startAfter` 5 giây (trả `deferred`); `retry` → `unmatched` (handler ném để pg-boss thử lại); `final` → chèn `app_unmatched` nếu `appId` thuộc app mình hoặc có `metadata`, ngược lại `external_human`.
- Chèn tin trang: `direction=outbound`, `status=sent`, `platform_message_id`, `delivery` (`dm` / `public_reply`, `reply_to_platform_id` = `parentId`), `platform_timestamp` = thời điểm echo, đính kèm như tin khách (job `inbox.fetch_attachment`), phát `message.sent`.
  - `external_human` → `applyHumanReply` (huỷ tin AI `pending`, `triage|ai|handoff|done → human` `HUMAN_REPLIED`, `ai_enabled=false`, xoá `waiting_since`).
  - `app_unmatched` → không đổi trạng thái; chỉ đẩy `last_message_at` (và xoá `waiting_since` khi `human` — đã có người trả lời).
- Queue `inbox.echo_match`: standard, `retryDelay` 5 giây, không backoff, retry 3, concurrency 5; lần chạy thứ 3 (`retryCount ≥ 2`) là `final` (lượt retry thứ tư dự phòng lỗi bất ngờ, cũng `final`).
- `webhook.route`: `messages|message_echoes` → `normalizeMessagingItem` (khách → `ingestDm`; echo → `ingestEcho`); `message_deliveries|message_reads` → `normalizeMessagingReceipt` → `inbox.markOutboundReceipt`; `page_comment` → `ingestEcho`. `no_conversation` / không có tin nào để cập nhật → `ignored`, còn lại `routed`.
- `markOutboundReceipt`: Messenger delivery (`mids`, `watermark`) → `sent → delivered`; read (`watermark`) / IG read (`mid` → mốc = `platform_timestamp` của tin đó) → `sent|delivered → read` cho tin outbound của hội thoại DM có `platform_timestamp ≤ mốc`; `mids` cập nhật được cả tin nhắn riêng. Không bao giờ hạ trạng thái; phát `message.updated` cho hội thoại có thay đổi.
- Field đăng ký: Page thêm `message_deliveries`, `message_reads`; IG thêm `messaging_seen` (cấp app, runbook). `page_credentials.webhook_subscribed_fields` lưu chuỗi field lần đăng ký thành công; worker chạy bù cả trang đã đăng ký mà chuỗi field khác hiện tại (không lỗi).
- Web: bong bóng `external_human` ghi "Bạn · ngoài app"; `app_unmatched` như tin của bạn.

**Never:**
- Không phát `message.received` cho tin của trang; không chuyển trạng thái khi khớp tin của app hoặc chèn `app_unmatched`.
- Không tạo khách/hội thoại từ tin của trang; không tải đính kèm cho echo đã khớp.
- Không xử lý sửa/thu hồi tin DM (`message_edit`, IG `is_deleted`), reaction, postback — giữ `ignored` (việc hoãn của 4.4).
- Không đổi hành vi gửi của job `inbox.send` (chỉ hưởng lợi: echo đặt `sent` trước khi retry chiếm lại).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|---|---|---|---|
| Echo Messenger khớp `metadata` | tin `app_human` `sending`, echo `metadata`=id tin | gắn `mid`, `sent`, `message.sent` một lần; không tin mới, không `message.received`; job gửi sau đó không ghi đè | |
| Echo tới sau khi job lưu id | tin `sent` có `mid` | `duplicate`, không đổi gì | |
| Khớp nội dung | IG echo không `metadata`, tin `pending` cùng chữ, cách 30 giây | gắn id, `sent` | cách 150 giây / khác chữ → không khớp |
| Echo cho tin đã `failed` `SEND_UNKNOWN` | `metadata` khớp | `sent`, xoá mã lỗi | |
| Nhắn riêng | echo DM có `metadata` của tin `private_reply` ở hội thoại bình luận | khớp, không cần hội thoại DM | |
| Bình luận của trang khớp | FB `feed` `from`=trang, trả lời bình luận gốc, tin `public_reply` `sending` cùng chữ | gắn id, `sent` | |
| Chưa khớp, app mình | `app_id` = app, không có tin khớp | lần đầu: job `inbox.echo_match` `startAfter` 5s, webhook `routed`; retry: ném; final: chèn `app_unmatched`, trạng thái giữ nguyên | tin khớp xuất hiện giữa các lần → khớp |
| Trả lời từ Business Suite | `app_id` khác, hội thoại `ai` | chèn `external_human` `sent`; `human` `HUMAN_REPLIED`, `ai_enabled=false`, tin AI `pending` bị xoá, rời "Cần xử lý" | |
| Không rõ app | comment/Threads/IG không `app_id`, không khớp | retry ×3 rồi `external_human` | |
| Không có hội thoại | echo cho khách chưa có trong Hộp thư; trang bình luận trên bài của mình | `ignored`, không tạo gì, không job | |
| Echo trùng / chạy lại | cùng `mid` hai lần | lần sau `duplicate` | |
| Đã nhận / đã xem | delivery `mids` / `watermark`; read `watermark`; IG read `mid` | `sent → delivered`; `sent|delivered → read` theo mốc; `message.updated` | tin `read` không hạ về `delivered`; không hội thoại / không tin → `ignored` |
| Đăng ký lại field | trang đã đăng ký với chuỗi field cũ | chạy bù enqueue `connections.subscribe_page`; thành công lưu chuỗi mới | trang có lỗi đăng ký → không chạy bù |
| Web | tin `external_human` | nhãn "Bạn · ngoài app" | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/webhooks.ts` -- `WEBHOOK_FIELDS` thêm field delivery/read.
- `server/src/adapters/meta/webhook-message.ts` -- `DmEcho`, `normalizeMessagingReceipt`.
- `server/src/adapters/meta/webhook-comment.ts` -- `PageComment` thay `skip from_page`.
- `server/src/modules/inbox/echo.ts` (MỚI) -- `ingestEcho`, job `inbox.echo_match`, `markOutboundReceipt`.
- `server/src/modules/inbox/ingest.ts` -- tách helper luồng bình luận + chèn đính kèm dùng chung.
- `server/src/modules/webhooks/route-job.ts` -- nhánh echo / page_comment / receipt; `appIds` trong deps.
- `server/src/modules/connections/{schema,subscribe}.ts` -- cột `webhook_subscribed_fields`, chạy bù khi field đổi; migration `drizzle-kit generate`.
- `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts` -- queue + handler `inbox.echo_match`, truyền `META_APP_ID`.
- `web/src/lib/inbox.ts`, `web/src/screens/Inbox.tsx` -- nhãn tác giả tin outbound.
- `deploy/runbook.md` -- field webhook mới.

## Tasks & Acceptance

**Execution:**
- [x] shared + adapters: field webhook, echo DM, bình luận của trang, receipt.
- [x] inbox: `ingestEcho`, `handleEchoMatchJob`, `markOutboundReceipt`; export qua `index.ts`.
- [x] webhooks: nhánh route mới, `appIds`.
- [x] connections: cột + migration, ghi chuỗi field, chạy bù khi đổi field.
- [x] queues + worker: `inbox.echo_match`.
- [x] web: nhãn "Bạn · ngoài app".
- [x] Test phủ mọi dòng matrix (`inbox-echo.test.ts`, adapter, subscribe, web helper); cập nhật test cũ về `from_page`/field.
- [x] runbook + deferred-work: gỡ mục delivered/read, cập nhật mục `TRANSIENT`.

**Acceptance Criteria:**
- Given 3 AC của epics.md Story 4.5, when `npm run check`, then đều có test và xanh.
- Given hội thoại đang `ai`, when chủ shop trả lời từ Business Suite, then không có `message.received`/`autoreply.triage` nào được kích hoạt bởi tin đó và hội thoại ở `human`.

## Implementation Notes

- **Adapter:** `normalizeMessagingItem` trả `echo` (khách = `recipient.id`, `app_id` số → chuỗi, `metadata`) thay `skip echo|from_page`; thêm `normalizeMessagingReceipt`. Bình luận FB/IG/Threads của trang → `page_comment` (bỏ `from_page` khỏi `CommentSkipReason`).
- **`inbox/echo.ts`:** `ingestEcho` (khớp id → `metadata` → nội dung), `handleEchoMatchJob` (`retryCount ≥ 2` là lần cuối), `markOutboundReceipt`. `ingest.ts` tách `commentThreadKey`, `insertAttachments` dùng chung.
- **Khớp theo nội dung bỏ qua tin `pending` chưa từng gọi Meta** (`sending_at` trống): echo không thể là của tin đó, khớp nhầm sẽ đặt `sent` và job không bao giờ gửi. Vì vậy `returnToPending` (send.ts) giữ `sending_at` — tin trả về chờ retry sau lỗi tạm vẫn khớp được (có thể đã tới khách); "Gửi lại" vẫn xoá `sending_at`.
- **Echo khớp tin `failed`** (vd `SEND_UNKNOWN`) → `sent`, xoá mã: echo là bằng chứng tin đã tới. Echo Messenger tới trước lần retry 5 giây đầu cũng chặn gửi trùng (cập nhật mục hoãn `TRANSIENT` của 4.7).
- **`app_unmatched` ở `human`** xoá `waiting_since` (không đổi trạng thái) để tin khách sau đặt mốc chờ mới.
- **App của mình** = `META_APP_ID`, `THREADS_APP_ID` (worker truyền `appIds` cho `webhook.route` và `inbox.echo_match`); chưa cấu hình → không kết luận theo `app_id`.
- **Đăng ký lại field:** migration `server/drizzle/0019_crazy_yellow_claw.sql` (`page_credentials.webhook_subscribed_fields`); `subscribedFieldsFor(platform)`; chạy bù gồm trang đã đăng ký mà chuỗi khác (trang cũ = `null` → đăng ký lại một lần). Runbook ghi field mới cần bật ở cấp app trước khi deploy.
- **Web:** `outboundAuthorLabel` — "Bạn · ngoài app" cho `external_human`.
- Test: `server/test/inbox-echo.test.ts` (22), cập nhật `meta-webhook-message|comment`, `connections-subscribe`, stub handler ở `notifications.test.ts`; web thêm 1 test. `npm run check`: server 1001, web 188, depcruise sạch. Chưa kiểm bằng Meta thật / trình duyệt (cùng lý do 4.3–4.7) — ghi ở deferred-work.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|---|---|---|
| Nhắn riêng: echo Messenger (khớp `metadata`) xử lý xong TRƯỚC khi Send API trả lời → echo đặt `sent`, job `inbox.send` thấy tin không còn `sending` nên `return` sớm, bỏ qua `linkRecipient` — `recipient_id` (chỉ có trong phản hồi Send API) không gắn vào khách của người bình luận, khách trả lời qua Messenger thành khách mới (AD-11). Race do 4.5 mở ra (trước đây echo bị bỏ). Sửa: `linkRecipient` chạy trước kiểm tra dòng (idempotent); thêm test. | thật, trung bình | patch |
| Phản hồi tự động của Meta (Instant Reply / tin vắng mặt / FAQ cấu hình trong Business Suite) về echo với `app_id` của app Meta → `other_app` → `external_human` + `HUMAN_REPLIED`, tắt AI ngay khi khách mở hội thoại. Payload không có cờ phân biệt tin tự động; cần sự kiện thật + quyết định sản phẩm trước Epic 5. | thật, trung bình | defer |

## Design Notes

Lần thử đầu chạy ngay trong `webhook.route` (đa số echo khớp tức thì). Retry hữu ích nhất khi chữ echo lệch chữ đã lưu: tới lần sau job gửi đã lưu id nền tảng nên bước 1 bắt được, không chèn trùng. Echo không có `app_id` (bình luận, Threads, có thể IG) không phân biệt được app mình hay ngoài app nên cũng thử lại; hết lượt thì coi là `external_human` (an toàn hơn: AI lùi lại thay vì chen vào chủ shop). `app_id` khác app mình là bằng chứng chắc → `external_human` ngay, không chờ 15 giây.

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, lint, depcruise, test đều xanh.
