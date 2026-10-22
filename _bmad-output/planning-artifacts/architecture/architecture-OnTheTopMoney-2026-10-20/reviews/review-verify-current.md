---
review: verify-current
lens: "Mọi quyết định đã được kiểm thực tế (web/npm/dự án) chứ không khẳng định từ trí nhớ"
target: ../ARCHITECTURE-SPINE.md (+ ../.memlog.md)
date: 2026-10-20
method: npm view, giải nén tarball pg-boss@12.38.0 đọc .d.ts/.js, GitHub API, Docker Hub, nodejs/Release schedule.json, WebFetch tài liệu chính thức Meta/OpenAI/Fastify/Caddy, đọc web/package.json
---

# Review: Kiểm thực tế các khẳng định (2026-10-20)

## Verdict

**Đạt có điều kiện — cần sửa trước khi chia story.** Phiên bản thư viện trong Stack đều khớp npm hôm nay. Phần lớn khẳng định về Meta đúng. Có **4 lỗi thực chất** và vài lỗ hổng:

1. **pg-boss `singletonKey` một mình không chống trùng** trên queue `standard`. Phải khai báo `policy` cho queue. Với `publish.target`, chọn policy sai thì đổi lịch bằng kéo thả sẽ làm bài không bao giờ được đăng (AD-13, AD-16).
2. **Phân loại lỗi Meta sai ở hai chỗ** (AD-6): `551` nghĩa là "người nhận không khả dụng", không phải lỗi ngoài cửa sổ. Còn mã `200` kèm subcode `1545041` sẽ bị xếp nhầm vào `PERMISSION_MISSING`.
3. **Model OpenAI mặc định đã lỗi thời**: `gpt-image-2` vẫn chạy nhưng không còn là model ảnh hiện hành (nay là `gpt-image-2.5-flare`/`-sunburst`). Không còn dòng model chữ "mini" hiện hành: các bản mini đang có lịch tắt, model thay thế là `gpt-6-luna`.
4. **TypeScript 7.0.2 không chạy được với typescript-eslint**, mà AD-1 dựa vào rule ESLint `import/no-restricted-paths`. FE hiện dùng oxlint.

Lỗ hổng thêm: IG chỉ nhận ảnh **JPEG**. Danh sách quyền Meta còn thiếu `pages_show_list`, `business_management`, `pages_manage_engagement`, `pages_read_user_content`. Chưa có tài liệu xác nhận Threads ký webhook bằng secret nào.

Ký hiệu: ✅ đã xác minh · ❌ sai · ⚠️ đúng nhưng thiếu hoặc lỗi thời · ❓ không chắc (chưa tìm thấy nguồn chính thức)

---

## A. Phiên bản Stack

