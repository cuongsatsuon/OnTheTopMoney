---
title: 'Story 7.6 — Chiến dịch tự tạm dừng khi có sự cố'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '92727415e816e1f068a60ac1ab5d5b896316ab48'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-7-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 7.6, AD-15, AD-23, AD-5, AD-7; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Chiến dịch chỉ dừng khi chủ shop bấm (7.5). Trang mất kết nối, hết hạn mức AI, thiếu hồ sơ / khoá OpenAI hay đăng lỗi liên tiếp thì chiến dịch vẫn `running`: bài tới giờ lỗi hàng loạt, cron sinh dừng im lặng rồi viết bù bài đã quá giờ (tốn tiền), `consecutive_failures` không ai tăng. Gỡ trang / trang rời nhóm nhãn chưa huỷ bài của trang đó. Mất kết nối chỉ có realtime, không có thông báo lưu lại.

**Approach:** Consumer sự kiện `events.campaigns` (AD-3) phản ứng `page.*`, `ai_budget.threshold_reached`, `post_target.failed|published` bằng chính `pauseCampaign` của 7.5 (idempotent, lý do hệ thống đè `MANUAL`); lượt sinh cuốn chiếu tự dừng chiến dịch khi gặp chặn (trang, hồ sơ, khoá, hạn mức) thay vì dừng im lặng. `content` có consumer `events.content` huỷ bài chưa đăng của trang bị gỡ. Không tự tiếp tục: chỉ chủ shop bấm "Tiếp tục" (AD-15, AD-5).

## Boundaries & Constraints

**Always:**
- **Shared:** `PauseReason` thêm `OPENAI_KEY_UNAVAILABLE`. `campaign.paused` thêm `pausedAt` (ISO, bắt buộc). `page.disconnected` thêm `disconnectedAt` (ISO, tuỳ chọn; `connections` đặt ở cả hai chỗ phát). `NotificationType` thêm `page_disconnected` (mặc định bật).
- **Content** (không import `campaigns`): `cancelPageTargets(tx, pageId, reason)` — target `planned|pending_approval|scheduled|failed` của trang → `cancelled` + lý do, bỏ `held` / mã lỗi (`scheduled` thì `schedule_version + 1`); `draft` thủ công, `publishing`, `published` giữ. Queue `events.content` nghe `page.removed` → `cancelPageTargets(PAGE_REMOVED)`.
- **Campaigns** — queue `events.campaigns` (standard, retry 5, backoff) nghe `page.disconnected`, `page.removed`, `page.group_changed`, `ai_budget.threshold_reached`, `post_target.failed`, `post_target.published`. Mỗi chiến dịch một transaction riêng; sai dạng → bỏ qua (không đốt retry):
  - `page.disconnected`: trang vẫn `disconnected` lúc xử lý → mọi chiến dịch `running|paused` có trang trong `campaign_pages` → `pauseCampaign(PAGE_DISCONNECTED)`.
  - `ai_budget.threshold_reached{100}`: hạn mức vẫn `blocked` lúc xử lý → mọi chiến dịch `running|paused` → `pauseCampaign(AI_BUDGET_EXCEEDED)`. Mức 80 bỏ qua.
  - `post_target.failed` có `campaignId`: mã `PAGE_DISCONNECTED` → `pauseCampaign(PAGE_DISCONNECTED)` (không đếm); `PAGE_REMOVED` → bỏ qua; mã khác, chiến dịch `running` và target chưa đếm trong chuỗi hiện tại → `consecutive_failures + 1`, ghi target vào `failure_target_ids`; chạm 3 → `pauseCampaign(PUBLISH_FAILURES)` cùng transaction.
  - `post_target.published` có `campaignId` → `consecutive_failures = 0`, `failure_target_ids = {}`.
  - `page.removed` → xoá dòng `campaign_pages` của trang ở chiến dịch `draft|running|paused` (chiến dịch chạy tiếp với trang còn lại; hết slot thì cron 7.5 chuyển `done`).
  - `page.group_changed` có `fromGroupId`, trang hiện không còn ở nhóm đó → chiến dịch `running|paused` có `group_id = fromGroupId` và có trang: khoá dòng, `content.cancelCampaignTargets(PAGE_LEFT_GROUP, {pageId})`, xoá dòng `campaign_pages`.
  - `page.expiring`, `page.reconnected`, `ai_budget.restored` không nghe (chiến dịch vẫn chạy / không tự tiếp tục).
