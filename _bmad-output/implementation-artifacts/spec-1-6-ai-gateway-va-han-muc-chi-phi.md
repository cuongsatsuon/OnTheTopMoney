---
title: 'Story 1.6 — AI gateway và hạn mức chi phí'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: 'NO_VCS' # snapshot scratchpad/baseline-1-6
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-5-nhap-va-kiem-khoa-openai.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Chưa có chỗ duy nhất gọi OpenAI để sinh nội dung, chưa tính chi phí, và hạn mức tháng chỉ là con số lưu trong Cài đặt: không có gì chặn chi tiêu hay cảnh báo, còn sidebar, Chiến dịch và Cài đặt vẫn hiện số mẫu.

**Approach:** Thêm AI gateway trong module `ai`. Mỗi lời gọi đi theo trình tự:
1. Lấy khoá.
2. Giữ chỗ chi phí ước tính trong sổ hạn mức tháng (giờ VN), có khoá dòng để api và worker gọi song song không vượt.
3. Gọi OpenAI (`store: false`): Responses API cho chữ, Images API cho ảnh.
4. Ghi `ai_usage` và chuyển chỗ giữ thành chi phí thật trong một transaction.
5. Phát cảnh báo 80% / 100% đúng một lần.

Web hiện số thật ở chip sidebar, toast 80%, banner đỏ toàn app ở 100%, bảng chi phí theo hạng mục ở Cài đặt và số ở màn Chiến dịch.

## Boundaries & Constraints

**Always:** AD-7 nguyên văn: chỉ `modules/ai` gọi `adapters/openai`; mỗi lời gọi có `feature` (`AiFeature`) và `pageId` nếu có; chi phí = usage × `ai_model_prices` × tỉ giá trong Cài đặt; tháng lịch `Asia/Ho_Chi_Minh`; cờ cảnh báo lật bằng `UPDATE … WHERE alerted_x = false`; đổi hạn mức/tỉ giá → tính lại cờ, phát `ai_budget.restored` khi xuống dưới ngưỡng. AD-12: không log prompt, nội dung trả về hay khoá; chỉ log id, feature, model, số token, chi phí. AD-3: sự kiện qua `publishEvent` trong transaction. Giá seed (USD / 1 triệu token, kiểm 2026-10-22 trên trang giá OpenAI):

| Model | Input | Cached input | Output |
|---|---|---|---|
| `gpt-6-luna` | 0,10 | 0,01 | 0,50 |
| `gpt-6.1-sol` | 2,00 | 0,10 | 10,00 |
| `gpt-6-astra` | 10,00 | 1,00 | 50,00 |

Model ảnh `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` và `gpt-image-2` cùng giá: input chữ 5,00, output ảnh 30,00.

Chi phí ảnh lấy theo `usage` nếu API có trả; nếu không, dùng giá ước tính mỗi ảnh `image_usd_each` = 0,05 USD [ASSUMPTION: tài liệu chưa xác nhận Images API trả `usage`]. Ước tính lúc giữ chỗ:
- chữ: số ký tự đầu vào ÷ 3 × giá input, cộng `maxOutputTokens` × giá output;
- ảnh: số ảnh × `image_usd_each`.

Làm tròn lên VND nguyên [ASSUMPTION]. Hạng mục hiển thị: "Trả lời tin nhắn" = `autoreply`, `autoreply_test`, `inbox_suggest`; "Sinh bài viết" = `compose_caption`, `campaign_generate`, `brand_sample`, `contact_summary`; "Sinh ảnh" = `image_generate`. Công tắc `warn80` tắt → không phát cảnh báo 80%, không hiện chip vàng, không toast 80% (100% vẫn luôn chặn). Hạn mức vẫn là số nguyên dương như Story 1.5; nhánh "hạn mức = 0" của AC không xảy ra qua UI [ASSUMPTION]. Chỗ giữ bị bỏ rơi (tiến trình chết giữa chừng) được dọn sau 15 phút.

