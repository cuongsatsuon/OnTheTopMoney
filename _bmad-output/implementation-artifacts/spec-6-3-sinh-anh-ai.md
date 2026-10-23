---
title: 'Story 6.3 — Sinh ảnh AI'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'd533d4b9c99ffd0c64ff44d81c3c7e1cd3333e54'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 6.3, UX F4 b3 + F4 Thất bại, AD-14, AD-7, AD-24; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Ở Soạn bài, nút "Tạo ảnh AI" đang khoá. Gateway đã có `generateImage` nhưng chưa có job sinh ảnh, chưa có cách lưu ô ảnh đang sinh / lỗi, và ảnh tải lên rồi bỏ nằm mãi trên Cloudinary vì chưa có cron dọn.

**Approach:**
- `POST /media-assets/generate` ghi 4 ô `media_assets(source=ai, status=pending)` và enqueue 4 job `content.image.generate` trong cùng transaction.
- Mỗi job gọi `ai.generateImage()`, `MediaStore.put()`, chuyển ô sang `ready` (phát `media_asset.created`) hoặc `failed` (phát `media_asset.failed`). FE đọc trạng thái ô qua REST, SSE làm cũ cache.
- Cron `content.media_gc` hằng ngày xoá ảnh không gắn vào bài nào quá 7 ngày.

## Boundaries & Constraints

**Always:**
- **Bảng `media_assets` (migration `drizzle-kit generate`):**
  - Thêm `status` `pending|ready|failed` (mặc định `ready`, ảnh tải lên vẫn ghi `ready`), `error_code` (`IMAGE_REJECTED|IMAGE_FAILED`, có ⇔ `failed`) và `prompt`.
  - Cột file (`public_id`, `url`, `width`, `height`, `bytes`, `format`) được null khi chưa `ready`. Check: `ready` ⇒ đủ cột file.
  - Chỉ ảnh `ready` gắn được vào target. Ảnh chưa xong → `VALIDATION_FAILED` "Ảnh chưa sẵn sàng". Kiểm ảnh khoá `FOR KEY SHARE` để cron dọn không xoá chen.
- **Hợp đồng (shared `content.ts`):**
  - `ImageStyle` `product|lifestyle|minimal|illustration`.
  - `GenerateImagesRequest` (strict): `prompt` (trim, 1–`POST_TOPIC_MAX`), `style` (mặc định `product`).
  - `GeneratedImageDto {id, status, errorCode, asset: MediaAssetDto|null, createdAt}`, `GeneratedImagesResponse {images}`.
  - `IMAGE_GENERATE_COUNT = 4`. Ô `pending` quá `IMAGE_PENDING_MS` (15 phút [ASSUMPTION], job mất) thì đọc ra `failed IMAGE_FAILED`.
  - Sự kiện mới `media_asset.failed {errorCode}` (realtime).
- **Route:**
  - `POST /api/v1/media-assets/generate` → 202 `{images}` (4 ô `pending`). Kiểm trước, theo thứ tự:
    1. kho media chưa cấu hình → 500 `MEDIA_NOT_CONFIGURED`;
    2. khoá OpenAI (`getUsableOpenAiKey`) → mã khoá;
    3. hạn mức `blocked` → 402 `AI_BUDGET_EXCEEDED`.

    Lỗi ở bước nào thì không ghi gì, không enqueue.
  - `GET /api/v1/media-assets/generated?ids=a,b` (1–40 uuid) → `{images}` theo thứ tự `ids`, bỏ id không có.
- **Prompt (AD-7):** `ai/prompts/image.ts` `buildImagePrompt({description, style})`: mô tả + phong cách + "không chữ, không logo, không watermark". Không log prompt.
- **Job `content.image.generate`** (`standard`, retry 2 backoff, concurrency 2, hạn 240 giây), data `{mediaAssetId}`:
  - Ô không còn `pending` → bỏ qua.
  - Gọi gateway `feature=image_generate`, `n=1`, `ref=mediaAssetId`, `signal=job.signal`.
  - `put({asJpeg, stripMetadata, toSrgb})`, rồi một transaction `UPDATE … WHERE status='pending'` → `ready` + `media_asset.created`. Không còn `pending` (đã bị dọn) → xoá ảnh vừa tải.
  - Ánh xạ lỗi:
    - `AI_POLICY_BLOCKED` → `failed IMAGE_REJECTED`.
    - Lỗi tạm (`RATE_LIMITED`, `AI_PROVIDER_ERROR` ≥500) chưa phải lần cuối → ném để retry.
    - Lỗi khác, lần cuối, kho lỗi, bytes không phải ảnh → `failed IMAGE_FAILED`. Kho lỗi không retry vì OpenAI đã tính tiền.
    - Mỗi lần thành `failed` phát `media_asset.failed`.
  - Huỷ (`job.signal`) → ném lại, không ghi.
