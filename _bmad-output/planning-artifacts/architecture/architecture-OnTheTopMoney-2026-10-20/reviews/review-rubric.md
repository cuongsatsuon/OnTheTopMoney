---
reviewer: rubric-walker (good-spine checklist)
target: ../ARCHITECTURE-SPINE.md (+ ../.memlog.md)
date: 2026-10-20
verdict: chưa đạt — cần sửa 1 critical + 5 high trước khi tách epic
---

# Đánh giá rubric — Architecture Spine OnTheTopMoney Backend

## Verdict

Phần lõi của spine vững: ranh giới module, cổng webhook, chủ sở hữu token, AI gateway, đăng bài theo từng trang đích, hợp đồng API. Nhưng spine **chưa đạt good-spine** vì hai lý do. Thứ nhất, chiều tuân thủ và xoá dữ liệu (Meta data deletion, retention) bị bỏ sót hoàn toàn, mà đây là điều kiện chặn go-live. Thứ hai, một số Rule dựa trên cơ chế không làm được điều đã hứa: `singletonKey` của pg-boss khi không khai báo queue policy, retry của Meta khi chưa có ngân sách rate limit chung, và tin echo của Meta. Các Rule này vì thế chưa ngăn được phân kỳ mà chính chúng nêu ra.

Tổng: **1 critical · 5 high · 14 medium · 10 low**.

## Kết quả theo từng mục checklist

| Mục checklist | Kết quả | Ghi chú |
|---|---|---|
| Cố định đúng các điểm phân kỳ cho epic, không bỏ sót | Một phần | Phủ tốt luồng chính F1–F7. Bỏ sót: xoá/giữ dữ liệu (C-1), tin echo và trả lời ngoài app (H-3), ràng buộc nền tảng khi đăng (H-5), tệp đính kèm đến (M-6), định nghĩa chỉ số (M-11), xem trước 7 bài trong wizard (M-12). |
| Rule của mỗi AD thực thi được và thực sự ngăn phân kỳ đã nêu | Một phần | AD-13 và AD-16 dựa vào `singletonKey` nhưng không khai báo queue policy (H-1). AD-6 retry riêng từng job, không có ngân sách chung (H-2). AD-1 lint chỉ chặn import sâu, không chặn mũi tên sai (M-10). |
| Không mục Deferred nào cho phép hai unit lệch nhau | Đạt, có lưu ý | Hoãn "Streaming token" sẽ đổi hợp đồng endpoint AI về sau (L-6). Hoãn "Chi tiết prompt" an toàn chỉ khi sinh caption nằm ở một chỗ (L-9). |
| Công nghệ đã xác minh còn hiện hành | Đạt | Đã kiểm lại trên npm ngày 2026-10-20: fastify 5.12.7, pg-boss 12.38.0 (13/10/2026), drizzle-orm 0.45.4, drizzle-kit 0.31.11, zod 4.6.7, openai 7.39.0, pino 10.4.0, vitest 5.0.5, typescript 7.0.2; máy dev chạy Node v24.18.0. Meta Graph v26.0 phát hành 29/07/2026; gpt-image-2 ra mắt 21/04/2026. Rủi ro toolchain với TS 7 ghi ở M-9. |
| Phê chuẩn, không mâu thuẫn codebase brownfield `web/` | Đạt, có lỗ hổng nhỏ | Phê chuẩn Vite + React 19 (đè đúng giả định Next.js cũ ở EXPERIENCE). Danh sách thay đổi so với `mock.ts` còn thiếu một số ánh xạ (L-2). Chưa quyết cách `web/` dùng `packages/shared` khi chưa có workspace gốc (M-9). Linter `web/` là oxlint, còn AD-1 dùng rule kiểu ESLint (M-9). |
| Mọi chiều cấu trúc ở altitude này đều được quyết / hoãn / mở | Chưa đạt | Xem bảng phủ chiều bên dưới. |

### Bảng phủ chiều cấu trúc

