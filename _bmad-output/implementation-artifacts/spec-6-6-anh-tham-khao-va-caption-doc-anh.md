---
title: 'Story 6.6 — Ảnh AI từ ảnh tham khảo và caption AI đọc ảnh'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'ef2935d54e4e1620f1c4610ba12f063791bb62b2'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="Yêu cầu mới của chủ dự án (ngoài epics.md, coi như Story 6.6); dựa trên 6.1 / 6.2 / 6.3, AD-7, AD-14, AD-21; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Ảnh AI ở Soạn bài chỉ vẽ từ chữ nên không giữ được sản phẩm thật của shop. Caption AI không thấy ảnh của tab, nên dễ tả sai màu, mẫu, bối cảnh trong ảnh sẽ đăng.

**Approach:**
- Trên ảnh chủ shop tải lên có thao tác "Dùng làm ảnh tham khảo". Chủ shop gõ yêu cầu bối cảnh, rồi luồng 4 ô / 4 job của 6.3 sinh biến thể qua Images API **edits**: giữ đúng sản phẩm, chỉ đổi bối cảnh. Chủ shop chọn 1 ảnh cho mỗi trang như ảnh AI hiện tại.
- Khi tab đã có ảnh, "Tạo bằng AI" / Viết lại / Ngắn hơn / Thêm CTA gửi kèm ảnh của tab cho model chữ (Responses API, `input_image`). Caption bám theo ảnh nhưng vẫn theo hồ sơ của trang và vẫn qua hậu kiểm.

## Boundaries & Constraints

**Always:**
- **API OpenAI** (tra 2026-10-24, nguồn ở Design Notes):
  - Ảnh tham khảo gọi `POST /v1/images/edits`, multipart: `model`, `prompt`, `image[]` (PNG/JPEG/WebP < 50 MB, tối đa 16 ảnh), `n`, `size`, `output_format=jpeg`.
  - `input_fidelity=high` chỉ gửi cho `gpt-image-1` / `gpt-image-1.5`. `gpt-image-2` thì bỏ tham số vì model luôn giữ chi tiết cao. `gpt-image-2.5-*` cũng bỏ [ASSUMPTION: tài liệu không nêu].
  - Vision: phần nội dung `{type:'input_image', image_url:'data:<mime>;base64,…', detail:'low'}` đặt cạnh `input_text` trong message `user`.
- **Ảnh gửi OpenAI:**
  - Server tải bytes từ kho bằng bản thu nhỏ (cạnh dài ≤ 1024 px qua transformation `c_limit` của Cloudinary), kiểm magic bytes, gửi base64 / multipart. Không bao giờ đưa URL cho OpenAI.
  - Tối đa 1 ảnh mỗi lời gọi, ≤ 10 MB. Không log URL, bytes, prompt.
  - Adapter media chỉ tải URL giao ảnh `image/upload` của đúng cloud đã cấu hình.
- **Chi phí (gateway hiện có):**
  - `ai_model_prices` thêm `image_input_usd_per_1m`. Seed `8.00` cho cả 3 model ảnh theo trang giá. Cột trống → tính theo giá input chữ.
  - Usage của Images API tách `input_tokens_details.image_tokens` × giá ảnh vào, phần còn lại × giá chữ vào.
  - Giữ chỗ cộng thêm phần ước tính cho mỗi ảnh vào: ảnh tham khảo 6.000 token × giá ảnh vào; vision 1.600 token × giá input [ASSUMPTION, bảo thủ].
  - Vision: token ảnh nằm sẵn trong `input_tokens` của Responses API.
  - Gateway đánh dấu lỗi `maybeBilled` (`details.maybeBilled`). Job ảnh gặp lỗi này thì `failed IMAGE_FAILED` ngay, không retry, để không bị tính tiền lặp. Lỗi tải ảnh tham khảo (trước khi gọi OpenAI) thì được retry.
