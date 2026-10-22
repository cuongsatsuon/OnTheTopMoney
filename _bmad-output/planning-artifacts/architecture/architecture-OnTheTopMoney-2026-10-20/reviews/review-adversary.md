---
review: adversary
target: ../ARCHITECTURE-SPINE.md
lens: 'Dựng hai unit cấp dưới, mỗi unit tuân thủ từng AD theo đúng chữ, mà vẫn ghép không khớp'
date: '2026-10-20'
verdict: 'CHƯA ĐỦ ĐỂ CHIA VIỆC SONG SONG — 6 lỗ nghiêm trọng (2 lỗ gây mất bài/vòng lặp AI), 9 lỗ cao, 7 lỗ trung bình'
---

# Review phản biện — Architecture Spine OnTheTopMoney

## Kết luận

Spine tốt ở tầng "ai gọi ai" và "ai giữ token", nhưng **chưa khoá được ba chỗ ghép**:

1. **Vòng đời `post_targets`**: ai tạo, ai chuyển trạng thái, ai giữ cổng "chiến dịch tạm dừng". Mũi tên phụ thuộc (campaigns → content) làm `content` **không được phép** đọc trạng thái chiến dịch mà AD-13 lại bắt nó kiểm tra.
2. **Tin outbound và echo từ Meta**: không AD nào nói webhook echo (tin/bình luận do chính trang gửi) được nhận diện ra sao. Hai unit đúng chữ sẽ tạo ra **vòng lặp AI tự trả lời bình luận của chính nó**.
3. **Ngữ nghĩa trạng thái hội thoại ngoài sơ đồ**: trạng thái ban đầu trong 8 giây chờ, `ai_enabled` so với `state`, tin người dùng gửi ở trạng thái `ai`, trả lời trực tiếp trên Facebook, cổng "không áp dụng" so với cổng "tạm đóng".

Ngoài ra có một lỗi kỹ thuật cụ thể: `singletonKey=targetId` của pg-boss (AD-13) **chặn** việc enqueue lại khi kéo thả đổi giờ → bài không bao giờ đăng.

Mức độ: **Nghiêm trọng** = mất dữ liệu/đăng sai/đốt tiền không giới hạn; **Cao** = hai unit build ra hành vi khác nhau thấy được trên UI; **Trung bình** = lệch hợp đồng, sửa được khi tích hợp nhưng tốn công.

Đánh số AD đề xuất tiếp nối spine (AD-20 trở đi). "Siết AD-x" = sửa AD đã có.

## Bảng tổng hợp

| # | Mức | Cặp unit xung đột | Đề xuất |
|---|---|---|---|
| H1 | Nghiêm trọng | Soạn bài & lịch (kéo thả) × nền tảng jobs | Siết AD-13: `schedule_version`, singletonKey `targetId:version` |
| H2 | Nghiêm trọng | Webhook/hộp thư × AI trả lời tự động | AD-20: Nhận diện outbound/echo |
| H3 | Nghiêm trọng | Soạn bài & lịch × Chiến dịch | AD-21: Cổng giữ bài chiến dịch (`hold`), cấm content đọc campaigns |
| H4 | Nghiêm trọng | AI (ảnh) × Soạn bài × Chiến dịch | AD-22: `content.image.generate` sở hữu `media_assets`; luật đăng theo nền tảng |
| H5 | Nghiêm trọng | Hộp thư (Tiếp quản) × AI trả lời tự động | AD-23: Phiên bản trạng thái hội thoại + hàng đợi `stately` |
| H6 | Nghiêm trọng | Soạn bài × Chiến dịch (tạo slot, duyệt, huỷ) | AD-24: Bảng chuyển trạng thái `post_targets` duy nhất |
| H7 | Cao | Chiến dịch × Soạn bài (đếm "3 lỗi liên tiếp") | Siết AD-15: định nghĩa bộ đếm |
| H8 | Cao | Hộp thư × AI trả lời (trạng thái ban đầu, `ai_enabled`, cổng) | Siết AD-9 + AD-16: AD-25 |
| H9 | Cao | Hộp thư × Webhook (người dùng trả lời ngoài app) | Gộp vào AD-20/AD-25 |
| H10 | Cao | Trang & nhóm × Hồ sơ/AI × Chiến dịch (xoá nhóm, chuyển nhóm) | AD-26: Thay đổi thành viên nhóm |
| H11 | Cao | Hộp thư (nhắn riêng bình luận) × Webhook (DM mới) | Siết AD-11: liên kết định danh do Meta chứng minh |
| H12 | Cao | Kết nối Meta (FB+IG chung token) × mọi module gọi Meta | Siết AD-5: nguồn token và lan truyền ngắt kết nối |
| H13 | Cao | Hiệu suất/AI trả lời × Soạn bài (mũi tên thiếu); DTO dẫn xuất | AD-27: Mũi tên bổ sung + lớp ghép DTO chỉ đọc |
| H14 | Cao | Soạn bài × Hộp thư × Hiệu suất (`platform_post_id`) | AD-28: Dạng chuẩn id bài theo nền tảng |
| H15 | Cao | Kết nối (trạng thái trang) × Chiến dịch/Soạn bài/Trang | Siết AD-5: `pages.connection_status` là bản đọc duy nhất |
| H16 | Trung bình | AI gateway (api + worker song song) × Cài đặt | Siết AD-7: sổ cái tháng nguyên tử |
| H17 | Trung bình | Mọi module phát sự kiện × Thông báo × Realtime | Siết AD-3: payload sự kiện miền + một bộ ánh xạ realtime |
| H18 | Trung bình | Kết nối (xoá/kết nối lại trang) × mọi module có `page_id` | AD-29: Vòng đời trang (soft-delete, khoá nền tảng) |
| H19 | Trung bình | Webhook × Hộp thư (độ hạt sự kiện, verb sửa/xoá) | Siết AD-4 |
| H20 | Trung bình | Mọi endpoint có Phạm vi (thực thể nhiều trang) | Siết AD-18: luật "giao khác rỗng" |
| H21 | Trung bình | Hồ sơ (kho kiến thức) × adapters/media | Siết AD-14: file kiến thức không công khai |
| H22 | Trung bình | Kết nối (OAuth nhiều trang) × Màn chào | Siết AD-5: chọn trang sau callback |

---

## H1 — Kéo thả đổi giờ làm bài không bao giờ đăng (Nghiêm trọng)

**Unit A — Soạn bài & lịch (kéo thả):** theo AD-13, đổi `scheduled_at` rồi enqueue `publish.target` với `startAfter=scheduled_at mới`, `singletonKey=targetId`.

