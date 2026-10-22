---
type: review-reconcile
target: ../ARCHITECTURE-SPINE.md
inputs:
  - ../../../ux-designs/ux-OnTheTopMoney-2026-10-19/EXPERIENCE.md
  - ../../../../../web/src/data/mock.ts
  - ../../../../../web/src/screens/AutoReply.tsx
  - ../../../../../web/src/screens/Settings.tsx
  - ../../../../../web/src/components/BrandProfileForm.tsx
created: '2026-10-20'
---

# Đối soát: Architecture Spine và đầu vào UX / FE

## 1. Kết luận

**Verdict: CẦN SỬA trước khi khoá spine. Mức sửa: vừa phải, không phải viết lại.**

Spine phủ tốt phần lõi: webhook (AD-4), token (AD-5), AI gateway và hạn mức (AD-7), kế thừa cấu hình (AD-8), trạng thái hội thoại (AD-9), cửa sổ gửi (AD-10), đăng bài theo trang đích (AD-13), chiến dịch (AD-15), pipeline AI trả lời (AD-16). Phần lớn State Patterns và Key Flows có AD quản.

Còn hở ở các điểm mà hai unit có thể tự hiểu khác nhau:

- **Cao (4):** tin "echo" và vòng lặp AI tự trả lời chính mình (R1). Chuyển trang giữa các nhóm và Bật/Tắt AI hàng loạt phá bất biến của AD-8 (R2). File kho kiến thức: lưu ở đâu, trích chữ thế nào, khi nào kiểm 40k token (R3). Kiểm tra từng nền tảng trước khi đăng, vd IG bắt buộc có ảnh (R4).
- **Trung bình (6):** quy tắc "Webhook ngừng >30 phút" (R5). Nhắn riêng cho người bình luận (R6). Handoff kèm câu trả lời tạm (R7). Từ cấm phải được kiểm (R8). Khoá OpenAI bị thu hồi lúc đang chạy (R9). Kết quả OAuth và Kết nối lại một trang (R10).
- **Thấp (7):** R11–R17, sửa vài dòng trong AD có sẵn.
- **Mâu thuẫn trực tiếp giữa spine và FE (4):** xem mục 4.

## 2. Ma trận phủ (tóm tắt)