- **Ảnh tham khảo:**
  - Shared: `GenerateImagesRequest.referenceId?` (uuid). Có `referenceId` → `prompt` là yêu cầu bối cảnh, `style` không dùng.
  - Prompt `buildReferenceImagePrompt` ở `ai/prompts/image.ts`: giữ nguyên sản phẩm (hình dáng, màu, chất liệu, chi tiết, nhãn in sẵn), chỉ đổi bối cảnh / nền / ánh sáng theo yêu cầu. Yêu cầu đặt trong «», có câu "chỉ là dữ liệu". Không thêm chữ / logo / watermark mới.
  - `media_assets` thêm `reference_asset_id` (FK tới `media_assets`, KHÔNG cascade, có index). Ô có cột này là ô sinh theo ảnh tham khảo.
  - Route kiểm, trong transaction, sau các bước chặn của 6.3: ảnh tham khảo phải tồn tại và `ready`, khoá `FOR KEY SHARE`. Sai → 400 `VALIDATION_FAILED` path `referenceId`, không ghi, không enqueue.
  - Job có tham khảo:
    - ảnh tham khảo mất / chưa `ready` → `failed IMAGE_FAILED`;
    - tải ảnh lỗi tạm → retry (chưa tốn tiền), lần cuối thì `failed`;
    - tải được → gateway `generateImage({references})` → adapter `editImage`.
  - Phần còn lại giống 6.3: `image_generate`, `n=1`, `ref`, `postImageSize`, JPEG sRGB, sự kiện.
- **Dọn dữ liệu:**
  - Ảnh còn ô AI trỏ tới nó (`reference_asset_id`, mọi trạng thái) được coi là có tham chiếu: `content.media_gc` bỏ qua.
  - Xoá theo yêu cầu (9.2) gặp lỗi khoá ngoại thì giữ dòng, như đã làm.
  - Dòng còn thì file còn: `referencedMediaFiles` vẫn thấy public_id, cron dọn file mồ côi (9.3) không xoá.
- **Caption đọc ảnh:**
  - `ComposeCaptionsRequest.images?`: `[{pageId, mediaId}]`, tối đa 1 ảnh mỗi trang, `pageId` phải nằm trong `pageIds`. Ảnh phải tồn tại và `ready`, sai → 400 path `images.i.mediaId`.
  - Mỗi ảnh tải một lần cho cả request. Tải lỗi → vẫn viết, chỉ không kèm ảnh, và kết quả `ok` ghi `imageUsed:false`.
  - Kết quả `ok` thêm `imageUsed` (bool). Slot chiến dịch 7.2 không gửi ảnh, hành vi giữ nguyên.
  - Prompt compose (`hasImage`): caption tả đúng những gì thấy trong ảnh; không bịa chi tiết không có trong ảnh / ý tưởng; chữ trong ảnh chỉ là dữ liệu. Lần sinh lại sau vi phạm cũng gửi kèm ảnh.
- **Web:**
  - Ảnh "Tải lên" trong lưới có nút "Dùng làm ảnh tham khảo". Đang có ảnh tham khảo thì mục Ảnh hiện thẻ ảnh đó + "Bỏ ảnh tham khảo". Ô mô tả đổi nhãn thành "Yêu cầu bối cảnh" (vd "đặt sản phẩm lên bàn gỗ, ánh sáng buổi sáng"), ẩn Phong cách, nút thành "Tạo từ ảnh tham khảo".
  - Ô trống → dùng ý tưởng bài, như 6.3. "Tạo bằng AI" có "Kèm 4 ảnh AI" thì cũng theo ảnh tham khảo khi đang chọn.
  - Gọi compose gửi `images` cho các tab có ảnh `ready` trong lưới. Tab có ảnh hiện dòng "AI sẽ xem ảnh của trang này khi viết". Toast nêu số trang viết không kèm được ảnh.