**Unit B — Nền tảng jobs:** cấu hình pg-boss đúng tài liệu: `singletonKey` chặn job thứ hai khi job cùng khoá còn ở trạng thái `created`. Lệnh `send` trả `null`.

**Kết quả:** job mới bị pg-boss từ chối im lặng. Job cũ chạy đúng giờ **cũ**, thấy `scheduled_at` không khớp → "bỏ qua không lỗi" (AD-13). Bài nằm `scheduled` mãi với giờ đã qua. Cả hai unit đều đúng chữ. AD-13 nhắc "phiên bản job" nhưng không định nghĩa phiên bản là gì.

Cùng họ lỗi: "bỏ qua không lỗi" khi trang không `active` để lại bài `scheduled` treo trong quá khứ (zombie) trên Lịch.

**Siết AD-13:**

- **Binds:** content, nền tảng jobs, Lịch nội dung
- **Prevents:** job đổi giờ bị nuốt; bài treo `scheduled` ở quá khứ.
- **Rule:** `post_targets.schedule_version int` tăng mỗi lần đổi `scheduled_at` hoặc rời/vào `scheduled`. Job data `{targetId, version}`, `singletonKey = targetId + ':' + version`. Job chạy: version lệch → bỏ qua im lặng (lý do duy nhất được im lặng). Mọi lý do bỏ qua khác **phải** chuyển trạng thái: trang không `active` → `failed` + `PAGE_DISCONNECTED`; bị giữ bởi chiến dịch → xem AD-21. Cron 15 phút quét `scheduled` có `scheduled_at < now() - 10 phút` mà không có job sống → enqueue lại (tự chữa).

## H2 — Echo của chính app thành tin khách mới → AI tự trả lời chính nó (Nghiêm trọng)

**Unit A — AI trả lời tự động (kênh bình luận):** AD-16 quyết `reply`; `inbox.applyAutoreplyDecision` ghi tin `ai` `status=pending`, enqueue `inbox.send`. Meta trả comment id mới.

**Unit B — Webhook & hộp thư:** AD-4 + AD-11 đúng chữ: sự kiện feed `item=comment, verb=add` → `inbox.ingest` upsert theo `(page_id, platform_message_id)`. Bình luận trả lời của trang có `parent_id` = bình luận gốc → rơi vào đúng hội thoại → phát `message.received`.

**Kết quả:** nếu Unit B không biết `from.id == page_id` là outbound, nó tạo tin "khách" → AD-16 chạy `autoreply.run` → AI trả lời câu của chính nó → **vòng lặp vô hạn**, đốt hạn mức tới 100%. Với Messenger: webhook `is_echo=true` có thể tới **trước** khi job gửi kịp lưu `platform_message_id` (đua) → upsert không thấy → chèn tin thứ hai; nếu Unit B coi echo là "người dùng gửi tin" thì `ai → ?`/`handoff → human` (AD-9) được kích hoạt sai, AI tự tắt chính nó.

Không AD nào nói echo được nhận diện thế nào, khi nào tin outbound có `platform_message_id`, ai ghi nó.

**AD-20 — Nhận diện outbound và echo**

- **Binds:** inbox, webhooks, autoreply, F2
- **Prevents:** tin trùng do echo; AI trả lời chính nó; echo của app làm đổi trạng thái hội thoại.
- **Rule:**
  - Chỉ `inbox` ghi tin outbound (người dùng, AI, nhắn riêng). Tin outbound tạo với `id` UUIDv7, `direction=outbound`, `origin ∈ app_human | app_ai`, `status=pending`, `platform_message_id=null`. Job `inbox.send` gửi kèm `metadata = message.id` khi API hỗ trợ (Messenger Send API), lưu `platform_message_id` từ phản hồi bằng `UPDATE … WHERE id=?` (idempotent).
  - `inbox.ingest` phân loại **trước** khi upsert: tác giả là chính trang (`is_echo=true`, hoặc `from.id` = id nền tảng của trang, hoặc Threads `username` = trang) ⇒ outbound.
    1. Có `metadata` khớp `messages.id` → gắn `platform_message_id`, `status=sent`. Không phát `message.received`.
    2. Không metadata nhưng `app_id` = app của mình, hoặc khớp tin `pending/sending` cùng hội thoại cùng nội dung trong 120 giây → gắn như trên. Không khớp được → job thử lại sau 5 giây, tối đa 3 lần, rồi mới chèn với `origin=app_unmatched` (không đổi trạng thái).
    3. Tác giả là trang nhưng không phải app (trả lời từ Meta Business Suite / app Facebook) → chèn `origin=external_human` và đi AD-25 (chuyển `human`).
  - `message.received` chỉ phát cho `direction=inbound`; payload có `direction` để `autoreply` lọc lần hai (phòng thủ).
  - Ràng buộc DB: `UNIQUE (page_id, platform_message_id) WHERE platform_message_id IS NOT NULL`.

## H3 — `content` phải kiểm "chiến dịch không paused" nhưng không được phép đọc `campaigns` (Nghiêm trọng)

**Unit A — Soạn bài & lịch:** AD-13 bắt job `publish.target` kiểm "chiến dịch (nếu có) không `paused`". Sơ đồ AD-1 chỉ có `campaigns → content`. Lint chặn `content` import `campaigns`. Unit A đúng chữ AD-1 bằng cách… bỏ qua kiểm tra, hoặc đọc thẳng bảng `campaigns` bằng SQL (vi phạm AD-1 nhưng lint không bắt được SQL).

**Unit B — Chiến dịch:** AD-15 tự tạm dừng bằng `status=paused` trên bảng `campaigns`; tin rằng AD-13 sẽ chặn đăng.

**Kết quả:** chiến dịch "tạm dừng" vẫn đăng bài đã `scheduled` (đúng tình huống AD-15 muốn ngăn: đăng lên trang vừa hết hạn mức/lỗi). Ngược lại nếu bị chặn bằng "bỏ qua không lỗi" thì slot treo ở quá khứ; khi "Tiếp tục", không ai định nghĩa slot đã lỡ giờ xử lý sao.

**AD-21 — Cổng giữ bài chiến dịch thuộc `content`, do `campaigns` bật/tắt**

