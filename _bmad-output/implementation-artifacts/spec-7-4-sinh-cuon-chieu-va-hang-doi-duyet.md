---
title: 'Story 7.4 — Sinh nội dung cuốn chiếu và hàng đợi Bài chờ duyệt'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '812033cc3b29543fa45c948f8b8a903862e5c4c3'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 7.4, AD-15, AD-13, AD-21, AD-7; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Chiến dịch đã `running` nhưng slot `planned` không bao giờ được viết (chưa có cron `campaigns.generate_window`); chế độ "Tự đăng" không tự lên lịch bài AI viết xong; hàng đợi "Bài chờ duyệt" ở `/chien-dich` và nút duyệt trên Lịch còn khoá "Sắp có". Slot kẹt "AI đang viết…" khi job mất thì kẹt mãi.

**Approach:**
- Cron hằng giờ enqueue job `campaigns.generate` (stately theo chiến dịch) cho mỗi chiến dịch `running`. Job sinh slot `planned` chưa viết có giờ đăng trong 3 ngày tới, theo lô, bằng đúng đường sinh của 7.2 (`content.generateSlot`). "Tự đăng" thì duyệt luôn bài viết xong không lỗi.
- Một endpoint hành động slot chung cho hàng đợi và Lịch: duyệt, sửa, tạo lại, từ chối. Hàng đợi đọc qua read-model theo Phạm vi.
- Cron cũng dọn slot kẹt: ô ảnh chờ quá hạn → `IMAGE_FAILED`, nháp còn bài chưa viết quá lâu → enqueue lại `campaigns.preview`.

## Boundaries & Constraints

**Always:**
- **Shared:**
  - `CAMPAIGN_GENERATE_WINDOW_MS = 3 ngày` [ASSUMPTION AD-15].
  - `CampaignSlotDto.scheduledAt` (ISO | null).
  - `CampaignSlotActionRequest` thêm `approve {version, scheduledAt?}` (thiếu = giờ hiện tại của bài), `reject {version}`, và `regenerate.immediate?`.
  - Route hành động trả `CampaignSlotActionResponse {slot}` (không còn trả cả danh sách xem trước).
  - `PendingSlotDto` = `CampaignSlotDto` + `campaignId`, `campaignName`, `campaignMode`.
  - `GET /campaigns/pending-slots?scope=` → `{items, truncated}`, tối đa `PENDING_SLOTS_MAX = 200`, xếp theo `scheduledAt` tăng dần.
- **Content:**
  - Cột `post_targets.generate_lease_until` (migration). `generateSlot` chiếm slot bằng `UPDATE … WHERE status='planned' AND caption='' AND (lease is null OR lease < now)`; không chiếm được → `skipped`, không gọi AI. Mọi lối ra trước khi ghi xong caption (lỗi tạm, huỷ, lỗi lạ) trả lease (khớp đúng giá trị đã đặt). `listSlotsToGenerate` bỏ qua slot đang có lease. `regenerate` xoá lease. Lease `SLOT_GENERATE_LEASE_MS = 10 phút`.
  - `listSlotsToGenerate(db, id, {until?, limit?})`: `until` lọc `scheduled_at <= until` (không có cận dưới — slot quá giờ chưa viết vẫn được viết rồi về "Chờ duyệt").
  - `generateSlot({autoApprove})` và job ảnh: bài viết xong không lỗi → duyệt ngay (`approve` tại `scheduled_at`) trong cùng transaction, bọc savepoint. 422 → giữ `pending_approval` kèm mã đó. Job ảnh nhận cờ qua payload `content.image.generate {mediaAssetId, autoApprove?}`. Ảnh lỗi / hậu kiểm chặn → không duyệt.
  - `autoApproveCampaignSlots(tx, deps, campaignId)`: duyệt mọi slot `pending_approval`, không mã, không `held`. Lấy trước khoá giới hạn/24h theo `pageId` tăng dần. `startCampaignSlots` dùng lại hàm này.
  - `transitionTarget`:
    - `reject`: `pending_approval → cancelled USER_REJECTED`, phát `post_target.cancelled`.
    - `approve` phát thêm `post_target.updated`.
  - `failStuckSlotImages(deps, now)`: ô `pending` gắn slot `planned`, tạo trước `now − IMAGE_PENDING_MS` → ô `failed IMAGE_FAILED` + slot `pending_approval IMAGE_FAILED` (cùng đường lỗi của job ảnh).
  - `staleSlotCampaigns(db, before)`: chiến dịch có slot `planned` chưa viết, không lease, `updated_at < before`.
  - `listPendingSlots(db, {campaignIds, pageIds, limit})`: slot `pending_approval` không `held`. `getCampaignSlot(db, id)`.
