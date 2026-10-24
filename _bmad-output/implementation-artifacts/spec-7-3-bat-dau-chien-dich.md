---
title: 'Story 7.3 — Bắt đầu chiến dịch'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '10747b2e6b3b7b7174f1d06e0e1bbbe6587afa31'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 7.3, AD-15, AD-13, AD-18, UX-DR10; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Nút "Bắt đầu chiến dịch" ở bước 4 còn khoá "Sắp có": chiến dịch nháp có 7 bài xem trước (`held`, chưa có giờ trên Lịch) nhưng không chuyển được sang `running`, phần slot còn lại chưa được tạo. `/chien-dich` và thẻ "Chiến dịch đang chạy" ở Tổng quan vẫn chạy dữ liệu mẫu (không có danh sách / tiến độ thật).

**Approach:**
- `POST /campaigns/:id/start`: MỘT transaction, khoá dòng chiến dịch. Kiểm lại cấu hình như lúc lưu (trang gỡ / mất kết nối / thiếu hồ sơ, nhóm, ngày bắt đầu). Chụp `campaign_pages` (chốt tần suất hiệu lực). Gọi `content.startCampaignSlots`: tạo idempotent slot còn lại `planned` lên Lịch, bỏ `held` + đặt giờ cho 7 bài xem trước; "Tự đăng" thì duyệt luôn bài xem trước đã viết xong. Rồi → `running` + sự kiện `campaign.started`.
- Read-model `app/read-models/campaigns.ts` ghép chiến dịch (`campaigns`) với tiến độ slot (`content`) → `GET /campaigns?scope=` cho `/chien-dich` và Tổng quan.
- Lịch hiện slot `planned` với chủ đề và nhãn "AI tạo".

## Boundaries & Constraints

**Always:**
- **Shared:**
  - `CAMPAIGN_SLOT_MIN_LEAD_MS = 2 phút`: bài chiến dịch phải còn ít nhất chừng này tới giờ đăng mới lên lịch được (bắt đầu, duyệt).
  - `StartCampaignRequest {baseUpdatedAt?}` (strict) → 200 `StartCampaignResponse {campaign: CampaignSummaryDto, alreadyStarted}`.
  - `CampaignSummaryDto` = `CampaignDto` + `startedAt`, `postsTotal`, `postsDone`, `postsPending`, `nextPost` (ISO | null), `trend` (7 số), `daysDone`. `CampaignListQuery {scope?}`, `CampaignListResponse {items}`.
  - `CampaignDto.startedAt` (null khi nháp). `CalendarItemDto.topic` (chủ đề của bài). Sự kiện `campaign.started {}` (realtime).
- **Content:**
  - `transitionTarget` thêm hành động nội bộ `approve {at}`: `pending_approval → scheduled`, cùng đường tới `scheduled` (luật nền tảng, giới hạn/24h, enqueue `publish.target`). `at ≤ now + CAMPAIGN_SLOT_MIN_LEAD_MS` → 422 `SCHEDULE_IN_PAST`.
  - `unschedule` trên slot chiến dịch → 409 (slot không được thành bài nháp).
  - `startCampaignSlots(tx, deps, campaignId, plan, {autoPublish})`, trong transaction của bên gọi:
    1. Khoá mọi slot của chiến dịch theo id.
    2. Tạo slot thiếu của kế hoạch có `slotAt > now + lead`: `planned`, không `held`, `scheduled_at = slot_at`. Slot giờ đã qua không tạo.
    3. Mọi slot của chiến dịch bỏ `held`. Slot `planned|pending_approval` chưa có giờ → `scheduled_at = slot_at`, `version + 1`.
    4. `autoPublish`: slot `pending_approval` không mã lỗi → `approve` tại `slot_at` trong savepoint; khoá advisory giới hạn/24h lấy trước theo `pageId` tăng dần. 422 (giờ đã qua, luật nền tảng, giới hạn) → giữ `pending_approval` kèm mã đó (về "Chờ duyệt", không làm hỏng cả lần bắt đầu).
  - `campaignProgress(db, ids, now)`: `postsTotal` (slot chưa huỷ), `postsDone` (`published`), `postsPending` (`pending_approval` không `held`), `nextPost` (giờ sớm nhất > now của slot `planned|pending_approval|scheduled` không `held`), `trend` (số bài `published` mỗi ngày VN, 7 ngày tới hôm nay).
  - Lịch: `topic` = `posts.topic`.
