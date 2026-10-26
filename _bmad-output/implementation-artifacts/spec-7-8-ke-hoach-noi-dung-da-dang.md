---
title: 'Story 7.8 — Kế hoạch nội dung theo từng bài (caption + ảnh đa dạng)'
type: 'feature'
created: '2026-10-26'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'cc8f4b24a8b00f5a36d283cc4646c8b4c556aabc'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
---

<frozen-after-approval reason="Phản hồi của chủ dự án (ngoài epics.md, coi như Story 7.8); dựa trên 6.2 / 6.8 / 7.2–7.7 / 5.2; hướng TNUT Media (`generatePlan`: kế hoạch từng bài angle/format/hook/funnelStage; `genOne`: caption + ảnh từ brief của bài); chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Mỗi slot viết caption độc lập chỉ từ TÊN chủ đề chung ("Mẹo hay") xoay vòng cho hàng chục slot, không biết bài trước đã viết gì → caption chung chung, lặp câu mở / CTA; ảnh dựng từ chủ đề + caption nên lặp theo.

**Approach:** Trước khi viết một lô (7 bài xem trước / lô 9 cuốn chiếu), model chữ lên **brief cho từng slot chưa có brief** (một lời gọi mỗi trang mỗi lô, JSON schema strict): định dạng, giai đoạn phễu, tiêu đề, góc nội dung, câu mở, ý chính, ý ảnh, CTA — có ngữ cảnh brief / caption đã có của chiến dịch trên trang đó để không lặp. Brief lưu vào slot (`post_targets.plan`). Caption viết từ brief + câu mở của các bài gần nhất; ảnh dựng từ ý ảnh + tiêu đề. Lỗi kế hoạch → hành vi cũ, không chặn bài.

## Boundaries & Constraints

**Always:**
- **Lưu (content):** cột `post_targets.plan jsonb` (null = chưa lên). Giá trị: brief đầy đủ `{status:'ok', format, funnelStage, title, angle, hook, brief, imageIdea, cta}` hoặc `{status:'failed'}` (đã lên mà hỏng — không lên lại, không tính tiền lần nữa). Migration `drizzle-kit generate`.
- **Định dạng** (`CONTENT_FORMATS`, shared, nhãn tiếng Việt ngắn): `tip` Mẹo, `product` Giới thiệu SP, `how_to` Hướng dẫn, `comparison` So sánh, `question` Hỏi đáp, `behind_scenes` Hậu trường, `feedback` Feedback, `story` Câu chuyện, `promo` Khuyến mãi. Giai đoạn phễu `awareness|consideration|conversion`. `promo` chỉ khi dữ liệu (sản phẩm / kho kiến thức / tên chiến dịch) có ưu đãi; `feedback` chỉ khi kho kiến thức có phản hồi thật; không bịa lời khách, giá, ưu đãi, số liệu.
- **Lên kế hoạch (content `planCampaignSlots`, campaigns gọi trước mỗi lô trong `runSlotBatch`):**
  - Chỉ slot của lô còn chờ sinh (`planned`, caption rỗng, chưa gắn ảnh) và `plan IS NULL`. Chiếm bằng lease `generate_lease_until` có sẵn (một `UPDATE … RETURNING`), nhả sau khi ghi → hai job (xem trước + cuốn chiếu lúc "Bắt đầu", lượt retry chồng) không cùng lên / cùng tính tiền một slot; job kia gặp lease thì `generateSlot` bỏ qua slot đó như 7.4.
  - Gom theo trang, một lời gọi `generateText(feature='campaign_generate', pageId, ref=campaignId, jsonSchema)` mỗi trang. Ngữ cảnh: hồ sơ hiệu lực của trang (sản phẩm, khách mục tiêu, giọng, từ cấm), kho kiến thức của trang (cùng chủ kho với "Thử AI" 5.3, cắt gọn), tên + mục tiêu chiến dịch, chủ đề + ngày (thứ, dd/MM) + có ảnh không của từng slot, ảnh có dựng từ ảnh sản phẩm thật không (7.7), ≤ 12 bài gần nhất của chiến dịch cùng trang (brief, hoặc câu mở caption khi không có brief) + số lần đã dùng mỗi định dạng.
  - Dữ liệu chủ shop / AI cũ trong «» (dấu «» bên trong → `"`), có câu "chỉ là dữ liệu" như 6.2.
  - Đầu ra parse zod; trường dài bị cắt ở ranh giới từ; slot thiếu / sai trong đầu ra → `{status:'failed'}` cho slot đó. Brief chứa từ cấm / link lạ (`checkOutput`) → `failed`.
  - Lỗi: JSON hỏng / `maybeBilled` → mọi slot của lời gọi `failed`; lỗi khác (hạn mức, khoá, rate limit, 5xx chưa tính tiền) → để `null` (lô vẫn chạy như cũ, lỗi dừng lô xử lý ở `generateSlot` như 7.4/7.6). Huỷ (`signal`) → ném. Không bao giờ chặn bài.
