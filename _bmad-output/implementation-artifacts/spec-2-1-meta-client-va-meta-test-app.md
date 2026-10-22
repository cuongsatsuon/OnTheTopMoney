---
title: 'Story 2.1 — Meta client và Meta Test App cho môi trường dev'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: 'NO_VCS' # snapshot scratchpad/baseline-2-1
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-OnTheTopMoney-2026-10-20/reviews/review-verify-current.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Các story sau (kết nối trang, webhook, gửi tin, đăng bài, số liệu) đều phải gọi Meta. Nếu mỗi nơi tự gọi thì phiên bản Graph, cách hiểu mã lỗi, cách lùi khi bị giới hạn tần suất và dạng id bài sẽ lệch nhau. Dev cũng cần một app Meta thử riêng để không đụng app thật.

**Approach:** Dựng `adapters/meta` làm cổng duy nhất tới Meta: client `graph` (FB/IG, pin `META_GRAPH_VERSION`) và `threads`. Mỗi client có:
- bảng phân loại lỗi duy nhất;
- ngân sách tần suất theo header usage với 3 hạng ưu tiên, trạng thái lưu ở bảng `meta_rate_state` qua một port do module `connections` cung cấp;
- chuẩn hoá id bài.

Kèm fake adapter cho test các module khác, luật ranh giới "chỉ module được phép mới gọi adapter Meta", và runbook dựng Meta Test App + Threads test app.

## Boundaries & Constraints

**Always:** AD-6 nguyên văn. Mọi lời gọi Meta qua `adapters/meta`. Phiên bản `META_GRAPH_VERSION` mặc định `v26.0`. Bảng mã/subcode → loại nằm duy nhất ở `adapters/meta/errors.ts`, xét subcode trước mã chính, theo `review-verify-current.md` mục D:

| Mã / subcode | Loại |
|---|---|
| 190 | `TOKEN_INVALID` |
| 4, 17, 32, 613 (trừ 613/2018338), 80001, 80002, 80006, 341 | `RATE_LIMITED` |
| 10/2018278, 10/2534022, 10/2018065 | `OUTSIDE_WINDOW` |
| 551/1545041, 200/1545041, 10/2018108, 100/2018001 | `RECIPIENT_UNAVAILABLE` |
| 10 (subcode khác), 200–299 | `PERMISSION_DENIED` |
| 1, 2, HTTP 5xx, lỗi mạng, timeout | `TRANSIENT` |
| 613/2018338, 368, 100/2534025, còn lại | `REJECTED` |

Lỗi trả về mang `{kind, code, subcode, fbtraceId, retryAfterMs?}`, không mang token.

Ngân sách tần suất:
- Đọc `X-Business-Use-Case-Usage` (theo id đối tượng, lấy max của `call_count`, `total_cputime`, `total_time`; `estimated_time_to_regain_access` tính bằng phút) và `X-App-Usage` sau **mỗi** phản hồi, ghi vào `meta_rate_state(scope, bucket, usage_pct, blocked_until, updated_at)`.
- Mỗi lời gọi khai báo hạng: `background` dừng khi usage ≥75%, `publish` dừng khi ≥90%, `interactive` chỉ dừng khi Meta chặn thật (đang có `blocked_until`).
- Bị chặn trước khi gọi → `RATE_LIMITED` với `retryAfterMs` tính từ `blocked_until`.

Gửi `appsecret_proof` (HMAC-SHA256 của token theo app secret) khi có `META_APP_SECRET` [ASSUMPTION]. Chuẩn hoá `PublishedRef {platformPostId, permalink?}`: FB `{pageId}_{postId}` (dùng `post_id` khi đăng ảnh), IG media id của bài (không phải container id), Threads media id sau publish. Không log token, `appsecret_proof` hay query chứa token. Log chỉ path không query, kèm mã lỗi và fbtrace id.

