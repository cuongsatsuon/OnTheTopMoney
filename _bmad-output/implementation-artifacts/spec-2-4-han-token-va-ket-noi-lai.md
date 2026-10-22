---
title: 'Story 2.4 — Theo dõi hạn token và kết nối lại'
type: 'feature'
created: '2026-10-22'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — ACs lấy từ epics.md Story 2.4, do PM duyệt">

## Intent

**Problem:** Trang đã kết nối (Story 2.2/2.3) nhưng chưa có cơ chế theo dõi hạn token, cảnh báo trước khi hết hạn, phát hiện token hỏng, và kết nối lại đúng trang đó. Thiếu thì hộp thư và lịch đăng đứt mà chủ shop không biết.

**Approach:** Thêm cron hằng ngày (giờ VN) làm mới token Threads sắp hết hạn và tính lại `ConnectionStatus` mọi trang; adapter trả `TOKEN_INVALID` → `connections.markDisconnected` chuyển trang (và trang IG cùng nguồn token) sang `disconnected`; luồng OAuth `intent=reconnect:<pageId>` cập nhật đúng dòng trang; FE hiện chip trạng thái (vàng/đỏ, luôn có chữ) + nút "Kết nối lại" ở Trang & Nhóm, Tổng quan, Cài đặt. Giữ đúng UX-DR3.

## Boundaries & Constraints

**Always (theo epics.md Story 2.4 — bám sát 4 AC):**
- Cron hằng ngày (CRON_TZ Asia/Ho_Chi_Minh): làm mới token Threads còn ≤15 ngày và đã ≥24 giờ tuổi; tính lại trạng thái mọi trang. `expires_at=0` = không hết hạn; mốc hết hạn = sớm nhất giữa `expires_at` và `data_access_expires_at` (bỏ qua giá trị 0/null). Còn ≤7 ngày → `expiring`. Lưu qua `pages.setConnectionStatus`. Trang mới chuyển sang `expiring` phát `page.expiring` **một lần mỗi chu kỳ** (không lặp mỗi lần cron nếu đã expiring).
- Lời gọi Meta trả `TOKEN_INVALID` → `connections.markDisconnected`: chuyển trang đó và mọi trang IG dùng chung `token_source_page_id` sang `disconnected` kèm `reason`, phát `page.disconnected` cho từng trang.
- FE: trang `expiring` → chip vàng "Token sắp hết hạn"; `disconnected` → chip đỏ "Mất kết nối"; cả hai luôn có chữ (UX-DR3) và nút "Kết nối lại". Hiện ở Trang & Nhóm, Tổng quan, Cài đặt › Tài khoản Meta. Chip lấy từ `ConnectionStatus` của server.
- "Kết nối lại" một trang → OAuth với `intent=reconnect:<pageId>` và `auth_type=reauthorize`. Callback cập nhật token đúng dòng trang đó (GIỮ nhóm, cấu hình, lịch sử — không tạo dòng mới), trạng thái về `active` **chỉ khi đủ quyền bắt buộc**, phát `page.reconnected`.
- Bí mật token mã hoá như cũ (AD-12), không log, không trả client. Việc ghi trạng thái + phát sự kiện trong cùng transaction (AD-3).

**Never:** Không đổi cơ chế lưu/mã hoá token. Không tạo dòng trang mới khi reconnect. Không phát `page.expiring` lặp lại mỗi chu kỳ cron cho trang đã `expiring`. Không làm mới token Facebook/Page (Meta không cho refresh token Page kiểu Threads — chỉ reconnect tay). Không chạm module khác ngoài `connections` và FE.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|----------|--------------|----------|-------|
| Cron tính trạng thái | `expires_at=0` | `active` (không hết hạn) | |
| Cron | sớm nhất của expires/data_access còn 5 ngày, đang `active` | → `expiring`, phát `page.expiring` 1 lần | |
| Cron | trang đã `expiring`, vẫn ≤7 ngày | giữ `expiring`, KHÔNG phát lại | |
| Cron refresh Threads | token ≤15 ngày, ≥24h tuổi | gọi refresh, lưu token + hạn mới | refresh lỗi TOKEN_INVALID → markDisconnected |
| Cron refresh Threads | token <24h tuổi | bỏ qua (Meta từ chối refresh token quá mới) | |
| Gọi Meta | trả `TOKEN_INVALID` | trang + IG cùng token_source → `disconnected`, phát `page.disconnected` mỗi trang | |
| Reconnect | OAuth intent=reconnect:<id> xong, đủ quyền | token dòng đó cập nhật, `active`, phát `page.reconnected`, giữ group/config | |
| Reconnect | thiếu quyền bắt buộc | KHÔNG về `active` (giữ expiring/disconnected), nêu quyền thiếu | |
| Reconnect | pageId không thuộc chủ shop / không tồn tại | từ chối, không đổi gì | |

</frozen-after-approval>

## Code Map (điểm xuất phát — subagent tự điều tra thêm)

