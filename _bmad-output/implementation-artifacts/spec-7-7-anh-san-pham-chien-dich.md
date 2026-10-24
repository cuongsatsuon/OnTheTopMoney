---
title: 'Story 7.7 — Ảnh sản phẩm (ảnh tham khảo) cho chiến dịch'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '460aab09cf868ce74392f5bcbc686787eb284b71'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
---

<frozen-after-approval reason="Yêu cầu mới của chủ dự án (ngoài epics.md, coi như Story 7.7); dựa trên 6.6 / 6.8 / 7.1–7.6 / 9.2 / 9.3; hướng TNUT Media (`genOne`: `sourceImageUrl = productImageUrl || moodImageUrl`); chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Ảnh slot chiến dịch chỉ vẽ từ chữ (6.8). Thử thật `gpt-image-2.5-sunburst`: không có ảnh tham khảo thì ảnh chỉ "gần giống" sản phẩm (sai màu đế, sai switch); có ảnh tham khảo qua Images API edits thì giữ đúng sản phẩm.

**Approach:** Wizard bước 3 có ô "Ảnh sản phẩm" (tuỳ chọn, 1 ảnh tải lên). Nháp lưu `campaigns.product_image_id` (FK tới `media_assets`). Mọi slot có ảnh (xem trước 7.2, cuốn chiếu 7.4, tạo lại) của chiến dịch có ảnh sản phẩm đặt `reference_asset_id` cho ô ảnh và dựng prompt `buildReferenceImagePrompt({mode:'ad', topic, caption, …})`. Job ảnh có sẵn (6.6) tự đi đường edits. Không có ảnh sản phẩm → hành vi 6.8 giữ nguyên.

## Boundaries & Constraints

**Always:**
- **Hợp đồng (shared):**
  - `SaveCampaignRequest.productImageId`: uuid | null, thiếu = `null` (không ảnh). PUT thay toàn bộ cấu hình như các ô khác.
  - `CampaignDto.productImage`: `MediaAssetDto | null` (wizard xem trước, bước 4 hiện ảnh đang dùng).
- **Lưu nháp (campaigns):**
  - Cột `campaigns.product_image_id` (FK `media_assets.id`, KHÔNG cascade, có index). Migration bằng `drizzle-kit generate`.
  - Kiểm trong transaction lưu, khoá dòng ảnh `FOR KEY SHARE`: ảnh phải tồn tại, `ready`, `source = 'upload'`. Sai → 400 `VALIDATION_FAILED` path `productImageId` (FE về bước 3, báo dưới ô). `content` cung cấp hàm kiểm + đọc DTO (`campaigns` không đọc bảng của `content`).
  - Đổi ảnh ở nháp: bài xem trước đã có ảnh mà ảnh đó không sinh từ ảnh sản phẩm hiện tại (gồm thêm / đổi / bỏ ảnh) → giữ caption (kể cả caption chủ shop đã sửa), gỡ ảnh cũ, slot về `planned` + ô ảnh mới `pending` + job ảnh (cùng transaction lưu). Ô cũ còn `pending` → `failed` để job cũ không gọi OpenAI. Job `campaigns.preview` chạy cùng bước này dưới khoá `FOR SHARE` (sửa slot vừa sinh xong theo ảnh cũ trong lúc lưu).
  - **Sau "Bắt đầu": không đổi được ảnh sản phẩm** (như trang / tần suất / chủ đề — v1 không sửa cấu hình chiến dịch đang chạy; không có endpoint mới). Lý do: mọi slot của một chiến dịch dùng cùng một ảnh, không có slot nửa cũ nửa mới, không phải tính lại ô ảnh đang chạy / đã duyệt "Tự đăng".
- **Slot có ảnh (content):**
  - `generateSlot` nhận `referenceAssetId` (campaigns truyền ảnh sản phẩm của chiến dịch). Trong transaction ghi caption: ảnh còn `ready` (khoá `FOR KEY SHARE`) → ô `pending` có `reference_asset_id` + prompt `buildReferenceImagePrompt({request:'', topic, caption, mode:'ad', goal, brandColors})`; ảnh không còn dùng được → prompt 6.8 không ảnh tham khảo (không chặn bài).
  - Có ảnh tham khảo thì KHÔNG thêm dòng "Shop bán": ảnh là nguồn sự thật của sản phẩm; liệt kê sản phẩm khác dễ làm model ghép thêm sản phẩm khác. Không có ảnh → giữ dòng "Shop bán" như 6.8.
  - Job ảnh không đổi: tải bản ≤1024 px (lỗi kho tạm → retry, chưa tốn tiền), `editImage`, `feature=campaign_generate` theo trang slot, lỗi `maybeBilled` → `failed` không retry, không gửi `input_fidelity` cho `gpt-image-2.5-*`. Giữ chỗ hạn mức có phần ảnh vào (gateway 6.6).
  - Tạo lại (7.2 / 7.4) đi lại `generateSlot` → dùng ảnh sản phẩm hiện tại. Sửa caption không đổi ảnh. Lease / idempotent 7.4, "Tự đăng" (cờ `autoApprove` trên job ảnh), tạm dừng / xoá 7.5, tự tạm dừng 7.6 không đổi.
