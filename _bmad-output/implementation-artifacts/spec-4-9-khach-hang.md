---
title: 'Story 4.9 — Khách hàng: danh sách, thẻ, giai đoạn, lịch sử'
type: 'feature'
created: '2026-10-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '7ecf623705dcad514902c45f588497ea29854462'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 4.9 (PM duyệt), AD-1, AD-7, AD-11, AD-18; chủ dự án cho tự duyệt spec">

## Intent

**Problem:** `/khach-hang` còn chạy dữ liệu mẫu, panel khách trong Hộp thư khoá "Sắp có": chủ shop không lọc, gắn thẻ, đổi giai đoạn, ghi chú, lưu SĐT, xem lịch sử nhiều trang, gộp khách hay tóm tắt AI trên khách thật.

**Approach:** `inbox` thêm cột hồ sơ khách (`phone`, `note`, `tags`, tóm tắt AI) + bảng gợi ý gộp, các hàm đọc/ghi khách, `mergeContacts`, job `inbox.contact_summary` (gateway `feature=contact_summary`). Route `app/contacts.ts` giải phạm vi, read-model `app/read-models/contacts.ts` ghép `pageIds` (chỉ trang chưa gỡ) và `handledBy`. Web thay mock bằng API; panel Hộp thư sửa được hồ sơ.

## Boundaries & Constraints

**Always:**
- API dưới phiên (route ghi kiểm Origin): `GET /api/v1/contacts?scope=&stage=&tag=&q=&cursor=&limit=` (cursor `{items,nextCursor}`, mặc định 50; khách thuộc phạm vi khi có định danh trên trang của phạm vi; mới hoạt động nhất trước theo tin mới nhất trong phạm vi), `GET …/contacts/facets?scope=` (tổng, số theo giai đoạn, danh sách thẻ), `GET …/contacts/:id` (chi tiết + hội thoại + gợi ý gộp), `GET …/contacts/:id/messages` (lịch sử), `PATCH …/contacts/:id`, `POST …/contacts/bulk`, `POST …/contacts/:id/merge {sourceId}`, `POST …/contacts/:id/summarize` (202).
- `pageIds` = trang chưa gỡ của các định danh; `handledBy` = `ai` khi hội thoại mới nhất (trong phạm vi) đang `ai`, `human` khi ở trạng thái khác, `null` khi chưa có hội thoại. Ghép ở read-model (Epic 5 thêm `Page.autoReply` tại đây). Khách chỉ còn định danh ở trang đã gỡ → 404 / không trong danh sách.
- Thẻ: tự do, cắt khoảng trắng, 1–40 ký tự, tối đa 50, trùng không phân biệt hoa thường bị bỏ; lọc thẻ không phân biệt hoa thường. SĐT ≤20 ký tự chỉ số, khoảng trắng, `+-.()`; chuỗi rỗng → xoá. Ghi chú ≤5000. Sửa tên được (rỗng → xoá, FE hiện nhãn dự phòng). Mỗi lần ghi phát `contact.updated`.
- Lịch sử: tin không phải `system` của mọi hội thoại của khách trên trang chưa gỡ, mỗi tin kèm `pageId`, `channel`; trang mới nhất trước, `items` cũ → mới; FE nhóm theo hội thoại và ghi rõ trang.
- `mergeContacts(target, source)` trong một transaction (khoá hai dòng): chuyển mọi định danh (hội thoại theo định danh), hợp thẻ, giữ tên/SĐT của đích nếu có, nối ghi chú, giai đoạn của đích (đích `new` → của nguồn), giữ tóm tắt của đích nếu có; chuyển gợi ý gộp với khách thứ ba; xoá nguồn; phát `contact.merged` + `contact.updated`.
- Nhắn riêng có `recipient_id` đã thuộc khách khác (việc hoãn 4.7) → ghi gợi ý gộp (lý do `private_reply`) cho hai khách; chi tiết khách hiện gợi ý + nút gộp. Không tự gộp (AD-11).
- Tóm tắt: route đánh dấu đang chờ + enqueue `inbox.contact_summary` cùng transaction; đang chờ (<10 phút) thì không enqueue lại; khách chưa có tin có chữ → 422. Job: tối đa 40 tin gần nhất có chữ trên trang chưa gỡ (ghi trang, mỗi tin một dòng, cắt 500 ký tự), prompt ở `modules/ai/prompts/`, gateway `feature=contact_summary`, `pageId` = trang hội thoại mới nhất, `ref` = contactId; lưu `aiSummary` + thời điểm; lỗi khoá/hạn mức/chính sách → ghi mã lỗi; lỗi tạm → retry, lần cuối ghi mã. FE hiện nhãn "AI tạo", trạng thái đang tóm tắt / lỗi.
- Web: giai đoạn hiện nhãn Việt (Mới, Đang tư vấn, Chốt đơn, Khách quen, Khiếu nại); realtime `contact.*`/`message.*`/`conversation.*` làm cũ `['contacts', …]`.