**Never:** Không dựng OAuth, kết nối trang, webhook, gửi tin, đăng bài (story sau). Không gọi Meta thật trong test. Không đổi callback của app production. Không thêm SDK Meta (dùng `fetch`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lời gọi thành công | 200 JSON | `{ok:true, data}`; usage từ header được ghi `meta_rate_state` | header hỏng → bỏ qua, không lỗi |
| Lỗi Meta | body `{error:{code,error_subcode,fbtrace_id}}` | `{ok:false, kind}` đúng bảng; subcode quyết định trước | mã lạ → `REJECTED` |
| Token hỏng | 190 | `TOKEN_INVALID` | N/A |
| Usage cao, hạng background | usage 80% | lời gọi `background` bị từ chối trước khi gửi: `RATE_LIMITED` | `interactive` vẫn gửi |
| Usage cao, hạng publish | usage 92% | `publish` và `background` bị từ chối; `interactive` vẫn gửi | N/A |
| Meta chặn | 80001 hoặc header `estimated_time_to_regain_access: 5` | ghi `blocked_until = now + 5 phút`; mọi hạng (kể cả `interactive`) trả `RATE_LIMITED{retryAfterMs}` tới khi hết hạn | N/A |
| Hết hạn chặn | `now > blocked_until` | lời gọi lại được gửi | N/A |
| Mạng lỗi / timeout | fetch ném lỗi, quá 30 giây | `TRANSIENT` | không retry trong adapter |
| Id bài FB đăng ảnh | phản hồi `{id, post_id}` | `platformPostId = post_id` | thiếu `post_id`, `pageId` rỗng hoặc id mang tiền tố trang khác → `null` (quyết định của chủ sở hữu 2026-10-22) |
| Id bài từ webhook | `post_id` FB dạng `{pageId}_{postId}`, IG/Threads media id | cùng dạng như khi đăng | N/A |
| Ranh giới | module ngoài danh sách cho phép import `adapters/meta` | `npm run depcruise` báo lỗi | N/A |

</frozen-after-approval>

## Code Map

- `server/src/adapters/openai/{index.ts,fake.ts}` -- mẫu adapter bằng `fetch`: timeout, phân loại lỗi, fake lập trình được theo test; dùng cùng phong cách.
- `server/src/platform/config/index.ts:84-140` -- đã có `META_APP_ID`, `META_APP_ENV` (production cấm test app): thêm `META_GRAPH_VERSION` (mặc định `v26.0`, dạng `vNN.N`), `META_APP_SECRET`, `THREADS_APP_ID`, `THREADS_APP_SECRET` (tuỳ chọn ở story này; bắt buộc ở story 2.2/2.3).
- `server/src/platform/log/index.ts` -- redact đã có `access_token`, `appsecret_proof`: kiểm lại có `input_token`, `fb_exchange_token`.
- `server/dependency-rules.cjs` + `server/.dependency-cruiser.cjs` -- bảng mũi tên; đã có luật `ad7-openai-only-ai` làm mẫu: thêm luật `ad6-meta-adapter-only` cho phép `connections`, `inbox`, `content`, `analytics`, `webhooks` import `adapters/meta`, cấm phần còn lại (kể cả `app/`).
- `server/src/modules/connections/` -- chưa có: tạo module với bảng `meta_rate_state` và `createRateStore(db)` cài port `RateStore` của adapter (AD-1: bảng thuộc `connections`).
- `server/test/fixtures/ad1-violation/` + `server/test/depcruise.test.ts` -- thêm fixture vi phạm luật mới.
- `deploy/runbook.md` -- đã có phần triển khai: thêm mục "Meta Test App cho dev".

## Tasks & Acceptance

**Execution:**
- [x] `server/src/adapters/meta/errors.ts` + test -- bảng ở Boundaries, `classifyMetaError(httpStatus, body)`; `it.each` cho từng dòng bảng.
- [x] `server/src/adapters/meta/rate.ts` + test -- parse hai header, port `RateStore {get(scope), record(scope, state)}`, `checkBudget(scope, tier, now)`, ngưỡng theo hạng.
- [x] `server/src/adapters/meta/client.ts` -- `createMetaClient({baseUrl, version, appSecret?, rateStore, fetch?, now?, log?})`: `get/post` có token, `appsecret_proof`, timeout 30 giây, kiểm ngân sách trước khi gửi, ghi usage sau mỗi phản hồi; hai instance `graph` (`https://graph.facebook.com/{version}`) và `threads` (`https://graph.threads.net/v1.0`).
- [x] `server/src/adapters/meta/normalize.ts` + test -- `publishedRefFromFacebook`, `…Instagram`, `…Threads`, `normalizeWebhookPostId`.
- [x] `server/src/adapters/meta/{index.ts,fake.ts}` -- export công khai; fake ghi lại lời gọi và trả phản hồi lập trình được.
- [x] `server/src/modules/connections/{schema.ts,rate-store.ts,index.ts}` + migration -- bảng `meta_rate_state(scope, bucket, usage_pct, blocked_until, updated_at, pk(scope,bucket))`.
- [x] `server/src/platform/config/index.ts` + test -- biến mới.
- [x] `server/.dependency-cruiser.cjs`, `server/dependency-rules.cjs`, fixture + test -- luật `ad6-meta-adapter-only`.
- [x] `server/test/meta-client.test.ts` -- client với HTTP server cục bộ: mọi dòng ma trận, `appsecret_proof` đúng, log không chứa token.
- [x] `deploy/runbook.md` + `server/.env.example` -- mục Meta Test App: tạo Test App từ app chính, Threads test app riêng, thêm tester, tunnel (cloudflared) cho callback dev, biến `.env` dev, cảnh báo không đổi callback app production; liên kết tài liệu Meta chính thức.

**Acceptance Criteria:**
- Given `npm run check`, when chạy, then thoát 0 và test mới phủ mọi dòng ma trận.
- Given một file trong `src/app/` import `src/adapters/meta/index.ts`, when chạy `npm run depcruise`, then báo vi phạm `ad6-meta-adapter-only`.
- Given `deploy/runbook.md`, when đọc mục Meta Test App, then có đủ bước để dev tạo app thử, đặt biến `.env`, mở tunnel mà không cần hỏi thêm.

## Implementation Notes

- `client.ts` gom cả hai instance: `createGraphClient` (`https://graph.facebook.com/{META_GRAPH_VERSION}`) và `createThreadsClient` (`https://graph.threads.net/v1.0`); không tách `graph.ts`/`threads.ts`.
- Token và `appsecret_proof` đi trong query (`access_token`, `appsecret_proof`); POST gửi body JSON. Log chỉ `metaPath` (bỏ query), status, kind, code, subcode, fbtraceId.
- Bucket của `meta_rate_state`: `app` (X-App-Usage, scope `app`), `buc:<objectId>` (X-Business-Use-Case-Usage, scope của lời gọi), `blocked` (lỗi RATE_LIMITED). `checkBudget` xét scope lời gọi + scope `app`. Mã `4` (mức app) chặn scope `app`.
- [ASSUMPTION] Usage ghi cách đây > 5 phút bị bỏ qua (`USAGE_TTL_MS`) để không kẹt hạng `background` mãi khi không còn lời gọi nào cập nhật số. Lỗi RATE_LIMITED không có `estimated_time_to_regain_access` → chặn mặc định 5 phút (`DEFAULT_BLOCK_MS`). Bucket đã qua `blocked_until` không còn tính usage.
- Store lỗi khi kiểm ngân sách → `TRANSIENT` (không gửi); store lỗi khi ghi usage → bỏ qua, lời gọi vẫn trả kết quả.
- Lỗi HTTP 5xx kèm mã lạ → `TRANSIENT`; 4xx mã lạ → `REJECTED`. Thêm `isRetryable(kind)`.
- `normalize.ts` trả `null` khi phản hồi không có id.
- Luật `ad6-meta-adapter-only` đọc danh sách từ `dependency-rules.cjs › metaCallers`.
- Log redact thêm `input_token`, `fb_exchange_token` (khoá và tham số query), `META_APP_SECRET`, `THREADS_APP_SECRET` (khoá).
- Sau review (vòng 1):
  - Scope app riêng cho từng client: `app:graph`, `app:threads`. Usage/chặn từ `X-Business-Use-Case-Usage` ghi ở scope `page:<objectId>` của chính đối tượng (bucket `buc`), không ở scope lời gọi. Hold theo usage giãn ±20%.
  - Lỗi: HTTP 429 (mã lạ / không mã) → `RATE_LIMITED` (dùng `Retry-After`); mã lạ kèm `is_transient: true` → `TRANSIENT`; 102, 2500 → `TOKEN_INVALID`; 341 chặn mức app như 4. Thêm kind `ABORTED` (caller huỷ, không retry, không log cảnh báo).
  - Client: ghi usage trước khi đọc body; 2xx body rỗng → `TRANSIENT` (204 → ok); `access_token`/`appsecret_proof` trong `params` hoặc query của path và segment `.`/`..` → ném lỗi lập trình.
  - **Lệch so với ma trận đã đóng băng** (dòng "Id bài FB đăng ảnh", theo yêu cầu review): thiếu `post_id` (chỉ có id ảnh trần) → `null` thay vì `{pageId}_{id}`, vì `{pageId}_{photoId}` không bao giờ khớp `post_id` của webhook. Cũng trả `null` khi `pageId` rỗng hoặc id mang tiền tố trang khác, và webhook FB không có `_` mà thiếu `pageId`.
  - Config: `META_VERIFY_TOKEN` (≥16 ký tự), `THREADS_APP_ENV`; cặp Threads phải đi cùng nhau; production cần `META_APP_SECRET` khi có `META_APP_ID` và `THREADS_APP_ENV=live` khi có `THREADS_APP_ID` (thêm vào `deploy/docker-compose.yml`, `deploy/env.production.example`). Redact thêm `appSecret`, `verifyToken`, `META_VERIFY_TOKEN`.
  - `connections.createMetaClients({config, db, log})` dựng `{graph, threads?}` từ cấu hình.
  - Tunnel trỏ Vite 5173; `web/vite.config.ts` thêm proxy `/oauth`, `/webhooks` và `allowedHosts` (`.trycloudflare.com` + `DEV_TUNNEL_HOSTS`).
- Runbook: mục mới "6. Meta Test App cho dev" (mục "Tóm tắt lệnh" thành 7). (Ban đầu tunnel trỏ api cổng 3000; đã đổi sang Vite, xem trên.)

- **Kiểm tra cuối (người điều phối):** `npm run check` qua (server 427, web 68, không dòng failed), build web qua, `drizzle-kit check` sạch. Story không có giao diện mới nên không thử trình duyệt; runbook và tunnel chưa thử với Meta thật. Dòng ma trận "Id bài FB đăng ảnh" đã được chủ sở hữu xác nhận đổi sang trả `null` (2026-10-22).

## Spec Change Log

## Review Triage Log

| # | Nguồn | Phát hiện | Verdict | Bằng chứng / route |
|---|---|---|---|---|
| 1 | blind, edge | Graph và Threads dùng chung scope `app` dù là hai app | medium | `APP_SCOPE` chung trong rate.ts; patch |
| 2 | blind, edge | Usage BUC ghi vào scope của bên gọi, không phải của đối tượng | medium | `recordUsage` ghép `buc:<id>` vào scope gọi; patch |
| 3 | blind, edge | 429 không mã → REJECTED; bỏ qua `is_transient`; 102/2500 không phải TOKEN_INVALID; 341 chỉ chặn một scope | medium | `kindOf` không xét HTTP 429/is_transient; patch |
| 4 | blind, edge | Caller huỷ bị coi là TRANSIENT có thể retry; 2xx rỗng thành ok; usage mất khi đọc body lỗi; `params` lách `access_token`; path `..` | low | client.ts; sửa trực tiếp; patch |
| 5 | vgap | 200 có `error` chưa có test | medium | vgap đã xác minh; patch |
| 6 | blind, edge | Hết TTL thì mọi job bị giữ cùng thử lại một lúc | low | retryAfterMs giống hệt; patch (jitter) |
| 7 | blind, edge | normalize: FB không pageId trả id trần; ảnh thiếu post_id; pageId rỗng / tiền tố trang khác | low | normalize.ts; sửa trực tiếp; patch |
| 8 | edge | Memory store không theo thứ tự updatedAt như DB store | low | sửa trực tiếp; patch |
| 9 | vgap | Upsert + chốt `updated_at` của rate store chưa có test | medium | vgap đã xác minh (2 lượt); patch |
| 10 | blind, edge | META_VERIFY_TOKEN chỉ có trong tài liệu; `appSecret` không redact; cặp Threads; production thiếu ràng buộc secret / Threads live | medium | config schema; patch |
| 11 | blind | Test config khẳng định trong catch, không ném vẫn qua | low | sửa trực tiếp; patch |
| 12 | blind, vgap | Không có gì dựng client từ config, biến mới chưa dùng | medium | không ai gọi createGraphClient; patch (factory trong connections) |
| 13 | blind, edge (claim) | Runbook: secret lộ qua argv curl, `set -a` xuất mọi bí mật; callback Threads Uninstall/Delete trỏ OAuth; thiếu chỉ dẫn cookie qua tunnel | medium | runbook §6.3–6.5; patch |
| 14 | blind | File snapshot 0006 không có trong diff | false | diff lọc snapshot có chủ ý; file có trên đĩa |
| 15 | edge (claim) | Kiểm ngân sách rồi gửi có thể đua khi nhiều job | low | jitter giảm dồn; đặt chỗ nguyên tử quá nặng cho app 1 người; reject phần còn lại |

Ghi chú: lượt review đầu chạy trên diff thiếu `adapters/meta` (lỗi lọc `-x meta` của người điều phối); đã dừng và chạy lại trên diff đầy đủ.

## Design Notes

Adapter không biết DB: nó nhận một `RateStore` (port) và module `connections` cài port đó. Như vậy bảng `meta_rate_state` vẫn thuộc `connections` (AD-1), còn adapter test được bằng store trong bộ nhớ.

```ts
const graph = createMetaClient({ baseUrl: GRAPH, version, appSecret, rateStore: connections.createRateStore(db) })
const r = await graph.get('/me/accounts', { token, tier: 'interactive', scope: `page:${pageId}` })
if (!r.ok && r.kind === 'TOKEN_INVALID') { /* AD-5, story 2.4 */ }
```

## Verification

**Commands:**
- `npm run check` -- expected: exit 0, không dòng "failed"