- **Vòng đời ảnh:**
  - Còn chiến dịch trỏ tới → `content.media_gc` không xoá: worker truyền danh sách ảnh sản phẩm của chiến dịch (`keep`), khoá ngoại là lưới an toàn (đã có: lỗi FK → bỏ qua).
  - Xoá chiến dịch → dòng chiến dịch mất, ảnh thành ảnh tải lên không gắn bài: `media_gc` dọn theo hạn 7 ngày như mọi ảnh, nhưng vẫn giữ khi còn ô AI trỏ `reference_asset_id` tới (kể cả ô `pending` của slot vừa huỷ — 6.6).
  - 9.2 không đụng ảnh tải lên chưa gắn bài (như 9.2 hiện tại); 9.3: dòng còn → file có tham chiếu.
- **Web:** bước 3 thẻ "Ảnh sản phẩm": tải 1 ảnh (PNG/JPEG/WebP, dùng `POST /media-assets` — không chọn được nhiều ảnh), xem trước, "Đổi ảnh", "Bỏ ảnh", câu giải thích; đang tải thì khoá "Lưu và tiếp tục". Tóm tắt có dòng ảnh sản phẩm. Bước 4 hiện ảnh sản phẩm đang dùng. Lỗi tải → toast theo mã.

**Never:** nhiều ảnh sản phẩm / ảnh theo chủ đề; dùng ảnh AI làm ảnh sản phẩm; gửi URL cho OpenAI; gửi `input_fidelity` cho `gpt-image-2.5-*`; `content` import `campaigns`; đổi model / giá / luồng job ảnh; gọi OpenAI / Cloudinary thật trong test; sửa `sprint-status.yaml`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lưu nháp có ảnh | `productImageId` = ảnh tải lên `ready` | 201; `productImage` có url; cột đặt | |
| Ảnh sai | id lạ / ô AI / ô `pending` / không phải uuid | 400 `VALIDATION_FAILED` path `productImageId` | không ghi, không slot |
| Body cũ | không có `productImageId` | như `null` | |
| Slot có ảnh + ảnh sản phẩm | xem trước / cuốn chiếu, slot `withImage` | ô `pending` có `reference_asset_id`; prompt tham khảo `ad` (ý tưởng + nội dung, "Giữ NGUYÊN sản phẩm", không "Shop bán"); job → `editImage` bytes ảnh (không URL, không `input_fidelity`), `campaign_generate`; slot → chờ duyệt / "Tự đăng" `scheduled` | ảnh lỗi → như 7.2 / 7.4 |
| Không ảnh sản phẩm | | prompt 6.8 có "Shop bán", `generateImage` | |
| Tải ảnh tham khảo lỗi | kho 503 lượt đầu / cuối | retry, không gọi OpenAI / slot `pending_approval IMAGE_FAILED` | |
| Có thể đã tính tiền | edits hết giờ sau khi gửi | `failed IMAGE_FAILED`, không retry, slot `IMAGE_FAILED` | |
| Tạo lại | slot chờ duyệt, Tạo lại | slot viết lại, ô ảnh mới trỏ ảnh sản phẩm hiện tại | |
| Đổi ảnh ở nháp | 2 slot có ảnh (1 caption đã sửa), PUT ảnh mới | 2 slot `planned`, caption giữ, ô mới trỏ ảnh mới + 2 job; slot không ảnh không đổi | |
| Bỏ ảnh ở nháp | PUT `null` | slot có ảnh làm lại ảnh không tham khảo | |
| Đã bắt đầu | chiến dịch `running` | không có đường đổi ảnh (PUT → 409 như 7.1) | |
| Dọn | ảnh sản phẩm quá 7 ngày, chiến dịch còn | `media_gc` giữ; xoá chiến dịch rồi + không ô nào trỏ tới → lượt sau xoá | lỗi FK → bỏ qua |
| Slot đang chờ ảnh khi xoá chiến dịch | ô `pending` trỏ ảnh sản phẩm | ảnh giữ tới khi ô bị dọn | |
| File mồ côi | file ảnh sản phẩm | có tham chiếu, không xoá | |
| Web | chọn ảnh → xem trước → bỏ; nạp nháp có ảnh; bước 4 | body `productImageId`; form từ DTO; ảnh hiện ở bước 4 | lỗi tải → toast |

