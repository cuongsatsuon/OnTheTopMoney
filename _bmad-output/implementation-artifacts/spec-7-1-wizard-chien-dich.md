---
title: 'Story 7.1 — Wizard tạo chiến dịch: mục tiêu, trang đích, nội dung và lịch'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '203b8048f436ab098e1dc775cc13cb61665c9d14'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 7.1, AD-15, AD-1, AD-18; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Wizard `/chien-dich/tao` chạy hoàn toàn trên dữ liệu mẫu. Server chưa có module `campaigns`, nên cấu hình chiến dịch chưa lưu được. Chưa có chỗ nào kiểm phía server luật "tổng tỉ lệ chủ đề = 100%" và luật "trang mất kết nối / chưa có hồ sơ thì không làm đích được".

**Approach:**
- Dựng module `campaigns` (bảng `campaigns`, `campaign_topics`, `campaign_pages`).
- API lưu / đọc chiến dịch `draft` cùng chủ đề và cấu hình trang đích, có kiểm hợp lệ phía server, và API cho biết trang nào chọn được.
- Bước 1–3 của wizard dùng trang/nhóm thật. Sang bước 4 thì lưu nháp; lỗi validate báo ngay dưới ô.
- Bước 4 (xem trước 7 bài) và "Bắt đầu" khoá kèm "Sắp có" (Story 7.2 / 7.3).

## Boundaries & Constraints

**Always:**
- **Shared:**
  - `enums.ts` thêm `CAMPAIGN_GOALS` = `engage|follow|sell|launch` và `CAMPAIGN_FREQUENCIES` = `3_per_week|1_per_day|2_per_day|3_per_day`.
  - `campaigns.ts` (mới) chứa `SaveCampaignRequest`:
    - `name` 1–120 ký tự, đã trim; `goal`; `startDate` dạng `YYYY-MM-DD`; `durationDays` ∈ {7, 14, 30}.
    - `groupId` uuid hoặc null (chỉ là nhãn); `defaultFrequency`; `imageRatio` số nguyên 0–100; `mode` mặc định `review`.
    - `postTimes`: 1–6 giờ `HH:MM` (giờ VN), không trùng.
    - `topics`: 1–10 mục `{name 1–60 ký tự, share số nguyên 1–100}`, tên không trùng (không phân biệt hoa thường).
    - `pages`: 1–50 mục `{pageId, frequency | null}` (null = theo mặc định), trang không trùng.
    - Tổng `share` ≠ 100 → issue `path ['topics']`, message "Tổng tỉ lệ chủ đề phải đúng 100% (hiện N%)".
  - `CampaignDto` = cấu hình trên + `id, status, createdAt, updatedAt`; `topics` và `pages` giữ đúng thứ tự gửi lên.
  - `CampaignPageOptionsResponse {items: [{pageId, selectable, reason: 'PAGE_DISCONNECTED' | 'CONFIG_MISSING' | null}]}`.
  - Helper thuần (FE tóm tắt; 7.2 / 7.3 dùng lại khi tạo slot):
    - `campaignPostsOnDay(freq, dayIndex, timesCount)`: `3_per_week` → 1 bài vào ngày `dayIndex % 7 ∈ {0, 2, 4}`; `n_per_day` → n bài; luôn chặn trên bởi `timesCount`.
    - `campaignImageRatio(platform, ratio)`: Instagram luôn 100, nền tảng khác giữ `ratio`.
- **Module `campaigns` (AD-1):**
  - Chỉ gọi `pages` và `profiles` (`resolveEffectiveOrNull(…, 'brand')`).
  - `pages` export thêm `groupsTable` (chỉ để khai FK `campaigns.group_id → groups on delete set null`).
  - FK `campaign_pages.page_id → pages`: on delete cascade. FK từ `campaign_topics` / `campaign_pages` tới `campaigns`: on delete cascade.
  - Cột có check constraint sinh từ mảng shared.
