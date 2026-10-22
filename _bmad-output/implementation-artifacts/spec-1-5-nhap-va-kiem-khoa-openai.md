---
title: 'Story 1.5 — Nhập và kiểm khoá OpenAI'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: 'NO_VCS' # snapshot scratchpad/baseline-1-5
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-4-kenh-realtime-va-trung-tam-thong-bao.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Cài đặt › Kết nối OpenAI và mọi nút AI đang chạy theo dữ liệu mẫu: khoá không được kiểm, không được lưu, danh sách model viết cứng, và trạng thái "đã có khoá" là cờ giả.

**Approach:** Lưu khoá OpenAI mã hoá AES-256-GCM (chỉ sau khi gọi OpenAI kiểm tra thành công), trả về client chỉ `{configured, last4, status, checkedAt}`. Bảng `ai_model_prices` là nguồn danh sách model. Lưu lựa chọn model chữ, model ảnh, kích thước ảnh, tỉ giá VND/USD và hạn mức tháng. Web nối Cài đặt › OpenAI vào API, và mọi nút AI khoá theo trạng thái khoá thật, có tooltip kèm liên kết tới Cài đặt.

## Boundaries & Constraints

**Always:** AD-12 (envelope `v1:<keyId>:<iv>:<ciphertext>:<tag>`, khoá chủ từ `APP_ENCRYPTION_KEYS` + `APP_ENCRYPTION_ACTIVE_KEY`, không bao giờ trả khoá đầy đủ, log không chứa khoá), AD-7 (chỉ `modules/ai` gọi `adapters/openai`; danh sách model cho FE lấy từ `ai_model_prices`; không hard-code tên model ngoài seed), AD-1. Production thiếu `APP_ENCRYPTION_KEYS`/`APP_ENCRYPTION_ACTIVE_KEY` → không khởi động. Dev không có biến này → `npm run dev` tự sinh khoá dev ngẫu nhiên lưu `.data/dev-encryption-key` (gitignored) [ASSUMPTION]. Seed model: chữ `gpt-6-luna` (mặc định), `gpt-6.1-sol`, `gpt-6-astra`; ảnh `gpt-image-2.5-flare` (mặc định), `gpt-image-2.5-sunburst`, `gpt-image-2`; cột giá để trống, Story 1.6 điền sau khi kiểm giá [ASSUMPTION]. Tỉ giá mặc định 26.000 VND/USD, hạn mức mặc định 1.000.000 đ/tháng [ASSUMPTION]. Story này chỉ lưu hạn mức; tính chi phí, chặn và cảnh báo là Story 1.6. Tooltip khoá AI: "Thêm khoá OpenAI ở Cài đặt" + liên kết "Mở Cài đặt" tới `/cai-dat` (UX-DR2).

**Never:** Không gọi OpenAI để sinh nội dung (gateway là Story 1.6). Không đổi hành vi khác của các màn ngoài việc khoá nút AI. Không lưu khoá sai. Không ghi khoá vào log, lỗi, hay payload sự kiện.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Khoá hợp lệ | `PUT /api/v1/settings/openai/key {apiKey}`, OpenAI trả 200 | lưu envelope, trả `{configured:true,last4,status:'valid',checkedAt}`; phát `settings.updated` | N/A |
| Khoá sai | OpenAI trả 401 | 400 `OPENAI_KEY_INVALID`, không thay khoá cũ | N/A |
| OpenAI không trả lời / 5xx / 429 | lỗi mạng, timeout 10 giây | 502 `AI_PROVIDER_ERROR`, không thay khoá cũ | log không chứa khoá |
| Khoá rỗng / sai dạng | không bắt đầu bằng `sk-` hoặc dài >512 | 400 `VALIDATION_FAILED`, không gọi OpenAI | N/A |
| Đọc trạng thái | `GET /api/v1/settings/openai` | `{key:{configured,last4,status,checkedAt}, textModel, imageModel, imageSize, exchangeRateVnd, monthlyLimitVnd, models:{text[],image[]}}` | chưa có khoá → `configured:false,status:'missing'` |
| Lưu lựa chọn | `PUT /api/v1/settings/openai {textModel,…}` | lưu; model phải có trong `ai_model_prices` đúng loại; tỉ giá, hạn mức là số nguyên dương | sai → 400 `VALIDATION_FAILED` |
| Giải mã | envelope có `keyId` không còn trong `APP_ENCRYPTION_KEYS` | `ai.getOpenAiKey()` ném lỗi rõ tên keyId | status không đổi |
| Khoá chủ sai định dạng | `APP_ENCRYPTION_KEYS` không phải base64 32 byte | không khởi động, log tên biến | exit ≠ 0 |
| Nút AI | status `missing` hoặc `invalid` | nút mờ, tooltip có liên kết "Mở Cài đặt" | trạng thái lấy từ server, cập nhật khi `settings.updated` |

