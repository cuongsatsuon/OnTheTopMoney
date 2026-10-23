---
title: 'Story 7.2 — Xem trước 7 bài đầu'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'e1df195cbc0aab780c40859c39c72f9dd30dfaee'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 7.2, AD-15, AD-13, AD-21, AD-24; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Bước 4 của wizard đang khoá "Sắp có". Chưa có slot chiến dịch: `post_targets` thiếu `campaign_id` / `slot_at` / `held`, `createPost` chỉ nhận bài tay, chưa có job `campaigns.preview`, chưa có hành động sửa / tạo lại cho bài chờ duyệt. Chủ shop chưa xem được AI viết thế nào trước khi chiến dịch chạy.

**Approach:**
- Lưu nháp (bước 3 → 4) dựng 7 slot đầu theo luật slot chung (shared `campaignSlots`) qua `content.createPost({source: campaign})` ở `planned` + `held`, rồi enqueue `campaigns.preview` cùng transaction.
- Job viết caption từng slot bằng chính đường Soạn bài (`composeCaptionForPage` + `checkOutput`, `feature=campaign_generate`). Slot cần ảnh thì đi qua job ảnh có sẵn `content.image.generate`. Xong thì slot sang `pending_approval`.
- Bước 4 hiện 7 bài với Sửa / Xoá / Tạo lại (qua `content.transitionTarget` + `version`), cập nhật qua SSE.
- Slot xem trước chính là slot thật của chiến dịch: 7.3 giữ nguyên và chỉ bỏ `held`, không sinh lại.

## Boundaries & Constraints

**Always:**
- **Shared:**
  - `CAMPAIGN_PREVIEW_COUNT = 7`.
  - `campaignSlots(plan, limit)` là hàm thuần, dùng chung cho 7.2 / 7.3 / 7.4:
    - Ngày 0…N−1, mỗi trang `campaignPostsOnDay` bài. Chọn khung giờ chỉ số `⌊i·T/n⌋`. `slotAt` = ngày + giờ VN đổi ra UTC.
    - Sắp theo `slotAt`, rồi theo thứ tự trang.
    - Chủ đề: chia vòng có trọng số (smooth weighted round-robin) theo tỉ lệ, trên thứ tự chung.
    - Ảnh: IG luôn có; trang khác lấy bài thứ k (đếm theo trang) khi `⌈(k+1)·r/100⌉ > ⌈k·r/100⌉`.
  - `CampaignSlotDto {id, postId, pageId, slotAt, topic, status, caption, aiCaption, media, imagePending, version, errorCode}` và `CampaignPreviewResponse {items, generating}`. `generating` = còn slot `planned`.
  - `CampaignSlotActionRequest` (strict, phân theo `action`): `edit {version, caption 1–POST_CAPTION_MAX đã trim}` | `regenerate {version}` | `cancel {version}`.
  - `SaveCampaignRequest.baseUpdatedAt?` (ISO): PUT có gửi mà khác `updatedAt` hiện tại → 409 `VERSION_CONFLICT` (đóng việc hoãn "hai tab").
  - Sự kiện mới `post_target.updated {pageId, campaignId}` (realtime).