- **Binds:** campaigns, content, AD-13, AD-15
- **Prevents:** chiến dịch tạm dừng vẫn đăng; content phụ thuộc ngược campaigns; slot lỡ giờ không ai xử lý.
- **Rule:** `post_targets.held boolean` (thuộc content). `campaigns` khi chuyển `paused` gọi `content.holdCampaignTargets(campaignId)` **trong cùng transaction**; khi "Tiếp tục" gọi `content.releaseCampaignTargets(campaignId, now)`. Job `publish.target` chỉ đọc `held` của chính dòng, không đọc `campaigns`. Release: slot chưa đăng có `scheduled_at < now` → `cancelled` với `cancel_reason=MISSED_WHILE_PAUSED` (không tính lỗi, không tự dời); slot tương lai bỏ `held`, tăng `schedule_version`, enqueue lại. Sinh nội dung (cron AD-15) bỏ qua chiến dịch `paused`. Chiến dịch `done`/xoá → `content.cancelCampaignTargets(campaignId)` (chỉ slot chưa `published`/`publishing`).

## H4 — Ai ghi `media_assets` cho ảnh AI; IG không đăng được bài không ảnh (Nghiêm trọng)

**Unit A — AI gateway:** AD-14 nói sinh ảnh là job `ai.image.generate` (tên job `<module>.<action>` ⇒ module `ai`). AD-7: chỉ `ai` gọi OpenAI. Unit A sinh ảnh, gọi `MediaStore.put()`, rồi cần chèn `media_assets` — bảng của `content`. Mũi tên `ai → base` cấm gọi `content`. Unit A chèn thẳng bằng SQL hoặc tạo bảng ảnh riêng trong `ai`.

**Unit B — Soạn bài:** sở hữu `media_assets` theo Structural Seed, đợi sự kiện `media_asset.created` để gắn ảnh vào `post_targets`.

**Unit C — Chiến dịch:** chế độ "Tự đăng" chuyển slot sang `scheduled` khi caption xong (AD-15), ảnh còn đang sinh. Slot tới giờ đăng không ảnh; trang IG → Meta từ chối (IG bắt buộc media) → `failed` → góp vào "3 lỗi liên tiếp" → chiến dịch tự dừng vì lỗi do chính app.

**AD-22 — Ảnh AI do `content` điều phối; luật đăng theo nền tảng**

- **Binds:** content, ai, campaigns, adapters/media, AD-14
- **Prevents:** hai chủ bảng ảnh; slot đăng khi ảnh chưa xong; bài IG không ảnh.
- **Rule:** Job tên `content.image.generate` (sửa AD-14). Content gọi `ai.generateImage(prompt, ctx)` — gateway chỉ trả bytes + ghi `ai_usage` — rồi `MediaStore.put()` và chèn `media_assets`, phát `media_asset.created`. `ai` không bao giờ chạm `media_assets`. Hàm duy nhất `content.assertPublishable(target)` chạy trước mọi chuyển sang `scheduled` và lúc job đăng: IG cần ≥1 ảnh đã `ready`; Threads ≤500 ký tự; FB không bắt buộc ảnh. Slot chiến dịch "có ảnh" chỉ rời `planned` khi ảnh `ready` hoặc ảnh lỗi; ảnh lỗi trên trang IG → `pending_approval` + `IMAGE_REJECTED`/`IMAGE_FAILED` (kể cả chế độ "Tự đăng"). Tỉ lệ "bài có ảnh AI" của chiến dịch không áp cho trang IG (IG luôn có ảnh) — server ép, FE hiện ghi chú.

## H5 — Tiếp quản trong lúc AI đang nghĩ; hai lượt AI song song (Nghiêm trọng)

**Unit A — Hộp thư:** người dùng bấm "Tiếp quản" ở giây 7 → `ai → human` (AD-9, đúng).

**Unit B — AI trả lời tự động:** job `autoreply.run` bắt đầu giây 8, gọi LLM 4 giây, trả `reply` → `inbox.applyAutoreplyDecision`. AD-9 nói inbox "áp dụng" quyết định, không nói phải kiểm trạng thái hiện tại. Unit A cài `applyAutoreplyDecision` chèn tin AI và enqueue gửi → AI trả lời vào hội thoại người dùng đã tiếp quản.

Thêm: AD-16 dùng `singletonKey=conversationId` nhưng không nói **chính sách hàng đợi** pg-boss. Với `standard` + singletonKey, tin khách tới trong lúc job đang chạy hoặc bị nuốt (không ai trả lời tin đó) hoặc (nếu Unit B đặt policy khác) chạy song song → hai câu trả lời.

**AD-23 — Phiên bản trạng thái hội thoại và hàng đợi autoreply**

- **Binds:** inbox, autoreply, AD-9, AD-16
- **Prevents:** AI trả lời sau khi người dùng tiếp quản; mất tin khách đến giữa lượt; hai lượt AI song song.
- **Rule:** `conversations.state_version int` tăng ở mọi chuyển trạng thái và mọi tin outbound của người. `autoreply.run` đọc `{state, state_version, last_inbound_message_id}` lúc bắt đầu; `inbox.applyAutoreplyDecision(conversationId, expectedVersion, expectedLastInboundId, decision)` dùng `UPDATE … WHERE state_version = ?`; lệch phiên bản hoặc đã có tin khách mới hơn → huỷ quyết định (ghi `autoreply_runs.outcome=superseded`), không gửi. Queue `autoreply.run` dùng policy `stately` (tối đa một job chờ + một job chạy cho mỗi singletonKey) để tin đến giữa lượt sinh đúng một lượt tiếp theo. Tiếp quản/gửi tin của người huỷ các tin AI `pending` chưa `sending` của hội thoại (`status=cancelled`).

## H6 — Ai tạo `posts`/`post_targets` cho bài thủ công và slot chiến dịch; ai chuyển trạng thái (Nghiêm trọng)

**Unit A — Soạn bài:** tạo `posts` (caption bắt buộc) + `post_targets` (FK `post_id NOT NULL`), trạng thái `draft → scheduled` trực tiếp (bài thủ công không cần duyệt).

**Unit B — Chiến dịch:** AD-15 "tạo đủ slot `post_targets(status=planned, campaign_id, topic)`". Không có `posts` để gắn → Unit B hoặc chèn `post_id=null` (phá FK của A), hoặc tạo `posts` rỗng (phá ràng buộc caption của A), hoặc chèn thẳng bảng của content (phá AD-1). Bước 4 wizard "AI tạo trước 7 bài đầu để xem" — lưu ở đâu khi chiến dịch còn `draft`? Bấm "Bắt đầu" tạo đủ 30 slot → 7 bài xem trước bị **nhân đôi** hoặc bị mất.

**Duyệt bài:** màn Chiến dịch có "Bài chờ duyệt", Lịch nội dung cũng "duyệt bài chiến dịch". Unit B dựng `POST /campaigns/:id/queue/:targetId/approve`, Unit A dựng `POST /post-targets/:id/approve`; mỗi bên kiểm điều kiện khác (giờ đã qua? chiến dịch paused? ảnh xong?).

