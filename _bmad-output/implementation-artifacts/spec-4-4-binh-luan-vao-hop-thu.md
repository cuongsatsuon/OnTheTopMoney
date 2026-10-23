---
title: 'Story 4.4 — Bình luận Facebook/Instagram và trả lời Threads vào Hộp thư'
type: 'feature'
created: '2026-10-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'da32de1f4a92d727736e38be89af484809904f00'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 4.4 (PM duyệt), AD-4, AD-6, AD-11, AD-16">

## Intent

**Problem:** Story 4.3 mới đưa tin DM vào Hộp thư. Mục `feed`/`comments`/`replies` vẫn chỉ được đánh `routed` giả, không vào `inbox`. Ngoài ra khoá chống trùng của 4.1 làm rơi sự kiện thật: mọi bình luận IG trên cùng bài gộp về `comments:<media id>`, và sửa/xoá bình luận FB trùng khoá với lúc thêm.

**Approach:** Sửa khoá chống trùng ở parser. Thêm bộ chuẩn hoá bình luận trong `adapters/meta` (FB `feed`, IG `comments`, Threads `replies`). Mở rộng `inbox` với `ingestComment` (hội thoại `channel=comment`, `thread_key` = id bình luận gốc, lưu `platform_post_id` chuẩn), `updateMessageText`, `markMessageRemoved`/`markMessageUnhidden`, và job lấy caption bài một lần (`post_text_snapshot`). Nối `webhook.route`; mọi loại còn lại → `ignored`. Hộp thư web hiện kênh bình luận, bài được bình luận, nhãn "Đã sửa"/"Đã xoá"/"Đã ẩn" và tên người trả lời.

## Boundaries & Constraints

**Always:**
- Khoá chống trùng:
  - `feed` thêm mới (`verb=add`, không phải reaction/like) → `feed:<item>:<id>`. Sửa, xoá, ẩn, reaction → `feed:<item>:<verb>:<hash mục>`.
  - IG `comments` → `comments:<value.id>`.
  - Threads nhận thêm dạng `{values:{field,value}}`, trang = `root_post.owner_id` rồi tới `target_id` [ASSUMPTION AD-4].
- Chuẩn hoá (hàm thuần, không mạng):
  - FB `feed` `item=comment`: `add` → bình luận; `edited` → sửa; `remove` → xoá; `hide` → ẩn; `unhide` → bỏ ẩn. `item` khác → bỏ qua.
  - IG `comments`: luôn là thêm mới.
  - Threads `replies`: thêm mới; tác giả là `from.id`, nếu thiếu thì `@username`.
  - Tác giả là chính trang (FB/IG `from.id` = id trang, Threads username = `handle` trang) → bỏ qua (Story 4.5). Thiếu id bình luận/tác giả/bài → bỏ qua.
  - `parentId` = null khi bình luận nằm trực tiếp trên bài. Ảnh/video kèm bình luận → đính kèm (luồng 4.3).
  - `platformPostId` qua `normalizeWebhookPostId`. Thời điểm: `created_time`/`timestamp`, nếu thiếu thì `webhook_events.received_at`.
- `ingestComment`:
  - `thread_key` = id bình luận (gốc). Có `parentId` → lấy `thread_key` của hội thoại chứa tin `parentId` cùng trang; chưa có tin đó thì dùng `parentId`.
  - Cùng khoá luồng, chống trùng, `GREATEST` và máy trạng thái như `ingestDm`. Phát `message.received` → triage `AI_OFF`.
  - Định danh mới lấy tên/username từ payload, không enqueue `fetch_profile`.
  - Tin lưu `sender_identity_id`. Người khác trả lời trong luồng vẫn vào cùng hội thoại, mang định danh/khách riêng; khách của hội thoại không đổi.
  - Hội thoại mới lưu `platform_post_id` và enqueue `inbox.fetch_post_text`.
- `inbox.fetch_post_text` (job, retry 3):
  - đọc caption qua `adapters/meta` (FB `message`, IG `caption`, Threads `text`), token lấy bằng `connections.getAccessToken`;
  - chỉ điền khi còn trống, cắt 2.000 ký tự, phát `conversation.updated`;
  - lỗi tạm → retry. Lỗi khác, lần thử cuối, trang gỡ/mất kết nối → bỏ qua, ghi `post_text_fetched_at`.
- Sửa/xoá/ẩn/bỏ ẩn theo `(page_id, platform_message_id)`:
  - đổi tin có sẵn, ghi `edited_at` hoặc `removal`+`removed_at`, phát `message.updated`;
  - không tìm thấy tin → `ignored`, không tạo tin. Lặp lại → không đổi, không phát sự kiện;
  - `deleted` không bị `hidden` ghi đè; bỏ ẩn chỉ gỡ `hidden`. Nội dung tin được giữ.