| Chiều | Trạng thái trong spine | Đánh giá |
|---|---|---|
| Triển khai | Đã quyết: 1 VPS, Docker Compose, Caddy, 1 api + 1 worker | Thiếu cách build/ship image, rollback, build `web/` (M-4) |
| Môi trường | `local` + `production`, không staging | Thiếu tách Meta app dev/prod; tunnel local sẽ giật webhook của prod (H-4) |
| Hạ tầng | Đã quyết | Thiếu dung lượng đĩa: media và Postgres chung đĩa (M-1) |
| Vận hành / quan sát | healthz + heartbeat; giám sát ngoài bị hoãn | Không có cảnh báo ngoài băng; job chết không ai biết (M-2) |
| Backup / khôi phục | pg_dump + media hằng đêm, giữ 14 bản | Chưa chốt nơi lưu, mã hoá, giữ khoá mã hoá, RPO/RTO (M-3) |
| Migration | "chạy trước khi api/worker khởi động" | Chưa rõ ai chạy, có đua giữa hai tiến trình không (M-4) |
| Bảo mật | AD-12, AD-19 | Thiếu chặn dò mật khẩu, kiểm tệp tải lên, header bảo mật, guardrail đầu ra AI (M-7, M-8) |
| Dữ liệu: retention, xoá theo yêu cầu | **Không có** | C-1 |
| Rate limit ra ngoài (Meta, OpenAI) | Chỉ có phân loại lỗi và retry | H-2, M-5 |
| Rate limit vào (login, API) | Không có | M-8 |
| Tuân thủ nền tảng Meta | Có mục "Điều kiện ngoài" về App Review | Thiếu Data Deletion, Privacy Policy, deauthorize (C-1) |

---

## Phát hiện

### CRITICAL

#### C-1 — Thiếu hoàn toàn quyết định về xoá dữ liệu, retention và tuân thủ dữ liệu Meta

**Vấn đề.** Spine lưu dữ liệu cá nhân của khách: tên, SĐT, ghi chú, tóm tắt AI, toàn bộ tin nhắn, payload thô trong `webhook_events`, nhật ký `autoreply_runs` và dữ liệu job của pg-boss. Không có AD nào nói dữ liệu này được giữ bao lâu và xoá theo cách nào. Các điểm cụ thể:
- Để chuyển app sang **Live mode**, Meta bắt buộc khai báo **Privacy Policy URL** và **User Data Deletion**, ở dạng callback hoặc URL hướng dẫn. Mục "Điều kiện ngoài (Meta)" chỉ nêu App Review và Business Verification, nên go-live sẽ bị chặn ở bước này.
- Cần phân biệt rõ hai thứ. Data Deletion Callback dành cho **người dùng Facebook Login**, tức chủ shop. Khách nhắn tin (PSID/IGSID) không đi qua callback này, nhưng Meta Platform Terms vẫn yêu cầu xoá Platform Data khi không còn cần, khi có yêu cầu, và khi app bị gỡ hoặc trang bị ngắt kết nối. Việt Nam cũng có Luật Bảo vệ dữ liệu cá nhân (hiệu lực 01/01/2026). Spine không có đường xoá nào cho cả hai trường hợp.
- Xoá chạm vào nhiều module: `inbox` (contacts, identities, conversations, messages), `autoreply` (runs), `webhooks` (events thô), `ai` (`ai_usage.ref`), `content` (media), hàng đợi và archive của pg-boss, và các bản backup 14 ngày. Không có chủ trì thì mỗi epic sẽ tự xoá một kiểu, hoặc không xoá gì. Đây đúng loại phân kỳ mà spine phải cố định.
- Trang bị ngắt kết nối hoặc chủ shop gỡ app (deauthorize) thì dữ liệu của trang đó xử lý ra sao: giữ, ẩn hay xoá? Spine chưa nói.
- Tin nhắn khách bị gửi sang OpenAI. Privacy policy cần khai báo việc này, và cần quyết có bật `store: false` hay không.

**Đề xuất sửa.** Thêm **AD-20 "Vòng đời dữ liệu và xoá theo yêu cầu"**, gồm:
1. Endpoint công khai `POST /webhooks/meta/deauthorize` và `POST /webhooks/meta/data-deletion`. Cả hai xác minh `signed_request` bằng app secret. Data-deletion trả `{url, confirmation_code}` trỏ tới trang trạng thái công khai `/xoa-du-lieu/<code>`. Thêm cả hai vào danh sách route công khai của AD-19.
2. Một điều phối duy nhất, ví dụ module `privacy` hoặc `pages.purge*`, phát sự kiện `page.purge_requested` / `contact.purge_requested`. Mỗi module sở hữu bảng tự xoá phần của mình qua `index.ts` rồi báo hoàn tất. Xoá chạy bằng job (AD-2) và ghi bảng `deletion_requests(code, scope, status, requested_at, completed_at)`.
3. Bảng retention ghi trong spine, các con số đánh dấu [ASSUMPTION]: `webhook_events` payload thô 30 ngày, sau đó giữ hash/metadata; archive pg-boss (`deleteAfter`/`archiveCompletedAfter`) 7 ngày; `autoreply_runs` 90 ngày; `sessions` hết hạn thì xoá; tin nhắn và khách giữ tới khi người dùng xoá hoặc trang bị gỡ quá N ngày; backup tự hết hạn theo vòng 14 ngày. Ghi rõ "xoá có hiệu lực hoàn toàn sau ≤14 ngày do backup".
4. Thao tác tay ở Khách hàng: "Xoá khách và toàn bộ hội thoại", dùng chung đường xoá với trên.
5. Thêm vào "Điều kiện ngoài": Privacy Policy URL, Terms URL, Data Deletion callback, App icon, mô tả dùng dữ liệu cho App Review. Ghi việc gửi dữ liệu sang OpenAI vào chính sách và quyết `store: false`.
6. Bổ sung redact cho AD-12: log không chứa nội dung tin nhắn, prompt hay SĐT, chỉ chứa id.

