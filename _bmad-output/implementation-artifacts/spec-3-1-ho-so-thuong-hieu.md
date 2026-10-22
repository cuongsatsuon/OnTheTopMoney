---
title: 'Story 3.1 — Soạn và lưu hồ sơ thương hiệu'
type: 'feature'
created: '2026-10-22'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-media-cloudinary.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 3.1 (PM duyệt)">

## Intent

**Problem:** Chưa lưu được hồ sơ thương hiệu (giọng điệu, sản phẩm, từ cấm, logo…) cho nhóm hoặc trang để AI viết đúng chất shop. FE `BrandProfileForm.tsx` đang chạy dữ liệu mẫu; chưa có module `profiles`, bảng `brand_profiles`, lẫn upload logo.

**Approach:** Thêm module `profiles` + bảng `brand_profiles` theo `(owner_type, owner_id)` (group|page); API lưu/đọc hồ sơ với validate zod (tên bắt buộc, lỗi dưới ô); logo tải lên qua MediaStore công khai (Cloudinary — Story media) sau khi kiểm magic bytes + từ chối SVG, lưu URL vào `logo_path`; nối FE BrandProfileForm (ở Chi tiết nhóm / Chi tiết trang) vào API thật + chặn rời trang khi chưa lưu.

## Boundaries & Constraints

**Always (bám 3 AC epics.md Story 3.1):**
- Form hồ sơ: tên (bắt buộc), slogan, ngành, giọng điệu (≤3), độ trang trọng, xưng hô, emoji (bật/tắt/mức), sản phẩm chủ lực + giá, khách mục tiêu, màu thương hiệu (≤6), hashtag, từ cấm, logo, domain cho phép. Lưu `brand_profiles` theo `(owner_type, owner_id)` — một hồ sơ mỗi chủ (upsert). Validate zod; tên rỗng → lỗi dưới ô (ErrorResponse details theo field).
- Logo: nhận PNG/JPEG/WebP ≤2 MB. Kiểm **magic bytes** (khớp MIME khai báo; SVG/text bị từ chối). Lưu qua `MediaStore` công khai (adapter Cloudinary) → `logo_path` (URL/ref Cloudinary; AD-14 nói `/media/<uuidv7>` — đã đổi sang Cloudinary ở Story media, GIỮ ý định "ảnh công khai cho bài/logo", KHÔNG vào `media_assets`). EXIF bị loại (Cloudinary strip metadata mặc định — ghi chú; không cần thư viện ảnh server). Chưa cấu hình Cloudinary → `MEDIA_NOT_CONFIGURED`, phần chữ của hồ sơ vẫn lưu được (logo là tuỳ chọn).
- Rời trang khi chưa lưu (dirty) → FE hỏi lại (Interaction Primitives beforeunload + điều hướng trong app).
- Route cần phiên (AD-19), kiểm Origin ghi. owner_id phải tồn tại (group/page chưa gỡ) → nếu không 404. Giới hạn độ dài hợp lý từng ô; giọng điệu ≤3, màu ≤6 enforce ở zod.

**Never:** Không thêm thư viện xử lý ảnh server (magic bytes tự kiểm; EXIF do Cloudinary lo). Logo KHÔNG vào `media_assets` (đó là ảnh bài). Không tự suy diễn kế thừa nhóm↔trang ở đây (Story 3.2). Không gọi AI (Story 3.4). Không nhận SVG.

## I/O & Edge-Case Matrix

| Scenario | Input | Expected | Error |
|----------|-------|----------|-------|
| Lưu hồ sơ nhóm | owner=group:<id>, tên "Shop A", các field hợp lệ | upsert brand_profiles, trả hồ sơ | tên rỗng → VALIDATION_FAILED details.name |
| Lưu hồ sơ trang | owner=page:<id> | upsert theo (page, id) | owner không tồn tại/đã gỡ → 404 |
| Giọng điệu >3 / màu >6 | quá giới hạn | VALIDATION_FAILED | |
| Upload logo png hợp lệ | PNG ≤2MB | logo_path = URL Cloudinary công khai | >2MB → quá lớn; magic bytes sai → từ chối |
| Upload SVG | image/svg+xml | từ chối (không nhận SVG) | |
| Upload khi chưa cấu hình Cloudinary | PNG | MEDIA_NOT_CONFIGURED (chữ vẫn lưu được) | |
| Đọc hồ sơ chưa có | owner chưa có hồ sơ | trả rỗng/null (FE form trống) | |
| Rời trang khi dirty | điều hướng | FE xác nhận | |

</frozen-after-approval>

## Code Map (điểm xuất phát — subagent điều tra thêm)

