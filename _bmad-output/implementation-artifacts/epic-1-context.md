# Epic 1 Context: Nền móng, đăng nhập và kết nối OpenAI

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Dựng backend mới cạnh frontend React đã có trong `web/` (đang chạy bằng dữ liệu mẫu) để chủ shop mở app trên tên miền HTTPS riêng, đăng nhập an toàn, nhập khoá OpenAI đã được kiểm, đặt hạn mức chi phí AI theo tháng và thấy chi phí. Epic này cũng tạo nền dùng chung cho mọi epic sau: monorepo, hợp đồng kiểu chung, hai tiến trình api/worker, hàng đợi, kênh realtime SSE, trung tâm thông báo và AI gateway duy nhất có chặn hạn mức.

## Stories

- Story 1.1: Khung monorepo, server hai tiến trình và hợp đồng chung
- Story 1.2: Đăng nhập chủ sở hữu và lớp gọi API của web
- Story 1.3: Triển khai production trên một VPS
- Story 1.4: Kênh realtime và trung tâm thông báo
- Story 1.5: Nhập và kiểm khoá OpenAI
- Story 1.6: AI gateway và hạn mức chi phí

## Requirements & Constraints

- Một chủ sở hữu duy nhất, không multi-tenant, không tạo tài khoản qua web. Mọi `/api/v1/*` cần phiên, trừ `/auth/login`; công khai chỉ có `/healthz`, `/webhooks/*`, `/media/*`, `/oauth/*/callback`, `/privacy/*`.
- Realtime: thay đổi hiển thị trên tab đang mở ≤3 giây sau khi ghi DB; mất kết nối thì tự nối lại và tải bù.
- Bí mật (khoá OpenAI, token Meta) mã hoá khi lưu, không bao giờ trả về client hay ghi log.
- Chi phí OpenAI không được vượt hạn mức tháng quá một lời gọi. Hạn mức 0 = chặn mọi lời gọi. Tháng tính theo lịch `Asia/Ho_Chi_Minh`.
- Khoá OpenAI chỉ lưu sau khi gọi kiểm tra thành công; khoá sai → "Khoá không hợp lệ", không lưu.
- Thông báo trong app cho: AI chuyển người, token sắp hết hạn, đăng bài lỗi, chiến dịch tạm dừng, job hết retry ở queue quan trọng; bật/tắt từng loại ở Cài đặt › Thông báo.
- Sao lưu Postgres + media hằng đêm, mã hoá, ở nhà cung cấp khác VPS, giữ 14 bản (RPO 24 giờ); khoá mã hoá không nằm trong backup.
- Web desktop ≥1280px, giao diện tiếng Việt có dấu; giữ Accessibility Floor khi nối API.
- Definition of Done cho phần `web/`: bỏ dữ liệu mẫu của phần đó, gọi API qua lớp client chung, kiểu lấy từ `packages/shared`, skeleton khi tải, lỗi qua bản đồ `ErrorCode` → microcopy; test unit cho nghiệp vụ, tích hợp với Postgres thật, fake adapter cho OpenAI/Meta.

## Technical Decisions