- **Campaigns:**
  - Queue `campaigns.generate {campaignId}`: stately `campaignId`, retry 2, concurrency 2, hạn 900 giây. Cron `campaigns.generate_window`: hằng giờ, standard, retry 1.
  - `runGenerate(deps, campaignId, {finalAttempt, signal, now})`:
    - Chỉ chiến dịch `running` (dưới `FOR SHARE`), không thì `skipped`.
    - "Tự đăng" → `autoApproveCampaignSlots` trước.
    - Lô `GENERATE_BATCH = 9` slot cần sinh trong cửa sổ, 3 slot song song.
    - Kiểm trước khoá OpenAI / hạn mức (`getUsableOpenAiKey`, `getBudgetSummary`). Bị chặn → `{stopped: code}`, không gọi AI, không đổi slot.
    - Mã dừng giữa lượt → slot đó đã có mã (`generateSlot`), các slot còn lại giữ `planned`, không enqueue tiếp.
    - Còn slot ngoài lô và không lỗi tạm → enqueue lượt tiếp.
  - `runGenerateWindow(deps, now)`: `failStuckSlotImages`, rồi enqueue `campaigns.generate` cho mọi chiến dịch `running`, enqueue `campaigns.preview` cho nháp có slot kẹt (`staleSlotCampaigns`, quá 15 phút).
  - "Bắt đầu" enqueue `campaigns.generate` cùng transaction. `runPreview` thấy chiến dịch đã `running` sau lượt → enqueue `campaigns.generate` (lượt đó duyệt bài xem trước vừa xong ở "Tự đăng").
  - `applySlotAction`:
    - Nháp: `edit | regenerate | cancel` (`approve` / `reject` → 409).
    - `running | paused`: `edit | regenerate | cancel | approve | reject`.
    - `done` → 409.
    - `regenerate`: nháp → enqueue `campaigns.preview`; đã chạy → enqueue `campaigns.generate` khi `immediate`, không thì chờ cron kế.
- **Read-model + route:** `app/read-models/campaign-queue.ts` ghép slot chờ duyệt (`content`) với tên / chế độ chiến dịch `running | paused` (`campaigns`). Phạm vi = trang của slot thuộc tập trang (`resolveScope`).
- **Web:**
  - `/chien-dich` "Bài chờ duyệt" thật:
    - Thẻ: trang, chiến dịch, giờ, chủ đề, caption, ảnh, ghi chú mã.
    - Bài quá giờ → chip "Quá giờ — chọn giờ mới" + ô ngày giờ.
    - Nút: Duyệt, Sửa, Tạo lại (`immediate`, khoá theo `AiLockHint`), Từ chối.
    - "Duyệt tất cả" = bài không mã, chưa quá giờ, tuần tự, lỗi giữa chừng → "Đã xong k/n bài".
    - `SCHEDULE_IN_PAST` → mở ô giờ mới.
  - Lịch: ngăn bài `pending_approval` chiến dịch có "Duyệt" (cùng endpoint; quá giờ → ô giờ mới) + "Sửa ở Chiến dịch". Ô quá giờ ghi "Quá giờ".
  - Wizard bước 4 dùng response `{slot}` (vá cache). SSE `post_target.*` đã làm cũ `['campaigns', …]`.