### HIGH

#### H-1 — `singletonKey` của pg-boss không làm được điều AD-13 và AD-16 hứa nếu không khai báo queue policy

**Vấn đề.** Theo tài liệu pg-boss hiện hành (v10 trở lên, gồm 12.x), queue mặc định là `standard`, và ở policy này `singletonKey` **không** đảm bảo duy nhất (chỉ dùng cho throttle khi có `singletonSeconds`). Tính duy nhất theo key chỉ có ở các policy `short`, `singleton`, `stately`, `exclusive`. Hệ quả:
- **AD-16** (`autoreply.run`, `singletonKey=conversationId`, trễ 8 giây). Dưới `standard`, mỗi tin khách tạo một job, và hai job của cùng hội thoại có thể chạy song song, khiến AI trả lời trùng cho khách thật. Đây đúng thứ AD-16 tuyên bố ngăn. Ngoài ra "trễ 8 giây để gộp" không phải debounce thật: tin thứ hai đến lúc giây thứ 7 sẽ tạo job thứ hai, hoặc bị từ chối, tuỳ policy.
- **AD-13** (`publish.target`, `singletonKey=targetId`). Nếu chọn `short` hoặc `exclusive`, kéo thả đổi lịch sẽ `send()` job mới cùng key trong khi job cũ vẫn đang chờ. Job mới **bị từ chối** (trả `null`) và bài không bao giờ được đăng mà không có lỗi nào. Nếu để `standard` thì key vô nghĩa. Lúc đó việc chống đăng hai lần chỉ còn nhờ kiểm phiên bản và `UPDATE … WHERE status='scheduled'`. Hai cơ chế này đủ chặn, nhưng Rule đang ghi sai cơ chế.

**Đề xuất sửa.** Thêm vào Consistency Conventions hoặc AD-2 một bảng **"Queue và policy"**. Mỗi queue tạo bằng `createQueue` khi khởi động worker, kèm policy, retry và concurrency:
- `autoreply.run`: policy `stately`, `singletonKey=conversationId`, gửi với `startAfter=8`. Như vậy chỉ có 1 job chờ và 1 job chạy cho mỗi hội thoại; tin đến trong lúc job đang chạy sẽ tạo đúng một job tiếp theo. Job khi chạy đọc **mọi** tin khách chưa trả lời, không chỉ tin đã kích hoạt nó.
- `publish.target`: policy `standard`, **không** dựa vào singletonKey. Lưu `publish_job_id` trên `post_targets`. Khi đổi lịch thì `cancel(oldJobId)` rồi `send` job mới, cả hai trong cùng transaction. Giữ nguyên kiểm `scheduled_at` khớp và khoá lạc quan như lớp phòng thủ cuối.
- `webhook.route`: `standard`. Có thể dùng `key_strict_fifo` theo `pageId:threadKey` nếu cần đúng thứ tự (xem M-13).
- Sửa AD-13 và AD-16 để trỏ về bảng này, bỏ câu "singletonKey chống trùng" chung chung.

#### H-2 — Không có ngân sách rate limit Meta dùng chung và không có thứ tự ưu tiên giữa các loại lời gọi

**Vấn đề.** AD-6 chỉ phân loại lỗi `RATE_LIMITED` rồi để từng job tự retry tối đa 5 lần. Trong khi đó, gửi tin (autoreply, người dùng), đăng bài theo chiến dịch, cron insight 6 giờ và cron làm mới token cùng tiêu một quota theo trang/app: Business Use Case rate limit của Pages và Messenger, quota IG theo tài khoản, **giới hạn đăng nội dung** (IG khoảng 100 bài API/24h, Threads 250 bài và 1000 trả lời/24h). Hệ quả:
- Cron insight có thể ăn hết quota đúng lúc khách đang nhắn, làm AI trả lời chậm hoặc lỗi.
- Retry riêng lẻ không đọc `X-Business-Use-Case-Usage` / `X-App-Usage` nên dễ dồn thành cơn bão retry.
- Chiến dịch có thể lên lịch vượt giới hạn đăng/24h mà không ai kiểm.

