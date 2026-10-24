---
title: 'Story 7.5 — Tạm dừng, tiếp tục và xoá chiến dịch'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '2334d3f6f52e09cb85abd2d71b478df26b510923'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 7.5, AD-15, AD-13; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Nút Tạm dừng / Tiếp tục / Xoá ở `/chien-dich` và Tổng quan còn khoá "Sắp có": chiến dịch đang chạy không dừng được (bài vẫn đăng, cron vẫn viết), không xoá được chiến dịch (kể cả nháp), và chiến dịch hết bài không bao giờ sang `done`. Chưa có cột `pause_reason` nên thẻ không nói được vì sao dừng, và Story 7.6 không có chỗ để tự dừng.

**Approach:**
- MỘT cặp hàm `campaigns.pauseCampaign(tx, deps, id, reason)` / `resumeCampaign(tx, deps, id)` dùng chung cho chủ shop (`MANUAL`) và hệ thống (7.6). Tạm dừng: `paused` + lý do + `content.holdCampaignTargets` cùng transaction. Tiếp tục: kiểm lý do còn không, rồi `content.releaseCampaignTargets` (bài lỡ giờ → huỷ `MISSED_WHILE_PAUSED`, bài tương lai bỏ `held` + enqueue lại).
- Xoá: `content.cancelCampaignTargets` huỷ bài chưa đăng, giữ bài đã đăng / đang đăng, rồi xoá dòng chiến dịch.
- Cron `campaigns.complete_check` hằng giờ: chiến dịch hết slot mở → `done` + `campaign.completed`.

## Boundaries & Constraints

**Always:**
- **Shared:**
  - `CampaignDto.pauseReason` (`PauseReason | null`), `CampaignDto.pausedAt` (ISO | null).
  - `POST /campaigns/:id/pause` và `/resume` (body `{}` strict) → 200 `CampaignActionResponse {campaign: CampaignSummaryDto, changed, missed}` (`missed` = số bài vừa huỷ vì lỡ giờ khi tiếp tục; 0 với tạm dừng).
  - `DELETE /campaigns/:id` → 200 `DeleteCampaignResponse {cancelled, kept}` (`kept` = bài đã đăng + đang đăng giữ nguyên).
  - Sự kiện `campaign.deleted {}` (realtime). `CalendarItemDto.held` (boolean).
- **Content** (không import `campaigns`, không biết lý do dừng):
  - `holdCampaignTargets(tx, campaignId)`: mọi target `planned|pending_approval|scheduled|publishing|failed` chưa `held` → `held = true`, `version + 1`. Không đổi `schedule_version` (job đăng chờ sẵn tự bỏ qua vì `held`).
  - `releaseCampaignTargets(tx, deps, campaignId, now)`: khoá dòng slot theo id, rồi với target `held`:
    - `planned|pending_approval|scheduled` có giờ đăng (`scheduled_at ?? slot_at`) `≤ now + CAMPAIGN_SLOT_MIN_LEAD_MS` → `cancelled MISSED_WHILE_PAUSED`, bỏ mã lỗi (`scheduled` thì `schedule_version + 1`).
    - `scheduled` còn tương lai → bỏ `held`, `schedule_version + 1`, `version + 1`, enqueue `publish.target` `startAfter = scheduled_at` cùng transaction.
    - Còn lại (`planned|pending_approval` tương lai, `failed`, `publishing`) → bỏ `held`.
    - Trả `{missed, rescheduled, released}`.
  - `cancelCampaignTargets(tx, campaignId, reason, {pageId?})`: `planned|pending_approval|scheduled|failed` → `cancelled` + lý do, bỏ `held` / mã lỗi (`scheduled` thì `schedule_version + 1`). `publishing` / `published` không đụng. Trả `{cancelled, kept}`. 7.6 gọi lại với `PAGE_LEFT_GROUP` + `pageId`.
  - `openCampaignSlots(db, campaignIds)` → số slot `planned|pending_approval|scheduled|publishing` theo chiến dịch.
  - Job `publish.target` giữ nguyên luật đã có: bỏ qua target `held` cả lúc đọc lẫn lúc chiếm (`WHERE held = false`). Target `publishing` bị dừng giữa chừng chạy hết lần đăng đó; nếu lần đăng trả lỗi tạm và bài về `scheduled` thì vẫn `held` → lần retry bỏ qua, cron `content.requeue` không enqueue lại.
  - Không phát `post_target.cancelled` từng bài cho thao tác hàng loạt: sự kiện cấp chiến dịch (`campaign.paused|resumed|deleted`) làm cũ Lịch.
  - Lịch: `held` theo target.