- **Cron `content.media_gc`** (04:00 `Asia/Ho_Chi_Minh`, retry 1):
  - Xoá tối đa 500 `media_assets` mọi trạng thái, tạo quá 7 ngày, không có dòng `post_target_media`.
  - Mỗi dòng: xoá DB (điều kiện lặp lại), rồi xoá file Cloudinary (best-effort).
  - Dòng vừa được gắn (lỗi FK) → bỏ qua. Kho chưa cấu hình → chỉ xoá dòng không có file.
- **Web (`lib/composer.ts`, `Composer.tsx`):**
  - Mục Ảnh có ô "Mô tả ảnh" (trống = ý tưởng bài), "Phong cách", nút "Tạo ảnh AI" (đã có ảnh AI thì là "Tạo lại ảnh").
  - Thiết lập có công tắc "Kèm 4 ảnh AI" (mặc định bật, theo UX F4 b3 và bản mẫu). Bật thì "Tạo bằng AI" sinh ảnh cùng lúc với caption.
  - Lưới ảnh:
    - ô đang sinh: khung chờ "Đang tạo ảnh…";
    - ô lỗi: "Không tạo được ảnh này" + lý do + "Thử mô tả khác" (bỏ ô lỗi, focus ô Mô tả ảnh);
    - ô xong: ảnh chọn được như ảnh tải lên.
  - "Tạo lại ảnh" thay bộ ảnh AI cũ, giữ ảnh đang gắn cho một tab nào đó.
  - Nút ảnh AI khoá theo `lock` của 6.2 và khi đang sinh. Caption không bị ảnh hưởng bởi lỗi ảnh.

