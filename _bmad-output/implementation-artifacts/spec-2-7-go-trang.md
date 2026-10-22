---
title: 'Story 2.7 — Gỡ trang khỏi app'
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

<frozen-after-approval reason="ACs lấy từ epics.md Story 2.7 (PM duyệt)">

## Intent

**Problem:** Chưa có cách gỡ một trang không còn quản lý. Hạ tầng đã sẵn (`page.removed`, cột `removed_at`, `upsertFromPlatform` khôi phục đúng dòng cũ khi kết nối lại) nhưng thiếu hàm gỡ, route, và nút "Gỡ trang" ở Cài đặt.

**Approach:** Thêm `connections.removePage(pageId)` — soft-delete (`removed_at`), xoá token (`page_credentials`), phát `page.removed`, tất cả trong một transaction (AD-3); route xoá; FE "Gỡ trang" + modal xác nhận ở Cài đặt › Tài khoản Meta, sau khi gỡ trang biến khỏi Bộ chọn phạm vi và bảng trang. Kết nối lại sau đó: `upsertFromPlatform` khôi phục đúng dòng cũ (xoá `removed_at`), giữ lịch sử — đã có, chỉ cần test.

## Boundaries & Constraints

**Always (bám 2 AC epics.md Story 2.7):**
- Gỡ trang (có xác nhận) → soft-delete `removed_at=now()`, xoá token của trang (`page_credentials` của trang; nếu trang là nguồn token cho IG — AD: token_source — cân nhắc trang IG phụ thuộc: ở story này gỡ một trang do chủ shop chọn, xoá credential của chính trang đó; [ASSUMPTION] gỡ Fanpage nguồn token thì IG liên kết cũng mất khả năng gọi — xử lý tối thiểu: vẫn chỉ gỡ trang được chọn, ghi chú rủi ro). Phát `page.removed` (cùng transaction). Trang biến khỏi `resolveScope`/bảng trang (đã lọc `removed_at`), khỏi Bộ chọn phạm vi (FE refetch).
- Kết nối lại trang đã gỡ: confirm OAuth → `upsertFromPlatform` khôi phục đúng dòng cũ (xoá `removed_at`, giữ id/nhóm/cấu hình/lịch sử), về `active` khi đủ quyền. (Đã có — thêm test.)
- Route cần phiên (AD-19), kiểm Origin ghi. pageId không tồn tại/đã gỡ → 404 (hoặc idempotent 204 nếu đã gỡ — chọn một, test). Lịch sử (hội thoại, bài, số liệu — các epic sau) KHÔNG bị xoá, chỉ trang bị đánh dấu gỡ.

**Never:** Không hard-delete trang hay dữ liệu lịch sử. Không xoá credential của trang khác. Không đụng module ngoài connections/pages + FE. Không tạo dòng mới khi kết nối lại (dùng upsert khôi phục).

## I/O & Edge-Case Matrix

| Scenario | Input | Expected | Error |
|----------|-------|----------|-------|
| Gỡ trang | pageId hợp lệ, đang active | removed_at set, token xoá, page.removed phát, 204/200 | |
| Gỡ trang đã gỡ | pageId đã removed | idempotent (204) hoặc 404 — nhất quán + test | |
| Gỡ pageId lạ | không tồn tại | 404 | |
| Sau gỡ: list | GET /pages | không còn trang đó | |
| Sau gỡ: scope | resolveScope all | không gồm trang đó; nếu đang chọn page:<id> đó → FE về all | |
| Kết nối lại trang đã gỡ | OAuth confirm cùng (platform, account) | khôi phục dòng cũ, removed_at=null, giữ id/nhóm/lịch sử, active | |
| Chưa đăng nhập | DELETE không phiên | 401 | |
| Origin lạ (ghi) | DELETE Origin ngoài allowlist | 403 | |

</frozen-after-approval>

## Code Map (điểm xuất phát — subagent điều tra thêm)

- `server/src/modules/pages/service.ts`, `index.ts` — thêm `removePage(tx, pageId)` (soft-delete + phát `page.removed` qua `publishEvent(tx,…)`); chỉ `connections` gọi (AD-5). Hoặc đặt ở connections gọi pages.setRemoved — theo ranh giới hiện có (connections sở hữu token, pages sở hữu bảng). Xoá `page_credentials` do connections (`credentials.ts`).
- `server/src/modules/connections/credentials.ts`, `index.ts` — hàm xoá credential của trang; export `removePage` cấp connections (gói soft-delete pages + xoá token + sự kiện trong một transaction).
- `server/src/app/` — `DELETE /api/v1/pages/:id` (hoặc `/connections/pages/:id`); zod param uuid; 404/idempotent nhất quán.
- `packages/shared/src/events.ts` — `page.removed` đã có (payload `{}` + base id/pageId).
- `web/src/screens/Settings.tsx` — mục Tài khoản Meta: nút "Gỡ trang" cho từng trang + modal xác nhận (mẫu như "Gỡ khoá OpenAI"); gọi API, invalidate `['pages']`/`['groups']`; nếu scope đang là page vừa gỡ → về all (app-context đã có effectiveScope lo khi refetch).
- `web/src/lib/connections.ts` — `useRemovePage` mutation.
- UX: [ASSUMPTION] EXPERIENCE chưa mô tả "Gỡ trang"; đặt ở Cài đặt › Tài khoản Meta, giọng + modal theo Interaction Primitives (hành động phá huỷ = nút đỏ + xác nhận).

## Tasks & Acceptance

**Execution:**
- [ ] BE: `connections.removePage(pageId)` (soft-delete pages + xoá token + phát page.removed, một transaction); route DELETE; 404/idempotent nhất quán.
- [ ] FE: nút "Gỡ trang" + modal xác nhận ở Cài đặt › Tài khoản Meta; `useRemovePage`; refetch để trang biến khỏi bảng + bộ chọn.
- [ ] Test: server (gỡ → removed_at+token xoá+page.removed; list không còn; resolveScope không gồm; 404 id lạ; idempotent/404 cho đã gỡ; 401/403; kết nối lại khôi phục dòng cũ giữ nhóm/lịch sử + removed_at null); web (modal xác nhận gỡ, mutation gọi API).

**Acceptance Criteria:** 2 AC epics.md Story 2.7 (frozen) đạt và có test.

## Verification
**Commands:** `npm run check` — xanh.

## Implementation Notes

## Spec Change Log

## Review Triage Log

### Lượt 1 (blind / edge / verification-gap) — triage
| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Gỡ Fanpage nguồn token → IG liên kết vẫn `active` (token mất) | medium | patch (cascade disconnect IG cùng token_source trong transaction + page.disconnected + test) |
| Nút/toast "Gỡ trang" cứng, không theo nền tảng (mâu thuẫn modal "tài khoản" cho Threads) | low | patch (dùng removePageConfirm noun cho nút + toast) |
| setRemoved dựng PageDto không ai dùng | low | patch (trả boolean/tồn tại) |
| Scope = trang vừa gỡ → về all chưa test | false | reject (effectiveScope đã test ở 2.6; VG xác nhận) |
| Lock FOR UPDATE của gỡ song song chưa test | low | defer (khó test tất định) |
| useRemovePage invalidation chưa test | low | defer (web chưa có harness hook/render) |
| DELETE /pages/:id đăng ở connections, GET /pages ở pages | — | reject (DELETE xoá token → connections sở hữu; ghi chú) |
| sessionIdOf side-effect; event id==pageId | — | reject (id = entity id, pageId ở base payload) |