- **Campaigns:**
  - Cột `campaigns.started_at`; check `(status = 'draft') = (started_at is null)`.
  - `startCampaign(tx, deps, id, input, now)`:
    - Không có → 404.
    - Đã rời `draft` → `alreadyStarted: true`, không đổi gì (bấm hai lần / hai tab).
    - `baseUpdatedAt` lệch → 409 `VERSION_CONFLICT`.
    - Kiểm lại bằng chính hàm kiểm khi lưu → 400 `VALIDATION_FAILED`, `path` như khi lưu (`pages[i].pageId` + `code`, `startDate`, `groupId`).
    - `campaign_pages.frequency` ← tần suất hiệu lực. Kế hoạch đầy đủ `campaignSlots` (không giới hạn). Gọi `startCampaignSlots`.
    - `status = running`, `started_at = now`, phát `campaign.started`.
  - Job `campaigns.preview` đọc slot cần sinh trong cùng transaction `FOR SHARE` (đóng việc hoãn race).
  - `listCampaigns(db, pageIds | null)`: chiến dịch có `campaign_pages` giao phạm vi, `created_at` giảm dần.
- **Read-model + route:**
  - `campaignSummaries`: nháp → `postsTotal` = độ dài kế hoạch (trang chưa gỡ), `postsPending`/`nextPost` rỗng, `daysDone` 0. Đã bắt đầu → số từ `campaignProgress`, `daysDone = clamp(hôm nay VN − startDate, 0, durationDays)` (`done` → `durationDays`).
  - `GET /campaigns?scope=` giải bằng `pages.resolveScope` (nhóm/trang lạ 404, sai cú pháp 400). `POST /campaigns/:id/start` cần `jobs` + `events`.
- **Web:**
  - Wizard bước 4: "Bắt đầu chiến dịch" bật (khoá khi đang lưu / đang bắt đầu), gửi `baseUpdatedAt`.
    - Xong → làm cũ `campaigns` + `post_targets`, toast "Đã bắt đầu “<tên>” — N bài trên Lịch nội dung", chuyển `/lich`.
    - `VALIDATION_FAILED` → về đúng bước, báo dưới ô. 409 → câu "Nháp đã đổi ở tab khác".
  - `/chien-dich` dùng danh sách thật theo Phạm vi:
    - Tab trạng thái, KPI (số chiến dịch, bài AI đã đăng, bài chờ duyệt).
    - Thẻ: mục tiêu, chế độ, trang, nhóm nhãn, `daysDone/durationDays ngày · postsDone/postsTotal bài`, "Bài tiếp theo", biểu đồ "Bài đã đăng 7 ngày".
    - Nháp → "Tiếp tục thiết lập" (`?id=`). Tạm dừng / Xoá khoá "Sắp có" (7.5). Hàng đợi "Bài chờ duyệt" khoá "Sắp có" (7.4).
  - Tổng quan "Chiến dịch đang chạy": chiến dịch `running|paused` thật, thanh `postsDone/postsTotal`.
  - Lịch: ô `planned` không caption có tiêu đề "AI sẽ viết · <chủ đề>". Nhóm slot chiến dịch không có "Bỏ lịch" / "Mở ở Soạn bài". Chạy nhiều request mà lỗi giữa chừng → báo "Đã xong k/n bài — <lỗi>" (việc hoãn 6.5).
  - SSE `campaign.*` làm cũ `['campaigns', …]` + Lịch `['post_targets', …]`.