AD-13 chỉ liệt kê trạng thái theo một chuỗi thẳng; không có cạnh `draft→scheduled`, `scheduled→draft` (bỏ lịch), từ chối/xoá bài chờ duyệt, "Tạo lại từng bài", huỷ.

**AD-24 — Bảng chuyển trạng thái `post_targets` duy nhất, một cửa tạo**

- **Binds:** content, campaigns, Lịch nội dung, Chiến dịch, F3, F4
- **Prevents:** hai đường tạo bài; hai endpoint duyệt với luật khác nhau; trạng thái không có cạnh định nghĩa.
- **Rule:**
  - Chỉ `content.createPost({source: 'manual'|'campaign', campaignId?, topic?, targets[]})` tạo `posts`/`post_targets`. `posts.caption` nullable khi `source=campaign` và chưa sinh. Slot chiến dịch = **1 post : 1 target** (mỗi trang tần suất và hồ sơ riêng); FE gom hiển thị theo giờ. Khoá duy nhất `(campaign_id, page_id, scheduled_at)` cho slot ⇒ "Bắt đầu" tạo phần còn lại idempotent, giữ nguyên 7 slot xem trước đã tạo ở bước 4 (chiến dịch `draft` được có slot).
  - Mọi đổi trạng thái qua `content.transitionTarget(targetId, action, expectedVersion)` theo bảng (thêm trạng thái `cancelled`):

    | Từ | Hành động | Tới | Ai được gọi |
    |---|---|---|---|
    | `planned` | sinh xong (duyệt trước) / AI lỗi | `pending_approval` | campaigns |
    | `planned` | sinh xong (tự đăng) | `scheduled` | campaigns |
    | `draft` | lên lịch / đăng ngay | `scheduled` | content |
    | `scheduled` | bỏ lịch | `draft` (thủ công) / `pending_approval` (chiến dịch) | content |
    | `pending_approval` | duyệt | `scheduled` | content (một endpoint, cả hai màn gọi) |
    | `pending_approval` | tạo lại | `planned` | content → campaigns sinh lại |
    | `scheduled` | job chiếm | `publishing` | worker content |
    | `publishing` | xong / lỗi cuối | `published` / `failed` | worker content |
    | `failed` | Đăng lại | `scheduled` | content |
    | mọi trạng thái chưa `publishing`/`published` | xoá/từ chối/huỷ | `cancelled` | content (campaigns qua AD-21) |

  - Duyệt yêu cầu `scheduled_at > now + 2 phút`, ngược lại trả `SCHEDULE_IN_PAST` và FE hỏi giờ mới. Mọi chuyển đều kiểm `assertPublishable` (AD-22) và `held` (AD-21). `post_targets.version` khoá lạc quan chống đua giữa cron sinh nội dung và "Tạo lại" bằng tay.

## H7 — Ai đếm "3 lần lỗi liên tiếp" và đếm cái gì (Cao)

**Unit A — Soạn bài:** AD-6 retry 5 lần; Unit A phát `post_target.failed` mỗi lần thử thất bại (đúng chữ AD-3: phát cùng transaction khi đổi trạng thái — nó ghi `error_code` mỗi lần).

**Unit B — Chiến dịch:** đếm `post_target.failed` liên tiếp theo chiến dịch → một bài lỗi tạm thời đủ dừng chiến dịch. Unit B' khác lại đếm theo **từng trang**, hoặc truy vấn 3 target gần nhất theo `scheduled_at`. Không rõ "liên tiếp" có reset khi có bài `published`, có tính `PAGE_DISCONNECTED` (đã có lý do dừng riêng), có tính slot `MISSED_WHILE_PAUSED`.

**Siết AD-15:**

- **Binds:** campaigns, content
- **Prevents:** chiến dịch dừng vì retry nội bộ; đếm hai kiểu.
- **Rule:** `post_target.failed` chỉ phát khi target vào `failed` **cuối cùng** (hết retry hoặc lỗi không retry). Payload `{targetId, campaignId, pageId, errorCode, attempt}`. Bộ đếm `campaigns.consecutive_failures` thuộc campaigns, **theo chiến dịch** (mọi trang), tăng khi nhận `failed` với `errorCode ∉ {PAGE_DISCONNECTED, TOKEN_INVALID}`; về 0 khi nhận `post_target.published` cùng chiến dịch hoặc khi "Tiếp tục". Chạm 3 → `paused`, `pause_reason=PUBLISH_FAILURES`. Handler idempotent theo `targetId` (sự kiện có thể tới hai lần).

## H8 — Trạng thái hội thoại ngoài sơ đồ: 8 giây đầu, `ai_enabled`, cổng "không áp dụng" (Cao)

Các cặp lỗ, mỗi cặp đều đúng chữ AD-9/AD-16:

- **Trạng thái lúc mới tạo.** `inbox.ingest` (Unit A) phải tạo hội thoại có `state`, nhưng chỉ `autoreply` (Unit B) biết cổng mở hay đóng, và inbox không được gọi autoreply/profiles. Unit A chọn `ai` → trang tắt AI vẫn hiện chip "AI đang trả lời" 8 giây; chọn `handoff` → mọi tin nhảy vào "Cần xử lý" rồi nhảy ra. Tương tự `done → ai|handoff`: trong 8 giây hội thoại nằm ở tab "Đã xong" với tin chưa đọc.
- **AI tắt ⇒ handoff hay human?** AD-9/AD-16: cổng đầu đóng → `handoff` `AI_OFF`. `mock.ts` cv6 (trang p8 không bật AI) ở `human`. Trang tắt AI hoặc tắt kênh bình luận (F6: minhphat.store tắt bình luận) theo AD sẽ **dồn mọi tin/bình luận vào "Cần xử lý" kèm lý do "AI tắt"** — UI lệch mock, badge vô nghĩa.
- **Cổng tạm đóng có trả lại AI không?** Sơ đồ không có `handoff → ai`. Hội thoại vào `handoff OUTSIDE_HOURS` lúc 17:59 sẽ không bao giờ được AI trả lời lại kể cả 22:00 khi chủ shop vắng — trái mục đích "Ngoài giờ làm việc". Unit B có thể chạy `autoreply.run` cho mọi `message.received` bất kể trạng thái (AD-16 không cấm) → AI trả lời vào hội thoại `handoff`/`human`.
- **`ai_enabled` so với `state`.** Mock: `handoff` có `aiEnabled=false`, `done` có `aiEnabled=true`. AD-9 chỉ đặt `aiEnabled=false` ở cạnh Tiếp quản. Nếu handoff đặt `false` mà "Đánh dấu xong" không đặt lại, cổng 1 đóng vĩnh viễn → khách đó không bao giờ được AI trả lời nữa.
- **Người dùng gửi tin khi đang `ai`** (không bấm Tiếp quản): không có cạnh. Unit A giữ `ai` → AI và người cùng trả lời.
- **Quyết định handoff có kèm chữ** (mock cv2: tin `system` rồi tin AI "nhân viên sẽ phản hồi"): thứ tự và việc `canSend` không cho gửi chưa định nghĩa. Quyết định `reply` thiếu `mode` (công khai / nhắn riêng) dù cấu hình có cả hai.