</frozen-after-approval>

## Code Map

- `server/src/modules/settings/schema.ts` -- bảng `secrets(name, kind, value, updated_at)` và `settings(key, value jsonb)`: khoá OpenAI ở `secrets` (`name='openai_api_key'`, `kind='envelope'`), thêm cột `status`, `last4`, `checked_at`; lựa chọn ở `settings` (`key='openai'`).
- `server/src/modules/settings/{auth.ts,prefs.ts,index.ts}` -- mẫu đọc/ghi + phát `settings.updated` trong transaction (`publishEvent`).
- `server/src/platform/config/index.ts` -- thêm `APP_ENCRYPTION_KEYS`, `APP_ENCRYPTION_ACTIVE_KEY` (bắt buộc ở production; active phải có trong danh sách).
- `server/src/platform/log/index.ts` -- redact đã có `apiKey`; thêm `api_key`, `openaiKey`.
- `server/scripts/dev.ts` -- truyền env cho api/worker; thêm khoá dev.
- `server/dependency-rules.cjs` -- bảng mũi tên AD-1: `ai` phụ thuộc nền; module `ai` chưa tồn tại thì thêm thư mục `server/src/modules/ai/`.
- `web/src/lib/app-context.tsx` -- `openAiKeySet` đang là cờ giả: thay bằng trạng thái từ server, giữ tên để 7 màn dùng (Inbox, Composer, AutoReply, Analytics, ContentCalendar, CampaignWizard, BrandProfileForm) không phải đổi logic.
- `web/src/screens/Settings.tsx:84-86,180-200` -- `TEXT_MODELS`/`IMAGE_MODELS`/`IMAGE_SIZES` viết cứng, modal đổi khoá giả: nối API.
- `web/src/lib/notifications.ts` -- mẫu hook TanStack Query + invalidation theo entity.

## Tasks & Acceptance