**Never:** Không dựng tính năng dùng gateway (caption, trả lời…: các story sau). Không tự retry trong gateway (caller quyết theo loại lỗi). Không gửi nội dung người dùng vào log, sự kiện hay `ai_usage`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Gọi chữ thành công | khoá valid, còn hạn mức | trả `{text, usage}`; 1 dòng `ai_usage` với `cost_vnd`, `usd_micros`, token, `feature`, `page_id`; chỗ giữ được thay bằng chi phí thật | N/A |
| Gọi ảnh thành công | `generateImage({prompt, n, size})` | trả bytes ảnh + 1 dòng `ai_usage` (`images = n`) | N/A |
| Chưa có khoá / khoá invalid | status `missing` / `invalid` | `OPENAI_KEY_MISSING` / `OPENAI_KEY_INVALID`, không gọi OpenAI, không giữ chỗ | N/A |
| Hết hạn mức | `spent + reserved + est > limit` | `AI_BUDGET_EXCEEDED` (HTTP 402), không gọi OpenAI | N/A |
| Song song | api và worker cùng giữ chỗ sát ngưỡng | tổng giữ chỗ + đã tiêu không vượt hạn mức; cờ 80% chỉ lật 1 lần, 1 sự kiện | khoá dòng tháng |
| Vượt 80% lần đầu | lời gọi đẩy chi tiêu ≥80% | phát `ai_budget.threshold_reached{level:80}` (nếu `warn80`); web toast + chip vàng | N/A |
| Chạm 100% | chi tiêu ≥ hạn mức | phát `{level:100}`; web banner đỏ toàn app có liên kết "Tăng hạn mức" tới Cài đặt | N/A |
| Tăng hạn mức | lưu hạn mức mới lớn hơn | cờ hạ theo tỉ lệ mới, phát `ai_budget.restored`; banner/chip biến mất | N/A |
| OpenAI 401 lúc chạy | khoá bị thu hồi | `secrets.status=invalid`, phát `openai_key.invalidated` + `settings.updated`; lời gọi sau trả `OPENAI_KEY_INVALID` không gọi ra ngoài | chỗ giữ được trả lại |
| Lỗi khác | 403 / 429 quota / 429 rate / nội dung bị từ chối / 5xx / timeout | `OPENAI_KEY_RESTRICTED` / `AI_PROVIDER_ERROR{kind:PROVIDER_QUOTA}` / `RATE_LIMITED` / `AI_POLICY_BLOCKED{kind:CONTENT_REJECTED}` / `AI_PROVIDER_ERROR{kind:TRANSIENT}` | chỗ giữ được trả lại |
| Huỷ | `AbortSignal` bị huỷ | gửi abort sang OpenAI; huỷ trước khi gửi → trả chỗ giữ, không ghi; huỷ sau khi đã gửi → ghi chi phí ước tính (`estimated = true`) | N/A |
| Sang tháng mới | lời gọi đầu tháng | dòng tháng mới, cờ về false | N/A |
| Xem chi phí | `GET /api/v1/ai/budget` | `{month, limitVnd, spentVnd, reservedVnd, percent, state: ok|warn|blocked, warn80, byCategory:[{category,costVnd,count}]}` | chưa có dòng tháng → 0 |

**Quyết định của chủ sở hữu (2026-10-22):** khi lời gọi có thể đã tới OpenAI rồi mới hỏng (hết giờ, rớt kết nối sau khi gửi, huỷ sau khi gửi, 200 hỏng thân), ghi chi phí ước tính vào hạn mức và đánh dấu `estimated = true`; lỗi HTTP rõ ràng và lỗi trước khi gửi vẫn trả lại chỗ giữ.

</frozen-after-approval>

## Code Map