- **Content (sở hữu cột slot):**
  - `post_targets` thêm `campaign_id` (uuid, không FK — `content` không biết bảng `campaigns`), `slot_at`, `held` (mặc định false). Thêm khoá duy nhất `(campaign_id, page_id, slot_at)` và check `(campaign_id is null) = (slot_at is null)`.
  - Check `error_code` nới ra: bắt buộc khi `failed`, được phép thêm ở `pending_approval`.
  - `createPost({source:'campaign', campaignId, topic, pageId, slotAt, held, scheduledAt})` → 1 post : 1 target `planned`, caption rỗng. Slot xem trước có `scheduledAt = null` (không lên Lịch; 7.3 đặt).
  - `ensureCampaignSlots` (idempotent theo khoá), `pruneCampaignSlots` (xoá cứng slot không còn trong kế hoạch, khoá so khớp `page + slotAt + topic`), `listCampaignSlots`, `listSlotsToGenerate` (`planned`, caption rỗng, chưa gắn ảnh).
  - `generateSlot(targetId, {goal, withImage, finalAttempt, signal})`:
    - Không có hồ sơ → `pending_approval CONFIG_MISSING`.
    - Caption bằng `composeCaptionForPage` (tách từ `compose.ts`, `feature=campaign_generate`, `ref=targetId`). Vi phạm thì sinh lại 1 lần; vẫn vi phạm → giữ caption + `AI_POLICY_BLOCKED`, bỏ ảnh.
    - Cần ảnh: một transaction ghi caption, ghi ô `media_assets pending` (prompt = `buildImagePrompt(caption)`), gắn vào target và enqueue `content.image.generate`; slot giữ `planned`. Không cần ảnh → `pending_approval`.
    - Lỗi tạm (`RATE_LIMITED`, 5xx) chưa phải lần cuối → ném để retry. Lỗi khác / lần cuối → `pending_approval` + mã.
    - Mọi lần ghi là `UPDATE … WHERE status='planned'` (slot đã bị xoá / huỷ → bỏ qua).
  - Job ảnh: ô gắn với slot → gateway `feature=campaign_generate`, `pageId` của slot. `ready` / `failed` → slot `planned` sang `pending_approval` (lỗi: `IMAGE_*`, gỡ dòng gắn) cùng transaction, phát `post_target.updated`.
  - `transitionTarget` thêm hành động nội bộ:
    - `edit {caption}`: `pending_approval → pending_approval`, xoá `error_code`, giữ nhãn AI.
    - `regenerate`: `pending_approval → planned`, xoá caption / mã / ảnh gắn.
    - Cả hai khoá `version` và phát `post_target.updated`. `cancel` dùng lại `USER_DELETED`.
  - `held = true` → job `publish.target` bỏ qua im lặng, cron `content.requeue` bỏ qua.
  - Sự kiện `post_target.*` và `GET /calendar` mang `campaignId` thật.
- **Campaigns:**
  - Lưu nháp (`POST` / `PUT`) trong cùng transaction: kế hoạch 7 slot (trang chưa gỡ, theo thứ tự lưu) → prune → ensure → enqueue `campaigns.preview`.
  - Job `campaigns.preview {campaignId}` (stately `campaignId`, retry 2, concurrency 2, hạn 900 giây):
    - Chiến dịch không phải `draft` → bỏ qua. Ensure lại slot, rồi sinh từng slot cần sinh, tối đa 3 slot song song.
    - Mục tiêu ánh xạ sang `ComposeGoal`: `engage` / `follow` → `engagement`, `sell` → `sales`, `launch` → `announce`. Độ dài `medium`.
    - Mã dừng (khoá OpenAI / hạn mức / mã hoá) → các slot chưa bắt đầu nhận cùng mã, không gọi AI.
    - Có lỗi tạm mà chưa phải lần cuối → ném sau khi các slot khác đã xong.
  - `GET /campaigns/:id/preview` → `CampaignPreviewResponse` (404 khi không có).
  - `POST /campaigns/:id/slots/:targetId/transition`:
    - Chiến dịch không có → 404. Không `draft` → 409. Slot không thuộc chiến dịch → 404.
    - `version` lệch / sai trạng thái → 409 (`transitionTarget`).
    - `regenerate` enqueue `campaigns.preview` cùng transaction. Trả `CampaignPreviewResponse`.
- **Web:**
  - Bước 4 hiện thẻ cho các slot chưa huỷ: trang, giờ VN, chủ đề, "AI tạo", caption, ảnh.
  - Slot đang viết → khung chờ "AI đang viết…" / "Đang tạo ảnh…". Slot có mã lỗi → ghi chú theo mã.
  - Sửa (ô chữ + Lưu / Huỷ), Xoá, Tạo lại. Tạo lại khoá theo khoá OpenAI / hạn mức (`AiLockHint`). Đếm "Đã bỏ n bài".
  - Còn slot `planned` thì hỏi lại 5 giây. SSE `post_target.*` làm cũ `['campaigns', …]`.
  - 409 khi lưu nháp → "Nháp đã đổi ở tab khác — tải lại trang". "Bắt đầu chiến dịch" vẫn khoá "Sắp có" (7.3).

