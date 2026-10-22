---
review: round-2
target: ../ARCHITECTURE-SPINE.md (v2)
inputs: [review-adversary.md, review-rubric.md, review-reconcile.md, review-verify-current.md]
date: '2026-10-20'
verdict: 'Gần đạt. Các phát hiện critical/high của vòng 1: 25 đóng, 8 đóng một phần, 0 chưa đóng. Spine v2 sinh thêm 5 mâu thuẫn nội bộ mức cao. Sửa xong 15 mục cuối file là đủ để chia epic.'
---

# Review vòng 2 — Architecture Spine v2

## 1. Kết luận

Spine v2 đóng gần hết các lỗ ghép của vòng 1: vòng đời `post_targets` (AD-13), echo (AD-20), cổng `held` (AD-15), `triage` và phân loại lý do (AD-9), chính sách queue (AD-24), vòng đời dữ liệu (AD-22), vòng đời trang (AD-23), ngân sách gọi Meta (AD-6), model seed, lint ranh giới.

Tuy vậy, phần viết mới lại tạo ra lệch nội bộ, chủ yếu ở bốn chỗ:

- **Retry của job**: job retry nhưng lần chạy sau không chiếm lại được bản ghi (`publish.target`, `inbox.send`).
- **Bảng queue AD-24**: còn dòng `singletonKey` trên policy `standard`, đúng lỗi mà chính AD-24 nêu ở Prevents. Bảng cũng thiếu nhiều queue mà các AD khác cần.
- **Sơ đồ trạng thái AD-9**: thiếu các cạnh mà Rule đòi.
- **Ai sở hữu file**: đính kèm của khách và logo bị gắn vào `media_assets`, là bảng của `content`, trong khi không có mũi tên phụ thuộc phù hợp. Cron dọn ảnh mồ côi sẽ xoá luôn các file này.

## 2. Đối chiếu phát hiện critical/high của vòng 1

Ký hiệu: **Đóng** · **Một phần** · **Chưa**

### review-adversary.md (Nghiêm trọng H1–H6, Cao H7–H15)

| # | Phát hiện | Spine v2 | Trạng thái | Còn hở |
|---|---|---|---|---|
| H1 | Kéo thả làm job đổi giờ bị nuốt; bài treo `scheduled` | AD-13: `schedule_version`, `standard` không singletonKey, trang không `active` → `failed`, cron 15 phút | Một phần | Job gặp `held=true` không đổi trạng thái, nên cron 15 phút enqueue lại mãi khi chiến dịch đang tạm dừng (N5) |
| H2 | Echo khiến AI tự trả lời chính nó | AD-20 | Đóng | Lần thử lại 5 giây ×3 chưa có queue (N4) |
| H3 | `content` phải kiểm chiến dịch `paused` nhưng không được đọc `campaigns` | AD-15 `held` + `holdCampaignTargets`/`releaseCampaignTargets` | Đóng | — |
| H4 | Không rõ ai ghi `media_assets` cho ảnh AI; bài IG không ảnh | AD-14 `content.image.generate`, AD-13 `assertPublishable`, AD-15 slot IG luôn có ảnh | Đóng | — |
| H5 | Tiếp quản trong lúc AI đang chạy; hai lượt AI song song | AD-9 `applyAutoreplyDecision` theo `state_version` + AD-24 `stately` | Đóng | — |
| H6 | Một cửa tạo bài, bảng chuyển trạng thái | AD-13 `createPost` + bảng | Một phần | Retry khi đang `publishing` bị kẹt (N1). Slot xem trước của chiến dịch `draft` duyệt được và đăng được trước khi bấm "Bắt đầu" (N7). Khoá duy nhất dựa trên `scheduled_at`, là trường sửa được (N8) |
| H7 | Định nghĩa "3 lỗi liên tiếp" | AD-15 + payload ở AD-3 | Đóng | — |
| H8 | Trạng thái ngoài sơ đồ: `triage`, `ai_enabled`, cổng không áp dụng / tạm đóng | AD-9, AD-16 | Một phần | Sơ đồ thiếu `ai → human` (cổng không áp dụng), `done/triage → human` (người gửi tin) (N6). `HUMAN_REPLIED` và lý do của các chuyển khác chưa nằm trong enum nào (N9) |
| H9 | Người dùng trả lời ngoài app | AD-20 `external_human` → `human` | Đóng | Cạnh `done → human` chưa có trong sơ đồ (N6) |
| H10 | Xoá nhóm / chuyển nhóm | AD-8 + AD-15 `PAGE_LEFT_GROUP` | Đóng | `PAGE_LEFT_GROUP` áp cả cho chiến dịch chọn từng trang (N14) |
| H11 | Nhắn riêng làm một người thành hai khách | AD-10/AD-11 `recipient_id`, `origin_conversation_id` | Đóng | — |
| H12 | FB và IG dùng chung token | AD-5 `token_source_page_id`, lan truyền ngắt kết nối | Đóng | — |
| H13 | Thiếu mũi tên phụ thuộc; DTO dẫn xuất không ai tính | `analytics→content`, `autoreply→content`, `app/read-models` | Đóng | Lại thiếu mũi tên mới: inbox/profiles cần `media_assets` (N2, N3) |
| H14 | Id bài không thống nhất | AD-6 `PublishedRef` | Đóng | — |
| H15 | Trạng thái kết nối đọc ở đâu | AD-5 `pages.connection_status` | Đóng | — |

