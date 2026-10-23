---
title: 'Story 5.2 — Kho kiến thức'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '602e0cd88a864faed6a7f7cd95fe6a730b3e2241'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-5-1-cau-hinh-ai-tra-loi.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 5.2; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Mục "Kho kiến thức" của form AI trả lời đang hiện "chưa mở" với nhóm/trang thật. Server chưa có `knowledge_items`, nên chủ shop chưa tải được bảng giá/chính sách hay thêm câu hỏi thường gặp, và chưa có gì chặn bật AI khi kho vượt giới hạn prompt.

**Approach:** `profiles` sở hữu `knowledge_items` theo chủ `(owner_type, owner_id)` như `autoreply_configs`, đi cùng cấu hình AI trong registry kế thừa (sao chép/xoá cùng cấu hình). File (pdf/docx/txt) gửi nguyên bytes, kiểm magic bytes + kích thước, lưu `PrivateFileStore`, ghi `processing` + enqueue `profiles.knowledge.extract` cùng transaction. Worker trích văn bản trong `worker_threads` có timeout cứng (pdf bằng `unpdf`, docx bằng đọc zip tự viết, txt giải mã) → `ready|failed|too_large`, phát `knowledge_item.processed`. FAQ `ready` ngay. Lưu cấu hình ở trạng thái bật (kể cả hàng loạt) mà tổng token `ready` > 40.000 → `KNOWLEDGE_TOO_LARGE`. FE nối mục Kho kiến thức vào API.

## Boundaries & Constraints

**Always:**
- Thay đổi kho áp ngay (không chờ "Lưu cấu hình"). Chỉ ghi được kho của nhóm, trang không nhóm, hoặc trang đang dùng cấu hình riêng (đã lưu). Trang đang theo nhóm → 400 `VALIDATION_FAILED`; FE xem kho của nhóm, chỉ đọc.
- File: `application/pdf` (`%PDF-` trong 1024 byte đầu), docx (zip có `word/document.xml`), `text/plain` (UTF-8, hoặc UTF-16 có BOM; không có byte NUL). 1 byte–10 MB. MIME khai báo phải khớp loại nhận dạng. Tên file gửi qua header `X-File-Name` (percent-encoded).
- Token ước tính = `ai.estimateInputTokens(số ký tự)` (ký tự ÷ 2). Giới hạn `KNOWLEDGE_MAX_TOKENS = 40000` [ASSUMPTION] tính trên tổng mục `ready` (file + FAQ) của một chủ. Tối đa 100 mục mỗi chủ.
- Bất biến khi cấu hình của chủ đang BẬT: tổng `ready` không vượt giới hạn. Thêm FAQ làm vượt → 422 `KNOWLEDGE_TOO_LARGE`. File trích xong làm vượt → mục đó `too_large`. Một file tự nó vượt giới hạn → `too_large` bất kể cấu hình.
- Job `profiles.knowledge.extract` (standard, retry 2, concurrency 1, AD-24) xử lý theo file. Mọi mục `processing` cùng file (bản sao do kế thừa) được kết thúc cùng lúc bằng `UPDATE … WHERE status='processing'`. Lỗi tải tạm (5xx/429) → retry; lần cuối → `failed`. Trích văn bản chạy trong thread riêng, timeout 60 giây, giới hạn bộ nhớ. Hết giờ → `failed EXTRACT_TIMEOUT`, không retry.
- Mục đã kết thúc giữ văn bản ở DB; file gốc bị xoá khỏi Cloudinary (best-effort) khi không còn mục nào trỏ tới nó. Xoá mục đang `processing` cũng xoá file nếu không còn mục nào dùng.
- Kế thừa: `setUseOwn(true)`/rời nhóm sao chép cả kho (thay kho đích, idempotent). `setUseOwn(false)`/vào nhóm có cấu hình/xoá nhóm xoá kho của chủ bị bỏ.
- Lỗi adapter media dùng một bảng ánh xạ chung ở `app/` (logo + kho) → `ErrorCode` có câu tiếng Việt; thêm `UPLOAD_FAILED`.
- Ranh giới AD-1 (`profiles → ai`), depcruise sạch. Không log tên file, câu hỏi hay văn bản.

