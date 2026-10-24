---
title: 'Story 8.3 — Hiệu quả AI'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '2ab3354c53fec9ce4c3c04d4c75548825bb5a81f'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 8.3, AD-17, AD-1, AD-9; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Khối "Hiệu quả AI" ở `/hieu-suat` còn số mẫu ("912 tin", "9%", "14 giây", "AI tạo cao hơn 40%"), KPI "Tin nhắn" bị bỏ ở 8.2 chờ story này. Chủ shop chưa biết AI thật sự trả lời bao nhiêu, chuyển cho mình bao nhiêu, nhanh thế nào, và bài AI có hơn bài tự viết không.

**Approach:** Mở rộng `GET /api/v1/performance` (cùng phạm vi + kỳ của 8.2): `analytics` gọi hàm đọc mới của `inbox` (đếm trên `messages` + tin `system`) và `content` (cờ AI của bài đã đăng) rồi tính tương tác trung bình từ `post_metrics`. Web thay số mẫu bằng số thật.

## Boundaries & Constraints

**Always:**
- **Kỳ, phạm vi:** đúng `performanceWindow` + `listPages(scope)` của 8.2 (N ngày VN kết thúc hôm qua, thành viên nhóm hiện tại, bỏ trang đã gỡ). Tin thuộc kỳ theo `platform_timestamp` ∈ `[00:00 VN from, 00:00 VN to+1)`.
- **Định nghĩa (server, `inbox/stats.ts`):**
  - *Tin khách* = `origin='customer'`, `removal is null`. *Tin đã gửi* = outbound `status ∈ sent|delivered|read`. Thứ tự trong hội thoại = `(platform_timestamp, id)`.
  - `customerMessages` = tin khách trong kỳ (cả DM lẫn bình luận). `kpis.messages = {current, previous}`; `previous = null` khi có trang trong phạm vi kết nối sau 00:00 VN ngày đầu kỳ trước (kỳ trước thiếu).
  - `aiAnswered` = tin khách trong kỳ mà tin đã gửi ĐẦU TIÊN sau nó là `app_ai` (câu chuyển tiếp của AI cũng là AI trả lời). Web: "AI đã trả lời X% tin nhắn" = `aiAnswered / customerMessages`.
  - `aiMessages` = tin `app_ai` đã gửi trong kỳ.
  - *AI chuyển người* = tin `system` trong kỳ có lý do loại `transient|sticky` (`HANDOFF_REASON_KIND`, đích `handoff`) mà tin `system` liền trước của hội thoại là `GATE_OPEN|AI_REENABLED` (đang `ai`). Cổng đóng ngay ở triage, Tiếp quản, chủ shop trả lời, lý do `not_applicable` → không tính.
  - `aiConversations` = hội thoại có tin `app_ai` đã gửi trong kỳ ∪ có AI chuyển người trong kỳ; `handoffConversations` = hội thoại có AI chuyển người trong kỳ. Tỉ lệ chuyển người = `handoff / ai` (tỉ lệ AI tự xử lý = phần còn lại).
  - **Thời gian phản hồi:** mỗi tin `app_ai` R là phản hồi đầu tiên của một nhóm tin khách; mốc A = tin khách đầu nhóm (tin hiệu lực liền trước A không phải tin khách) và A trong kỳ. Mẫu = `max(0, R.sent_at − A.created_at)` (giây — mốc vào hệ thống, như NFR1). Chỉ tính khi hội thoại ở với AI suốt từ A tới R: tin `system` cuối trước A là không có / `GATE_OPEN` / `AI_REENABLED` / `MARKED_DONE`, và giữa A–R không có tin `system` nào khác `GATE_OPEN`. `avgResponseSeconds` = trung bình mẫu (`null` khi 0 mẫu), kèm `responseSamples`.