Như vậy mỗi epic (inbox, content, analytics) sẽ tự chế cơ chế chậm lại theo một kiểu. Prompt rubric cũng yêu cầu rõ chiều rate limit.

**Đề xuất sửa.** Mở rộng AD-6 hoặc thêm AD mới **"Ngân sách gọi Meta"**:
1. `adapters/meta` đọc các header usage sau **mỗi** lời gọi và ghi vào bảng `meta_rate_state(page_id|app, bucket, usage_pct, blocked_until)`.
2. Trước mỗi lời gọi, kiểm `blocked_until`. Có ba hạng ưu tiên: `interactive` (gửi tin) > `publish` > `background` (insight, đồng bộ). `background` dừng khi usage ≥ 75% [ASSUMPTION], `publish` dừng khi ≥ 90%, `interactive` chỉ dừng khi Meta chặn thật.
3. Lỗi `RATE_LIMITED` thì job hoãn tới `blocked_until` (không backoff mù) và không tính vào 5 lần retry.
4. `content` kiểm giới hạn đăng/24h theo nền tảng khi lên lịch (dùng `content_publishing_limit` của IG/Threads) và từ chối với mã `PUBLISH_LIMIT_REACHED`. `campaigns` dùng cùng hàm khi tạo slot.
5. Thêm `RATE_LIMITED` vào microcopy "Gửi quá nhanh, thử lại sau ít phút" (đã có trong EXPERIENCE).

#### H-3 — Chưa quyết cách xử lý tin echo và tin do chủ shop gửi từ ngoài app

**Vấn đề.** Messenger và IG gửi lại webhook `is_echo` cho mọi tin trang gửi đi, gồm tin do chính worker gửi và tin chủ shop trả lời trên Meta Business Suite hoặc app điện thoại. Spine im lặng về việc này:
- **Đua ghi:** worker gửi tin rồi mới nhận `message_id` từ response, trong khi echo có thể tới trước. Khi đó `inbox.ingest` theo AD-11 upsert theo `platform_message_id` và tạo một dòng thứ hai (dòng của worker chưa có id), sinh tin trùng trong Hộp thư.
- **Phân kỳ trạng thái:** chủ shop trả lời từ điện thoại mà hội thoại vẫn ở `ai`, nên AI tiếp tục trả lời chồng lên. AD-9 chỉ có "handoff → human: người dùng gửi tin" cho tin gửi trong app.
- Bình luận trên trang cũng có sự kiện do chính trang tạo (`from.id = page_id`).

Webhooks/inbox và inbox.send là hai unit khác nhau, và cả hai đều sẽ tự đoán cách xử lý.

**Đề xuất sửa.** Bổ sung vào AD-11 và AD-9:
1. Tin gửi đi được tạo trước với `client_ref` (UUIDv7). Gửi qua Meta kèm `metadata=client_ref` (Messenger hỗ trợ `metadata`, echo trả lại). Echo có `metadata` khớp thì cập nhật dòng sẵn có; echo không có `metadata` là tin gửi ngoài app, ghi `from=human`, `source=external`.
2. Thêm chuyển trạng thái `ai → human` (và `handoff → human`) khi nhận echo `source=external`, với reasonCode `HUMAN_REPLIED_EXTERNALLY` (thêm vào enum HandoffReason hoặc một enum lý do chuyển riêng).
3. Comment hoặc reply có tác giả là chính trang thì đi cùng đường đối chiếu này.
4. Ghi rõ trong AD-16: job `autoreply.run` kiểm lại trạng thái hội thoại **ngay trước khi gửi**, không chỉ lúc bắt đầu.

#### H-4 — Môi trường local dùng tunnel nhưng không tách Meta app; dev sẽ giật webhook của production

**Vấn đề.** Mỗi Meta app chỉ có **một** callback URL webhook cho mỗi object (page, instagram), và Threads app cũng vậy. Spine ghi: local "webhook qua tunnel như cloudflared", production một VPS, không staging, nhưng không nói dùng bao nhiêu Meta app. Nếu dùng chung một app, mỗi lần dev trỏ callback về tunnel thì production ngừng nhận tin. Đây chính là state "Webhook ngừng nhận tin". Ngoài ra OAuth redirect URI, `META_APP_SECRET` và verify token cũng phải khác nhau giữa hai môi trường. Sau khi app lên Live, thử nghiệm trên app production sẽ chạm vào khách thật.