**Execution:**
- [x] `server/src/adapters/crypto/index.ts` + test -- `encrypt(plain)`/`decrypt(envelope)` AES-256-GCM, iv 12 byte ngẫu nhiên, nhiều khoá, chọn khoá theo `keyId`.
- [x] `server/src/platform/config/index.ts` + test -- biến khoá chủ theo ma trận.
- [x] `server/src/adapters/openai/{index.ts,fake.ts}` -- `checkKey(apiKey)` gọi `GET https://api.openai.com/v1/models` (timeout 10 giây), phân loại `KEY_INVALID`/`RATE_LIMITED`/`TRANSIENT`; không log khoá.
- [x] `server/src/modules/ai/{schema.ts,models.ts,key.ts,index.ts}` + migration -- bảng `ai_model_prices(model pk, kind text|image, label, input_usd_per_1m, output_usd_per_1m, image_usd_each, active, sort)` có seed; `listModels`, `setOpenAiKey` (kiểm rồi mã hoá rồi lưu), `getOpenAiKeyStatus`, `getOpenAiKey` (giải mã, dùng ở 1.6); ghi `secrets` qua hàm export của `settings` (AD-1).
- [x] `server/src/modules/settings/{schema.ts,openai.ts,index.ts}` + migration -- cột mới của `secrets`, `getOpenAiSettings`/`setOpenAiSettings` (mặc định theo Boundaries), phát `settings.updated`.
- [x] `server/src/app/openai-settings.ts` + đăng ký trong `app.ts` -- `GET/PUT /api/v1/settings/openai`, `PUT /api/v1/settings/openai/key`.
- [x] `server/scripts/dev.ts` -- sinh/đọc `.data/dev-encryption-key`, truyền `APP_ENCRYPTION_KEYS`/`APP_ENCRYPTION_ACTIVE_KEY` cho api/worker.
- [x] `server/test/openai-settings.test.ts` -- mọi dòng ma trận phía server (dùng fake adapter), kèm kiểm log không chứa khoá và DB chỉ chứa envelope.
- [x] `packages/shared/src/openai.ts` -- zod request/response.
- [x] `web/src/lib/openai.ts` -- `useOpenAiSettings`, `useSaveOpenAiKey`, `useSaveOpenAiSettings`; khoá query `['settings', 'openai']`.
- [x] `web/src/lib/app-context.tsx` -- `openAiKeySet` = `status === 'valid'` từ server.
- [x] `web/src/components/AiLockHint.tsx` + 7 màn ở Code Map -- thay `title="Thêm khoá OpenAI ở Cài đặt"` bằng tooltip có liên kết "Mở Cài đặt" (bàn phím mở được).
- [x] `web/src/screens/Settings.tsx` -- chip trạng thái thật ("Đã kết nối" / "Chưa có khoá" / "Khoá không hợp lệ"), modal "Kiểm tra và lưu" gọi API và hiện lỗi, model từ API, kích thước ảnh, ô tỉ giá mới, hạn mức lưu thật; phần "Đã dùng tháng này" vẫn là số mẫu tới Story 1.6.
- [x] `deploy/env.production.example`, `deploy/runbook.md` -- ghi rõ hai biến khoá chủ là bắt buộc.

**Acceptance Criteria:**
- Given `npm run dev` và đã đăng nhập, when mở Cài đặt › Kết nối OpenAI và dán một khoá sai, then hiện "Khoá không hợp lệ" và trạng thái không đổi.
- Given chưa có khoá, when mở Soạn bài AI, then nút "Tạo bằng AI" mờ, rê chuột hoặc focus thấy "Thêm khoá OpenAI ở Cài đặt" và liên kết mở `/cai-dat`.
- Given `npm run check`, when chạy, then thoát 0.

## Implementation Notes