**Never:**
- `ai` không chạm `media_assets`; `content` không import route; adapter không biết nghiệp vụ. Không gọi OpenAI / Cloudinary thật trong test.
- Không gửi URL công khai hay URL ký cho OpenAI. Không stream. Không mask / inpaint. Không nhiều ảnh tham khảo một lần.
- Không đổi luồng ảnh AI thường, luồng caption không ảnh, slot chiến dịch.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sinh theo ảnh tham khảo | `referenceId` ảnh upload `ready` + yêu cầu | 202, 4 ô `pending` có `reference_asset_id`, prompt tham khảo, 4 job | |
| Tham khảo sai | id lạ / ô `pending` / `failed` | 400 `VALIDATION_FAILED` path `referenceId` | không ghi, không enqueue |
| Job tham khảo thành công | ô có tham khảo | tải bản ≤1024 px (`c_limit`), `editImage` (multipart, `image[]`, jpeg, size), ô `ready`, 1 `ai_usage` `image_generate` | |
| input_fidelity | model `gpt-image-1.5` / `gpt-image-2` / `gpt-image-2.5-flare` | gửi `high` / không gửi / không gửi | |
| Tải tham khảo lỗi | kho 503 lượt đầu / lượt cuối | ném retry, không gọi OpenAI / `failed IMAGE_FAILED` | |
| Tham khảo mất | dòng tham khảo không `ready` lúc chạy | `failed IMAGE_FAILED`, không gọi OpenAI | |
| Có thể đã tính tiền | gateway hết giờ sau khi gửi (`maybeBilled`), lượt chưa cuối | `failed IMAGE_FAILED`, không retry, chi phí ước tính ghi 1 lần | |
| Bị từ chối | edits `moderation_blocked` | `failed IMAGE_REJECTED` | |
| Chi phí ảnh vào | usage `{input 1100 (image 1000, text 100), output 4160}` | chi phí = 1000×8 + 100×5 + 4160×30 (USD/1M) × tỉ giá | |
| Dọn | ảnh tham khảo quá 7 ngày không gắn, còn ô AI trỏ tới; ô con bị dọn trước | giữ; lượt sau xoá | |
| File mồ côi | file của ảnh tham khảo | có tham chiếu, không xoá | |
| Caption có ảnh | 2 trang, 1 trang có ảnh `ready` | trang đó: request có 1 ảnh `detail:'low'` base64 (không URL), prompt `hasImage`, `imageUsed:true`; trang kia không ảnh, `imageUsed:false` | |
| Ảnh dùng chung | 3 trang cùng 1 ảnh | tải kho 1 lần | |
| Vi phạm rồi sinh lại | lần 1 có từ cấm | lần 2 vẫn kèm ảnh | |
| Ảnh caption sai | mediaId lạ / `pending`; `pageId` ngoài `pageIds`; 2 ảnh 1 trang | 400 `VALIDATION_FAILED` + path | không gọi AI |
| Tải ảnh caption lỗi | kho 503 | viết không ảnh, `imageUsed:false` | |
| Revise có ảnh | `shorter` + ảnh | prompt có caption hiện tại + ảnh | |
| Adapter | `editImage` / `createResponse` có ảnh / `download` URL lạ | multipart đúng trường, không `Content-Type` JSON / content parts đúng / `INVALID_REQUEST` không gọi mạng | |
| Web | ảnh tải lên → dùng làm tham khảo; bỏ; body compose | nhãn / nút đổi; body `referenceId`; `images` chỉ cho tab có ảnh ready | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/content.ts` -- `referenceId`, `ComposeCaptionsRequest.images`, `imageUsed`, hằng số.
- `server/src/adapters/openai/{index,fake}.ts` -- `editImage` (multipart), ảnh trong `createResponse`, `inputFidelityFor`, `parseUsage` tách token ảnh.
- `server/src/adapters/media/{index,fake}.ts` -- `publicStore.download(url, {maxSide})`; fake bỏ qua đoạn transformation.
- `server/src/modules/ai/{schema,cost,gateway,index}.ts`, `prompts/{image,compose,index}.ts` -- giá ảnh vào, ảnh trong gateway, `maybeBilled`, mẫu prompt.
- `server/src/modules/content/{schema,input-images,images,compose,media-gc,index}.ts` -- cột tham khảo, tải ảnh cho AI, job edits, compose có ảnh, dọn.
- `server/src/app/{app,posts-compose}.ts` -- truyền `media` cho compose.
- `server/drizzle/0043_loose_starfox.sql` -- migration (`drizzle-kit generate`) + seed giá ảnh vào (thêm tay).
- `server/test/content-reference.test.ts` (MỚI), `openai-adapter.test.ts`, `media-adapter.test.ts`, `ai-gateway.test.ts`, `content-compose.test.ts` -- ma trận.
- `web/src/lib/composer.ts` + test, `web/src/screens/Composer.tsx` -- UI.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/content.ts` -- hợp đồng -- AD-18.
- [x] `server/src/adapters/{openai,media}/*` -- edits, vision, download -- AD-7, AD-14.
- [x] `server/src/modules/ai/*` + migration -- giá ảnh vào, gateway, prompt -- AD-7.
- [x] `server/src/modules/content/*` + migration -- tham khảo, compose có ảnh, dọn -- AD-1, AD-14.
- [x] `server/src/app/*` -- route.
- [x] `server/test/*` -- phủ các dòng server của ma trận.
- [x] `web/src/lib/composer.ts` + test, `Composer.tsx` -- UI.
- [x] `deferred-work.md` -- cập nhật mục `maybeBilled` của 6.3, thêm kiểm bằng OpenAI thật.