### review-rubric.md (C-1, H-1…H-5)

| # | Phát hiện | Spine v2 | Trạng thái | Còn hở |
|---|---|---|---|---|
| C-1 | Xoá dữ liệu / retention / tuân thủ Meta | AD-22, AD-19 `/privacy/*`, Điều kiện ngoài | Một phần | Module không có kênh nào để báo "xoá xong phần của mình", vì không được gọi `privacy` và danh mục sự kiện không có sự kiện này. Chưa nói `deauthorize` làm gì (N12) |
| H-1 | `singletonKey` không có tác dụng nếu không khai báo policy | AD-24 | Một phần | `profiles.knowledge.extract` và dòng `connections.*…` vẫn dùng `standard` + singletonKey (N10) |
| H-2 | Ngân sách gọi Meta, ưu tiên | AD-6 `meta_rate_state`, ba hạng ưu tiên; AD-13 `PUBLISH_LIMIT_REACHED` | Đóng | Cơ chế "không tính RATE_LIMITED vào số lần retry" với pg-boss chưa nói (thấp) |
| H-3 | Echo / trả lời ngoài app | AD-20 | Đóng | — |
| H-4 | Tách Meta app theo môi trường | Structural Seed › Môi trường, `platform/config` | Đóng | — |
| H-5 | Ràng buộc nền tảng khi đăng | AD-13 `assertPublishable` + bảng ở shared | Một phần | Các mã lỗi (`MEDIA_REQUIRED`, `CAPTION_TOO_LONG`, quá số hashtag) chưa được khai báo (N11) |

### review-reconcile.md (Cao R1–R4, mâu thuẫn M1–M4)

| # | Phát hiện | Spine v2 | Trạng thái | Còn hở |
|---|---|---|---|---|
| R1 | Echo và vòng lặp tự trả lời | AD-20, AD-4 danh sách field | Đóng | — |
| R2 | Chuyển nhóm, nhóm chưa có cấu hình, Bật/Tắt AI hàng loạt | AD-8 (`awaiting_group_default`, sao chép cấu hình khi rời nhóm, bật/tắt hàng loạt) | Đóng | — |
| R3 | File kho kiến thức | AD-14 `PrivateFileStore`, AD-16 job extract + `KNOWLEDGE_TOO_LARGE` | Một phần | Cấu hình đã bật mà file trích xong sau đó làm tổng vượt 40k token thì xử lý thế nào: chưa nói (thấp) |
| R4 | Ràng buộc nền tảng | AD-13 | Một phần | Mã lỗi chưa khai báo, như H-5 |
| M1–M4 | Verify token, hai callback URL, danh sách model, ô tỉ giá | AD-12, mục "Thay đổi `web/`" | Đóng | — |