- **Trang chọn được:**
  - Trang chưa gỡ, không `disconnected` (trang `expiring` vẫn được), và có hồ sơ thương hiệu hiệu lực.
  - Lý do theo thứ tự: `PAGE_DISCONNECTED` trước `CONFIG_MISSING`.
  - Cùng một hàm dùng cho cả API "trang chọn được" lẫn kiểm khi lưu.
- **Lưu (`POST /campaigns` → 201, `PUT /campaigns/:id`):**
  - Kiểm sau zod, gom mọi lỗi thành `VALIDATION_FAILED` 400, mỗi lỗi có `{path, message, code?}`:
    - trang lạ / đã gỡ;
    - trang không chọn được → `code`;
    - `groupId` không tồn tại → `['groupId']`;
    - trang không thuộc nhóm `groupId`;
    - `startDate` trước hôm nay (giờ VN) hoặc xa hơn 365 ngày → `['startDate']`.
  - `PUT` khoá dòng chiến dịch, thay toàn bộ chủ đề và trang. Chiến dịch không ở `draft` → 409 `VERSION_CONFLICT`. Không có → 404.
- **Web:**
  - `lib/campaigns.ts` chứa helper thuần + hook:
    - nhãn mục tiêu / tần suất; chủ đề gợi ý theo mục tiêu;
    - dựng body, nạp lại form từ `CampaignDto`;
    - lỗi → `{step, field, message}`;
    - tổng bài theo ngày.
  - Wizard dùng `usePages` / `useGroups` / page-options.
  - Trang không chọn được hiện mờ kèm lý do ("Mất kết nối — kết nối lại để chọn" / "Chưa có hồ sơ thương hiệu"). Ở chế độ nhóm, các trang này tự bị loại.
  - Kiểm sớm bằng chính `SaveCampaignRequest` của shared. Sang bước 4 thì `POST`, hoặc `PUT` khi đã có `?id=`, rồi ghi `?id=<id>` vào URL (thay thế, không thêm lịch sử). Mở `?id=` thì nạp lại nháp.
  - Lỗi từ server → về đúng bước, báo dưới ô.
  - Có trang IG trong đích → dưới thanh tỉ lệ hiện ghi chú "Instagram luôn cần ảnh".
  - Ngày bắt đầu mặc định = ngày mai theo giờ VN. Đích ban đầu lấy theo Phạm vi.
  - Bỏ toàn bộ nội dung / ảnh mẫu (picsum, `CONTENT_POOL`), bỏ chi phí ước tính giả.
  - Sửa cảnh báo React Compiler ở `useMemo`.

