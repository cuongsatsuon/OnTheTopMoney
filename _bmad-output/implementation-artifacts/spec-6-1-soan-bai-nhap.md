---
title: 'Story 6.1 — Soạn bài nháp cho nhiều trang'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'da3b54af2d1ac3d6ebaef3397b51c4003b338ab7'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 6.1, UX Flow 4, AD-13, AD-14, AD-18; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Soạn bài AI `/soan-bai` đang chạy hoàn toàn trên dữ liệu mẫu: trang mẫu, ảnh picsum, "Lưu nháp" chỉ hiện toast. Server chưa có module `content`. Vì vậy chưa lưu được bài nào, chưa tải được ảnh thật, và chưa có bảng ràng buộc nền tảng cho FE và server dùng chung.

**Approach:**
- Dựng module `content`: bảng `posts`, `post_targets`, `media_assets`, `post_target_media`; một cửa tạo `createPost`; sửa nháp; đọc bài; `assertPublishable`.
- Thêm route tải ảnh bài lên kho công khai (magic bytes, bỏ EXIF, JPEG sRGB) và route lưu/đọc nháp.
- Bảng ràng buộc nền tảng + hàm `publishIssues` đặt ở `packages/shared`.
- Composer dùng trang/nhóm thật: tab theo trang, caption và ảnh riêng từng trang, báo lỗi nền tảng ngay trên tab, "Lưu nháp" thật, mở lại nháp bằng `?bai=<id>`.

## Boundaries & Constraints

**Always:**
- **Shared `content.ts`:**
  - `PLATFORM_RULES`:
    - facebook: caption ≤ 63.206, không bắt buộc ảnh.
    - instagram: caption ≤ 2.200, ≤ 30 hashtag, bắt buộc ảnh.
    - threads: caption ≤ 500.
  - `POST_TARGET_MEDIA_MAX = 1`: mỗi trang tối đa 1 ảnh [ASSUMPTION, theo UX "chọn 1 ảnh"; cột vẫn là danh sách để mở carousel sau].
  - `captionLength` đếm code point, khớp `checkOutput`. `countHashtags`.
  - `publishIssues({platform, caption, mediaCount})` kiểm theo thứ tự `POST_EMPTY` → `MEDIA_REQUIRED` → `CAPTION_TOO_LONG` → `TOO_MANY_HASHTAGS`. `POST_EMPTY` nghĩa là caption trống và không có ảnh; đây là `ErrorCode` mới.
  - FE và server cùng gọi hàm này.
- **Bảng (AD-1, chỉ `content` ghi):**
  - `posts(source manual|campaign, topic)`.
  - `post_targets(post_id, page_id, status, caption, version, schedule_version, scheduled_at, error_code, cancel_reason)`, `UNIQUE(post_id, page_id)`.
  - `media_assets(source upload|ai, public_id, url, width, height, bytes, format)`.
  - `post_target_media(post_target_id, media_asset_id, position)`.
  - FK tới `pages` và `posts` dùng `on delete cascade`. Migration sinh bằng `drizzle-kit generate`.
- **Một cửa tạo (AD-13):**
  - `content.createPost(tx, {source:'manual', topic, targets[]})`: một `posts` + n target `draft`.
  - Trang phải tồn tại và chưa gỡ; trang `disconnected` vẫn lưu nháp được.
  - `pageId` không trùng. `mediaIds` phải là `media_assets` có thật.
  - Lỗi → `VALIDATION_FAILED` kèm `details[].path` trỏ đúng ô.
  - Nháp được lưu cả khi vi phạm luật nền tảng; luật chỉ chặn khi lên lịch.
- **Sửa nháp:** `PUT /posts/:id` thay toàn bộ đích trong một transaction (khoá dòng `posts`).
  - Trang bỏ chọn → xoá target nháp. Trang giữ lại → cập nhật caption/ảnh, `version + 1`. Trang mới → thêm target `draft`.
  - Chỉ sửa được khi bài `manual` và mọi target đang `draft`; nếu không → 409 `VERSION_CONFLICT`.
- **Ảnh (AD-14):** `POST /api/v1/media-assets`.
  - Body là bytes thô; `Content-Type` ∈ jpeg/png/webp (loại khác → 415 → `VALIDATION_FAILED`).
  - Giới hạn 1 B–10 MB. Magic bytes phải khớp MIME khai báo (dùng `profiles.detectImageMime`).
  - Lưu `MediaStore.put({asJpeg: true, stripMetadata: true, toSrgb: true})`. Adapter thêm cờ `toSrgb` → incoming transformation `cs_srgb,fl_strip_profile`.
  - Mọi ảnh bài đều được chuẩn hoá JPEG vì một ảnh có thể gắn cho trang IG sau.
  - Ghi `media_assets(source=upload)`. Ghi DB lỗi → xoá ảnh vừa tải (best-effort). Lỗi kho đi qua `mediaAppError` (`UPLOAD_FAILED`).