- `server/src/adapters/openai/index.ts` -- `checkKey`, `classifyStatus` (kinds: KEY_INVALID, KEY_RESTRICTED, PROVIDER_QUOTA, RATE_LIMITED, CONTENT_REJECTED, TRANSIENT): thêm `createResponse` (Responses API, `store:false`, `max_output_tokens`, `signal`) và `generateImage` (Images API, `output_format: jpeg`, `b64_json`); `fake.ts` mở rộng tương ứng.
- `server/src/modules/ai/{key.ts,models.ts,service.ts,schema.ts}` -- `getOpenAiKey` (giải mã, map lỗi), `ai_model_prices` (cột giá đang rỗng), `getOpenAiSettings` (model, tỉ giá, hạn mức, `warn80`): gateway dùng lại.
- `server/src/modules/settings/` -- `secrets` (status), `getOpenAiPrefs`; phát `settings.updated`.
- `server/src/platform/events`, `platform/jobs/queues.ts` -- `publishEvent`; consumer theo queue (mẫu `events.notifications` ở Story 1.4); cron trong registry.
- `packages/shared/src/{events.ts,enums.ts,errors.ts}` -- `ai_budget.threshold_reached|restored`, `openai_key.invalidated` đã có; `AiFeature` đã có.
- `web/src/components/AppShell.tsx:94-101`, `web/src/screens/Campaigns.tsx:133-135`, `web/src/screens/Settings.tsx:395+` -- đang đọc `aiBudget` mẫu từ `mock.ts`.
- `web/src/lib/realtime.ts` (`useRealtimeEvent`), `web/src/lib/openai.ts` (query `['settings','openai']`).

## Tasks & Acceptance

**Execution:**
- [x] `server/drizzle/*` -- migration điền giá theo bảng Boundaries (thêm cột `cached_input_usd_per_1m`), bảng `ai_budget_months(month pk 'YYYY-MM', spent_vnd, alerted_80, alerted_100)`, `ai_reservations(id, month, est_vnd, created_at)`, `ai_usage(id, created_at, month, feature, model, page_id, ref, input_tokens, cached_input_tokens, output_tokens, images, usd_micros, cost_vnd)`.
- [x] `server/src/adapters/openai/{index.ts,fake.ts}` + test -- hai lời gọi mới, phân loại lỗi, abort.
- [x] `server/src/modules/ai/{budget.ts,cost.ts,gateway.ts,index.ts}` -- `reserve` (khoá dòng tháng `FOR UPDATE`, kiểm `spent + Σreserved + est ≤ limit`), `settle`, `release`, `computeCost`, `generateText`, `generateImage`, `getBudgetSummary`, `recomputeAlerts`; xử lý 401 runtime.
- [x] `server/src/platform/jobs/queues.ts` + `server/src/worker/main.ts` -- consumer `events.ai` nghe `settings.updated` → `recomputeAlerts`; cron `ai.reservations_gc` mỗi 5 phút dọn chỗ giữ >15 phút.
- [x] `server/src/app/ai-budget.ts` -- `GET /api/v1/ai/budget`.
- [x] `server/scripts/ai-simulate.ts` + script `ai-simulate` -- dev-only (chặn production): ghi chi phí giả qua `settle` để thử chip/banner mà không gọi OpenAI.
- [x] `server/test/ai-gateway.test.ts` -- mọi dòng ma trận phía server bằng fake adapter, gồm song song (Promise.all nhiều lời gọi sát ngưỡng), log không chứa prompt.
- [x] `packages/shared/src/ai.ts` -- zod `AiBudgetSummary`, hạng mục.
- [x] `web/src/lib/ai-budget.ts` -- `useAiBudget` (query `['ai_budget']`, realtime entity `ai_budget` + `settings`), toast 80% qua `useRealtimeEvent`, hàm thuần `budgetView(summary)` → chip/banner + test.
- [x] `web/src/components/AppShell.tsx` -- chip sidebar số thật (vàng khi warn, đỏ khi blocked), banner đỏ toàn app khi blocked.
- [x] `web/src/screens/Settings.tsx`, `web/src/screens/Campaigns.tsx` -- bảng chi phí theo hạng mục, số thật; bỏ `aiBudget` khỏi `mock.ts` khi không còn ai dùng.
- [x] `web/src/lib/realtime.ts` -- `openai_key.invalidated` vô hiệu hoá `['settings']`.

