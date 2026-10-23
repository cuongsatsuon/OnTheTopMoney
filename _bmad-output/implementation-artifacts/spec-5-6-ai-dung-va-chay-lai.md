---
title: 'Story 5.6 — AI dừng và chạy lại đúng lúc khi hết hạn mức hoặc khoá lỗi'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '390c6f0fbcbbfac9d713a7498263b3f46612ce79'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-4-ai-tu-tra-loi.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 5.6, AD-7, AD-9, AD-16; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** 5.4/5.5 đã dừng AI đúng lúc: hết hạn mức, khoá lỗi, lỗi nhà cung cấp, ngoài giờ → `handoff` tạm đóng, không gửi gì. Nhưng hội thoại kẹt ở đó mãi. Chủ shop tăng hạn mức hay sửa khoá xong, khách nhắn tiếp vẫn không được AI trả lời, trừ khi bật lại AI từng hội thoại. Tin AI gửi lỗi phía Meta cũng đang mang lý do tạm đóng `AI_PROVIDER_ERROR`. Từ story này lý do tạm đóng tự chạy lại, nên lỗi gửi cần lý do riêng.

**Approach:** Theo AD-9/AD-16, `autoreply.run` chạy được cả cho `handoff` tạm đóng (chủ shop chưa trả lời).
- Tin kế tiếp của chính khách hội thoại → triage xem cổng 1–5. Còn đóng tạm thời → bỏ qua. Ngược lại → hẹn lượt chạy như hội thoại `ai`.
- Lượt chạy quyết định như thường. Có gì để gửi (trả lời / câu chuyển tiếp) thì `applyAutoreplyDecision` đưa `handoff → ai` (`GATE_OPEN`) rồi áp tiếp như 5.4. Còn tạm đóng thì giữ nguyên, không ghi gì.

Khôi phục chỉ do tin khách kích hoạt, không quét lại khi có `ai_budget.restored` / `settings.updated`.

## Boundaries & Constraints

**Always:**
- **Hội thoại khôi phục được** = `state=handoff`, `state_reason` thuộc loại `transient` của `HANDOFF_REASON_KIND`: `OUTSIDE_HOURS`, `OPENAI_KEY_UNAVAILABLE`, `AI_BUDGET_EXCEEDED`, `AI_PROVIDER_ERROR`. Lý do sticky, `human`, `done` không bao giờ tự về `ai`. Chủ shop trả lời / Tiếp quản luôn đưa hội thoại sang `human` (AD-9), nên "chưa trả lời từ lúc handoff" = vẫn ở `handoff`.
- **Triage** (`message.received`, hội thoại khôi phục được):
  - tin của người khác trong luồng bình luận → bỏ qua (đã ở "Cần xử lý");
  - cổng 1–5 đóng với lý do tạm đóng → `skipped`, không job, không ghi gì;
  - còn lại (mở / không áp dụng) → `autoreply.run` trễ 4 giây (stately như 5.4).
- **Lượt chạy** nhận `state=ai` hoặc hội thoại khôi phục được. Hội thoại bình luận còn tin người khác chưa ai trả lời → `skipped`.
  - Quyết định tạm đóng (cổng 5, lỗi gateway, JSON hỏng) khi đang `handoff` → không áp. Run `handoff` + lý do, không tin, không tin `system`, không thông báo.
  - Lỗi bất ngờ ở lần thử cuối khi đang `handoff` → không áp fallback (đã ở "Cần xử lý").
- **`applyAutoreplyDecision`** chấp nhận ảnh chụp `handoff` khôi phục được (cùng `state_version`, cùng `lastInboundId`):
  - có tin AI hoặc trả lời (`transition=null`) → trước hết `handoff → ai` `GATE_OPEN` (tin `system` đứng trước tin AI), rồi y như 5.4;
  - không tin, đích `human` (không áp dụng) / `handoff` sticky (`OUTSIDE_24H`) → chuyển thẳng từ `handoff`, không qua `ai`;
  - đích `handoff` tạm đóng, không tin → không ghi gì (`unchanged`).
