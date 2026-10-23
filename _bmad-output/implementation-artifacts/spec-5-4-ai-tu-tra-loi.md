---
title: 'Story 5.4 — AI tự trả lời tin nhắn và chuyển cho bạn'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '7bc5732fd1ee3f0c989033b9c3f1c542abc4dcf2'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-3-thu-ai.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 5.4, AD-9, AD-16, AD-20, AD-21, AD-24; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Cấu hình AI (5.1–5.2) và lõi quyết định (5.3) đã có, nhưng `autoreply.triage` vẫn luôn đưa hội thoại về `human` `AI_OFF`. Khách nhắn Fanpage/IG không bao giờ được AI trả lời. Bật lại AI lúc khách đang chờ cũng không ai trả lời tin đang chờ.

**Approach:** Triage chạy chuỗi cổng AD-16 tới hạn mức. Cổng mở → `ai` + job `autoreply.run` (stately theo hội thoại, trễ 4 giây). Lượt chạy:
1. Đọc ảnh chụp `{state, stateVersion, lastInboundId}`.
2. Chạy nốt cổng (`canSend`, tin có chữ), rồi `decideReply` của 5.3.
3. Áp quyết định qua `inbox.applyAutoreplyDecision` với khoá lạc quan: tin `app_ai` `pending` + job `inbox.send`, chuyển trạng thái nếu có.
4. Ghi `autoreply_runs`.

Hộp thư hiện chấm "đang gõ" theo `conversation.ai_typing`. 5.4 chỉ trả lời DM; bình luận để 5.5.

## Boundaries & Constraints

**Always:**
- **Cổng**, theo thứ tự, lấy lý do đầu tiên đóng:
  1. `ai_enabled=false` → `AI_OFF`.
  2. `profiles.resolveEffective(page,'autoreply')`: không có → `CONFIG_MISSING`; tắt → `AI_OFF`.
  3. Kênh → `CHANNEL_OFF`. DM Facebook = `messenger`, DM Instagram = `ig_direct`. Hội thoại `comment` luôn `CHANNEL_OFF` ở 5.4.
  4. Giờ hoạt động → `OUTSIDE_HOURS`, theo giờ `Asia/Ho_Chi_Minh`:
     - `always`: luôn mở;
     - `custom`: mở trong khung của ngày;
     - `offhours`: mở ngoài khung (ngày `on=false` → AI cả ngày);
     - khung `from>to` qua nửa đêm, thuộc ngày bắt đầu.
  5. `aiAvailabilityGate`: khoá OpenAI → hạn mức.
  6. (Chỉ lượt chạy) `canSend(dm)` từ chối → `OUTSIDE_24H` (AD-9).
  7. (Chỉ lượt chạy) Các tin khách mới không tin nào có chữ → `NON_TEXT_MESSAGE`.
- **Đích theo `HANDOFF_REASON_KIND`:** `not_applicable` → `human`; `transient` → `handoff`; `sticky` → `handoff`.
  - Câu chuyển tiếp `handoffMessage` chỉ đi kèm lý do chủ ý mà vẫn gửi được: không gửi với `OUTSIDE_24H`.
  - Gửi tin AI trước, tin `system` sau.
  - Đóng ở triage: không gửi gì.
- **`autoreply.triage`** (nghe `message.received` và `conversation.state_changed`):
  - Hội thoại `triage` → cổng 1–5 → `applyTriageDecision`. Cổng mở = `ai` `GATE_OPEN`.
  - Đã `ai` (vừa mở cổng, hoặc tin khách mới khi đang `ai`) → enqueue `autoreply.run {conversationId}` trễ 4 giây.
  - `state_changed` sang `ai` với `AI_REENABLED` → enqueue run ngay. Đóng mục hoãn 4.6.
  - Trạng thái khác → bỏ qua.