**Never:**
- `ai` không chạm `media_assets`; `content` không import route. Không gọi OpenAI thật ở test, không log prompt / mô tả.
- Không tự gắn ảnh AI vào tab. Không huỷ được job đang sinh (Dừng chỉ huỷ caption).
- Không dọn file mồ côi trên Cloudinary theo prefix (việc hoãn còn mở). Không lên lịch / đăng (6.4).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Bấm sinh ảnh | prompt + style hợp lệ, khoá ok | 202, 4 ô `pending` `source=ai`, 4 job `content.image.generate` | |
| Body sai | prompt rỗng / >1000; style lạ; khoá thừa | 400 `VALIDATION_FAILED` + `path` | không ghi, không enqueue |
| Chặn trước | kho chưa cấu hình / thiếu khoá / hạn mức blocked | 500 `MEDIA_NOT_CONFIGURED` / 400 `OPENAI_KEY_MISSING` / 402 `AI_BUDGET_EXCEEDED` | không ghi, không enqueue |
| Job thành công | ô `pending` | gateway `image_generate` (n=1, `ref`), Cloudinary nhận JPEG sRGB không EXIF, ô `ready` có `asset`, 1 `ai_usage`, phát `media_asset.created` | |
| Bị từ chối | OpenAI `moderation_blocked` | ô `failed IMAGE_REJECTED`, phát `media_asset.failed` | không retry |
| Lỗi tạm | 5xx lần đầu / lần cuối | ném để retry, ô vẫn `pending` / `failed IMAGE_FAILED` | |
| Lỗi khác | hết hạn mức giữa chừng; Cloudinary 5xx sau khi có ảnh | `failed IMAGE_FAILED` | không retry |
| Ô không còn chờ | ô đã `ready`/`failed`/bị xoá | bỏ qua, không gọi OpenAI | |
| Huỷ job | `job.signal` huỷ | ném lại, ô vẫn `pending` | |
| Đọc trạng thái | ids lẫn id lạ; ô chờ quá 15 phút | đúng thứ tự, bỏ id lạ; ô cũ đọc ra `failed IMAGE_FAILED` | ids sai → 400 |
| Gắn ảnh chưa xong | lưu nháp với ô `pending`/`failed` | 400 `VALIDATION_FAILED` "Ảnh chưa sẵn sàng" | |
| Dọn ảnh | ô quá 7 ngày không gắn; ảnh gắn bài; ảnh mới; ô lỗi không file | xoá DB + file Cloudinary; giữ; giữ; xoá dòng | kho lỗi khi xoá file → vẫn xoá dòng, đếm lỗi |
| Chưa đăng nhập | | 401 | |
| Web lưới ảnh | 4 ô (chờ, xong, lỗi, xong) + ảnh tải lên | ô chờ / ảnh / "Không tạo được ảnh này" + lý do theo mã / ảnh, rồi ảnh tải lên | |
| Web tạo lại | bộ cũ có 1 ảnh đang gắn tab | bộ mới thay bộ cũ, ảnh đang gắn còn trong kho | |
| Web prompt | mô tả trống / có; cả hai trống | dùng ý tưởng / mô tả; nút khoá | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/{enums,content,events}.ts` -- `MediaAssetStatus`, `ImageStyle`, hợp đồng sinh ảnh, `media_asset.failed`.
- `server/src/modules/content/{schema,media,posts,images,media-gc,index}.ts` -- cột mới, chỉ gắn ảnh `ready`, yêu cầu + job sinh ảnh, cron dọn.
- `server/src/modules/ai/prompts/{image,index}.ts`, `ai/index.ts` -- mẫu prompt ảnh.
- `server/src/platform/jobs/queues.ts` -- `content.image.generate`, `content.media_gc`.
- `server/src/app/{media-assets,media-generate,app}.ts`, `server/src/worker/main.ts`, `server/test/notifications.test.ts` -- route + đăng ký job.
- `server/drizzle/0028_stormy_wendigo.sql` -- migration.
- `server/test/content-images.test.ts` (MỚI) -- ma trận server.
- `web/src/lib/composer.ts` + `composer.test.ts`, `web/src/screens/Composer.tsx`, `web/src/components/ui.tsx` -- hook, helper lưới ảnh, giao diện.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/*` -- enum, hợp đồng, sự kiện -- AD-18, AD-3.
- [x] `server/src/modules/content/schema.ts` + migration -- cột `status`/`error_code`/`prompt`, check -- AD-14.
- [x] `server/src/modules/content/{media,posts}.ts` -- DTO ô ảnh, chỉ gắn ảnh `ready` + khoá `FOR KEY SHARE`.
- [x] `server/src/modules/ai/prompts/image.ts` -- `buildImagePrompt` -- AD-7.
- [x] `server/src/modules/content/images.ts` -- `requestImageGeneration`, `listGeneratedImages`, `handleImageGenerateJob` -- AD-14, AD-24.
- [x] `server/src/modules/content/media-gc.ts` -- `gcOrphanMedia` -- AD-14.
- [x] `server/src/platform/jobs/queues.ts`, `worker/main.ts`, `app/*` -- queue, cron, route.
- [x] `server/test/content-images.test.ts` -- phủ các dòng server của ma trận.
- [x] `web/src/lib/composer.ts`, `composer.test.ts` -- hook + helper + test các dòng web.
- [x] `web/src/screens/Composer.tsx` -- mục Ảnh AI, công tắc "Kèm 4 ảnh AI".
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- mục kiểm bằng trình duyệt, tỉ lệ ảnh IG.

**Acceptance Criteria:**
- Given chủ shop bấm "Tạo ảnh AI", when 4 job chạy xong, then 4 ô ảnh tự cập nhật qua SSE và chọn được cho từng tab.
- Given OpenAI từ chối một ảnh, then chỉ ô đó báo "Không tạo được ảnh này" + "Thử mô tả khác"; caption các tab giữ nguyên.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:**
  - `MediaAssetStatus` (enums).
  - `content.ts`: `IMAGE_GENERATE_COUNT`, `IMAGE_PENDING_MS`, `GENERATED_IMAGES_QUERY_MAX` (40), `ImageStyle`, `ImageErrorCode`, `GenerateImagesRequest`, `GeneratedImageDto`, `GeneratedImagesResponse`.
  - Sự kiện `media_asset.failed {errorCode}`.