- `webhook.route`: `messages` (4.3), `feed`, `comments`, `replies` đi nhánh ingest. Mọi loại khác (echo, postback, reaction, mentions…) → `ignored`.
- DTO:
  - `ConversationDto.post {platformPostId, text}|null`;
  - `MessageDto.editedAt`, `removal`, `sender {contactId, name}|null`;
  - sự kiện mới `conversation.updated`.

**Never:**
- Không gọi mạng trong transaction hay trong request webhook. Không log nội dung, tên khách, token.
- Không ingest sửa/xoá tin DM (Messenger `message_edit`, IG `is_deleted`): giữ `ignored`, ghi việc hoãn.
- Không làm trả lời công khai/nhắn riêng, `canSend` (4.7), hay phân loại echo (4.5). Ô soạn tin vẫn là ghi chú "Sắp có".

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|---|---|---|---|
| Bình luận FB mới | `feed` comment add, trang FB | hội thoại `comment`, `thread_key`=comment_id, `platform_post_id`=`{page}_{post}`, tin `customer`, tên từ `from.name`; `message.received`; triage → `human`; job fetch_post_text | |
| Trả lời trong luồng FB | `parent_id` = bình luận gốc đã có | cùng hội thoại; người khác → khách riêng, `sender` riêng | |
| Bình luận IG | `comments` (`id`, `media.id`, `from.username`) | hội thoại trên trang IG, `platform_post_id`=media id; hai bình luận cùng bài → hai hội thoại | |
| Trả lời Threads | `replies` (`root_post`, `replied_to`, `username`) cả hai dạng body | hội thoại `comment` trên trang Threads, `thread_key`=id trả lời gốc | |
| Trả lời lồng Threads | `replied_to` là trả lời đã có | vào hội thoại của trả lời đó | |
| Trùng | route chạy lại / Meta gửi lại | 1 tin, không sự kiện mới | |
| Sửa bình luận | `verb=edited` | cùng tin đổi `text`, `edited_at`; `message.updated`; không tin mới | |
| Xoá / ẩn / bỏ ẩn | `remove` / `hide` / `unhide` | `removal`=`deleted`/`hidden`/null; `message.updated` | |
| Sửa/xoá tin chưa có | không có tin | `ignored`, không tạo gì | |
| Bình luận của chính trang | `from.id`=trang / username Threads = handle | `ignored` | |
| Reaction, postback, echo, mentions, `item` khác | | `ignored` | |
| Trang không có/đã gỡ | | `ignored` | |
| Caption bài | fetch_post_text OK / lỗi tạm / lỗi khác | snapshot + `conversation.updated` / retry / để trống | |
| Khoá chống trùng | 2 bình luận IG cùng bài; add rồi edited cùng comment_id | khoá khác nhau | |
| Web | hội thoại comment | nhãn kênh "Bình luận Facebook/Instagram", "Trả lời Threads"; dòng bài; nhãn Đã sửa/Đã xoá/Đã ẩn; tên người trả lời khác khách | |

</frozen-after-approval>

## Code Map

- `server/src/modules/webhooks/parse.ts` -- khoá chống trùng `feed`/`comments`; dạng Threads `values`.
- `server/src/adapters/meta/webhook-comment.ts` (MỚI) -- `normalizeFeedChange`, `normalizeInstagramComment`, `normalizeThreadsReply`; export ở `index.ts`.
- `server/src/modules/inbox/schema.ts` -- `conversations.platform_post_id|post_text_snapshot|post_text_fetched_at`; `messages.sender_identity_id|edited_at|removal|removed_at`. Migration `drizzle-kit generate`.
- `server/src/modules/inbox/ingest.ts` -- lõi chung DM/comment; `ingestComment`.
- `server/src/modules/inbox/edits.ts` (MỚI) -- `updateMessageText`, `markMessageRemoved`, `markMessageUnhidden`.
- `server/src/modules/inbox/post-text.ts` (MỚI) -- job `inbox.fetch_post_text`.
- `server/src/modules/inbox/queries.ts` -- DTO mới (`post`, `editedAt`, `removal`, `sender`).
- `server/src/modules/webhooks/route-job.ts` -- nhánh `feed|comments|replies`; bỏ stub `ROUTABLE_FIELDS`.
- `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts` -- queue + handler `inbox.fetch_post_text`.
- `packages/shared/src/inbox.ts`, `enums.ts`/`events.ts` -- `MessageRemoval`, DTO, `conversation.updated`.
- `web/src/lib/inbox.ts`, `web/src/screens/Inbox.tsx` -- nhãn kênh, dòng bài, nhãn sửa/xoá/ẩn, tên người gửi.

## Tasks & Acceptance

**Execution:**
- [x] parser: khoá chống trùng + dạng Threads `values`.
- [x] adapters: chuẩn hoá bình luận FB/IG/Threads.
- [x] shared: enum, DTO, sự kiện.
- [x] inbox: schema + migration, `ingestComment`, sửa/xoá/ẩn, job caption, truy vấn.
- [x] webhooks: route nhánh bình luận; queues + worker.
- [x] web: Hộp thư hiện bình luận/Threads.
- [x] Test: parser, chuẩn hoá, ingest/route/sửa/xoá/caption/API (mọi dòng matrix), helper web.