- **Campaigns:**
  - Migration: `campaigns.pause_reason`, `paused_at`, `consecutive_failures int not null default 0`. Check `(status = 'paused') = (pause_reason is not null)` và `(pause_reason is null) = (paused_at is null)`.
  - `pauseCampaign(tx, deps, id, reason, now)`: khoá dòng `FOR UPDATE`.
    - Không có → 404. `draft|done` → 409 `VERSION_CONFLICT`.
    - `running` → `paused` + `reason` + `paused_at`, `holdCampaignTargets`, phát `campaign.paused {reason}` → `changed: true`.
    - Đã `paused`: lý do đang là `MANUAL` mà `reason` là lý do hệ thống → đổi lý do + phát lại `campaign.paused` (`changed: true`, không hold lại); còn lại → `changed: false`, không đổi gì.
  - `resumeCampaign(tx, deps, id, now)`: khoá dòng.
    - Không có → 404. `running` → `changed: false`. `draft|done` → 409.
    - Lý do còn → 409, mã = lý do: `PAGE_DISCONNECTED` / `CONFIG_MISSING` khi một trang chưa gỡ của chiến dịch còn bị chặn (`pageBlockReason`, mã theo trang); `AI_BUDGET_EXCEEDED` khi hạn mức `blocked`. `MANUAL` / `PUBLISH_FAILURES` không kiểm.
    - Ngược lại `releaseCampaignTargets`, `running`, `pause_reason = paused_at = null`, `consecutive_failures = 0`, phát `campaign.resumed`, enqueue `campaigns.generate` cùng transaction.
  - `deleteCampaign(tx, deps, id)`: khoá dòng; 404; mọi trạng thái (gồm nháp). `cancelCampaignTargets(CAMPAIGN_DELETED)` rồi xoá dòng chiến dịch (cascade chủ đề / trang), phát `campaign.deleted`.
  - Sinh nội dung: `runSlotBatch` nhận `active()` kiểm trước mỗi slot. Cuốn chiếu: chiến dịch còn `running`; xem trước: còn `draft|running`. Hết `active` → dừng lô, không enqueue lượt tiếp. Slot đang viết dở thì viết xong; "Tự đăng" không duyệt bài `held` (luật đã có của `autoApproveSlot`).
  - Cron `campaigns.complete_check` (`5 * * * *`, standard, retry 1): chiến dịch `running|paused` có 0 slot mở → khoá dòng, kiểm lại, `done` (bỏ `pause_reason`), phát `campaign.completed`.
- **Route:** cả 3 route cần `jobs` + `events`; trả DTO qua `campaignSummaries`.
- **Web:**
  - Thẻ ở `/chien-dich`: Tạm dừng / Tiếp tục bấm là chạy, không xác nhận. Thẻ tạm dừng ghi lý do theo `pauseReason`. Xoá (cả nháp) mở hộp xác nhận "bài đã đăng giữ nguyên"; xong → toast "Đã xoá … — huỷ n bài chưa đăng".
  - Tiếp tục: `missed > 0` → toast "n bài lỡ giờ trong lúc dừng đã bỏ". Lỗi 409 theo mã → câu của `error-messages.ts`.
  - Tổng quan "Chiến dịch đang chạy": nút Tạm dừng / Tiếp tục thật, dòng lý do khi tạm dừng.
  - Lịch: ô / ngăn bài `held` của chiến dịch đã bắt đầu ghi "Tạm dừng".
  - SSE `campaign.*` (gồm `deleted`) đã làm cũ danh sách + Lịch.