**Never:**
- Không tạo slot / `posts`, không job `campaigns.*`, không gọi AI, không đổi `content` (thuộc 7.2+).
- Không `running|paused|done`, không danh sách chiến dịch trên `/chien-dich` (màn này giữ dữ liệu mẫu tới 7.3), không xoá nháp.
- Không thêm `ErrorCode`, không sự kiện mới.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lưu nháp | "Tăng tương tác" · 30 ngày; nhóm có 2 trang (1 trang đặt riêng `2_per_day`); chủ đề 40/30/20/10; giờ 11:30, 19:30; ảnh 70; không gửi `mode` | 201 `status draft`, `mode review`; topics / pages đúng thứ tự, `frequency` null / `2_per_day`; `groupId` được lưu | |
| Mở lại, sửa | `GET /:id`; `PUT` đổi chủ đề, bỏ 1 trang | GET trả như lúc lưu; PUT thay toàn bộ, không còn dòng cũ | id lạ 404; không `draft` 409 |
| Tỉ lệ ≠ 100 | chủ đề 40/30/20 | 400 `VALIDATION_FAILED`, issue `path ['topics']` "…(hiện 90%)"; FE: bước 3, dưới ô chủ đề | |
| Dữ liệu sai | tên chủ đề trùng; share 0; giờ trùng / `25:00`; thiếu giờ; `durationDays` 10; trang trùng; ngày bắt đầu hôm qua (giờ VN) | 400, mỗi lỗi một `path`; FE quy về đúng bước / ô | |
| Trang không chọn được | trang `disconnected`; trang chưa có hồ sơ; trang `expiring` có hồ sơ | page-options: lý do `PAGE_DISCONNECTED` / `CONFIG_MISSING` / chọn được; lưu với 2 trang đầu → 400 `path ['pages', i, 'pageId']` + `code`; FE không cho chọn, hiện lý do | |
| Nhóm nhãn | `groupId` lạ; trang không thuộc nhóm; trang đã gỡ | 400 với path tương ứng | |
| IG và ảnh | đích có trang IG, ảnh 30% | FE hiện ghi chú "Instagram luôn cần ảnh"; `campaignImageRatio('instagram', 30) = 100`, `('facebook', 30) = 30` | |
| Tổng số bài | 30 ngày, `3_per_week` + `2_per_day` với 1 khung giờ | ngày 0: 1 + 1 bài; ngày 1: 0 + 1; tổng = 13 + 30 | |
| Chưa đăng nhập | | 401 | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/{enums,campaigns,index}.ts` -- enum mục tiêu / tần suất; hợp đồng + helper.
- `server/src/modules/campaigns/{schema,drafts,pages,index}.ts` (MỚI) -- bảng; lưu / đọc nháp; trang chọn được. Mẫu gom lỗi: `content/posts.ts` `assertTargetsValid`. Giờ VN: `webhooks/health.ts` (UTC+7 cố định).
- `server/src/modules/pages/index.ts` -- export `groupsTable`. `getGroup` / `getPage` có sẵn.
- `server/src/modules/profiles/index.ts` -- `resolveEffectiveOrNull` (chỉ đọc).
- `server/drizzle/0031_regular_makkari.sql` -- sinh bằng `npm run db:generate -w server`.
- `server/src/app/{campaigns,app}.ts` -- route `/api/v1/campaigns` (mẫu: `app/posts.ts`), đăng ký trong `buildApp` với `clock`.
- `server/test/campaigns.test.ts` (MỚI) -- ma trận server. Mẫu setup: `test/content-calendar.test.ts`.
- `web/src/lib/campaigns.ts` + `campaigns.test.ts` (MỚI) -- helper + hook. `todayKey` (`lib/calendar.ts`); mẫu lỗi theo ô: `lib/autoreply.ts`.
- `web/src/screens/CampaignWizard.tsx` -- viết lại phần dữ liệu, giữ bố cục / thành phần UI.
- `deferred-work.md` -- thêm: ước tính chi phí AI thật cho wizard; kiểm bằng trình duyệt.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/{enums,campaigns,index}.ts` -- enum, schema, DTO, helper -- AD-15, AD-18.
- [x] `server/src/modules/campaigns/*`, `pages/index.ts`, migration -- bảng + nghiệp vụ nháp + trang chọn được -- AD-1, AD-15.
- [x] `server/src/app/campaigns.ts`, `app.ts` -- 4 route.
- [x] `server/test/campaigns.test.ts` -- phủ các dòng server của ma trận.
- [x] `web/src/lib/campaigns.ts` + test -- phủ các dòng web của ma trận (lỗi → bước/ô, IG, tổng bài, body / nạp lại).
- [x] `web/src/screens/CampaignWizard.tsx` -- nối API, bước 4 "Sắp có", sửa cảnh báo lint.
- [x] `deferred-work.md` -- mục hoãn.

**Acceptance Criteria:**
- Given chủ shop chọn nhóm có trang mất kết nối, when xem bước 2, then trang đó mờ kèm lý do và không tính vào tổng bài.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:**
  - `enums.ts`: thêm `CAMPAIGN_GOALS`, `CAMPAIGN_FREQUENCIES`.
  - `campaigns.ts` (mới): `SaveCampaignRequest`, `CampaignDto`, `CampaignPageOption(s)`, `CAMPAIGN_*` (giới hạn [ASSUMPTION]), `campaignPostsOnDay`, `campaignImageRatio`.