- **Lỗi gateway → lý do (AC1, giữ bảng 5.3):** `AI_BUDGET_EXCEEDED` → `AI_BUDGET_EXCEEDED`; `OPENAI_KEY_*` (gồm 401 lúc chạy, khoá thành `invalid`) → `OPENAI_KEY_UNAVAILABLE`; `PROVIDER_QUOTA` / `RATE_LIMITED` / 5xx → `AI_PROVIDER_ERROR`. Đều tạm đóng, không câu chuyển tiếp.
- **Lý do mới `AI_SEND_FAILED` (sticky):** tin AI không tới được khách vì lỗi phía gửi (mã khác cửa sổ: `SEND_FAILED`, `RECIPIENT_UNAVAILABLE`, `PAGE_DISCONNECTED`, `SEND_UNKNOWN`…). Sticky vì cổng không biết sự cố gửi đã hết chưa, tin `SEND_UNKNOWN` có thể đã tới khách. Shared enum + CHECK (migration `drizzle-kit generate`), câu ở web và thông báo.
- **Lượt hết hạn ở lần thử cuối:** `job.signal` truyền xuống gateway. pg-boss huỷ khi quá `expireInSeconds` → lỗi huỷ → lần cuối áp fallback như lỗi bất ngờ.
- **Kho vượt 40k lúc chạy** (cửa sổ đua của 5.2): `autoreplyRunSources` chỉ nhét các mục `ready` theo thứ tự hiển thị tới khi chạm `KNOWLEDGE_MAX_TOKENS`, bỏ phần còn lại. Log số mục bỏ, không log nội dung. Màn cấu hình đã hiện mức dùng vượt.
- **NFR1:** run khôi phục lấy `inbound_at` = tin khách đầu tiên sau lần chuyển trạng thái cuối, không phải tin cũ đã chờ từ trước.
- Web: câu ghi chú của 4 lý do tạm đóng nói rõ AI trả lời lại từ tin kế tiếp; thêm câu `AI_SEND_FAILED` (Hộp thư, Thử AI).
- AD-1 giữ nguyên (`autoreply → inbox|profiles|ai`, báo ngược chỉ qua sự kiện). Không log nội dung.

