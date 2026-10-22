---
title: 'Story 2.6 — Bộ chọn phạm vi lọc dữ liệu thật'
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

<frozen-after-approval reason="ACs lấy từ epics.md Story 2.6 (PM duyệt)">

## Intent

**Problem:** FE đã có Bộ chọn phạm vi (AppShell `ScopeSwitcher`, `app-context` Scope/scopedPages/inScope) nhưng chạy thuần trên kho mẫu; chưa có helper BE `pages.resolveScope` và chưa có endpoint danh sách lọc theo phạm vi thật. Cần: tìm không dấu trong bộ chọn, nhớ lựa chọn ở localStorage, và đảm bảo 4 màn không-lọc giữ đúng EXPERIENCE.md.

**Approach:** Thêm `pages.resolveScope(scope)` — helper DUY NHẤT dịch `all|group:<id>|page:<id>` → tập `pageId`; endpoint danh sách nhận `scope`, thực thể nhiều trang thuộc phạm vi khi tập trang của nó giao tập phạm vi khác rỗng. FE: bộ chọn lấy danh sách trang/nhóm từ API (đã mirror), tìm không dấu, nhớ ở localStorage; các màn Soạn bài AI, Trang & Nhóm, AI trả lời, Cài đặt KHÔNG lọc theo phạm vi.

## Boundaries & Constraints

**Always (bám 3 AC epics.md Story 2.6):**
- `pages.resolveScope(scope)` là helper DUY NHẤT dịch phạm vi → tập pageId (server). `all` = mọi trang chưa gỡ; `group:<id>` = trang thuộc nhóm; `page:<id>` = một trang. Validate scope bằng zod; id không tồn tại/không hợp lệ → VALIDATION_FAILED/404 nhất quán.
- Endpoint danh sách (hiện tại: `GET /pages`; cộng mọi list endpoint khác đang có nhận scope nếu hợp lý) nhận `scope=all|group:<id>|page:<id>`, trả tập pageId tương ứng. Thực thể nhiều trang: thuộc phạm vi khi tập trang của nó ∩ tập phạm vi ≠ ∅ (chuẩn bị cho các epic sau; tài liệu hoá helper này).
- Bộ chọn phạm vi ở thanh trên: danh sách trang/nhóm lấy từ API; tìm **không dấu** (gõ "my pham" khớp "Mỹ phẩm" — chuẩn hoá NFD, bỏ dấu, lower, cả query lẫn nhãn). Lựa chọn nhớ ở **localStorage** của trình duyệt (khôi phục khi mở lại; phạm vi trỏ tới trang/nhóm đã biến mất → về `all`).
- Các màn **Soạn bài AI (Composer), Trang & Nhóm (PagesGroups), AI trả lời tự động (AutoReply), Cài đặt (Settings)** KHÔNG bị lọc theo phạm vi (đúng EXPERIENCE.md). Các màn dữ liệu khác (Tổng quan, Hiệu suất, Hộp thư, Khách hàng, Lịch, Chiến dịch) lọc theo.

**Never:** Không nhân bản logic dịch phạm vi (chỉ `resolveScope`). Không đổi hành vi nhóm/kết nối. Không lọc 4 màn nêu trên. Không lưu phạm vi ở server (chỉ localStorage mỗi trình duyệt).

## I/O & Edge-Case Matrix

| Scenario | Input | Expected | Error |
|----------|-------|----------|-------|
| resolveScope all | scope=all | mọi pageId chưa gỡ | |
| resolveScope group | group:<id> có 3 trang | 3 pageId | id lạ → 404 |
| resolveScope page | page:<id> | [pageId] | id lạ → 404 |
| scope rỗng/sai cú pháp | "foo" | VALIDATION_FAILED | |
| list theo scope | GET /pages?scope=group:<id> | chỉ trang nhóm đó | |
| tìm không dấu | gõ "my pham" | khớp "Mỹ phẩm" (trang & nhóm) | |
| nhớ localStorage | chọn group X, reload | vẫn group X | group X đã xoá → về all |
| màn không lọc | đổi scope ở Composer/PagesGroups/AutoReply/Settings | nội dung không đổi theo scope | |

</frozen-after-approval>