- **Queue `autoreply.run`:** `stately`, `singletonKey = conversationId`, retry 2, concurrency 5, expire 300 giây. Một job chờ + một job chạy cho mỗi hội thoại.
- **Lượt chạy:**
  - Chỉ khi `state=ai` và tin hiệu lực mới nhất là của khách; ngược lại `skipped`, không ghi run.
  - Tin khách "mới" = các tin khách sau tin outbound hiệu lực cuối. Luật từ khoá xét chữ gộp của chúng. Prompt nhận ≤20 lượt gần nhất.
  - Bật `ai_typing` ngay trước LLM. `applyAutoreplyDecision` tắt nó trong cùng transaction; lỗi / bỏ dở → `finally` tắt.
  - Lần thử cuối mà vẫn lỗi bất ngờ → áp `handoff` `AI_PROVIDER_ERROR`, để khách không kẹt ở `ai`.
- **`inbox.applyAutoreplyDecision(deps, conversationId, {stateVersion, lastInboundId}, {messages, transition})`:**
  - Khoá luồng. Bỏ (`superseded`, không ghi gì) khi: hội thoại không còn `ai`, `state_version` lệch, hoặc id tin khách mới nhất ≠ `lastInboundId`.
  - Mỗi tin: `canSend` lại trong transaction. Từ chối → tin `app_ai` `failed` + mã và xử lý như gửi lỗi.
  - Tin AI: `origin=app_ai`, `pending`, job `inbox.send` cùng transaction.
- **Tin `app_ai` gửi lỗi** (job, cron kẹt `sending`, `canSend` lúc áp) khi hội thoại còn `ai` → `handoff`:
  - mã `OUTSIDE_24H` / `PRIVATE_REPLY_*` → `OUTSIDE_24H`;
  - mã khác → `AI_PROVIDER_ERROR`.
  - Khoá luồng TRƯỚC khi đổi dòng tin (tránh deadlock với Gửi lại).
- **"Gửi lại"** áp cho cả tin `app_ai` `failed`. Chủ shop bấm = chủ shop gửi: `applyHumanReply` → `HUMAN_REPLIED`, tắt AI.
- **`autoreply_runs`** (module `autoreply` sở hữu), không chứa nội dung:
  - `conversation_id`, `page_id`, `last_inbound_id`, `state_version`;
  - `inbound_at` (= `created_at` của tin khách mới đầu tiên, mốc webhook);
  - `started_at`, `finished_at`;
  - `outcome` ∈ `replied|handoff|not_applicable|superseded|failed`, `reason_code`;
  - `config_source_type/id` (AD-8), `llm_calls`, `confidence`, `message_ids`.
- **`messages.sent_at`** ghi lúc tin outbound thành `sent` (job hoặc echo). NFR1 đo `sent_at − inbound_at` qua `message_ids`.
- **Sinh lại sau vi phạm hậu kiểm** (`decideReply`, cả `inbox.suggestReply`): lần 2 kèm ghi chú vi phạm lần 1 (từ cấm, link lạ, quá N ký tự). Đóng mục hoãn 5.3.
- **Shared:**
  - sự kiện `conversation.ai_typing {id, pageId}` (realtime);
  - `ConversationDto.aiTyping` (= `ai_typing_at` trong 120 giây và `state=ai`).
  - Web: chip "AI đang trả lời" kèm chấm đang gõ, bong bóng "AI đang trả lời…" cuối khung chat, "Gửi lại" cho tin AI lỗi. Gợi ý `ai_typing` chỉ làm cũ hội thoại + tin.
- AD-1: `autoreply → inbox|profiles|ai`; worker gọi `autoreply`. Không log prompt / nội dung / kịch bản.