**Never:** Không tự gộp khách; không log SĐT, ghi chú, nội dung tin, tóm tắt, prompt; `inbox` không query bảng `pages` trực tiếp, không import `profiles`; không gọi OpenAI thật ở test; không xoá dữ liệu mock mà màn khác (Tổng quan) còn dùng; không làm tìm không dấu (Story 4.10) — `q` chỉ là `ILIKE` đơn giản; không làm xuất CSV.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|---|---|---|---|
| Lọc phạm vi | khách X ở trang A+B, Y ở B, Z ở trang đã gỡ; `scope=page:A` / `all` | A: chỉ X; all: X, Y; X.`pageIds`=[A,B]; Z không có | |
| handledBy | hội thoại mới nhất `ai` / `human` | `ai` / `human`; facets đếm đúng giai đoạn, thẻ | |
| Lọc thẻ / giai đoạn / q | `tag=khiếu nại` (thẻ "Khiếu nại"), `stage=complaint`, `q` theo tên/SĐT | đúng khách; cursor `limit=1` đi hết không trùng | |
| Sửa hồ sơ | PATCH thẻ "Đổi trả", `stage=loyal`, ghi chú, SĐT | lưu, chuẩn hoá thẻ, phát `contact.updated`; hội thoại hiện giai đoạn mới | |
| Sửa sai | stage lạ, SĐT có chữ, body rỗng, thẻ >40 ký tự | | 400 `VALIDATION_FAILED` |
| Lịch sử nhiều trang | DM trang A + bình luận trang B, tin `system` | tin cả hai trang kèm `pageId`, không `system`; cursor lùi | |
| Gộp | đích + nguồn có thẻ, định danh, hội thoại | định danh, hội thoại, thẻ về đích; nguồn 404; sự kiện | |
| Gộp sai | nguồn = đích / không có | | 400 / 404 |
| Gợi ý gộp | nhắn riêng trả `recipient_id` của khách khác | hai khách thấy gợi ý; gộp xong mất | |
| Hàng loạt | `ids` + `addTag` hoặc `stage` | áp cho các khách, không trùng thẻ | 400 khi thiếu/thừa thao tác |
| Tóm tắt | POST, job chạy (fake OpenAI) | 202 `pending`; job ghi `aiSummary`, `ai_usage.feature=contact_summary`; POST lại khi đang chờ không thêm job | 422 khi chưa có tin; khoá thiếu → `failed` + `OPENAI_KEY_MISSING` |
| Không phiên / không có | | | 401 / 404 |

</frozen-after-approval>

## Code Map