**Acceptance Criteria:**
- Given ảnh sản phẩm đã tải lên, when "Dùng làm ảnh tham khảo" + "đặt sản phẩm lên bàn gỗ, ánh sáng buổi sáng" → "Tạo từ ảnh tham khảo", then 4 ô biến thể về dần qua SSE và chọn được cho từng tab.
- Given tab có ảnh, when "Tạo bằng AI" / Viết lại / Ngắn hơn / Thêm CTA, then model nhận ảnh của tab và caption vẫn theo hồ sơ trang.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `AI_INPUT_IMAGE_MAX_SIDE` (1024), `GenerateImagesRequest.referenceId?`, `ComposeCaptionsRequest.images` (mặc định `[]`, kiểm trang thuộc `pageIds` + 1 ảnh/trang), `ComposeCaptionResult.ok.imageUsed`.
- **Adapter OpenAI:**
  - `editImage`: multipart `/images/edits`, `image[]` kèm tên file + MIME, không đặt `Content-Type` JSON. Dùng chung `postJson` (nhận `FormData`).
  - `createResponse({images})` dựng message `user` gồm `input_text` + `input_image` (data URL base64).
  - `inputFidelityFor`: chỉ `gpt-image-1` / `1.5` nhận `high`.
  - `parseUsage` tách `image_tokens`.
  - Fake: `editRequests` / `onEdit`.
- **Adapter media:**
  - `publicStore.download(url, {maxSide, signal})`: chỉ URL `https://res.cloudinary.com/<cloud>/image/upload/…`, chèn `c_limit`, chặn query / `..`, giới hạn 10 MB.
  - Fake bỏ qua đoạn transformation khi giao file.
- **ai:**
  - Cột `image_input_usd_per_1m` (seed 8,00 cho 3 model ảnh); `computeCost` tách token ảnh vào.
  - Ước tính giữ chỗ `estimateInputImagesCost` (6.000 / 1.600 token mỗi ảnh) + `addCost`.
  - Gateway: `generateText({images})`, `generateImage({references})` → `editImage`. Giới hạn 4 ảnh, 10 MB mỗi ảnh. Lỗi `maybeBilled` mang `details.maybeBilled` (`isMaybeBilled`).
  - `buildReferenceImagePrompt`; `composeInstructions` thêm khối `hasImage`.
- **content:**
  - Cột `reference_asset_id` (FK tự trỏ, không cascade, index).
  - `input-images.ts` `loadInputImage`: tải bản thu nhỏ + kiểm magic bytes.
  - `images.ts`:
    - route kiểm ảnh tham khảo `FOR KEY SHARE` trong transaction;
    - job tải ảnh tham khảo trước khi gọi OpenAI (lỗi tạm → retry `UPLOAD_FAILED`);
    - `retryable` loại lỗi `maybeBilled` — đóng nửa việc hoãn 6.3.
  - `compose.ts`: kiểm ảnh `ready` (400 `images.i.mediaId`); tải mỗi ảnh một lần cho cả request (cache theo URL); tải lỗi → viết không ảnh + log `kind`.
  - `media-gc.ts`: bỏ qua ảnh còn ô trỏ tới (`notReference`). Xoá theo yêu cầu (9.2) và dọn file mồ côi (9.3) không đổi code: FK giữ dòng nên file vẫn có tham chiếu.
- **Route:** compose nhận `media` (`app.ts`).
- **Web:**
  - `lib/composer.ts`: `composeImages`, `buildComposeBody({images})`, `buildImageBody(…, referenceId)`, `canUseAsReference`, `referenceAsset`, `composeToast(results, withImage)`.
  - `Composer.tsx`:
    - nút "Dùng làm ảnh tham khảo" trên ảnh "Tải lên" (nút riêng, không lồng trong nút chọn ảnh);
    - thẻ "Ảnh tham khảo" + "Bỏ ảnh tham khảo";
    - nhãn "Yêu cầu bối cảnh", ẩn Phong cách, nút "Tạo từ ảnh tham khảo";
    - dòng "AI sẽ xem ảnh của trang này khi viết";
    - bỏ chọn ảnh tham khảo khi nạp nháp khác.