- `server/src/modules/connections/schema.ts` — `pagesTable` có `connectionStatus`, `expiresAt`, `dataAccessExpiresAt`, `tokenSourcePageId`; `oauthStates.intent` đã ghi nhận `reconnect:<pageId>`.
- `server/src/modules/connections/index.ts` — public API; thêm `setConnectionStatus`, `markDisconnected`, `recomputeStatuses` (hoặc tên tương tự) + export.
- `server/src/modules/connections/candidates.ts`, `confirm.ts`, `credentials.ts`, `oauth.ts` — tạo trang, lưu token, luồng OAuth; thêm nhánh `reconnect`.
- `server/src/modules/connections/meta-clients.ts`, `server/src/adapters/meta/` — refresh token Threads (`/refresh_access_token`), phân loại `TOKEN_INVALID`.
- `server/src/platform/jobs/queues.ts` — thêm cron `connections.token_check` (hằng ngày, CRON_TZ). `server/src/worker/main.ts` — đăng ký handler.
- `packages/shared/src/events.ts` — `page.expiring/disconnected` đã có; thêm `page.reconnected` nếu thiếu. `notifications.ts` — `token_expiring` đã có.
- `web/src/lib/connections.ts`, `web/src/screens/PagesGroups.tsx`, `Settings.tsx`, `Welcome.tsx` (Tổng quan) — chip trạng thái + nút "Kết nối lại"; gọi `/connections/<provider>/start` với `from`/intent reconnect.
- `web/src/lib/error-messages.ts`, `packages/shared` ErrorCode — mã quyền thiếu nếu cần.

## Tasks & Acceptance

**Execution:**
- [ ] BE: `setConnectionStatus`, `markDisconnected`, hàm tính trạng thái từ expires/data_access; cron `connections.token_check` (refresh Threads + recompute + phát sự kiện 1 lần/chu kỳ).
- [ ] BE: nhánh OAuth `intent=reconnect:<pageId>` — cập nhật đúng dòng, về `active` chỉ khi đủ quyền, phát `page.reconnected`; `auth_type=reauthorize` trong URL.
- [ ] BE: adapter `TOKEN_INVALID` → markDisconnected (gồm IG cùng token_source).
- [ ] FE: chip trạng thái vàng/đỏ có chữ + nút "Kết nối lại" ở 3 nơi; wiring API.
- [ ] Test: unit cho hàm tính trạng thái (mọi dòng matrix), cron (fake clock + fake Meta), reconnect (giữ group/config, thiếu quyền), markDisconnected lan sang IG; web test chip + nút.

**Acceptance Criteria:** 4 AC trong epics.md Story 2.4 (đã chép vào frozen block) đều đạt và có test.

## Verification

**Commands:**
- `npm run check` — lint, typecheck, depcruise, test xanh.

## Implementation Notes

## Spec Change Log

## Review Triage Log

### Lượt 1 (blind / edge / verification-gap)
| # | Phát hiện | Verdict | Route |
|---|-----------|---------|-------|
| 1 | Cron ném ở 1 trang (decrypt/network) → chết cả run, không recompute/phát sự kiện các trang khác | high | patch |
| 2 | Token đã quá hạn vẫn hiện `expiring` mãi, cron không hạ xuống `disconnected` | high | patch |
| 3 | Refresh thành công nhưng thiếu/≤0 `expires_in` → giữ hạn cũ, refresh lại mỗi chu kỳ | medium | patch |
| 4 | `resolveIntent` không kiểm platform của trang khớp provider endpoint (threads pageId gửi vào facebook/start) | medium | patch |
| 5 | Dashboard "Kết nối lại" gọi OAuth với id mock (p1..p8) → 400; và `from='pages'` sai | medium | patch |
| 6 | `refreshed` đếm cả ca lỗi/disconnected → log sai | low | patch |
| 7 | `connection_status_reason` không được xoá khi trang về `active` | medium | patch |
| 8 | Chưa có thông báo bền (notification) cho `page.disconnected` | medium | defer (ngoài AC, chạm enum shared) |
| 9 | Thiếu test: Threads reconnect start; FB/Threads không refresh ngoài cửa sổ/age; cron tiếp tục khi 1 trang ném; quá hạn→disconnected | medium | patch |
| 10 | `page.expiring` payload `expiresAt` bị NOTIFY bỏ | false | reject (NOTIFY chỉ mang {type,entity,id,pageId} theo AD-3; expiresAt đi qua pg-boss tới notifications, đã test) |
| 11 | Owner scoping reconnect chưa kiểm | false | reject (app một chủ, mọi trang thuộc chủ) |
| 12 | Reconnect không chặn account khác account đã click | medium | defer (hardening; confirm khớp theo (platform, platformAccountId)) |
| 13 | auth_type=reauthorize có thể Threads không honor | low | reject (vô hại; giữ) |
| 14 | runTokenCheck nạp toàn bảng 2 lần, chưa phân trang | low | reject (quy mô hiện tại) |