- `server/src/modules/profiles/` (MỚI) — `schema.ts` (`brand_profiles`: id, owner_type enum(group|page), owner_id uuid, name, slogan, industry, tone text[], formality, pronoun, emoji, products jsonb, target, colors text[]≤6, hashtags text[], banned_words text[], logo_path, allowed_domains text[], timestamps; UNIQUE(owner_type, owner_id)); `service.ts` (getProfile/upsertProfile/setLogo); `index.ts`. Ranh giới AD-1: profiles gọi pages (kiểm owner tồn tại) + adapters/media.
- `server/src/adapters/media/` — dùng `MediaStore.put` (public) cho logo; kiểm magic bytes trước khi gọi (hàm nhỏ trong profiles hoặc shared: đọc chữ ký JPEG FFD8FF / PNG 89504E47 / WEBP RIFF…WEBP; khớp MIME; SVG/text → từ chối).
- `server/src/app/` — route `GET/PUT /api/v1/brand-profiles/:ownerType/:ownerId` + upload logo (chọn multipart qua @fastify/multipart HOẶC base64 trong JSON để tránh dep — ghi chú lựa chọn; ≤2MB). zod ở `packages/shared`.
- `packages/shared/src/` — BrandProfile DTO + request/response, enum ownerType/formality/pronoun/emoji; ErrorResponse details theo field (đã có mẫu ở settings/openai?).
- `web/src/components/BrandProfileForm.tsx` + `web/src/screens/{GroupDetail,PageDetail}.tsx` — nối form vào API thật (load/save), upload logo, hiển thị lỗi dưới ô, chặn rời trang khi dirty; bỏ dữ liệu mẫu cho phần này (giữ phần Epic 5 còn mock).
- Migration Drizzle (`drizzle-kit generate`) cho `brand_profiles`.
- UX: `ux-designs/` (Chi tiết nhóm › Hồ sơ thương hiệu, Chi tiết trang › Hồ sơ thương hiệu; F1 b3); DESIGN/EXPERIENCE.

## Tasks & Acceptance

**Execution:**
- [x] shared: BrandProfile schema + request/response + enums.
- [x] BE: module profiles (schema+migration, get/upsert, setLogo qua MediaStore + magic-bytes/SVG reject); route GET/PUT + logo upload; 404 owner.
- [x] FE: BrandProfileForm nối API (load/save/upload logo, lỗi dưới ô), dirty-guard rời trang; GroupDetail/PageDetail dùng form thật (qua owner id uuid).
- [x] Test: server (upsert group/page, tên rỗng → details.name, tone>3/màu>6, owner 404, logo magic-bytes ok/sai/SVG/>2MB, MEDIA_NOT_CONFIGURED với fake chưa cấu hình, đọc rỗng); web (validate dưới ô, mapping form helper, logo check, isRealOwner).

**Acceptance Criteria:** 3 AC epics.md Story 3.1 (frozen) đạt và có test.

## Verification
**Commands:** `npm run check` — xanh.

## Implementation Notes