**Never:**
- Không "Bắt đầu" / bỏ `held` / duyệt (`pending_approval → scheduled`), không cron `campaigns.generate_window` (7.3 / 7.4).
- Không viết mẫu prompt / gateway mới, không nhân bản `checkOutput`. Không gọi OpenAI thật ở test, không log prompt / caption.
- `content` không import `campaigns`. Không sửa ảnh của slot ở bước 4 (chỉ caption). Không ước tính chi phí AI (vẫn hoãn).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Kế hoạch slot | 2 trang (FB `1_per_day`, IG `3_per_week`), giờ 11:30 + 19:30, chủ đề 40/30/20/10, ảnh 70% | 7 slot đầu đúng ngày/giờ UTC, sắp theo giờ rồi trang; chủ đề theo vòng có trọng số; IG luôn ảnh; FB ảnh theo ⌈⌉ (bài 0,1,2 có, bài 3 không) | |
| Lưu nháp | `POST` chiến dịch hợp lệ | 201; đúng 7 slot `planned` + `held`, `source=campaign`, `campaign_id`, `slot_at`, `scheduled_at` null; 1 job `campaigns.preview` | |
| Job chạy | khoá ok, hồ sơ có, 1 slot cần ảnh | caption qua `campaign_generate` (`page_id`, `ref`=targetId); slot không ảnh → `pending_approval held`; slot ảnh: ô `pending` gắn + job ảnh; job ảnh xong → `pending_approval` có ảnh; phát `post_target.updated` | |
| Idempotent | job chạy lại / lưu lại không đổi cấu hình | không slot mới, không gọi AI thêm | |
| Đổi cấu hình | `PUT` đổi giờ đăng | slot không còn khớp bị xoá, slot mới `planned`; slot còn khớp (kể cả đã xoá `cancelled`) giữ nguyên | |
| Hậu kiểm | từ cấm cả hai lần | `pending_approval AI_POLICY_BLOCKED`, giữ caption, không sinh ảnh, 2 lời gọi | |
| Thiếu hồ sơ / khoá / hạn mức | trang mất hồ sơ sau khi lưu; khoá chưa nhập; hạn mức hết | `CONFIG_MISSING` / `OPENAI_KEY_MISSING` / `AI_BUDGET_EXCEEDED` ở `pending_approval`; mã dừng không gọi AI cho slot sau | |
| Lỗi tạm | OpenAI 5xx lần đầu / lần cuối | ném để retry, slot vẫn `planned` / `pending_approval AI_PROVIDER_ERROR` | |
| Ảnh lỗi | OpenAI từ chối ảnh | slot `pending_approval IMAGE_REJECTED`, không gắn ảnh | |
| Không đăng được | slot `held` có job `publish.target` | job bỏ qua; requeue bỏ qua | |
| Sửa | `edit` caption mới + version đúng | caption mới, `error_code` null, `version+1`, vẫn `pending_approval` | version lệch 409; caption rỗng 400 |
| Xoá | `cancel` + version | `cancelled USER_DELETED`, `post_target.cancelled` có `campaignId` | |
| Tạo lại | `regenerate` + version | `planned`, caption rỗng, bỏ ảnh gắn, 1 job `campaigns.preview`; job sinh lại đúng slot đó | sai trạng thái 409 |
| Route sai | chiến dịch lạ; slot của chiến dịch khác; chiến dịch không `draft` | 404 / 404 / 409 | |
| Hai tab | `PUT` với `baseUpdatedAt` cũ | 409 `VERSION_CONFLICT`, không đổi gì | |
| Chưa đăng nhập | | 401 | |
| Web | danh sách slot (planned, ok, lỗi, cancelled); khoá AI | thẻ chờ / caption / ghi chú lỗi theo mã; "Đã bỏ 1 bài"; Tạo lại khoá; `generating` → hỏi lại | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/{campaigns,events}.ts` -- luật slot, DTO xem trước, hành động slot, `baseUpdatedAt`, sự kiện `post_target.updated`.
- `server/src/modules/content/schema.ts` + `server/drizzle/0032_sweet_steve_rogers.sql` -- cột slot, khoá duy nhất, check `error_code`.
- `server/src/modules/content/{posts,slots,compose,images,transitions,publish,requeue,calendar,index}.ts` -- một cửa tạo slot, sinh slot, hành động mới, kiểm `held`, `campaignId`.
- `server/src/modules/campaigns/{preview,drafts,index}.ts` -- kế hoạch, đồng bộ slot khi lưu, job, hành động slot.
- `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts`, `server/src/app/{campaigns,app}.ts`, `server/test/notifications.test.ts` -- queue, handler, route.
- `server/test/campaigns-preview.test.ts` (MỚI), `packages/shared` test qua server -- ma trận server.
- `web/src/lib/{campaigns,realtime}.ts` + `campaigns.test.ts`, `web/src/screens/CampaignWizard.tsx` -- hook, helper, bước 4.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/*` -- luật slot + hợp đồng -- AD-15, AD-18.
- [x] `server/src/modules/content/*` + migration -- cột slot, `createPost` campaign, sinh slot, hành động, `held` -- AD-13, AD-21, AD-14.
- [x] `server/src/modules/campaigns/*` -- đồng bộ slot khi lưu, job `campaigns.preview`, hành động slot -- AD-15, AD-1.
- [x] `server/src/platform/jobs/queues.ts`, `worker/main.ts`, `app/*` -- queue stately, handler, route -- AD-24.
- [x] `server/test/campaigns-preview.test.ts` -- phủ các dòng server của ma trận.
- [x] `web/src/lib/campaigns.ts` + test, `realtime.ts`, `CampaignWizard.tsx` -- bước 4 thật.
- [x] `deferred-work.md` -- đóng mục "hai tab"; cập nhật mục chi phí AI; thêm mục mới.