- **Lượt sinh cuốn chiếu** (`runGenerate`, chiến dịch `running`, có slot cần viết) kiểm trước khi gọi AI, gặp chặn → `pauseCampaign` + trả `{stopped, approved, paused}`: trang chưa gỡ bị chặn (`pageBlockReason`) → `PAGE_DISCONNECTED` / `CONFIG_MISSING`; khoá không dùng được (`OPENAI_KEY_*`, `ENCRYPTION_NOT_CONFIGURED`) → `OPENAI_KEY_UNAVAILABLE`; hạn mức `blocked` → `AI_BUDGET_EXCEEDED`. Mã dừng giữa lô cũng tạm dừng theo cùng bảng.
- **Tiếp tục:** `OPENAI_KEY_UNAVAILABLE` còn (khoá chưa dùng được) → 409 mã = lỗi khoá. Tiếp tục xoá cả `failure_target_ids`. Luật 7.5 khác giữ nguyên.
- **Migration:** `campaigns.failure_target_ids text[] not null default '{}'` + check `consecutive_failures = cardinality(failure_target_ids)`; check lý do / loại thông báo theo enum mới.
- **Thông báo:** `campaign.paused` chống trùng theo `(id, reason, pausedAt)` — dừng lại lần sau vẫn báo, giao lại không nhân đôi; câu cho lý do mới. `page.disconnected` → `page_disconnected` ("Trang mất kết nối"), chống trùng theo `disconnectedAt`.
- **Web:** lý do `OPENAI_KEY_UNAVAILABLE` trên thẻ + câu lỗi khi tiếp tục bị từ chối vì khoá; mục "Trang mất kết nối" ở Cài đặt › Thông báo + biểu tượng trong ngăn thông báo; sự kiện `page.*` làm cũ cả Lịch (bài huỷ vì gỡ / rời nhóm).