- **`content.assertPublishable(db, targetId)`:** đọc nền tảng của trang, caption, số ảnh, rồi ném `AppError(issue đầu tiên, 422, {details:{targetId, pageId, issues}})`. Story 6.4 gọi hàm này khi chuyển tới `scheduled`.
- **Hợp đồng zod (AD-18):** `MediaAssetDto`, `SavePostRequest` (strict), `PostTargetDto`, `PostDto`. Thêm `POST_EMPTY` vào `error-messages.ts`.
- **Web `lib/composer.ts` (hook + helper thuần), `Composer.tsx`:**
  - Bộ chọn đích dùng `usePages`/`useGroups` thật. Chọn sẵn theo Phạm vi đang chọn, bỏ trang `disconnected`.
  - Mỗi trang đã chọn có một tab soạn ngay, không cần chờ AI.
  - Tab hiển thị đếm `n/giới hạn` và các dòng lỗi từ `publishIssues`, tiếng Việt kèm tên nền tảng. `POST_EMPTY` chỉ là gợi ý xám.
  - "Chép sang trang còn trống" chép caption của tab đang mở sang các tab có caption trống.
  - Ảnh:
    - Tải lên → kho ảnh của bài; gắn cho tab đang mở và các tab chưa có ảnh.
    - Bấm một ảnh → gắn cho tab đang mở. "Dùng ảnh này cho mọi trang". "Bỏ ảnh".
  - "Lưu nháp": lần đầu `POST`, sau đó `PUT`, rồi đặt `?bai=<id>` (replace). Mở `/soan-bai?bai=<id>` nạp lại nháp. `?idea=` vẫn điền sẵn ý tưởng.