- **Server:**
  - Migration `0028_stormy_wendigo.sql`: `media_assets` thêm `status` / `error_code` / `prompt`, cột file được null, 3 check (trạng thái, mã lỗi ⇔ `failed`, `ready` ⇒ đủ cột file), index `created_at` cho cron.
  - `content/media.ts`: `toMediaAssetDto` chỉ nhận dòng `ready`; `toGeneratedImageDto` đọc ô chờ quá 15 phút thành `failed IMAGE_FAILED`.
  - `content/posts.ts`: ảnh gắn phải `ready` ("Ảnh chưa sẵn sàng"), khoá `FOR KEY SHARE`.
  - `content/images.ts`: `requestImageGeneration`, `listGeneratedImages`, `generateImageAsset`, `handleImageGenerateJob`.
  - `content/media-gc.ts`: `gcOrphanMedia`. Từng dòng: xoá DB rồi mới xoá file; lỗi khoá ngoại → bỏ qua; kho chưa cấu hình → chỉ xoá dòng không có file.
  - `ai/prompts/image.ts`: `buildImagePrompt`. Mô tả gộp một dòng; ảnh không chữ / logo / watermark.
  - Queue `content.image.generate` (retry 2, concurrency 2, hạn 240 giây) và cron `content.media_gc` (04:00 giờ VN).
  - Route:
    - `app/media-generate.ts` (`POST`, đăng ký trong khối AI, cần `jobs`);
    - `GET /media-assets/generated` thêm vào `app/media-assets.ts`;
    - worker đăng ký hai handler.
  - `test/notifications.test.ts` thêm hai handler rỗng (worker test dùng đủ registry).
- **Web:**
  - `lib/composer.ts`:
    - `IMAGE_STYLE_OPTIONS`, `imagePrompt`, `buildImageBody`;
    - `imageTiles` / `tileImages` / `pendingTiles`, `keepAttachedGenerated`, `dismissFailed`, `imageFailureText`;
    - hook `useGeneratedImages` (khoá gốc `media_assets` — SSE `media_asset.*` làm cũ; hỏi lại 10 giây khi còn ô chờ) và `useGenerateImages` (ghi sẵn 4 ô vào cache).
  - `Composer.tsx`:
    - công tắc "Kèm 4 ảnh AI" (mặc định bật) ở Thiết lập;
    - mục Ảnh có "Mô tả ảnh", "Phong cách", "Tạo ảnh AI" / "Tạo lại ảnh" (khoá theo `lock` + khi đang sinh);
    - lưới `ImageTileView`: ô chờ, ô lỗi "Không tạo được ảnh này" + lý do + "Thử mô tả khác", ảnh.
  - `components/ui.tsx`: `Input` nhận `ref` để focus ô mô tả.
- **Kiểm tra:** `npm run check` thoát 0.
  - depcruise sạch (182 module).
  - Server 61 file / 1.267 test (`content-images.test.ts` 18 test).
  - Web 19 file / 270 test (+4).
  - Chưa thử bằng trình duyệt (dev không có mật khẩu mẫu, cần khoá OpenAI + Cloudinary thật + worker); đã ghi vào deferred-work cùng hai việc hoãn mới: tỉ lệ ảnh IG khi đăng (6.4), ô ảnh AI chưa gắn mất khi tải lại trang.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|---|---|---|
| Kích thước ảnh lấy từ Cài đặt; `1024x1536` (2:3) ngoài khoảng tỉ lệ ảnh feed Instagram (4:5 – 1,91:1) → ảnh AI sẽ bị IG từ chối khi đăng (6.4). Sửa: job truyền `size` = `postImageSize(prefs.imageSize)` (2:3 → `1024x1024`, `1536x1024` giữ) + test. | đúng, trung bình | `patch` |
| Tiền đã trả cho ảnh có thể mất / trả lại: kho lỗi tạm sau khi OpenAI đã trả ảnh → `failed` ngay (không thử `put` lại); hết giờ sau khi gửi (`maybeBilled`, ghi chi phí ước tính) là `AI_PROVIDER_ERROR` 502 → retry gọi OpenAI lần nữa (tối đa 3 lần tính tiền cho một ô). | đúng, trung bình (chi phí) | `defer` |

## Design Notes

- Ô ảnh đang sinh / lỗi nằm luôn trong `media_assets` (trạng thái), không cần bảng riêng. Job đổi `pending → ready`, tương đương "chèn `media_assets(status=ready)`" của AD-14. FE theo dõi đúng các id vừa nhận, nên tải lại trang thì ô chưa gắn sẽ mất khỏi lưới; cron dọn sau 7 ngày.
- Ảnh không gắn với bài hay trang: một bộ 4 ảnh dùng chung cho mọi tab. `ai_usage.page_id` để trống, `ref` = id ô.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: một migration mới cho `media_assets`.
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `/soan-bai` với khoá OpenAI + Cloudinary thật, worker chạy: "Tạo bằng AI" → 4 ô "Đang tạo ảnh…" lần lượt thành ảnh; mô tả vi phạm → ô báo lỗi + "Thử mô tả khác".