**AD-25 — Ngữ nghĩa trạng thái hội thoại đầy đủ (siết AD-9, AD-16)**

- **Binds:** inbox, autoreply, profiles, F2, F6, Hộp thư tabs
- **Prevents:** chip/tab nhấp nháy; dồn "Cần xử lý" vì AI tắt; AI trả lời hội thoại đã giao người; hội thoại kẹt `handoff` vĩnh viễn vì lý do tạm thời.
- **Rule:**
  - Thêm trạng thái nội bộ `triage`. `inbox.ingest` tạo hội thoại mới / mở lại `done` ở `triage`. `autoreply` nghe `message.received` và chạy **ngay** job `autoreply.triage` (không trễ) để chuyển `triage → ai | handoff | human`; sau đó mới tới `autoreply.run` trễ 8 giây. FE: `triage` chỉ hiện ở "Tất cả".
  - Cổng chia hai loại. **Không áp dụng** (`conversation.ai_enabled=false`, cấu hình hiệu lực tắt, kênh không bật, `CONFIG_MISSING`) → `human`, tin `system` ghi lý do, không vào handoff (vẫn hiện ở "Cần xử lý" theo luật "human + tin cuối từ khách"). **Tạm đóng** (`OUTSIDE_HOURS`, `OPENAI_KEY_MISSING`, `AI_BUDGET_EXCEEDED`, `AI_ERROR`) → `handoff` với `reasonCode` loại `transient`. **Chủ ý** (`KEYWORD`, `CUSTOMER_ASKED_HUMAN`, `AI_UNCERTAIN`) → `handoff` loại `sticky`.
  - `autoreply.run` chỉ chạy khi `state ∈ {ai, triage}` hoặc `state=handoff` với lý do `transient` và người dùng chưa gửi tin nào từ lúc handoff; khi đó cổng mở lại → `handoff → ai` (thêm cạnh). Mọi trạng thái khác → `skip`, không ghi gì.
  - `ai_enabled` chỉ đổi bởi: Tiếp quản / người gửi tin (app hoặc ngoài app) → `false` và `→ human`; công tắc "bật lại AI" → `true` và `→ ai`; "Đánh dấu xong" → `true`. Handoff **không** đổi `ai_enabled` (FE hiển thị công tắc theo `state`). Sửa mock tương ứng.
  - Quyết định: `{action: reply|handoff|skip, text?, mode?: dm|public_reply|private_reply, reasonCode?}`. `handoff` có `text`: gửi tin AI trước, tin `system` sau; `canSend` từ chối → chỉ handoff, không lưu tin AI. Thêm `CONFIG_MISSING`, `CHANNEL_OFF`, `HUMAN_REPLIED` vào enum lý do.
  - "Tin cuối từ khách" của tab "Cần xử lý" = tin không phải `system` có `created_at` lớn nhất, tính cả `external_human`.

## H9 — Người dùng trả lời trực tiếp trên Facebook (Cao)

**Unit A — Webhook:** nhận echo không phải từ app; AD-11 bảo upsert tin.

**Unit B — Hộp thư:** AD-9 chỉ nói "`handoff → human`: người dùng gửi tin". Unit B hiểu "người dùng" = gửi từ app; echo ngoài app chỉ là một tin, không đổi trạng thái → AI vẫn trả lời chen vào cuộc chat chủ shop đang tự xử lý trên điện thoại. Unit B' khác coi là `human` và tắt AI.

**Đóng bằng:** AD-20 nhánh 3 (`origin=external_human`) + AD-25 (người gửi tin ở `ai|handoff|triage` → `human`, `ai_enabled=false`, lý do `HUMAN_REPLIED`, tăng `state_version` để huỷ lượt AI đang chạy theo AD-23).

## H10 — Xoá nhóm, chuyển trang sang nhóm khác khi chiến dịch nhóm đang chạy (Cao)

**Xoá nhóm.** Unit A (Trang & nhóm, module nền `pages`) xoá `groups`, đặt `pages.group_id=null`. AD-1 cấm `pages` gọi `profiles`. Unit B (`profiles`) giữ `autoreply_configs`/`brand_profiles` `owner_type=group` mồ côi. Theo AD-8, trang không nhóm và không cấu hình riêng → `CONFIG_MISSING` — mã này **không có** trong enum lý do handoff (AD-9), không có phản ứng định nghĩa ở composer hay campaigns. Hậu quả: xoá một nhóm làm AI trả lời của mọi trang thành viên chết lặng, chiến dịch sinh lỗi.

**Chuyển nhóm khi chiến dịch đang chạy.** Unit C (Chiến dịch) đọc thành viên nhóm **sống** (`campaigns.group_id` → `pages.listByGroup`), Unit C' dùng `campaign_pages` chụp lúc bắt đầu. Với C', trang đã chuyển sang Nhóm Gia dụng vẫn đăng chủ đề "mẹo chăm da" nhưng nội dung sinh theo `resolveEffective` = **hồ sơ Nhóm Gia dụng** (AD-8 giải lúc sinh). Với C, trang mới vào nhóm tự nhận slot không ai tạo.

**AD-26 — Thay đổi thành viên nhóm**

- **Binds:** pages, profiles, campaigns, content, autoreply, F1
- **Prevents:** cấu hình mồ côi; trang mất cấu hình hiệu lực âm thầm; chiến dịch đăng giọng nhóm khác.
- **Rule:** Mọi thay đổi thành viên qua `pages.assignGroup / unassignGroup / deleteGroup`, phát trong cùng transaction `page.group_changed {pageId, fromGroupId, toGroupId}` và `group.deleted {groupId, memberPageIds}`. `profiles` xử lý: trang rời nhóm mà không có cấu hình riêng → sao chép cấu hình nhóm cũ thành cấu hình riêng (`use_own_*=true`) để hành vi không đổi; rồi xoá cấu hình của nhóm đã xoá. Trong khoảng trễ, `resolveEffective` trả `CONFIG_MISSING` và mọi consumer xử lý đồng nhất: autoreply → `human` `CONFIG_MISSING` (AD-25), composer khoá nút AI cho trang đó, campaigns tạm dừng `CONFIG_MISSING`. `campaign_pages` là ảnh chụp lúc bắt đầu; `campaigns.group_id` chỉ là nhãn. Trang có slot chiến dịch đổi nhóm → các slot chưa đăng của trang đó `cancelled` `PAGE_LEFT_GROUP`, chiến dịch chạy tiếp với các trang còn lại (hết trang → `done`). Modal F1 "Trang này sẽ chuyển khỏi…" phải liệt kê chiến dịch bị ảnh hưởng (lấy từ `campaigns.listByPage`).

