---
title: 'Story 3.4 — Viết thử bằng AI theo hồ sơ'
type: 'feature'
created: '2026-10-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-1-ho-so-thuong-hieu.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 3.4 (PM duyệt)">

## Intent

**Problem:** Chủ shop chưa thử được AI viết caption theo hồ sơ trước khi dùng thật. Cần endpoint tương tác (không job) gọi AI gateway với hồ sơ đang soạn (kể cả chưa lưu), hậu kiểm từ cấm/URL (AD-21), huỷ được (Dừng), và khoá nút theo mã lỗi khi hết hạn mức/thiếu khoá.

**Approach:** Thêm mẫu prompt caption ở `modules/ai/prompts/`; hàm duy nhất `ai.checkOutput(text, {brand, kind})` (AD-21); endpoint request-time `POST /api/v1/brand-profiles/sample` nhận hồ sơ nháp → reserve → `generateText(feature=brand_sample, signal)` → checkOutput (sinh lại 1 lần nếu vi phạm) → settle → trả JSON một lần; Dừng = client huỷ → server truyền AbortSignal sang OpenAI và release phần chưa chạy. FE: nút "Viết thử bằng AI" ("AI đang viết…" + Dừng), khoá theo mã lỗi (UX-DR2), vẫn sửa tay.

## Boundaries & Constraints

**Always (bám 4 AC epics.md Story 3.4):**
- Bấm "Viết thử bằng AI" với hồ sơ đang soạn (kể cả CHƯA lưu — body mang hồ sơ nháp): api gọi gateway `feature=brand_sample` với mẫu prompt ở `modules/ai/prompts/`, `store: false`, trả JSON một lần (KHÔNG stream). FE hiện "AI đang viết…" + nút Dừng (Component "Nút AI", Accessibility Floor "AI tạo").
- Dừng: client huỷ request → server truyền `AbortSignal` sang OpenAI; reservation được release, KHÔNG settle chi phí cho phần chưa chạy (AD-7). Request bị huỷ không ghi `ai_usage` cho phần không chạy.
- `ai.checkOutput(text, {brand, kind})` là hàm DUY NHẤT hậu kiểm (AD-21): từ cấm của hồ sơ (không phân biệt hoa thường, chuẩn hoá dấu), URL ngoài `allowedDomains`, độ dài tối đa theo kênh. Vi phạm → sinh lại MỘT lần; vẫn vi phạm → trả kết quả kèm danh sách cụm vi phạm để FE đánh dấu. Sạch → xem trước hiện "Đã tránh N từ cấm" (N = số từ cấm của hồ sơ, hoặc số lần tránh — theo UX; [ASSUMPTION] N = số từ cấm đã khai).
- Hết hạn mức (`AI_BUDGET_EXCEEDED`) hoặc thiếu/khoá lỗi (`OPENAI_KEY_MISSING`/`OPENAI_KEY_INVALID`) → nút khoá theo mã lỗi server (UX-DR2), chủ shop VẪN sửa tay được (không chặn form).
- Route cần phiên (AD-19), Origin ghi. Gọi AI chạy TRONG request (AD-7 ngoại lệ sinh chữ tương tác), không enqueue job.

**Never:** Không stream (trả JSON một lần). Không nhân bản luật hậu kiểm ngoài `checkOutput`. Không ghi chi phí phần bị huỷ. Không lưu hồ sơ khi "Viết thử" (dùng hồ sơ nháp trong body). Không gọi AI quá 2 lần (1 sinh + tối đa 1 sinh lại). Không đụng OpenAI thật ở test (dùng adapter giả/SIMULATED như test gateway hiện có).

## I/O & Edge-Case Matrix

| Scenario | Input | Expected | Error |
|----------|-------|----------|-------|
| Viết thử sạch | hồ sơ hợp lệ, có khoá + hạn mức | 200 {caption, violations:[], avoidedBannedCount} | |
| Có từ cấm lần 1 | AI trả chứa từ cấm | sinh lại 1 lần; nếu sạch → trả sạch | |
| Vẫn vi phạm sau sinh lại | | 200 {caption, violations:[cụm...]} để FE đánh dấu | |
| URL ngoài allowlist | caption có link lạ | tính là vi phạm (cùng cơ chế) | |
| Dừng giữa chừng | client abort | request huỷ, AbortSignal→OpenAI, reservation release, không settle | |
| Hết hạn mức | reserve thất bại | 4xx `AI_BUDGET_EXCEEDED` (FE khoá nút) | |
| Thiếu khoá | không có khoá dùng được | 4xx `OPENAI_KEY_MISSING`/`INVALID` (FE khoá nút) | |
| Hồ sơ nháp tên rỗng | | vẫn viết thử được? [ASSUMPTION] cho phép (chưa lưu); hoặc validate tối thiểu — ghi chú | |
| checkOutput đơn vị | text + brand | phát hiện từ cấm (dấu/hoa thường), URL ngoài domain, độ dài | |

</frozen-after-approval>

## Code Map (điểm xuất phát — subagent điều tra thêm)

