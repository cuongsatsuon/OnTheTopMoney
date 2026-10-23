# Epic 4 Context: Hộp thư hợp nhất và Khách hàng

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Đưa tin nhắn Messenger, Instagram Direct, bình luận Facebook/Instagram và trả lời Threads về một Hộp thư realtime duy nhất. Chủ shop không phải mở từng ứng dụng mà vẫn không bỏ sót khách nào. Epic này dựng cổng webhook (nhận an toàn, chống trùng, tự đăng ký theo trang, theo dõi sức khoẻ) và module `inbox`. `inbox` là chủ duy nhất của khách, hội thoại, tin nhắn và trạng thái hội thoại. Trên nền đó, chủ shop tiếp quản, gửi tin đúng luật 24 giờ, dùng "Gợi ý bằng AI", quản lý khách (thẻ, giai đoạn, lịch sử, gộp) và tìm nhanh bằng ⌘K. Epic 5 (AI tự trả lời) cắm vào máy trạng thái và đường gửi tin dựng ở đây.

## Stories

- Story 4.1: Cổng nhận webhook Meta và Threads
- Story 4.2: Tự đăng ký webhook trang và theo dõi sức khoẻ webhook
- Story 4.3: Tin Messenger và Instagram Direct vào Hộp thư
- Story 4.4: Bình luận Facebook/Instagram và trả lời Threads vào Hộp thư
- Story 4.5: Nhận diện tin của chính trang (echo)
- Story 4.6: Tab Hộp thư, Tiếp quản và Đánh dấu xong
- Story 4.7: Gửi tin từ Hộp thư đúng luật 24 giờ
- Story 4.8: Gợi ý bằng AI khi trả lời
- Story 4.9: Khách hàng: danh sách, thẻ, giai đoạn, lịch sử
- Story 4.10: Tìm nhanh bằng ⌘K

## Requirements & Constraints

- Endpoint webhook trả 200 trong ≤1 giây p95. Sự kiện phải được ghi DB trước khi trả 200 để worker dừng cũng không mất. Không xử lý nghiệp vụ trong request webhook.
- Không mất và không trùng tin: nhận idempotent theo id nền tảng, tin gửi lỗi được lưu và gửi lại được.
- Tin mới hoặc trạng thái mới hiện trên trình duyệt đang mở trong ≤3 giây sau khi ghi DB. Mất kết nối realtime thì hiện "Đang kết nối lại…", tự thử lại rồi tải bù.
- Tuân thủ chính sách Meta:
  - DM chỉ gửi được trong 24 giờ kể từ tin cuối của khách.
  - Nhắn riêng người bình luận: mỗi bình luận một lần, trong 7 ngày, chỉ FB/IG.
  - Trả lời công khai luôn được, trừ khi bình luận đã bị xoá.
  - Threads chỉ có trả lời/bình luận công khai, không có DM.
  - v1 không dùng message tag (HUMAN_AGENT).
- Theo dõi sức khoẻ webhook: không có sự kiện >30 phút trong khung 08:00–22:00 giờ VN ([ASSUMPTION]), và sản phẩm đó có trang `active` → coi là ngừng nhận tin.
- Log chỉ ghi id. Không ghi nội dung tin, prompt, SĐT. Token và app secret không bao giờ lộ. Verify token webhook thì được trả đầy đủ cho người dùng.
- Mọi `/api/v1/*` cần phiên. `/webhooks/*` là route công khai.
- Danh sách có dữ liệu trang (hội thoại, khách) nhận `scope=` và giải phạm vi qua `pages.resolveScope()`. Phân trang bằng cursor `{items, nextCursor}`, mặc định 50.

## Technical Decisions

- **Sở hữu bảng (AD-1):** `webhooks` sở hữu `webhook_events`, `webhook_health`. `inbox` sở hữu `contacts`, `contact_identities`, `conversations`, `messages`, `message_attachments`. Hướng gọi: `webhooks → inbox`, `webhooks → connections`, `inbox → connections`, `inbox → ai`. Báo ngược chiều chỉ qua sự kiện. DTO xuyên module (`Contact.handledBy`, `Contact.pageIds`, badge) ghép ở `app/read-models/`.
- **Cổng webhook (AD-4):**
  - `webhook.route` chuẩn hoá qua `adapters/meta` rồi ánh xạ: tin mới → `inbox.ingest`; sửa → `inbox.updateMessageText`; xoá/ẩn → `inbox.markMessageRemoved`; đã gửi/đã đọc → cập nhật tin outbound; reaction, postback và loại khác → chỉ lưu (`ignored`).
  - Trang không có trong DB hoặc đã gỡ → lưu, không route.
  - Field tối thiểu khi đăng ký `subscribed_apps` qua job `connections.subscribe_page`: Page `messages`, `messaging_postbacks`, `message_echoes`, `feed`; IG `messages`, `comments`; Threads `replies`. Đăng ký cấp app (callback, field) là bước làm một lần, ghi trong runbook.
  - Cron `webhooks.health` chạy mỗi 5 phút, riêng cho `meta` và `threads`. Trạng thái: `waiting_first` (chưa từng nhận) · `ok` · `stalled`. Đổi trạng thái thì phát `webhook.stalled|recovered`.