**Acceptance Criteria:**
- Given `npm run dev`, when chạy `npm run ai-simulate -w server -- 850000` với hạn mức 1.000.000, then trong ≤3 giây tab đang mở có toast 80% và chip vàng; chạy thêm 200000 thì banner đỏ toàn app hiện; tăng hạn mức lên 2.000.000 ở Cài đặt thì banner và chip vàng biến mất.
- Given Cài đặt › OpenAI, when mở bảng chi phí, then thấy tổng tháng, % hạn mức và ba hạng mục với số tiền + số lượng.
- Given `npm run check`, when chạy, then thoát 0.

## Implementation Notes

- **Adapter (`adapters/openai`):** gọi bằng `fetch` như `checkKey` (không thêm SDK `openai`) để test trỏ được về server giả và mọi lỗi đi qua `classifyStatus`. `createResponse` gửi `{model, input, instructions?, max_output_tokens, store:false}`, gom `output_text` của mọi message, đọc `usage` (cached nằm trong input); `status:'incomplete'` → `incomplete: max_output_tokens | content_filter`, phần `refusal` → `refusal`; 200 mà thiếu `usage` → `TRANSIENT`. `generateImage` gửi `output_format:'jpeg'` (không gửi `response_format` — model GPT image luôn trả `b64_json`), giải base64; không có ảnh → `TRANSIENT`. Thêm kết quả `{kind:'ABORTED'}` (caller huỷ) tách khỏi hết giờ (`TRANSIENT`); `moderation_blocked` cũng là `CONTENT_REJECTED`. Hết giờ [ASSUMPTION]: chữ 120 giây, ảnh 180 giây (dưới 15 phút tuổi chỗ giữ).
- **Schema / migration `0004_ai_gateway_budget`:** sinh bằng `drizzle-kit generate` (snapshot khớp), seed giá bằng `UPDATE … FROM (VALUES …)`. `ai_reservations.month` FK tới `ai_budget_months`; `ai_usage` có check `feature ∈ AiFeature`, `month ~ YYYY-MM`. Giá NULL → gateway trả `CONFIG_MISSING` (không gọi OpenAI khi không tính được tiền).
- **Chi phí (`ai/cost.ts`):** tính bằng BigInt đơn vị 10⁻¹² USD từ chuỗi `numeric` (không qua số thực); `usd_micros` và VND làm tròn lên. Ảnh có `usage` → theo token (input 5,00 / output 30,00); không có → số ảnh × `image_usd_each`. Ước tính chữ: `ceil(ký tự/3)` × input + `maxOutputTokens` × output.
- **Sổ hạn mức (`ai/budget.ts`):** `reserve` = insert dòng tháng (on conflict nothing) → `SELECT … FOR UPDATE` → `Σ est_vnd` → chặn khi `spent ≥ limit` hoặc `spent + reserved + est > limit` (402) → insert chỗ giữ. `settle` một transaction: xoá chỗ giữ (đã bị dọn vẫn ghi chi phí), ghi `ai_usage`, `UPDATE spent_vnd = spent_vnd + cost` (khoá dòng), lật cờ. Cờ 80% chỉ lật khi bật `warn80` (tắt rồi bật lại khi đang ≥80% → `recomputeAlerts` lật và phát lại); vượt thẳng từ <80% lên ≥100% phát cả hai mức. `recomputeAlerts` hạ cờ không còn đúng → một `ai_budget.restored`. Id sự kiện: `YYYY-MM:80`, `YYYY-MM:100`, `restored` = `YYYY-MM`. Trạng thái tóm tắt (`aiBudgetState` ở shared) tính từ số đã tiêu, không từ cờ — nên banner mất ngay khi tăng hạn mức, trước cả consumer.
- **Gateway (`ai/gateway.ts`):** `generateText({feature, pageId?, ref?, model?, instructions?, input, maxOutputTokens, signal?})`, `generateImage({feature, pageId?, ref?, model?, prompt, n?, size?, signal?})`; model mặc định theo Cài đặt (`resolveModel`). Ánh xạ lỗi: `KEY_INVALID`→`OPENAI_KEY_INVALID` 400 (+ `invalidateOpenAiKey`: `updateSecretStatus` có thêm `onlyIfStatus`/`afterUpdate` để `settings.updated` + `openai_key.invalidated` cùng transaction, lật một lần); `KEY_RESTRICTED`→`OPENAI_KEY_RESTRICTED` 400; `RATE_LIMITED`→429; `CONTENT_REJECTED`→`AI_POLICY_BLOCKED` 422; `PROVIDER_QUOTA`/`TRANSIENT`→`AI_PROVIDER_ERROR` 502 (`details.kind`, `status`). Huỷ → trả chỗ giữ, ném `signal.reason` (AbortError). Nội dung bị lọc sau khi sinh (`content_filter`/`refusal`) → vẫn ghi chi phí (token đã tính tiền) rồi `AI_POLICY_BLOCKED`. Giới hạn: `maxOutputTokens` 1–32.000, `n` 1–4. `AiDeps` thêm `log?`, `now?` (đồng hồ cho test sang tháng). Log: `feature, model, pageId, usageId, token, usdMicros, costVnd, estVnd`.
- **Worker:** queue `events.ai` (subscribe `settings.updated`, chỉ xử lý khi `keys` có `openai`, poll 0,5 giây) và cron `ai.reservations_gc` `*/5 * * * *`.
- **Web:** `useAiBudget` (`['ai_budget']`, `refetchInterval` 60 giây — chi tiêu giữa hai ngưỡng không phát sự kiện, và để banner tự mất khi sang tháng). `realtime.ts` thêm `ENTITY_ALSO_INVALIDATES` (`openai_key → settings`, `settings → ai_budget`). Toast 80%: `useAiBudgetToasts` ở AppShell nghe `ai_budget.threshold_reached`, tải lại tóm tắt và chỉ toast khi `state = warn`. Chip sidebar là liên kết tới Cài đặt, vàng/đỏ kèm chữ "Sắp chạm hạn mức"/"Đã hết hạn mức"; banner đỏ dính đầu vùng nội dung cùng dải "Đang kết nối lại…". Bảng chi phí: đơn vị "tin" / "lượt" / "ảnh" (Sinh bài viết gồm cả `brand_sample`, `contact_summary` nên dùng "lượt"); % "Đã dùng" xem trước theo hạn mức đang sửa. `aiBudget` đã bỏ khỏi `mock.ts`.
- **Đã kiểm:** `npm run check` exit 0 (server 17 file / 277 test, web 6 file / 66 test, depcruise sạch). Trình duyệt (`npm run dev`, hạn mức 1.000.000): `ai-simulate 850000` → refetch `/ai/budget` sau <1 giây, toast "Đã dùng 80% hạn mức AI tháng này", chip vàng 85%; `+200000` → banner đỏ "Đã dùng hết hạn mức AI tháng này — Tăng hạn mức", chip đỏ 105%; bấm "Tăng hạn mức" → Cài đặt, bảng chi phí hiện tổng, %, ba hạng mục; lưu 2.000.000 → banner và chip vàng mất (52%), worker hạ cờ. Chiến dịch hiện số thật. Dữ liệu thử đã dọn khỏi DB dev.
- **Sửa hạ tầng test:** `vitest run` của `server/` từng thoát 0 cả khi test đỏ — `embedded-postgres` nạp `async-exit-hook`, hook này nghe `beforeExit` và gọi `process.exit(0)` đè `exitCode = 1` của vitest. `test/global-setup.ts` nay nạp động `scripts/lib/embedded-pg.ts` rồi gỡ đúng các listener `beforeExit`/`exit` mới thêm (listener `exit` gọi hook không kèm callback → `TypeError: done is not a function`); hook tín hiệu giữ nguyên, teardown vẫn dừng Postgres. Đã chứng minh bằng test đỏ tạm (exit 1, đã xoá) và test xanh (exit 0); không còn tiến trình Postgres mồ côi.
- **Sau review (vòng 1):**
  - Ước tính: chữ = ký tự ÷ 2 (tiếng Việt có dấu tách token dày hơn); ảnh theo kích thước — 1024×1024 0,10 USD, kích thước khác 0,15 USD, không thấp hơn `image_usd_each` [ASSUMPTION].
  - Adapter: `status` 200 khác `completed`/`incomplete` (`failed`, `cancelled`, `in_progress`, `queued`) → `TRANSIENT`. Kind mới `INVALID_REQUEST` (400/404/422 không phải nội dung bị chặn, vd `context_length_exceeded`) → gateway trả `AI_PROVIDER_ERROR` HTTP 400 kèm `details.kind`; caller không retry. Lỗi `TRANSIENT`/`ABORTED` mang `maybeBilled` (true khi request có thể đã tới OpenAI: hết giờ, đứt sau khi gửi, huỷ sau khi gửi, 200 mà body hỏng; false khi có mã lỗi HTTP, huỷ trước khi gửi, ECONNREFUSED/ENOTFOUND/EAI_AGAIN).
  - Gateway: `maybeBilled` → ghi chỗ giữ thành chi phí với `ai_usage.estimated = true` (migration `0005_ai_usage_estimated`). Điều này **thay ma trận đóng băng** ở dòng "Huỷ … không ghi chi phí" và ở cột "chỗ giữ được trả lại" của lỗi hết giờ, theo yêu cầu review; con người cần xác nhận. `settle` lỗi → trả chỗ giữ, log `error` feature/model/costVnd/usdMicros (không nội dung), ném lại. Model truyền tường minh mà đang tắt → `VALIDATION_FAILED`. `generateImage` trả thêm `{requested, received}`.
  - `AI_BUDGET_EXCEEDED.details` có thêm `remainingVnd` và `estimateVnd` (đổi tên từ `estVnd`). Web `errorMessageOf`: `remainingVnd > 0` → "Hạn mức AI còn lại không đủ cho thao tác này (còn Xđ) — Tăng hạn mức ở Cài đặt."; banner vẫn chỉ hiện khi đã tiêu ≥ hạn mức.
  - Cờ 80%: ghi nhận "tháng đã qua 80%", không phụ thuộc `warn80`. Công tắc chỉ quyết có phát sự kiện 80% hay không; bật/tắt không hạ cờ, không phát `restored`, không phát lại toast. Chỉ đổi hạn mức mới hạ cờ.
  - `handleAiEvent(deps, data: unknown)`: tự kiểm envelope và payload bằng schema chung, thiếu `keys` → `[]`; sai dạng → `ignored`, không ném. Worker truyền thẳng `job.data`.
  - `ai-simulate`: số tiền chỉ nhận chữ số, có thể ngăn nghìn bằng dấu chấm (`1.5`, `850,5`, `-1` bị từ chối). Thêm `--reset`: `resetSimulatedSpend` xoá dòng `dev-simulate` của tháng, đặt lại `spent_vnd` = tổng còn lại và tính lại cờ (hạ cờ → `restored`).
  - Web: chip lỗi tải hiện "—" kèm "Chưa tải được chi phí". Bảng chi phí ở Cài đặt lỗi tải → dòng báo lỗi có nút "Thử lại". Màu % ở Cài đặt dùng `budgetToneOf` (cùng luật `aiBudgetState` với chip, tính `warn80`).
  - `buildApp({clock})` cho route `/ai/budget`. Test thêm: đủ giá cho cả sáu model seed; 401 song song → đúng 1 `openai_key.invalidated` + 1 `settings.updated`; khoá bị thay giữa lời gọi không bị lật; giữ chỗ 23:59 ngày 31/10 rồi ghi sau nửa đêm → tính vào tháng 10; ảnh có chi phí thật vượt ước tính cũ nhưng không vượt ước tính mới; tháng của test route lấy từ `now` cố định.

