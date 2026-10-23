---
title: 'Story 5.5 — AI trả lời bình luận công khai và nhắn riêng'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '1a9974e7b30f49ca5bd0396833f9f31152920644'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-4-ai-tu-tra-loi.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 5.5, AD-16, AD-10, AD-6, AD-9; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Lượt AI của 5.4 chỉ trả lời DM. Mọi hội thoại bình luận đều về `human` `CHANNEL_OFF`, kể cả khi chủ shop đã bật "Trả lời bình luận công khai" / "Nhắn riêng cho người bình luận". Khách bình luận hỏi giá dưới bài không bao giờ được AI trả lời.

**Approach:** Mở kênh bình luận trong chuỗi cổng 5.4. Lượt chạy dùng caption `post_text_snapshot` trong prompt. Cách gửi lấy theo kênh bật và theo `canSend`:
- chỉ công khai;
- chỉ nhắn riêng;
- cả hai (FB/IG): một quyết định gồm trả lời công khai ngắn + nhắn riêng chi tiết, áp chung một transaction.

Threads chỉ công khai. AI chỉ trả lời bình luận của chính khách của hội thoại. Bình luận đã xoá/ẩn thì AI không gửi.

## Boundaries & Constraints

**Always:**
- **Kênh (cổng 3)** của hội thoại `comment`:
  - FB/IG: `comment_public` → `public_reply`, `comment_private` → `private_reply`, giao với kênh bật, thứ tự công khai trước;
  - Threads: chỉ `comment_public` (bỏ qua `comment_private` dù có trong cấu hình);
  - không còn kênh nào → `human` `CHANNEL_OFF`, không job. "Cần xử lý" theo luật sẵn có (`human` + tin hiệu lực cuối của khách), không thêm luật riêng.
- **Tin cần trả lời (`pending`)** = tin khách sau tin outbound hiệu lực cuối, chưa xoá/ẩn, do chính khách của hội thoại viết (`sender_identity_id` = định danh hội thoại hoặc null).
  - Người khác trả lời trong luồng: vào prompt (lượt "Người khác") nhưng không bao giờ là tin cần trả lời. Chỉ có tin người khác → `skipped`.
  - `lastInboundId` (khoá lạc quan) cũng chỉ tính tin của khách đó.
  - Bình luận của chính trang (kể cả bản phản hồi của tin AI) đi nhánh echo 4.5, không phải tin khách.
- **Caption:** prompt đọc `post_text_snapshot`, không gọi Meta.
  - Job caption chưa xong (`post_text_fetched_at` null) và tin cần trả lời đầu tiên mới hơn 10 giây [ASSUMPTION] → hoãn lượt 2 giây (`deferred`, không ghi run).
  - Quá 10 giây → chạy với caption null.
- **Cách gửi trước LLM:** lượt kiểm `canSend` cho từng cách gửi, kèm luật riêng của AI cho bình luận:
  - Công khai: bình luận gốc (`thread_key`) đã xoá/ẩn → coi là "đã gỡ".
  - Nhắn riêng: đích là bình luận đã ẩn → coi là "đã gỡ". `PRIVATE_REPLY_USED` / `PRIVATE_REPLY_INVALID` (quá 7 ngày) → bỏ cách gửi này.
  - Còn ít nhất một cách → quyết định với các cách còn lại.
  - Không còn cách nào: có cách gửi "đã gỡ" → không gửi gì, giữ `ai`, run `superseded`. Ngược lại → `handoff` `OUTSIDE_24H` (theo 5.4), không tin.
- **Quyết định hai tin:** khi cả `public_reply` và `private_reply` còn dùng được, structured output thêm `privateReply`:
  - `reply` = câu công khai ngắn, `privateReply` = tin nhắn riêng chi tiết (rỗng = không nhắn);
  - tin gửi theo thứ tự công khai → nhắn riêng; bỏ tin rỗng; cả hai rỗng → `AI_UNCERTAIN`;
  - mỗi tin qua `checkOutput` theo loại / giới hạn của cách gửi của nó (`replyLimit`); một tin vi phạm → sinh lại cả quyết định một lần (≤2 lời gọi);
  - chỉ một cách gửi → schema và hành vi như 5.4.