- `packages/shared/src/contacts.ts` (MỚI) -- DTO, query, body; `events.ts` thêm `contact.merged`.
- `server/src/modules/inbox/schema.ts` + `drizzle/0020_*` -- cột hồ sơ khách, `contact_merge_suggestions`.
- `server/src/modules/inbox/contacts.ts` (MỚI) -- đọc/sửa/hàng loạt/lịch sử khách, `mergeContacts`, gợi ý gộp.
- `server/src/modules/inbox/contact-summary.ts` (MỚI) -- yêu cầu + job tóm tắt; `ai/prompts/contact-summary.ts` (MỚI).
- `server/src/modules/inbox/queries.ts` -- `toMessageDtos` nhiều hội thoại, `previewsOf` dùng chung.
- `server/src/modules/inbox/send.ts` -- `linkRecipient` ghi gợi ý gộp.
- `server/src/app/read-models/contacts.ts` (MỚI), `server/src/app/contacts.ts` (MỚI), `app.ts`, `worker/main.ts`, `platform/jobs/queues.ts`.
- `web/src/lib/contacts.ts` (MỚI) -- hook + helper thuần; `lib/realtime.ts` -- làm cũ `contacts`.
- `web/src/components/ContactProfile.tsx` (MỚI) -- giai đoạn, thẻ, SĐT, ghi chú, tóm tắt AI (dùng ở hai màn).
- `web/src/screens/Contacts.tsx`, `web/src/screens/Inbox.tsx` -- API thật.

## Tasks & Acceptance

**Execution:**
- [x] shared: DTO khách, sự kiện `contact.merged`.
- [x] inbox: schema + migration, hàm khách, gộp, gợi ý gộp ở `linkRecipient`, job tóm tắt + prompt `ai`; queue + worker.
- [x] app: read-model + route khách.
- [x] web: lib + realtime, `ContactProfile`, màn Khách hàng, panel Hộp thư.
- [x] Test server phủ mọi dòng matrix (Postgres thật, fake OpenAI/Meta); test helper web.

**Acceptance Criteria:**
- Given 5 AC của epics.md Story 4.9, when `npm run check`, then đều có test và xanh; depcruise sạch.

## Implementation Notes

