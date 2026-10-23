---
title: 'Story 4.3 — Tin Messenger và Instagram Direct vào Hộp thư'
type: 'feature'
created: '2026-10-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '1a2772f943b50c7d58821a72a4addc7b82ac82d1'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 4.3 (PM duyệt), AD-3, AD-9, AD-11, AD-14, AD-16, AD-24">

## Intent

**Problem:** Webhook tin nhắn đã được nhận và lưu (4.1, 4.2) nhưng `webhook.route` chỉ đặt `status`: chưa có module `inbox`, chưa có khách/hội thoại/tin, Hộp thư vẫn là dữ liệu mẫu. Chủ shop chưa thấy tin Messenger/IG Direct nào trong app.

**Approach:** Dựng module `inbox` (5 bảng của AD-1) với `ingest` cho DM: định danh → khách → hội thoại `(page_id,'dm',PSID|IGSID)` → upsert tin, chạy trong một transaction có khoá theo luồng. Nối `webhook.route` → chuẩn hoá qua `adapters/meta` → `inbox.ingest`. Đính kèm và tên khách lấy bằng job riêng. Thêm module `autoreply` tối thiểu: queue `autoreply.triage` nghe `message.received`, trước Epic 5 luôn chuyển `triage → human` với `AI_OFF`. API danh sách hội thoại/tin/đính kèm. Hộp thư web đọc dữ liệu thật và refetch theo hint SSE.

## Boundaries & Constraints

**Always:**
- Chỉ mục `messages` không phải echo được ingest. `message_echoes` (Story 4.5), postback, reaction, delivery/read, tin `is_deleted`, mục thiếu `sender.id`/`mid`, mục mà người gửi là chính trang → chỉ lưu, `ignored`. Comment/feed/replies giữ hành vi 4.1 (Story 4.4).
- Trang không có trong DB hoặc đã gỡ → `ignored`, không tạo gì trong `inbox`.
- Một transaction cho mỗi tin, mở đầu bằng `pg_advisory_xact_lock` theo `(page_id,'dm',thread_key)`:
  - định danh `contact_identities(page_id, platform_user_id)` → contact; định danh mới tạo contact mới, không tự gộp;
  - hội thoại `UNIQUE(page_id, channel, thread_key)`;
  - tin `UNIQUE(page_id, platform_message_id) WHERE platform_message_id IS NOT NULL`, `ON CONFLICT DO NOTHING`. Trùng thì không đổi gì, không phát sự kiện;
  - `last_customer_message_at = GREATEST(...)`, `last_message_at = GREATEST(...)`. Hiển thị sắp theo `platform_timestamp` rồi `id`.
- Máy trạng thái (AD-9):
  - hội thoại mới hoặc `done` + tin khách → `triage` (tăng `state_version`). Trạng thái khác giữ nguyên;
  - `human` + tin khách khi `waiting_since` trống → đặt `waiting_since`.
- Phát `message.received {id: messageId, pageId, conversationId}` cho tin inbound, trong cùng transaction.
- `autoreply.triage` (standard, retry 3, concurrency 10, subscribes `message.received`) chỉ làm khi hội thoại đang `triage`. Quyết định áp qua `inbox.applyTriageDecision(conversationId, expectedVersion, {to, reasonCode})`:
  - `UPDATE … WHERE state='triage' AND state_version=?`; lệch phiên bản thì bỏ;
  - thành công: tăng `state_version`, lưu `state_reason`, ghi tin `system` có `reason_code`, đặt `waiting_since` (khách đang chờ), phát `conversation.state_changed {from,to,reasonCode, version}`.
  - Trước Epic 5: luôn `{to:'human', reasonCode:'AI_OFF'}`.
- Đính kèm: lúc ingest chèn `message_attachments(status='pending')` và enqueue `inbox.fetch_attachment` trong cùng transaction. Job:
  - tải URL bằng `adapters/meta`, chỉ host CDN Meta (`*.fbcdn.net`, `*.fbsbx.com`, `*.cdninstagram.com`), tối đa 10 MB;
  - lưu `PrivateFileStore`, `stored` + ref; phát `message.updated`;
  - `TRANSIENT`/`RATE_LIMITED` → ném để retry. MIME ngoài danh sách cho phép, quá lớn, host lạ, `MEDIA_NOT_CONFIGURED`, hết retry → `failed` + `error_code`, tin vẫn còn.