- **Server:**
  - Module `campaigns` (mới): `schema.ts`, `drafts.ts` (create / update / get, gom lỗi theo ô, ngày VN cố định UTC+7), `pages.ts` (`pageBlockReason`, `listPageOptions`), `index.ts`.
  - `pages/index.ts` export thêm `groupsTable`.
  - Migration `0031_regular_makkari.sql`: 3 bảng + check + FK (`group_id` set null, trang / chiến dịch cascade).
  - `app/campaigns.ts`: 4 route, đăng ký trong `buildApp` với `clock`.
- **Web:**
  - `lib/campaigns.ts` (mới): form, đích (nhóm tự loại trang không chọn được), body / nạp lại, tóm tắt (tổng bài, lịch nhiệt, bài có ảnh), lỗi → bước + ô, hook.
  - `lib/realtime.ts`: `page.*` làm cũ `['campaigns', …]`.
  - `CampaignWizard.tsx` viết lại trên API:
    - đích ban đầu theo Phạm vi, bắt đầu ngày mai giờ VN; skeleton khi tải;
    - "Lưu và tiếp tục" ở bước 3 → `?id=`; bước 4 và "Bắt đầu chiến dịch" khoá "Sắp có";
    - bỏ nội dung / ảnh mẫu và chi phí giả, thay bằng "Bài có ảnh AI";
    - hết cảnh báo React Compiler (bỏ `useMemo`).
  - `Campaigns.tsx` không đổi (danh sách thuộc 7.3).
- **Việc hoãn:** thêm 4 mục: kiểm bằng trình duyệt, ước tính chi phí AI thật, danh sách / xoá nháp, page-options không tự cập nhật khi đổi hồ sơ.
- **Kiểm tra:** `npm run check` thoát 0.
  - depcruise sạch.
  - server 64 file / 1331 test (22 mới ở `campaigns.test.ts`).
  - web 22 file / 307 test (14 mới ở `campaigns.test.ts`).
  - Chưa thử bằng trình duyệt.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Lưu nháp MỚI ở bước 3: router v7 đổi `?id=` trong transition (ưu tiên thấp), còn `setLoadedKey(id)` / `show(4)` ưu tiên thường → một lần render `campaignId` còn `null` mà `loadedKey` đã là id mới → form nạp lại thành chiến dịch mới (mất dữ liệu đã nhập), rồi nạp lại từ DTO và về bước 1 thay vì bước 4. Sửa: state `createdId` — chờ URL có đúng id mới rồi mới xét nạp lại (`CampaignWizard.tsx`). | đúng, trung bình | patch |
| Nháp đã mở (`?id=`) mà một lần tải lại `GET /campaigns/:id` lỗi (focus cửa sổ, sự kiện `page.*` làm cũ `['campaigns', …]`, `retry: false`) → effect báo lỗi + xoá `?id=` → form về chiến dịch mới, mất dữ liệu đang sửa. Sửa: chỉ coi là "không mở được" khi chưa có dữ liệu. | đúng, trung bình | patch |
| Hai tab cùng sửa một nháp → `PUT` sau đè im lặng (không so `updatedAt`). | đúng, thấp–trung bình | defer |

## Design Notes

- **Đích nháp lưu ở `campaign_pages`** (trang + tần suất đặt riêng, null = theo mặc định). 7.3 chụp lại khi "Bắt đầu" (kiểm lại trang còn chọn được, chốt tần suất hiệu lực), nên không cần bảng thứ tư.
- **Lỗi trang không chọn được dùng `VALIDATION_FAILED` + `code` trong từng issue**, cùng kiểu gom lỗi theo dòng của `posts`, để FE trỏ đúng trang. Không thêm mã mới.
- **Bước 4 khoá "Sắp có"**: theo tiền lệ Story 6.1 (nút của story sau bị khoá kèm "Sắp có"), không mô phỏng 7 bài giả.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: đúng một migration mới (3 bảng `campaign*`).
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `/chien-dich/tao`: đi qua 3 bước với trang thật; tổng tỉ lệ 90% → báo dưới ô; sang bước 4 → URL có `?id=`; tải lại thì nạp đúng nháp.