- **Ranh giới (AD-1):** `inbox` trả nguyên liệu (`listContacts`, `contactActivity`: trang theo định danh + hội thoại kèm xem trước trên tập trang) và không đọc bảng `pages`; read-model `app/read-models/contacts.ts` lọc `pageIds` theo trang chưa gỡ (`pages.resolveScope`), chọn `latest`, suy `handledBy` (`ai` khi hội thoại mới nhất đang `ai`, còn lại `human`, chưa có → `null`; Epic 5 thêm `Page.autoReply` tại đây). Route `app/contacts.ts`; khách chỉ còn định danh ở trang đã gỡ → 404 như Hộp thư. depcruise sạch.
- **Schema (`0020_curved_venom.sql`):** `contacts` thêm `phone`, `note`, `tags text[]`, `ai_summary`, `ai_summary_at`, `ai_summary_requested_at`, `ai_summary_error` (không CHECK theo `ErrorCode` để thêm mã sau không cần migration); bảng `contact_merge_suggestions` (một cặp một dòng, cascade).
- **So khớp tiếng Việt:** DB khởi tạo `--locale=C` nên `lower('Đ')` không đổi — lọc thẻ, bỏ trùng khi gắn thẻ hàng loạt và `q` dùng collation builtin `pg_c_utf8` (Postgres ≥17; prod/CI là 18). Bỏ trùng phía TS dùng `dedupeTags` (shared, `toLocaleLowerCase('vi')`).
- **Gộp (`mergeContacts`):** khoá hai dòng `FOR UPDATE` theo id; chuyển định danh (hội thoại/tin đi theo), tên/SĐT của đích nếu có, nối ghi chú, hợp thẻ, giai đoạn của đích trừ `new`, giữ tóm tắt của đích; gợi ý gộp với khách thứ ba chuyển sang đích; xoá nguồn; phát `contact.merged {intoId}` (sự kiện mới, realtime) + `contact.updated`.
- **Việc hoãn 4.7:** nhắn riêng trả `recipient_id` đã thuộc khách khác → `linkRecipient` ghi gợi ý gộp (`suggestMerge`, lý do `private_reply`) + `contact.updated` cho hai khách; KHÔNG tự gộp (AD-11 "gộp chỉ bằng tay"). Ngăn kéo khách hiện gợi ý + "Gộp vào khách này"; panel Hộp thư báo có gợi ý.
- **Tóm tắt AI:** `contact-summary.ts` — route đánh dấu chờ + enqueue `inbox.contact_summary` cùng transaction (đang chờ <10 phút → không enqueue lại, trả 202 chi tiết); job đọc ≤40 tin có chữ (bỏ `system`, tin gửi lỗi, tin xoá/ẩn; mỗi tin một dòng, cắt 500 ký tự, ghi "trang · kênh nền tảng"), prompt `ai/prompts/contact-summary.ts` (không chép SĐT/địa chỉ, chống prompt-injection), gateway `contact_summary` (`pageId` = trang tin mới nhất, `ref` = contactId). Lỗi khoá/hạn mức/chính sách → `ai_summary_error`; `RATE_LIMITED`/OpenAI 5xx → retry, lần cuối ghi mã. Queue: retry 2 backoff, concurrency 2; worker đăng ký handler.
- **`queries.ts`:** `toMessageDtos` nhận dòng của nhiều hội thoại (lịch sử khách), tách `previewsOf` dùng chung cho Hộp thư và hội thoại của khách.
- **Web:** `lib/contacts.ts` (hook + helper thuần), `ContactProfile` (giai đoạn/thẻ lưu ngay; tên/SĐT/ghi chú sửa nháp + "Lưu", ô chưa đụng luôn theo server; "Tóm tắt bằng AI" khoá theo khoá OpenAI/hạn mức qua `AiLockHint`, nhãn "AI tạo"), `Contacts.tsx` thay mock (pipeline đếm theo facets, lọc server + "Xem thêm", hàng loạt, ngăn kéo với lịch sử theo đoạn ghi trang, Gộp khách có xác nhận), panel Hộp thư dùng `ContactProfile` + liên kết "Xem hồ sơ và lịch sử". Realtime: `message`/`conversation` làm cũ `contacts`, `contact` làm cũ `messages`. `useNow` chuyển sang `lib/inbox.ts` dùng chung. Xuất CSV giữ nút khoá "Sắp có"; dữ liệu mock khách giữ cho Tổng quan.
- **Test:** `server/test/contacts.test.ts` (12, phủ mọi dòng matrix), `inbox-send.test.ts` (gợi ý gộp từ nhắn riêng), `notifications.test.ts` (handler queue mới), web `lib/contacts.test.ts`, `lib/realtime.test.ts`. `npm run check`: server 1030 test, web 200 test, xanh.
- Chưa kiểm bằng trình duyệt — ghi ở deferred-work cùng "bỏ qua gợi ý gộp" và tìm không dấu (4.10).

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|---|---|---|
| Job `inbox.contact_summary` hết hạn (120 giây) đúng bằng hết giờ OpenAI và không truyền `job.signal` → pg-boss đánh lỗi + retry trong khi lời gọi cũ vẫn chạy (tính tiền hai lần, chặn worker); huỷ lại bị ghi thành lỗi. Sửa: truyền `job.signal` vào gateway, huỷ thì ném lại không ghi lỗi; hạn job 180 giây. Test: signal huỷ → ném, không gọi OpenAI, vẫn `pending`. | real (medium) | patch |
| Gộp khách: gợi ý của nguồn chuyển sang đích chỉ `on conflict do nothing` cùng chiều → đích đã có cặp chiều ngược thì có hai dòng gợi ý cùng một khách (hiện trùng ở hồ sơ). Sửa: bỏ qua khi cặp ngược đã có. Test kèm. | real (medium) | patch |
| Màn Khách hàng: khách đã chọn giữ nguyên khi đổi phạm vi / bộ lọc / sau gộp → "Gắn thẻ" / "Đổi giai đoạn" hàng loạt sửa cả khách không còn hiện. Sửa: chỉ tính khách đã chọn đang hiện (đếm + gửi). | real (medium) | patch |
| `linkRecipient` (nhắn riêng) đọc `contact_id` của người bình luận / định danh có sẵn rồi mới ghi định danh / gợi ý gộp; gộp khách commit xen giữa → khoá ngoại tới khách nguồn đã xoá lỗi, transaction giao tin hỏng sau khi Meta đã nhận tin. | real (medium, hiếm) | defer |

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, lint, depcruise, test đều xanh.