- **Câu chuyển tiếp** (lý do chủ ý): gửi bằng cách gửi đầu tiên còn dùng được (công khai nếu có).
- **`applyAutoreplyDecision`** thêm kiểm, dưới khoá luồng: hội thoại `comment` mà mọi tin cần trả lời đã xoá/ẩn, hoặc một tin AI gặp "đã gỡ" → `superseded` (`reason: 'removed'`), không ghi gì. `canSend` từ chối khác → như 5.4.
- **Job `inbox.send`**, tin `app_ai` bình luận: đích (gốc khi công khai, bình luận được nhắn riêng) đã xoá/ẩn lúc chiếm tin → huỷ tin (xoá dòng, như Tiếp quản), phát `conversation.updated`, không gọi Meta, không đổi trạng thái.
- **"Thử AI":** kênh bình luận dùng đúng cách gửi của lượt thật theo nháp và nền tảng; bật cả hai kênh (FB/IG) → có thể trả hai tin.
- **Web:**
  - khung thử ghi nhãn "AI trả lời công khai" / "AI nhắn riêng" cho kênh bình luận;
  - Hộp thư: câu lý do `OUTSIDE_24H` / `CHANNEL_OFF` trong hội thoại bình luận nói đúng chuyện bình luận / nhắn riêng.
- AD-1 giữ nguyên. Không log nội dung, caption, prompt.

