---
title: 'Story 4.6 — Tab Hộp thư, Tiếp quản và Đánh dấu xong'
type: 'feature'
created: '2026-10-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '550468f2300582740e7f70f4240cbdbaa1f49aa9'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 4.6 (PM duyệt), AD-9, AD-18; chủ dự án cho tự duyệt spec">

## Intent

**Problem:** Hộp thư đã có hội thoại thật (4.3, 4.4) nhưng tab lọc trên trang danh sách đã tải ở client, badge "Cần xử lý" chỉ đếm 50 hội thoại đầu, còn Tiếp quản / Đánh dấu xong / công tắc AI đều khoá. Chủ shop không có hàng đợi "cần tôi" đáng tin và không đổi được trạng thái hội thoại.

**Approach:** `inbox` lọc + đếm theo tab ở server (đúng điều kiện AD-9, sắp theo `waiting_since`), thêm ba lệnh chuyển trạng thái của người dùng (Tiếp quản, bật lại AI, Đánh dấu xong) qua cùng máy trạng thái (khoá luồng, `state_version`, tin `system`, `conversation.state_changed`). Web đọc tab/badge từ server, mở khoá ba thao tác và phím `T`.

## Boundaries & Constraints

**Always:**
- `GET /api/v1/conversations?scope=&tab=&cursor=&limit=`, `tab ∈ all|needs_human|ai|done` (mặc định `all`):
  - `all` = mọi trạng thái (gồm `triage`); `ai` = `state='ai'`; `done` = `state='done'`; ba tab này mới nhất trước như cũ;
  - `needs_human` = `handoff`, hoặc `human` mà tin không phải `system` mới nhất là `customer`; sắp theo `coalesce(waiting_since, last_customer_message_at, last_message_at)` tăng dần (chờ lâu nhất trên cùng), rồi `id`; cursor theo đúng khoá sắp.
- `GET /api/v1/conversations/count?scope=&tab=` → `{count}`, cùng điều kiện lọc với danh sách (một hàm điều kiện dùng chung). Badge sidebar và số ở tab dùng `tab=needs_human`.
- Lệnh (dưới phiên, kiểm Origin, trả `ConversationDto` sau khi đổi), mỗi lệnh một transaction mở đầu bằng khoá luồng như ingest:
  - `POST /:id/takeover`: `triage|ai|handoff → human`, `ai_enabled=false`, `TAKEOVER`; xoá tin `app_ai` outbound còn `pending` (chưa gửi). `waiting_since` = giữ/đặt (`waiting_since ?? last_customer_message_at`) nếu tin không phải `system` mới nhất là của khách, ngược lại `null`.
  - `POST /:id/enable-ai`: `human|handoff → ai`, `ai_enabled=true`, `AI_REENABLED`, `waiting_since=null`.
  - `POST /:id/done`: mọi trạng thái trừ `done` → `done`, `ai_enabled=true`, `MARKED_DONE`, `waiting_since=null`.
  - Mỗi lần chuyển: `state_version+1`, `state_reason`, tin `system` có `reason_code` (đứng sau tin mới nhất), phát `conversation.state_changed {from,to,reasonCode,version}`.
  - Đã ở trạng thái đích (takeover ở `human`, enable-ai ở `ai`, done ở `done`) → không ghi gì, trả 200 hội thoại hiện tại. Trạng thái nguồn không hợp lệ (takeover/enable-ai ở `done`, enable-ai ở `triage`) → 409 `VERSION_CONFLICT`. Không có / trang đã gỡ → 404.
- Trước Epic 5, `autoreply.triage` coi cổng AI đóng cả với hội thoại `ai` có tin khách mới: `ai → human` `AI_OFF` (nhánh "cổng không áp dụng" của AD-9), để bật lại AI không làm khách rơi khỏi "Cần xử lý". Quyết định vẫn qua khoá lạc quan `state_version`.
- Web:
  - tab gọi server theo `tab`, khoá query `['conversations','list',scope,tab]`; badge/số tab `['conversations','count',scope,'needs_human']` → hint `conversation.*`/`message.*` sẵn có làm cũ cả hai;
  - "Tiếp quản" (và phím `T` khi không gõ trong ô nhập, không có hộp thoại) khi `triage|ai|handoff`; công tắc "AI tự trả lời" bật = `state='ai'`, dùng được ở `human|handoff|ai` (tắt = Tiếp quản); "Đánh dấu xong" khi khác `done`; lỗi → toast theo `ErrorCode`;
  - hội thoại `handoff`: ghi chú vàng nêu lý do theo `REASON_TEXT` (UX-DR5) + "khách chờ …" tính từ `waitingSince`.