- **Kiểm thử trên trình duyệt (sau review):** chip sidebar 0% → `ai-simulate 850.000` → 85%, chip "Sắp chạm hạn mức" + toast "Đã dùng 80% hạn mức AI tháng này" → thêm 200.000 → 105%, banner đỏ toàn app + chip đỏ "Đã hết hạn mức" → Cài đặt: bảng chi phí đủ 3 hạng mục + tổng → tăng hạn mức 2.000.000 → banner biến mất, chip 52%. Dữ liệu giả đã xoá (`--reset`), hạn mức trả về 1.000.000. Chưa gọi OpenAI thật (chưa có khoá thật).

## Spec Change Log

## Review Triage Log

| # | Nguồn | Phát hiện | Verdict | Bằng chứng / route |
|---|---|---|---|---|
| 1 | implementer (báo cáo) | `vitest run` của server thoát 0 kể cả khi test hỏng (async-exit-hook) | high | subagent tái hiện bằng test cố ý hỏng; cổng CI vô hiệu; patch |
| 2 | blind, edge (claim) | Ước tính ảnh n×0,05 USD thấp hơn chi phí token (~0,125); chữ ước chars/3 thấp | medium | test của chính diff cho 125.050 micro-USD; patch |
| 3 | blind, edge | Huỷ/hết giờ sau khi đã gửi: không ghi chi phí dù OpenAI có thể tính tiền | medium | `runCall` release và không ghi; patch (ghi ước tính, cờ estimated) |
| 4 | blind, edge | `settle` lỗi sau lời gọi đã trả tiền: mất kết quả, giữ chỗ 15 phút | low | không có catch; patch |
| 5 | blind, edge | 402 khi còn hạn mức nhưng ước tính lớn hơn phần còn lại; chip vẫn "sắp chạm", câu báo sai | medium | `aiBudgetState` chỉ xét spent; patch |
| 6 | blind | `handleAiEvent` không parse payload | low | ép kiểu `{keys}`; patch |
| 7 | blind | Bật/tắt `warn80` phát `restored` và toast 80% lần nữa | low | recomputeAlerts hạ cờ theo warn80; patch |
| 8 | edge | 200 có status failed/cancelled trả ok với chữ rỗng; 400 invalid_request coi là TRANSIENT | medium | adapter không xét `status`, gộp 400; patch |
| 9 | vgap | `content_filter` chưa có test | low | vgap đã xác minh; patch |
| 10 | edge | Model đã tắt vẫn gọi được qua `ctx.model`; ảnh trả thiếu không báo | low | sửa trực tiếp; patch |
| 11 | blind, edge | Lỗi tải hạn mức: chip nhấp nháy mãi, bảng chi phí skeleton mãi; màu % bỏ qua warn80 | low | sửa trực tiếp; patch |
| 12 | blind | Migration giá im lặng khi thiếu model | low | thêm test kiểm 6 model có giá; patch |
| 13 | blind | ai-simulate hiểu sai `1.5`/`850,5`; không xoá được chi phí giả | low | dev-only; sửa trực tiếp; patch |
| 14 | vgap | 401 song song chưa kiểm đúng 1 sự kiện; cuộc gọi vắt qua tháng; realMonth dễ chập chờn | medium | vgap đã xác minh; patch |
| 15 | blind | Cảnh báo 80/100% chỉ là toast, không vào chuông | low | EXPERIENCE chỉ yêu cầu toast + chip/banner; reject |
| 16 | blind | Chưa có test component chip/banner/toast | low | logic đã tách hàm thuần có test; reject |
| 17 | vgap | Wiring `events.ai` trong worker chưa có test | low | repo chưa có hạ tầng test wiring worker; reject (vgap đề defer) |

## Design Notes

Giữ chỗ bằng bảng dòng (`ai_reservations`) thay vì một cột cộng dồn: tiến trình chết giữa chừng chỉ để lại dòng có `created_at`, cron dọn được; tổng giữ chỗ là `SUM` trong cùng transaction đã khoá dòng tháng.

```sql
select spent_vnd from ai_budget_months where month = $1 for update;
-- + coalesce(sum(est_vnd),0) from ai_reservations where month = $1
-- nếu spent + reserved + est > limit → AI_BUDGET_EXCEEDED, ngược lại insert ai_reservations
```

## Verification

**Commands:**
- `npm run check` -- expected: exit 0
- Manual: AC thứ nhất và thứ hai trên trình duyệt (không gọi OpenAI thật).