**Never:**
- Không sinh slot ngoài cửa sổ 3 ngày (trừ bài xem trước). Không sinh trùng một slot: lease + `WHERE status='planned'`. Không gọi AI khi khoá / hạn mức đã chặn.
- Không đăng bài chưa duyệt ở "Duyệt trước". Không tự duyệt bài có mã lỗi. Không tự huỷ bài chờ duyệt quá giờ.
- Không tạm dừng / tiếp tục / xoá / tự dừng / `done` (7.5, 7.6). Không sửa ảnh của bài chờ duyệt (vẫn hoãn).
- `content` không import `campaigns`. Không gọi OpenAI thật ở test, không log caption / prompt.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cron cửa sổ | `running` "Duyệt trước", FB 1/ngày 30 ngày, slot day 0..29 `planned` | `generate_window` enqueue 1 `campaigns.generate`; job sinh đúng slot `scheduled_at ≤ now+3 ngày` (`campaign_generate`, `ref` = target) → `pending_approval`; slot ngoài cửa sổ giữ `planned`; nháp / chiến dịch khác trạng thái bỏ qua | |
| Idempotent | chạy job 2 lần; slot đang có lease | lần 2 không gọi AI, không `ai_usage` mới | lease còn → `skipped` |
| Lô | > 9 slot trong cửa sổ | lượt 1 sinh 9, enqueue lượt tiếp; lượt cuối không enqueue | |
| Tự đăng | `mode auto`, slot không ảnh / có ảnh / slot giờ còn < 2 phút | không ảnh → `scheduled` + job `publish.target`; có ảnh → `planned` tới khi job ảnh `ready` rồi `scheduled`; giờ sát → `pending_approval SCHEDULE_IN_PAST` | 422 không làm hỏng lượt |
| Lỗi AI / ảnh / hậu kiểm | hậu kiểm chặn 2 lần; ảnh bị từ chối; "Tự đăng" | `pending_approval` kèm `AI_POLICY_BLOCKED` / `IMAGE_REJECTED`, không `scheduled`, slot không bị xoá | |
| Hạn mức / khoá | hạn mức đã hết hoặc khoá chưa nhập trước lượt; hạn mức hết giữa lượt | `{stopped}`, 0 lời gọi, slot giữ `planned`; giữa lượt: slot đó `AI_BUDGET_EXCEEDED`, còn lại `planned`, không enqueue tiếp | |
| Ảnh kẹt | ô `pending` gắn slot `planned` tạo 16 phút trước | cron → ô `failed IMAGE_FAILED`, slot `pending_approval IMAGE_FAILED`; job ảnh tới muộn → `skipped` | |
| Nháp kẹt | nháp có slot `planned` chưa viết `updated_at` 20 phút trước / 1 phút trước | enqueue `campaigns.preview` / không | |
| Bắt đầu "Tự đăng" | bài xem trước còn viết dở lúc bắt đầu | lượt preview xong → enqueue `campaigns.generate` → bài đó `scheduled` | |
| Duyệt | `approve` + version, giờ còn xa | `scheduled`, job `publish.target startAfter`, `post_target.updated` | version lệch 409 |
| Duyệt quá giờ | giờ đã qua / còn < 2 phút; rồi gửi `scheduledAt` mới | 422 `SCHEDULE_IN_PAST`, không đổi; lần sau `scheduled` giờ mới | |
| Từ chối | `reject` + version | `cancelled USER_REJECTED`, `post_target.cancelled` | sai trạng thái 409 |
| Tạo lại | `regenerate` (`immediate` / không) trên chiến dịch chạy | `planned`, caption rỗng, bỏ ảnh; enqueue `campaigns.generate` / không | |
| Route | nháp `approve`; slot của chiến dịch khác; chiến dịch lạ; 401 | 409 / 404 / 404 / 401 | |
| Hàng đợi | 2 chiến dịch, 2 trang; `scope=page:A`; bài `held` (nháp) | đúng slot chờ duyệt trong phạm vi, có `campaignName`, theo giờ; bỏ bài xem trước nháp | `scope` sai 400 / lạ 404 |
| Web | hàng đợi (ok, lỗi, quá giờ); duyệt tất cả lỗi giữa chừng; ngăn Lịch chờ duyệt | Duyệt / Sửa / Tạo lại / Từ chối; "Quá giờ — chọn giờ mới"; "Đã xong 1/3 bài — …"; nút Duyệt trên Lịch | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/{campaigns,content}.ts` -- cửa sổ, DTO slot / hàng đợi, hành động mới, response hành động.
- `server/src/modules/content/{schema,slots,slots-start,images,transitions,index}.ts` + migration -- lease, sinh có duyệt luôn, duyệt hàng loạt, `reject`, ảnh kẹt, đọc hàng đợi.
- `server/src/modules/campaigns/{generate,preview,start,index}.ts` -- job + cron sinh cuốn chiếu, hành động slot theo trạng thái, enqueue khi bắt đầu.
- `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts` -- 2 queue mới, payload ảnh, handler.
- `server/src/app/{campaigns.ts,read-models/campaign-queue.ts}` -- route hàng đợi, response hành động.
- `server/test/campaigns-generate.test.ts` (MỚI) -- ma trận server; chỉnh `campaigns-preview` / `queues` theo hợp đồng mới.
- `web/src/lib/{campaigns,calendar}.ts` + test; `web/src/screens/{Campaigns,ContentCalendar,CampaignWizard}.tsx` -- hàng đợi, duyệt trên Lịch, vá cache.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/*` -- hợp đồng mới -- AD-15, AD-18.
- [x] `server/src/modules/content/*` + migration -- lease, duyệt luôn, `reject`, ảnh kẹt, hàng đợi -- AD-13, AD-15, AD-21.
- [x] `server/src/modules/campaigns/*` -- `runGenerate`, `runGenerateWindow`, hành động slot, enqueue -- AD-15, AD-7, AD-1.
- [x] `server/src/platform/jobs/queues.ts`, `worker/main.ts`, `app/*` -- queue / cron / route -- AD-24, AD-18.
- [x] `server/test/campaigns-generate.test.ts` -- phủ các dòng server của ma trận.
- [x] `web/src/lib/*` + test, `screens/*` -- hàng đợi, Lịch, wizard.
- [x] `deferred-work.md` -- đóng / cập nhật mục 7.4, thêm mục mới.