- **Bài AI vs tự viết:** target `published` trong kỳ của trang trong phạm vi (`content.listPublishedInRange` thêm cờ `ai`, cùng luật Lịch nội dung); tương tác = snapshot mới nhất `post_metrics`; bài không có snapshot / `engagement null` không tính. Mỗi nhóm `{posts, avgEngagement}` (`null` khi 0 bài).
- **AD-1:** `analytics → inbox|content|pages` qua `index.ts` (mũi tên có sẵn — không cần `app/read-models/`). Không SQL chéo bảng module khác; không đọc `autoreply_runs`. Không đọc/log nội dung tin.
- Index mới `messages (page_id, platform_timestamp)` cho truy vấn theo trang + kỳ.
- **Web `/hieu-suat`:** KPI thứ 6 "Tin nhắn" (+ % kỳ trước theo luật 8.2). Khối "Hiệu quả AI": "AI trả lời" `n tin` + "AI đã trả lời X% tin nhắn"; "Chuyển cho bạn" `X%` + "n hội thoại"; "Phản hồi trung bình" (giây / phút / giờ) + "Từ lúc khách nhắn tới lúc AI gửi"; thanh "Tương tác trung bình mỗi bài" Bài AI tạo vs Bài tự viết (kèm số bài) + câu "AI tạo cao hơn / thấp hơn X%" khi hai nhóm đều có số và bài tự viết > 0. Không có số → "—" / câu trống thay vì 0%. % làm tròn số nguyên.