**Never:**
- Không trả lời bình luận, không gửi hai tin trong một quyết định (5.5).
- Không đưa `handoff` transient về `ai` khi cổng mở lại (5.6).
- Không đổi luật echo `external_human` (giữ hoãn: chưa có sự kiện thật).
- Không gọi OpenAI / Meta thật trong test. Không đổi `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cổng mở | tin DM FB đầu, cấu hình nhóm bật `messenger`, `always`, khoá + hạn mức ổn | triage → `ai` `GATE_OPEN`, job run trễ 4 giây | |
| Không áp dụng | không cấu hình / tắt / kênh `ig_direct` tắt / bình luận | `human` `CONFIG_MISSING` / `AI_OFF` / `CHANNEL_OFF`, không job | |
| Tạm đóng ở triage | ngoài khung `custom`; khoá xoá; hạn mức `blocked` | `handoff` `OUTSIDE_HOURS` / `OPENAI_KEY_UNAVAILABLE` / `AI_BUDGET_EXCEEDED`, không tin AI | |
| Giờ | `offhours` T2 08–18 lúc 20:00; `custom` T2 22:00–06:00 lúc 03:00 T3 | cả hai mở | |
| Trả lời | run, LLM `reply` 0.9 | tin `app_ai` `pending` + `inbox.send`, giữ `ai`. Run `replied`: `message_ids`, `config_source`, `llm_calls=1`. Typing bật rồi tắt | |
| Gộp tin | 3 tin trong 4 giây (3 lần triage) | 1 job, 1 lời gọi LLM, prompt có cả 3 tin | |
| Từ khoá | "muốn đổi trả" | 0 lời gọi LLM. Tin AI = `handoffMessage`, rồi `system` `KEYWORD` (thứ tự đúng), `handoff` | |
| LLM chuyển / không chắc / vi phạm | `CUSTOMER_ASKED_HUMAN`; `confidence 0.3`; 2 lần từ cấm | `handoff` lý do tương ứng + câu chuyển tiếp. Lần 2 có ghi chú vi phạm | |
| Tin không chữ | khách gửi ảnh | `handoff` `NON_TEXT_MESSAGE` + câu chuyển tiếp, 0 lời gọi | |
| Quá 24 giờ | tin khách cuối 25 giờ trước, AI bật lại | `handoff` `OUTSIDE_24H`, không tin AI | |
| Lỗi nhà cung cấp | fake 5xx | `handoff` `AI_PROVIDER_ERROR`, không tin | |
| Khách nhắn giữa lúc AI nghĩ | tin mới commit trong lúc LLM chạy | lượt cũ `superseded`, không tin. Lượt sau trả lời gộp cả hai | |
| Tiếp quản giữa chừng | Tiếp quản khi LLM đang chạy | `superseded`, không tin; hội thoại `human` | |
| Tiếp quản sau khi áp | tin AI còn `pending` | Tiếp quản xoá tin, job gửi `cancelled` | |
| Chạy trùng | job chạy lại sau khi đã trả lời | `skipped`, không lời gọi | |
| Gửi lỗi | job gửi tin AI lỗi `RECIPIENT_UNAVAILABLE` / `OUTSIDE_24H` | tin `failed`, hội thoại `handoff` `AI_PROVIDER_ERROR` / `OUTSIDE_24H` | |
| Gửi lại tin AI | POST resend tin `app_ai` `failed` | `pending`, job mới, `human` `HUMAN_REPLIED` | |
| Bật lại AI khi khách chờ | `human` + tin khách cuối → `enable-ai` | `ai`, run ngay, AI trả lời | |
| Bật lại AI khi đã trả lời | tin cuối là của chủ shop | run `skipped` | |
| Lỗi bất ngờ lần cuối | DB lỗi ở lần thử cuối | `handoff` `AI_PROVIDER_ERROR`, run `failed`, ném lại | |
| Hộp thư | GET khi typing | `aiTyping=true`; quá 120 giây hoặc không `ai` → `false` | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/{events,inbox}.ts` -- `conversation.ai_typing`, `ConversationDto.aiTyping`
- `server/src/modules/inbox/schema.ts` + `drizzle/` -- `conversations.ai_typing_at`, `messages.sent_at`
- `server/src/modules/inbox/autoreply.ts` (mới), `state.ts`, `send.ts`, `echo.ts`, `queries.ts`, `suggest.ts`, `index.ts` -- ảnh chụp lượt, áp quyết định, typing, tin AI lỗi → handoff, Gửi lại tin AI, `sent_at`
- `server/src/modules/ai/prompts/{reply,index}.ts`, `ai/index.ts` -- ghi chú vi phạm cho lần sinh lại
- `server/src/modules/profiles/{autoreply,index}.ts` -- `autoreplyRunSources(pageId)`
- `server/src/modules/autoreply/{schema,gates,run,triage,decide,test-run,index}.ts` -- `autoreply_runs`, cổng + giờ, lượt chạy, triage mới
- `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts` -- queue `autoreply.run`, triage nghe thêm `state_changed`
- `server/dependency-rules.cjs` -- không đổi (đã có `autoreply → inbox|profiles|ai`)
- `web/src/lib/{inbox,realtime}.ts` (+ test), `web/src/screens/Inbox.tsx` -- chấm đang gõ, Gửi lại tin AI, gợi ý typing

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared` -- sự kiện + DTO
- [x] `server/src/modules/inbox` + migration -- cột, `readAutoreplyTurn`, `applyAutoreplyDecision`, `setAiTyping`, tin AI lỗi → handoff, resend tin AI, `sent_at`
- [x] `server/src/modules/ai` + `inbox/suggest.ts` -- ghi chú vi phạm lần sinh lại
- [x] `server/src/modules/profiles` -- nguồn lượt chạy
- [x] `server/src/modules/autoreply` + migration -- `autoreply_runs`, cổng, triage, run
- [x] `server/src/platform/jobs/queues.ts`, `worker/main.ts`
- [x] `server/test/autoreply-run.test.ts` (mới) -- phủ mọi dòng ma trận (Postgres thật, OpenAI + Meta giả); test thuần cho giờ; sửa test 4.3/4.6 theo cổng mới
- [x] `web` -- typing, Gửi lại tin AI, realtime
- [x] `deferred-work.md` -- đóng mục 4.6 (bật lại AI), 5.3 (sinh lại kèm vi phạm), 4.7 (tin AI lỗi); cập nhật mục echo 4.5

**Acceptance Criteria:**
- Given trang FB có cấu hình AI bật kênh Messenger và khoá OpenAI hợp lệ, when khách nhắn "Nồi chiên bảo hành bao lâu?", then Hộp thư hiện chip "AI đang trả lời" kèm chấm đang gõ, rồi bong bóng tím "AI trả lời" và tin được gửi qua `inbox.send`.
- Given khách nhắn "muốn đổi trả", when lượt chạy, then khách nhận câu chuyển tiếp, hội thoại vào "Cần xử lý" với ghi chú lý do từ khoá.
- `npm run check` xanh; depcruise sạch.

## Implementation Notes

- **Inbox** (`inbox/autoreply.ts` mới):
  - `readAutoreplyTurn`: ảnh chụp + tin khách chưa trả lời + `replyTurns`.
  - `applyAutoreplyDecision`, `setAiTyping`.
  - `state.ts` thêm `onAiMessageFailed` / `aiSendFailureReason`. Đặt ở đây để `send.ts` gọi được mà không tạo vòng import (depcruise `no-circular`).
  - Gửi lại tin AI: `applyHumanReply(..., {keepMessageId})`, để chính tin đang gửi lại không bị huỷ như tin AI `pending` khác.
  - Migration `0024_sour_pride.sql`: `autoreply_runs`, `conversations.ai_typing_at`, `messages.sent_at`.
- **Autoreply:**
  - `gates.ts`: cổng 1–5, giờ VN UTC+7 cố định, `servingChannels` — chỗ 5.5 thêm kênh bình luận.
  - `run.ts`: lượt chạy, `enqueueAutoreplyRun`, `handleRunJob`.
  - `triage.ts` viết lại: nghe thêm `conversation.state_changed`; nếu lệch phiên bản mà hội thoại đã `ai` thì vẫn enqueue.
  - `decide.ts`: kết quả kèm `llmCalls`; `brandOrEmpty` dùng chung với "Thử AI".
  - `profiles.autoreplyRunSources`: kho của đúng chủ cấu hình hiệu lực.
- **Sinh lại kèm vi phạm:** `ai/prompts/reply.ts` `retryNote`, dùng ở `decideReply` và `suggestReply`.
- **Quyết định:**
  - Bình luận ở 5.4 → `CHANNEL_OFF`, đúng hành vi 5.5 mô tả cho kênh tắt.
  - `NON_TEXT_MESSAGE` gửi kèm câu chuyển tiếp (lý do chủ ý). `OUTSIDE_24H` thì không.
  - Mọi `canSend` từ chối → `OUTSIDE_24H` (theo chữ AD-9).
  - Tin AI gửi lỗi vì lỗi khác cửa sổ → `AI_PROVIDER_ERROR`. Chưa có lý do riêng, đã ghi hoãn.
  - Câu ghi chú `GATE_OPEN` ở web đổi thành "AI đang trả lời hội thoại này", vì nay là tin đầu của hội thoại mới.
  - `skipped` không ghi run. Lần thử cuối lỗi bất ngờ → `handoff` `AI_PROVIDER_ERROR`.
- **Hộp thư:**
  - Chấm "đang gõ" ở chip và bong bóng cuối khung chat.
  - Gợi ý `conversation.ai_typing` chỉ làm cũ hội thoại + tin (`TYPE_INVALIDATES`).
  - "Gửi lại" tin AI, tooltip nêu "bạn sẽ tiếp quản".
- **Test:**
  - `server/test/autoreply-run.test.ts`: 27 ca, phủ mọi dòng ma trận + giờ thuần.
  - Sửa test 4.3/4.4/4.6/4.7 theo cổng mới: không cấu hình → `CONFIG_MISSING`; `ai` + tin mới → `queued`; tin AI lỗi gửi lại được.
  - `inbox-suggest` kiểm ghi chú sinh lại. Web: realtime + `canResend`.
  - `npm run check` xanh: server 1153 test, web 234 test, depcruise sạch.
- **Hoãn:**
  - Đã đóng: mục 4.6 (bật lại AI), 4.7 (tin AI lỗi), 5.3 (sinh lại).
  - Đã cập nhật: mục echo 4.5 — giữ hoãn, khuyên tắt Instant Reply.
  - Mới: kiểm trình duyệt / NFR1 thật, kho vượt giới hạn lúc chạy, lý do riêng cho tin AI không gửi được.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| `inbox/autoreply.ts` `readAutoreplyTurn`: tin khách "chưa trả lời" xếp theo `platform_timestamp`. Khách gửi tin trước lúc AI áp nhưng webhook tới sau (mốc Meta < mốc tin AI = giờ áp) → lượt sau thấy tin AI đứng sau tin khách, `pending` rỗng → `skipped`; hội thoại kẹt `ai`, không vào "Cần xử lý" — khách bị bỏ im lặng. Sửa: quét theo thứ tự GHI (`id` uuidv7, dưới khoá luồng), khớp với `lastInboundId`; test "webhook tới sau". Đánh đổi nhỏ: tin chủ shop "Gửi lại" (id cũ) không còn tính là trả lời tin khách đến giữa chừng khi bật lại AI sau đó. | Lỗi thật (trung bình) | `patch` |
| `applyAutoreplyDecision` chỉ so `state_version` + tin khách mới nhất; câu trả lời AI không đổi cả hai → hai lượt cùng ảnh chụp (job quá `expireInSeconds` bị pg-boss cho chạy lại trong khi handler cũ vẫn chạy, không nghe `job.signal`) đều áp được → khách nhận hai câu. Sửa: dưới khoá luồng, đã có tin outbound hiệu lực ghi sau `lastInboundId` → `superseded`; test hai lần áp cùng ảnh chụp. | Lỗi thật (trung bình) | `patch` |
| Lượt chạy quá `expireInSeconds` ở lần thử cuối: pg-boss đánh `failed` mà không qua `catch` của `runAutoreply` → không áp `handoff` `AI_PROVIDER_ERROR`, hội thoại có thể kẹt `ai`. Hiếm (2 lời gọi OpenAI ≤ 240 giây < 300 giây). | Lỗi thật (thấp–trung bình) | `defer` |

## Design Notes

Thứ tự áp trong một transaction (luôn sau khoá luồng):

```
lockConversation → so state/version/lastInboundId → canSend từng tin → insert app_ai pending + job inbox.send
  → (transition handoff|human: tin system đứng sau tin AI cùng mốc giờ, id lớn hơn) → ai_typing_at=null + conversation.ai_typing
```

Đo NFR1 (p95):

```sql
select percentile_cont(0.95) within group (order by extract(epoch from m.sent_at - r.inbound_at))
from autoreply_runs r join messages m on m.id = r.message_ids[1]
where r.outcome = 'replied' and m.sent_at is not null and r.started_at > now() - interval '7 days';
```

## Verification

**Commands:**
- `npm run check` (gốc repo) -- typecheck, lint, depcruise, test đều xanh