**Never:**
- Không tự tiếp tục khi trang kết nối lại / hạn mức được nâng / khoá được nhập lại.
- `content` không biết chiến dịch hay lý do dừng. Không đếm lỗi `PAGE_DISCONNECTED` / `PAGE_REMOVED` vào chuỗi lỗi. Không đếm một target hai lần trong một chuỗi (bấm "Đăng lại" lỗi tiếp).
- Không phát `post_target.cancelled` từng bài cho thao tác hàng loạt. Không huỷ bài `publishing` / `published`.
- Không động tới chiến dịch nháp khi mất kết nối / hạn mức (nháp chưa đăng; "Bắt đầu" tự kiểm lại); không sửa chiến dịch `done`.
- Không đổi mặc định bật/tắt `campaign_paused` (Story 1.4).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Mất kết nối | `page.disconnected` của trang trong chiến dịch `running` (+ một chiến dịch khác không có trang đó, một nháp có trang đó) | chiến dịch có trang → `paused PAGE_DISCONNECTED`, slot `held`, 1 `campaign.paused`; hai chiến dịch kia giữ nguyên; giao lại sự kiện → không phát thêm | trang đã kết nối lại lúc xử lý → không dừng |
| Đè `MANUAL` | `paused MANUAL` + `page.disconnected` | lý do → `PAGE_DISCONNECTED`, phát lại `campaign.paused` | |
| Hạn mức 100% | `threshold_reached{100}`, hạn mức `blocked`; 2 chiến dịch `running` | cả hai `paused AI_BUDGET_EXCEEDED` | mức 80 / hạn mức đã nâng → không dừng |
| Sinh: chặn | lượt sinh: trang thiếu hồ sơ / trang mất kết nối / khoá chưa nhập / hạn mức hết | `paused` `CONFIG_MISSING` / `PAGE_DISCONNECTED` / `OPENAI_KEY_UNAVAILABLE` / `AI_BUDGET_EXCEEDED`; 0 lời gọi AI; slot giữ `planned`; lượt sau `skipped` | |
| Sinh: hết hạn mức giữa lô | mã dừng ở slot 2 | slot 2 `pending_approval` kèm mã, slot sau `planned`, chiến dịch `paused AI_BUDGET_EXCEEDED` | |
| Đăng lỗi liên tiếp | 3 `post_target.failed` (`PUBLISH_FAILED`) của 3 target khác nhau | `consecutive_failures` 1→2→3, lần 3 → `paused PUBLISH_FAILURES` | |
| Idempotent / reset | cùng target lỗi 2 lần; `post_target.published` giữa chuỗi; lỗi `PAGE_REMOVED`; bài thủ công (`campaignId null`); chiến dịch đã xoá | đếm 1 lần; về 0; không đếm; bỏ qua; bỏ qua | |
| Lỗi mất kết nối | `post_target.failed{PAGE_DISCONNECTED}` | không đếm; `paused PAGE_DISCONNECTED` | |
| Tiếp tục | `paused OPENAI_KEY_UNAVAILABLE` khoá chưa nhập / đã nhập; `PUBLISH_FAILURES` có `failure_target_ids` | 409 `OPENAI_KEY_MISSING` / 200; 200, đếm về 0, danh sách rỗng | |
| Sắp hết hạn | `page.expiring` | chiến dịch vẫn `running`, không thông báo dừng | |
| Gỡ trang | `page.removed` của 1 trong 2 trang của chiến dịch `running` (slot `planned`, `scheduled`, `failed`, `published`) + bài thủ công `draft` / `scheduled` của trang đó | `content`: bài chưa đăng của trang → `cancelled PAGE_REMOVED` (cả bài thủ công `scheduled`; `draft` / `published` giữ); `campaigns`: trang rời `campaign_pages`, chiến dịch vẫn `running`, slot trang kia giữ nguyên | giao lại → không đổi gì |
| Rời nhóm nhãn | `page.group_changed{from: nhóm nhãn}` | slot chưa đăng của trang → `cancelled PAGE_LEFT_GROUP`, trang rời `campaign_pages`; chiến dịch khác nhóm / trang đã quay lại nhóm → không đổi | |
| Thông báo | `campaign.paused` hai lần cùng lý do khác `pausedAt`; giao lại cùng sự kiện; `page.disconnected` | 2 thông báo (khi bật); 1; `page_disconnected` (mặc định bật) | |
| Web | thẻ `OPENAI_KEY_UNAVAILABLE`; tiếp tục bị từ chối vì khoá; Cài đặt › Thông báo; SSE `page.removed` | câu lý do + việc cần làm; câu lỗi khoá; mục "Trang mất kết nối"; Lịch tải lại | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/{enums,events,notifications}.ts` -- lý do mới, `pausedAt`, `disconnectedAt`, loại thông báo mới.
- `server/src/modules/connections/token-check.ts` -- `disconnectedAt` ở hai chỗ phát `page.disconnected`.
- `server/src/modules/content/{slots-hold,events,index}.ts` (`events.ts` MỚI) -- `cancelPageTargets`, consumer `page.removed`.
- `server/src/modules/campaigns/{schema,lifecycle,generate,auto-pause,index}.ts` (`auto-pause.ts` MỚI) + migration -- chuỗi lỗi, consumer sự kiện, tự dừng ở lượt sinh, kiểm khoá khi tiếp tục.
- `server/src/modules/notifications/service.ts` -- `page_disconnected`, câu lý do mới, khoá chống trùng.
- `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts`, `server/src/app/{campaigns,app}.ts` -- 2 queue consumer, nối handler, `cipher` cho tiếp tục.
- `server/test/campaigns-auto-pause.test.ts` (MỚI) -- ma trận server; cập nhật `campaigns-generate`, `campaigns-lifecycle`, `notifications`, `queues`.
- `web/src/lib/{campaigns,realtime}.ts` + test, `web/src/screens/Settings.tsx`, `web/src/components/NotificationsDrawer.tsx`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/*` -- enum / payload / loại thông báo -- AD-3, AD-15.
- [x] `server/src/modules/connections/token-check.ts` -- `disconnectedAt` -- AD-5.
- [x] `server/src/modules/content/*` -- `cancelPageTargets` + consumer `page.removed` -- AD-23, AD-13.
- [x] `server/src/modules/campaigns/*` + migration -- consumer, chuỗi lỗi, tự dừng lúc sinh, tiếp tục kiểm khoá -- AD-15, AD-7, AD-1.
- [x] `server/src/modules/notifications/service.ts` -- thông báo mất kết nối, chống trùng `campaign.paused` -- AD-3.
- [x] `server/src/platform/jobs/queues.ts`, `worker/main.ts`, `app/*` -- queue + nối -- AD-24.
- [x] `server/test/*` -- phủ mọi dòng server của ma trận.
- [x] `web/src/*` + test -- lý do, câu lỗi, Cài đặt, ngăn thông báo, realtime.
- [x] `deferred-work.md` -- đóng mục khoá OpenAI / thông báo mất kết nối, thêm việc hoãn mới.