- **Kiến trúc:** modular monolith, npm workspaces `web`, `server`, `packages/shared`. Hai entrypoint: `api` (Fastify: REST, SSE, webhook, OAuth; không chạy việc nền dài) và `worker` (pg-boss: job, cron, consumer sự kiện). Postgres 18 là nguồn sự thật duy nhất cho dữ liệu, hàng đợi và LISTEN/NOTIFY; không Redis.
- **Ranh giới module:** mỗi bảng thuộc đúng một module; module khác chỉ đi qua `modules/<m>/index.ts`, không query chéo. Chiều phụ thuộc cố định (vd `ai`, `notifications` chỉ phụ thuộc nền `pages`/`settings`; `notifications` chỉ được entrypoint gọi, module khác báo qua sự kiện). Thực thi trong CI bằng `dependency-cruiser` (+ `no-circular`); dự phòng là oxlint `no-restricted-imports` sinh từ cùng bảng nếu spike với TS 7 thất bại.
- **Bảng thuộc Epic 1:** `settings` (`settings`, `secrets`, `sessions`), `ai` (`ai_usage`, `ai_model_prices`, `ai_budget_months`), `notifications` (`notifications`), platform (`worker_heartbeats`, schema `pgboss`).
- **Stack chốt:** Node 24 chạy TS bằng type stripping (`erasableSyntaxOnly`), kiểm kiểu `tsc --noEmit` với TS 7.0.2; Fastify 5.12.7; drizzle-orm 0.45.4 / drizzle-kit 0.31.11; pg-boss 12.38.0; zod 4.6.7; openai SDK 7.39.0; pino 10.4.0; vitest 5.0.5; dependency-cruiser 18.7.0; Caddy 2.
- **Hợp đồng API:** REST JSON `/api/v1`, mọi schema là zod ở `packages/shared` (export nguồn TS). Lỗi = HTTP status + `{error:{code, message, details?}}`, `code` thuộc enum `ErrorCode`; `message` chỉ cho dev. Phân trang cursor `{items, nextCursor}`, mặc định 50. Lỗi miền ném `AppError(code, details)`; adapter trả lỗi đã phân loại, không ném lỗi thô SDK.
- **Quy ước:** bảng/cột `snake_case`, JSON `camelCase`, job `<module>.<action>`, sự kiện `<entity>.<pastVerb>`; ID UUIDv7 dạng chuỗi; `timestamptz` UTC, API ISO 8601 có `Z`; tiền VND `bigint` (`*_vnd`), USD gốc `usd_micros`; enum định nghĩa một lần ở shared, DB lưu `text` + check constraint.
- **Mutation:** thay đổi trạng thái + enqueue job + phát sự kiện trong cùng một transaction Drizzle.
- **Hàng đợi:** mọi queue khai báo một lần ở `platform/jobs/queues.ts` (policy, retry, concurrency); `singletonKey` chỉ dùng với policy `stately`; cron dùng `tz: 'Asia/Ho_Chi_Minh'`. Job hết retry phát `job.failed`.
- **Sự kiện & realtime:** `packages/shared/events.ts` khai báo từng sự kiện với zod payload và cờ `realtime`; payload luôn có `id`, `pageId` nếu có. Phát bằng pg-boss `publish` trong transaction. Chỉ `platform/realtime` chuyển sự kiện `realtime=true` thành `NOTIFY realtime` `{type, entity, id, pageId}` ≤1 KB; module không tự NOTIFY (trừ `conversation.ai_typing`). SSE `GET /api/v1/stream`, heartbeat 25 giây. Client chỉ dùng sự kiện để vô hiệu hoá cache và refetch REST, không render payload. Consumer idempotent theo `(event, id, version)`.
- **Đăng nhập:** mật khẩu argon2id đặt bằng CLI `server set-password`; session trong bảng `sessions`, hạn 30 ngày trượt, xoay id khi đăng nhập; cookie `HttpOnly; Secure; SameSite=Lax`; giới hạn 5 lần/15 phút/IP, `@fastify/rate-limit` cho route ghi; kiểm `Origin` cho request ghi.
- **Bí mật:** AES-256-GCM dạng `v1:<keyId>:<iv>:<ciphertext>:<tag>`, khoá chủ từ `APP_ENCRYPTION_KEYS` + `APP_ENCRYPTION_ACTIVE_KEY` (hỗ trợ xoay, job `crypto.reencrypt`). API trả khoá OpenAI dạng `{configured, last4, status, checkedAt}`. pino `redact` cho token, authorization, apiKey, cookie, password; log chỉ ghi id, không ghi nội dung tin, prompt, SĐT.
- **AI gateway:** chỉ `modules/ai` gọi `adapters/openai`; mỗi lời gọi khai báo `feature` (enum `AiFeature`: `autoreply`, `autoreply_test`, `inbox_suggest`, `compose_caption`, `campaign_generate`, `brand_sample`, `image_generate`, `contact_summary`) và `pageId` nếu có. Giữ chỗ bằng `UPDATE ai_budget_months SET reserved_vnd = reserved_vnd + est WHERE spent_vnd + reserved_vnd + est <= limit_vnd RETURNING` (0 dòng → `AI_BUDGET_EXCEEDED`, không gọi); sau lời gọi, một transaction ghi `ai_usage` và chuyển ước tính thành chi phí thật. Cờ `alerted_80`/`alerted_100` lật bằng `UPDATE … WHERE alerted_x = false RETURNING` để phát `ai_budget.threshold_reached` đúng một lần dù api và worker chạy song song. Đổi hạn mức/tỉ giá → `settings.updated` → tính lại cờ, phát `ai_budget.restored`. Chi phí = usage × `ai_model_prices` × tỉ giá (mặc định 26.000 VND/USD, giả định). Gọi OpenAI với `store: false`. Chữ tương tác chạy trong request api, nút "Dừng" truyền `AbortSignal`.
- **Lỗi OpenAI:** adapter phân loại `KEY_INVALID` (401 → `secrets.status=invalid`, phát `openai_key.invalidated`, lời gọi sau trả `OPENAI_KEY_INVALID` không gọi ra ngoài) · `PROVIDER_QUOTA` · `RATE_LIMITED` · `CONTENT_REJECTED` · `TRANSIENT`. Job chỉ retry `RATE_LIMITED`/`TRANSIENT`; request tương tác không retry. Module gọi tự quyết phản ứng.
- **Model:** seed `gpt-6-luna` (chữ), `gpt-image-2.5-flare` (ảnh); model và kích thước ảnh đọc từ `settings`, danh sách cho FE lấy từ `ai_model_prices`.
- **Cấu hình & triển khai:** env đọc một lần ở `platform/config` bằng zod; thiếu biến bắt buộc hoặc production dùng id Meta test app (hay ngược lại) → không khởi động. Biến bắt buộc: `PUBLIC_BASE_URL`, `META_APP_ID/SECRET`, `THREADS_APP_ID/SECRET`, `META_VERIFY_TOKEN`, `APP_ENCRYPTION_KEYS`, `APP_ENCRYPTION_ACTIVE_KEY`, `SESSION_SECRET`, `DATABASE_URL`. Một VPS Docker Compose (`caddy`, `migrate` one-shot, `api`, `worker`, `postgres`); migration Drizzle chỉ tiến, tương thích ngược một phiên bản; image tag git SHA, giữ 5 tag để rollback; image Caddy có stage build `web/`. `/healthz` trả 503 khi heartbeat worker cũ hơn 2 phút, đĩa >85% hoặc DB lỗi. Chỉ hai môi trường: local (Meta Test App riêng) và production; không staging.
- **Kiểm thử:** vitest; fake adapter ở `adapters/*/fake.ts`; test tích hợp chạy Postgres thật trong docker.