### review-verify-current.md (4 lỗi thực chất và các lỗ hổng kèm theo)

| # | Phát hiện | Spine v2 | Trạng thái | Còn hở |
|---|---|---|---|---|
| V1 | `singletonKey` / policy pg-boss | AD-24 | Một phần | Như H-1 (N10) |
| V2 | Phân loại lỗi Meta (551, subcode 1545041) | AD-6 `RECIPIENT_UNAVAILABLE`, xét subcode trước | Đóng | — |
| V3 | Model OpenAI lỗi thời | Stack: `gpt-6-luna`, `gpt-image-2.5-flare`; Organization Verification | Đóng | — |
| V4 | TS 7 không chạy được typescript-eslint | AD-1: dependency-cruiser, oxlint dự phòng | Đóng | Nên ghi rõ `parser: swc` (`@swc/core`), vì nếu dependency-cruiser parse TS bằng `tsc` thì vẫn cần API của TypeScript (thấp) |
| V-gap | Ảnh IG chỉ JPEG; poll container | AD-14 | Đóng | — |
| V-gap | Quyền Meta thiếu | Điều kiện ngoài: "chốt trong story App Review" | Một phần | Chấp nhận được. Nên ghi tối thiểu `pages_show_list`, `business_management`, `pages_manage_engagement`, `pages_read_user_content` để story không bỏ sót |
| V-gap | Threads ký webhook bằng secret nào | AD-4 [ASSUMPTION] + story xác nhận | Đóng | — |

## 3. Mâu thuẫn nội bộ mới trong spine v2

### N1 — Retry của `publish.target` và `inbox.send` không chiếm lại được bản ghi (Cao)
- AD-13: job chiếm bản ghi bằng `UPDATE … WHERE status='scheduled' AND schedule_version=?`, rồi chuyển sang `publishing`. AD-24 cho `publish.target` retry 5 lần. Lần retry sau lỗi `TRANSIENT` gặp bản ghi đang `publishing`, câu UPDATE không khớp, bài kẹt `publishing` mãi. Cron 15 phút chỉ quét `scheduled`, nên tiến trình chết giữa chừng cũng để lại bản ghi `publishing` mồ côi.
- AD-24/AD-20: `inbox.send` chống trùng bằng `UPDATE … WHERE status='pending'`. Lần retry gặp `sending`, nên dừng. "Gửi lại" (AD-10) tạo job mới cho tin đang `failed`, câu UPDATE cũng không khớp.

### N2 — Đính kèm của khách trỏ vào `media_assets`, bảng của `content` (Cao)
- AD-11 viết: tải đính kèm về "`MediaStore` riêng tư", và `messages.attachments[]` trỏ `media_asset_id`.
- AD-14 lại nói `MediaStore` là kho công khai, đính kèm phải đi `PrivateFileStore`, và `content` sở hữu `media_assets`.
- Sơ đồ phụ thuộc không có mũi tên `inbox → content`.
- Cron AD-14 xoá `media_assets` "chưa gắn vào bài nào quá 7 ngày", nên mọi đính kèm của khách sẽ bị xoá sau 7 ngày.

### N3 — Logo nằm trong `MediaStore` nhưng `profiles` không được ghi `media_assets` (Trung bình)
AD-14 nói `MediaStore` công khai dùng cho ảnh đăng bài **và logo**. Logo thuộc `brand_profiles` (module profiles), mà sơ đồ chỉ có `content → profiles`, không có chiều ngược lại. Nếu logo là một `media_asset` thì cron mồ côi cũng xoá logo, vì logo không gắn vào bài nào.