- **Khoá chủ (`platform/config`):** `APP_ENCRYPTION_KEYS` = `<keyId>:<base64 của đúng 32 byte>` phẩy ngăn cách (keyId `[A-Za-z0-9_-]{1,32}`, base64 chuẩn, không lặp keyId), parse thành `Map` keyId → Buffer (`JSON.stringify` ra `{}` nên lỡ log config cũng không lộ). Production thiếu một trong hai biến → không khởi động; mọi môi trường: đặt một nửa cặp, hay active không có trong danh sách → lỗi. Thông báo lỗi chỉ nêu vị trí mục/keyId, không chép khoá. Áp cho api, worker và `migrate` (cùng `getConfig`).
- **`adapters/crypto`:** `createSecretCipher({keys, activeKeyId})` → `encrypt`/`decrypt`/`keyIdOf`; iv/ciphertext/tag dạng base64url. Lỗi: `EncryptionKeyNotFoundError` (nêu keyId), `DecryptionFailedError`, `EnvelopeFormatError`.
- **`adapters/openai`:** `checkKey` dùng `fetch` (chưa thêm SDK `openai` — 1.6 thêm khi sinh nội dung), `AbortSignal.timeout(10s)`. 401/403 → `KEY_INVALID`; 429 `insufficient_quota` → `PROVIDER_QUOTA`, 429 khác → `RATE_LIMITED`; còn lại, lỗi mạng, hết giờ → `TRANSIENT`. API: chỉ `KEY_INVALID` → 400 `OPENAI_KEY_INVALID`; mọi lỗi khác → 502 `AI_PROVIDER_ERROR` (log `warn` chỉ `{kind,status}`). Fake: `adapters/openai/fake.ts`. Luật depcruise mới `ad7-openai-only-ai`: chỉ `modules/ai` import `adapters/openai`.
- **Model mặc định không viết cứng:** settings lưu `textModel/imageModel` (null = chưa chọn); module `ai` chọn model đã lưu nếu còn `active`, ngược lại model đang bật có `sort` nhỏ nhất. Tên model chỉ nằm trong seed (`drizzle/0003_openai_key_models.sql`, `INSERT … ON CONFLICT DO NOTHING`, cột giá NULL).
- **Phân chia module:** `settings/openai.ts` — `getSecretMeta`, `getSecretValue`, `putCheckedSecret` (upsert + `settings.updated {id:'openai_api_key'}` trong một transaction), `getOpenAiPrefs`/`setOpenAiPrefs` (khoá `openai`, mặc định từng trường khi hỏng). `ai` ghép (`getOpenAiSettings`, `setOpenAiSettings` kiểm model theo `ai_model_prices` đúng loại và đang bật), `setOpenAiKey`, `getOpenAiKeyStatus`, `getOpenAiKey` (thêm `ai/service.ts` ngoài các file trong Tasks). `buildApp({ai: {cipher, openai?}})`; thiếu `cipher` (dev không qua `npm run dev`) → lưu khoá trả 500, không gọi OpenAI. `secrets.status` có check `null | valid | invalid`; `missing` = không có dòng.
- **Hợp đồng (`packages/shared/openai.ts`):** khoá nhận vào được `trim`, regex `^sk-[\x21-\x7e]+$`, ≤512. `PUT /settings/openai` cần đủ 5 khoá (strict); tỉ giá ≤1.000.000, hạn mức ≤10^12, đều nguyên dương (hạn mức 0 bị từ chối theo ma trận; "hạn mức 0 = chặn mọi lời gọi" của epic để 1.6 quyết). Kích thước ảnh: `1024x1024 | 1024x1536 | 1536x1024`. Lỗi kiểm dạng khoá không đưa issue zod vào `details`.
- **Dev:** `server/scripts/dev.ts` sinh `.data/dev-encryption-key` (base64 32 byte, quyền 600, keyId `dev`) khi shell/`server/.env` chưa đặt `APP_ENCRYPTION_KEYS`; file hỏng → sinh lại (phải nhập lại khoá OpenAI).
- **Web:** `AppProvider` hỏi `['settings','openai']` khi đã đăng nhập; `openAiKeySet = status === 'valid'` (đang tải / lỗi → nút mờ). `AiLockHint` hiện bằng CSS `group-hover`/`group-focus-within` (vỏ bọc `tabIndex=0` vì nút `disabled` không nhận focus), Esc ẩn, liên kết "Mở Cài đặt". Bọc mọi nút AI khoá theo khoá ở 7 màn (kể cả nút trước đó không có tooltip: "Viết thêm", Viết lại/Ngắn hơn/Thêm CTA, "Tạo lại ảnh", "Tạo lại" từng bài). `Select` nhận thêm `{value,label}`. Modal khoá: lỗi `OPENAI_KEY_INVALID`/`VALIDATION_FAILED` hiện "Khoá không hợp lệ" (nhãn trạng thái), lỗi khác qua `errorMessageOf`; ô nhập tự focus. "Cảnh báo khi đạt 80%" và bảng chi phí vẫn là mock (Story 1.6) — ô cảnh báo chưa được lưu.
- **Triển khai:** compose bắt buộc hai biến (`:?`), CI deploy-smoke sinh khoá thử; `env.production.example`, `runbook.md` ghi rõ bắt buộc + cách xoay khoá.
- **Đã kiểm:** `npm run check` exit 0 (server 220 test, web 48). `npm run dev`: `curl /api/v1/settings/openai` không phiên → 401; `.data/dev-encryption-key` được sinh quyền 600. Trình duyệt (phiên tạo thẳng trong DB dev, đã dọn): Soạn bài AI chưa có khoá → "Tạo bằng AI" mờ, rê chuột và Tab đều hiện gợi ý + "Mở Cài đặt", Tab tới liên kết + Enter mở `/cai-dat`, Esc ẩn; Cài đặt › OpenAI chip "Chưa có khoá", model từ API; dán khoá giả `sk-…` → OpenAI thật trả 401 → "Khoá không hợp lệ", chip không đổi, DB không có dòng khoá, log không chứa khoá; đổi tỉ giá + Lưu → còn sau khi tải lại (đã xoá dữ liệu thử).
- **Sau review (vòng 1):** `warn80` (mặc định true) lưu trong prefs `openai`; `PUT /settings/openai` nhận một phần (khoá thiếu giữ giá trị, khoá lạ bị từ chối), web bỏ model rỗng khi loại đó không có model đang bật ("Chưa có model nào đang bật", select khoá) và kiểm tỉ giá/hạn mức theo max của shared. 403 → mã mới `OPENAI_KEY_RESTRICTED` (không lưu); thiếu khoá chủ → `ENCRYPTION_NOT_CONFIGURED`. GET/recheck đối chiếu envelope với keyring (keyId không còn / giải mã lỗi) → `status:'invalid', reason:'reentry_required'` ("Cần nhập lại khoá"); `getOpenAiKey` đổi lỗi giải mã thành `AppError OPENAI_KEY_INVALID` (message nêu keyId, `details.reason`). Thêm `DELETE /settings/openai/key` và `POST /settings/openai/key/recheck` + nút "Gỡ khoá" (xác nhận) / "Kiểm tra lại". Màn Bắt đầu bước 2 dùng cùng hook lưu khoá. `aiLock(status)` ở `web/src/lib/openai.ts`: chỉ `valid` mở khoá; đang tải khoá không gợi ý; gợi ý theo `missing`/`invalid`/lỗi tải. `AiLockHint`: `role="group"` + `aria-label`, chạm/click ghim gợi ý, chỉ chặn Esc khi gợi ý đang hiện; bỏ liên kết trùng ở Soạn bài / Hộp thư. `app/deps.ts` (cipher từ config, có test); fixture depcruise cho `ad7-openai-only-ai`; `dev.ts` đổi tên file khoá hỏng thành `.bak-<thời điểm>`, file không đọc được → thoát 1.