**Never:**
- Không gọi Meta / OpenAI; không kéo tin thô về web. Không so kỳ trước cho khối AI (chỉ KPI "Tin nhắn").
- Không giữ dòng mẫu "Bạn tự trả lời: 23 phút" (thời gian người trả lời sau khi AI chuyển chưa đo đúng được từ `messages` — ghi việc hoãn). Không làm tab Hiệu suất của Chi tiết trang / nhóm (hoãn từ 8.2).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| AI trả lời | hội thoại triage → `GATE_OPEN`, 2 tin khách gộp, 1 tin AI `sent` sau 5 giây | `customerMessages 2`, `aiAnswered 2`, `aiMessages 1`, `aiConversations 1`, mẫu 5 giây | |
| Chủ shop trả lời | trang tắt AI: tin khách → `app_human` sent; tin khách chưa ai trả lời | tính vào `customerMessages`, không vào `aiAnswered` | |
| Tin không tính | tin AI `failed` / `pending`; tin khách bị gỡ; tin ngoài kỳ (hôm nay, trước `from`); trang ngoài phạm vi / đã gỡ | không tính | |
| AI chuyển người | `GATE_OPEN` → tin AI câu chuyển tiếp → `system KEYWORD`; hội thoại khác `ai` → `AI_SEND_FAILED` không tin AI | `handoffConversations 2`, `aiConversations 2` | |
| Không phải AI chuyển | triage → `OUTSIDE_HOURS` (không qua `ai`); `ai` → `TAKEOVER`; `ai` → `HUMAN_REPLIED`; `ai` → `AI_OFF` | `handoffConversations 0` | |
| Mẫu bị loại | tin khách khi `handoff` tạm đóng, sáng sau AI chạy lại (`system` giữa A–R); bật lại AI cho khách chờ từ `human`; nhóm tin bắt đầu trước `from` | không vào mẫu (vẫn đếm `aiAnswered`) | |
| Bài AI vs tự viết | 2 bài AI (tương tác 30, 50 — snapshot mới nhất), 1 bài tự viết 20, 1 bài không có snapshot, 1 bài ngoài kỳ | `ai {2, 40}`, `manual {1, 20}` | |
| KPI Tin nhắn | 3 tin kỳ này, 2 tin kỳ trước; trang kết nối 40 ngày (range 7d) / thêm trang kết nối 10 ngày | `{3, 2}` / `previous null` | |
| Rỗng | phạm vi không có trang / không tin nào | mọi đếm 0, `avgResponseSeconds null`, `avgEngagement null` | |
| Web | 0 tin khách; `aiConversations 0`; `avg 14 / 200 / 7200` giây; AI 40 vs tự viết 20 / 0 / null | câu trống, "—"; "14 giây" / "3 phút" / "2 giờ"; "AI tạo cao hơn 100%" / không câu | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/metrics.ts` -- `AiEfficiencyDto`, `kpis.messages`, `ai` trong `PerformanceResponse`.
- `server/src/modules/inbox/{stats,schema,index}.ts` (MỚI `stats.ts`) -- `aiReplyStats`, `countCustomerMessages`; index mới.
- `server/drizzle/` -- migration index (drizzle-kit generate).
- `server/src/modules/content/metrics-targets.ts` -- cờ `ai` trong `listPublishedInRange` (dùng chung biểu thức với `describePublishedTargets`).
- `server/src/modules/analytics/{ai-efficiency,performance,index}.ts` (MỚI `ai-efficiency.ts`) -- ghép số AI + bài AI vs tự viết.
- `server/test/analytics-ai-efficiency.test.ts` (MỚI) -- ma trận phía server qua app thật.
- `web/src/lib/performance{,.test}.ts` -- helper thuần (`percentOf`, `formatDuration`, `aiVsManualText`) + `emptyPerformance`.
- `web/src/screens/Analytics.tsx` -- KPI "Tin nhắn", khối "Hiệu quả AI" thật.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- việc hoãn.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/metrics.ts` -- hợp đồng `AiEfficiencyDto`, `kpis.messages`, `ai` -- AD-18.
- [x] `server/src/modules/inbox/stats.ts` + `schema.ts` + `index.ts` + migration -- hàm đọc đếm tin / chuyển người / thời gian phản hồi -- AD-1, AD-9.
- [x] `server/src/modules/content/metrics-targets.ts` -- cờ `ai` -- AD-1.
- [x] `server/src/modules/analytics/ai-efficiency.ts` + `performance.ts` + `index.ts` -- ghép vào `performanceOverview` -- AD-17.
- [x] `server/test/analytics-ai-efficiency.test.ts` -- phủ mọi dòng server của ma trận; cập nhật test 8.2 nếu hợp đồng đổi.
- [x] `web/src/lib/performance.ts` + test -- helper + dòng "Web".
- [x] `web/src/screens/Analytics.tsx` -- thay số mẫu.
- [x] `deferred-work.md` -- kiểm UI, thời gian người trả lời, so kỳ trước khối AI, tab Chi tiết trang / nhóm.