- **Khoá hội thoại và định danh (AD-11):**
  - Hội thoại duy nhất theo `(page_id, channel, thread_key)`, với `channel ∈ dm|comment`. `thread_key` là PSID/IGSID với DM, là id bình luận gốc với comment (Threads: id bài trả lời gốc). Hội thoại comment lưu `platform_post_id` dạng chuẩn và `post_text_snapshot` (caption lấy một lần lúc ingest, để Epic 5 dùng).
  - Tin có `UNIQUE(page_id, platform_message_id)` khi id khác null. Hiển thị theo thứ tự `platform_timestamp`. `last_customer_message_at` chỉ tăng (`GREATEST`).
  - `contact_identities(page_id, platform_user_id)` thuộc đúng một contact. Định danh mới tạo khách mới. Ngoại lệ: `recipient_id` Meta trả về khi nhắn riêng thì gắn vào cùng contact. Gộp khách chỉ bằng tay qua `inbox.mergeContacts`.
  - Đính kèm của khách tải về `PrivateFileStore` (Cloudinary `authenticated`) lúc ingest, vì URL CDN của Meta hết hạn.
- **Máy trạng thái hội thoại (AD-9):**
  - Trạng thái: `triage|ai|handoff|human|done`. Chỉ hàm của `inbox` được chuyển trạng thái. Mỗi lần chuyển thì tăng `state_version`, ghi tin `system` kèm `reasonCode` (`StateChangeReason`), phát `conversation.state_changed {from,to,reasonCode}`.
  - Tin khách vào hội thoại mới hoặc `done` → `triage`, rồi `autoreply.triage` chạy ngay. Trước Epic 5 thì chuyển `human` với lý do `AI_OFF`.
  - Tiếp quản hoặc người dùng gửi tin (trong app hay ngoài app) → `human`, `ai_enabled=false` (`HUMAN_REPLIED`/`TAKEOVER`), và huỷ tin AI `pending` chưa gửi. Bật lại AI → `ai`, `ai_enabled=true`. "Đánh dấu xong" → `done`, `ai_enabled=true`, xoá `waiting_since`.
  - `waiting_since` được đặt khi vào `handoff`, hoặc khi `human` có tin khách chưa trả lời. Xoá khi đã trả lời hoặc `done`.
  - Tab "Cần xử lý" (và badge sidebar) gồm `handoff`, cộng `human` mà tin không phải `system` mới nhất là của khách. Sắp theo `waiting_since`. `triage` chỉ hiện ở tab "Tất cả".
  - Epic 5 áp quyết định qua `inbox.applyAutoreplyDecision(conversationId, expectedVersion, expectedLastInboundId, decision)` với khoá lạc quan.
- **Gửi tin (AD-10, AD-2):**
  - `inbox.canSend(conversationId, mode: dm|public_reply|private_reply)` là chỗ duy nhất tính cửa sổ gửi. Lỗi `OUTSIDE_WINDOW` của Meta cũng ánh xạ về cùng mã.
  - Tin outbound được lưu `pending`, job `inbox.send` enqueue trong cùng transaction. Job chiếm tin bằng `UPDATE … SET status='sending' WHERE status='pending'` và gửi kèm `metadata = messages.id`. Lỗi retry được thì trả tin về `pending` trước khi ném lỗi. Tin kẹt `sending` quá 15 phút → `failed` `SEND_UNKNOWN`, không tự gửi lại.
  - Mã lỗi gửi: `OUTSIDE_24H`, `PRIVATE_REPLY_USED`, `PRIVATE_REPLY_INVALID`, `RECIPIENT_UNAVAILABLE`, `PAGE_DISCONNECTED`, `PAGE_REMOVED`, `RATE_LIMITED`, `SEND_REJECTED`, `SEND_FAILED`, `SEND_UNKNOWN`.
  - `RATE_LIMITED` hoãn tới `blocked_until` và không tính vào số lần retry. Gửi tin dùng hạng `interactive`. Token lấy bằng `connections.getAccessToken(pageId)` ngay trước khi gọi. `TOKEN_INVALID` → `connections.markDisconnected`.