### N4 — Bảng queue AD-24 thiếu queue mà các AD khác cần (Cao)
AD-24 quy định "không tạo queue ngoài file này". Các thứ sau được dùng ở AD khác nhưng không có dòng trong bảng:
- **Queue nhận sự kiện:** với pg-boss, `publish` chỉ đến được queue đã `subscribe`. Thiếu: `platform/realtime` (AD-3); `notifications`; `campaigns` nghe `page.disconnected`, `post_target.*`, `ai_budget.*`, `page.group_changed/removed`; `profiles` nghe `page.group_changed`, `group.deleted`; `ai` nghe `settings.updated`; handler xoá dữ liệu của từng module nghe `privacy.purge_requested` (AD-22); `autoreply` nghe `message.received`.
- **Cron:** health webhook 5 phút (`webhooks.*`, AD-4); quét lại `scheduled` 15 phút và dọn media 7 ngày (`content.*`, AD-13/AD-14); retention (`autoreply_runs`, `webhook_events`, `sessions`, AD-22).
- **Thử lại khớp echo** 5 giây ×3 (AD-20): đi queue nào? Nếu dùng retry của `webhook.route` (backoff mũ, 5 lần) thì không khớp "5 giây ×3".

### N5 — `held` là lý do bỏ qua im lặng thứ hai, và cron enqueue lại mãi (Cao)
AD-13 viết "version lệch → bỏ qua im lặng (lý do **duy nhất** được im lặng)", nhưng ngay sau đó `held=true → không đăng`, mà không chuyển trạng thái nào. Bản ghi vẫn `scheduled` ở quá khứ. Cron 15 phút thấy "không có job sống", enqueue lại, rồi lặp lại suốt thời gian chiến dịch tạm dừng.

### N6 — Sơ đồ trạng thái AD-9 thiếu cạnh mà Rule đòi (Cao)
- Rule: cổng **không áp dụng** (`AI_OFF`, `CHANNEL_OFF`, `CONFIG_MISSING`) → `human`. Sơ đồ chỉ có cạnh này từ `triage`. Hội thoại đang `ai`, hoặc `handoff` transient, mà người dùng tắt AI của trang thì `autoreply.run` gặp `AI_OFF` nhưng không có cạnh `ai → human`. Người làm sẽ chọn `ai → handoff`, trái với phân loại.
- Rule (AD-9, AD-20): người dùng gửi tin, trong app hoặc `external_human`, thì → `human`. Sơ đồ thiếu `done → human` (chủ shop chủ động nhắn khách đã xong) và `triage → human`.
- Không có cạnh từ `handoff` khi bấm "bật lại AI", trong khi handoff giữ nguyên `ai_enabled`. Cần nói rõ công tắc ở `handoff` làm gì.

### N7 — Slot xem trước của chiến dịch `draft` duyệt được và đăng được trước "Bắt đầu" (Cao)
AD-15: `campaigns.preview` sinh 7 slot `pending_approval` khi chiến dịch còn `draft`. AD-13: duyệt là một endpoint chung cho Lịch và Chiến dịch, chỉ kiểm giờ, `assertPublishable` và `held`. `held` chỉ được đặt khi chiến dịch tạm dừng, nên bài xem trước có thể được duyệt và đăng thật khi người dùng chưa bấm "Bắt đầu". Ngược lại, ở chế độ "Tự đăng", 7 slot này "giữ nguyên" `pending_approval` sau "Bắt đầu", trái với chế độ đã chọn.

### N8 — Khoá idempotent của slot dựa trên trường sửa được (Trung bình)
Khoá `(campaign_id, page_id, scheduled_at)` vừa dùng để "Bắt đầu" tạo slot idempotent, vừa bị kéo thả đổi `scheduled_at` (AD-13). Kéo một slot xem trước sang giờ khác rồi bấm "Bắt đầu" sẽ sinh thêm slot ở giờ gốc, thành 8 bài. Kéo hai slot cùng trang về cùng giờ thì vi phạm unique.