**Never:**
- Không đếm/lọc tab ở client trên trang đã tải.
- Không gửi tin, không mở ô soạn (Story 4.7); "Gợi ý bằng AI" và sửa panel khách vẫn khoá.
- Không để module khác ghi trạng thái hội thoại; `autoreply` chỉ gọi hàm của `inbox`.
- Không thêm cột/migration khi điều kiện tab tính được từ dữ liệu sẵn có.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|---|---|---|---|
| Tab Cần xử lý | `handoff`, `human`+tin khách cuối, `human`+tin người cuối, `triage`, `ai`, `done` | chỉ hai cái đầu, chờ lâu nhất trước; count = 2 | |
| Tab khác | `tab=all|ai|done` | `all` có `triage`; `ai`/`done` đúng trạng thái | `tab` lạ → 400 |
| Phân trang needs_human | > limit hội thoại | cursor không trùng, không sót, đúng thứ tự chờ | cursor hỏng → 400 |
| Phạm vi count | `scope=page:<id>` / trang đã gỡ | chỉ đếm trang trong phạm vi, chưa gỡ | |
| Tiếp quản | `ai` hoặc `handoff` | `human`, `ai_enabled=false`, version+1, tin `system` `TAKEOVER`, `state_changed`; tin `app_ai` `pending` bị xoá, tin `sent` giữ | |
| Tiếp quản đã `human` / ở `done` | | 200 không đổi / 409 | 409 `VERSION_CONFLICT` |
| Tiếp quản đua triage | hội thoại `triage` | `human` `TAKEOVER`; quyết định triage sau đó `stale` | |
| Bật lại AI | `human` (hoặc `handoff`) | `ai`, `ai_enabled=true`, `AI_REENABLED`, `waiting_since=null` | ở `triage`/`done` → 409 |
| Tin khách khi `ai` (trước Epic 5) | | triage → `human` `AI_OFF`, vào Cần xử lý | |
| Đánh dấu xong | `triage|ai|handoff|human` | `done`, `ai_enabled=true`, `waiting_since=null`, `MARKED_DONE` | đã `done` → 200 không đổi |
| Xong rồi khách nhắn | `done` + tin khách | `triage` → `human` `AI_OFF` (4.3, giữ nguyên) | |
| Không có / trang gỡ / không phiên / sai Origin | | | 404 / 404 / 401 / 403 |
| Ghi chú handoff (web) | `handoff`, `stateReason`, `waitingSince` | câu lý do UX-DR5 + "khách chờ x phút" | lý do null → không ghi chú |
| Thao tác hiện theo trạng thái (web) | 5 trạng thái | Tiếp quản / công tắc / Đánh dấu xong đúng bảng trên | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/inbox.ts` -- `InboxTab`, `tab` trong `ConversationsQuery`, `ConversationCountQuery`/`ConversationCountResponse`.
- `server/src/modules/inbox/queries.ts` -- điều kiện tab dùng chung, `listConversations` theo tab + khoá sắp `needs_human`, `countConversations`.
- `server/src/modules/inbox/state.ts` -- `applyUserAction` (takeover / enable_ai / mark_done); `applyTriageDecision` nhận cả `ai`.
- `server/src/modules/inbox/index.ts` -- export mới.
- `server/src/modules/autoreply/triage.ts` -- xử lý `triage|ai`.
- `server/src/app/inbox.ts`, `server/src/app/app.ts` -- route `count`, ba lệnh POST (cần `events`).
- `web/src/lib/inbox.ts` -- hook theo tab, `useNeedsHumanCount`, `useConversationAction`, helper thao tác/ghi chú handoff.
- `web/src/screens/Inbox.tsx`, `web/src/components/AppShell.tsx`, `web/src/components/ui.tsx` (`Switch.disabled`).
- `_bmad-output/implementation-artifacts/deferred-work.md` -- gỡ mục badge đếm phía server.

## Tasks & Acceptance

**Execution:**
- [x] shared: tab, query/response đếm.
- [x] inbox: điều kiện tab + đếm + sắp theo chờ; `applyUserAction`; triage nhận `ai`.
- [x] autoreply: `ai` + tin khách → `human` `AI_OFF` trước Epic 5.
- [x] app: `GET …/count`, `POST …/takeover|enable-ai|done`.
- [x] web: tab/badge server, ba thao tác + phím `T`, ghi chú handoff; `Switch` có `disabled`.
- [x] Test server phủ mọi dòng matrix (tab, đếm, phân trang, lệnh, đua triage, cổng `ai`, lỗi); test helper web (thao tác theo trạng thái, ghi chú handoff, khoá query).
- [x] deferred-work: gỡ mục badge.

**Acceptance Criteria:**
- Given 5 AC của epics.md Story 4.6, when `npm run check`, then đều có test và xanh.
- Given Hộp thư đang mở ở hai tab trình duyệt, when một tab Tiếp quản, then hint `conversation.state_changed` làm cũ danh sách, badge và khung chat ở tab kia.

## Implementation Notes

- **Không có migration.** Điều kiện "Cần xử lý" là subquery tương quan lấy `origin` của tin không phải `system` mới nhất (index `(conversation_id, platform_timestamp, id)` có sẵn). `tabCondition` dùng chung cho danh sách và `count`; `needsAttention()` của DTO là bản TS cùng điều kiện (comment nhắc giữ khớp).
- **Thứ tự "Cần xử lý": chờ lâu nhất trên cùng** (`coalesce(waiting_since, last_customer_message_at, last_message_at)` tăng dần). AC chỉ nói "sắp theo `waiting_since`"; chọn tăng dần vì đây là hàng đợi. Tab khác giữ mới nhất trước.
- **Lệnh** `applyUserAction` ở `inbox/state.ts`, cùng helper `transition` với `applyTriageDecision` (một chỗ ghi `state_version`, `state_reason`, tin `system`, `state_changed`). Lệnh tăng `state_version` nên quyết định triage đang bay tới sau sẽ `stale` (có test đua).
  - Tiếp quản nhận cả `triage` (chủ shop bấm trước khi triage giải xong); đã `human` → 200 không đổi, kể cả khi `ai_enabled` còn `true` (hội thoại `AI_OFF`).
  - "Huỷ tin AI `pending`" = xoá dòng `app_ai` `status='pending'` (chưa từng gửi; `MessageStatus` không có `cancelled`). Story 4.7: job `inbox.send` không thấy dòng thì coi như đã huỷ, không lỗi.
  - Tiếp quản giữ/đặt `waiting_since` khi tin cuối (sau khi xoá tin AI chờ) là của khách, để hội thoại vẫn ở "Cần xử lý".
- **Cổng AI cho hội thoại `ai` trước Epic 5** (ngoài AC, cần để công tắc không tạo "hố đen"): `autoreply.triage` giờ quyết cả `triage` và `ai`; `decideTriage` vẫn luôn `AI_OFF` → `ai → human` (nhánh "cổng không áp dụng" của AD-9), `ai_enabled` giữ `true`. Kết quả: bật lại AI rồi khách nhắn → hội thoại về "Cần xử lý" với ghi chú "AI trả lời chưa bật cho trang này". `applyTriageDecision` có thêm kết quả `noop` khi đã ở đích. Test 4.3 "`ai` giữ trạng thái" đổi theo.
- **API:** `GET /api/v1/conversations?tab=`, `GET /api/v1/conversations/count?scope=&tab=`, `POST /api/v1/conversations/:id/takeover|enable-ai|done` (chỉ đăng ký khi `buildApp` có `events`). Trạng thái nguồn sai → 409 `VERSION_CONFLICT` (FE: "Dữ liệu vừa được thay đổi ở nơi khác…").
- **Web:** tab gọi server (`['conversations','list',scope,tab]`), badge sidebar + số tab dùng `useNeedsHumanCount` (`['conversations','count',scope,'needs_human']`); ô tìm chỉ lọc trong trang đã tải của tab. Đầu khung chat có công tắc "AI tự trả lời" (bật = `ai`; tắt = Tiếp quản), nút Tiếp quản (phím `T`), Đánh dấu xong; lỗi → toast. Ghi chú vàng handoff qua `handoffNote`. `Switch` thêm `disabled`/`title`. Bỏ `matchesTab`/`countNeedsAttention`/`useNeedsAttentionCount`.
- **Việc hoãn:** gỡ mục "badge đếm phía server" ở `deferred-work.md`. Không thêm mục mới.
- Chưa kiểm bằng trình duyệt (cùng lý do 4.3/4.4: cần mật khẩu chủ shop + trang đã kết nối); màn qua typecheck, lint, test helper.
- `npm run check`: server 938 test, web 181 test, depcruise sạch.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|---|---|---|
| Web: chưa chọn hội thoại (`?c=` trống) thì khung chat là `list[0]`; thao tác làm hội thoại rời tab (vd Tiếp quản ở tab "AI đang trả lời", Đánh dấu xong ở "Cần xử lý") → sau refetch khung chat nhảy sang khách khác, công tắc/phím `T` tiếp theo tác động lên khách đó. Sửa: `runAction` ghim id vào `?c=` trước khi gọi lệnh (chi tiết đã `setQueryData`). | thật, trung bình | patch |
| Bật lại AI khi tin không phải `system` mới nhất là của khách: `waiting_since=null`, hội thoại rời "Cần xử lý" sang tab AI nhưng không có gì kích hoạt cổng AI cho tin đang chờ (cổng chỉ chạy khi có `message.received` mới) → khách chờ mà không ai trả lời. | thật, trung bình (đúng spec hiện tại) | defer |

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, lint, depcruise, test đều xanh.
