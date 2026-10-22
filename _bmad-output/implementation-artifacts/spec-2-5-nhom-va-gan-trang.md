---
title: 'Story 2.5 — Nhóm và gán trang'
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

<frozen-after-approval reason="ACs lấy từ epics.md Story 2.5 (PM duyệt)">

## Intent

**Problem:** Trang đã kết nối nhưng chưa gom được vào nhóm có tên + màu để dùng chung cấu hình và lọc dữ liệu. Chưa có bảng nhóm, hàm gán/gỡ/xoá, API, lẫn giao diện quản lý nhóm (hiện FE dùng dữ liệu mẫu).

**Approach:** Thêm bảng nhóm (id, name, color `group-1..8`, createdAt) + hàm `pages.assignGroup / unassignGroup / createGroup / renameGroup / deleteGroup`; mỗi lần đổi thành viên phát `page.group_changed` trong cùng transaction, xoá nhóm phát `group.deleted {groupId, memberPageIds}`. API trả trước "danh sách ảnh hưởng" khi chuyển trang khỏi nhóm cũ (nhóm cũ + chiến dịch đang chạy dùng trang qua read-model — rỗng vì Epic 7 chưa có) để FE hiện modal xác nhận. Nối FE Trang & Nhóm (thẻ nhóm, bảng trang, thanh thao tác chọn nhiều, tạo/sửa/xoá nhóm) vào API thật, giữ nguyên UX hiện có (8 màu, trạng thái rỗng).

## Boundaries & Constraints

**Always (bám 4 AC epics.md Story 2.5):**
- Tạo nhóm: tên + một màu trong bảng 8 màu `group-1..8`. Gán nhiều trang qua `pages.assignGroup`, MỖI lần gán phát `page.group_changed {fromGroupId, toGroupId}` trong cùng transaction với thay đổi.
- Mỗi trang tối đa **một** nhóm. Chuyển trang sang nhóm khác: API trả trước danh sách ảnh hưởng (nhóm cũ; chiến dịch đang chạy dùng trang — read-model, rỗng khi chưa có Epic 7). FE hiện modal "Trang này sẽ chuyển khỏi …". Chỉ khi xác nhận mới đổi.
- Sửa tên/màu, hoặc xoá nhóm (có xác nhận) → `pages.deleteGroup` gỡ nhóm khỏi MỌI trang, phát `group.deleted {groupId, memberPageIds}` (cùng transaction).
- Chưa có nhóm → trạng thái rỗng "Chưa có nhóm nào. Gom các trang cùng chủ đề để dùng chung cấu hình."
- Mọi route cần phiên (AD-19), kiểm Origin cho ghi. Màu validate bằng zod enum `group-1..8`. Tên nhóm: cắt khoảng trắng, không rỗng, giới hạn độ dài hợp lý; [ASSUMPTION] cho phép trùng tên.

**Never:** Không đụng cơ chế kết nối/token. Trang không thể thuộc >1 nhóm. Không đổi cấu hình kế thừa nhóm (đó là Epic 3 — ở đây chỉ gán thành viên). Không tự suy diễn hành vi profiles khi đổi nhóm (Story 3.3 xử lý) — chỉ phát `page.group_changed`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|----------|--------------|----------|-------|
| Tạo nhóm + gán | chọn 3 trang, tên "Nhóm Mỹ phẩm", màu group-2 | nhóm tạo, 3 trang groupId=nhóm, 3 sự kiện page.group_changed | tên rỗng/màu lạ → VALIDATION_FAILED |
| Xem ảnh hưởng | trang đang ở nhóm A, xin chuyển sang B | trả {fromGroup: A, campaigns: []} trước khi đổi | trang/nhóm không tồn tại → 404 |
| Xác nhận chuyển | confirm | trang.groupId=B, phát page.group_changed {A,B} | |
| Gỡ khỏi nhóm | unassign | groupId=null, page.group_changed {A,null} | |
| Xoá nhóm | nhóm có 3 trang | 3 trang groupId=null, group.deleted {groupId, [3 id]} | |
| Sửa tên/màu | rename/recolor | cập nhật, không đổi thành viên | |
| Danh sách rỗng | chưa có nhóm | trả [] → FE hiện trạng thái rỗng | |
| Gán trang đã ở đúng nhóm đó | no-op | không phát sự kiện thừa | |