### N9 — Mã lý do chuyển trạng thái hội thoại chưa khai báo (Cao)
- AD-9 bắt mọi chuyển trạng thái ghi tin `system` có `reasonCode`, nhưng enum `HandoffReason` chỉ có ba nhóm lý do handoff/không áp dụng. Còn thiếu: `HUMAN_REPLIED` (dùng ở AD-9 và AD-20), Tiếp quản, bật lại AI, Đánh dấu xong, `triage → ai`, `handoff → ai` khi mở lại.
- Hai cổng ở AD-16 chưa có lý do tương ứng: `conversation.ai_enabled` và `canSend`.
- Lỗi của `adapters/openai` (AD-7) chưa có bảng ánh xạ sang lý do AD-9: `PROVIDER_QUOTA`, `RATE_LIMITED`, `TRANSIENT`, `CONTENT_REJECTED` sẽ thành `AI_PROVIDER_ERROR` (transient) hay `AI_POLICY_BLOCKED` (sticky)?

### N10 — AD-24 tự mâu thuẫn với Prevents của chính nó (Cao)
Prevents ghi "`singletonKey` vô tác dụng dưới policy mặc định". Bảng vẫn có `profiles.knowledge.extract | standard | knowledgeItemId` và `connections.*, analytics.*, privacy.*, crypto.reencrypt | standard | theo thực thể`, tức đúng tổ hợp không có tác dụng đó.

### N11 — Mã lỗi được dùng nhưng chưa khai báo (Trung bình)
- `assertPublishable` (AD-13) trả "mã đó" nhưng không có tên mã nào.
- Mã lỗi đăng bài lưu ở `post_targets.error_code` chưa có danh sách và bảng ánh xạ từ loại lỗi adapter, khác với AD-10 đã có cho gửi tin. AD-15 loại trừ `TOKEN_INVALID`, vốn là loại lỗi adapter chứ không phải `ErrorCode`.
- `cancel_reason` chưa có enum: `MISSED_WHILE_PAUSED`, `PAGE_LEFT_GROUP`, `PAGE_REMOVED`, xoá, từ chối, xoá chiến dịch.
- `OPENAI_KEY_MISSING` cần cho state "Chưa nhập khoá OpenAI" nhưng AD-7 chỉ có `OPENAI_KEY_INVALID`.
- `IMAGE_FAILED` chưa có (AD-15 nhắc "ảnh lỗi").
- `PERMISSION_MISSING` (loại lỗi adapter, AD-6) và `PERMISSIONS_MISSING` (ErrorCode, AD-23) gần trùng tên, dễ nhầm.

### N12 — AD-22: module không báo được "xoá xong" (Trung bình)
AD-1 cấm module gọi `privacy`, AD-22 yêu cầu module "báo hoàn tất", nhưng danh mục AD-3 chỉ có `privacy.purge_requested|purge_completed`. `privacy` cũng không biết "đủ" là đủ những module nào. Phạm vi `contact`: `autoreply` cần id hội thoại, mà nếu `inbox` xoá trước thì không còn tra được. `POST /privacy/meta/deauthorize` chưa có hành vi.

### N13 — Danh sách enum ở Conventions thiếu enum đang được dùng (Trung bình)
Thiếu: `MessageDirection`, `MessageStatus` (`pending|sending|sent|failed|cancelled`), `MessageDelivery`, `HandoffKind` (`transient|sticky`), `WebhookEventStatus`, `CancelReason`, `DeletionScope`, `DeletionStatus`, `ConfigOwnerType`, `StateChangeReason` (N9). `MessageOrigin` chưa có giá trị cho tin của khách và tin `system`.