## H11 — Nhắn riêng cho người bình luận sinh hội thoại DM và khách mới không liên kết (Cao)

**Unit A — Hộp thư (bình luận):** AD-10 cho "nhắn riêng một lần mỗi bình luận". Gửi Send API `recipient: {comment_id}`; tin lưu trong hội thoại `comment`.

**Unit B — Webhook (DM):** khách trả lời tin riêng trong Messenger → webhook `messaging` với PSID. AD-11: `thread_key=PSID` → hội thoại `dm` mới; `contact_identities(page, PSID)` chưa có → "định danh mới tạo khách mới". Id người bình luận trên feed khác PSID ⇒ một người thành hai khách, tin nhắn riêng nằm ở hội thoại bình luận còn câu trả lời nằm ở hội thoại DM khác. `canSend` của hội thoại DM mới đúng, nhưng lịch sử bị cắt đôi.

**Siết AD-11:**

- **Binds:** inbox, webhooks, Khách hàng
- **Prevents:** một người thành hai khách do chính app tạo ra; lịch sử nhắn riêng bị tách.
- **Rule:** Phản hồi Send API cho nhắn riêng trả `recipient_id` (PSID/IGSID). `inbox.send` gắn định danh đó vào **cùng `contact`** của người bình luận (ngoại lệ duy nhất của "định danh mới tạo khách mới": định danh do Meta chứng minh cùng người) và tạo sẵn hội thoại `dm` với `origin_conversation_id` = hội thoại bình luận; tin nhắn riêng được sao lưu tham chiếu ở cả hai (bản gốc ở `dm`, bản tham chiếu ở `comment`). `contacts` có cả id feed lẫn PSID trên cùng trang là hợp lệ.

## H12 — FB Page và IG Business dùng chung một token (Cao)

**Unit A — Kết nối:** `PAGE ||--|| PAGE_CREDENTIAL` (ER) ⇒ lưu một bản sao token Page cho trang FB và một bản cho trang IG liên kết.

**Unit B — Gọi Meta (hộp thư/soạn bài):** token Page FB bị thu hồi → lỗi 190 trên trang FB → `markDisconnected(fbPage)`. Trang IG vẫn `active` (bản sao token cũ) cho tới khi một lời gọi IG khác cũng ăn 190. Chiến dịch có trang IG không tạm dừng; "Kết nối lại" FB làm mới token FB nhưng bản sao IG vẫn hỏng.

**Siết AD-5:**

- **Rule (bổ sung):** `page_credentials` của trang IG không chứa token; có `token_source_page_id` trỏ tới trang FB liên kết. `getAccessToken(igPageId)` trả token của nguồn. `markDisconnected` và làm mới token lan truyền cho mọi trang có cùng nguồn (phát `page.disconnected` / `page.reconnected` cho từng trang). Threads có token riêng (người dùng Threads), không chia sẻ.

## H13 — Mũi tên phụ thuộc thiếu; trường dẫn xuất trong DTO không ai được phép tính (Cao)

Các cặp unit đúng chữ AD-1 nhưng không thể hoàn thành:

- **Hiệu suất × Soạn bài:** AD-17 kéo insight "theo `platform_post_id`" — cột nằm ở `post_targets` (content). Sơ đồ chỉ có `analytics → inbox, connections`. "Bài AI tạo vs bài tự viết", "Tạo bài tương tự" đều cần `posts`. Unit Hiệu suất sẽ đọc SQL thẳng hoặc nhân bản dữ liệu.
- **AI trả lời × Soạn bài:** bình luận khách "giá bao nhiêu?" dưới bài do app đăng — AI cần caption bài. `autoreply → content` không có. Hộp thư hiển thị "Bình luận dưới bài X" cũng không lấy được.
- **Chiến dịch × Kết nối:** "Bắt đầu chiến dịch" phải từ chối trang `disconnected`; `campaigns → connections` không có (xem H15).
- **DTO:** `Group.activeCampaigns` (pages không gọi campaigns), `Page.autoReply`/`Page.brandSource` (pages không gọi profiles), `Contact.handledBy` (dẫn xuất từ trạng thái hội thoại), `Page.status` (connections). Unit API của `pages` không được tính; Unit FE trông đợi chúng trong một response như `mock.ts`.

**AD-27 — Mũi tên bổ sung và lớp ghép đọc**

- **Binds:** AD-1, AD-18, analytics, autoreply, campaigns, `web/`
- **Prevents:** đọc SQL chéo module; DTO thiếu trường mà FE cần.
- **Rule:** Thêm mũi tên chỉ đọc: `analytics → content`, `autoreply → content` (`content.findTargetByPlatformPostId`, `content.getPostText`), `campaigns → pages` (đã là nền). Hội thoại `comment` lưu `platform_post_id` (cột, không FK) lúc ingest. Trường dẫn xuất xuyên module được ghép ở **lớp query của route** (`server/src/app/read-models/`): chỉ gọi hàm đọc export từ `index.ts`, không ghi, không nghiệp vụ; mỗi DTO có đúng một hàm ghép. `Page.autoReply = resolveEffective(page,'autoreply').config.enabled`; không có cột `pages.auto_reply`. Bật/tắt AI hàng loạt trên trang đang kế thừa = bật "Dùng cấu hình AI riêng" kèm đổi `enabled`, FE xác nhận.

## H14 — Id bài trên nền tảng không thống nhất (Cao)

**Unit A — Soạn bài:** đăng ảnh FB qua `/{page}/photos` → phản hồi `{id, post_id}`; Unit A lưu `id` (id ảnh) vào `platform_post_id`.

**Unit B — Webhook/hộp thư:** bình luận feed mang `post_id` dạng `{pageId}_{postId}`. **Unit C — Hiệu suất:** gọi `/{platform_post_id}/insights` với id ảnh → metric khác/không có. Liên kết bình luận ↔ bài (H13) và insight đều gãy dù ai cũng "lưu `platform_post_id`".

**AD-28 — Dạng chuẩn id bài**