**Đề xuất sửa.** Thêm vào Structural Seed › Môi trường:
- `local` dùng **Meta Test App** (tạo từ app chính, tự ở Development mode, có callback và secret riêng) và một Threads test app riêng. `production` dùng app Live.
- Bảng biến môi trường bắt buộc theo môi trường: `META_APP_ID/SECRET`, `THREADS_APP_ID/SECRET`, `META_VERIFY_TOKEN`, `PUBLIC_BASE_URL`, `OAUTH_REDIRECT_BASE`. `platform/config` từ chối khởi động nếu `NODE_ENV=production` mà dùng id của test app, hoặc ngược lại.
- Ghi rõ: không bao giờ đổi callback URL của app production sang tunnel.

#### H-5 — Ràng buộc nền tảng khi đăng bài chưa được cố định ở một chỗ (IG bắt buộc có ảnh, giới hạn độ dài…)

**Vấn đề.** Instagram không cho đăng bài chỉ có chữ. Threads giới hạn 500 ký tự. IG giới hạn caption khoảng 2.200 ký tự và tối đa 30 hashtag. Kích thước và tỉ lệ ảnh mỗi nền tảng cũng khác nhau. Spine không có hàm hoặc AD nào cố định các ràng buộc này. Chiến dịch có "tỉ lệ bài có ảnh AI" < 100%, và AD-14 nói "ảnh bị từ chối → caption không bị ảnh hưởng". Gộp lại, slot IG không có ảnh ở chế độ "Tự đăng" sẽ được `scheduled`, lỗi lúc đăng, ba lần lỗi thì chiến dịch tự dừng. Composer, campaigns và job publish sẽ mỗi nơi kiểm một kiểu.

**Đề xuất sửa.** Thêm vào AD-13 hàm duy nhất `content.validateTarget(target)`, trả danh sách vi phạm, dùng bảng ràng buộc theo `Platform` đặt ở `packages/shared` để FE kiểm sớm cùng luật. Hàm được gọi khi chuyển sang `scheduled` (composer, duyệt bài, cron chiến dịch) và lại một lần trong job trước khi gọi Meta. Ở AD-15: slot IG luôn cần ảnh (tỉ lệ ảnh chỉ áp cho FB/Threads); ảnh lỗi ở chế độ Tự đăng thì slot về `pending_approval` với `IMAGE_REJECTED`/`MEDIA_REQUIRED`. Thêm `MEDIA_REQUIRED`, `CAPTION_TOO_LONG` vào `ErrorCode`.

### MEDIUM

#### M-1 — Dọn media mồ côi và dung lượng đĩa
Composer sinh 4 ảnh nhưng chỉ dùng 1, ảnh tải lên rồi bỏ, ảnh tạo lại: tất cả nằm mãi trên volume local, chung đĩa với Postgres. **Sửa:** `media_assets.status` (`orphan|attached`) cùng cron xoá ảnh `orphan` quá 7 ngày [ASSUMPTION]. Không xoá ảnh của bài đã đăng (IG/Threads đã sao chép khi đăng, FB cũng vậy). Thêm ngưỡng cảnh báo đĩa (xem M-2). Ghi giới hạn kích thước tệp tải lên.

#### M-2 — Quan sát và cảnh báo ngoài băng còn thiếu
healthz và heartbeat nằm trong chính hệ đang theo dõi; VPS chết thì không ai biết cho tới khi chủ shop mở app. Meta có thể **tắt subscription webhook** nếu giao tin lỗi kéo dài. Job lỗi hết retry (vd `webhook.route` do bug) làm mất tin mà không có dấu vết trên UI. **Sửa:**
- Một uptime ping ngoài miễn phí gọi `/healthz`. Endpoint này trả 503 khi heartbeat worker cũ hơn 2 phút, khi đĩa trên 85%, hoặc khi Postgres không truy cập được. Việc này rẻ và không mâu thuẫn mục Deferred, vì Deferred hoãn hệ giám sát chứ không cấm ping.
- `webhook_events.status` (`received|routed|failed`) cùng thao tác "Xử lý lại" ở Cài đặt › Webhook.
- Job hết retry phát sự kiện `job.failed` và tạo `notifications` cho các queue quan trọng.
- Ghi rõ nơi xem log trên VPS (`docker logs` có rotation, vd `max-size`).

#### M-3 — Backup chưa đủ để khôi phục thật
**Sửa:** chốt nơi lưu (vd R2/B2 khác nhà cung cấp VPS), **mã hoá backup** (age/gpg) vì backup chứa PII, **lưu `APP_ENCRYPTION_KEYS` ở chỗ riêng ngoài backup** (thiếu khoá thì token và khoá OpenAI trong backup thành rác), RPO 24h / RTO vài giờ [ASSUMPTION], diễn tập khôi phục định kỳ (quý), dùng `pg_dump -Fc` và kiểm checksum. Ghi tương tác với C-1: xoá dữ liệu hoàn tất khi các bản backup cũ hết hạn.