## Code Map (điểm xuất phát — subagent điều tra thêm)

- `server/src/modules/pages/service.ts` / `groups.ts` — thêm `resolveScope(deps, scope)`; `listPages` nhận scope (lọc theo tập pageId). Phân tích/validate scope ở `packages/shared` (zod `Scope` = discriminated union all|group|page, hoặc chuỗi `all|group:<id>|page:<id>` + parser).
- `server/src/app/` — route danh sách nhận query `scope`; áp cho `GET /pages` (và list endpoint khác nếu có). 404/validation nhất quán.
- `packages/shared/src/` — `Scope` schema + parse/format helpers dùng chung BE/FE; GroupDto/PageDto đã có.
- `web/src/lib/app-context.tsx` — `Scope` type (đã có), `scopedPages`, `inScope`, `scopeLabel`; thêm/sửa: nhớ localStorage (key ổn định), khôi phục an toàn (scope trỏ tới id đã mất → all), danh sách từ API đã mirror.
- `web/src/components/AppShell.tsx` `ScopeSwitcher` — thêm ô tìm không dấu; danh sách trang/nhóm từ context (API).
- `web/src/screens/{Composer,PagesGroups,AutoReply,Settings}.tsx` — xác nhận KHÔNG dùng scopedPages/inScope (hoặc gỡ nếu đang lọc nhầm); các màn còn lại giữ lọc.
- UX: `ux-designs/` (Mô hình khái niệm › Phạm vi; Component "Bộ chọn phạm vi"); EXPERIENCE.md (màn nào lọc).

## Tasks & Acceptance

**Execution:**
- [ ] shared: `Scope` schema + parse/format (`all` | `group:<id>` | `page:<id>`), dùng chung.
- [ ] BE: `pages.resolveScope`; `GET /pages` (+ list endpoint khác) nhận scope; test resolveScope (all/group/page/giao tập), 404/validation.
- [ ] FE: tìm không dấu trong ScopeSwitcher; nhớ localStorage + khôi phục an toàn; đảm bảo 4 màn không lọc.
- [ ] Test: web — chuẩn hoá không dấu (helper), khôi phục localStorage (scope mất → all), inScope theo giao tập; không-lọc ở 4 màn (nếu có helper).

**Acceptance Criteria:** 3 AC epics.md Story 2.6 (frozen) đạt và có test.

## Verification
**Commands:** `npm run check` — xanh.

## Implementation Notes

## Spec Change Log

## Review Triage Log

### Lượt 1 (blind / edge / verification-gap) — triage
| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| listPages 'all' re-implement query (không qua resolveScope) + group/page 2 SELECT | medium | patch (qua resolveScope, 1 query) |
| normalizeText regex combining marks ký tự ẩn, thiếu cờ `u` | low | patch (̀-ͯ + /gu) |
| scopeLabel nhóm mất → hiện "Tất cả trang" (nhãn sai) | low | patch (fallback an toàn) |
| Dẫn xuất provider scope→{scope,scopedPages,scopeLabel} chưa có test | medium | patch (tách helper thuần + test removed id→all) |
| formatScope không ai gọi; FE không gửi scope lên /pages | false | reject (prep cho endpoint lọc server ở Epic 4/8; selector cần mọi trang → lọc client; ghi Implementation Notes) |
| Composer đọc scope | false | reject (pre-select trang đích theo EXPERIENCE, không lọc nội dung) |
| intersectsScope chỉ test FE | low | reject (khái niệm FE; prep) |
| /groups /notifications không nhận scope | false | reject (spec hedge "nếu hợp lý"; không cần) |
| teardown UPDATE thừa + double try/catch | low | patch (dọn nhẹ) |

**Implementation Notes:** /pages của bộ chọn giữ KHÔNG lọc (selector cần mọi trang; lọc client trên kho mirror). `ScopeParam`/`formatScope`/`intersectsScope` là hợp đồng dùng chung, chuẩn bị cho endpoint lọc server ở Epic 4 (hộp thư) & 8 (hiệu suất). /groups, /notifications cố ý không nhận scope. Composer đọc scope để pre-select trang đích (EXPERIENCE cho phép), không phải lọc.