- **Binds:** adapters/meta, content, inbox, analytics
- **Prevents:** ba module lưu ba dạng id cho cùng một bài.
- **Rule:** `adapters/meta` trả `PublishedRef {platformPostId, permalink}` đã chuẩn hoá: FB = `{pageId}_{postId}` (dùng `post_id` khi đăng ảnh), IG = media id của bài (không phải container id), Threads = media id sau `threads_publish`. Webhook normalizer của adapter chuẩn hoá cùng dạng trước khi tới `inbox`. Không module nào tự ghép/tách id.

## H15 — Trạng thái kết nối: ai được đọc ở đâu (Cao)

**Unit A — Kết nối:** AD-5 "trạng thái trang tính duy nhất ở `connections`" → lưu ở `page_credentials.status`.

**Unit B — Trang & nhóm:** `Page.status` (mock) trả từ bảng `pages` — Unit B thêm cột `pages.status` và tự cập nhật khi nhận `page.disconnected` → hai bản ghi trạng thái, lệch khi `page.expiring` (sự kiện "một lần mỗi chu kỳ") hoặc khi kết nối lại.

**Siết AD-5:**

- **Rule (bổ sung):** Trạng thái được **tính** chỉ ở `connections`, **lưu** ở `pages.connection_status` + `pages.connection_status_reason` qua hàm duy nhất `pages.setConnectionStatus` mà chỉ `connections` gọi (`connections → pages` hợp lệ vì pages là nền). Mọi module đọc `pages.get(pageId).connectionStatus`; không module nào giữ bản sao. Kết nối lại phát `page.reconnected`; chiến dịch không tự chạy lại; target `failed` `PAGE_DISCONNECTED` giữ nguyên, chờ "Đăng lại".

## H16 — Hạn mức AI vượt và phát cảnh báo hai lần khi chạy song song (Trung bình)

**Unit A — api (Tạo bằng AI)** và **Unit B — worker (autoreply, cron chiến dịch)** cùng gọi gateway. Mỗi bên "kiểm hạn mức theo ước tính" bằng `SUM(ai_usage)` rồi chèn — hai lượt cùng đọc 79% cùng phát `threshold_reached{80}`, hoặc cùng đọc 99% cùng gọi và vượt xa 100%. Khi người dùng tăng hạn mức giữa tháng, không ai biết đặt lại cờ "đã cảnh báo 80%", banner đỏ có thể còn.

**Siết AD-7:**

- **Rule (bổ sung):** Bảng `ai_budget_months(month, spent_vnd, reserved_vnd, alerted_80, alerted_100)` thuộc `ai`. Trước lời gọi: `UPDATE … SET reserved_vnd = reserved_vnd + est WHERE spent_vnd + reserved_vnd + est <= limit RETURNING` (0 dòng → `AI_BUDGET_EXCEEDED`). Sau lời gọi: chuyển `est` sang chi phí thật trong cùng transaction ghi `ai_usage`. Cờ cảnh báo lật bằng `UPDATE … WHERE alerted_80 = false RETURNING` → sự kiện phát đúng một lần. `settings` phát `settings.updated{keys}` khi đổi hạn mức/tỉ giá; `ai` tính lại cờ (hạ cờ nếu xuống dưới ngưỡng) và phát `ai_budget.restored` để FE bỏ banner. Chiến dịch không tự chạy lại.

## H17 — Payload sự kiện miền và ai NOTIFY (Trung bình)

AD-3 định nghĩa payload **realtime** `{type, entity, id, pageId}` nhưng không định nghĩa payload **sự kiện miền** giữa module. Unit Soạn bài phát `post_target.failed {id}`; Unit Chiến dịch cần `campaignId` và `errorCode` → phải gọi lại content (được) hoặc tự giả định payload (lệch). Unit Thông báo nghe `conversation.handed_off`; Unit Hộp thư phát `conversation.state_changed`. Ai NOTIFY: mỗi module tự gọi `NOTIFY` (AD-3 cho phép "worker/api") → có module quên, có module NOTIFY trước commit qua kết nối khác.

**Siết AD-3:**

- **Rule (bổ sung):** `packages/shared/events.ts` khai báo mỗi sự kiện kèm zod payload và cờ `realtime: boolean`. Payload tối thiểu luôn có `id`, `pageId` (nếu có), và mọi khoá mà một consumer đã biết cần (vd `post_target.*` có `campaignId`, `errorCode`; `conversation.state_changed` có `from`, `to`, `reasonCode`). Danh mục khởi điểm bắt buộc: `conversation.state_changed`, `message.received`, `message.sent`, `message.failed`, `post_target.published|failed|cancelled`, `campaign.paused|resumed|completed`, `page.connected|reconnected|disconnected|expiring|removed|group_changed`, `group.deleted`, `media_asset.created`, `ai_budget.threshold_reached|restored`, `settings.updated`. Chỉ `platform/realtime` (một subscriber chung) dịch sự kiện có `realtime=true` thành `NOTIFY`; module không tự `NOTIFY`, trừ `conversation.ai_typing`. Consumer idempotent theo `(event, id, version)`.

## H18 — Xoá trang, kết nối lại tạo trang trùng (Trung bình)

**Unit A — Kết nối:** OAuth callback gọi `pages.create` cho mỗi tài khoản được cấp. Kết nối lại cùng Fanpage → thêm một dòng `pages` mới (không có khoá duy nhất theo id nền tảng) → hội thoại, slot, metric của trang cũ mồ côi.

**Unit B — Trang & nhóm (xoá/ngắt trang):** xoá cứng `pages` → FK cascade xoá hội thoại/tin nhắn/metric; Unit khác soft-delete. Không AD nào nói.

**AD-29 — Vòng đời trang**

- **Binds:** pages, connections, mọi module có `page_id`
- **Prevents:** trang trùng khi kết nối lại; mất lịch sử khi gỡ trang.
- **Rule:** `UNIQUE (platform, platform_account_id)` trên `pages`; callback dùng `pages.upsertFromPlatform` — kết nối lại khôi phục đúng dòng cũ (xoá `removed_at`). Gỡ trang = soft-delete `removed_at`, xoá token, phát `page.removed`: content huỷ target chưa đăng (`cancelled PAGE_REMOVED`), campaigns bỏ trang khỏi chiến dịch (AD-26), inbox giữ lịch sử chỉ đọc (không gửi được: `PAGE_REMOVED`), webhook của trang đã gỡ bị bỏ sau khi lưu `webhook_events`. Không xoá cứng dữ liệu nghiệp vụ trong v1.

## H19 — Độ hạt của `webhook_events` và các verb không phải "tin mới" (Trung bình)