### N14 — `page.removed` bị huỷ hai lần; `PAGE_LEFT_GROUP` mâu thuẫn "group_id chỉ là nhãn" (Trung bình)
- AD-23 viết "content huỷ target chưa đăng", còn AD-15 viết campaigns huỷ slot `PAGE_REMOVED`. Hai chủ cùng làm một việc.
- AD-15 coi `campaigns.group_id` "chỉ là nhãn" và chụp `campaign_pages`, nhưng lại huỷ slot khi trang đổi nhóm, kể cả với chiến dịch chọn từng trang.

### N15 — `/healthz` không đến được api (Trung bình)
Structural Seed: Caddy chuyển `/api`, `/webhooks`, `/oauth`, `/privacy` sang api, còn lại sang SPA, nên `/healthz` rơi vào `index.html` và luôn trả 200. AD-19 cũng không liệt kê `/healthz` trong bề mặt công khai. Kèm theo: sơ đồ container thiếu `API → Pub`, trong khi ảnh và logo người dùng tải lên được ghi trong request api.

### Thấp (không đưa vào danh sách sửa ưu tiên)
- AD-7: chưa nói phần đặt trước (`reserved_vnd`) được trả lại khi lời gọi lỗi, bị Dừng, hoặc worker chết. Phần đặt trước bị kẹt dần sẽ chặn mọi lời gọi. `limit_vnd` nằm cả ở `settings` lẫn `ai_budget_months`, nên ghi rõ `ai` sao chép khi nhận `settings.updated`.
- AD-3: yêu cầu idempotent theo `(event, id, version)` nhưng payload không bắt buộc có `version`. Thiếu sự kiện khi cron chuyển slot `planned → pending_approval`, trong khi Lịch và Chiến dịch cần realtime.
- AD-13: hàng "tạo lại → planned … rồi campaigns sinh lại", nhưng `content` không gọi được `campaigns`. Cần ghi route enqueue `campaigns.generate`. Cron chỉ sinh slot trong 3 ngày tới.
- AD-16: file trích xong làm tổng vượt 40k token trong khi cấu hình đang bật (R3).
- `AiFeature.contact_summary` không có AD hay job nào. Cần định nghĩa job hoặc đưa vào Deferred.
- AD-1/Stack: dependency-cruiser nên ghi `parser: swc`.

## 4. Danh sách sửa (ưu tiên giảm dần)