**Never:**
- Không xoá / sửa bài đã đăng trên Meta. Không huỷ bài `publishing` (đang gọi Meta).
- Không đăng dồn bài lỡ giờ khi tiếp tục. Không tự dừng theo sự kiện (`page.*`, hạn mức, đăng lỗi liên tiếp — 7.6); không tăng `consecutive_failures` (7.6).
- Không hiện bài của chiến dịch tạm dừng trong hàng đợi "Bài chờ duyệt" (giữ luật 7.4: bỏ bài `held`).
- Không xác nhận khi Tạm dừng / Tiếp tục. Không sửa cấu hình chiến dịch đã chạy. `content` không import `campaigns`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tạm dừng | `running`; slot `planned`, `pending_approval`, `scheduled` (job chờ), `failed`, `published` | 200 `changed true`; `paused MANUAL`, `paused_at`; mọi slot chưa đăng `held`; `published` giữ nguyên; 1 `campaign.paused {MANUAL}`, không thông báo | |
| Job đăng tới giờ | slot `scheduled` của chiến dịch `paused` | `publish.target` → `skipped`, 0 lời gọi Meta; `content.requeue` không enqueue lại | |
| Race: job đang đăng | Meta đang xử lý lời gọi của bài `publishing` thì bấm tạm dừng | 200; bài đó đăng xong `published` | |
| Race: lỗi tạm sau dừng | IG `publishing`, tạm dừng, container trả lỗi tạm | bài về `scheduled` + `held`; lần retry `skipped`; tiếp tục → enqueue lại (tương lai) / `MISSED_WHILE_PAUSED` (đã qua) | |
| Cron sinh | chiến dịch `paused`; lô đang chạy thì bị dừng | `campaigns.generate` → `skipped`; lô dừng trước slot kế, không enqueue lượt tiếp; `generate_window` không enqueue | |
| Tạm dừng hai lần / sai trạng thái | `paused` bấm lại; nháp / `done`; lạ; 401 | 200 `changed false`; 409; 404; 401 | |
| Hệ thống dừng đè | `paused MANUAL` + `pauseCampaign(PAGE_DISCONNECTED)` | lý do → `PAGE_DISCONNECTED`, phát lại `campaign.paused`; `paused PAGE_DISCONNECTED` + `MANUAL` → không đổi | |
| Tiếp tục | `paused`; slot lỡ giờ (`planned`, `pending_approval`, `scheduled`); slot tương lai; `failed`; `consecutive_failures 2` | 200 `missed 3`; lỡ giờ → `cancelled MISSED_WHILE_PAUSED`; `scheduled` tương lai bỏ `held`, `schedule_version + 1`, job mới đúng giờ (job cũ bỏ qua); `failed` bỏ `held`; `running`, lý do null, `consecutive_failures 0`; `campaign.resumed`; enqueue `campaigns.generate` | |
| Lý do còn | `PAGE_DISCONNECTED` + trang vẫn `disconnected`; `CONFIG_MISSING` + chưa có hồ sơ; `AI_BUDGET_EXCEEDED` + hạn mức `blocked` | 409 mã tương ứng, không đổi gì | |
| Lý do đã hết / không kiểm | trang kết nối lại; `PUBLISH_FAILURES`; `MANUAL` + hạn mức `blocked` | 200 tiếp tục | |
| Tiếp tục sai trạng thái | `running`; nháp / `done` | 200 `changed false`; 409 | |
| Xoá | `running`; slot `planned`, `pending_approval`, `scheduled`, `failed`, `publishing`, `published` | 200 `cancelled 4, kept 2`; 4 bài `cancelled CAMPAIGN_DELETED`; `publishing` / `published` giữ nguyên; dòng chiến dịch mất (danh sách / `GET /campaigns/:id` 404); `campaign.deleted`; job `publish.target` cũ bỏ qua; `campaigns.generate` sau đó `skipped` | |
| Xoá nháp | nháp có 7 bài xem trước `held` | 200; bài xem trước `cancelled`; job `campaigns.preview` sau đó `skipped` | 404 lạ, 401 |
| Hoàn tất | `running` không còn slot mở (còn `published` / `failed` / `cancelled`); `paused` không còn slot mở; `running` còn slot `scheduled` | `done` + `campaign.completed` (lý do null); `done`; giữ `running` | |
| Lịch | slot `held` của chiến dịch tạm dừng | `held true` | |
| Web | thẻ `running` / `paused` (lý do) / nháp; xoá có xác nhận; tiếp tục bị từ chối / có bài lỡ giờ; Tổng quan; ô Lịch `held` | nút thật; "Tạm dừng: trang mất kết nối…"; hộp xác nhận; câu lỗi theo mã; toast lỡ giờ; " · Tạm dừng" | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/{campaigns,content,events}.ts` -- `pauseReason` / `pausedAt`, response tạm dừng / tiếp tục / xoá, `campaign.deleted`, `CalendarItemDto.held`.
- `server/src/modules/content/{slots-hold,calendar,index}.ts` (`slots-hold.ts` MỚI) -- hold / release / cancel / đếm slot mở, `held` trên Lịch.
- `server/src/modules/campaigns/{schema,lifecycle,runner,generate,preview,drafts,index}.ts` + migration (`lifecycle.ts` MỚI) -- cột mới, pause / resume / delete / complete check, `active()` trong lô sinh.
- `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts` -- cron `campaigns.complete_check`.
- `server/src/app/campaigns.ts` -- 3 route.
- `server/test/campaigns-lifecycle.test.ts` (MỚI) -- ma trận server; `notifications.test.ts` / `queues.test.ts` theo queue mới.
- `web/src/lib/{campaigns,calendar}.ts` + test; `web/src/screens/{Campaigns,Dashboard,ContentCalendar}.tsx` -- nút, lý do, xác nhận xoá, "Tạm dừng" trên Lịch.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/*` -- hợp đồng mới -- AD-15, AD-18, AD-3.
- [x] `server/src/modules/content/*` -- hold / release / cancel / đếm, `held` Lịch -- AD-13, AD-15.
- [x] `server/src/modules/campaigns/*` + migration -- vòng đời chiến dịch, `active()` -- AD-15, AD-1.
- [x] `server/src/platform/jobs/queues.ts`, `worker/main.ts`, `app/campaigns.ts` -- cron + route -- AD-24, AD-18.
- [x] `server/test/campaigns-lifecycle.test.ts` -- phủ các dòng server của ma trận (gồm 2 race với job đăng).
- [x] `web/src/lib/*` + test, `screens/*` -- thẻ, Tổng quan, Lịch.
- [x] `deferred-work.md` -- đóng "xoá nháp", cập nhật "lý do tạm dừng", thêm mục mới.

