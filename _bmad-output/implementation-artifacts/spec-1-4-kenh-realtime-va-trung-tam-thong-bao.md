---
title: 'Story 1.4 — Kênh realtime và trung tâm thông báo'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: 'NO_VCS' # snapshot scratchpad/baseline-1-4
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-2-dang-nhap-chu-so-huu-va-lop-goi-api.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Giao diện chỉ thấy thay đổi khi tải lại trang, và việc nền (AI chuyển người, token sắp hết hạn, đăng bài lỗi, chiến dịch tạm dừng, job hỏng) không báo cho chủ shop.

**Approach:** Một đường phát sự kiện miền duy nhất ở `platform/events`: ghi pg-boss `publish` trong transaction, và nếu sự kiện có `realtime=true` thì `pg_notify('realtime', …)` trong cùng transaction (chỉ tới khi commit). api giữ một kết nối LISTEN và phát tới mọi tab qua SSE `GET /api/v1/stream`. Web nối SSE, vô hiệu hoá cache theo thực thể, hiện "Đang kết nối lại…" khi mất kết nối. Module `notifications` nhận sự kiện qua queue, tạo thông báo theo cài đặt bật/tắt, đẩy toast, có danh sách trong chuông ở thanh trên.

## Boundaries & Constraints

**Always:** AD-3 (danh mục sự kiện ở `packages/shared/events.ts`, payload realtime `{type, entity, id, pageId}` ≤1 KB, module không tự NOTIFY, client chỉ refetch qua REST, consumer idempotent theo `(event, id, version)`), AD-24 (queue consumer khai báo trong `queues.ts`; job hết retry phát `job.failed`), AD-1 (`notifications` chỉ được entrypoint gọi; module khác báo qua sự kiện). Server gửi ping SSE mỗi 10 giây; client coi mất kết nối khi 25 giây không nhận gì, nối lại có backoff 1→2→4…≤30 giây. Khoá truy vấn của web bắt đầu bằng tên thực thể (`['notifications', …]`) để realtime vô hiệu hoá đúng nhóm. Loại thông báo: `ai_handoff`, `token_expiring`, `publish_failed`, `campaign_paused`, `system_error` (job hỏng ở queue quan trọng); mặc định bật cả, trừ `campaign_paused` theo mock hiện có [ASSUMPTION]. Danh sách thông báo mở dạng ngăn kéo từ chuông [ASSUMPTION: EXPERIENCE.md chưa mô tả]. Có lệnh dev `npm run emit-event -w server` để phát sự kiện thử (không có route HTTP) [ASSUMPTION].

**Never:** Không dựng producer thật của các sự kiện (thuộc story sau). Không dùng WebSocket. Không đưa nội dung thực thể vào payload realtime. Không email/push.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Sự kiện realtime | `publishEvent(tx, 'page.expiring', …)` rồi commit | mọi SSE đang mở nhận `event: page.expiring`, `data: {type,entity,id,pageId}` ≤3 giây | payload >1 KB → từ chối khi phát (lỗi lập trình) |
| Transaction rollback | phát sự kiện rồi rollback | không SSE nào nhận, không job nào được tạo | N/A |
| Sự kiện không realtime | `job.failed` | không NOTIFY; consumer queue vẫn nhận | N/A |
| SSE chưa đăng nhập | `GET /api/v1/stream` không phiên | 401 JSON `UNAUTHENTICATED` | N/A |
| Mất kết nối | không nhận gì 25 giây / lỗi mạng | dải xám "Đang kết nối lại…", nối lại có backoff | khi nối lại: refetch mọi query đang mở, ẩn dải xám |
| LISTEN rớt ở api | kết nối LISTEN bị đóng | api tự nối lại LISTEN; client vẫn sống | log `warn` |
| Thông báo bật | `conversation.state_changed` với `to=handoff` và `ai_handoff` bật | tạo 1 thông báo, phát `notification.created` (realtime) → web toast + chấm đỏ ở chuông | N/A |
| Thông báo tắt | loại tương ứng tắt ở Cài đặt › Thông báo | không tạo | N/A |
| Sự kiện lặp | cùng `(event, id, version)` tới 2 lần | chỉ 1 thông báo | ràng buộc unique `dedupe_key` |
| Job hỏng | handler ném lỗi ở lần thử cuối của queue | phát `job.failed {queue, jobId}`; thông báo `system_error` chỉ khi queue thuộc danh sách quan trọng | N/A |
| Đọc thông báo | mở ngăn kéo / bấm "Đánh dấu đã đọc tất cả" | `unreadCount` về 0 | N/A |