**Acceptance Criteria:**
- Given phạm vi và khoảng thời gian, when mở mục Hiệu quả AI, then số tin AI trả lời, tỉ lệ chuyển người, thời gian phản hồi trung bình tính từ `messages` + tin `system` qua hàm đọc của `inbox`; tương tác trung bình bài AI tạo vs bài tự viết tính từ `posts`/`post_metrics`.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `metrics.ts` — `PostKindStats`, `AiEfficiencyDto`; `PerformanceResponse.kpis.messages` + `ai`.
- **Inbox:** `stats.ts` (mới) — `aiReplyStats` (hai câu SQL: tin khách + phản hồi đầu tiên qua `lateral` trên index `(conversation_id, platform_timestamp, id)` + lọc mẫu thời gian; tin AI / hội thoại AI / AI chuyển người với tin `system` liền trước qua `lateral`) và `countCustomerMessages`. Index `messages_page_ts_idx` (migration `server/drizzle/0038_foamy_captain_flint.sql`).
- **Content:** `listPublishedInRange` trả thêm `ai` (join `posts`); luật `ai` gom vào `aiPostOf()` dùng chung với `describePublishedTargets`.
- **Analytics:** `ai-efficiency.ts` (mới) — `aiEfficiency` (gọi `inbox` + bài AI vs tự viết từ snapshot mới nhất `post_metrics`) và `messagesKpi`; `performanceOverview` ghép vào cùng response. Không cần `app/read-models/`: `analytics → inbox|content` là mũi tên AD-1 có sẵn (depcruise sạch).
- **Web:** `lib/performance.ts` — `percentOf`, `formatDuration`, `aiVsManualText`, `emptyPerformance` đủ trường mới. `Analytics.tsx`: KPI thứ 6 "Tin nhắn" (lưới `xl:grid-cols-6`, skeleton 6 ô); `AiEfficiencyCard` dùng `data.ai`, bỏ dòng mẫu "Bạn tự trả lời"; tiêu đề phụ "n trên m hội thoại AI nhận", dòng số bài có số liệu dưới thanh so sánh.
- **Test:** `server/test/analytics-ai-efficiency.test.ts` (9 test, mới — mọi dòng server của ma trận); `analytics-performance.test.ts` thêm `kpis.messages`; `web/src/lib/performance.test.ts` +4 test (dòng "Web"). Sửa test chập chờn có sẵn `inbox.test.ts` (hai job cùng transaction cùng `created_on` → so không theo thứ tự) — làm `npm run check` đỏ ngẫu nhiên.
- **Kiểm tra:** `npm run check` thoát 0 — depcruise sạch (217 module); server 72 file / 1456 test; web 23 file / 339 test.
- **Việc hoãn** (`deferred-work.md`): kiểm UI bằng trình duyệt; thời gian chủ shop trả lời; so kỳ trước / trung vị cho khối AI. Mục tab Hiệu suất Chi tiết trang / nhóm (8.2) cập nhật: "tin AI trả lời" nay lấy từ `data.ai`.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Đã soát: tin echo / `external_human` / `app_unmatched` (outbound `sent`, không vào tin khách), tin AI `failed`/`pending` (loại khỏi "đã gửi"), tin gỡ, tin `system`; kỳ VN `[00:00 from, 00:00 to+1)` trùng 8.2, kỳ trước liền kề; "Gửi lại" tin AI dời `platform_timestamp` ra sau `AI_SEND_FAILED` → mẫu thời gian bị loại đúng; reopen `done → triage` không ghi `system` (coi như `MARKED_DONE`); phạm vi qua `listPages`; index `(page_id, platform_timestamp)` khớp `WHERE` của `c` / `ai` / `handoffs`; mẫu số 0 → `null` ở web; sửa test `inbox.test.ts` chỉ là thứ tự đọc `pgboss.job` (job độc lập, không phụ thuộc thứ tự) | Không có lỗi mức trung bình / cao | — |
| Test có sẵn `notifications.test.ts` "handler ném lỗi ở lần thử cuối…" chập chờn: `system_error` có trước khi pg-boss ghi job `failed` → `expected 'active' to be 'failed'` (lần chạy `npm run check` đầu đỏ, lần sau xanh) | Thật, ngoài phạm vi 8.3 | defer |

## Design Notes

- **Vì sao lọc mẫu thời gian phản hồi:** cả `autoreply_runs.inbound_at` lẫn "tin khách đầu nhóm" đều neo vào tin khách sớm nhất chưa được trả lời. Khách nhắn 23:00 lúc ngoài giờ (`handoff OUTSIDE_HOURS`), 08:00 nhắn tiếp → AI chạy lại trả lời cả hai → mẫu 9 giờ, làm "Phản hồi trung bình" thành vài giờ dù AI trả lời trong vài giây. Chỉ tính khi hội thoại ở với AI liên tục từ A tới R.
- **"X% tin nhắn" tính theo tin khách**, không theo tin gửi đi: khớp câu Voice and Tone "AI đã trả lời 81% tin nhắn" (của khách); gộp tin (3 tin → 1 câu trả lời) vẫn tính đủ 3.

## Verification

**Commands:**
- `npm run check` -- expected: thoát 0 (depcruise sạch, test server + web xanh).