**Never:**
- Không gọi Meta / OpenAI trong request hay trong transaction bắt đầu. Không sinh lại 7 bài xem trước, không nhân đôi slot.
- Không đăng bài chưa duyệt ở chế độ "Duyệt trước khi đăng". Không đăng bài xem trước có mã lỗi ở chế độ "Tự đăng".
- Không cron sinh cuốn chiếu / hàng đợi duyệt (7.4). Không tạm dừng / tiếp tục / xoá (7.5). Không tự tạm dừng (7.6).
- Không sửa cấu hình chiến dịch đang chạy. Không tính "tương tác" cho `trend` (chỉ số bài đăng — Epic 8 có `post_metrics`).
- `content` không import `campaigns`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Bắt đầu (duyệt) | nháp 30 ngày, FB `1_per_day` 11:30; 7 bài xem trước `pending_approval held` (1 bài đã xoá) | 200 `alreadyStarted false`; `running`, `started_at`; 30 slot (23 mới `planned`, `scheduled_at = slot_at`); 7 bài cũ giữ id / caption, bỏ `held`, có giờ; bài đã xoá vẫn `cancelled`; không job `publish.target`; `campaign_pages.frequency` chốt; 1 `campaign.started`; `postsTotal` 29, `postsDone` 0 | |
| Bắt đầu (tự đăng) | như trên, `mode auto`; 1 bài xem trước `AI_POLICY_BLOCKED`; 1 bài IG mất ảnh (`MEDIA_REQUIRED`) | bài không lỗi → `scheduled` + job `publish.target startAfter=slot_at`; bài có mã giữ `pending_approval`; bài IG → `pending_approval MEDIA_REQUIRED`; slot mới vẫn `planned` | lỗi 422 từng bài không làm hỏng lần bắt đầu |
| Bài xem trước đã qua giờ | bắt đầu ngày đầu, sau giờ bài đầu | bài đó có giờ cũ, giữ `pending_approval` (tự đăng: + `SCHEDULE_IN_PAST`); slot kế hoạch đã qua giờ mà chưa có thì không tạo | |
| Bấm hai lần | `start` lần 2 / song song | lần sau 200 `alreadyStarted true`, không slot / job / sự kiện mới | khoá dòng chiến dịch |
| Trang không dùng được | 1 trang đích `disconnected` / chưa có hồ sơ / đã gỡ / rời nhóm nhãn; ngày bắt đầu đã qua | 400 `VALIDATION_FAILED` `pages[i].pageId` (+ `code`) / `startDate`; không đổi gì; FE về bước 2 / 1 | tất cả hoặc không |
| Hai tab | `baseUpdatedAt` cũ | 409 `VERSION_CONFLICT`, không đổi gì | |
| Chiến dịch lạ / chưa đăng nhập | | 404 / 401 | |
| Job đăng sau bắt đầu | bài `scheduled` tới giờ | đăng bình thường (không còn `held`) | |
| Duyệt nội bộ | `approve` khi giờ còn < 2 phút / đã qua | 422 `SCHEDULE_IN_PAST` | |
| Bỏ lịch slot | `unschedule` slot chiến dịch `scheduled` | 409, không đổi | |
| Danh sách | 2 chiến dịch (nháp + đang chạy) ở 2 trang; `scope=page:<A>`; `scope` sai / lạ | đúng chiến dịch giao phạm vi; nháp `postsTotal` theo kế hoạch; đang chạy: `postsDone`, `postsPending`, `nextPost`, `trend` 7 ngày, `daysDone` | 400 / 404 |
| Lịch sau bắt đầu | `GET /calendar` tuần đầu | slot `planned` có `ai true`, `campaignId`, `topic`, `title null` | |
| Preview race | lưu nháp chen giữa lượt job | lượt cũ không sinh slot theo kế hoạch cũ | |
| Web | bắt đầu ok / 400 trang / 409; thẻ nháp / đang chạy; ô `planned`; nhóm slot chạy lỗi giữa chừng | toast + `/lich` / bước 2 + câu dưới trang / câu hai tab; "0/30 bài", "Bài tiếp theo"; "AI sẽ viết · Mẹo hay"; "Đã xong 1/3 bài — …" | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/{campaigns,content,events}.ts` -- hợp đồng bắt đầu, tóm tắt / danh sách, lead 2 phút, `topic` lịch, `campaign.started`.
- `server/src/modules/content/{transitions,slots,calendar,index}.ts` -- `approve`, chặn `unschedule` slot, `startCampaignSlots`, `campaignProgress`, `topic`.
- `server/src/modules/campaigns/{schema,drafts,start,preview,index}.ts` + migration -- `started_at`, kiểm lại, chụp trang, bắt đầu, danh sách, sửa race.
- `server/src/app/{campaigns.ts,read-models/campaigns.ts}` -- route start + list, read-model.
- `server/test/campaigns-start.test.ts` (MỚI) -- ma trận server.
- `web/src/lib/{campaigns,calendar,realtime}.ts` + test; `web/src/screens/{CampaignWizard,Campaigns,Dashboard,ContentCalendar}.tsx` -- nút bắt đầu, danh sách thật, thẻ Tổng quan, lịch.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/*` -- hợp đồng mới -- AD-15, AD-18.
- [x] `server/src/modules/content/*` -- `approve`, `startCampaignSlots`, `campaignProgress`, `topic`, chặn `unschedule` -- AD-13, AD-15.
- [x] `server/src/modules/campaigns/*` + migration -- `started_at`, `startCampaign`, `listCampaigns`, race preview -- AD-15, AD-1.
- [x] `server/src/app/*` -- read-model + 2 route -- AD-18.
- [x] `server/test/campaigns-start.test.ts` -- phủ các dòng server của ma trận.
- [x] `web/src/lib/*` + test, `screens/*` -- nút bắt đầu, `/chien-dich`, Tổng quan, Lịch, SSE.
- [x] `deferred-work.md` -- đóng / cập nhật mục liên quan, thêm mục mới.