**Acceptance Criteria:**
- Given chiến dịch đang chạy có bài sắp đăng, when bấm "Tạm dừng" rồi đợi qua giờ một bài, then bài đó không đăng; bấm "Tiếp tục" thì bài đó thành "đã huỷ — lỡ giờ khi tạm dừng" và các bài sau đăng đúng giờ.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `campaigns.ts` — `CampaignDto.pauseReason` / `pausedAt`, `CampaignActionRequest` / `CampaignActionResponse`, `DeleteCampaignResponse`. `events.ts` — `campaign.deleted`. `content.ts` — `CalendarItemDto.held`.
- **Content:**
  - `slots-hold.ts` (mới): `holdCampaignTargets`, `releaseCampaignTargets` (3 lệnh `UPDATE` theo thứ tự lỡ giờ → `scheduled` tương lai + enqueue → còn lại), `cancelCampaignTargets(…, {pageId?})`, `openCampaignSlots`. Khoá dòng slot theo id trước mỗi lệnh.
  - `calendar.ts`: trả `held`. Job đăng / cron vá không đổi (đã kiểm `held` từ 6.4 / 7.2).
- **Campaigns:**
  - Migration `0035_regular_penance.sql`: `pause_reason`, `paused_at`, `consecutive_failures` + 3 check (`paused` ⇔ có lý do, lý do thuộc `PAUSE_REASONS`, lý do ⇔ `paused_at`).
  - `lifecycle.ts` (mới): `pauseCampaign`, `resumeCampaign`, `deleteCampaign`, `runCompleteCheck`. `drafts.ts` đọc 2 cột mới.
  - `runner.ts`: `active()` trước mỗi slot + `inactive`; `campaignIn`. `generate.ts` (`running`) / `preview.ts` (`draft|running`) truyền `active`; lô dừng vì `inactive` thì không ném retry, không enqueue tiếp.
- **Nền / app:** queue cron `campaigns.complete_check` (`5 * * * *`) + handler worker; route `POST /campaigns/:id/pause|resume`, `DELETE /campaigns/:id`.
- **Web:**
  - `lib/campaigns.ts`: `PAUSE_REASON_TEXT`, `pausedNote`, `lifecycleToast`, `resumeErrorText`, `deleteConfirmText`, `deletedToast`, `useCampaignLifecycle`, `useDeleteCampaign`.
  - `lib/calendar.ts`: `CalendarGroup.held`, `isGroupHeld`, `groupStatusText`, `HELD_NOTE`.
  - `Campaigns.tsx`: nút thật, lý do, hộp xác nhận xoá (cả nháp). `Dashboard.tsx`: nút + dòng lý do. `ContentCalendar.tsx`: " · Tạm dừng" trên ô, chip + ghi chú trong ngăn.
- **Test:**
  - Server: `campaigns-lifecycle.test.ts` (13 test, mới — phủ mọi dòng server của ma trận, gồm 2 race với job đăng qua Meta giả). `campaigns-generate.test.ts` đặt lý do khi giả `paused`; `notifications.test.ts` thêm handler queue mới.
  - Web: `campaigns.test.ts` (+1, fixture thêm 2 trường), `calendar.test.ts` (+1).
- **Kiểm tra:** `npm run check` thoát 0.
  - depcruise sạch (204 module).
  - Server 68 file / 1392 test; web 22 file / 326 test.
  - Chưa thử bằng trình duyệt.