- Định danh mới → enqueue `inbox.fetch_profile` (token qua `connections.getAccessToken`, Graph `GET /{PSID|IGSID}`). Chỉ điền `contacts.name` khi còn trống, phát `contact.updated`. Lỗi không retry được → bỏ qua (tên hiển thị dự phòng ở FE).
- API (dưới phiên):
  - `GET /api/v1/conversations?scope=&cursor=&limit=`: theo `pages.resolveScope`, mới nhất trước, `{items,nextCursor}`, mặc định 50;
  - `GET /api/v1/conversations/:id`; `GET /api/v1/conversations/:id/messages?cursor=`: trang mới nhất, `items` tăng dần theo thời gian, cursor lùi về tin cũ;
  - `GET /api/v1/attachments/:id`: bytes từ `PrivateFileStore`, `Cache-Control: private`, `nosniff`.
  - Hội thoại của trang đã gỡ không trả.
- Web Hộp thư:
  - danh sách + khung chat + panel khách đọc API thật. Khoá query `['conversations',…]`, `['messages',…]`;
  - hint `message.*` và `contact.*` cũng làm cũ `conversations`;
  - dải "Đang kết nối lại…" và tải bù khi nối lại dùng cơ chế sẵn có của `lib/realtime.ts`;
  - URL đính kèm dựng theo `API_BASE` (gồm cả chế độ tách origin; CSP `media-src` thêm origin api).