</frozen-after-approval>

## Code Map

- `packages/shared/src/campaigns.ts` -- `productImageId`, `CampaignDto.productImage`.
- `server/src/modules/campaigns/{schema,drafts,preview,generate,runner,start,index}.ts` -- cột + kiểm + DTO, truyền ảnh vào lượt sinh, làm lại ảnh khi đổi ảnh nháp, danh sách ảnh cho GC.
- `server/drizzle/00xx_*.sql` -- migration (`drizzle-kit generate`).
- `server/src/modules/content/{slots,media,media-gc,index}.ts` -- `generateSlot({referenceAssetId})`, `refreshSlotImages`, kiểm / đọc ảnh tải lên, `gcOrphanMedia({keep})`, export bảng cho FK.
- `server/src/worker/main.ts` -- ghép `keep` cho `content.media_gc`.
- `server/test/campaigns-product-image.test.ts` (MỚI) -- ma trận server.
- `web/src/lib/campaigns.ts` + `campaigns.test.ts`, `web/src/screens/CampaignWizard.tsx` -- form, body, lỗi bước 3, UI.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/campaigns.ts` -- hợp đồng.
- [x] `server/src/modules/content/*` -- slot dùng ảnh tham khảo, làm lại ảnh, kiểm ảnh tải lên, GC `keep`.
- [x] `server/src/modules/campaigns/*` + migration -- cột, kiểm, DTO, truyền ảnh, đổi ảnh nháp.
- [x] `server/src/worker/main.ts` -- `keep` cho GC.
- [x] `server/test/campaigns-product-image.test.ts` -- phủ các dòng server của ma trận; sửa test có sẵn theo DTO mới.
- [x] `web/src/lib/campaigns.ts` + test, `CampaignWizard.tsx` -- UI.
- [x] `deferred-work.md` -- kiểm thật bằng OpenAI / trình duyệt; đổi ảnh sau khi bắt đầu.

**Acceptance Criteria:**
- Given wizard bước 3 có ảnh sản phẩm đã tải, when sang bước 4, then bước 4 hiện ảnh đó và các bài có ảnh được tạo từ ảnh đó (edits).
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `SaveCampaignRequest.productImageId` (uuid | null, mặc định `null`, câu lỗi "Ảnh sản phẩm không hợp lệ"), `CampaignDto.productImage` (`MediaAssetDto | null`).
- **Migration** `server/drizzle/0045_burly_the_fallen.sql` (`drizzle-kit generate`): `campaigns.product_image_id` + FK `ON DELETE no action` + index `campaigns_product_image_idx`. Đã chạy vào Postgres nhúng của dev (5433).
- **content:**
  - `media.ts`: `lockUploadedImage` (`FOR KEY SHARE`, trả `missing | not_ready | not_upload`), `uploadedImagesById`. `index.ts` export thêm `mediaAssetsTable` (chỉ để khai FK).
  - `slots.ts`: `SlotGenerateOptions.referenceAssetId`; `slotImagePrompt` (có ảnh → `buildReferenceImagePrompt({request:'', topic, caption, mode:'ad', goal, brandColors})`, không "Shop bán"; không ảnh → prompt 6.8 cũ); `usableReference` (ảnh còn `ready`, khoá `FOR KEY SHARE` trong transaction ghi caption, không thì vẽ từ chữ); `refreshSlotImages` (bài có ảnh AI mà `reference_asset_id IS DISTINCT FROM` ảnh hiện tại → gỡ ảnh, ô cũ `pending` → `failed`, slot `planned` + ô mới + job, giữ caption, `version + 1`, `post_target.updated`).
  - `media-gc.ts`: `keep` (bỏ khỏi danh sách ứng viên); khoá ngoại vẫn là lưới an toàn.
- **campaigns:** `schema.ts` cột; `drafts.ts` kiểm ảnh trong `assertDraftValid` (cả lúc "Bắt đầu" kiểm lại), ghi cột, DTO đọc qua `uploadedImagesById`, `PRODUCT_IMAGE_MESSAGE`, `campaignProductImageIds`; `preview.ts` `syncPreviewSlots(tx, campaign, {jobs, events})` gọi `refreshSlotImages`, `runPreview` gọi lại dưới `FOR SHARE` và truyền `referenceAssetId`; `generate.ts` + `runner.ts` truyền `referenceAssetId`; `start.ts` `asSaved` mang ảnh.
- **Route / worker:** `app/campaigns.ts` truyền `{jobs, events}` cho `syncPreviewSlots`; `worker/main.ts` `content.media_gc` nhận `keep = campaignProductImageIds()`.
- **Web:** `lib/campaigns.ts` `CampaignForm.productImage`, body `productImageId`, lỗi `productImageId` → bước 3. `CampaignWizard.tsx`: thẻ "Ảnh sản phẩm" ở bước 3 (Tải ảnh lên / Đổi ảnh / Bỏ ảnh, 1 ảnh, kiểm loại + 10MB như Soạn bài, lỗi → toast; tỉ lệ ảnh cho ra 0 bài có ảnh thì ghi chú), đang tải thì khoá "Lưu và tiếp tục" + stepper; Tóm tắt có dòng "Ảnh sản phẩm"; bước 4 hiện ảnh đang dùng.
- **Hàm để thử thật:** prompt slot dựng ở `content/slots.ts` `slotImagePrompt` (gọi từ `generateClaimed` / `refreshSlotImages`); lời gọi edits ở `content/images.ts` `generateImageAsset` (ô có `reference_asset_id` → `loadInputImage` → `ai.generateImage({references})` → adapter `editImage`).
- **Test:** `server/test/campaigns-product-image.test.ts` (12 test mới, phủ các dòng server của ma trận); `web/src/lib/campaigns.test.ts` (+3), `overview.test.ts` (fixture thêm `productImage`).
- **Kiểm:** `npm run check` thoát 0 — depcruise sạch (250 module), server 82 tệp / 1637 test, web 25 tệp / 364 test. Trình duyệt (dev 5173): cột Tóm tắt hiện "Ảnh sản phẩm · Không có"; chưa vào được bước 3 (trang dev chưa có hồ sơ thương hiệu, dev không có `CLOUDINARY_URL`) — ghi ở deferred-work.
- **deferred-work:** kiểm thật OpenAI / trình duyệt; đổi ảnh sau khi bắt đầu; "Bắt đầu" ngay sau khi đổi ảnh lúc bài đang viết dở.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Đã soát: đổi ảnh chen giữa lượt xem trước (queue `campaigns.preview` stately theo `campaignId` → lượt sau chạy `refreshSlotImages` sau khi lượt cũ xong), lưu lại không đổi ảnh không làm lại (`IS DISTINCT FROM`), bài không ảnh / ảnh tải lên không bị đụng, GC (`keep` + `notReference` + FK), xoá chiến dịch, purge 9.2 (chỉ xoá ảnh vừa gỡ khỏi bài, lỗi FK → bỏ qua), quét file mồ côi 9.3 (dòng còn → có tham chiếu), ảnh mất → vẽ từ chữ, server kiểm `source = 'upload'`, state web (callback `mutate` không chạy sau unmount, form giữ ảnh khi quay lại bước 3) | không lỗi mức vừa / cao | — |
| `refreshSlotImages` khoá `post_targets` rồi mới cập nhật ô ảnh cũ `pending` → `failed`; job ảnh hoàn tất cùng lúc khoá ô ảnh rồi mới `settle` slot → thứ tự khoá ngược, có thể deadlock (Postgres huỷ một bên: lưu nháp 500 phải bấm lại, hoặc job ảnh retry rồi `skipped`). Cửa sổ vài ms, không hỏng dữ liệu | thật, mức thấp | defer |

## Design Notes

- **Một cột thay vì bảng:** v1 một ảnh; FK không cascade cho phép DB chặn xoá ảnh đang dùng mà `content` không cần biết bảng `campaigns` (AD-1). `keep` do worker ghép chỉ để `media_gc` không lặp lại cùng các dòng bị FK chặn mỗi ngày.
- **Làm lại theo trạng thái, không theo "có đổi":** slot cần làm lại = có ảnh gắn mà `reference_asset_id` khác ảnh sản phẩm hiện tại. Không cần so bản trước / sau, và lượt preview sau tự sửa slot vừa sinh theo ảnh cũ trong lúc lưu.
- **TNUT:** `sourceImageUrl = productImageUrl || moodImageUrl` cho mọi bài có ảnh; ở đây chỉ có ảnh sản phẩm (không ảnh mood).

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: đúng một migration (`campaigns.product_image_id` + FK + index).
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `/chien-dich/tao` với OpenAI + Cloudinary thật: bước 3 tải ảnh sản phẩm → bước 4 hiện ảnh; bài có ảnh giữ đúng sản phẩm.