- **Kiểm thử trên trình duyệt (sau review):** Soạn bài AI khi chưa có khoá: nút "Tạo bằng AI" mờ, nhóm có nhãn "Thêm khoá OpenAI ở Cài đặt", rê chuột hiện tooltip, liên kết "Mở Cài đặt" mở `/cai-dat`. Cài đặt: model lấy từ API, tỉ giá mặc định 26.000. Khoá sai định dạng → "Khoá phải bắt đầu bằng sk-…" không gọi server; khoá bịa đúng định dạng → OpenAI từ chối → "Khoá không hợp lệ", trạng thái vẫn `missing`, log không chứa khoá. Chưa thử tay: nút Gỡ khoá/Kiểm tra lại với khoá thật (cần khoá OpenAI thật), lớp chạm trên thiết bị cảm ứng.

## Spec Change Log

## Review Triage Log

| # | Nguồn | Phát hiện | Verdict | Bằng chứng / route |
|---|---|---|---|---|
| 1 | blind | Công tắc "Cảnh báo khi dùng 80%" không được lưu | medium | `warn80` chỉ là useState; patch |
| 2 | edge (claim) | Màn Chào bước 2 vẫn kiểm khoá giả, báo đã kết nối mà không lưu | medium | `Welcome.tsx` setTimeout + startsWith; patch |
| 3 | blind, edge | Khoá không giải mã được (keyId mất/giá trị hỏng) vẫn hiện "Đã kết nối"; lỗi giải mã thành 500 | medium | GET chỉ đọc cột status; patch |
| 4 | blind | Không gỡ được khoá, không kiểm tra lại được khoá đã lưu | medium | chỉ có GET/PUT; patch |
| 5 | blind, edge | 403 (khu vực, thiếu quyền) bị báo là khoá sai | low | adapter gộp 401/403; sửa trực tiếp; patch |
| 6 | blind | Thiếu cấu hình mã hoá trả 500 chung chung | low | EncryptionNotConfiguredError không phải AppError; patch |
| 7 | blind | Khoá sai định dạng và khoá bị từ chối cùng một câu | low | modal ánh xạ chung; patch |
| 8 | blind, vgap | Nút AI khoá khi đang tải/lỗi mạng với khoá hợp lệ; khoá invalid hiện sai câu; ánh xạ chưa có test | medium | `openAiKeySet = status==='valid'` gồm cả loading; patch (hàm thuần + test) |
| 9 | blind, edge | AiLockHint: không tên truy cập, không chạm được, chặn Esc của modal, trùng liên kết | medium | `AiLockHint.tsx` stopPropagation luôn; patch |
| 10 | blind, edge | Không có model bật → mọi lần lưu thất bại; số vượt tối đa báo lỗi chung | low | form gửi `''`; patch |
| 11 | vgap | Luật `ad7-openai-only-ai` không có fixture vi phạm | medium | vgap đã xác minh; patch |
| 12 | vgap | Entry point có truyền cipher không thì chưa ai kiểm | medium | vgap đã xác minh; patch (tách hàm dựng deps) |
| 13 | blind | Thiếu test 429 quota, không phát settings.updated khi lỗi, GET khi keyId mất; test gắn cứng danh sách seed | low | patch |
| 14 | blind, edge | dev.ts ghi đè file khoá dev hỏng, file không đọc được thì crash | low | dev-only; sửa trực tiếp; patch |
| 15 | blind | Chưa có công cụ mã hoá lại khi xoay khoá chủ | medium | AD-12 job `crypto.reencrypt`; hiện chỉ có 1 bí mật; defer → deferred-work.md, làm ở Epic 2 khi có token Meta |
| 16 | blind | /models không chứng minh khoá sinh được nội dung | maybe-false | khoá dự án hạn chế có thể đọc model mà không gọi được; Story 1.6 kiểm khi gọi thật; reject |
| 17 | edge | Hai lần lưu khoá đồng thời về sai thứ tự | low | một chủ sở hữu; reject |
| 18 | blind | Kiểm model ngoài transaction | low | `resolveModel` có fallback; reject |
| 19 | blind | Mã thừa (ml-auto, parse hai lần, superRefine khó đọc) | low | không gây lỗi; reject |
| 20 | vgap | Khoá dev còn giữ sau khởi động lại chưa có test | low | dev-only; reject |

## Design Notes

Khoá dev sinh một lần và tái dùng, nên khoá OpenAI đã lưu ở dev vẫn giải mã được sau khi khởi động lại. Mất file `.data/dev-encryption-key` thì phải nhập lại khoá OpenAI (giống mất `APP_ENCRYPTION_KEYS` ở production).

## Verification

**Commands:**
- `npm run check` -- expected: exit 0
- `npm run dev`, rồi `curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/v1/settings/openai` -- expected: 401
- Manual: hai AC đầu trên trình duyệt (không dùng khoá OpenAI thật).