## UX & Interaction Patterns

- **Màn đăng nhập:** chưa có trong spec UX — làm tối giản theo DESIGN.md (giả định); chưa có phiên thì chuyển tới đăng nhập rồi quay lại route ban đầu; bị khoá do thử sai → "Thử lại sau ít phút".
- **Microcopy:** ngắn, động từ đi đầu, xưng "bạn", tiếng Việt có dấu, không lộ mã kỹ thuật. Bản đồ `ErrorCode` → microcopy đặt ở đúng một file trong `web/`.
- **Đang tải:** skeleton đúng bố cục ở mọi màn.
- **Cài đặt › OpenAI:** dán khoá → "Kiểm tra và lưu" → "Đã kết nối" hoặc "Khoá không hợp lệ"; chọn model chữ/ảnh từ API (bỏ danh sách cứng hiện có trong `web/`), kích thước ảnh, ô tỉ giá VND/USD; hạn mức VND/tháng; bảng chi phí: tổng tháng, % hạn mức, chi phí + số lượng theo hạng mục "Trả lời tin nhắn / Sinh bài viết / Sinh ảnh" (gộp từ `AiFeature`). Lưu form bằng nút "Lưu" ở footer cố định, rời trang chưa lưu thì hỏi lại.
- **Chưa có khoá / khoá invalid:** mọi nút AI mờ, tooltip "Thêm khoá OpenAI ở Cài đặt" kèm liên kết, dựa trên trạng thái server.
- **Hạn mức:** 80% → toast + chip vàng ở sidebar (chỉ cảnh báo); 100% → banner đỏ toàn app "Đã dùng hết hạn mức AI tháng này — Tăng hạn mức"; tăng hạn mức thì banner biến mất. Sidebar hiện có thanh hạn mức dùng dữ liệu mẫu, cần nối dữ liệu server.
- **Realtime:** mất SSE → dải xám "Đang kết nối lại…", tự nối lại có backoff, refetch danh sách đang mở.
- **Toast** cho mọi thao tác nền (đăng bài, kết nối, AI xong) từ sự kiện SSE; trạng thái không chỉ bằng màu, chip luôn có chữ; thao tác chính dùng được bằng bàn phím.

## Cross-Story Dependencies

- 1.1 là nền cho tất cả: workspaces, `packages/shared` (`ErrorCode`, `events.ts`, enum), `platform/jobs/queues.ts`, heartbeat worker cho `/healthz`.
- 1.2 cung cấp phiên + lớp client API + bản đồ lỗi mà mọi story có phần `web/` dùng (gồm 1.4–1.6).
- 1.3 phụ thuộc 1.1 (healthz, migration) và 1.2 (header bảo mật, cookie Secure); cần trước khi Epic 2/4 nhận OAuth callback và webhook thật.
- 1.4 phụ thuộc 1.1 (sự kiện, queue); 1.6 dùng 1.4 cho toast/chip/banner hạn mức; các loại thông báo khác (token, đăng bài, chiến dịch, AI chuyển người) do Epic 2, 4–7 phát sự kiện.
- 1.5 cung cấp khoá đã mã hoá và trạng thái khoá; 1.6 dùng khoá đó và cập nhật `secrets.status` khi gặp 401.
- AI gateway (1.6) là điểm duy nhất gọi OpenAI cho Epic 3 (Viết thử), 4 (Gợi ý), 5 (AI trả lời), 6 (caption/ảnh), 7 (chiến dịch); phản ứng khi hết hạn mức ở Hộp thư, Soạn bài, Chiến dịch thuộc các epic đó.