- **Echo (AD-20):**
  - Chỉ `inbox` ghi tin outbound, với `origin ∈ app_human|app_ai`.
  - `ingest` phân loại trước khi upsert. Tác giả là chính trang (`is_echo`, `from.id` của trang, username Threads của trang), và khớp `metadata`, `app_id` của app, hoặc khớp tin `pending|sending` cùng nội dung trong 120 giây → gắn id, `sent`, không phát `message.received`.
  - Chưa khớp thì job `inbox.echo_match` thử lại sau 5 giây, tối đa 3 lần, rồi chèn `app_unmatched`.
  - Echo không phải của app → `external_human`, chuyển `human` với `HUMAN_REPLIED`.
  - `message.received` chỉ phát cho tin inbound.
- **AI (AD-7, AD-8, AD-21, AD-2):**
  - "Gợi ý bằng AI" chạy trong request api qua gateway (`feature=inbox_suggest`), không qua job. Prompt dùng hồ sơ hiệu lực `profiles.resolveEffective(pageId)` và các tin gần nhất. Nút Dừng huỷ request và truyền `AbortSignal` sang OpenAI. Bản nháp đi qua `ai.checkOutput`, cụm vi phạm trả về để FE đánh dấu. Không tự gửi.
  - Tóm tắt khách (`feature=contact_summary`) chạy bằng job, kết quả đánh dấu "AI tạo".
- **Hàng đợi (AD-24):** khai báo ở `platform/jobs/queues.ts`.

  | Queue | Policy | Retry | Concurrency | Ghi chú |
  |---|---|---|---|---|
  | `webhook.route` | standard | 5, backoff | 10 | |
  | `inbox.send` | standard | 5 (không tính `RATE_LIMITED`) | 5 | |
  | `inbox.echo_match` | standard, `retryDelay` 5 giây | 3 | 5 | |
  | `connections.*` | standard | 3 | 2 | |
  | `webhooks.health` | cron | 1 | 1 | `tz: 'Asia/Ho_Chi_Minh'` |

  Job hết retry phát `job.failed`. `notifications` tạo thông báo cho `webhook.route` và `inbox.send`.
- **Tìm kiếm (AD-18):** `/api/v1/search` ghép từ `pages.search` và `inbox.searchContacts`, dùng `unaccent` + `pg_trgm` trên tên trang, tên nhóm, tên và SĐT khách. Gõ "nguyen thu ha" phải khớp "Nguyễn Thu Hà".
- **Hợp đồng `web/`:**
  - `Conversation.time/waiting` chuyển thành timestamp (`lastMessageAt`, `waitingSince`), thêm `triage` và `aiEnabled`.
  - `Stage` tiếng Việt chuyển thành `ContactStage` (`new|consulting|ordered|loyal|complaint`), FE hiển thị nhãn Việt.
  - `Contact.pageIds` và `handledBy` là trường dẫn xuất.

### Đã có, phải dùng lại

- Story 4.1 đã xong:
  - Module `webhooks`: verify HMAC trên raw body, parser Graph/Threads, `webhook_events` với dedupe key `${field}:${naturalId}`, API nhật ký/test/retry.
  - Handler `webhook.route` hiện chỉ đặt `status` và **chưa gọi `inbox`**. Story 4.3/4.4 nối vào.
  - `META_VERIFY_TOKEN` đã có trong config.
- Shared:
  - Enum đã đủ: `ConversationState`, `ConversationChannel`, `MessageOrigin`, `MessageDirection`, `MessageStatus`, `MessageDelivery`, `HandoffReason`/`HandoffKind`, `StateChangeReason`, `ContactStage`, `WebhookHealthStatus`, `WebhookProduct`.
  - `AiFeature` đã có `inbox_suggest` và `contact_summary`.
  - `ErrorCode` đã có các mã gửi tin.
  - Sự kiện `conversation.state_changed`, `message.received|sent|failed`, `webhook.stalled|recovered` đã khai báo.
  - `events.notifications` đã subscribe `conversation.state_changed`.
- Chưa có:
  - Queue và handler `connections.subscribe_page`. Story 4.2 tạo, enqueue trong confirm/kết nối lại, và chạy bù một lần cho các trang đã kết nối trước đó.
  - Bảng `webhook_health`.
  - Module `inbox`.
- Việc hoãn còn tồn:
  - GC cho `webhook_events` (chứa PII) để sang Story 9.3.
  - Nhật ký webhook chưa có "xem thêm" theo `nextCursor`.

## UX & Interaction Patterns

- **Hộp thư `/hop-thu`:**
  - Bố cục 3 cột: danh sách hội thoại 340px, khung chat co giãn, panel khách 320px.
  - Tab: Tất cả · Cần xử lý · AI đang trả lời · Đã xong. Sidebar có badge số "Cần xử lý".
  - Khi trống: "Không còn tin nhắn cần xử lý. AI đang trông giúp bạn."