</frozen-after-approval>

## Code Map

- `packages/shared/src/events.ts` -- `EVENTS`, `BasePayload`, `isEventName`; thêm `notification.created` (realtime) và hàm `realtimeHint(name, payload)` dựng `{type, entity, id, pageId}` (entity = phần trước dấu chấm).
- `server/src/platform/jobs/{queues.ts,boss.ts}` -- registry + `ensureQueues`/`startWorkers`; thêm queue consumer `events.notifications` và khai báo subscription sự kiện → queue trong registry; bọc handler để phát `job.failed` ở lần thử cuối.
- `server/src/platform/db/index.ts` -- `createDb` (postgres.js); `sql.listen` có sẵn cho LISTEN tự nối lại.
- `server/src/app/{app.ts,auth/index.ts}` -- guard đã bảo vệ mọi `/api/v1/*`; route SSE đặt dưới `/api/v1/stream`.
- `server/src/modules/settings/schema.ts` -- thêm bảng `settings(key pk, value jsonb, updated_at)` ở đây (module settings sở hữu).
- `web/src/lib/api.ts`, `web/src/lib/auth.tsx` -- `QueryClient`, `RequireAuth`: gắn hook realtime bên trong vùng đã đăng nhập.
- `web/src/lib/app-context.tsx` -- `notify(msg)` toast hiện có: dùng lại.
- `web/src/components/AppShell.tsx:202` -- nút chuông có chấm đỏ cứng: nối `unreadCount`, mở ngăn kéo (`Drawer` trong `ui.tsx`).
- `web/src/screens/Settings.tsx:92,420` -- state `notifs` giả và danh sách `NOTIFY_ITEMS`: nối API, giữ nút "Lưu thay đổi".

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/events.ts`, `packages/shared/src/notifications.ts` -- `notification.created`, `realtimeHint`, zod cho `Notification`, `NotificationType`, `NotificationPrefs`, request/response API.
- [x] `server/src/platform/events/index.ts` -- `publishEvent(tx, name, payload)`: parse payload, `boss.publish(name, payload, { db: tx })`, nếu realtime thì `select pg_notify('realtime', $hint)` trong `tx`.
- [x] `server/src/platform/realtime/index.ts` -- `RealtimeHub`: một `sql.listen('realtime')`, quản lý client SSE, ping 10 giây, gỡ client khi đóng.
- [x] `server/src/app/stream.ts` -- `GET /api/v1/stream` (text/event-stream, `X-Accel-Buffering: no`, `retry: 3000`, `event: ready` đầu tiên).
- [x] `server/src/platform/jobs/{queues.ts,boss.ts}` -- queue `events.notifications`, subscription, phát `job.failed`.
- [x] `server/src/modules/settings/{schema.ts,prefs.ts,index.ts}` + migration -- bảng `settings`, `getNotificationPrefs`, `setNotificationPrefs` (phát `settings.updated`).
- [x] `server/src/modules/notifications/{schema.ts,service.ts,index.ts}` + migration -- bảng `notifications(id, type, title, body, entity, entity_id, page_id, dedupe_key unique, read_at, created_at)`, `handleEvent`, `list`, `markRead`; thêm `notifications` vào `server/dependency-rules.cjs` (chỉ phụ thuộc nền).
- [x] `server/src/worker/main.ts` -- đăng ký consumer `events.notifications`.
- [x] `server/src/app/notifications.ts` -- `GET /api/v1/notifications`, `POST /api/v1/notifications/read`, `GET/PUT /api/v1/settings/notifications`.
- [x] `server/scripts/emit-event.ts` + script `emit-event` -- phát một sự kiện bất kỳ trong danh mục (dev, chặn khi `NODE_ENV=production`).
- [x] `server/test/{events,realtime,notifications}.test.ts` -- phủ các dòng phía server của ma trận.
- [x] `web/src/lib/realtime.ts` -- hook `useRealtime()`: EventSource, watchdog 25 giây, backoff, `invalidateQueries({queryKey:[entity]})`, nối lại → `refetchQueries({type:'active'})`; trạng thái kết nối qua context.
- [x] `web/src/lib/notifications.ts`, `web/src/components/NotificationsDrawer.tsx`, `web/src/components/AppShell.tsx` -- query danh sách + `unreadCount`, toast khi `notification.created` (lấy chữ qua REST), dải xám "Đang kết nối lại…" ở đầu vùng nội dung.
- [x] `web/src/screens/Settings.tsx` -- mục Thông báo đọc/ghi API.
- [x] `web/src/lib/realtime.test.ts` -- watchdog, backoff, vô hiệu hoá theo entity (EventSource giả).

**Acceptance Criteria:**
- Given đã đăng nhập ở hai tab, when chạy `npm run emit-event -w server -- conversation.state_changed '{...to:"handoff"...}'`, then cả hai tab hiện toast và chấm đỏ ở chuông trong ≤3 giây; mở chuông thấy thông báo.
- Given tắt "AI chuyển cho bạn" ở Cài đặt › Thông báo và lưu, when phát lại sự kiện đó, then không có thông báo mới.
- Given `npm run check`, when chạy, then thoát 0.

## Implementation Notes

- **Envelope sự kiện:** một queue subscribe nhiều sự kiện nên `publishEvent` gửi `boss.publish(name, {event, payload}, {db})` (envelope `EventEnvelope` ở `platform/events`), không gửi payload trần; consumer dùng `parseEventEnvelope` (kiểm lại zod). `publishEvent` là method của `EventPublisher` (`createEventPublisher(boss)`), được truyền vào module/entrypoint.
- **Transaction:** `bossDbFor(executor)` (`platform/db`) bọc client postgres.js bên dưới tx Drizzle (`tx._.session.client.unsafe`) thành `db` của pg-boss → job và `pg_notify` cùng commit/rollback. `DbExecutor = Db | Tx`.
- **api có pg-boss riêng** (`createBoss(…, {background:false})` = `supervise:false, schedule:false`) chỉ để phát sự kiện (vd `settings.updated`); bảo trì/cron vẫn ở worker. `buildApp` nhận `events?` (đăng ký route thông báo) và `realtime?` (đăng ký `/api/v1/stream`; hook `preClose` đóng stream để `app.close()` không treo).
- **Registry (`queues.ts`):** thêm `subscribes`, `critical`, `pollingIntervalSeconds`; `ensureQueues` đồng bộ subscription (thêm thiếu, gỡ thừa — chỉ với queue thuộc registry). Queue `events.notifications`: retry 3 backoff, poll 0,5 giây (để ≤3 giây), KHÔNG `critical`. `startWorkers` dùng `includeMetadata` và phát `job.failed {id, queue, jobId}` khi lỗi ở lần thử cuối (`retryCount >= retryLimit`); job đang xử lý chính `job.failed` thì không phát tiếp (chặn vòng lặp). Hiện chưa queue nào `critical: true` — story sở hữu queue quan trọng tự bật.
- **RealtimeHub:** `sql.listen('realtime')` (postgres.js tự LISTEN lại khi kết nối rớt — lần `onlisten` thứ hai = đã nối lại → log `warn` + `event: resync`). Thêm gói dò tự NOTIFY mỗi 30 giây; không quay lại trong 5 giây → đăng ký LISTEN mới (generation mới, listener cũ bị bỏ qua) — phủ trường hợp postgres.js nối lại thất bại hoặc kết nối chết im lặng. Ping SSE là `event: ping` thật (EventSource không thấy comment `:`). Client đọc chậm >1 MB đệm → ngắt.
- **Khoá query ↔ entity:** `entity` là số ít (`notification`), khoá REST số nhiều (`['notifications', …]`): web vô hiệu hoá query có khoá gốc `=== entity` hoặc `=== entity + 's'` (`entityMatches`). `event: resync` và nối lại → `refetchQueries({type:'active'})`. Web tự backoff (đóng EventSource khi lỗi, không dùng retry tự động của trình duyệt).
- **Thông báo:** `dedupe_key = <event>:<id>:v<version>`; sự kiện không có version → `job:<jobId>` (pg-boss giao lại cùng job vẫn trùng; phát lại sự kiện mới thì tạo mới). `campaign.paused` lý do `MANUAL` không báo [ASSUMPTION: chủ shop tự dừng]. `created_at` độ chính xác mili giây để `?since=<createdAt>` không trả lại chính mục đó. Cài đặt lưu ở `settings` khoá `notification_prefs` (thiếu khoá → mặc định). API: `GET /notifications?since&cursor&limit` → `{items, nextCursor, unreadCount}`; `POST /notifications/read` `{all:true}|{ids}` → `{unreadCount}`; `GET/PUT /settings/notifications` (PUT đủ 5 khoá, phát `settings.updated`).
- **Web:** `RealtimeProvider` (trong `RequireAuth`) mở SSE; `AppShell` có chuông (chấm đỏ khi `unreadCount>0`, `aria-label` kèm số), ngăn kéo `NotificationsDrawer` (mở = đánh dấu đã đọc tất cả, mục chưa đọc lúc mở vẫn được làm nổi; bấm mục → màn theo entity), dải xám "Đang kết nối lại…", toast qua `useNotificationToasts` (mốc `since` lấy từ lần tải danh sách đầu, chuỗi tuần tự để không toast trùng). Cài đặt › Thông báo có thêm "Việc chạy nền bị lỗi" (`system_error`), skeleton/lỗi khi tải, lưu bằng "Lưu thay đổi".
- **`emit-event`:** `npm run emit-event -w server -- <sự kiện> '<JSON>'`, thiếu `id` → tự sinh UUIDv7; không `DATABASE_URL` → Postgres nhúng của `npm run dev`; chặn khi `NODE_ENV=production`.
- **Migration:** `server/drizzle/0002_notifications_settings.sql` (drizzle-kit, `drizzle-kit check` sạch). `dependency-rules.cjs` đã có `notifications: []` từ 1.1 (chỉ phụ thuộc nền) — không cần sửa.
- **Đã kiểm trên trình duyệt (`npm run dev`, phiên tạo trực tiếp trong DB dev, đã dọn):** hai tab cùng toast ~1,1 giây sau `emit-event` (tính cả thời gian khởi động npm), chấm đỏ ở cả hai; mở chuông thấy thông báo, số chưa đọc về 0; tắt "AI chuyển hội thoại cho bạn" + lưu → phát lại không tạo thông báo; đóng băng api (SIGSTOP) 30 giây → dải xám sau ~25 giây, tiếp tục api → dải biến mất ngay và refetch query đang mở. `curl /api/v1/stream` không phiên → 401.
- **Sau review (vòng 1):** chống trùng khi không có version dùng trường ổn định của payload (`page.expiring`: `expiresAt`; `conversation.state_changed`: `to:reasonCode`; `post_target.failed`: `errorCode`; `campaign.paused`: `reason`; `job.failed`: `queue:jobId`), không dùng id job nữa → phát lại cùng sự kiện chỉ một thông báo. `system_error` ghi tên queue và mã job. `cursor`/`ids` là `z.uuid()` ở shared (400 khi sai). Toast không dùng `since` nữa: mỗi `notification.created` lấy trang mới nhất, toast mục chưa đọc có id chưa thấy (`pickToasts`, tập id gieo từ lần tải đầu, tối đa 500). Ngăn kéo đánh dấu đọc theo id các mục chưa đọc đang hiện (và mục mới tới khi đang mở), nút "Đánh dấu đã đọc tất cả" vẫn `{all:true}`; có "Xem thêm" theo `nextCursor`. Web: mỗi `ready` (kể cả lần đầu) refetch query đang mở; mất kết nối thì hỏi `/auth/me`, 401 → dừng client và `me = null`. Server: mỗi nhịp ping kiểm lại phiên của từng stream (`isSessionValid`, không gia hạn) → phiên mất thì đóng stream; `addClient` sau `close()` đóng ngay; một gói dò mỗi lúc, hẹn giờ bắt đầu sau khi `pg_notify` xong; `relisten` LISTEN mới trước rồi mới UNLISTEN cũ. `assertBossDbSupported` chạy lúc khởi động api và worker. Bỏ `isRealtimeEvent` không dùng.
- **Còn hở:** đọc thông báo ở tab này không làm tắt chấm đỏ ở tab khác cho tới lần refetch sau (không có sự kiện `notification.read`).

- **Kiểm thử trên trình duyệt (sau review):** hai tab đã đăng nhập; `emit-event` handoff và `page.expiring` → cả hai tab nhận toast và chuông "1/2 chưa đọc" ~1 giây sau khi chạy lệnh; ngăn kéo hiện đủ; tắt "AI chuyển hội thoại" rồi phát handoff mới → không có thông báo mới; đóng băng api → dải "Đang kết nối lại…" sau ~25 giây, chạy lại thì biến mất ngay. Dữ liệu thử đã xoá, cài đặt thông báo trả về mặc định. Ghi nhận: tab khác vẫn hiện số chưa đọc cũ tới lần refetch sau (đã reject trong triage).

## Spec Change Log

## Review Triage Log

| # | Nguồn | Phát hiện | Verdict | Bằng chứng / route |
|---|---|---|---|---|
| 1 | blind, edge, vgap | Con trỏ toast theo `created_at` (giờ bắt đầu transaction) + `gt`, sắp theo id nhưng lấy items[0].createdAt → toast mất hoặc lặp | medium | `schema.ts` defaultNow, `service.ts` gt, `notifications.ts` cursor; patch |
| 2 | blind, edge | Mở ngăn kéo đánh dấu `all` cả thông báo đến sau; mở sẵn thì thông báo mới vẫn chưa đọc | medium | `NotificationsDrawer.tsx` gửi `{all:true}` một lần; patch |
| 3 | blind, edge | Phiên hết hạn → SSE 401 → client nối lại mãi, không về đăng nhập | medium | `realtime.ts` onerror chỉ backoff; patch |
| 4 | edge | Lần kết nối đầu bỏ lỡ sự kiện giữa fetch REST và `ready` | low | chỉ refetch khi nối lại; sửa trực tiếp; patch |
| 5 | blind, edge | Luồng SSE sống tiếp sau đăng xuất/hết hạn | medium | `stream.ts` chỉ kiểm phiên lúc mở; patch |
| 6 | edge | Request tới sau `hub.close()` không bao giờ kết thúc | low | `addClient` không kiểm `closed`; sửa trực tiếp; patch |
| 7 | blind, edge | `relisten` UNLISTEN cũ trước LISTEN mới; probe chồng nhau | low | thứ tự trong `realtime/index.ts`; sửa trực tiếp; patch |
| 8 | blind, edge | Sự kiện không có version (vd `page.expiring`) tạo thông báo lặp mỗi lần phát | medium | dedupe dùng id job consumer; patch |
| 9 | blind | Thông báo `system_error` không nêu queue nào | low | body chung chung; sửa trực tiếp; patch |
| 10 | blind, vgap | cursor/ids validate ở hai chỗ; id không phải UUID bị bỏ qua lặng lẽ | low | schema `z.string()` + regex service; patch |
| 11 | blind | Ngăn kéo chỉ hiện 50 mục đầu | low | API có `nextCursor` nhưng UI không dùng; patch |
| 12 | blind | `bossDbFor` dựa vào nội bộ drizzle, chỉ lỗi khi dùng lần đầu | medium | đọc `_.session.client`; patch (tự kiểm lúc khởi động) |
| 13 | vgap | Không kiểm `job.failed` chỉ phát ở lần thử cuối | medium | vgap đã xác minh; patch |
| 14 | vgap | Chốt chặn vòng lặp `job.failed` chưa được chạy | medium | vgap đã xác minh; patch |
| 15 | vgap | Logic toast và cập nhật cache khi đánh dấu đã đọc chưa có test | medium | vgap đã xác minh; patch cùng lúc tách hàm thuần |
| 16 | blind | `isRealtimeEvent` không dùng | low | sửa trực tiếp; patch |
| 17 | blind, edge | Job hết hạn / worker chết ở lần cuối không phát `job.failed` | medium | chỉ phát trong `catch`; chưa có queue quan trọng nào; defer → deferred-work.md, sửa ở story tạo queue quan trọng đầu tiên |
| 18 | vgap | Route thông báo/stream là tuỳ chọn trong `buildApp`, chưa kiểm wiring production | low | cần smoke có phiên; defer theo vgap; reject cho story này |
| 19 | vgap | Ngắt client chậm chưa có test | low | app một người dùng; reject |
| 20 | blind | Bấm thông báo không mở đúng hội thoại/trang | low | màn Hộp thư chưa nhận tham số id; sẽ nối ở Epic 4; reject |
| 21 | blind | Trạng thái đã đọc không đồng bộ giữa các tab | low | tab khác tự refetch ở sự kiện sau; reject |
| 22 | blind | Không dọn bảng notifications theo thời hạn/xoá trang | low | thuộc Epic 9 (retention, privacy); reject |
| 23 | edge (claim) | Job mang `{event, payload}` thay vì payload thô như spec | false | lệch có chủ ý, đã ghi ở Implementation Notes; consumer đọc qua platform |

## Design Notes

NOTIFY nằm trong transaction nên chỉ được giao khi commit, rollback thì không — đúng "phát khi commit" của AD-3 mà không cần outbox riêng. Thông báo toast lấy chữ qua REST (`GET /api/v1/notifications?since=`), không lấy từ payload.

```ts
await db.transaction(async (tx) => {
  await tx.update(...)                       // đổi trạng thái
  await publishEvent(tx, 'page.expiring', { id, pageId: id, expiresAt })
})
```

## Verification

**Commands:**
- `npm run check` -- expected: exit 0
- `curl -sN -o /dev/null -w '%{http_code}' localhost:3000/api/v1/stream` -- expected: 401
- Manual: AC thứ nhất và thứ hai trên trình duyệt; tắt api 30 giây thì thấy "Đang kết nối lại…", bật lại thì dải xám biến mất.