**Unit A — api webhook:** chống trùng theo hash của **cả body POST**. Meta gửi lại có thể gom `entry[]` khác → hash khác → xử lý trùng (cứu được nhờ upsert tin, nhưng không cứu được sự kiện không có `platform_message_id`).

**Unit B — router:** coi mọi `changes` là tin mới. Bình luận `verb=edited` (ghi đè chữ — ổn), `verb=remove`/`hide` (tạo tin rỗng?), `message_reactions`, `message_reads`, `message_deliveries`, `postback` — mỗi builder tự quyết.

**Siết AD-4:**

- **Rule (bổ sung):** api tách body thành từng mục (`entry[].messaging[]`, `entry[].changes[]`) và ghi mỗi mục một dòng `webhook_events` với khoá chống trùng của mục đó; enqueue một `webhook.route` mỗi mục. Bảng ánh xạ ở router: tin/bình luận mới → `inbox.ingest`; sửa → `inbox.updateMessageText`; xoá/ẩn → `inbox.markMessageRemoved` (giữ bản ghi, cờ `removed`); đã gửi/đã đọc → cập nhật `status` tin outbound; reaction, postback và loại khác → lưu `webhook_events`, bỏ qua ở v1. `last_customer_message_at = max(hiện tại, timestamp của Meta)` (webhook có thể tới không theo thứ tự). Webhook cho trang không có trong DB hoặc đã gỡ: lưu, không route.

## H20 — Phạm vi với thực thể nhiều trang (Trung bình)

`pages.resolveScope()` trả tập `pageId` (AD-18), nhưng chiến dịch (nhiều trang), bài (nhiều target), khách (nhiều định danh) lọc thế nào thì mỗi unit tự chọn: "mọi trang thuộc phạm vi" hay "ít nhất một trang". Chiến dịch Nhóm Mỹ phẩm sau khi một trang chuyển nhóm sẽ biến mất khỏi phạm vi ở unit này, còn ở unit kia.

**Siết AD-18:**

- **Rule (bổ sung):** Thực thể nhiều trang thuộc phạm vi khi **tập trang của nó giao tập phạm vi khác rỗng**; danh sách con (target, định danh) trong response vẫn trả đủ, FE làm mờ phần ngoài phạm vi. Lọc chiến dịch theo `campaign_pages`, không theo `campaigns.group_id`.

## H21 — File kho kiến thức bị công khai qua MediaStore (Trung bình)

**Unit A — Hồ sơ/AI trả lời:** tải "Bảng giá.pdf" (F6), tái dùng `MediaStore.put()` vì AD-14 nói "mọi ảnh/tải lên" đi qua đó. **Unit B — adapters/media:** mọi thứ qua `put()` thành URL công khai `/media/<uuid>` do Caddy phục vụ (AD-19 để `/media/*` công khai). Bảng giá, chính sách nội bộ thành công khai (khó đoán nhưng không có auth, rò qua log/referrer).

**Siết AD-14:**

- **Rule (bổ sung):** `MediaStore` chỉ cho ảnh dùng để đăng bài. File kho kiến thức lưu qua `PrivateFileStore` (thư mục không do Caddy phục vụ, hoặc bucket riêng), chỉ đọc trong server để trích văn bản; `knowledge_items` lưu văn bản đã trích + metadata file.

## H22 — OAuth trả nhiều trang: kết nối hết hay để người dùng chọn (Trung bình)

**Unit A — Kết nối:** callback nhận mọi Page/IG được cấp → tạo hết. **Unit B — Màn chào/Trang & Nhóm:** F7 "chọn Fanpage … và IG" — FE chờ một bước chọn mà backend không có API. Người có 15 Fanpage sẽ có 15 trang, 15 lần đăng ký webhook và kéo insight.

**Siết AD-5:**

- **Rule (bổ sung):** Callback lưu danh sách ứng viên (tên, nền tảng, quyền đã cấp, quyền thiếu) vào `oauth_states` (TTL 15 phút) và chuyển hướng FE tới bước chọn; `POST /api/v1/connections/confirm {stateId, accountIds[]}` mới tạo/khôi phục trang (AD-29), lưu token, enqueue đăng ký webhook trang. Kiểm quyền thiếu ở bước này để hiện modal "Chưa cấp đủ quyền…". Đăng ký `subscribed_apps` là job của `connections` (`connections.subscribe_page`), `webhooks` chỉ cập nhật `webhook_health` khi nhận sự kiện đầu tiên.

---

## Ghi chú phụ (không phải lỗ ghép, nhưng nên sửa cùng đợt)

- **Mock mâu thuẫn spine:** `campaigns.cp2` tạm dừng với lý do "sắp hết hạn token", trong khi EXPERIENCE và AD-15 nói `expiring` thì chiến dịch **vẫn chạy**. Sửa mock; `PauseReason` = `PAGE_DISCONNECTED | AI_BUDGET_EXCEEDED | PUBLISH_FAILURES | CONFIG_MISSING | MANUAL`.
- **`mock.ts` `Post.pageIds` nhiều trang có `campaignId`** (po1, po10, po12) mâu thuẫn quyết định 1 post : 1 target cho slot chiến dịch (AD-24). FE gom theo giờ khi hiển thị.
- **Chiến dịch `done`:** chưa ai đặt. Gợi ý: cron campaigns đặt `done` khi không còn slot ở `planned | pending_approval | scheduled | publishing`.
- **Bài `pending_approval` quá giờ:** giữ nguyên, Lịch hiện "Quá giờ — chọn giờ mới"; không tự huỷ (AD-24 đã chặn duyệt về quá khứ).
- **Sửa chiến dịch đang chạy** (thêm/bớt trang, đổi tần suất/chủ đề): spine im lặng. Gợi ý v1: chỉ đổi tên và chế độ; thêm/bớt trang đi qua `content.createPost`/`cancelCampaignTargets`.

## Thứ tự đóng lỗ đề xuất

1. H1, H2, H5 — sửa trước khi dựng job đăng bài và pipeline autoreply (lỗi mất bài và vòng lặp tốn tiền).
2. H3, H6, H4, H7 — chốt cùng nhau thành một AD "vòng đời post_target" trước khi tách epic Soạn bài và Chiến dịch.
3. H8, H9, H11 — chốt ngữ nghĩa hội thoại trước khi tách epic Webhook/Hộp thư và AI trả lời.
4. H12, H15, H18, H22, H10 — chốt vòng đời trang/nhóm trước epic Kết nối Meta.
5. H13, H14, H16, H17, H19–H21 — có thể chốt song song khi viết `packages/shared`.