#### M-4 — Migration và quy trình triển khai chưa rõ
"Migration Drizzle chạy trước khi api/worker khởi động" chưa nói ai chạy; nếu cả hai tiến trình cùng chạy thì sẽ đua. **Sửa:** thêm service one-shot `migrate` trong compose; `api` và `worker` `depends_on: condition: service_completed_successfully`. Migration chỉ tiến (forward-only), rollback bằng image cũ cộng migration tương thích ngược ít nhất một phiên bản. Image gắn tag theo git SHA, giữ N tag gần nhất để rollback. Ghi rõ ai build `web/` (stage build trong image Caddy) và Caddy cần SPA fallback cho route tiếng Việt (`/hop-thu`…) trong khi `/api`, `/webhooks`, `/oauth`, `/media` đi đúng đích. pg-boss tự migrate schema khi `start()` (có advisory lock) cần ghi lại để không ai viết migration tay cho nó.

#### M-5 — Thiếu phân loại lỗi OpenAI tương tự AD-6
AD-7 chỉ có `OPENAI_KEY_MISSING` và `AI_BUDGET_EXCEEDED`. **Sửa:** `adapters/openai` phân loại: `KEY_INVALID` (401, cập nhật `secrets.status`), `QUOTA_EXHAUSTED` (`insufficient_quota`, khác hạn mức nội bộ), `RATE_LIMITED` (429), `CONTENT_REJECTED` (ánh xạ `IMAGE_REJECTED`), `TRANSIENT` (5xx, timeout). Chỉ retry `RATE_LIMITED`/`TRANSIENT` trong job; request tương tác thì không retry. Đặt concurrency cho `ai.image.generate` (vd 2) và timeout cho mỗi loại lời gọi. Autoreply gặp `KEY_INVALID`/`QUOTA_EXHAUSTED` thì handoff với reasonCode tương ứng.

#### M-6 — Tệp đính kèm và sự kiện không phải chữ chưa có quyết định
Khách gửi ảnh, voice, sticker, story mention/reply (IG), reaction, thu hồi tin, sửa hay xoá bình luận, đã đọc. Message trong mock chỉ có `text`. URL đính kèm của Meta CDN **hết hạn**, nên lưu URL gốc sẽ vỡ ảnh sau vài ngày. **Sửa:** quyết `messages.attachments[]` (type, `media_asset_id`), tải đính kèm về `MediaStore` trong `inbox.ingest`. Autoreply gặp tin không phải chữ thì handoff với `NON_TEXT_MESSAGE` [ASSUMPTION], hoặc ghi rõ là bỏ qua. Bình luận bị xoá thì đánh dấu. Ghi chủ sở hữu trạng thái `unread` (thuộc `inbox`, không đồng bộ ngược lên Meta ở v1). Quyết có gửi `sender_action: typing_on` khi `conversation.ai_typing` hay không.

#### M-7 — Không có guardrail xác định cho đầu ra AI gửi thẳng tới khách
Tin khách đi thẳng vào prompt, nên khách có thể prompt-inject để AI hứa giảm giá hay bịa chính sách, và kết quả được gửi tự động. Hồ sơ thương hiệu có `banned` (từ cấm) nhưng spine không bắt kiểm. **Sửa:** thêm vào AD-16 bước hậu kiểm xác định trước `inbox.send`: chứa từ cấm thì handoff `AI_POLICY_BLOCKED`; giới hạn độ dài; chặn URL không nằm trong danh sách cho phép; không lặp lại kịch bản hệ thống. Cùng hàm hậu kiểm áp cho caption bài đăng ở chế độ Tự đăng.