**Never:**
- Không gọi mạng trong transaction hay trong request webhook.
- Không log nội dung tin, tên khách, URL đính kèm hay token.
- Không lưu URL CDN Meta lâu dài để hiển thị.
- Không tự gộp khách.
- Không làm Tiếp quản/Đánh dấu xong/bật AI/gửi tin/gợi ý AI/sửa panel khách (Story 4.6–4.9): trên dữ liệu thật các nút này hiện nhưng khoá, kèm gợi ý "Sắp có" — không giả lập thao tác trên khách thật.
- Không phát `conversation.state_changed` hay ghi tin `system` khi chỉ vào `triage`: triage là trạng thái nội bộ, được giải ngay, và `StateChangeReason` không có lý do cho bước này.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|---|---|---|---|
| Tin Messenger đầu tiên | PSID mới, trang FB active | contact + identity + hội thoại `triage` + tin `customer`; `message.received`; job fetch_profile; triage → `human` `AI_OFF` + tin `system` + `state_changed`; `waiting_since` đặt | |
| Tin IG Direct | IGSID, trang IG | như trên, hội thoại thuộc trang IG | |
| Trùng mid | route chạy lại / Meta gửi lại | 1 tin; không sự kiện mới | |
| Tới lệch thứ tự | tin cũ hơn tới sau | hiển thị theo `platform_timestamp`; `last_customer_message_at` không giảm | |
| Hội thoại `human` | tin khách mới | thêm tin, giữ `human`, `waiting_since` giữ/đặt; triage bỏ qua | |
| Hội thoại `done` | tin khách mới | `triage` → `human` `AI_OFF` | |
| Hội thoại `ai`/`handoff` | tin khách mới | giữ trạng thái (Epic 5 xử lý) | |
| Cùng người, trang khác | PSID khác trang | identity + contact riêng, không gộp | |
| Triage lệch phiên bản | `state_version` đã đổi | bỏ quyết định, không ghi | |
| Ảnh/voice | `attachments[]` URL fbcdn | `pending` → `stored` trên PrivateFileStore; `message.updated`; API trả bytes | |
| Đính kèm lỗi tạm | CDN 5xx | job retry; hết retry → `failed`, tin còn | |
| Đính kèm không lưu được | host lạ / MIME lạ / >10 MB / kho chưa cấu hình | `failed` + mã, không retry | |
| Trang không có/đã gỡ | | `webhook_events` `ignored`, không tạo hội thoại | |
| Echo/postback/reaction/xoá tin | | `ignored`, không tạo gì | |
| Tên khách | fetch_profile thành công / lỗi | điền `name` khi trống + `contact.updated` / giữ trống | |
| Phạm vi API | trang ngoài phạm vi hoặc đã gỡ | không có trong danh sách | |
| Realtime web | hint `message.received` | danh sách + khung chat refetch (≤3 giây); mất kết nối → "Đang kết nối lại…", nối lại → refetch | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/inbox.ts` (MỚI) -- DTO `ConversationDto`, `MessageDto`, `AttachmentDto`, query/response; enum `AttachmentKind`, `AttachmentStatus`. `events.ts`: thêm `message.updated`, `contact.updated`.
- `server/src/adapters/meta/webhook-message.ts` (MỚI) -- `normalizeMessagingItem` (mục `messaging` → tin DM chuẩn hoặc lý do bỏ qua) + `downloadWebhookAttachment` (allowlist host, giới hạn byte, timeout). Export ở `index.ts`.
- `server/src/adapters/media/index.ts` -- mở `PRIVATE_FILE_MIMES` cho gif/audio/video của khách (lưu `raw`).
- `server/src/modules/inbox/` (MỚI) -- `schema.ts` (5 bảng), `ingest.ts` (`ingestDm`), `state.ts` (`applyTriageDecision`, `getTriageState`), `attachments.ts` (job fetch + đọc file), `profile.ts` (job fetch_profile), `queries.ts` (list/get cho API), `index.ts`.
- `server/src/modules/autoreply/` (MỚI) -- `triage.ts` (`handleTriageEvent`: luôn `AI_OFF` trước Epic 5), `index.ts`.
- `server/src/modules/webhooks/route-job.ts` -- `messages` → normalize → `inbox.ingest`; cần `events`, `jobs` trong deps.
- `server/src/platform/jobs/queues.ts` -- `autoreply.triage`, `inbox.fetch_attachment`, `inbox.fetch_profile`; `webhook.route` poll 0,5 giây.
- `server/src/worker/main.ts` -- handler mới; `webhook.route` truyền `events`, `jobs`; `media` cho fetch_attachment.
- `server/src/app/inbox.ts` (MỚI) + `app.ts` -- route hội thoại/tin/đính kèm.
- `server/drizzle/0016_*.sql` -- `drizzle-kit generate`.
- `web/src/lib/inbox.ts` (MỚI) -- hook + helper thuần (nhãn khách, xem trước, câu lý do, URL đính kèm). `lib/api.ts`: `apiUrl()`. `lib/realtime.ts`: `message`/`contact` → `conversation`.
- `web/src/screens/Inbox.tsx` -- dữ liệu thật; nút story sau khoá.
- `deploy/hostinger/htaccess.template` -- `media-src` thêm `{{API_SRC}}`.

## Tasks & Acceptance

**Execution:**
- [x] shared: DTO inbox, enum đính kèm, 2 sự kiện mới.
- [x] adapters: chuẩn hoá mục messaging, tải đính kèm an toàn; mở MIME kho riêng tư.
- [x] inbox: schema + migration, `ingestDm`, `applyTriageDecision`, job đính kèm, job hồ sơ, truy vấn API.
- [x] autoreply: consumer `autoreply.triage` (AI_OFF).
- [x] webhooks: route `messages` → ingest; queues + worker.
- [x] app: route `/api/v1/conversations…`, `/api/v1/attachments/:id`.
- [x] web: lib inbox + realtime + `apiUrl`, Inbox dữ liệu thật; CSP `media-src`.
- [x] Test server phủ mọi dòng matrix (ingest/triage/đính kèm/hồ sơ/route/API); test thuần normalize + download; test web helper + hint.

**Acceptance Criteria:**
- Given 4 AC của epics.md Story 4.3, when `npm run check`, then đều có test và xanh.
- Given Hộp thư đang mở, when một tin khách được ingest, then hint realtime làm cũ cả danh sách và khung chat, không cần tải lại trang.

## Implementation Notes

- **Migration** `server/drizzle/0016_chemical_blockbuster.sql` (sinh bằng `drizzle-kit generate`): 5 bảng của `inbox`. FK tới `pages` để `on delete cascade` (trang chỉ soft-delete; test xoá cứng `pages` vẫn dọn được). Hội thoại trỏ `contact_identity_id`, khách suy qua định danh, nên gộp khách (4.9) chỉ cần chuyển định danh.
- **Tin `system` có `direction = null`.** `MessageDirection` chỉ có `inbound|outbound`, ràng buộc DB là `(origin='system') = (direction is null)`, và `MessageDto.direction` cho phép null.
- **Vào `triage` không phát sự kiện, không ghi tin `system`** (đúng Boundaries), nhưng vẫn tăng `state_version`. Lần chuyển `triage → human` là lần có lý do: ghi tin `system` `AI_OFF` và phát `conversation.state_changed` kèm `version`. `events.notifications` chỉ báo `to = handoff`, nên `AI_OFF` không sinh thông báo.
- **Module `autoreply`** mới, chỉ có `triage.ts`. Queue `autoreply.triage` subscribe thẳng `message.received` (AD-16), không qua `events.autoreply`. `decideTriage` luôn trả `AI_OFF`; Epic 5 sẽ thay hàm này.
- **Khoá luồng:** `pg_advisory_xact_lock(hashtextextended('inbox:<page>:<channel>:<thread>'))` dùng chung cho ingest và `applyTriageDecision`. Test 3 tin đầu tiên song song của cùng khách cho ra đúng 1 khách và 1 hội thoại.
- **Đính kèm:**
  - mở `PRIVATE_FILE_MIMES` cho gif, audio, video, lưu `raw`;
  - MIME lấy từ `Content-Type` của CDN, chuẩn hoá vài biệt danh (`image/jpg`, `audio/x-m4a`…);
  - `downloadWebhookAttachment` không theo redirect tự động: mỗi bước phải là https `*.fbcdn.net|*.fbsbx.com|*.cdninstagram.com`, cổng 443, không userinfo (chống SSRF); đọc theo luồng, cắt ở 10 MB;
  - API `GET /api/v1/attachments/:id` trả `content-disposition: attachment` cho file không phải ảnh/âm thanh/video.
- **Tên khách** (`inbox.fetch_profile`, ngoài AC nhưng cần để Hộp thư dùng được): Messenger `first_name,last_name,name`, IG `name,username`. Chỉ điền khi `contacts.name` còn trống. Lấy được tên thì phát `contact.updated`. FE dự phòng "Khách Messenger · ABCD".
- **Sự kiện mới:** `message.updated` (đính kèm xong/lỗi) và `contact.updated`. Web: hint `message.*`, `contact.*` làm cũ cả `['conversations', …]`.
- **`webhook.route`:**
  - poll 0,5 giây (trước là 2 giây mặc định) để giữ được ≤3 giây;
  - mục `messages` có `payload` rỗng hoặc lạ giờ là `ignored`, không còn `routed` giả. Test 4.1 đổi sang `comments` để kiểm nhánh "loại sẽ ingest ở story sau".
- **Web Hộp thư:**
  - danh sách/chat/panel đọc API thật (`useInfiniteQuery`, "Xem thêm hội thoại", "Tải tin cũ hơn");
  - nút Tiếp quản / Đánh dấu xong khoá với gợi ý "Sắp có"; ô soạn tin thay bằng ghi chú. Bỏ dữ liệu mẫu, gợi ý AI giả, gửi giả;
  - phạm vi trỏ tới trang/nhóm mẫu (id không phải uuid) thì không gọi server, danh sách rỗng;
  - badge sidebar "Hộp thư" đếm `needsAttention` của các hội thoại đã tải, thay số mẫu (đếm phía server để 4.6, đã ghi việc hoãn).
- **Ngày giờ VN** tự ghép từ `formatToParts`, vì `toLocaleDateString('vi-VN')` của ICU cho `12-10` trên Node.
- **Việc hoãn:** `apiUrl()` xử lý luôn mục "Helper dựng URL theo `API_ORIGIN`" của 1.3c (còn `/privacy/*` cho Epic 9). CSP Hostinger thêm origin api vào `media-src`, kèm kiểm trong `check-htaccess.sh`. Ghi 3 mục mới: đếm badge phía server, `TOKEN_INVALID` ở fetch_profile, dọn file Cloudinary khi xoá.
- **Dev:** `npm run simulate-dm -w server -- <id trang> '<nội dung>' [PSID]` ghi một mục webhook đã ký (secret ngẫu nhiên) qua `ingestWebhook`, rồi worker đưa vào Hộp thư.
- Chưa kiểm bằng trình duyệt: dev cần đặt mật khẩu chủ shop (CLI) và có trang kết nối. Màn đã qua typecheck, lint, test helper.

## Spec Change Log

## Review Triage Log

### Lượt 1 (một reviewer, review gọn) — triage
| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| `conversation.state_changed` không làm cũ `['messages', …]` → tin `system` (AI_OFF) không hiện trong hội thoại đang mở | medium | patch (`conversation: ['message']` trong ENTITY_ALSO_INVALIDATES) |

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, lint, depcruise, test đều xanh.