1. **AD-13 + AD-20 + AD-24 (N1):** khi gặp lỗi retry được, job trả bản ghi về `scheduled`/`pending` rồi mới ném lỗi; câu chiếm cho phép `publishing`/`sending` khi khớp `jobId`. Thêm cron đưa bản ghi kẹt `publishing`/`sending` quá 15 phút về `failed` (`PUBLISH_UNKNOWN`/`SEND_UNKNOWN`, không tự đăng lại). "Gửi lại" đặt `status=pending` trước khi enqueue.
2. **AD-11 + AD-14 (N2):** đính kèm của khách lưu bằng `PrivateFileStore` trong bảng của `inbox` (`message_attachments` hoặc cột `file_key`), không dùng `media_asset_id`. Sửa chữ "MediaStore riêng tư". Cron mồ côi chỉ áp cho `media_assets` của content.
3. **AD-24 (N10):** đổi `profiles.knowledge.extract` và dòng "theo thực thể" sang policy `singleton` (hoặc `stately`), hoặc bỏ singletonKey và chống trùng bằng `UPDATE … WHERE status=…`.
4. **AD-24 (N4):** thêm nhóm dòng cho queue nhận sự kiện (`<module>.on.<event>`: realtime, notifications, campaigns, profiles, ai, autoreply, các handler purge), cron (`webhooks.health`, `content.requeue`, `content.media_gc`, các cron retention) và queue thử lại khớp echo (`inbox.echo_match`, `startAfter=5s`, tối đa 3 lần).
5. **AD-9 sơ đồ (N6):** thêm `ai → human` và `handoff → human` khi cổng không áp dụng; thêm `done → human` và `triage → human` khi người gửi tin; chốt công tắc "bật lại AI" ở `handoff` (thêm `handoff → ai` hoặc ẩn công tắc).
6. **AD-9 + Conventions (N9):** khai báo `StateChangeReason` = `HandoffReason` ∪ {`HUMAN_REPLIED`, `TAKEOVER`, `AI_REENABLED`, `MARKED_DONE`, `GATE_OPEN`}. Gán lý do cho cổng `ai_enabled` và `canSend`. Thêm bảng ánh xạ lỗi `adapters/openai` → lý do (`KEY_INVALID` → `OPENAI_KEY_UNAVAILABLE`; `PROVIDER_QUOTA`/`RATE_LIMITED`/`TRANSIENT` → `AI_PROVIDER_ERROR`; `CONTENT_REJECTED` → `AI_POLICY_BLOCKED`).
7. **AD-13 (N5):** ghi `held` là lý do bỏ qua im lặng thứ hai (job kết thúc, không đổi trạng thái); cron 15 phút lọc `held=false`; chỉ `releaseCampaignTargets` enqueue lại.
8. **AD-15 (N7):** slot xem trước tạo với `held=true`; "Bắt đầu" bỏ `held` cho 7 slot này; ở chế độ "Tự đăng", chuyển `pending_approval → scheduled` cho slot không có `error_code`.
9. **AD-7 ↔ AD-15:** sửa câu "campaigns → tạm dừng" ở AD-7 thành `AI_BUDGET_EXCEEDED` → tạm dừng, các lỗi AI khác → slot `pending_approval` + `error_code`; hoặc thêm `OPENAI_KEY_INVALID` vào `PauseReason`. Chọn một cách.
10. **AD-14 (N3):** logo lưu thẳng qua adapter `MediaStore` với `brand_profiles.logo_path`, không tạo `media_assets`; ghi rõ "`media_assets` chỉ chứa ảnh bài đăng".
11. **AD-3 + AD-22 (N12):** thêm sự kiện `privacy.purge_part_completed{requestId, module}`; `privacy` giữ danh sách cố định các module tham gia. Phạm vi `contact`: payload mang sẵn `conversationIds`, hoặc `inbox` xoá sau cùng. `deauthorize` = ngắt mọi trang + tạo yêu cầu phạm vi `all`.
12. **AD-13 + ErrorCode (N11):** khai báo mã của `assertPublishable` (`MEDIA_REQUIRED`, `CAPTION_TOO_LONG`, `TOO_MANY_HASHTAGS`), mã đăng bài kèm bảng ánh xạ loại lỗi adapter (`PUBLISH_REJECTED`, `PUBLISH_FAILED`, `RATE_LIMITED`, `PAGE_DISCONNECTED`), cùng `OPENAI_KEY_MISSING`, `IMAGE_FAILED`. Đổi `TOKEN_INVALID` ở AD-15 thành `PAGE_DISCONNECTED`. Đổi tên `PERMISSION_MISSING` của adapter để khỏi trùng `PERMISSIONS_MISSING`.
13. **Conventions › Enum (N13):** thêm `MessageDirection`, `MessageStatus`, `MessageDelivery`, `HandoffKind`, `WebhookEventStatus`, `CancelReason`, `DeletionScope`/`DeletionStatus`, `ConfigOwnerType`, `StateChangeReason`; bổ sung giá trị `customer` và `system` cho `MessageOrigin`.
14. **AD-15 (N8) + AD-23 (N14):** khoá slot đổi thành `(campaign_id, page_id, slot_at)`, với `slot_at` không đổi khi kéo thả. Chỉ `content` huỷ target khi nhận `page.removed`; `campaigns` chỉ bỏ trang khỏi `campaign_pages`. `PAGE_LEFT_GROUP` chỉ áp khi `campaigns.group_id` = nhóm cũ.
15. **AD-19 + Structural Seed (N15):** thêm `/healthz` vào bề mặt công khai và route Caddy → api; thêm mũi tên `API → Pub` vào sơ đồ container.