| # | Khẳng định | Kết quả | Bằng chứng / nguồn | Đề xuất |
|---|---|---|---|---|
| A1 | fastify 5.12.7 | ✅ | `npm view fastify version` → 5.12.7 | — |
| A2 | pg-boss 12.38.0 | ✅ | npm → 12.38.0 (phát hành 2026-10-13); `engines.node >=22.12.0` | — |
| A3 | drizzle-orm 0.45.4 / drizzle-kit 0.31.11 | ✅ ⚠️ | npm `latest` = 0.45.4 (2026-10-08), kit 0.31.11. Đã có **1.0.0-rc.5** (tag `rc5`; rc.4 ra ngày 2026-06-27) | Ghi rõ "pin 0.45.x; theo dõi 1.0 GA (API RQB v2, migrator thay đổi)". Đừng tự nâng lên rc. |
| A4 | openai SDK 7.39.0 | ✅ | npm → 7.39.0 (2026-10-19) | — |
| A5 | zod 4.6.7, pino 10.4.0, vitest 5.0.5 | ✅ | npm | — |
| A6 | TypeScript 7.0.2 | ✅ phiên bản / ❌ hệ sinh thái | npm `latest` 7.0.2 (2026-07-08). `typescript-eslint@8.72.0` peer `typescript: >=4.8.4 <6.1.0`. TS 7 (bản port Go) **chưa có programmatic API** (dự kiến từ 7.1). Microsoft khuyên dùng gói `@typescript/typescript6` cho công cụ cần API. Nguồn: [InfoQ](https://infoq.com/news/2026/08/typescript-7-released/), [typescript-eslint #12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518), [OpenReplay](https://blog.openreplay.com/upgrade-typescript-7/) | Xem C-Lint. Ghi rõ: server dùng `tsc` 7 để typecheck; lint bằng **oxlint** như `web/` (web/package.json: `"lint": "oxlint"`, `typescript ~7.0.2`). |
| A7 | Node.js 24 LTS, lên 26 sau 28/10/2026 | ✅ | [nodejs/Release schedule.json](https://github.com/nodejs/Release/blob/main/schedule.json): v24 vào maintenance ngày **2026-10-20 (hôm nay)**, hết hạn 2028-04-30; v26 vào LTS 2026-10-28. Máy dev v24.18.0 | Ghi thêm "Node 24 đang ở Maintenance LTS". Nên đặt mốc chuyển sang 26 ngay khi bắt đầu dựng (sau 28/10). |
| A8 | PostgreSQL 18 | ✅ | Docker Hub `postgres`: bản mới nhất 18.6; đã có `19rc1` | Pin `postgres:18` (hoặc `18.6`). PG18 có sẵn `uuidv7()` ([thenile.dev](https://thenile.dev/blog/uuidv7)), nên lưu kiểu `uuid` gốc. "UUIDv7 dạng chuỗi ở DB" nên đổi thành "kiểu `uuid`, mặc định `uuidv7()`". |
| A9 | Meta Graph API v26.0 | ✅ | Ra mắt 2026-07-29: [blog Meta](https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/), [changelog v26](https://developers.facebook.com/docs/graph-api/changelog/version26.0) | Thêm ghi chú: trên v26, **`GET /?ids=...` trả lỗi**, `ETag`/304 bị bỏ, `date_format` lỗi. Adapter meta không được dựa vào batch `?ids=`. |
| A10 | Caddy 2 | ✅ ⚠️ | GitHub API: release mới nhất **v2.11.7** (2026-10-03). Caddy tự flush ngay với `text/event-stream`, nên SSE qua reverse proxy không cần cấu hình thêm ([docs reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)) | Pin `caddy:2.11` thay vì "2". |
| A11 | Frontend Vite 8, React 19, Tailwind v4, react-router 7 | ✅ | `web/package.json`: vite ^8.3.4, react ^19.3.1, tailwindcss ^4.3.3, react-router-dom ^7.18.4 | — |

## B. pg-boss 12 (đọc trực tiếp `dist/*.d.ts` và `migrationStore.js` của 12.38.0)

| # | Khẳng định | Kết quả | Bằng chứng | Đề xuất |
|---|---|---|---|---|
| B1 | Có `publish`/`subscribe` | ✅ | `publish(event, data?, options?: SendOptions)`, `subscribe(event, name)`. `SendOptions = JobOptions & QueueOptions & ConnectionOptions`, nên `publish` nhận được `db` | Ghi rõ: `publish` chỉ fan-out vào các queue **đã `subscribe`**. Không có subscriber thì sự kiện bị bỏ, không lỗi. Mỗi queue phải được `createQueue` trước. `send` vào queue chưa tạo sẽ ném `QUEUE_NOT_FOUND`. Worker phải tạo và subscribe đủ queue lúc khởi động, trước khi api enqueue. |
| B2 | `schedule` (cron) | ✅ | `schedule(name, cron, data?, ScheduleOptions)`. `ScheduleOptions` có `tz`, `key`, `missed: 'skip'|'once'` | Cron hạn mức/tháng/khung giờ nên đặt `tz: 'Asia/Ho_Chi_Minh'`. Cron làm mới token/số liệu nên đặt `missed: 'once'` để chạy bù sau deploy. |
| B3 | `startAfter` | ✅ | `JobOptions.startAfter?: number \| string \| Date` | — |
| B4 | `db` executor cho enqueue cùng transaction | ✅ | `ConnectionOptions.db?: IDatabase` (`executeSql`). Có sẵn adapter **`fromDrizzle(tx, sql)`** xuất từ `pg-boss` | Ghi tên `fromDrizzle(tx, sql)` vào AD-2 để story không tự viết adapter. |
| B5 | `singletonKey=conversationId` / `=targetId` **chống hai worker xử lý trùng** (AD-13, AD-16, memlog) | ❌ (thiếu điều kiện) | Unique index trong `migrationStore.js` chỉ áp khi có `singleton_on` (tức `singletonSeconds`) **hoặc** queue có `policy` là `short`/`singleton`/`stately`/`exclusive`/`key_strict_fifo`. Queue mặc định `standard` + `singletonKey` **không ràng buộc gì** | Ghi policy cho từng queue: **`autoreply.run` → `stately`** (mỗi key tối đa 1 job chờ + 1 job chạy; tin mới đến khi đã có job chờ thì bị gộp, đúng ý debounce 8s). **`publish.target`**: KHÔNG dùng `stately`/`exclusive` kèm "gửi job mới khi kéo thả", vì job mới sẽ bị từ chối (trả `null`), job cũ chạy giờ cũ, thấy lệch phiên bản rồi bỏ qua, và **bài không bao giờ đăng**. Hai cách: (a) đổi lịch bằng **`boss.upsert`/`update`** theo `singletonKey` để sửa `startAfter` (API có trong 12.x: `UpdateOptions` gồm `startAfter`, `singletonKey`); hoặc (b) queue `standard` không singleton, mỗi lần đổi lịch gửi job mới kèm `version`, job tự so `scheduled_at`/`version`, và khoá lạc quan `UPDATE … WHERE status='scheduled'` lo chống đăng hai lần. Chọn (b) cho đơn giản và ghi vào AD-13. |
| B6 | Retry chỉ với `RATE_LIMITED`/`TRANSIENT`, backoff mũ, tối đa 5 lần | ⚠️ | pg-boss retry khi handler ném lỗi, theo `retryLimit`/`retryDelay`/`retryBackoff`/`retryDelayMax` của queue | Ghi: handler phải **bắt lỗi không retry được** (`REJECTED`, `TOKEN_INVALID`, `OUTSIDE_WINDOW`…), ghi `failed` vào bảng nghiệp vụ rồi **kết thúc job bình thường**. Chỉ ném lỗi lại khi lỗi thuộc loại retry được. Nên dùng `deadLetter` cho queue gửi tin/đăng bài. |
| B7 | Tên job/sự kiện dạng `publish.target`, `page.disconnected` | ✅ | `attorney.js`: tên khớp `/^[\w.\-/]+$/` (cho phép dấu chấm) | — |

## C. Fastify 5, lint, SSE

| # | Khẳng định | Kết quả | Nguồn | Đề xuất |
|---|---|---|---|---|
| C1 | Fastify 5 lấy được raw body cho webhook | ✅ | [ContentTypeParser](https://fastify.dev/docs/latest/Reference/ContentTypeParser/): `addContentTypeParser('application/json', {parseAs:'buffer', bodyLimit}, …)` giới hạn trong plugin đóng gói. Hoặc plugin `fastify-raw-body@6.0.3` (bảng tương thích: `^6.0.0` ↔ Fastify `^5.0.0`) | Ghi một cách cụ thể: parser `buffer` đăng ký **chỉ trong plugin `/webhooks`**, HMAC trên Buffer rồi mới `JSON.parse`. Meta ký trên payload **dạng unicode đã escape** (`é`…). Hash đúng byte nhận được thì khớp; parse rồi stringify lại thì sai. Điều này quan trọng vì nội dung tiếng Việt có nhiều dấu ([Messenger webhooks](https://developers.facebook.com/docs/messenger-platform/webhooks)). |
| C2 | AD-1: lint `import/no-restricted-paths` | ❌ với stack đã chọn | Đây là rule của `eslint-plugin-import`, cần `@typescript-eslint/parser`, mà parser này không hỗ trợ TS 7 (A6). FE dùng oxlint. Oxlint có `no-restricted-imports` kèm `patterns` ([oxc docs](https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-restricted-imports)). Chưa xác nhận oxlint có `import/no-restricted-paths` ❓ | Đổi AD-1 thành: "oxlint `no-restricted-imports` với `patterns` chặn `**/modules/*/!(index)`, hoặc `dependency-cruiser` trong CI". Nếu buộc dùng ESLint thì chạy với `@typescript/typescript6`. |
| C3 | SSE `/api/v1/stream` | ✅ | Có `@fastify/sse@0.6.1` (org fastify, peer `fastify ^5.x`), nhưng vẫn là 0.x | Tự viết SSE bằng `reply.raw` hoặc pin `@fastify/sse` 0.6.x. Caddy flush SSE tự động (A10). |

## D. Meta — mã lỗi Graph (AD-6)

| # | Khẳng định | Kết quả | Nguồn | Đề xuất |
|---|---|---|---|---|
| D1 | `190` = token không hợp lệ → `TOKEN_INVALID` | ✅ | [Error handling](https://developers.facebook.com/docs/graph-api/guides/error-handling/): 190 "Access token expired", subcode 458/460/463/467 | — |
| D2 | `4`, `17`, `32`, `613`, `80001` = rate limit | ✅ | [Rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/): 4 app, 17 user, 32 Page (user token), 613 custom, 80001 Page (Page token) | Liệt kê đủ thay vì "…": thêm **`80002` (Instagram BUC)**, **`80006` (Messenger BUC)**, **`341`** (application limit). Đọc header `X-Business-Use-Case-Usage.estimated_time_to_regain_access` (phút) để đặt `startAfter` khi retry. **Ngoại lệ**: `613/2018338` (hành vi gửi tin bị coi là quấy rầy) và `368` (tạm khoá do vi phạm chính sách) **không được retry tự động**, phải xếp vào `REJECTED` và báo người dùng. |
| D3 | `10` = `PERMISSION_MISSING` | ⚠️ | 10 = "API permission denied" | Phân loại **theo subcode trước, code sau**: `10` không subcode hoặc subcode khác → `PERMISSION_MISSING`. `10/2018278`, `10/2534022`, `10/2018065` → `OUTSIDE_WINDOW`. `10/2018108` → người nhận không nhận được tin. |
| D4 | `10/2018278` = ngoài cửa sổ | ✅ | [Messenger error codes](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes): "Message sent outside of allowed window" (chính sách mới). Thêm `10/2534022` "outside the standard messaging window" | Thêm `2534022` vào ánh xạ `OUTSIDE_WINDOW`. |
| D5 | `551` = `OUTSIDE_WINDOW` | ❌ | Cùng nguồn: `551/1545041` = "This person isn't available right now" (bị chặn, tài khoản khoá/xoá, đã từ chối nhận). Không liên quan cửa sổ 24h | Tạo mã riêng **`RECIPIENT_UNAVAILABLE`** cho `551/1545041`, `200/1545041`, `10/2018108`, `100/2018001`, không retry. FE hiển thị "Khách hiện không nhận được tin". |
| D6 | `200–299` = `PERMISSION_MISSING` | ⚠️ | `200/1545041` thực ra là người nhận không khả dụng | Kiểm subcode `1545041` trước khi rơi vào nhánh 200–299. |
| D7 | `1`, `2`, 5xx = `TRANSIENT` | ✅ | Error handling: 1 "Unknown API" và 2 "API Service" là tạm thời | — |
| D8 | Lỗi khi nhắn riêng lần 2 cho một bình luận | ❓ | Tài liệu chỉ có `100/2534025` "comment invalid for a private reply". Chưa thấy mã riêng cho "đã nhắn riêng rồi" | Giữ kiểm `PRIVATE_REPLY_USED` phía app như AD-10. Ánh xạ `100/2534025` → `PRIVATE_REPLY_INVALID`. Ghi log mã thực tế khi thử. |

## E. Meta — cửa sổ gửi tin, nhắn riêng (AD-10)

| # | Khẳng định | Kết quả | Nguồn | Đề xuất |
|---|---|---|---|---|
| E1 | DM Messenger/IG trong 24 giờ | ✅ ⚠️ | [Policy](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy): standard messaging 24h. [IG Messaging overview](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/overview): tin đầu tiên của khách đến sau quảng cáo Click-to-Direct có thể mở cửa sổ **tới 7 ngày** | Giữ 24h (an toàn). Ghi vào Deferred: "cửa sổ 7 ngày cho hội thoại từ quảng cáo". `canSend` vẫn là chỗ duy nhất cần sửa. |
| E2 | Nhắn riêng bình luận: 1 lần, ≤7 ngày | ✅ | [FB private replies](https://developers.facebook.com/docs/messenger-platform/discovery/private-replies/): "Only one message can be sent", trong 7 ngày kể từ lúc tạo bình luận. [IG private replies](https://developers.facebook.com/docs/instagram-platform/private-replies/): 7 ngày; bình luận Live chỉ trả lời được trong lúc đang phát | Bổ sung: sau khi khách **trả lời** tin nhắn riêng thì mở cửa sổ 24h thường. Khi đó hội thoại `comment` cần chuyển hoặc liên kết sang hội thoại `dm` của khách (AD-11 chưa nói). Tính 7 ngày theo **thời điểm tạo bình luận**, không theo `last_customer_message_at`. |
| E3 | HUMAN_AGENT hoãn | ✅ | Policy: tag cho phép 7 ngày, chỉ người thật gửi tay, bot không được dùng. Từ 27/04/2026 các tag `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` trả lỗi 100 | Giữ hoãn. Ghi thêm: tag khác không còn dùng được, đừng để story nào dùng. |

## F. Meta — token (AD-5)

| # | Khẳng định | Kết quả | Nguồn | Đề xuất |
|---|---|---|---|---|
| F1 | Threads: làm mới bằng `th_refresh_token`, hạn 60 ngày, chỉ sau 24h | ✅ | [Threads long-lived tokens](https://developers.facebook.com/docs/threads/get-started/long-lived-tokens): `GET /refresh_access_token?grant_type=th_refresh_token`, token phải **≥24h tuổi, chưa hết hạn, có `threads_basic`**. Làm mới xong được thêm 60 ngày; quá 60 ngày không làm mới thì phải đăng nhập lại. Đổi short→long dùng `th_exchange_token` + **Threads app secret** | Cron "≤15 ngày" là hợp lệ. Thêm điều kiện bỏ qua nếu `issued_at` < 24h. |
| F2 | Page token lấy từ long-lived user token | ✅ | [Get long-lived](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/): `fb_exchange_token` (~60 ngày), rồi `/{user-id}/accounts`. Page token dài hạn **không có ngày hết hạn cố định** | `expires_at` của Page token thường bằng 0, nên `connections` phải coi 0 là "không hết hạn" khi tính `expiring`. |
| F3 | `data_access_expires_at` 90 ngày | ✅ ⚠️ | [debug_token](https://developers.facebook.com/docs/graph-api/reference/debug_token/) có trường `data_access_expires_at`. [Data access expiration](https://developers.facebook.com/docs/facebook-login/auth-vs-data/): 90 ngày. Danh sách quyền **không hết hạn** gồm các quyền `pages_*`, `read_insights`, `business_management`… nhưng **không có quyền `instagram_*`** | Ghi rõ: hết `data_access_expires_at` thì chủ yếu chặn quyền **Instagram**; trang FB vẫn chạy. "Kết nối lại" phải dùng `auth_type=reauthorize`. Có thể hiển thị `expiring` riêng cho IG. |
| F4 | `scopes` lấy từ `debug_token` | ✅ | debug_token có `scopes`, `granular_scopes` (kèm `target_ids`) | Dùng `granular_scopes` để biết quyền áp cho **trang nào**. Người dùng có thể chỉ chọn một số trang khi đăng nhập. |

## G. Meta — đăng bài (AD-13, AD-14)

| # | Khẳng định | Kết quả | Nguồn | Đề xuất |
|---|---|---|---|---|
| G1 | IG đăng ảnh qua `image_url` công khai, container + `media_publish` | ✅ | [IG content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/): `POST /<IG_ID>/media` (image_url), rồi `POST /<IG_ID>/media_publish` (creation_id). Media phải ở server công khai | — |
| G2 | (thiếu) định dạng ảnh IG | ❌ thiếu | Cùng nguồn: "**JPEG is the only supported image format**" (không nhận MPO/JPS). Giới hạn 100 bài API/24h (có đoạn ghi 50 cho carousel). Container hết hạn sau 24h. Nên kiểm `status_code` tối đa 5 phút | Thêm vào AD-14: `MediaStore.put()` chuẩn hoá thành **JPEG sRGB** cho ảnh dùng ở IG; ảnh AI gọi với `output_format: 'jpeg'` (OpenAI có `png`/`jpeg`/`webp`). Job đăng IG: tạo container, poll `status_code` đến `FINISHED`, rồi publish. Kiểm `content_publishing_limit` trước khi đăng. |
| G3 | Threads đăng ảnh qua URL công khai | ✅ | [Threads posts](https://developers.facebook.com/docs/threads/posts): JPEG/PNG, ≤8 MB, rộng 320–1440, cần URL công khai. Container rồi `threads_publish`, chờ ~30s giữa hai bước | Spine nói Threads chỉ trả lời/bình luận, nhưng nhắc "IG và Threads chỉ đăng ảnh qua URL". Nếu Threads không đăng bài thì bỏ Threads khỏi AD-14 cho khỏi nhầm. Trả lời Threads cũng theo 2 bước, nên job `inbox.send` cho Threads cần chờ hoặc poll. |
| G4 | Đăng bài Page FB | ✅ | [Page feed](https://developers.facebook.com/docs/graph-api/reference/v26.0/page/feed): `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`; task CREATE_CONTENT | — |
| G5 | Insight trang/bài (AD-17) | ⚠️ | [Changelog v25](https://developers.facebook.com/docs/graph-api/changelog/version25.0): bỏ `page_impressions_unique`, `page_posts_impressions*`, `post_impressions_unique`… từ v26, **gọi sẽ lỗi trên mọi phiên bản**. Thay thế: `page_total_media_view_unique`, `page_media_view`, `post_total_media_view_unique`, `post_media_view` | Thêm vào AD-17: danh sách metric dùng phải lấy từ **bảng cấu hình trong adapter**, không rải trong code. Cấm dùng các metric `*impressions*` đã bỏ. |

## H. Meta — webhook (AD-4)

| # | Khẳng định | Kết quả | Nguồn | Đề xuất |
|---|---|---|---|---|
| H1 | `X-Hub-Signature-256` = HMAC-SHA256 trên raw body, dùng App Secret | ✅ | [Webhooks getting started](https://developers.facebook.com/docs/graph-api/webhooks/getting-started): header có tiền tố `sha256=`. Meta thử lại ngay rồi giãn dần **trong 36 giờ**, gộp tối đa **1000 cập nhật mỗi lần**, nên phải tự chống trùng. Messenger yêu cầu trả 200 **trong ≤5 giây** | Khoá chống trùng phải tính **theo từng entry/messaging item**, không theo cả request (một POST chứa nhiều entry). Tách từng entry thành dòng `webhook_events` riêng. Thứ tự tin dùng `timestamp` vì bản thử lại có thể đến lệch thứ tự. |
| H2 | Threads ký bằng **Threads app secret** riêng | ❓ | Threads app có secret riêng (đã xác minh ở F1, dùng cho `th_exchange_token`). Nhưng [Threads webhooks](https://developers.facebook.com/docs/threads/webhooks) **không nói** payload ký bằng secret nào, cũng không nhắc `X-Hub-Signature-256` | Đánh dấu [ASSUMPTION] trong AD-4. Story webhook Threads phải có bước thử thật trong Development mode, ghi lại secret nào khớp. Code thử Threads secret trước; nếu không khớp thì log cảnh báo, chưa thử secret thứ hai, cho đến khi xác nhận. |
| H3 | Threads webhook có trường `replies` | ✅ | Threads webhooks: topic `moderate` gồm `replies` (cần `threads_basic`+`threads_read_replies`) và `delete`; topic `interaction` gồm `mentions` (`threads_manage_mentions`) và `publish`. Cần Live mode (non-tech provider) hoặc Advanced Access (tech provider), business đã xác minh. Tài khoản riêng tư không gửi replies/mentions | Payload Threads **khác dạng** Graph (`target_id`, `values.value`, `topic`, không có `entry[]`). `webhook.route` cần parser riêng cho Threads; khoá chống trùng dùng `values.value.id`. Cân nhắc subscribe thêm `mentions`. |
| H4 | Đăng ký webhook cho trang | ✅ | Messenger webhooks: `POST /<PAGE_ID>/subscribed_apps?subscribed_fields=…`, cần `pages_messaging` + `pages_manage_metadata`, task MODERATE | Ghi tên trường: `messages`, `messaging_postbacks`, `message_echoes` (để thấy tin gửi tay từ Meta Business Suite), `feed` (bình luận trang). IG: `messages`, `comments`. |
| H5 | Nhận tin từ khách thật cần Advanced Access + App Review; Development mode chỉ nhận từ người có vai trò | ✅ | Messenger webhooks: "Advanced Access is required to receive notifications from customers", Standard Access chỉ cho người có vai trò | — |

## I. Meta — danh sách quyền ("Điều kiện ngoài")

| # | Khẳng định | Kết quả | Nguồn | Đề xuất |
|---|---|---|---|---|
| I1 | Dùng `instagram_basic` (không phải `instagram_business_basic`) | ✅ | [Permissions](https://developers.facebook.com/docs/permissions): `instagram_basic`, `instagram_manage_messages`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights` thuộc **Instagram API with Facebook Login**, chưa bị đánh dấu deprecated. `instagram_business_*` chỉ dành cho Instagram Login (`graph.instagram.com`) | Ghi rõ lựa chọn "Instagram API with Facebook Login (Page token, graph.facebook.com)". IG phải liên kết với một Page. |
| I2 | Tên các quyền Pages/Threads | ✅ | Đều tồn tại: `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_manage_posts`, `read_insights`, `threads_basic`, `threads_content_publish`, `threads_read_replies`, `threads_manage_replies`, `threads_manage_insights` | — |
| I3 | Danh sách đã đủ | ❌ thiếu | **`pages_show_list`** (bắt buộc cho `/me/accounts` và đăng feed). **`business_management`** (IG Messaging liệt kê là bắt buộc; trang thuộc Business Manager). **`pages_manage_engagement`** (trả lời bình luận trang `POST /{id}/comments`, task MODERATE, theo [Comments ref](https://developers.facebook.com/docs/graph-api/reference/object/comments/)). **`pages_read_user_content`** (đọc bình luận người dùng, `GET /feed`). Tuỳ chọn `threads_manage_mentions`. IG private reply qua Facebook Login: `instagram_basic` + `instagram_manage_comments` + `pages_read_engagement`; nếu người dùng có vai trò trên trang qua Business Manager thì cần thêm `ads_management`, `ads_read` | Bổ sung các quyền trên vào phần "Điều kiện ngoài" và vào scope OAuth của `connections`. Ghi `ads_*` là điều kiện có thể phát sinh. |

## J. OpenAI (AD-7, Stack, memlog)

| # | Khẳng định | Kết quả | Nguồn | Đề xuất |
|---|---|---|---|---|
| J1 | `gpt-image-2` có trong OpenAI API | ✅ | [Model gpt-image-2](https://developers.openai.com/api/docs/models/gpt-image-2): snapshot `gpt-image-2-2026-04-21`; hỗ trợ `v1/images/generations`, `v1/images/edits`, batch; **`v1/responses` "Not supported"** khi gọi trực tiếp; không có trong danh sách deprecation | — |
| J2 | `gpt-image-2` là model ảnh mặc định hiện hành | ⚠️ lỗi thời | [Models](https://developers.openai.com/api/docs/models) hiện chỉ giới thiệu **`gpt-image-2.5-flare`** (nhanh) và **`gpt-image-2.5-sunburst`** (chất lượng cao), ra ngày 08/09/2026. Bên thứ ba cho biết giá ngang `gpt-image-2` ([apiyi](https://docs.apiyi.com/en/live/2026-09/gpt-image-2-5-flare-sunburst-launch)). [Deprecations](https://developers.openai.com/api/docs/deprecations): gpt-image-1 tắt 23/10/2026, gpt-image-1.5 tắt 01/12/2026, cả hai thay bằng 2.5 | Đổi seed mặc định thành **`gpt-image-2.5-flare`**, giữ `gpt-image-2` trong bảng giá như một lựa chọn. Spine đã cho cấu hình model nên chỉ cần sửa seed và memlog. Có thể cần **xác minh tổ chức (Organization Verification)** mới dùng được GPT Image; thêm vào checklist go-live. |
| J3 | "Model chữ mặc định = model mini hiện hành" | ❌ lỗi thời | Trang Models không còn model chữ "mini". Model hiệu quả được khuyên dùng là **`gpt-6-luna`**. Deprecations: `gpt-5-mini-2025-08-07` tắt 11/12/2026 (thay bằng `gpt-5.6-terra`); `gpt-4o-mini`, `gpt-4.1-mini` tắt 14/01/2027 (thay bằng `gpt-6-luna`) | Seed model chữ = `gpt-6-luna`. Sửa câu trong memlog/AD-7 thành "model chữ hiệu quả hiện hành (seed `gpt-6-luna`)". Kiểm structured output và prompt caching của model này khi viết story AI. |
| J4 | Sơ đồ: Worker → "Responses, Images" | ✅ | Ảnh qua Images API (`v1/images/generations`); chữ qua Responses API | Ghi rõ: ảnh luôn đi **Images API**, không dùng tool `image_generation` của Responses, để chi phí tính đơn giản. Ảnh trả về dạng `b64_json`, sau đó `MediaStore.put()`. |

## K. Khẳng định khác đã kiểm

| # | Khẳng định | Kết quả | Ghi chú |
|---|---|---|---|
| K1 | Caddy phục vụ `/media/*` công khai cho Meta tải | ✅ | Hợp với yêu cầu "public server" của IG/Threads. Không đặt auth hay chặn bot cho đường dẫn này. |
| K2 | `last_event_at` dùng để báo "Webhook ngừng nhận tin" | ✅ (hợp lý) | Meta thử lại 36h. Ngưỡng cảnh báo nên tính bằng giờ, không nên tính bằng phút, để tránh báo nhầm cho shop ít tin. |
| K3 | PG LISTEN/NOTIFY payload ≤1 KB | ✅ | Giới hạn của PG là 8000 byte. Đặt 1 KB là bảo thủ, ổn. |

---

## Tóm tắt đề xuất sửa spine (theo mức ưu tiên)

1. **AD-13/AD-16 + memlog**: khai báo `policy` cho queue pg-boss (`autoreply.run`=`stately`). `publish.target` dùng queue `standard` + version check (hoặc `upsert` theo `singletonKey`). Bỏ câu "singletonKey chống hai worker xử lý trùng" vì đứng một mình thì sai.
2. **AD-6**: phân loại theo subcode trước. `551/1545041`, `200/1545041`, `10/2018108` → `RECIPIENT_UNAVAILABLE` mới. `10/2534022` → `OUTSIDE_WINDOW`. Thêm `80002`, `80006`, `341`. `613/2018338` và `368` không retry.
3. **Stack/AD-7/memlog**: seed model `gpt-image-2.5-flare` và `gpt-6-luna`. Ghi Organization Verification.
4. **AD-1/Stack**: lint ranh giới bằng oxlint `no-restricted-imports` hoặc dependency-cruiser. Ghi rằng TS 7 không có API cho typescript-eslint.
5. **AD-14**: ảnh IG phải là JPEG. Poll `status_code` container. Kiểm `content_publishing_limit`.
6. **Điều kiện ngoài**: thêm `pages_show_list`, `business_management`, `pages_manage_engagement`, `pages_read_user_content` (và có thể `ads_management`/`ads_read`).
7. **AD-4**: chống trùng theo từng entry. Parser riêng cho payload Threads. Đánh dấu [ASSUMPTION] cho secret ký webhook Threads.
8. **AD-5**: `expires_at=0` nghĩa là không hết hạn. Data access 90 ngày chủ yếu ảnh hưởng quyền `instagram_*`. Kết nối lại dùng `auth_type=reauthorize`. Dùng `granular_scopes`.
9. **AD-17**: dùng metric `*_media_view*`, cấm metric `*impressions*` đã bỏ ở v26.
10. Pin phiên bản cụ thể: `postgres:18`, `caddy:2.11`; Drizzle ghi rõ "0.45.x, chưa lên 1.0 rc". Ghi Node 24 đang Maintenance LTS và mốc chuyển sang 26.