- `server/src/modules/ai/gateway.ts` — `generateText({feature:'brand_sample', signal, …})` đã có AbortSignal + reserve/settle; xem cách reserve→gọi→settle và release khi abort.
- `server/src/modules/ai/prompts/` (MỚI) — builder prompt caption từ hồ sơ (giọng điệu, sản phẩm, emoji, xưng hô, độ trang trọng…); export qua `ai/index.ts`.
- `server/src/modules/ai/check-output.ts` (MỚI) — `checkOutput(text, {brand, kind})` AD-21: chuẩn hoá dấu + lower, khớp từ cấm; trích URL, so `allowedDomains`; độ dài theo kind. Trả `{clean, violations[], avoidedBannedCount}`. Thuần, test kỹ. Export qua `ai/index.ts`.
- `server/src/app/` — `POST /api/v1/brand-profiles/sample` (hoặc `/ai/brand-sample`): body = hồ sơ nháp (zod như SaveBrandProfileRequest nhưng không lưu); reserve → generateText(signal từ req close) → checkOutput → (sinh lại 1 lần nếu bẩn) → settle/release → JSON. Bắt `req.raw.on('close')` để abort. Map lỗi gateway → mã (AI_BUDGET_EXCEEDED/OPENAI_KEY_*).
- `packages/shared/src/` — BrandSampleRequest/Response (caption, violations[], avoidedBannedCount); tái dùng SaveBrandProfileRequest cho hồ sơ nháp.
- `web/src/components/BrandProfileForm.tsx`, `web/src/lib/profiles.ts` (hoặc ai.ts) — nút "Viết thử bằng AI" (Component "Nút AI"): AbortController, "AI đang viết…", Dừng; hiện caption + "Đã tránh N từ cấm" / đánh dấu cụm vi phạm; khoá nút theo mã lỗi (dùng error-messages/UX-DR2); vẫn sửa tay.
- UX: F1 b4; Component "Nút AI"; UX-DR9 (nhãn AI tạo), UX-DR10, UX-DR2 (khoá theo mã lỗi).

## Tasks & Acceptance

**Execution:**
- [ ] BE: prompt caption builder; `checkOutput` (AD-21) thuần + test; endpoint brand-sample (reserve→generate(signal)→checkOutput→sinh lại 1 lần→settle/release; abort khi client đóng; map mã lỗi).
- [ ] shared: BrandSampleRequest/Response.
- [ ] FE: nút Viết thử bằng AI (AbortController + Dừng, trạng thái "AI đang viết…"), hiển thị kết quả/đánh dấu vi phạm/"Đã tránh N từ cấm", khoá theo mã lỗi; vẫn sửa tay.
- [ ] Test: server (checkOutput mọi dòng matrix; endpoint: sạch, vi phạm→sinh lại→sạch, vẫn vi phạm trả violations, abort→release không settle, AI_BUDGET_EXCEEDED, OPENAI_KEY_MISSING; dùng adapter giả, không gọi OpenAI thật); web (trạng thái nút, Dừng huỷ, khoá theo mã lỗi — pure helpers).

**Acceptance Criteria:** 4 AC epics.md Story 3.4 (frozen) đạt và có test.

## Verification
**Commands:** `npm run check` — xanh.

## Implementation Notes

## Spec Change Log

## Review Triage Log

### Lượt 1 (blind / edge / verification-gap) — triage
| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| too_long bị lọc khỏi UI → caption quá dài hiện "sạch" | medium | patch (hiện cảnh báo too_long) |
| Route-level abort (req.raw close→abort, hijack) chưa test HTTP | medium | patch (test app.listen+fetch+AbortController như realtime.test.ts) |
| Mọi AbortError bị coi là client disconnect → client treo | medium | patch (chỉ hijack khi client thực sự đóng; khác → map lỗi) |
| Khớp từ cấm substring không biên → "giá" khớp "giá trị"; "giảm  giá" không khớp | medium | patch (chuẩn hoá khoảng trắng + biên alnum) + test |
| markViolations chỉ tô đúng casing → lần lặp khác hoa thường không tô | low | patch (tô không phân biệt hoa thường) |
| URL_RE gắn cờ domain trong email | medium | patch (bỏ token sau '@') |
| Link IP literal / IDN vượt allowlist | low | patch (nhận IP literal; IDN defer) |
| mutate lỗi non-abort/non-lock → nút reset im, không báo | medium | patch (hiện thông báo lỗi) |
| Sửa caption sau khi có violations → box cảnh báo kẹt không tô | low | patch (xoá violations khi sửa) |
| Prompt không nêu giới hạn độ dài; 700 token > 2200 ký tự | low | patch (thêm hướng dẫn độ dài) |
| avoidedBannedCount = số từ cấm khai, không phải số tránh | low | patch (sửa câu cho đúng nghĩa) |
| Brand field splice vào prompt (injection) | false | reject (hồ sơ do chủ shop tự soạn, tin cậy; checkOutput hậu kiểm) |
| 2 import @ottm/shared "trùng" | false | reject (hai symbol khác nhau, lint sạch; có thể gộp cho gọn) |