**Acceptance Criteria:**
- Given chiến dịch nháp sang bước 4, when worker chạy, then 7 thẻ lần lượt chuyển từ "AI đang viết…" sang bài có caption (và ảnh khi luật slot yêu cầu) mà không tải lại trang.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:**
  - `campaigns.ts`: `CAMPAIGN_PREVIEW_COUNT`, `campaignSlots` + `campaignSlotHasImage` (luật slot chung), `CampaignSlotDto`, `CampaignPreviewResponse`, `CampaignSlotActionRequest`, `SaveCampaignRequest.baseUpdatedAt`.
  - `events.ts`: `post_target.updated`.
- **Content:**
  - Migration `0032_sweet_steve_rogers.sql`: `campaign_id` / `slot_at` / `held`, khoá `post_targets_slot_unique`, check slot, check `error_code` nới cho `pending_approval`.
  - `posts.ts`: `createPost` nhận biến thể `campaign` (1 target `planned`).
  - `compose.ts`: tách `composeCaptionForPage` (nhận `feature` / `ref`), export `AI_STOP_CODES` — Soạn bài không đổi hành vi.
  - `slots.ts` (mới): `ensureCampaignSlots`, `pruneCampaignSlots`, `listCampaignSlots`, `listSlotsToGenerate`, `generateSlot`, `failSlot`, `settleSlotImage`, `slotOfAsset`, `slotCampaignOf`.
  - `images.ts`: ô gắn slot → `campaign_generate` + `pageId`; `ready` / `failed` đẩy slot sang `pending_approval`.
  - `transitions.ts`: `edit` / `regenerate` (khoá `version`, phát `post_target.updated`); `cancel` mang `campaignId`.
  - `publish.ts` / `requeue.ts`: bỏ qua `held`. `publish.ts` / `requeue.ts` / `calendar.ts`: `campaignId` thật.
- **Campaigns:**
  - `preview.ts` (mới): `previewPlan`, `syncPreviewSlots` (prune + ensure + enqueue khi lưu), `runPreview` / `handlePreviewJob`, `getPreview`, `applySlotAction`.
  - Job đọc cấu hình + ensure dưới khoá `FOR SHARE` của dòng chiến dịch, để lượt cũ không dựng lại slot vừa bị lưu nháp dọn.
  - `drafts.ts`: `baseUpdatedAt` lệch → 409.