**Acceptance Criteria:**
- Given chiến dịch "Duyệt trước" đang chạy và worker, when tới lượt cron, then bài 3 ngày tới hiện trong "Bài chờ duyệt" và duyệt được ở cả hàng đợi lẫn Lịch.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared** (`campaigns.ts`): `CAMPAIGN_GENERATE_WINDOW_MS`, `CampaignSlotDto.scheduledAt`, hành động `approve` / `reject` / `regenerate.immediate`, `CampaignSlotActionResponse`, `PendingSlotDto` / `PendingSlotsQuery` / `PendingSlotsResponse`, `PENDING_SLOTS_MAX`.
- **Content:**
  - Migration `0034_broad_sphinx.sql`: `post_targets.generate_lease_until`.
  - `slots.ts`: lease (`claimSlot`, trả trong `finally` khớp đúng giá trị), `autoApprove`, `listSlotsToGenerate({until, limit})`, `readSlots` dùng chung → `getCampaignSlot` / `listPendingSlots`, `staleSlotCampaigns`, `settleSlotImage(…, {autoApprove})`.
  - `slots-approve.ts` (mới): `autoApproveSlot` / `autoApproveCampaignSlots` (dòng → advisory). `slots-start.ts` dùng lại.
  - `images.ts`: payload `autoApprove`, `jobs` tuỳ chọn, `failStuckSlotImages`.
  - `transitions.ts`: `reject`; `approve` phát `post_target.updated`; `regenerate` xoá lease.
- **Campaigns:**
  - `runner.ts` (mới): vòng sinh chung `runSlotBatch` (`mark` / `halt`).
  - `generate.ts` (mới): `runGenerate`, `handleGenerateJob`, `runGenerateWindow`, `GENERATE_BATCH = 9`, `PREVIEW_STALE_MS = 15 phút`.
  - `preview.ts`: dùng `runSlotBatch`; `applySlotAction` theo trạng thái chiến dịch, trả slot. `start.ts`: enqueue `campaigns.generate`.
- **Nền / app:**
  - Queue `campaigns.generate` (stately) + cron `campaigns.generate_window` (`0 * * * *`); handler ở worker; job ảnh nhận `jobs`.
  - `read-models/campaign-queue.ts` + `GET /campaigns/pending-slots`; route hành động trả `{slot}`.
- **Web:**
  - `lib/campaigns.ts`: `useSlotAction(campaignId?)` (vá cache bằng `patchPreview`, làm cũ hàng đợi / danh sách / Lịch), `usePendingSlots`, `isOverdue`, `approveBlock`, `pendingNote`, `bulkApprovable`, `approveInput`, `approveBody`, `needsNewTime`, `approvedToast`.
  - `lib/calendar.ts`: `canApproveGroup`, `isGroupOverdue`, `approveCalls`, plan `awaiting`.
  - `Campaigns.tsx`: `PendingQueue` thật (thay thẻ "Sắp có"). `ContentCalendar.tsx`: "Duyệt" / "Sửa ở Chiến dịch" trong ngăn, "Quá giờ" trên ô.
  - "Duyệt" bị khoá khi bài chưa có nội dung hoặc hậu kiểm chặn (phải sửa trước).