#### M-8 — Bảo mật bề mặt internet còn mỏng
**Sửa:** giới hạn tốc độ `/api/v1/auth/login` (vd 5 lần/15 phút/IP, khoá tạm), `@fastify/rate-limit` cho route ghi; thời hạn session (vd 30 ngày trượt) và xoay session id khi đăng nhập; tuỳ chọn TOTP [ASSUMPTION] vì tài khoản này điều khiển nhiều Fanpage và khoá OpenAI. Kiểm tệp tải lên: allowlist MIME bằng magic bytes (jpeg/png/webp; không SVG), giới hạn kích thước, bỏ EXIF. Trích văn bản PDF cho kho kiến thức chạy trong worker có timeout, không chạy trong api. Header bảo mật ở Caddy: CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`. `/media/*` đặt `Content-Disposition: inline` với đúng content-type.

#### M-9 — Monorepo và toolchain chưa quyết, có rủi ro với TypeScript 7
`web/` có `package.json` và lockfile riêng, không có workspace gốc, nhưng spine yêu cầu `web/` và `server/` cùng import `packages/shared`. Linter của `web/` là **oxlint**, còn AD-1 dựa vào `import/no-restricted-paths` (rule ESLint). TS 7 (bản native) đổi API lập trình, nên công cụ dựa vào API của TS (typescript-eslint, một số plugin) có thể chưa hỗ trợ. **Sửa:** chốt npm workspaces ở gốc (`web`, `server`, `packages/shared`), cách build shared (nguồn TS export trực tiếp hay build ra JS), cách chạy server (Node 24 type-stripping, hoặc build bằng `tsgo` rồi chạy JS). Chốt linter chung và cách thực thi ranh giới (xem M-10). Thêm một spike xác nhận drizzle-kit, vitest và linter chạy với TS 7.0.2 trước epic đầu.

#### M-10 — Sơ đồ phụ thuộc chưa đủ và lint không thực thi được mũi tên
Thiếu `analytics → content`: insight bài lấy theo `platform_post_id` nằm ở `post_targets`, "bài AI tạo vs tự viết" cần `posts`. AD-1 nói `notifications` "không ai import", nhưng route `GET /notifications` ở `app` phải gọi nó. Rule lint `import/no-restricted-paths` chỉ chặn import vào ruột module; nó không chặn `inbox` import `campaigns/index.ts` (mũi tên sai) và không chặn vòng. **Sửa:** bổ sung mũi tên còn thiếu; cho phép entrypoint import mọi module. Thực thi đồ thị bằng `dependency-cruiser` (hoặc rule tương đương) với danh sách cho phép **sinh từ đúng bảng mũi tên trong spine**, cộng rule `no-circular`, chạy trong CI.

#### M-11 — Định nghĩa chỉ số hiệu suất chưa cố định
Meta đã bỏ dần `impressions` và chuyển sang `views` ở Page và IG insights. Mỗi nền tảng có tập metric khác nhau. Mock dùng `reach`, `engagement`. Không có định nghĩa chung thì analytics và FE (cùng "Hiệu quả AI", "tương tác gấp 3") sẽ hiểu khác nhau. **Sửa:** thêm vào AD-17 bảng chỉ số chuẩn ở `packages/shared` (vd `views`, `reach`, `engagement = reactions + comments + shares + saves`, `followers_delta`), cách ánh xạ từ metric gốc của từng nền tảng, và "không có" khi nền tảng không cung cấp (null, không phải 0).

#### M-12 — Wizard chiến dịch: "AI tạo trước 7 bài đầu để xem" chưa có chỗ
Flow 3 bước 4 cần sinh 7 bài, có ảnh, trước khi "Bắt đầu". Spine chỉ nói "Bắt đầu" thì tạo slot và cron sinh dần. Chưa rõ 7 bài xem trước nằm ở đâu: `post_targets` của chiến dịch `draft`? Sinh trong request (vượt AD-2 với ảnh) hay bằng job? Khi "Bắt đầu" thì chúng thành 7 slot đầu hay bị bỏ? **Sửa:** chiến dịch `draft` có `post_targets(status=draft)` sinh bằng job `campaign.preview`; "Bắt đầu" giữ lại 7 bài này làm slot đầu (đã duyệt) và tạo các slot còn lại.

#### M-13 — Cổng webhook: độ mịn chống trùng và thứ tự xử lý
Một POST của Meta chứa nhiều `entry` và nhiều `messaging`/`changes`. Khoá chống trùng `(platform, object_id, event_time, hash)` theo cả POST sẽ để lọt trùng khi Meta gửi lại batch với cách gom khác. Job `webhook.route` chạy song song có thể ingest tin sau trước tin trước. **Sửa:** tách ở api thành mỗi item một dòng `webhook_events`, khoá chống trùng theo `mid`/`comment_id` khi có (fallback hash của item). Thứ tự hiển thị theo `platform_timestamp` chứ không theo `created_at`. `last_customer_message_at` chỉ tăng (`GREATEST`).

#### M-14 — AD-7: chống phát trùng sự kiện ngưỡng giữa api và worker; luật vượt nhẹ chỉ có ở memlog
api (chữ tương tác) và worker cùng gọi gateway, nên "vượt 80% lần đầu trong tháng" có thể bị phát hai lần. Memlog ghi "cho phép vượt nhẹ 1 lời gọi, đối soát sau", nhưng Rule của AD-7 không ghi. **Sửa:** bảng `ai_budget_alerts(month, level)` có unique constraint, chỉ phát sự kiện khi insert thành công. Đưa luật "ước tính trước, đối soát sau, cho phép vượt tối đa một lời gọi đang chạy" vào Rule.

### LOW

- **L-1** — `companions: ../epics.md` trỏ tới tệp chưa tồn tại trong `planning-artifacts/`. Sửa đường dẫn hoặc ghi "sẽ tạo".
- **L-2** — Danh sách enum ở Conventions thiếu `ContactStage` (mock dùng chuỗi tiếng Việt `'Mới'…` nên cần mã ổn định), `Channel`, `MessageSender`, `CampaignMode`, `CampaignGoal`. Mục "Thay đổi so với mock.ts" thiếu `PostStatus 'pending' → 'pending_approval'`, giá trị `CampaignStatus` (`running|paused|done|draft`) và các trường dẫn xuất `Group.activeCampaigns`, `Campaign.postsDone`, `nextPost`, `trend`.
- **L-3** — Cron của pg-boss nên đặt rõ `tz: 'Asia/Ho_Chi_Minh'` (insight hằng ngày, làm mới token, cron chiến dịch), nếu không sẽ chạy theo UTC của container.
- **L-4** — AD-12: thiếu job mã hoá lại khi xoay khoá (`v1:<keyId>` cũ sang khoá active). Pino `redact` với `*.token` chỉ bắt một cấp, nên thêm `*.*.token`, `headers.cookie`, `body.password`.
- **L-5** — Tên miền và TLS chưa nêu. Meta bắt buộc HTTPS hợp lệ cho callback; ghi `PUBLIC_BASE_URL` là câu hỏi mở cùng giả định Singapore.
- **L-6** — Hoãn streaming nhưng chưa cố định hợp đồng endpoint AI tương tác (JSON một lần, huỷ bằng abort). Nên ghi rõ để khi bật streaming (SSE/NDJSON) thì là endpoint mới, không đổi endpoint cũ.
- **L-7** — Nói rõ đường kết nối IG là "Instagram qua Facebook Login for Business" (khớp quyền `instagram_basic`…, và EXPERIENCE yêu cầu IG Business liên kết Fanpage), không dùng Instagram Login. Việc này ảnh hưởng host Graph và tên quyền.
- **L-8** — Dòng Stack "Node.js 24 LTS (lên 26 sau 28/10/2026)" dễ hiểu thành phải nâng cấp ngay. Nên ghi "v1 pin Node 24; xét Node 26 khi đã LTS và các phụ thuộc hỗ trợ".
- **L-9** — Sinh caption dùng ở composer, campaigns và "Viết thử" (profiles). `profiles` nằm dưới `content` nên không gọi được content. Đặt mẫu prompt caption ở một chỗ (vd `modules/ai/prompts/caption.ts` export qua `ai/index.ts`) để mục Deferred "Chi tiết prompt" thật sự không gây lệch.
- **L-10** — SSE qua Caddy: cần `flush_interval -1`, heartbeat comment mỗi khoảng 25 giây, và giới hạn một luồng cho mỗi tab để tránh rò kết nối LISTEN. Đây là chi tiết story, ghi một dòng trong AD-3 là đủ.

---

## Điểm mạnh nên giữ

- Bảng module sở hữu bảng (Structural Seed) cùng AD-1 tạo ranh giới rõ cho epic.
- AD-4 làm đúng cổng webhook: HMAC trên raw body, đúng secret theo sản phẩm, ghi, enqueue, trả 200.
- AD-5 và AD-6 tập trung token và Meta client, có phân loại lỗi, lỗi 190 đi một đường.
- AD-9 có sơ đồ trạng thái hội thoại với một chủ duy nhất; AD-10 có cửa sổ gửi tin trong một hàm.
- AD-13 lưu trạng thái theo từng trang đích, khoá lạc quan và kiểm phiên bản khi job chạy.
- AD-3 dùng sự kiện như gợi ý vô hiệu hoá rồi refetch REST, tránh payload lệch.
- Các giả định được gắn [ASSUMPTION] nhất quán; công nghệ đã xác minh còn hiện hành.

## Thứ tự sửa đề xuất

1. C-1 (AD-20 vòng đời dữ liệu cùng bổ sung Điều kiện ngoài), H-4 (tách Meta app theo môi trường): chặn go-live hoặc vận hành.
2. H-1, H-3: sửa Rule hiện có để thật sự ngăn trả lời trùng hoặc chồng.
3. H-2, H-5: thêm ngân sách Meta và `validateTarget`.
4. Các mục medium theo epic liên quan; low gộp vào lần cập nhật spine kế tiếp.