**Acceptance Criteria:**
- Given chiến dịch đang chạy và trang của nó mất token, when worker xử lý `page.disconnected`, then thẻ chiến dịch ghi "Tự tạm dừng: trang … mất kết nối", bài tới giờ không đăng, và "Tiếp tục" bị từ chối cho tới khi kết nối lại.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `enums.ts` — `PauseReason.OPENAI_KEY_UNAVAILABLE`; `events.ts` — `campaign.paused.pausedAt` (bắt buộc), `page.disconnected.disconnectedAt` (tuỳ chọn); `notifications.ts` — `page_disconnected` (mặc định bật).
- **Connections:** `token-check.ts` đặt `disconnectedAt` ở cả `markDisconnectedTx` lẫn cron hết hạn.
- **AI:** `getUsableOpenAiKey` nhận `DbExecutor` (tiếp tục kiểm khoá dưới khoá dòng chiến dịch).
- **Content:** `slots-hold.ts` + `cancelPageTargets`; `events.ts` (mới) — `handleContentEvent` cho `page.removed`.
- **Campaigns:**
  - Migration `0036_black_invaders.sql`: `failure_target_ids text[]` + check `consecutive_failures = cardinality(...)`, check lý do / loại thông báo theo enum mới.
  - `auto-pause.ts` (mới): `handleCampaignsEvent` + `PUBLISH_FAILURES_MAX = 3`.
  - `lifecycle.ts`: `pauseBySystem` (transaction riêng, nuốt 404 / 409), `pausedAt` trong sự kiện, tiếp tục kiểm khoá (`cipher` qua `LifecycleDeps`) và xoá `failure_target_ids`.
  - `generate.ts`: kiểm trang (`pageBlockReason`) → khoá → hạn mức trước lô, mã dừng giữa lô → `pauseBySystem`; kết quả có `paused`.
- **Thông báo:** `page_disconnected`; câu `CONFIG_MISSING` rõ hơn + câu `OPENAI_KEY_UNAVAILABLE`; chống trùng `campaign.paused` theo `reason + pausedAt`, `page.disconnected` theo `disconnectedAt`.
- **Nền / app:** queue `events.content` (`page.removed`) + `events.campaigns` (6 sự kiện), retry 5 backoff; `events.notifications` nghe thêm `page.disconnected`; worker nối 2 handler; route tiếp tục nhận `cipher`.
- **Web:** `PAUSE_REASON_TEXT.OPENAI_KEY_UNAVAILABLE`, `resumeErrorText` cho lỗi khoá; Cài đặt › Thông báo thêm "Trang mất kết nối" (sửa gợi ý "Chiến dịch tạm dừng"); biểu tượng `Unplug` trong ngăn thông báo; `page` làm cũ cả `post_target` (Lịch).
- **Test:**
  - Server: `campaigns-auto-pause.test.ts` (15 test, mới — phủ mọi dòng server của ma trận). `notifications.test.ts` (+1, chống trùng mới, mặc định mới), `campaigns-generate.test.ts` (kết quả có `paused`), `campaigns-lifecycle.test.ts` (fixture chuỗi lỗi hợp check mới).
  - Web: `campaigns.test.ts` (+1), `realtime.test.ts` (+1 assert).