**Never:**
- Không RAG, không embeddings (prompt nhét toàn bộ văn bản — AD-16), không extension Postgres mới.
- Không nhận XLSX/CSV, không OCR PDF scan, không sửa FAQ (xoá rồi thêm lại), không tải file gốc về từ app.
- Không dùng kho trong prompt ở story này (5.3/5.4), không đổi "Thử AI".

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tải PDF | `Bảng giá.pdf` hợp lệ, nhóm | 201 mục `file` `processing`; file ở kho riêng tư (authenticated); 1 job enqueue | |
| Sai loại / giả mạo | `.exe` khai `application/pdf`; zip không có `word/document.xml` | Không lưu | 400 `VALIDATION_FAILED` path `file` |
| Quá lớn / rỗng | > 10 MB hoặc 0 byte | Không lưu | 400 path `file` (Fastify 413 → `VALIDATION_FAILED`) |
| Chưa cấu hình Cloudinary | không `CLOUDINARY_URL` | Không ghi mục | 500 `MEDIA_NOT_CONFIGURED` |
| Kho lỗi khi tải lên | Cloudinary 5xx | Không ghi mục | 502 `UPLOAD_FAILED` |
| Trích xong | job chạy với pdf/docx/txt | `ready`, `tokenCount`, văn bản lưu, file gốc bị xoá; phát `knowledge_item.processed` | |
| File hỏng / có mật khẩu / không chữ | pdf hỏng, pdf mã hoá, pdf chỉ có ảnh | `failed` `UNREADABLE` / `PASSWORD_PROTECTED` / `NO_TEXT`; phát sự kiện | không retry |
| Hết giờ | thread vượt timeout | `failed EXTRACT_TIMEOUT`; thread bị huỷ | không retry |
| Tải về lỗi tạm | `get` 5xx lần đầu / lần cuối | ném để retry / `failed FILE_UNAVAILABLE` | |
| Job chạy lại | mục đã `ready` hoặc đã xoá | `skipped`, không đổi gì; file không còn ai dùng thì xoá | |
| File quá lớn sau trích | > 40k token | `too_large` `KNOWLEDGE_TOO_LARGE`, giữ `tokenCount` | |
| Vượt khi đang bật | cấu hình bật, tổng + file mới > 40k | file mới `too_large` | |
| Thêm FAQ | "Phí giao hàng?" + câu trả lời | 201 `faq` `ready` có `tokenCount` | thiếu câu hỏi/trả lời → 400 |
| FAQ làm vượt khi bật | cấu hình bật, tổng + FAQ > 40k | Không lưu | 422 `KNOWLEDGE_TOO_LARGE` |
| Lưu bật khi kho vượt | cấu hình tắt, kho `ready` > 40k, PUT `enabled=true` | Không lưu | 422 `KNOWLEDGE_TOO_LARGE`; tắt thì lưu được |
| Hàng loạt bật khi kho vượt | trang hiệu lực có kho > 40k | Trang khác vẫn xử lý | `failed[{code:'KNOWLEDGE_TOO_LARGE'}]` |
| Trang theo nhóm ghi kho | POST FAQ / file / DELETE cho trang đang theo nhóm | Không đổi | 400 `VALIDATION_FAILED` |
| Dùng riêng / bỏ riêng | PUT page config (trang theo nhóm) / use-own `false` | Kho nhóm được sao chép sang trang / kho trang bị xoá | |
| Rời / xoá nhóm | `page.group_changed {A,null}`, `group.deleted` | Trang giữ bản sao kho; chạy lại không nhân đôi | |
| Xoá mục | DELETE mục FAQ / file `processing` | 204; file không còn ai dùng thì xoá khỏi kho | id lạ → 404 |
| Chủ lạ | GET/POST owner không tồn tại | | 404 `NOT_FOUND` |

</frozen-after-approval>

## Code Map