**Acceptance Criteria:**
- Given nháp có 7 bài xem trước, when bấm "Bắt đầu chiến dịch", then Lịch nội dung hiện đủ slot của chiến dịch với nhãn "AI tạo", và `/chien-dich`, Tổng quan hiện thẻ tiến độ "0/N bài".
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `campaigns.ts` thêm `CAMPAIGN_SLOT_MIN_LEAD_MS`, `CAMPAIGN_TREND_DAYS`, `StartCampaignRequest/Response`, `CampaignSummaryDto`, `CampaignListQuery/Response`, `CampaignDto.startedAt`. `content.ts`: `CalendarItemDto.topic`. `events.ts`: `campaign.started`.
- **Content:**
  - `transitions.ts`: hành động nội bộ `approve` (lead 2 phút), `lockDailyLimits` (export, dùng chung với `transitionPostTargets`), `unschedule` slot chiến dịch → 409.
  - `slots-start.ts` (mới): `startCampaignSlots` — khoá slot theo id, tạo slot tương lai `planned` trên Lịch, bỏ `held` + đặt giờ bài xem trước, "Tự đăng" duyệt trong savepoint (422 → `pending_approval` kèm mã).
  - `slots-progress.ts` (mới): `campaignProgress`. `calendar.ts`: `topic`.
- **Campaigns:**
  - Migration `0033_aspiring_pete_wisdom.sql`: `campaigns.started_at` + check `(status = 'draft') = (started_at is null)`.
  - `start.ts` (mới): `startCampaign` (khoá → `alreadyStarted` / 409 / `assertDraftValid` → chụp tần suất → kế hoạch đầy đủ → slot → `running` + sự kiện), `listCampaigns`.
  - `preview.ts`: `campaignPlan` (kế hoạch có `limit`), `toSlotPlan` export; job đọc `todo` + trang còn dùng trong cùng transaction `FOR SHARE`, bỏ qua slot của trang còn dùng mà không có trong kế hoạch (slot trang đã gỡ vẫn chốt `PAGE_REMOVED`). `drafts.ts`: export `assertDraftValid`, `startedAt`.