Ký hiệu: ✅ có AD quản · ⚠️ phủ một phần (xem R#) · ❌ không phủ · S = story-level.

| Yêu cầu đầu vào | AD | Trạng thái |
|---|---|---|
| Chưa kết nối trang → Màn chào 4 bước | AD-5, AD-12 (đủ để dẫn xuất) | S (trạng thái onboarding dẫn xuất được) |
| Chưa nhập khoá OpenAI → nút AI mờ + tooltip | AD-12 `{configured,…}`, AD-7 `OPENAI_KEY_MISSING` | ✅ |
| Khoá OpenAI sai/bị thu hồi | — | ⚠️ R9 |
| Token sắp hết hạn ≤7 ngày, chiến dịch vẫn chạy | AD-5, AD-15 | ✅ |
| Mất kết nối → chiến dịch tự tạm dừng + thông báo | AD-5, AD-15, AD-3 | ✅ |
| AI đang trả lời, chấm "đang gõ" | AD-9, AD-3 `conversation.ai_typing` | ✅ |
| Handoff: ghi chú lý do + **đếm thời gian chờ** | AD-9 (lý do có); mốc tính thời gian chờ chưa có | ⚠️ R13 |
| AI sinh lỗi / hết hạn mức → "Chờ duyệt" | AD-15, AD-7 | ✅ |
| Đăng bài lỗi → đỏ + "Đăng lại" | AD-13 | ✅ |
| Gửi tin lỗi (24h, mất kết nối, **gửi quá nhanh**) | AD-10, AD-6 | ⚠️ R14 (thiếu mã cho "gửi quá nhanh") |
| **Webhook ngừng nhận tin >30 phút "trong giờ thường có tin"** | AD-4 chỉ ghi `last_event_at` | ⚠️ R5 |
| Mất kết nối thời gian thực → nối lại, tải bù | AD-3 | ✅ |
| Hết hạn mức 100% / cảnh báo 80% | AD-7, AD-9, AD-15 | ✅ (R15: tăng hạn mức giữa tháng thì cảnh báo lại thế nào) |
| Kết nối bị huỷ / thiếu quyền / IG cá nhân | AD-5 (scopes) | ⚠️ R10 |
| Chưa đủ dữ liệu <7 ngày | AD-17 | ✅ |
| ⌘K tìm trang/nhóm/khách | — | S + quy ước tìm tiếng Việt (R17) |
| F1 gom nhóm, cảnh báo chuyển nhóm, Dùng hồ sơ riêng | AD-8 | ⚠️ R2 |
| F1 Viết thử bằng AI | AD-2 ngoại lệ, AD-7 | ✅ (R8: từ cấm) |
| F2 webhook → AI trả lời → handoff kèm câu trấn an | AD-4, AD-16, AD-9 | ⚠️ R1, R7 |
| F2 Tiếp quản, Gợi ý bằng AI, gửi tin | AD-9, AD-10, AD-2 | ✅ |
| F2 thẻ, **giai đoạn khách** | AD-11 | ⚠️ R17 (enum Stage chưa nằm trong danh sách enum) |
| F3 wizard, tỉ lệ chủ đề = 100%, slot, tự dừng | AD-15 | ✅ |
| F3 bước 4 "AI tạo trước 7 bài để xem" | — | ⚠️ R12 |
| F3 chọn đích theo nhóm: thành viên chốt hay động | — | ⚠️ R12 |
| F4 caption từng trang + 4 ảnh + tải ảnh lên | AD-8, AD-14, AD-2 | ✅ |
| F4 đăng nhiều nền tảng (ràng buộc IG/Threads) | — | ❌ R4 |
| F4 một trang lỗi, các trang khác vẫn đăng | AD-13 | ✅ |
| F5 Hiệu suất, Hiệu quả AI, Tạo bài tương tự | AD-17 | ✅ |
| F6 cấu hình AI nhóm, kho kiến thức, từ khoá, giờ, Thử AI | AD-16, AD-8 | ⚠️ R3, R6 |
| F6 "tắt riêng kênh bình luận" cho một trang | AD-8 + AD-16 (cổng kênh) | ✅ (R6: chưa định nghĩa tập kênh) |
| F7 dán khoá → app kiểm tra → "Đã kết nối" | AD-12 | ⚠️ R9 |
| F7 app tự đăng ký webhook, "Đang chờ tin đầu tiên" | AD-2 (job đăng ký webhook trang) | ⚠️ R5, R11 |
| F7 Kết nối lại đúng trang đó | AD-5 | ⚠️ R10 |
| Cài đặt › OpenAI: model chữ/ảnh, **kích thước ảnh**, hạn mức, cảnh báo 80%, bảng chi phí theo hạng mục | AD-7 | ⚠️ R15, mâu thuẫn M3 |
| Cài đặt › Webhook: URL, verify token, trạng thái, **nhật ký sự kiện**, Gửi sự kiện thử | AD-4, AD-12 | ⚠️ R11, mâu thuẫn M1, M2 |
| Cài đặt › Tài khoản Meta: theo tài khoản, ngày hết hạn | AD-5, bảng `meta_accounts` | ✅ (S: tài khoản Threads đăng nhập riêng) |
| Cài đặt › Thông báo: 4 loại bật/tắt | AD-3, `notifications`, `settings` | ✅ S |
| Bảng trang: **Thêm vào nhóm, Bật/Tắt AI hàng loạt** | AD-8 | ⚠️ R2 |
| Thẻ chiến dịch: Tạm dừng/Tiếp tục, Xoá | AD-15, AD-13 | ✅ S (dọn slot khi xoá: R12) |
| Bài trên lịch: kéo thả, bài đã đăng không kéo | AD-13 | ✅ |
| Câu hỏi mở: mỗi trang một nhóm | AD-8 chốt | ✅ |
| Câu hỏi mở: chiến dịch mặc định "Duyệt trước" | — | S |
| Câu hỏi mở: có trả lời bình luận công khai? | AD-10, AD-11 giả định có | ✅ (cần người dùng xác nhận) |

## 3. Phát hiện cần AD mới hoặc sửa AD

### R1 — Tin echo và vòng lặp tự trả lời · **Cao** · sửa AD-4/AD-11/AD-16 (hoặc thêm AD mới)

- **Nguồn:** F2 (AI trả lời), Message `from: 'human'` trong `mock.ts`, nhật ký webhook (`messages`, `feed`).
- **Spine hiện tại:** AD-16 kích hoạt từ `message.received` "(từ khách)", nhưng không quy định cách phân biệt tin của khách với tin của chính trang.
- **Vấn đề:** Meta gửi lại các tin trang đã gửi: `message_echoes` / `is_echo` trên Messenger và IG, sự kiện `feed` khi trang trả lời bình luận, reply của chính tài khoản Threads. Ingest coi những tin đó là tin khách thì AI tự trả lời chính câu của nó. Chủ shop cũng thường trả lời thẳng trên Meta Business Suite hoặc điện thoại. Spine chưa nói tin đó lưu với `from=human` không, và có tự Tiếp quản (tắt AI) hội thoại không.
- **Đề xuất (một quy tắc ở `inbox.ingest`):**
  1. Xác định người gửi bằng so sánh id người gửi với `platform_page_id` / IG user id / Threads user id của trang, cộng cờ `is_echo`. Tin của trang không bao giờ phát `message.received` cho autoreply.
  2. Tin do app gửi: lưu `platform_message_id` từ phản hồi gửi. Echo về sau upsert trùng theo AD-11 (đã có), không tạo tin mới.
  3. Echo không khớp tin nào app gửi = người dùng trả lời ngoài app. Lưu `from=human` và áp dụng như "người dùng gửi tin" trong sơ đồ AD-9 (`handoff|ai → human`, `ai_enabled=false`). [ASSUMPTION: cần người dùng xác nhận]
  4. Chốt danh sách field đăng ký webhook (`messages`, `message_echoes`, `messaging_postbacks`, `feed`; IG `messages`, `comments`; Threads `replies`) làm hằng số ở `packages/shared`. `connections` dùng hằng số này khi đăng ký, `webhooks` dùng khi định tuyến (xem R11).

### R2 — Chuyển nhóm, nhóm chưa có cấu hình, Bật/Tắt AI hàng loạt · **Cao** · sửa AD-8

- **Nguồn:** Component Patterns › Bảng trang ("Thêm vào nhóm, Bật/Tắt AI trả lời"). F1 thất bại (modal "Trang này sẽ chuyển khỏi Nhóm Gia dụng và dùng cấu hình của Nhóm Mỹ phẩm"). `mock.ts` `Page.autoReply` và `Group.autoReply`. `AutoReply.tsx initStore()`: trang nào có `autoReply` khác nhóm thì mặc nhiên là cấu hình riêng.
- **Spine hiện tại:** AD-8 nói "không nhóm → cấu hình trang bắt buộc tồn tại; thiếu → `CONFIG_MISSING`". AD-8 không nói gì về lúc trang **đổi** thành viên nhóm.
- **Các lỗ hổng:**
  1. **Gỡ trang khỏi nhóm, hoặc xoá nhóm:** trang thành "không nhóm" mà chưa có cấu hình riêng, nên AI và soạn bài đều ra `CONFIG_MISSING`.
  2. **Trang không nhóm (đang có cấu hình riêng) được thêm vào nhóm:** giữ `use_own_*=true` hay chuyển sang theo nhóm? Modal ở F1 ngầm hiểu là chuyển sang nhóm. Nếu chuyển, cấu hình riêng có bị xoá không?
  3. **Nhóm vừa tạo (F1 bước 2) chưa có hồ sơ và cấu hình AI:** ba trang vừa gom vào lập tức mất cấu hình hiệu lực. AI đang bật trên trang đó sẽ dừng mà không ai biết.
  4. **Bật/Tắt AI hàng loạt trên trang đang theo nhóm:** `enabled` nằm trong `autoreply_configs` của nhóm. Bản mock ngầm tách cấu hình riêng cho trang. Spine phải chốt một luật để FE và BE làm giống nhau.
- **Đề xuất (bổ sung AD-8, mọi thao tác dưới đây chạy trong một transaction của `pages` + `profiles`):**
  - Gỡ trang khỏi nhóm hoặc xoá nhóm: sao chép cấu hình nhóm hiện tại vào trang làm cấu hình riêng, đặt `use_own_*=true`.
  - Thêm trang vào nhóm: đặt `use_own_*=false`. Cấu hình riêng cũ giữ hay xoá phải chọn một lần. Khuyến nghị xoá để khớp câu chữ của modal.
  - Tạo nhóm: luôn sinh `brand_profiles` và `autoreply_configs` mặc định cho nhóm, với `enabled=false` và có thể sao chép từ trang đầu tiên được gom. Như vậy `CONFIG_MISSING` chỉ còn là lỗi không thể xảy ra.
  - Bật/Tắt AI hàng loạt: chọn một trong hai cách. (a) Trang đang theo nhóm thì tách cấu hình riêng rồi đổi `enabled`, FE xác nhận trước "N trang sẽ chuyển sang cấu hình riêng". Cách này khớp mock và luật "ghi đè toàn bộ". (b) Thêm cờ trang `autoreply_paused` độc lập với kế thừa. Khuyến nghị (a) để giữ mô hình "Dùng … riêng" là cách ghi đè duy nhất.
  - `Group.autoReply`, `Page.autoReply`, `brandSource` là dẫn xuất từ `resolveEffective`, không lưu. Spine đã nói điều này cho `brandSource`; cần nói thêm cho `autoReply`.

### R3 — File kho kiến thức · **Cao** · thêm vào AD-16 (hoặc AD mới cho file riêng tư)

- **Nguồn:** F6 bước 3 "tải Bảng giá.pdf". `AutoReply.tsx AddKnowledgeModal` nhận PDF, DOCX, XLSX, CSV, TXT, tối đa 10 MB, và hiện "AI đang đọc nội dung".
- **Spine hiện tại:** AD-16 nói "văn bản trích từ file + FAQ… giới hạn 40k token (vượt → chặn lưu)". AD-14 nói **mọi ảnh** đi qua `MediaStore` với URL công khai.
- **Vấn đề:**
  1. Chưa có chỗ lưu file gốc. Dùng chung `MediaStore` công khai sẽ làm lộ bảng giá và chính sách của shop qua URL.
  2. Trích chữ từ PDF, DOCX, XLSX chạy lâu và có thể lỗi. Theo AD-2 việc này phải là job, nhưng chưa có job nào. `knowledge_items` cũng chưa có trạng thái `processing|ready|failed`.
  3. "Vượt 40k → chặn lưu" mâu thuẫn với trích chữ bất đồng bộ: lúc bấm lưu chưa biết số token.
- **Đề xuất:** thêm job `profiles.knowledge.extract`. File gốc lưu ở kho riêng tư (cùng driver nhưng không phục vụ qua `/media`, chỉ api đọc được sau đăng nhập). `knowledge_items` có thêm `status`, `extracted_text`, `token_count`, `error_code`. Giới hạn 40k kiểm ở hai lúc: khi lưu FAQ (đồng bộ) và khi job trích xong. Nếu vượt thì đặt `status=failed` với `KNOWLEDGE_TOO_LARGE`, không đưa mục đó vào prompt. Prompt chỉ dùng mục `ready`. Xoá cấu hình riêng (tắt "Dùng cấu hình AI riêng") thì xoá cả file.

### R4 — Ràng buộc từng nền tảng khi đăng · **Cao** · thêm vào AD-13

- **Nguồn:** F4 (một bài cho FB + IG + Threads, tải ảnh hoặc ảnh AI). F3 bước 3 "tỉ lệ bài có ảnh AI".
- **Spine hiện tại:** không có.
- **Vấn đề:** IG không đăng được bài chỉ có chữ. Threads giới hạn 500 ký tự. Caption IG giới hạn 2.200 ký tự và 30 hashtag. Nếu không có hàm dùng chung, composer và động cơ chiến dịch sẽ kiểm mỗi nơi một kiểu. Chiến dịch có trang IG với "tỉ lệ ảnh AI = 50%" sẽ sinh slot IG không ảnh, đến giờ đăng mới lỗi.
- **Đề xuất:** thêm `content.validateTarget(platform, caption, media)` làm nơi duy nhất kiểm, gọi khi tạo hoặc sửa `post_target`, khi lên lịch, và trong động cơ AD-15 lúc sinh nội dung. Lỗi trả mã riêng (`MEDIA_REQUIRED`, `CAPTION_TOO_LONG`…). AD-15 thêm luật: slot của trang IG luôn có ảnh, không phụ thuộc tỉ lệ ảnh AI.

### R5 — Quy tắc "Webhook ngừng nhận tin" · **Trung bình** · sửa AD-4

- **Nguồn:** State Patterns: ">30 phút không nhận sự kiện **trong giờ thường có tin**", banner trên Hộp thư, Tổng quan, Cài đặt. F7: "Đang chờ tin đầu tiên" và "Nhận tin gần nhất: vừa xong".
- **Spine hiện tại:** AD-4 chỉ ghi `last_event_at`. Bảng `webhook_health` có tên nhưng chưa có luật.
- **Vấn đề:** "giờ thường có tin" chưa có định nghĩa. Chưa có module nào tính trạng thái, chưa có sự kiện, và không rõ tính chung hay tách theo sản phẩm (Meta, Threads). Threads ít tin nên dễ báo động giả.
- **Đề xuất:** cron 5 phút ở `webhooks` tính `webhook_health.status ∈ waiting_first | ok | stalled` cho từng sản phẩm (`meta`, `threads`). Đặt `stalled` khi `now - last_event_at > 30'` **và** khung giờ hiện tại nằm trong giờ hoạt động thường lệ. [ASSUMPTION] Khung giờ đó là mỗi giờ trong tuần có tin trong ≥3/4 tuần gần nhất, hoặc đơn giản là 08:00–22:00 giờ Việt Nam. Khi trạng thái đổi thì phát `webhook.stalled` / `webhook.recovered` (AD-3). Banner chỉ báo cho sản phẩm có trang đang `active`.

### R6 — Kênh "Nhắn riêng cho người bình luận" · **Trung bình** · sửa AD-10/AD-11/AD-16

- **Nguồn:** Cấu hình AI › Kênh áp dụng. `AutoReply.tsx CHANNELS` gồm `messenger`, `igDirect`, `commentPublic`, `commentPrivate` (chỉ FB và IG).
- **Spine hiện tại:** AD-10 có luật "một lần mỗi bình luận, ≤7 ngày". AD-16 có cổng "kênh áp dụng" nhưng không liệt kê tập kênh. AD-11 khoá hội thoại theo `channel ∈ dm|comment`.
- **Vấn đề:**
  1. Tập khoá kênh cấu hình chưa có trong shared enum. FE đã tự đặt 4 khoá.
  2. Tin nhắn riêng gửi theo `comment_id` thuộc hội thoại `comment` hay một hội thoại `dm` mới? Khi khách trả lời, Meta tạo luồng DM theo PSID.
  3. Khi bật cả công khai lẫn nhắn riêng, AI gửi cả hai hay chỉ một? Nếu cả hai thì ai soạn nội dung nào?
- **Đề xuất:** thêm enum `AutoreplyChannel` = `messenger | ig_direct | comment_public | comment_private` vào `packages/shared` và ánh xạ sang `(platform, conversation.channel)`. Tin nhắn riêng lưu trong hội thoại `comment` (để cửa sổ "một lần mỗi bình luận" kiểm ở một chỗ), đánh dấu `delivery=private_reply`. Khi khách trả lời thì tin đó vào hội thoại `dm` theo PSID như bình thường. Bật cả hai thì quyết định của autoreply trả `{publicReply?, privateReply?}`, hoặc chỉ cho chọn một. Phải chốt một cách.

### R7 — Handoff kèm câu trả lời tạm · **Trung bình** · sửa AD-9/AD-16

- **Nguồn:** F2 bước 3: AI trả lời "Shop sẽ kiểm tra và phản hồi ngay" **rồi** chuyển. Hội thoại `cv2` trong `mock.ts`. "Thử AI" hiện câu trả lời cùng ghi chú "AI sẽ chuyển cho bạn".
- **Spine hiện tại:** quyết định có dạng `{action: reply|handoff|skip, text?}`. Luật từ khoá chạy xác định, không qua LLM.
- **Vấn đề:** chưa rõ handoff có gửi `text` không. Với luật từ khoá (không gọi LLM), câu trả lời tạm lấy từ đâu? UI không có ô nào để nhập câu đó.
- **Đề xuất:** quy định rõ `handoff` kèm `text` thì gửi tin trước, sau đó mới chuyển trạng thái, cả hai trong cùng luồng `applyAutoreplyDecision`. Với luật từ khoá hoặc yêu cầu gặp người: hoặc gọi LLM để soạn câu tạm theo kịch bản (tốn chi phí, phải qua cổng hạn mức), hoặc dùng câu mặc định có trong cấu hình. Các cổng đóng như hạn mức, giờ, khoá thì **không** gửi gì.

### R8 — Từ cấm phải được kiểm, không chỉ nhắc trong prompt · **Trung bình** · thêm vào AD-7 hoặc AD-8

- **Nguồn:** `BrandProfileForm` › Điều cần tránh: "AI sẽ **không bao giờ** dùng các từ này trong bài viết và tin nhắn". Xem trước hiện "Đã tránh N từ cấm".
- **Vấn đề:** chỉ đưa vào prompt thì LLM không đảm bảo tránh được. Nếu không có luật chung, soạn bài, chiến dịch và autoreply sẽ mỗi nơi kiểm một kiểu, hoặc không kiểm.
- **Đề xuất:** đặt một hậu kiểm ở `ai` hoặc `profiles`: `checkBanned(text, effectiveBrand)`, so khớp không phân biệt hoa thường và có chuẩn hoá dấu. Mọi chữ do AI sinh đều phải qua hàm này. Nếu vi phạm: sinh lại một lần. Vẫn vi phạm thì autoreply chuyển `AI_UNCERTAIN` (hoặc một mã mới `BANNED_WORD`), chiến dịch đưa bài về `pending_approval`, composer đánh dấu cụm vi phạm.

### R9 — Kiểm tra khoá OpenAI và khoá bị thu hồi khi đang chạy · **Trung bình** · sửa AD-7/AD-12

- **Nguồn:** F7 bước 2 "app kiểm tra khoá, báo Đã kết nối". F7 thất bại "Khoá không hợp lệ, không lưu". `Settings.tsx`: chip "● Đã kết nối" và modal "Kiểm tra và lưu".
- **Spine hiện tại:** AD-12 trả `{configured, last4, status, checkedAt}` nhưng không có luật chuyển `status`. AD-7 và AD-9 chỉ có `OPENAI_KEY_MISSING`.
- **Đề xuất:**
  - Lưu khoá thì gọi kiểm tra qua `ai` (vd liệt kê model) trước khi mã hoá và lưu. Sai thì trả `OPENAI_KEY_INVALID` và không lưu.
  - Lúc chạy, nếu OpenAI trả 401 thì `ai` đặt `status=invalid` và phát `openai_key.invalidated`. Từ đó mọi lời gọi trả `OPENAI_KEY_INVALID` mà không gọi ra ngoài. Autoreply chuyển hội thoại cho người với cùng một reasonCode. Có thể gộp `MISSING` và `INVALID` thành `OPENAI_KEY_UNAVAILABLE`.
  - Lỗi 429 vì hết quota phía OpenAI là trường hợp khác với hạn mức nội bộ. Cần phân loại thành `AI_PROVIDER_QUOTA`.

### R10 — Kết quả OAuth, Kết nối lại một trang, quyền thiếu · **Trung bình** · sửa AD-5

- **Nguồn:** F7 bước 7 "Kết nối lại mở lại cửa sổ Meta cho đúng trang đó". State "Kết nối bị huỷ / thiếu quyền": modal liệt kê quyền thiếu. Thông báo "Chỉ hỗ trợ tài khoản Instagram Business đã liên kết Fanpage".
- **Spine hiện tại:** có `/oauth/*/callback` (AD-19) và `scopes` (AD-5). Chưa nói kết quả trả về FE thế nào, Kết nối lại khớp vào trang nào.
- **Đề xuất:**
  - `oauth_states` mang `intent` (`connect` | `reconnect:<pageId>`).
  - Callback ghi một kết quả có id và chuyển hướng về FE với id đó. FE gọi `GET /api/v1/oauth/results/:id` để lấy `{connected[], missingScopes[], errorCode}`.
  - Kết nối lại cập nhật đúng dòng `pages` theo `platform_*_id` (giữ lịch sử, nhóm, cấu hình). Dòng chỉ quay về `active` khi đủ scope bắt buộc.
  - Thêm ErrorCode `PERMISSIONS_MISSING{missing[]}`, `IG_NOT_BUSINESS`, `OAUTH_CANCELLED`.
  - Trang không được chọn lại trong lần cấp quyền mới thì không bị xoá, chỉ chuyển trạng thái theo token.

### R11 — Nhật ký webhook, đăng ký webhook cấp app, sự kiện thử · **Thấp** · sửa AD-4

- **Nguồn:** Cài đặt › Webhook: "nhật ký sự kiện", "Sự kiện đã đăng ký", "Gửi sự kiện thử". Nhật ký có cột trạng thái "200 OK" hoặc "Lỗi: trang mất kết nối". F7 bước 4 "app tự đăng ký webhook với Meta".
- **Đề xuất:**
  - `webhook_events` cần có `page_id`, `field`, `processed_status` (`received|processed|ignored|failed`), `error_code` để hiện **kết quả xử lý**, không chỉ việc nhận.
  - Cần chốt thời hạn giữ dữ liệu, vì payload thô có dữ liệu cá nhân của khách. Đề xuất giữ 14 ngày, cron dọn.
  - Ghi rõ đăng ký cấp app (`/{app-id}/subscriptions`, Threads cấu hình trong App Dashboard) là bước triển khai một lần, còn đăng ký cấp trang (`subscribed_apps`) là job khi kết nối trang.
  - Sự kiện thử phải mang dấu `test` và không tạo hội thoại thật.
  - Sự kiện tới cho trang `disconnected` vẫn ingest tin (không mất tin), chỉ không gửi trả lời.

### R12 — Bài xem trước của chiến dịch, thành viên chốt, dọn slot khi xoá · **Thấp** · sửa AD-15

- **Nguồn:** F3 bước 4 "AI tạo trước 7 bài đầu để xem; sửa/xoá/tạo lại". F3 bước 3 "chọn nhóm hoặc từng trang". Thẻ chiến dịch "Xoá phải xác nhận".
- **Đề xuất:**
  - Bài xem trước là `post_targets` của chiến dịch `draft`, ở trạng thái `draft`. "Bắt đầu" giữ lại chúng làm các slot đầu (đổi sang `pending_approval|scheduled` theo chế độ) thay vì sinh lại.
  - `campaign_pages` được chốt lúc bắt đầu. Đổi thành viên nhóm sau đó không làm đổi chiến dịch.
  - Xoá chiến dịch thì `campaigns` gọi `content.cancelCampaignTargets(campaignId)`: huỷ các slot chưa `published` hoặc `publishing`, giữ bài đã đăng.
  - "Tiếp tục" khi lý do dừng vẫn còn (trang vẫn mất kết nối, hạn mức vẫn 100%) thì từ chối với mã tương ứng.

### R13 — Mốc tính "thời gian chờ" · **Thấp** · sửa AD-9

- **Nguồn:** State "AI chuyển cho người… đếm thời gian chờ". `Conversation.waiting` trong `mock.ts`. Badge "Cần xử lý" ở sidebar và Tổng quan.
- **Đề xuất:** `conversations.waiting_since` do `inbox` đặt. Gán bằng thời điểm vào `handoff`, hoặc bằng thời điểm có tin khách đầu tiên chưa được trả lời khi đang `human`. Xoá khi có tin trả lời từ `human`/`ai` hoặc khi chuyển `done`. Tab "Cần xử lý" sắp xếp theo `waiting_since`. Endpoint đếm cho badge dùng đúng điều kiện của tab.

### R14 — Mã lỗi gửi tin đầy đủ · **Thấp** · sửa AD-10

- AD-10 mới có `OUTSIDE_24H`, `PRIVATE_REPLY_USED`, `PAGE_DISCONNECTED`. State "Gửi tin lỗi" còn có "Gửi quá nhanh, thử lại sau ít phút". Cần ghi rõ: tin hết lượt retry `RATE_LIMITED`/`TRANSIENT` thì lưu `failed` với `RATE_LIMITED` hoặc `SEND_FAILED`; lỗi `REJECTED` thì lưu `SEND_REJECTED`. FE ánh xạ mỗi mã sang một câu thông báo.

### R15 — Cài đặt AI: model, kích thước ảnh, tỉ giá, hạng mục chi phí, cảnh báo lại · **Thấp** · sửa AD-7

- `Settings.tsx` có "Kích thước ảnh". Thiết lập này chưa có trong danh sách cài đặt của AD-7 hay Conventions.
- Bảng chi phí chia theo "Trả lời tin nhắn / Sinh bài viết / Sinh ảnh", kèm số lượng (tin, bài, ảnh). Cần enum `AiFeature` ở shared (`autoreply`, `autoreply_test`, `inbox_suggest`, `compose_caption`, `campaign_generate`, `brand_sample`, `image_generate`…) và bảng ánh xạ feature → hạng mục hiển thị.
- Nếu hạn mức tăng giữa tháng sau khi đã chạm 80% hoặc 100%: trạng thái cảnh báo gắn với `(tháng, hạn mức)`. Hạn mức đổi thì đặt lại, để có cảnh báo mới khi vượt ngưỡng mới. Chiến dịch đã dừng thì vẫn chỉ "Tiếp tục" bằng tay.
- Hạn mức = 0 hoặc để trống: phải chốt nghĩa là "chặn hết" hay "không giới hạn". Hiện FE coi là 100%.

### R16 — Câu "Lấy từ Hồ sơ thương hiệu" và "Mẫu theo ngành" không được lọt khỏi AD-2 · **Thấp** · ghi chú vào AD-2

- Nếu "Lấy từ Hồ sơ thương hiệu" dùng LLM thì nó phải nằm trong danh sách ngoại lệ chữ tương tác của AD-2 và đi qua gateway. Khuyến nghị dùng template xác định phía server, nhận đầu vào từ `profiles.resolveEffective(…, 'brand')` của mục đang cấu hình, không tốn AI.

### R17 — Quy ước enum và tìm kiếm tiếng Việt · **Thấp** · sửa Consistency Conventions

- Danh sách enum chưa có `Stage` (Mới, Đang tư vấn, Chốt đơn, Khách quen, Khiếu nại), `AutoreplyChannel` (R6), `AiFeature` (R15), `WebhookHealthStatus` (R5), `KnowledgeStatus` (R3).
- ⌘K (tìm trang, nhóm, khách) và "Gõ để tìm trang/nhóm" cần tìm được khi gõ không dấu ("nguyen thu ha"). Cần thêm quy ước: Postgres `unaccent` + `pg_trgm` cho cột tên và số điện thoại. Endpoint tìm kiếm ghép kết quả ở `app` từ `pages.search` và `inbox.searchContacts`, đúng AD-1.

## 4. Mâu thuẫn trực tiếp giữa spine và FE/UX

| # | Đầu vào nói | Spine nói | Cần quyết |
|---|---|---|---|
| M1 | `Settings.tsx` hiện **toàn bộ verify token**, có nút hiện/ẩn và sao chép | AD-12: bí mật hạ tầng (gồm verify token) chỉ ở env. API chỉ trả `{configured, last4…}` | Verify token cần dán vào Meta App Dashboard. Một là cho API trả verify token (nó không phải khoá bí mật nguy hiểm) và sửa AD-12. Hai là FE bỏ ô này, chỉ hiện `last4`. |
| M2 | Một Callback URL `…/webhook/meta` | AD-4: hai endpoint `/webhooks/meta` và `/webhooks/threads`, hai app secret | FE hiện cả hai URL, đúng đường dẫn `/webhooks/*`, gắn nhãn theo sản phẩm. |
| M3 | FE hard-code model `gpt-4.1-mini`, `gpt-4.1`, `gpt-4o`, `gpt-image-1`, `dall-e-3` | AD-7: không hard-code tên model ngoài seed `ai_model_prices`. Stack: `gpt-image-2` | Danh sách model lấy từ API (`ai_model_prices`). FE bỏ danh sách cứng. |
| M4 | Không có ô **tỉ giá** trong Cài đặt › OpenAI | AD-7: "tỉ giá ở Cài đặt" | Thêm ô tỉ giá vào FE, hoặc chuyển tỉ giá sang giá trị seed/env có mặc định. |

Mâu thuẫn bên trong đầu vào (EXPERIENCE thắng, ghi lại để FE sửa khi nối API):

- `mock.ts cp2`: chiến dịch tạm dừng vì "**sắp** hết hạn token". EXPERIENCE và AD-15 nói chiến dịch chỉ dừng khi **mất** kết nối; token sắp hết hạn thì chiến dịch vẫn chạy.
- `Settings.tsx` gom trang Threads vào "tài khoản Meta" đăng nhập bằng Facebook. Thực tế Threads dùng OAuth riêng. `meta_accounts` cần chứa được tài khoản Threads.
- Bật "Dùng hồ sơ riêng" ở `BrandProfileForm` lưu ngay khi bấm công tắc, còn bật "Dùng cấu hình AI riêng" ở `AutoReply` chỉ lưu khi bấm "Lưu cấu hình". AD-8 nên chốt một hành vi (khuyến nghị: lưu khi bấm Lưu, cả hai giống nhau).

## 5. Story-level, không cần AD

- **Giờ hoạt động theo khung:** dữ liệu gồm `schedule ∈ always|offhours|custom` và 7 dòng `{day,on,from,to}`. "Ngoài giờ" nghĩa là nằm ngoài các khung giờ làm việc; ngày bỏ tick thì AI trả lời cả ngày. Có cho khung qua đêm không. Định nghĩa thành zod ở shared; múi giờ đã có trong Conventions. "Thử AI" bỏ qua cổng giờ và cổng `canSend`.
- **Validate cấu hình AI phía server:** bật AI thì kịch bản không được rỗng và phải có ≥1 kênh. Từ khoá không trùng. Ngưỡng `confidence` để ở hằng số hệ thống, vì UI chỉ có checkbox "AI không chắc chắn". Bỏ tick thì không chuyển cho người theo `AI_UNCERTAIN`, cũng như `askHuman=false`.
- **Hồ sơ thương hiệu:** tên bắt buộc. Tối đa 3 giọng điệu, tối đa 6 màu. Giá là chuỗi tự do. Logo PNG/SVG ≤2 MB qua `MediaStore` (logo công khai được). Logo dùng làm ảnh tham chiếu khi sinh ảnh.
- **Tóm tắt AI về khách (`Contact.aiSummary`):** chốt có hay hoãn. Nếu có thì là job (AD-2) với feature riêng trong `ai_usage`, chạy khi hội thoại chuyển `done` hoặc khi người dùng bấm. Nếu chưa làm thì ghi vào Deferred.
- **Khách hàng:** thẻ tự do, đổi giai đoạn bằng tay, sửa số điện thoại và ghi chú. `handledBy` dẫn xuất từ hội thoại gần nhất. Đánh dấu đã đọc (`unread`).
- **⌘K:** danh sách lệnh nằm ở FE. Chỉ phần tìm cần API (xem R17).
- **Phạm vi được nhớ giữa các lần mở app:** lưu localStorage ở FE, không cần API.
- **Trạng thái Màn chào:** dẫn xuất (có trang, có khoá, có hồ sơ, có cấu hình AI đang bật) qua một endpoint tổng hợp.
- **Tổng quan "việc cần xử lý" và badge:** tổng hợp từ count của các module (handoff, bài lỗi, token sắp hết, webhook ngừng).
- **Thông báo:** ánh xạ sự kiện → 4 loại thông báo + cảnh báo 80%, lưu lựa chọn trong `settings`. Toast "AI xong / đã kết nối" sinh ở client sau khi refetch.
- **Chiến dịch:** mặc định "Duyệt trước khi đăng". Cron đánh dấu `done` khi hết thời lượng. Các trường `trend`, `nextPost`, `postsDone/Total`, `daysDone/Total` đều dẫn xuất.
- **`Page.followers`:** lấy từ snapshot `page_daily_metrics` (AD-17), không gọi Graph theo request.
- **"Tạo bài tương tự":** FE truyền `postId`, composer điền sẵn chủ đề và caption gốc.
- **"Gợi ý gửi qua bình luận hoặc gọi điện"** khi quá 24h: chỉ là microcopy ở FE.
- **Kỳ vọng "AI trả lời trong vài giây" (F2)** so với độ trễ gộp tin 8 giây (AD-16): nên chỉnh xuống 3–5 giây khi thử thật. Đây là tham số, không phải quyết định kiến trúc.