- **Transport logo**: base64 trong JSON (`PUT …/logo` body `{mime, data}`) — KHÔNG thêm `@fastify/multipart` (giảm dep). bodyLimit mặc định Fastify là 1 MB nên route logo nâng riêng `bodyLimit ≈ 2.8 MB` (base64 của 2 MB + JSON). zod chặn `data` quá dài trước khi giải mã.
- **Magic bytes (kiểm inline, không thư viện ảnh)**: `detectImageMime` ở `modules/profiles/service.ts` đọc chữ ký JPEG `FFD8FF`, PNG `89504E470D0A1A0A`, WebP `RIFF…WEBP`. `validateLogoBytes` thứ tự: rỗng/>2 MB → `tooLarge`; không nhận dạng (SVG/text) → `notImage`; nhận dạng nhưng ≠ MIME khai báo → `mismatch`. Mọi lỗi logo trả `VALIDATION_FAILED` 400, `details:[{path:['logo'], message}]`. EXIF do Cloudinary strip mặc định (không xử lý server).
- **Chữ vẫn lưu khi chưa cấu hình Cloudinary**: text và logo là hai endpoint PUT riêng. FE lưu chữ trước; logo thất bại (`MEDIA_NOT_CONFIGURED` hay lỗi upload) chỉ `notify`, chữ đã lưu. `MEDIA_NOT_CONFIGURED` dùng status 500 theo convention repo (META/ENCRYPTION_NOT_CONFIGURED cũng 500); FE ánh xạ theo `code` nên status không ảnh hưởng microcopy. Map lỗi media khác: `INVALID_REQUEST→VALIDATION_FAILED(logo)`, `RATE_LIMITED→RATE_LIMITED 429`, còn lại→`IMAGE_FAILED 502`.
- **Routes**: `GET/PUT /api/v1/brand-profiles/:ownerType/:ownerId` (chữ) + `PUT/DELETE …/logo`. Params zod (`ownerType∈{group,page}`, `ownerId` uuid; sai→VALIDATION_FAILED). Validate body bằng `SaveBrandProfileRequest.parse` → ZodError.issues thành `details` (giống groups/openai; tên rỗng → `path:['name']`). Owner tồn tại kiểm ở service qua `pages.getGroup`/`pages.getPage` (AD-1 `profiles`→`pages`, đã nằm trong bảng mũi tên); không tồn tại/đã gỡ → 404. `setLogo`/`clearLogo` đòi hồ sơ đã tồn tại (404 nếu chưa lưu chữ).
- **DB**: bảng `brand_profiles` (`UNIQUE(owner_type, owner_id)`, check owner_type/emoji/formality), text[] cho tone/colors/hashtags/banned/allowed_domains, jsonb products, `logo_path` text (URL công khai — KHÔNG vào `media_assets`). Migration `drizzle/0012_elite_ma_gnuci.sql` (sinh bằng `drizzle-kit generate`). Upsert KHÔNG đụng `logo_path` (giữ logo khi lưu lại phần chữ). Không FK đa hình (owner kiểm ở service); xoá nhóm/gỡ trang có thể bỏ lại hồ sơ mồ côi — dọn là việc của story cascade sau.
- **Wiring**: `buildApp` nhận `media?: MediaStores` (thiếu → `createMediaStores` chưa cấu hình, logo trả `MEDIA_NOT_CONFIGURED`); `deps.mediaStoresFromConfig` + `main.ts` dựng từ `CLOUDINARY_URL`. Profiles route không cần `events`.
- **FE**: `web/src/lib/profiles.ts` (helper thuần + hook React Query). `BrandProfileForm` nối API thật khi owner id là **uuid** (`isRealOwner`) — nhóm/trang thật (đã mirror vào kho mẫu) dùng server; id kho mẫu (g-beauty, p1…) giữ mock trong phiên (bảo toàn UX demo + các epic khác còn mock). Lỗi tên hiện dưới ô (từ `brandNameError` trước khi gửi và từ `fieldErrorsOf` khi server trả `details.name`). Logo: kiểm nhanh loại/kích thước phía web (`logoFileError`), tải khi bấm Lưu (chữ trước, logo sau). Dirty-guard `beforeunload` (giống AutoReply); điều hướng trong app chưa chặn (chưa dùng data-router `useBlocker`).
- **Lệch spec có chủ ý**: form hiện chưa có ô "domain cho phép" (AC liệt kê) — mô hình/DB/validate đã hỗ trợ `allowedDomains`, FE gửi `[]` để GIỮ UX form hiện có (yêu cầu "preserve the existing BrandProfileForm UX"). Thừa kế nhóm↔trang vẫn là UX mock (Story 3.2, spec dặn không suy diễn ở đây).
- **Kiểm**: `npm run check` exit 0 — server 687 test (31 file, +`brand-profiles.test.ts` ~19 ca phủ trọn ma trận), web 134 test (+`profiles.test.ts`), typecheck/lint/depcruise sạch.
- **Rủi ro/chưa xác minh**: logo thật trên Cloudinary (chủ shop chạy `media:check`); FE chạy thật cần owner uuid (nhóm tạo thật / trang kết nối thật) — màn demo seed id không-uuid vẫn mock; logo cũ không bị xoá khi thay/gỡ (orphan trên Cloudinary — gộp #10 defer của spec media).

## Spec Change Log

## Review Triage Log

### Lượt 1 (blind / edge / verification-gap) — triage
| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Upload logo tới owner chưa có hồ sơ: media.put thành công rồi setLogo 404 → asset Cloudinary mồ côi/tốn tiền | medium | patch (kiểm hồ sơ tồn tại/tạo trước khi upload) |
| Save: logo upload lỗi vẫn hiện toast thành công (kèm toast lỗi) | medium | patch (track logoFailed, không báo thành công) |
| allowedDomains trong AC + model nhưng FE không có ô, gửi [] | medium | patch (thêm ô domain cho phép) |
| EXIF dựa vào "Cloudinary strip mặc định" — không chắc, có thể lộ GPS | medium | patch (strip metadata tường minh khi upload/deliver) |
| loadedRef chốt, đổi owner trên cùng instance giữ dữ liệu owner cũ | medium | patch (reseed khi owner đổi / key theo owner) |
| URL.createObjectURL không revoke | low | patch (revoke khi thay/unmount) |
| beforeunload chỉ preventDefault, thiếu returnValue | low | patch |
| Server ghi product rỗng (client lọc, server không) | low | patch (lọc/validate đối xứng; toDto parse products zod) |
| Thiếu test: upsert giữ logo; mapping media failNext 429/400/5xx; write-path 401+Origin; DELETE /logo no-profile 404; màu sai; 413 body | medium | patch |
| Guard điều hướng TRONG APP (AC "điều hướng trong app") | medium | defer (cả app dùng beforeunload như AutoReply; useBlocker cần data router — follow-up toàn app) |
| Thay/xoá logo để lại asset Cloudinary cũ | low | defer (media spec #10) |
| Không có authz tenant | false | reject (app một chủ) |
| error.details NOT_FOUND object vs VALIDATION_FAILED array | low | reject (khác ngữ nghĩa, fieldErrorsOf đã chắn) |
| buildApp fallback folder 'ottm' cứng | low | reject (fallback là store chưa-cấu-hình) |