**Never:**
- Không tạo hội thoại `dm` liên kết khi nhắn riêng (giữ hoãn 4.7: AC không cần).
- Không thêm `HandoffReason` / migration, không đổi `canSend` của chủ shop.
- Không đưa `handoff` transient về `ai` (5.6). Không gọi OpenAI/Meta thật trong test. Không đổi `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Công khai | FB, bật `comment_public`, khách "Giá bao nhiêu?", caption đã lấy | triage `ai` `GATE_OPEN`; run: prompt có caption + kênh công khai; 1 tin `app_ai` `public_reply` `reply_to`=gốc; run `replied` | |
| Hai tin | FB/IG bật cả hai kênh, LLM `reply`+`privateReply` | 2 tin theo thứ tự `public_reply` rồi `private_reply` (đích = bình luận của khách), 2 job gửi, 1 lời gọi; schema có `privateReply` | |
| Chỉ một phần | cả hai kênh, LLM `privateReply` rỗng / `reply` rỗng | chỉ tin còn lại; cả hai rỗng → `handoff` `AI_UNCERTAIN` | |
| Vi phạm ở tin riêng | lần 1 `privateReply` có từ cấm, lần 2 sạch | 2 lời gọi, gửi bản lần 2 | 2 lần → `AI_POLICY_BLOCKED` + câu chuyển tiếp công khai |
| Nhắn riêng đã dùng / quá 7 ngày | cả hai kênh, bình luận đã có tin nhắn riêng / bình luận 8 ngày trước | chỉ công khai; schema không có `privateReply` | |
| Chỉ nhắn riêng mà không gửi được | chỉ `comment_private`, đã dùng / quá 7 ngày | `handoff` `OUTSIDE_24H`, không tin, 0 lời gọi | |
| Threads | trang Threads bật cả hai kênh | chỉ `public_reply`; chỉ `comment_private` → `human` `CHANNEL_OFF` | |
| Kênh bình luận tắt | DM bật, bình luận tắt | `human` `CHANNEL_OFF`, không job; nằm trong "Cần xử lý" (tin cuối của khách) | |
| Người khác trong luồng | AI đã trả lời khách; người khác trả lời trong luồng | run `skipped`, 0 lời gọi; prompt lượt sau có "Người khác" | |
| Bình luận của trang | trang bình luận trong luồng (echo) | không `message.received`, không lượt AI mới | |
| Caption chưa có | job caption chưa chạy, bình luận vừa tới / đã 11 giây | `deferred` + job run 2 giây sau, không run / chạy với caption null | |
| Xoá/ẩn trước lượt | bình luận của khách bị xoá hoặc ẩn trước khi run | `skipped`, 0 lời gọi, không tin | |
| Xoá/ẩn giữa lúc AI nghĩ | xoá/ẩn sau khi đọc ảnh chụp, trước khi áp | `superseded`, không tin, giữ `ai` | |
| Gốc bị ẩn, nhắn riêng còn | cả hai kênh, gốc ẩn, khách trả lời trong luồng | chỉ nhắn riêng | |
| Xoá/ẩn trước khi gửi | tin AI `pending`, bình luận gốc bị ẩn rồi job chạy | tin bị huỷ, không gọi Meta, `conversation.updated`, giữ `ai` | |
| Thử AI | nháp FB bật cả hai kênh, thử `comment_public` | `messages` có thể gồm `public_reply` + `private_reply`; web nhãn tương ứng | |

</frozen-after-approval>

## Code Map

- `server/src/modules/autoreply/gates.ts` -- `servingChannels` mở kênh bình luận (Threads chỉ công khai)
- `server/src/modules/autoreply/run.ts` -- hoãn chờ caption, lọc cách gửi theo `canSend` + "đã gỡ", `superseded` khi gỡ
- `server/src/modules/autoreply/decide.ts` -- quyết định hai tin, hậu kiểm từng tin
- `server/src/modules/autoreply/test-run.ts` -- cách gửi bình luận như lượt thật
- `server/src/modules/ai/prompts/autoreply.ts` -- schema / hướng dẫn `privateReply`
- `server/src/modules/inbox/autoreply.ts` -- tin cần trả lời chỉ của khách hội thoại, `postTextPending`, `autoreplySendCheck`, kiểm "đã gỡ" lúc áp
- `server/src/modules/inbox/send.ts` -- huỷ tin AI bình luận khi đích đã gỡ lúc gửi
- `web/src/lib/{autoreply,inbox}.ts`, `web/src/screens/{AutoReply,Inbox}.tsx` -- nhãn bong bóng thử, câu lý do theo kênh

## Tasks & Acceptance

**Execution:**
- [x] `server/src/modules/inbox/{autoreply,send,index}.ts` -- tin cần trả lời theo khách, caption chờ, kiểm "đã gỡ" (lượt / áp / gửi)
- [x] `server/src/modules/ai/prompts/autoreply.ts` -- `privateReply` trong schema + hướng dẫn hai tin
- [x] `server/src/modules/autoreply/{gates,run,decide,test-run}.ts` -- mở kênh bình luận, cách gửi, quyết định hai tin
- [x] `server/test/autoreply-comment.test.ts` (mới) -- phủ mọi dòng ma trận (Postgres thật, OpenAI + Meta giả); sửa test 5.4 / 5.3 / prompt theo hành vi mới
- [x] `web` -- nhãn bong bóng thử, câu lý do theo kênh (+ test helper)
- [x] `deferred-work.md` -- cập nhật mục hội thoại `dm` liên kết (ngữ cảnh AI), thêm mục mới

**Acceptance Criteria:**
- Given trang FB bật "Trả lời bình luận công khai" và "Nhắn riêng", when khách bình luận "Giá bao nhiêu shop?" dưới bài có caption, then Hộp thư hiện tin tím "AI trả lời" công khai và tin "AI trả lời · Nhắn riêng", hội thoại vẫn "AI đang trả lời".
- `npm run check` xanh; depcruise sạch.

## Implementation Notes

- **Inbox** (`inbox/autoreply.ts`):
  - `readAutoreplyTurn`: tin cần trả lời + `lastInboundId` chỉ tính tin của định danh hội thoại (hoặc null). Tin người khác không chặn việc quét. Thêm `postTextPending`.
  - `autoreplySendCheck` = `canSend` + `COMMENT_REMOVED`: gốc đã xoá/ẩn (công khai), đích đã ẩn (nhắn riêng). `canSend` của chủ shop không đổi.
  - `applyAutoreplyDecision`: `expected.pendingIds`. Kiểm mọi tin trước khi ghi; "đã gỡ" → `{applied:false, reason:'removed'}`.
- **Gửi** (`send.ts`): tin `app_ai` bình luận có đích đã xoá/ẩn lúc job chiếm → xoá dòng, `conversation.updated`, `cancelled`. Tin chủ shop vẫn gửi.
- **Autoreply:**
  - `gates.servingChannels`: bình luận FB/IG → công khai rồi nhắn riêng; Threads → chỉ công khai.
  - `run.ts`: chờ caption (`POST_TEXT_WAIT_MS` 10 giây, hoãn `POST_TEXT_RETRY_MS` 2 giây, `deferred` không ghi run); lọc cách gửi; `REMOVED` → run `superseded`.
  - `decide.ts`: hai tin khi có cả `public_reply` và `private_reply`. Mỗi tin hậu kiểm theo `replyLimit` của cách gửi; một tin vi phạm → sinh lại cả quyết định.
  - `test-run.ts`: kênh bình luận dùng `servingChannels` ∩ nháp.
- **Prompt** (`ai/prompts/autoreply.ts`):
  - `isDualReply`; schema hai tin bỏ `mode`, thêm `privateReply`; `AUTOREPLY_DUAL_MAX_OUTPUT_TOKENS` 1600.
  - Hướng dẫn: câu công khai báo "đã nhắn riêng" chỉ khi có `privateReply`.
  - Kênh bình luận: chỉ trả lời "Khách", không trả lời "Người khác".
- **Web:**
  - `testResultBubbles` gắn nhãn "AI trả lời công khai" / "AI nhắn riêng".
  - `reasonText(reason, channel)`: câu riêng cho `OUTSIDE_24H` / `CHANNEL_OFF` ở bình luận, dùng ở ghi chú handoff và tin `system`.
- **Quyết định:**
  - Không thêm lý do / migration. Nhắn riêng không gửi được khi chỉ bật nhắn riêng → `OUTSIDE_24H` (AD-9, như 5.4); web nói đúng chuyện "đã nhắn / quá 7 ngày".
  - Bình luận ẩn = "đã gỡ", như xoá: AI không gửi, giữ `ai`. Đã ghi hoãn (bộ lọc ẩn SĐT của Facebook).
  - Câu chuyển tiếp ở bình luận đi công khai nếu được.
  - Gỡ một phần lúc áp (một tin "đã gỡ") → bỏ cả quyết định, vì câu công khai thường nhắc tới tin riêng.
  - Không làm hội thoại `dm` liên kết (AC không đòi). Đã ghi thêm hệ quả cho ngữ cảnh AI vào mục hoãn 4.7.
- **Test:**
  - `server/test/autoreply-comment.test.ts`: 23 ca, phủ mọi dòng ma trận.
  - Sửa 1 ca 5.4: cấu hình chỉ Messenger để bình luận vẫn `CHANNEL_OFF`.
  - Web: +2 ca (`autoreply.test.ts`, `inbox.test.ts`).
  - `npm run check` xanh: server 1178 test, web 236 test, depcruise sạch.
- Chưa kiểm bằng trình duyệt / Meta / OpenAI thật. Đã ghi vào `deferred-work.md`.
- **Vượt spec đã khoá (review lượt 1, theo yêu cầu chủ dự án):** bình luận của người khác ở hội thoại AI đang phục vụ → `handoff` `OTHER_COMMENTER` (thêm `HandoffReason` + migration `0025`, trái mục "Never: không thêm HandoffReason / migration") để tin không bị bỏ im lặng; dòng ma trận "Người khác trong luồng" đổi từ `skipped` thành `handoff`.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Luồng có gốc là bình luận của chính trang (vd trang ghim "Hỏi giá bình luận dưới đây"): echo gốc không tạo hội thoại (`echo.ts` `threadRef` null → `no_conversation`), nên mọi khách trả lời dưới bình luận đó dồn vào MỘT hội thoại (`commentThreadKey`), khách là người trả lời đầu tiên. Từ khách thứ hai trở đi là "Người khác": AI không trả lời, hội thoại `ai` không vào "Cần xử lý" — hồi quy so với trước 5.5 (khi đó nằm ở `human`). Sửa (vượt spec theo yêu cầu chủ dự án): triage gặp bình luận của người khác ở hội thoại `triage`/`ai` → `handoff` lý do mới `OTHER_COMMENTER` (sticky), không chạy AI; AI vẫn chỉ trả lời khách của hội thoại. Migration `0025` mở CHECK lý do; câu web/thông báo. Test: sau khi AI trả lời, chen trước lượt, lúc còn `triage` (+ cổng đóng theo cổng). | Lỗi thật (trung bình) | `patch` |
| Đã soát, không thấy lỗi: trả lời bình luận của chính trang (echo đi nhánh outbound, chặn quét `pending`); nhắn riêng hai lần (`canSend` đếm tin `private_reply` chưa `failed`, lượt chồng bị chặn bởi kiểm "đã có outbound sau `lastInboundId`"); Threads nhắn riêng (`servingChannels` + `canSend` + `platformFor`); gửi một phần (mỗi tin một job `inbox.send`, lỗi tin riêng → `handoff`, không gửi lại tin công khai); chờ caption (hoãn bằng job mới, không giữ slot worker; stately cho phép job `created` khi job hiện tại `active`); log không chứa nội dung. | Không phải lỗi | — |

## Design Notes

Structured output khi có hai cách gửi (strict, mọi field bắt buộc):

```json
{ "action": "reply", "reply": "Dạ shop đã nhắn riêng giá cho bạn ạ", "privateReply": "Dạ nồi chiên 5L giá 1.290.000đ…", "reasonCode": null, "confidence": 0.9 }
```

Không có `mode`: cách gửi do field quyết định. Một cách gửi → giữ schema 5.4 `{action, reply, mode, reasonCode, confidence}`.

## Verification

**Commands:**
- `npm run check` (gốc repo) -- typecheck, lint, depcruise, test đều xanh