**Never:**
- Không lên lịch, không đăng, không có `transitionTarget` hay queue `publish.target` (Story 6.4). Nút "Lên lịch" và "Đăng ngay" bị khoá kèm gợi ý "Sắp có".
- Không gọi OpenAI. "Tạo bằng AI", Viết lại / Ngắn hơn / Thêm CTA vẫn mô phỏng phía web cho tới Story 6.2. Sinh ảnh AI khoá cho tới Story 6.3. Bỏ hẳn ảnh picsum.
- Không phát sự kiện, không cron dọn ảnh (6.3), không màn danh sách nháp.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lưu nháp nhóm | 3 trang của nhóm, caption/ảnh khác nhau | 201 `PostDto`: 1 post `manual` + 3 target `draft`, caption và ảnh đúng từng trang | |
| Trang không hợp lệ | `pageId` lạ / đã gỡ / trùng; `targets` rỗng; 2 ảnh; `mediaId` lạ; khoá thừa | 400 `VALIDATION_FAILED` + `path` | không ghi gì |
| Nháp vi phạm luật | Threads 600 ký tự, IG không ảnh | lưu được (201) | luật chỉ chặn khi lên lịch |
| Đọc nháp | `GET /posts/:id` / id lạ | `PostDto` có target + ảnh theo `position` / 404 | |
| Sửa nháp | bỏ 1 trang, thêm 1 trang, đổi caption/ảnh | target bỏ bị xoá, target mới `draft`, target giữ `version+1` | |
| Sửa bài không còn nháp | có target ≠ `draft` / id lạ | 409 `VERSION_CONFLICT` / 404 | không đổi gì |
| Tải ảnh | png/jpeg/webp hợp lệ | 201 `MediaAssetDto` `source=upload`; Cloudinary nhận `format=jpg` + `cs_srgb,fl_strip_profile` | |
| Ảnh sai | SVG/text, MIME lệch magic, rỗng, >10 MB, `image/gif` | 400 `VALIDATION_FAILED` (path `image`); gif → 415 `VALIDATION_FAILED` | không gọi Cloudinary |
| Kho | chưa cấu hình / Cloudinary 5xx | 500 `MEDIA_NOT_CONFIGURED` / 502 `UPLOAD_FAILED` | |
| assertPublishable | Threads 501 / 500 ký tự (có emoji); IG 0 ảnh; IG 31 hashtag; FB trống không ảnh; FB có ảnh không chữ | `CAPTION_TOO_LONG` / ok; `MEDIA_REQUIRED`; `TOO_MANY_HASHTAGS`; `POST_EMPTY`; ok | 422 kèm `issues` |
| Chưa đăng nhập | không cookie | 401 | |
| Web chọn đích | Phạm vi nhóm / trang / tất cả; bấm nhóm | chọn sẵn trang không `disconnected` của nhóm / trang / không chọn; bấm nhóm bật/tắt cả nhóm | |
| Web lỗi tab | Threads 520 ký tự, IG chưa ảnh | tab có dấu lỗi + câu "Threads tối đa 500 ký tự (đang 520)", "Instagram cần ít nhất 1 ảnh" | |
| Web ảnh | tải lên khi 2/3 tab chưa ảnh; "Dùng cho mọi trang"; "Bỏ ảnh" | gắn cho tab đang mở + tab trống; mọi tab; bỏ khỏi tab đang mở | |
| Web body lưu / nạp | state 2 trang | body đúng thứ tự chọn, `topic` rỗng → `null`; nạp `PostDto` → state cũ, bỏ target của trang không còn | |
| Web file ảnh | gif / 11 MB | báo lỗi trước khi gửi | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/content.ts` (MỚI), `enums.ts`, `errors.ts`, `index.ts` -- luật nền tảng, `publishIssues`, DTO/request, `PostSource`, `MediaAssetSource`, `POST_EMPTY`.
- `server/src/adapters/media/index.ts` -- cờ `toSrgb`.
- `server/src/modules/content/{schema,media,posts,publishable,index}.ts` (MỚI) -- bảng, nghiệp vụ.
- `server/drizzle/0027_*.sql` -- migration sinh tự động.
- `server/src/app/media-assets.ts`, `server/src/app/posts.ts` (MỚI), `app.ts` -- route.
- `server/test/content.test.ts` (MỚI) -- ma trận phía server.
- `web/src/lib/composer.ts` + `composer.test.ts` (MỚI), `error-messages.ts` -- hook, helper, câu lỗi.
- `web/src/screens/Composer.tsx` -- nối API.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/*` -- hợp đồng + luật nền tảng -- AD-13, AD-18.
- [x] `server/src/adapters/media/index.ts` -- `toSrgb` -- AD-14 JPEG sRGB.
- [x] `server/src/modules/content/*`, migration -- bảng + `createPost` / `updateDraftPost` / `getPost` / `assertPublishable` / ghi ảnh.
- [x] `server/src/app/media-assets.ts`, `posts.ts`, `app.ts` -- route.
- [x] `server/test/content.test.ts` -- phủ các dòng server của ma trận.
- [x] `web/src/lib/composer.ts`, `composer.test.ts`, `error-messages.ts` -- hook + helper + test các dòng web.
- [x] `web/src/screens/Composer.tsx` -- giao diện nối API.

**Acceptance Criteria:**
- Given chủ shop chọn "Nhóm Gia dụng (3 trang)", when lưu nháp, then có 1 `posts` + 3 `post_targets` `draft`, mỗi target giữ caption/ảnh riêng, và mở lại `/soan-bai?bai=<id>` thấy đúng nội dung.
- Given caption Threads quá 500 ký tự hoặc trang IG chưa có ảnh, then tab trang đó báo ngay và `content.assertPublishable` trả `CAPTION_TOO_LONG` / `MEDIA_REQUIRED`.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** thêm `content.ts`, gồm:
  - `PLATFORM_RULES`, `publishIssues`, `captionLength`, `countHashtags`;
  - DTO/request bài và ảnh;
  - `PostSource` / `MediaAssetSource` trong `enums.ts`, mã lỗi `POST_EMPTY`.

  Nháp lưu caption tới `POST_CAPTION_MAX` (63.206); luật riêng từng nền tảng chỉ chặn ở `assertPublishable`.
- **Server:**
  - Module `content`: `schema.ts` → migration `0027_big_phil_sheldon.sql`; `posts.ts` (`createPost` / `updateDraftPost` / `getPost`); `publishable.ts`; `media.ts`.
  - `post_targets.position` giữ thứ tự tab.
  - Route `app/media-assets.ts`, `app/posts.ts`, đăng ký không cần `events` / `jobs`.
  - Adapter media có cờ `toSrgb` (`incomingTransformation`). `scripts/lib/media-check.ts` tải ảnh với đúng tuỳ chọn của ảnh bài, để `npm run media:check` thử `cs_srgb,fl_strip_profile` trên Cloudinary thật.
  - Ảnh tải lên dùng mã `UPLOAD_FAILED` khi kho lỗi (không dùng `IMAGE_FAILED`, mã đó dành cho sinh ảnh AI).