- **Bong bóng chat:**
  - Khách: bên trái, nền xám nhạt.
  - Người dùng: bên phải, nền teal, chữ trắng.
  - AI: bên phải, nền tím nhạt, có nhãn "AI trả lời". Màu tím chỉ dùng cho thứ do AI làm.
  - Ghi chú hệ thống: viên thuốc vàng nhạt ở giữa khung chat, nêu lý do chuyển. Microcopy ánh xạ từ `HandoffReason`, kèm đếm thời gian chờ từ `waitingSince`.
- **Hội thoại:**
  - Công tắc "AI tự trả lời" theo từng hội thoại. "Tiếp quản" tắt AI cho tới khi bật lại.
  - Phím tắt: `⌘↵` gửi, `↑/↓` chuyển hội thoại, `T` tiếp quản.
  - Hội thoại bình luận có "Trả lời công khai" / "Nhắn riêng". Threads chỉ có "Trả lời công khai".
- **Tin lỗi:** icon đỏ + lý do + "Gửi lại", tin không mất. Microcopy theo mã lỗi:
  - `OUTSIDE_24H`: "Quá 24 giờ kể từ tin cuối của khách — Meta không cho gửi tin thường", kèm gợi ý trả lời qua bình luận hoặc gọi điện.
  - `PAGE_DISCONNECTED`: "Trang mất kết nối".
  - `RATE_LIMITED`: "Gửi quá nhanh, thử lại sau ít phút".
- **Nút AI "Gợi ý bằng AI":** hiện "AI đang viết…" ngay tại chỗ, có nút Dừng. Bản nháp điền vào ô soạn và sửa được. Thiếu khoá hoặc hết hạn mức thì nút mờ theo mã lỗi, có tooltip, nhưng vẫn gõ tay và gửi được.
- **Webhook:**
  - Hộp thư hiện banner vàng "Chưa nhận tin mới 30 phút — Kiểm tra webhook", dẫn tới Cài đặt › Webhook.
  - Cài đặt hiện "Đang chờ tin đầu tiên" hoặc "Nhận tin gần nhất: vừa xong/…".
- **Realtime:** dải xám "Đang kết nối lại…" phía trên danh sách. Client chỉ dùng sự kiện SSE để vô hiệu hoá cache rồi refetch REST.
- **Khách hàng `/khach-hang`:**
  - Danh sách lọc theo thẻ hoặc giai đoạn, nhãn giai đoạn: Mới, Đang tư vấn, Chốt đơn, Khách quen, Khiếu nại.
  - Panel khách trong Hộp thư sửa được thẻ, giai đoạn, ghi chú, SĐT.
  - Chi tiết khách hiện lịch sử mọi hội thoại, mỗi đoạn ghi rõ trang. Có "Gộp khách" và "Tóm tắt bằng AI" (nhãn chữ "AI tạo").
- **⌘K / Ctrl+K:** tìm trang, nhóm, khách, chọn kết quả thì mở đúng chỗ. "Tạo bài viết", "Đổi phạm vi" là lệnh phía FE.
- Luôn hiện icon nền tảng kèm nhãn chữ cạnh tên trang. Chip trạng thái luôn có chữ. Đang tải thì hiện skeleton đúng bố cục.

## Cross-Story Dependencies

- **Nền:** 4.1 đã xong. 4.2 cần trang đã kết nối từ Epic 2, và sửa luồng confirm/kết nối lại của `connections` để enqueue `subscribe_page`.
- **Module `inbox`:** 4.3 dựng `inbox` (bảng, `ingest`, máy trạng thái cơ bản, SSE) và nối `webhook.route`. 4.4 mở rộng `ingest` cho comment/Threads. 4.5 thêm phân loại echo vào `ingest`, và cần đường gửi của 4.7 để khớp `metadata`, nên làm sau hoặc cùng 4.7.
- **Màn và API:** 4.6 cần hội thoại từ 4.3/4.4. 4.7 cần `canSend` và cập nhật trạng thái tin outbound từ webhook (đã gửi/đã đọc). 4.8 cần `profiles.resolveEffective` (Epic 3) và AI gateway (Epic 1). 4.9 cần contacts từ 4.3, và nhận diện nhắn riêng từ 4.7 để gắn `recipient_id`. 4.10 cần `pages.search` (Epic 2) và `inbox.searchContacts` (4.9).
- **Epic sau tiêu thụ:**
  - Epic 5 dùng `message.received`, `applyAutoreplyDecision`, `canSend`, `inbox.send` (origin `app_ai`) và `post_text_snapshot`. Đến lúc đó `autoreply.triage` thay nhánh mặc định `AI_OFF`.
  - Epic 8 đọc `messages` và tin `system` để tính "Hiệu quả AI", đọc badge cho Tổng quan.
  - Epic 9 xoá khách và dọn `webhook_events`.