- **Test:**
  - Server: `campaigns-generate.test.ts` (18 test, mới). `campaigns-preview.test.ts` theo response `{slot}` (+ nháp `approve` 409, `done` 409). `notifications.test.ts` thêm handler queue mới.
  - Web: `campaigns.test.ts` (+4), `calendar.test.ts` (+2, sửa 1).
- **Kiểm tra:** `npm run check` thoát 0.
  - depcruise sạch (202 module).
  - Server 67 file / 1379 test; web 22 file / 324 test.
  - Chưa thử bằng trình duyệt.
- **Việc hoãn:**
  - Đóng: slot kẹt, đích "Tự đăng" của job ảnh, "Tự đăng" với bài đang viết lúc bắt đầu + duyệt trên Lịch.
  - Cập nhật: lịch tab khác, sửa ảnh (vẫn hoãn).
  - Thêm: kiểm trình duyệt 7.4, dừng im lặng khi thiếu khoá, "Tạo lại" ngoài cửa sổ, ảnh bài xem trước lúc bắt đầu ở "Tự đăng", giới hạn 200 + duyệt tất cả tuần tự.
  - Kéo ô gom nhiều bài đã đóng ở 7.3 (báo n/m). Duyệt nhiều bài trên Lịch / "Duyệt tất cả" dùng cùng cách báo.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Duyệt bài `AI_POLICY_BLOCKED` không bị chặn ở server và ngăn Lịch (chỉ hàng đợi khoá nút) → nội dung vi phạm "Điều cần tránh" lên lịch đăng thẳng. Sửa: `applySlotAction` trả 422 `AI_POLICY_BLOCKED` cho `approve` khi slot còn mã hậu kiểm; ngăn Lịch khoá "Duyệt" (+ test route). | real, medium | patch |
| `GET /campaigns/pending-slots` không có `scope` / `scope=all` không lọc trang → bài của trang đã gỡ (`PAGE_REMOVED`, không duyệt được) vẫn vào hàng đợi và số đếm. Sửa: luôn `resolveScope(scope ?? all)` như Lịch (+ test trang gỡ). | real, medium | patch |
| Bài xem trước còn chờ ảnh lúc "Bắt đầu" ở "Tự đăng" chỉ được duyệt ở lượt cron kế (≤ 1 giờ), có thể về "Chờ duyệt" quá giờ. | real, low–medium | defer (đã có trong `deferred-work.md`) |

## Design Notes

- **Lease thay vì cờ:** job preview (nháp) và job generate (đã chạy) có thể cùng thấy một slot chưa viết lúc "Bắt đầu", lượt retry của pg-boss cũng có thể chồng lượt cũ. Lease chiếm slot trước khi gọi AI nên không tính tiền hai lần. Lease tự hết hạn nên slot của job chết được lượt cron sau viết lại.
- **Hết hạn mức / thiếu khoá: dừng, không đánh dấu.** Kiểm trước, rồi để slot ở `planned` để tự viết khi được gỡ chặn. Banner hạn mức / khoá toàn app đã báo lý do; 7.6 tự tạm dừng chiến dịch. Chỉ slot thật sự gặp lỗi khi gọi mới về "Chờ duyệt" kèm mã (AC "AI lỗi").
- **Bài chờ duyệt quá giờ:** giữ nguyên, không tự huỷ (review kiến trúc). Duyệt bắt chọn giờ mới (`SCHEDULE_IN_PAST`).
- **Tự đăng không qua sự kiện:** chế độ đi cùng lời gọi (`autoApprove` của `generateSlot` / payload job ảnh). Lượt `campaigns.generate` quét bài chờ duyệt không mã để vá các đường còn lại (bài xem trước viết dở lúc bắt đầu). `content` không đọc `campaigns`.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: đúng một migration mới (`post_targets.generate_lease_until`).
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- Chiến dịch đang chạy + worker: sau lượt cron, `/chien-dich` có "Bài chờ duyệt"; Duyệt → Lịch hiện bài xanh "Đã lên lịch".