- **App:** `read-models/campaigns.ts` (`campaignSummaries`, `campaignDaysDone`); route `GET /campaigns?scope=`, `POST /campaigns/:id/start` (cần `jobs` + `events`).
- **Web:**
  - `lib/campaigns.ts`: `useCampaigns`, `useStartCampaign`, `startedToast`, `campaignPct`, `nextPostLabel` / `relativeVnTime`, `trendTotal`, `campaignCounts`, `activeCampaigns`, `CAMPAIGN_STATUS_TEXT`.
  - `lib/calendar.ts`: `groupTitle` cho `planned` ("AI sẽ viết · <chủ đề>"), `isCampaignGroup`, `partialRunMessage`. `lib/realtime.ts`: `campaign` → `post_target`.
  - `CampaignWizard.tsx`: nút bắt đầu thật + câu giải thích theo chế độ. `Campaigns.tsx` viết lại trên API (bỏ dữ liệu mẫu). `Dashboard.tsx`: thẻ "Chiến dịch đang chạy" thật. `ContentCalendar.tsx`: ẩn "Bỏ lịch" / "Mở ở Soạn bài" cho slot chiến dịch, báo "Đã xong k/n bài".
- **Test:** `server/test/campaigns-start.test.ts` (11 test, mới); `campaigns.test.ts` / `campaigns-preview.test.ts` đặt `started_at` khi giả `running`. Web: `campaigns.test.ts` (+4), `calendar.test.ts` (+3).
- **Kiểm tra:** `npm run check` thoát 0 — depcruise sạch (198 module); server 66 file / 1361 test; web 22 file / 317 test. Chưa thử bằng trình duyệt.
- **Việc hoãn:** đóng "kéo ô gom nhiều bài" (báo n/m) và "race `runPreview`"; thu hẹp "danh sách / xoá nháp" còn xoá (7.5); cập nhật "lịch tab khác", "slot kẹt"; thêm: kiểm trình duyệt 7.3, `trend` = bài đã đăng, lý do tạm dừng / `Group.activeCampaigns`, "Tự đăng" với bài đang viết lúc bắt đầu.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Wizard: lỗi `VALIDATION_FAILED` của "Bắt đầu" (`pages[i]`) map theo `body` dựng từ `activePages` — trang vừa mất kết nối / gỡ sau lúc lưu đã bị bỏ khỏi form nên chỉ số lệch, câu lỗi rơi vào trang khác (hoặc mất). Sửa: `startCampaignErrors` map theo danh sách trang đã lưu (`campaignQuery.data.pages`) + test. | real (medium) | patch |

## Design Notes

- **Bài xem trước đã qua giờ không bị huỷ:** giữ `pending_approval` (đã tốn tiền AI, chủ shop đã xem) để 7.4 "Duyệt" hỏi giờ mới (`SCHEDULE_IN_PAST`, AC epic). Không cần lý do huỷ mới.
- **Lỗi 422 từng bài ở chế độ "Tự đăng" không làm hỏng lần bắt đầu:** savepoint quanh `approve`; bài về "Chờ duyệt" kèm mã như mọi bài AI lỗi (AD-15). Lỗi khác (DB, 404) vẫn huỷ cả transaction.
- **Thứ tự khoá:** dòng chiến dịch → dòng slot (theo id) → advisory giới hạn/24h (theo `pageId` tăng dần), cùng chiều với `transitionPostTargets` (dòng trước, advisory sau).
- **`trend` = số bài đã đăng mỗi ngày:** chưa có số liệu tương tác (Epic 8). Nhãn thẻ đổi thành "Bài đã đăng 7 ngày" để không nói sai.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: đúng một migration mới (`campaigns.started_at` + check).
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `/chien-dich/tao?id=` bước 4 → "Bắt đầu chiến dịch" → `/lich` có slot chấm tím "AI tạo"; `/chien-dich` và Tổng quan hiện "0/N bài".