- **Nền / route:**
  - Queue `campaigns.preview` (stately `campaignId`, retry 2, concurrency 2, hạn 900 giây), handler ở worker.
  - Route `GET /campaigns/:id/preview` và `POST /campaigns/:id/slots/:targetId/transition`. POST / PUT nháp gọi `syncPreviewSlots` cùng transaction.
- **Web:**
  - `lib/campaigns.ts`: `previewView`, `slotPhase`, `slotWhen`, `slotNote`, `slotCanEdit` / `slotCanCancel`, `useCampaignPreview` (hỏi lại 5 giây khi `generating`), `useSlotAction`; `buildCampaignBody(…, baseUpdatedAt)`.
  - `realtime.ts`: `post_target` làm cũ `['campaigns', …]`.
  - `CampaignWizard.tsx`: bước 4 `PreviewList` (thẻ đang viết / đang tạo ảnh / bài, Sửa / Lưu, Tạo lại có `AiLockHint`, Xoá, "Đã bỏ n bài"). `baseUpdatedAt` giữ trong state lúc nạp form (lần tải lại khi focus không làm mất bảo vệ). 409 → "Nháp đã đổi ở tab khác".
- **Kiểm tra:** `npm run check` thoát 0.
  - depcruise sạch (194 module).
  - Server 65 file / 1349 test (`campaigns-preview.test.ts` 18 mới; `campaigns.test.ts`, `notifications.test.ts` chỉnh theo slot / queue mới).
  - Web 22 file / 310 test (+3).
  - Chưa thử bằng trình duyệt (ghi ở deferred-work).
- **Việc hoãn:**
  - Đóng mục "hai tab"; cập nhật mục chi phí AI (giờ đo được qua `ai_usage.ref`).
  - Thêm: kiểm bằng trình duyệt, slot kẹt `planned` khi job mất, đích "Tự đăng" của job ảnh (7.4), sửa ảnh ở bước 4.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|---|---|---|
| Trang bị gỡ sau khi lưu nháp: `generateSlot` trả `skipped` → slot kẹt `planned`, `generating` luôn true, bước 4 hiện "AI đang viết…" và hỏi lại 5 giây mãi. Sửa: chốt `pending_approval PAGE_REMOVED` (`content/slots.ts`) + test. | real, medium | patch |
| Job đọc `listSlotsToGenerate` sau khi nhả khoá `FOR SHARE`: lưu nháp chen vào đúng khe đó thì slot mới sinh theo kế hoạch cũ (`withImage` rơi về `false`, kể cả trang Instagram). Cửa sổ rất hẹp. | real, low | defer |

## Design Notes

- **Slot xem trước = slot thật:** khoá `(campaign_id, page_id, slot_at)` + `campaignSlots` xác định nên 7.3 tạo phần còn lại idempotent và không nhân đôi 7 bài đầu, không tốn tiền sinh lại.
- **Tạo slot ngay lúc lưu và cả trong job:** lưu nháp tạo slot để bước 4 hiện ngay 7 thẻ chờ; job ensure lại để đúng AC và tự lành khi chạy lại.
- **Ảnh qua job có sẵn:** ô ảnh gắn vào target từ lúc `pending`. Job ảnh tự biết đó là slot (dòng gắn) để tính `campaign_generate` và đẩy slot sang `pending_approval`. Đây cũng là đường 7.4 dùng; chế độ "Tự đăng" của 7.4 sẽ cần đích khác `pending_approval`.
- **Không FK `campaign_id`:** FK buộc `content` import bảng của `campaigns` (trái AD-1). Xoá chiến dịch (7.5) huỷ slot qua `content`.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: đúng một migration mới cho `post_targets`.
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `/chien-dich/tao` với khoá OpenAI + worker: sang bước 4 → 7 thẻ chờ rồi thành bài; Sửa / Xoá / Tạo lại cập nhật thẻ.