- **Việc hoãn:** đóng "xoá nháp" (7.1); thu hẹp "lý do tạm dừng / `Group.activeCampaigns`" (7.3) còn `Group.activeCampaigns`. Thêm: kiểm trình duyệt 7.5, thao tác tới `scheduled` trên bài `held` không bị khoá, không phát sự kiện từng bài khi thao tác hàng loạt, bài `publishing` lúc xoá có thể đăng ở lượt retry.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Xoá chiến dịch lúc bài đang `publishing`, Meta trả lỗi tạm (`notSent`) → bài về `scheduled` không `held`, lượt retry đăng bài sau khi chiến dịch đã xoá. Sửa: `cancelCampaignTargets` (xoá cả chiến dịch) đặt `held` cho bài `publishing` → retry bỏ qua; cron `campaigns.complete_check` huỷ bài `held` sót của chiến dịch không còn (`heldCampaignIds` → `CAMPAIGN_DELETED`). Test race mới. | Thật (cao) | patch |
| Lúc tạm dừng, Lịch / API vẫn cho "Đăng lại ngay" / đổi giờ / "Duyệt" bài `held` → bài `scheduled` mà không đăng, tiếp tục thì thành `MISSED_WHILE_PAUSED`. Sửa: `transitionTarget` trả 409 `CAMPAIGN_PAUSED` (mã mới + câu ở `error-messages.ts`) cho hành động tới `scheduled` trên target `held`; ngăn Lịch ẩn đổi giờ / duyệt / đăng lại, không kéo thả bài `held`. Sửa / xoá vẫn được. Test mới. | Thật (vừa) | patch |
| Chiến dịch tạm dừng chỉ còn bài `failed` → cron chuyển `done` nhưng bài lỗi vẫn `held` mãi (đăng lại không bao giờ đăng / bị chặn). Sửa: `runCompleteCheck` gọi `content.clearCampaignHolds` khi sang `done`. Test mới. | Thật (vừa) | patch |
| Job đăng chờ sẵn khi tạm dừng; tiếp tục đăng dồn; tiếp tục đua tạm dừng; xoá mất lịch sử bài đã đăng; `complete_check` xong sớm; auth / Origin route `DELETE`; log nội dung | Đã kiểm: `held` kiểm cả lúc đọc lẫn lúc chiếm; lỡ giờ → huỷ; khoá dòng `FOR UPDATE` tuần tự; slot không FK, bài đã đăng giữ; mọi slot tạo lúc "Bắt đầu" nên không có slot "chưa sinh"; guard `/api/v1` + Origin cho `DELETE`; không log caption | — |

## Design Notes

- **Lỡ giờ = giờ đăng ≤ now + 2 phút lúc tiếp tục**, áp cho cả bài chờ duyệt đã quá giờ từ trước khi dừng (AC: "slot đã lỡ giờ → `cancelled MISSED_WHILE_PAUSED`"). Chọn huỷ (không dời, không bắt duyệt lại): không đăng dồn, Lịch không bị xô giờ, chủ shop thấy rõ bài nào mất. Mốc 2 phút cùng mốc `SCHEDULE_IN_PAST` của duyệt. Bài `failed` không huỷ (chủ shop tự "Đăng lại" / xoá).
- **`publishing` không chặn được giữa chừng:** lời gọi tạo bài của Meta không huỷ an toàn (chống đăng trùng — 6.4). Tạm dừng vẫn đặt `held` cho bài đó nên mọi lần đăng LẠI bị chặn; xoá thì để bài đó chạy hết (có thể đã lên Meta).
- **Lý do hệ thống đè `MANUAL`:** để 7.6 gọi `pauseCampaign` cả khi chủ shop đã tự dừng — "Tiếp tục" khi đó vẫn kiểm sự cố. Ngược lại không đè (giữ lý do sự cố đầu tiên).
- **Xoá cứng dòng chiến dịch:** slot không có FK tới `campaigns` (AD-1) nên bài đã đăng vẫn ở Lịch với `campaignId` cũ; job / sự kiện muộn của chiến dịch đã xoá gặp "không có" → bỏ qua.
- **Hàng đợi khi tạm dừng:** bài chờ duyệt của chiến dịch tạm dừng `held` nên rời hàng đợi (như số "chờ duyệt" trên thẻ); hiện lại khi tiếp tục.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: đúng một migration mới (`pause_reason`, `paused_at`, `consecutive_failures` + 2 check).
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `/chien-dich`: Tạm dừng → thẻ "Tạm dừng" + lý do, Lịch ghi "Tạm dừng"; Tiếp tục → lại "Đang chạy"; Xoá → hộp xác nhận → thẻ mất, bài đã đăng vẫn trên Lịch.