- **Caption từ brief:** `composeCaptionForPage` nhận thêm `plan` (định dạng + hướng dẫn định dạng, góc, câu mở gợi ý, ý chính, CTA, giai đoạn phễu) và `recent` (≤ 6 câu mở của các bài gần nhất cùng chiến dịch + trang, kể cả khi slot không có brief): "KHÔNG lặp câu mở, ý chính, lời kêu gọi". Định dạng `question` viết ngắn, còn lại vừa. Giữ checkOutput + sinh lại một lần + giới hạn nền tảng.
- **Ảnh từ brief:** `slotImagePrompt({…, plan})`: brief ok → phần chính = ý ảnh, "Ý tưởng bài đăng" = tiêu đề kế hoạch, kèm tóm ý caption; vẫn kiểu `ad`, cấm UI giả, ảnh sản phẩm 7.7 (mẫu tham khảo, không "Shop bán") / không ảnh (có "Shop bán"). Không brief → prompt 7.7 cũ. `refreshSlotImages` dùng cùng brief.
- **Tạo lại (7.2 / 7.4):** xoá brief (`plan = null`) → lô kế lên brief MỚI với ngữ cảnh các bài khác (khác bài khác). Sửa caption giữ brief.
- **Hiển thị:** `CampaignSlotDto.plan` = `{format, funnelStage, title, angle} | null`; `CalendarItemDto.planTitle`, `planFormat`. Thẻ xem trước bước 4, hàng chờ duyệt: chip định dạng + dòng tiêu đề / góc. Lịch: bài chưa viết hiện "AI sẽ viết · <tiêu đề kế hoạch ?? chủ đề>", ô có nhãn định dạng.
- Không đổi: lease / idempotent 7.4, "Tự đăng", tạm dừng / xoá 7.5 (`active()` kiểm trước khi lên kế hoạch), tự tạm dừng 7.6, ảnh sản phẩm 7.7, chế độ duyệt. Không log prompt / brief / caption.