- **Web:**
  - `lib/composer.ts`: hook `usePost` / `useSavePost` / `useUploadPostImage` và helper thuần. Câu `POST_EMPTY` ở `error-messages.ts`.
  - `Composer.tsx`:
    - đích lấy từ `usePages` / `useGroups`; nạp state ban đầu ngay trong lúc render (bài mới theo Phạm vi, hoặc `?bai=`);
    - mỗi trang đã chọn có tab, bộ đếm `n/giới hạn`, dòng lỗi luật nền tảng và dấu đỏ trên tab;
    - "Chép sang trang còn trống"; kho ảnh của bài, gắn ảnh theo tab, "Dùng ảnh này cho mọi trang", "Bỏ ảnh khỏi trang này";
    - "Lưu nháp" thật (`POST`, rồi `PUT`, đặt `?bai=`); trang mất kết nối đã có trong nháp vẫn bỏ chọn được.
  - Viết caption bằng AI vẫn mô phỏng (Story 6.2) nhưng chạy trên trang thật. Đã bỏ ảnh picsum và khối "Kèm ảnh AI". "Tạo ảnh AI", ngày/giờ, "Lên lịch", "Đăng ngay" bị khoá kèm câu "Sắp có".
- **Kiểm tra:** `npm run check` thoát 0: depcruise sạch, server 59 file / 1227 test, web 19 file / 261 test. Chưa thử bằng trình duyệt (dev không có mật khẩu mẫu) và chưa thử `cs_srgb` với Cloudinary thật; đã ghi vào việc hoãn.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| `fl_strip_profile` chỉ bỏ ICC profile; EXIF/IPTC/XMP (cả toạ độ GPS của ảnh điện thoại) vẫn nằm trong bản gốc công khai — Cloudinary chỉ xoá metadata ở incoming transformation khi có `fl_force_strip`. Kéo theo logo hồ sơ (Story 3.1) cũng chưa sạch EXIF. Sửa: `incomingTransformation` gửi `fl_force_strip.strip_profile` + test adapter. | real (high, lộ vị trí) | patch |
| Ảnh dọc chụp điện thoại có thể nằm ngang sau khi bỏ EXIF: thêm `a_exif` đầu incoming transformation để xoay theo `Orientation` trước khi bỏ metadata (khuyến nghị của Cloudinary). | real (medium) | patch |
| Threads đếm emoji theo số byte UTF-8 (tài liệu Meta "Threads Posts" › Limitations), còn `captionLength` đếm code point: caption qua kiểm ở FE/server vẫn bị Threads từ chối (vd 498 chữ + 2 emoji = 506). Sửa: `captionLength(caption, platform)` — Threads tính code point emoji (hình, màu da, cờ, ZWJ, VS16, keycap, tag) theo byte UTF-8; `publishIssues` và bộ đếm tab truyền nền tảng; test server + web. | real (medium) | patch |
| `updateDraftPost` chỉ khoá dòng `posts`; `transitionTarget` (6.4) khoá `post_targets` → target vừa lên lịch sau lần đọc trạng thái vẫn bị ghi đè caption/ảnh hoặc bị xoá. Sửa: `SELECT … FOR UPDATE` trên các target của bài. | real (medium, lộ ra khi có 6.4) | patch |
| Story 6.2 kiểm caption AI bằng `checkOutput({maxChars})` (đếm code point) — với Threads phải dùng `captionLength(caption, 'threads')`, không thì caption AI nhiều emoji lọt giới hạn. | real (medium, việc của 6.2) | defer |

## Design Notes

- Caption nằm ở `post_targets` (luôn là giá trị hiệu lực của trang). Bài thủ công không có "caption chung". Slot chiến dịch 1:1 (Epic 7) dùng caption của target duy nhất, nên chưa thêm `posts.caption`. Epic 7 thêm `campaign_id`, `slot_at`, `held` bằng migration riêng.
- `media_assets` chưa có `status`: ảnh tải lên chỉ được ghi khi đã `ready`. Story 6.3 tự quyết cách lưu ô ảnh đang sinh / lỗi.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: sinh đúng một migration mới cho 4 bảng.
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `META_FAKE=1` + `CLOUDINARY_URL` thật: chọn nhóm → mỗi trang một tab → tải ảnh → Lưu nháp → tải lại `/soan-bai?bai=<id>` thấy đúng caption/ảnh từng trang.