**Never:**
- Không quét / chạy lại hàng loạt hội thoại khi hạn mức hay khoá được khắc phục (dễ trả lời tin cũ ngoài cửa sổ gửi, trả lời trùng).
- Không đổi lý do của `handoff` tạm đóng sang lý do tạm đóng khác. Không thêm chấm "đang gõ" cho lượt khôi phục.
- Không thêm queue / cron. Không gọi OpenAI / Meta thật trong test. Không đổi `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Hết hạn mức lúc chạy | `ai`, hạn mức đủ qua cổng nhưng không đủ ước tính lời gọi | `handoff` `AI_BUDGET_EXCEEDED`, không tin AI | |
| Khoá bị thu hồi lúc chạy | OpenAI 401 | `handoff` `OPENAI_KEY_UNAVAILABLE`, khoá `invalid`, không tin AI | |
| Hết quota nhà cung cấp | OpenAI `PROVIDER_QUOTA` | `handoff` `AI_PROVIDER_ERROR`, không tin AI | |
| Tăng hạn mức rồi khách nhắn | `handoff` `AI_BUDGET_EXCEEDED`; tăng hạn mức; khách nhắn | triage `queued`; run `replied`: `system GATE_OPEN` rồi tin `app_ai`; `ai`; prompt có cả tin đang chờ | |
| Sửa khoá rồi khách nhắn | `handoff` `OPENAI_KEY_UNAVAILABLE`; lưu khoá hợp lệ; khách nhắn | như trên | |
| Chưa khắc phục | `handoff` `AI_BUDGET_EXCEEDED`, hạn mức vẫn hết; khách nhắn | triage `skipped`, không job, không tin `system` mới | |
| Lượt chạy vẫn lỗi | `handoff` `AI_PROVIDER_ERROR`; LLM vẫn 5xx | run `handoff`; hội thoại giữ nguyên lý do, không tin `system` / thông báo mới | |
| Chỉ khắc phục, khách không nhắn | `handoff` `AI_BUDGET_EXCEEDED`; tăng hạn mức (`settings.updated`, `ai_budget.restored`) | không job, giữ `handoff` | |
| Đã tiếp quản | `handoff` tạm đóng → Tiếp quản; khắc phục; khách nhắn | `human`, không job, không lời gọi | |
| Tiếp quản giữa lúc khôi phục | Tiếp quản khi LLM đang chạy | `superseded`, không tin; `human` | |
| Lý do chủ ý | `handoff` `KEYWORD` / `AI_SEND_FAILED`; khách nhắn | triage `skipped`, giữ `handoff` | |
| Khôi phục rồi chuyển chủ ý | `handoff` `AI_BUDGET_EXCEEDED`, đã khắc phục; khách nhắn "đổi trả" | `GATE_OPEN`, câu chuyển tiếp, `KEYWORD`; `handoff` sticky | |
| Khôi phục mà quá 24 giờ | tin chờ cũ + `canSend` từ chối | `handoff` `OUTSIDE_24H` thẳng từ `handoff`, không `GATE_OPEN`, không tin AI | |
| Khôi phục mà AI đã tắt | cấu hình trang tắt; khách nhắn | `human` `AI_OFF` (AD-9), không lời gọi | |
| Không trả lời trùng | AI đã trả lời tin 1; tin 2 → `handoff`; khắc phục; khách nhắn tin 3 | MỘT lời gọi, MỘT tin AI. Tin cần trả lời = 2 + 3, không gồm tin 1. Job chạy lại → `skipped` | |
| Người khác trong luồng | bình luận `handoff` tạm đóng; người khác bình luận | triage `skipped`; run (nếu có) `skipped` | |
| Tin AI gửi lỗi | Meta `RECIPIENT_UNAVAILABLE` / `SEND_UNKNOWN` (cron) | `handoff` `AI_SEND_FAILED`; `OUTSIDE_24H` giữ nguyên | |
| Hết hạn lần cuối | `job.signal` huỷ giữa lời gọi ở lần thử cuối | `handoff` `AI_PROVIDER_ERROR`, run `failed`, ném lại | |
| Kho vượt lúc chạy | tổng `ready` > 40k | prompt chỉ gồm các mục đầu ≤ 40k; vẫn trả lời | |
| NFR1 | run khôi phục | `inbound_at` = mốc tin khách mới, không phải tin chờ cũ | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/enums.ts` -- `AI_SEND_FAILED` + bảng loại
- `server/src/modules/inbox/{state,autoreply,index}.ts` + `drizzle/` -- `resumableHandoff`, `TriageState.stateReason`, ảnh chụp lượt thêm lý do/mốc chuyển/người khác, áp quyết định từ `handoff`, lý do lỗi gửi
- `server/src/modules/autoreply/{triage,run}.ts` -- triage khôi phục, lượt chạy từ `handoff`, `signal`, `inbound_at`
- `server/src/modules/profiles/autoreply.ts` -- cắt kho theo giới hạn
- `server/src/worker/main.ts` -- (đã truyền `job`, `signal` đi theo)
- `server/src/modules/notifications/service.ts` -- câu `AI_SEND_FAILED`
- `web/src/lib/{inbox,autoreply}.ts` (+ test) -- câu lý do
- `server/test/autoreply-resume.test.ts` (mới), `autoreply-run.test.ts` -- ma trận

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/enums.ts` -- `AI_SEND_FAILED` sticky
- [x] `server/src/modules/inbox` + migration -- khôi phục được, ảnh chụp, áp từ `handoff`, `aiSendFailureReason`
- [x] `server/src/modules/autoreply/{triage,run}.ts` -- triage + run khôi phục, `signal`, `inbound_at`, bỏ fallback khi `handoff`
- [x] `server/src/modules/profiles/autoreply.ts` -- cắt kho
- [x] `server/src/modules/notifications/service.ts`, `web/src/lib/{inbox,autoreply}.ts` -- câu lý do
- [x] `server/test/autoreply-resume.test.ts` -- phủ mọi dòng ma trận; sửa test 5.4 theo `AI_SEND_FAILED`
- [x] `deferred-work.md` -- đóng mục 5.4 (lý do gửi lỗi, hết hạn lần cuối, kho vượt lúc chạy)

**Acceptance Criteria:**
- Given gateway trả `AI_BUDGET_EXCEEDED` / `OPENAI_KEY_INVALID` / `PROVIDER_QUOTA`, when triage hoặc lượt chạy, then hội thoại `handoff` lý do `AI_BUDGET_EXCEEDED` / `OPENAI_KEY_UNAVAILABLE` / `AI_PROVIDER_ERROR`, không câu chuyển tiếp.
- Given chủ shop đã tăng hạn mức hoặc sửa khoá, when khách nhắn tiếp trong `handoff` tạm đóng mà chủ shop chưa trả lời, then hội thoại về `ai` và AI trả lời bình thường.
- `npm run check` xanh; depcruise sạch.

## Implementation Notes

- **Shared + DB:** `AI_SEND_FAILED` (sticky) trong `HANDOFF_REASONS`; migration `0026_material_vermin.sql` (CHECK `state_reason`, `reason_code`, `autoreply_runs.reason_code`) sinh bằng `drizzle-kit generate`.
- **Inbox:**
  - `state.ts`: `resumableHandoff(state, reason)`, `TriageState.stateReason`, `aiSendFailureReason` → `AI_SEND_FAILED`.
  - `autoreply.ts`: ảnh chụp thêm `stateReason`, `stateChangeId` (id tin `system` cuối), `othersPending`. `applyAutoreplyDecision` nhận `handoff` khôi phục được: chuyển `→ ai` `GATE_OPEN` trước tin AI, hoặc chuyển thẳng khi không tin, `unchanged` khi vẫn tạm đóng.
- **Autoreply:**
  - `triage.ts` `resumeHandoff`: tin người khác / cổng tạm đóng → `skipped`; còn lại enqueue run trễ 4 giây.
  - `run.ts`: nhận `handoff` khôi phục được; `stillClosed` không áp; không fallback khi khôi phục; `job.signal` xuống `decideReply`.
- **Profiles:** `capKnowledge` cắt kho theo thứ tự hiển thị (mục sau vừa thì vẫn giữ); run log số mục bỏ.
- **Quyết định thêm khi làm:**
  - Lượt khôi phục chỉ chạy khi có tin khách ghi SAU tin `system` cuối (so id uuidv7 — mốc `created_at` ms có thể trùng). Job sót lại không kéo hội thoại khỏi "Cần xử lý". Mốc này cũng là `inbound_at` (NFR1).
  - Không áp dụng (AI tắt) lúc khôi phục → `handoff → human` theo sơ đồ AD-9. Triage vẫn hẹn lượt để lượt chạy ghi chuyển.
  - Web: 4 câu tạm đóng thêm "AI trả lời lại từ tin kế tiếp…"; câu `AI_SEND_FAILED` ở Hộp thư, Thử AI, thông báo.
- **Test:**
  - `server/test/autoreply-resume.test.ts` (mới, 20 ca): phủ mọi dòng ma trận + `capKnowledge` thuần.
  - `autoreply-run.test.ts`: tin AI gửi lỗi / kẹt `sending` → `AI_SEND_FAILED`.
  - Web `inbox.test.ts` theo câu mới.
  - `npm run check` xanh: server 1199 test, web 236 test, depcruise sạch.
- **Hoãn:**
  - Đã đóng 3 mục 5.4: lý do riêng tin AI lỗi, hết hạn ở lần thử cuối, kho vượt lúc chạy.
  - Mới: kiểm trình duyệt luồng 5.6, lý do tạm đóng lỗi thời khi nguyên nhân đổi, dồn thông báo `ai_handoff` khi hết hạn mức.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Người khác bình luận trong luồng lúc lượt khôi phục đang nghĩ: triage bỏ qua tin đó vì hội thoại còn `handoff` (không tăng `state_version`), `applyAutoreplyDecision` chỉ so tin của khách → AI trả lời, hội thoại về `ai`, bình luận của người khác rơi khỏi "Cần xử lý". Sửa: lúc áp từ `handoff` khôi phục, còn bình luận người khác (chưa gỡ) ghi sau `lastInboundId` → `superseded` (+ test). | real (medium) | patch |
| Chủ shop trả lời ngoài app mà echo không rõ app (bình luận FB/IG, DM IG không `app_id`) được hoãn `inbox.echo_match` 5 giây × 3 trước khi ghi `external_human` → `human`; khách nhắn tiếp trong khoảng đó thì lượt khôi phục không thấy tin của chủ shop và AI trả lời chen. | real (medium, cửa sổ ~15–20 giây) | defer |
| Hội thoại đang `handoff` `AI_PROVIDER_ERROR` từ trước 5.6 do tin AI gửi lỗi (lúc đó chưa có `AI_SEND_FAILED`) nay thành khôi phục được. Migration không đổi lý do dữ liệu cũ. | real (chỉ khi đã có dữ liệu thật) | defer |

## Design Notes

Thứ tự trong transaction áp, khi ảnh chụp là `handoff` khôi phục được:

```
lockConversation → so version/lastInboundId/đã trả lời → canSend từng tin
  → (có tin hoặc reply) transition handoff→ai GATE_OPEN → insert app_ai + inbox.send → (đích) transition ai→handoff|human
  → (không tin, đích human|sticky) transition handoff→đích
```

## Verification

**Commands:**
- `npm run check` (gốc repo) -- typecheck, lint, depcruise, test đều xanh