</frozen-after-approval>

## Code Map (điểm xuất phát — subagent điều tra thêm)

- `server/src/modules/pages/schema.ts` — `pagesTable.groupId` đã có; thêm bảng `page_groups` (id uuidv7, name, color, created_at) + FK groupId → page_groups(id) onDelete set null (hoặc xử lý ở app khi deleteGroup).
- `server/src/modules/pages/service.ts`, `index.ts` — thêm createGroup/renameGroup/recolor/deleteGroup/assignGroup/unassignGroup/listGroups/affectedByMove; phát sự kiện qua `publishEvent(tx, …)` trong cùng transaction.
- `server/src/app/` — route nhóm dưới `/api/v1` (vd `/groups`, `/groups/:id`, `/pages/:id/group`); zod request/response ở `packages/shared`.
- `packages/shared/src/events.ts` — `group.deleted` đổi payload thành `{ groupId, memberPageIds }` (hiện `{}`); `page.group_changed` giữ.
- `packages/shared/src/` — thêm GroupColor enum `group-1..8`, GroupDto, request/response schemas; map màu phải khớp DESIGN token FE.
- `web/src/screens/PagesGroups.tsx`, `web/src/lib/` — nối thẻ nhóm, thanh chọn nhiều, modal tạo/sửa/xoá + modal xác nhận chuyển vào API thật; bỏ dữ liệu nhóm mẫu; giữ 8 màu + trạng thái rỗng theo DESIGN/EXPERIENCE.
- UX: `_bmad-output/planning-artifacts/ux-designs/` (Trang & Nhóm, Chi tiết nhóm, Component "Bảng trang").

## Tasks & Acceptance

**Execution:**
- [ ] BE: bảng `page_groups` + migration; hàm nhóm trong pages service (phát sự kiện trong transaction); read-model affectedByMove (campaigns rỗng).
- [ ] shared: GroupColor, GroupDto, schemas; sửa payload `group.deleted`.
- [ ] API routes nhóm + gán/gỡ/chuyển (có bước trả ảnh hưởng trước khi đổi).
- [ ] FE: nối Trang & Nhóm vào API thật (thẻ nhóm, chọn nhiều, tạo/sửa/xoá, modal xác nhận chuyển, trạng thái rỗng).
- [ ] Test: server (tạo+gán phát N sự kiện, chuyển nhóm trả ảnh hưởng rồi đổi, xoá nhóm gỡ mọi trang + group.deleted payload, một-nhóm-mỗi-trang, no-op không phát sự kiện); web (modal xác nhận chuyển, trạng thái rỗng, tạo nhóm).

**Acceptance Criteria:** 4 AC trong epics.md Story 2.5 (frozen) đạt và có test.

## Verification
**Commands:** `npm run check` — xanh.

## Implementation Notes

## Spec Change Log

## Review Triage Log

### Lượt 1 (blind / edge / verification-gap) — triage
| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| GroupDetail.tsx vẫn sửa mock store cho nhóm thật (add/remove member, rename no-op, bị revert khi refetch) | high | patch |
| Migration ADD CONSTRAINT FK có thể lỗi nếu pages.group_id mồ côi (đã có DB thật) | medium | patch (NULL-out phòng vệ) |
| preview bỏ im pageId lạ, assign lại 404 cả batch — không nhất quán | medium | patch (preview 404 pageId lạ) |
| requestAssign gate theo client pagesLeavingGroup → state cũ bỏ qua modal | medium | patch (luôn gọi server preview) |
| unassign/delete không reset brandSource overlay về 'own' | low | patch |
| fromGroups trả nhưng FE không dùng, không ORDER BY | low | patch (bỏ fromGroups) |
| Thiếu test: tạo nhóm/empty-state/move-modal (web), GroupName max 60, assign pageIds rỗng | medium | patch |
| Migration meta thiếu | false | reject (đã verify journal+snapshot, drizzle-kit check OK) |
| page.group_changed pageId ngoài schema | false | reject (BasePayload có pageId.optional) |
| Bảng "groups" vs spec "page_groups"; renameGroup vs updateGroup | false | reject (code đúng, chữ trong spec) |
| hex cứng vs token; N+1 bulk≤1000; updated_at chết; tenant scoping; Origin test mỗi route | — | reject (quy mô/một chủ; Origin có guard chung đã test) |