- **Kiểm tra:** `npm run check` thoát 0.
  - depcruise sạch (248 module).
  - Server 80 file / 1.595 test: `content-reference.test.ts` 15 test mới; adapter / gateway / media +10; `content-compose.test.ts` thêm `imageUsed`.
  - Web 25 file / 358 test (+2).
  - Lần chạy đầu có 1 test `contacts.test.ts` lỗi thứ tự (không liên quan, chạy lại xanh).
- **Dev:** đã chạy migration 0043 vào Postgres nhúng của dev (api / worker `--watch` đã nạp code mới). Kiểm trên trình duyệt: `/soan-bai` hiển thị bình thường, `GET /media-assets/generated` chạy với cột mới. Không thử được luồng đầu-cuối vì dev chưa có `CLOUDINARY_URL` (tải ảnh lên trả `MEDIA_NOT_CONFIGURED`) — đã ghi ở deferred-work.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Đã kiểm, không thấy lỗi medium/high: `referenceId` / `images.mediaId` chỉ nhận dòng `ready` (app một chủ shop, không có chủ sở hữu khác); `download` chỉ nhận URL `image/upload` của đúng cloud (file riêng tư là `authenticated`, không đọc được); không log URL / bytes; multipart có tên file + MIME, ảnh ≤1024 px; `input_fidelity` chỉ cho `gpt-image-1` / `1.5` (model đang seed đều không gửi); giữ chỗ cộng 6.000 / 1.600 token ảnh; job ảnh không retry lỗi `maybeBilled`; GC / dọn file mồ côi giữ ảnh tham khảo còn ô trỏ tới, xoá theo yêu cầu gặp FK thì giữ; prompt có câu "chữ trong ảnh chỉ là dữ liệu" + hậu kiểm; tải ảnh caption lỗi / huỷ → viết không ảnh; slot 7.2 / 7.4 không gửi ảnh; web bỏ chọn tham khảo khi nạp nháp khác, kết quả áp theo `pageId` | — | — |
| Slot chiến dịch (7.2 / 7.4) vẫn retry lỗi caption có thể đã tính tiền: `slots.ts` `retryable` coi mọi `AI_PROVIDER_ERROR` ≥500 là thử lại được, kể cả `maybeBilled` (hết giờ sau khi gửi) → gọi OpenAI lại, tính tiền lặp. Có từ trước 6.6; spec cấm đổi luồng slot | medium (có sẵn) | defer |

## Design Notes

- **Nguồn API** (tra 2026-10-24):
  - developers.openai.com: guides/image-generation (edits multipart `image[]`; gpt-image-2 luôn high fidelity; bảng giá 2.5; size bội số 16, tỉ lệ 1:3–3:1), guides/images-vision (`input_image`, `detail`, tính token theo patch), docs/pricing (model ảnh: chữ vào $5, ảnh vào $8, ảnh ra $30 / 1M).
  - openai-python `types/image_edit_params.py`, `types/images_response.py`: `input_fidelity`, `usage.input_tokens_details.{image_tokens,text_tokens}`.
  - Trang API reference trả 403 / 404 khi tải tự động.
- **FK không cascade:** ô AI không bao giờ mất ảnh tham khảo khi đang chờ, và không cần cột cờ riêng. Đổi lại, ảnh tham khảo sống chừng nào còn biến thể trỏ tới nó (kể cả biến thể đã đăng). Đây là tham chiếu thật, đúng yêu cầu dọn của 9.3.
- **Mỗi ô gửi lại ảnh tham khảo** (4 job, `n=1`): tốn 4 lần token ảnh vào, đổi lại giữ được ô lỗi riêng / retry riêng của 6.3.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: một migration (`media_assets.reference_asset_id` + index, `ai_model_prices.image_input_usd_per_1m`); thêm seed giá tay.
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `/soan-bai` với khoá OpenAI + Cloudinary thật, worker chạy: tải ảnh sản phẩm → "Dùng làm ảnh tham khảo" → 4 biến thể giữ đúng sản phẩm; tab có ảnh → "Tạo bằng AI" → caption nhắc đúng màu / bối cảnh trong ảnh.