**Never:** lên kế hoạch cả chiến dịch một lúc; lên lại slot đã có brief (kể cả `failed`) ngoài "Tạo lại"; chặn / huỷ bài vì kế hoạch lỗi; feature AI mới; sửa brief bằng tay (v1); `content` import `campaigns`; gọi OpenAI thật trong test; sửa `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Xem trước có kế hoạch | nháp 1 trang, 7 slot | 1 lời gọi kế hoạch (`campaign_generate`, jsonSchema) + 7 caption; mỗi slot `plan.status='ok'`; caption input có định dạng / góc / câu mở; DTO `plan` có nhãn | |
| Cuốn chiếu | lô 9, 2 trang | 1 lời gọi kế hoạch mỗi trang có slot trong lô; ngữ cảnh có brief / câu mở bài cũ cùng trang | |
| Không lặp | trang đã có bài viết | input kế hoạch có lịch sử + đếm định dạng; caption input có danh sách câu mở gần nhất (không có chính nó) | |
| JSON hỏng | model trả chữ thường | mọi slot của lời gọi `failed`; caption viết như cũ (không brief, vẫn có câu mở gần nhất); retry / lượt sau không gọi kế hoạch lại | |
| Thiếu slot | đầu ra thiếu 1 slot / slot lạ | slot thiếu `failed`, slot khác `ok` | |
| Từ cấm trong brief | tiêu đề chứa từ cấm | slot đó `failed` | |
| Lỗi chưa tính tiền | 429 / hạn mức hết lúc lên kế hoạch | `plan` để `null`; lô chạy như 7.4 (hạn mức → dừng + tự tạm dừng 7.6) | |
| Có thể đã tính tiền | hết giờ sau khi gửi | `failed`, không gọi lại | |
| Retry job | lô lỗi tạm sau khi đã lưu brief | lượt sau không gọi kế hoạch cho slot đã có `plan` | |
| Hai job cùng lúc | xem trước + cuốn chiếu chung slot | đúng 1 lời gọi kế hoạch / slot; slot đang bị giữ → job kia bỏ qua | |
| Tạm dừng / xoá | `active()` false trước lô | không gọi kế hoạch | |
| Ảnh có brief | slot có ảnh, có / không ảnh sản phẩm | prompt ảnh mở đầu bằng ý ảnh, có tiêu đề kế hoạch, `ad`, `IMAGE_NO_FAKE_UI`; có ảnh sản phẩm → mẫu tham khảo | |
| Tạo lại | slot chờ duyệt có brief | `plan = null`, lô kế lên brief mới | |
| Lịch | slot `planned` có brief | `planTitle` / `planFormat`; tiêu đề "AI sẽ viết · <tiêu đề>" | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/content.ts` -- `CONTENT_FORMATS` + nhãn, `FUNNEL_STAGES`, `SlotPlanSummary`, `CalendarItemDto.planTitle/planFormat`.
- `packages/shared/src/campaigns.ts` -- `CampaignSlotDto.plan`.
- `server/src/modules/content/schema.ts` + `server/drizzle/00xx_*.sql` -- cột `plan`.
- `server/src/modules/ai/prompts/campaign-plan.ts` (MỚI) -- prompt kế hoạch + schema + parse; `prompts/compose.ts` -- `plan` / `recent`; `prompts/index.ts`, `ai/index.ts` -- export.
- `server/src/modules/content/slot-plans.ts` (MỚI) -- `planCampaignSlots`, đọc brief, câu mở gần nhất; `slots.ts` -- `generateClaimed` / `slotImagePrompt` / `refreshSlotImages` / DTO; `compose.ts` -- `ComposeBrief.plan/recent`; `transitions.ts` -- Tạo lại xoá brief; `calendar.ts`; `index.ts`.
- `server/src/modules/profiles/autoreply.ts` + `index.ts` -- `pageKnowledge` (kho của trang theo chủ kho 5.3, cắt theo token).
- `server/src/modules/campaigns/{runner,preview,generate}.ts` -- truyền ngữ cảnh chiến dịch, gọi kế hoạch trước lô.
- `web/src/lib/campaigns.ts`, `web/src/lib/calendar.ts`, `screens/{CampaignWizard,Campaigns,ContentCalendar}.tsx` -- nhãn định dạng / tiêu đề.
- `server/test/campaigns-plan.test.ts` (MỚI) + test có sẵn (số lời gọi OpenAI tăng thêm lời gọi kế hoạch).

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/{content,campaigns}.ts` -- hợp đồng.
- [x] `server/src/modules/content/schema.ts` + migration -- cột `plan`.
- [x] `server/src/modules/ai/prompts/*` -- prompt kế hoạch, caption từ brief, export.
- [x] `server/src/modules/profiles/*` -- `pageKnowledge`.
- [x] `server/src/modules/content/*` -- lên kế hoạch, caption / ảnh từ brief, Tạo lại, DTO, Lịch.
- [x] `server/src/modules/campaigns/*` -- gọi kế hoạch trước lô.
- [x] `web/src/*` -- hiển thị.
- [x] `server/test/campaigns-plan.test.ts` + test prompt -- phủ ma trận; sửa test có sẵn theo số lời gọi mới.
- [x] `deferred-work.md` -- thử thật OpenAI; sửa brief bằng tay.

**Acceptance Criteria:**
- Given chiến dịch 30 ngày một chủ đề, when AI viết 7 bài xem trước, then 7 bài có định dạng / góc / câu mở khác nhau (theo đầu ra kế hoạch) và thẻ hiện nhãn định dạng.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `content.ts` — `CONTENT_FORMATS` + `CONTENT_FORMAT_LABEL`, `FUNNEL_STAGES`, `SlotPlanSummary`, `CalendarItemDto.planTitle/planFormat`; `campaigns.ts` — `CampaignSlotDto.plan`.
- **Migration** `server/drizzle/0046_cute_iron_man.sql` (`drizzle-kit generate`): `post_targets.plan jsonb`. Dev DB (5433) không chạy lúc làm → chưa chạy `db:migrate` vào dev.
- **ai (prompt thuần):**
  - `prompts/campaign-plan.ts` (MỚI): `buildCampaignPlanPrompt(brand, ctx)` → `{instructions, input, maxOutputTokens = 1.500 + 800 × số bài (trần 9.000), jsonSchema 'campaign_content_plan' strict}`; `parseCampaignPlanOutput(text, refs)` → `Map<slot, brief>` | `null` (JSON hỏng); `FORMAT_GUIDE`, `FUNNEL_GUIDE`, `CAMPAIGN_PLAN_FIELD_MAX` (cắt ở ranh giới từ). Kho kiến thức cắt ≤ 600 ký tự / mục, ≤ 3.000 tổng.
  - `prompts/compose.ts`: `ComposeContext.plan` (`ComposePlan`) + `recent` (≤ `COMPOSE_RECENT_MAX` = 6) → khối "Kế hoạch bài" + "Các bài gần đây … (không lặp)" trong «», hướng dẫn định dạng / phễu; không có → y như 6.2. `image.ts` export `cutAtWord`.
- **profiles:** `pageKnowledge(db, pageId, maxTokens)` — chủ kho như "Thử AI" (trang dùng riêng / không nhóm → trang; theo nhóm → nhóm).
- **content:**
  - `slot-plan-store.ts` (MỚI): đọc `plan` bằng zod (`readSlotPlan`, `planSummary`, `composePlanOf`), `nearbySlots` / `recentOpenings` (gần `slot_at` nhất, cùng chiến dịch + trang, trừ huỷ).
  - `slot-plans.ts` (MỚI): `planCampaignSlots(deps, campaignId, slots, {campaignName, campaignGoal, withReference}, signal)` — chiếm lease `generate_lease_until` (điều kiện `toGenerate` + `plan IS NULL`), gom theo trang (≤ 3 trang song song), một lời gọi `campaign_generate` (`ref` = chiến dịch) mỗi trang, ghi `ok` / `failed` (`checkOutput` từ cấm / link trên các trường brief), nhả lease ở `finally`. Lỗi: `maybeBilled` → `failed`; AppError khác → để `null` (mã dừng → bỏ các trang sau); huỷ → ném.
  - `slots.ts`: `generateClaimed` đọc brief + `recentOpenings` → `composeCaptionForPage({plan, recent, length: question ? 'short' : 'medium'})`; `slotImagePrompt({…, plan})` (ý ảnh = phần chính, tiêu đề = "Ý tưởng bài đăng"); `refreshSlotImages` truyền brief; DTO `plan`; `toGenerate` export (dùng chung điều kiện chiếm).
  - `transitions.ts`: Tạo lại đặt `plan = null` (brief mới). `calendar.ts`: `planTitle` / `planFormat`.
- **campaigns:** `runner.ts` `runSlotBatch({plan})` — kiểm `active()` rồi `planCampaignSlots` trước vòng viết; `preview.ts` / `generate.ts` truyền tên / mục tiêu / có ảnh sản phẩm.
- **Web:** `lib/campaigns.ts` `slotPlanView` (chip định dạng + dòng "tiêu đề · góc") ở thẻ bước 4 và hàng chờ duyệt; `lib/calendar.ts` `groupTitle` ưu tiên tiêu đề kế hoạch cho bài chưa viết, `groupFormatLabel`; `ContentCalendar.tsx` nhãn định dạng trên ô (kèm tooltip / aria) và chip trong ngăn.
- **Quyết định người dùng thấy:** "Tạo lại" = brief MỚI (ngữ cảnh các bài khác), không giữ brief cũ; bài Hỏi đáp viết ngắn; bài chưa viết trên Lịch hiện tiêu đề kế hoạch khi có.
- **Test:** `server/test/campaigns-plan.test.ts` (12, ma trận I/O qua app thật + OpenAI giả), `campaign-plan-prompt.test.ts` (8, prompt thuần), `helpers/plan.ts`; sửa test có sẵn theo lời gọi kế hoạch thêm (`campaigns-{generate,preview,start,lifecycle,product-image}`, `check-output` câu chống chèn lệnh); web `calendar.test.ts` / `campaigns.test.ts` (+2).
- **Kiểm:** `npm run check` thoát 0 — depcruise sạch (253 module), server 84 tệp / 1657 test, web 25 tệp / 366 test.
- **deferred-work:** thử thật OpenAI; sửa brief bằng tay; brief theo trang (nhiều trang cùng hồ sơ).

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Lời gọi kế hoạch bị model từ chối / lọc nội dung (200 `refusal` / `content_filter`): gateway đã ghi `ai_usage` rồi ném `AI_POLICY_BLOCKED` (kèm `usageId`, không `maybeBilled`) → `plan` để `null`; lô lỗi tạm ở caption / tạm dừng giữa lô → retry / lượt sau gọi kế hoạch lại, tính tiền lần nữa. Sửa: lỗi mang `usageId` coi như đã tính tiền → `failed` (`slot-plans.ts` `isBilled`) + test | thật, mức vừa | patch |
| `campaignPlanMaxOutputTokens` = 1.500 + 450 × số bài (trần 6.000) thấp hơn độ dài brief tối đa (~1.500 ký tự ≈ 800 token theo tỉ lệ `COMPOSE_MAX_OUTPUT_TOKENS`), chưa kể token suy luận → lô 7–9 bài một trang dễ bị cắt JSON → mọi slot `failed` (đã tính tiền). Sửa: 1.500 + 800 × số bài, trần 9.000 (chi phí theo token thật) | thật, mức vừa | patch |
| Lời gọi kế hoạch 9 bài (~5–7k token ra) có thể vượt `RESPONSE_TIMEOUT_MS` 120 giây với model chậm → `maybeBilled` → cả lô `failed` (mất tiền, không brief); thêm thời gian kế hoạch vào lô 900 giây của queue khi nhiều trang. Cần đo thật trước khi chia nhỏ lời gọi / nâng timeout riêng | rủi ro thật, chưa đo | defer |
| Đã soát: cron hằng giờ không lên lại slot có `plan` (kể cả `failed`, điều kiện `plan IS NULL`); lease kế hoạch ↔ `generateSlot` (cùng `toGenerate`, nhả ở `finally`, `savePlan` khớp lease); lỗi kế hoạch không chặn caption; refs ngoài lô / trùng bị bỏ; dữ liệu chủ shop / AI cũ trong «»; kho kiến thức ≤ 3.000 ký tự; Tạo lại có lịch sử 12 bài; log chỉ mã lỗi; web render chữ thường (JSX); tạm dừng / xoá giữa kế hoạch (`savePlan` đòi `planned`) | không lỗi mức vừa / cao | — |

## Design Notes

- **Lô, không cả chiến dịch:** brief theo nhịp viết (7 / lô 9) để chi phí chỉ phát sinh cho bài sắp viết, và mỗi lô thấy brief + caption thật của lô trước (lô sau đa dạng theo cái đã viết, không theo dự kiến).
- **Lease chung:** dùng lại `generate_lease_until` thay cột mới: trong lúc lên kế hoạch, slot không bị job khác viết caption thiếu brief; sau khi nhả, `generateSlot` chiếm lại như 7.4.
- **`failed` thay vì `null`:** lời gọi đã tính tiền thì không lặp lại dù slot chưa viết xong (retry / tạm dừng giữa lô).
- **Chi phí:** model chữ mặc định (`gpt-6-luna` $0,10/$0,50 mỗi 1M token): một lời gọi kế hoạch ~4k token vào + ~3k ra ≈ $0,002 mỗi trang mỗi lô (< $0,0005 / bài); caption thêm ~300 token vào.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: đúng một migration (`post_targets.plan`).
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- Với OpenAI thật: `/chien-dich/tao` một chủ đề → bước 4 có 7 bài khác định dạng / câu mở / bố cục ảnh.