**Acceptance Criteria:**
- Given 3 AC của epics.md Story 4.4, when `npm run check`, then đều có test và xanh.
- Given Hộp thư đang mở, when bình luận bị sửa/xoá, then hint `message.updated` làm cũ khung chat và danh sách.

## Implementation Notes

- **Migration** `server/drizzle/0017_wakeful_magik.sql` (`drizzle-kit generate`): cột mới ở `conversations`/`messages`. Có thêm hai ràng buộc: `(channel='comment') = (platform_post_id is not null)` và `(removal is null) = (removed_at is null)`. Tin trước 4.4 có `sender_identity_id` null; API lấy định danh của hội thoại thay vào, nên không cần backfill.
- **Khoá chống trùng đổi dạng:**
  - `feed:<comment_id>` thành `feed:comment:<comment_id>`;
  - IG `comments:<media id>` thành `comments:<comment id>`.
  Nếu Meta gửi lại một mục cũ đúng lúc deploy thì tạo thêm một dòng `webhook_events`, nhưng ingest vẫn chống trùng theo `(page_id, platform_message_id)`.
- **Bỏ stub `ROUTABLE_FIELDS`:** echo, postback, mentions giờ là `ignored` (trước là `routed` giả). Story 4.5 sẽ thêm nhánh echo. Test 4.1 cập nhật theo.
- **Lõi ingest chung** `ingestInbound`, dùng cho `ingestDm` và `ingestComment`. Bình luận:
  - không enqueue `fetch_profile`. Tên lấy từ payload: FB `from.name`, IG/Threads `@username`;
  - `profile_fetched_at` ghi ngay;
  - hai luồng bình luận song song của cùng người có thể tạo trùng định danh → vi phạm UNIQUE → job `webhook.route` retry.
- **Threads:**
  - định danh là `from.id` nếu có, không thì `@username`;
  - bình luận của chính trang nhận theo `pages.handle`;
  - trả lời lồng được tra qua tin cha đã có.
  Parser nhận thêm dạng `values` theo tài liệu [ASSUMPTION]. Đã ghi việc hoãn: xác nhận bằng sự kiện thật.
- **Sửa/xoá:**
  - lần sửa dùng `received_at` của webhook làm `edited_at`, vì FB không gửi thời điểm sửa. Lần sửa cũ hơn lần đã áp bị bỏ qua;
  - nội dung bị xoá/ẩn vẫn giữ; web hiện gạch ngang, mờ, kèm nhãn "Khách đã xoá"/"Đã ẩn".
- **Caption:** job `inbox.fetch_post_text` (retry 3, concurrency 2) dùng client Graph hoặc Threads của worker, phát sự kiện mới `conversation.updated`. Web không cần đổi realtime, vì entity `conversation` đã làm cũ cả danh sách và tin.
- **Web:**
  - nhãn kênh "Bình luận Facebook/Instagram", "Trả lời Threads";
  - dòng bài ở đầu khung chat;
  - tên người trả lời khác trong luồng, nhãn "Đã sửa";
  - ghi chú ô soạn theo kênh (Threads không có "Nhắn riêng").
  Chưa kiểm bằng trình duyệt, cùng lý do như 4.3 (cần mật khẩu chủ shop và trang đã kết nối). Màn đã qua typecheck, lint và test helper.
- **Việc hoãn mới:** sửa/thu hồi tin DM; xác nhận payload Threads và trường hợp bình luận FB thiếu `from`.
- `npm run check`: server 917 test, web 176 test, depcruise sạch.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|---|---|---|
| Khoá chống trùng `feed` sửa/xoá/ẩn chỉ hash mục: ẩn → bỏ ẩn → ẩn lại, hay sửa A→B→A→B, cho mục giống hệt lần trước → lần sau bị chặn như trùng, mất sự kiện (bình luận đã ẩn hiện như còn, nội dung cũ). Sửa: hash kèm `entry.time` (Meta gửi lại đúng entry vẫn cùng khoá; thêm mới vẫn `feed:<item>:<id>`); test ở `webhook-parse.test.ts`. | real, medium | patch |
| Sửa/xoá/ẩn chạy trước hoặc song song lần thêm (`webhook.route` concurrency 10; FB tự ẩn bình luận theo từ khoá gần như cùng lúc thêm) → `missing` → `ignored`, thay đổi mất; ẩn/bỏ ẩn tới lệch thứ tự không có mốc thời gian để so. | real, medium | defer |
| Trả lời Threads lồng nhiều cấp tới trước tin cha (tra cứu chạy ngoài khoá luồng) → `thread_key` = id tin cha, tách thành hội thoại riêng. | real, low–medium (payload Threads còn [ASSUMPTION]) | defer |

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, lint, depcruise, test đều xanh.