- **Kiểm tra:** `npm run check` thoát 0 — depcruise sạch (206 module); server 69 file / 1411 test; web 22 file / 327 test. Chưa thử bằng trình duyệt.
- **Lệch nhỏ so với ma trận:** không có. Quyết định ngoài AC ghi ở Design Notes (`PAGE_DISCONNECTED` khi đăng cũng dừng; `group.deleted` không huỷ bài; khoá OpenAI chỉ dừng khi lượt sinh cần AI).
- **Việc hoãn:** đóng "thông báo bền khi mất kết nối" (2.4) và "khoá OpenAI / hạn mức dừng im lặng" (7.4). Thêm: kiểm trình duyệt 7.6, mặc định `campaign_paused` tắt + không gộp thông báo, tiếp tục chỉ kiểm lý do đang ghi.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Chuỗi lỗi đăng phụ thuộc thứ tự xử lý sự kiện (2 job song song, retry backoff): `post_target.failed` của bài lỗi TRƯỚC một bài đăng được mà tới muộn vẫn được đếm → có thể dừng oan `PUBLISH_FAILURES`; `post_target.published` tới muộn xoá cả lỗi xảy ra sau nó. Sửa: `content.publishedAfter` (bỏ lỗi đã có bài đăng sau nó) + `content.failedAfterPublish` (reset chỉ bỏ lỗi trước lúc bài đăng, dưới khoá dòng chiến dịch); test thứ tự sai trong `campaigns-auto-pause.test.ts`. | real (medium) | patch |

## Design Notes

- **Đếm theo chuỗi, idempotent theo `targetId`:** `failure_target_ids` giữ các target đã đếm từ lần reset gần nhất; `UPDATE … WHERE NOT (target = ANY(failure_target_ids))` nên giao lại sự kiện hay "Đăng lại" bài cũ lỗi tiếp không đếm thêm. Một bài đăng được → reset. Chỉ đếm khi `running` (đang dừng thì "Tiếp tục" đặt về 0 anyway).
- **Kiểm lại lúc xử lý sự kiện:** sự kiện tới muộn (trang đã kết nối lại, hạn mức đã nâng) thì không dừng — tránh dừng oan; ngược lại lượt sinh là lưới an toàn khi sự kiện lỡ (vd hạ hạn mức không phát `threshold_reached`).
- **Khoá OpenAI = lý do tạm dừng mới** (việc hoãn 7.4): chỉ dừng khi lượt sinh thực sự cần AI — chiến dịch đã viết đủ bài không bị dừng oan; tiếp tục sau đó huỷ bài lỡ giờ (`MISSED_WHILE_PAUSED`) thay vì viết bù tốn tiền. Không nghe `openai_key.invalidated` vì lý do đó.
- **`PAGE_DISCONNECTED` khi đăng** (Meta trả `PERMISSION_DENIED` mà trang chưa bị đánh dấu) cũng tạm dừng — cùng lý do, không đếm vào chuỗi.
- **Xoá nhóm (`group.deleted`)** không huỷ bài: nhãn về `null` (FK `set null`), chiến dịch giữ nguyên trang — xoá nhóm để dọn không được làm mất cả lịch đăng.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: đúng một migration mới (cột `failure_target_ids` + check, check lý do, check loại thông báo).
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `/chien-dich`: trang mất kết nối → thẻ "Tạm dừng" + lý do, chuông có "Trang mất kết nối"; Tiếp tục → câu lỗi; kết nối lại → Tiếp tục được.