- `packages/shared/src/knowledge.ts` (mới), `errors.ts`, `events.ts`, `index.ts` -- hợp đồng kho, `UPLOAD_FAILED`, payload `knowledge_item.processed`
- `server/package.json` -- thêm `unpdf` 1.8.1 (pdf.js gói sẵn, không phụ thuộc)
- `server/src/modules/profiles/schema.ts` -- bảng `knowledge_items`
- `server/src/modules/profiles/knowledge-row.ts` (mới) -- DTO, tổng token, sao chép/xoá theo chủ (registry gọi)
- `server/src/modules/profiles/knowledge-files.ts` (mới) -- nhận dạng loại file, đọc zip/docx, trích văn bản (thuần)
- `server/src/modules/profiles/knowledge-extract-thread.ts` (mới) -- entry `worker_threads`; `runExtraction` có timeout cứng
- `server/src/modules/profiles/knowledge.ts` (mới) -- list/thêm FAQ/tải file/xoá, job trích
- `server/src/modules/profiles/{autoreply-row,autoreply,index}.ts` -- ops kéo theo kho; kiểm `KNOWLEDGE_TOO_LARGE` khi lưu/hàng loạt
- `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts` -- queue + handler
- `server/src/app/knowledge-items.ts` (mới), `media-errors.ts` (mới), `brand-profiles.ts`, `cors.ts`, `app.ts` -- route, ánh xạ lỗi media, header `X-File-Name`
- `deploy/nginx*.conf.example` -- location upload cho phép body 11 MB (kho + logo)
- `web/src/lib/{api,knowledge,autoreply,error-messages}.ts`, `web/src/screens/AutoReply.tsx` -- upload bytes, hook, mục Kho kiến thức thật

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared` -- hợp đồng kho + mã lỗi + sự kiện
- [x] `server/src/modules/profiles/*` + migration `drizzle-kit generate` -- bảng, trích văn bản, service, kế thừa, kiểm giới hạn
- [x] `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts` -- job `profiles.knowledge.extract`
- [x] `server/src/app/*` + `deploy/nginx*.conf.example` -- route, ánh xạ lỗi media, CORS, body lớn
- [x] `server/test/knowledge.test.ts`, `knowledge-files.test.ts` -- phủ mọi dòng I/O matrix (Postgres thật, Cloudinary giả, không gọi mạng)
- [x] `web/src/lib/{api,knowledge,autoreply,error-messages}.ts` + test, `web/src/screens/AutoReply.tsx` -- mục Kho kiến thức thật, cập nhật dòng theo realtime

**Acceptance Criteria:**
- Given nhóm thật trên `/ai-tra-loi`, when chủ shop tải "Bảng giá.pdf", then dòng mới hiện "AI đang đọc nội dung…" và tự đổi sang kích thước + số token (hoặc lý do lỗi) khi job xong, không cần tải lại trang.
- Given kho vượt 40.000 token, when bật AI rồi Lưu, then lỗi hiện dưới mục Kho kiến thức "cần rút gọn kho kiến thức" và cấu hình không đổi.
- Given trang đang theo nhóm, when mở form trang, then mục Kho kiến thức hiện kho của nhóm, chỉ để xem.

## Implementation Notes

- Migration `server/drizzle/0023_silky_smasher.sql` (sinh bằng `drizzle-kit generate`): bảng `knowledge_items` (CHECK owner_type/kind/status/error_code/file_mime, index theo chủ và theo `file_public_id`). Không extension mới: v1 nhét toàn văn bản vào prompt (AD-16), nên embedded-postgres và `postgres:18` chạy y nguyên.
- Phụ thuộc mới: `unpdf` 1.8.1 (pdf.js gói sẵn, không phụ thuộc con, bản 08/2026), chỉ nạp động trong thread trích. docx đọc bằng zip tự viết (`zlib.inflateRawSync`, giới hạn 64 MB/mục chống zip bomb, không zip64).
- `profiles`:
  - `knowledge-files.ts` thuần (nhận dạng loại, zip/docx, txt UTF-8/UTF-16, chuẩn hoá NFC).
  - `knowledge-extract-thread.ts` vừa là module vừa là entry `worker_threads` (nhận diện qua `workerData`), timeout 60 giây (`terminate`), heap 256 MB.
  - `knowledge-row.ts` có DTO, tổng token và sao chép/xoá theo chủ. `autoreplyOps.copy/remove` kéo theo kho; sao chép thay kho đích (idempotent).
  - `knowledge.ts` lo list/FAQ/ghi file/xoá/job. Khoá `pg_advisory_xact_lock` theo chủ khi cộng tổng token (thêm FAQ, kết thúc file, lưu bật).
- Lưu cấu hình bật gọi `assertKnowledgeFits` sau khi đã sao chép kho (trang vừa chuyển riêng). Bật hàng loạt kiểm kho của nguồn hiệu lực trước khi tách khỏi nhóm.
- Route `app/knowledge-items.ts`: `GET/POST faqs/POST files` theo chủ, `DELETE /knowledge-items/:id`. Tải file nhận nguyên bytes qua content-type parser riêng của scope, tên ở `X-File-Name` (thêm vào CORS allow-headers). Ánh xạ lỗi media gom về `app/media-errors.ts` cho cả logo (`IMAGE_FAILED`) và file (`UPLOAD_FAILED` mới). Việc hoãn "ánh xạ lỗi adapter media" đã làm và xoá khỏi `deferred-work.md`.
- nginx mẫu: thêm location regex cho `…/knowledge-items/(group|page)/<id>/files` và `…/brand-profiles/…/logo` với `client_max_body_size 11m`. Mức chung 2 MB trước đây chặn cả logo base64 > ~1,4 MB. Chủ shop cần chép lại khối này vào site nginx đang chạy.
- Quyết định:
  - File gốc bị xoá khỏi Cloudinary khi trích xong (văn bản đã ở DB). Nhờ vậy bản sao kế thừa không cần đếm tham chiếu lâu dài, và ít dữ liệu riêng tư nằm ngoài DB. Không có nút tải lại file gốc.
  - Thay đổi kho áp ngay, không chờ "Lưu cấu hình". Trang đang theo nhóm (kể cả vừa bật "Dùng riêng" mà chưa Lưu) xem kho nhóm, chỉ đọc.
  - Một file tự nó > 40k token → `too_large`. File làm tổng vượt chỉ thành `too_large` khi cấu hình của chủ đang bật; cấu hình tắt thì kho tích luỹ tự do và bị chặn ở lúc bật (đúng AC).
  - Không nhận XLSX/CSV (mock cũ ghi có). Hộp thêm mục nay ghi "PDF, DOCX hoặc TXT · tối đa 10 MB".
- FE: `lib/knowledge.ts` (helper + hook, khoá gốc `knowledge_items` nên realtime `knowledge_item.processed` tự làm cũ; còn mục đang đọc thì hỏi lại mỗi 10 giây làm dự phòng). `apiFetch` có `raw` để gửi bytes. `AutoReply.tsx`: `RealKnowledge` (dòng theo trạng thái, mức dùng token, lỗi "cần rút gọn"), hộp thêm mục báo lỗi tại chỗ; bật/lưu khi kho vượt bị chặn sớm và lỗi server `KNOWLEDGE_TOO_LARGE` hiện dưới mục kho.
- Test: `server/test/knowledge.test.ts` (23 ca, phủ mọi dòng ma trận), `knowledge-files.test.ts` (9), `web/src/lib/knowledge.test.ts` (9). `npm run check` xanh: server 1101 test, web 229 test, depcruise sạch.
- Chưa kiểm bằng trình duyệt, chưa thử file thật / Cloudinary thật, chưa có quét mục kẹt `processing` khi worker chết. Đã ghi vào `deferred-work.md`.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| `deploy/nginx-api.conf.example`: location tải file (11 MB) `proxy_pass http://ottm_api` — file này chỉ khai upstream `ottm_api_upstream`, nên `nginx -t` báo "host not found in upstream" và không nạp được cấu hình mẫu. Sửa thành `ottm_api_upstream`. | Lỗi thật (cao: chặn deploy host api riêng) | `patch` |
| Đua sao chép kho kế thừa với job kết thúc file (bản sao `processing` chèn sau `UPDATE … WHERE status='processing'` hoặc sau khi file bị xoá) → mục kẹt "AI đang đọc nội dung…". Cửa sổ hẹp, chủ shop xoá rồi tải lại được. | Lỗi thật (trung bình, hiếm) | `defer` (đã có trong `deferred-work.md`: quét mục kẹt `processing`) |

## Design Notes

Job xử lý theo file (không theo mục) vì sao chép kế thừa tạo nhiều mục trỏ cùng một file đang `processing`. Nếu chỉ kết thúc mục gốc thì bản sao kẹt mãi. Payload `{knowledgeItemId, filePublicId}`, mục chỉ dùng để log.

`worker_threads` + `terminate()` mới huỷ được pdf.js đang chạy CPU. `expireInSeconds` của pg-boss chỉ cho lượt khác chạy, không dừng lượt đang chạy.

Không cần pgvector: AD-16 v1 nhét toàn bộ văn bản vào prompt, nên embedded-postgres và image `postgres:18` không cần thêm gì.

## Verification

**Commands:**
- `npm run db:generate -w server` -- sinh migration cho `knowledge_items`
- `npm run check` (gốc repo) -- typecheck, lint, depcruise, test đều xanh
