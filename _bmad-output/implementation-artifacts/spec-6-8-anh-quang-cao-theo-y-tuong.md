---
title: 'Story 6.8 — Ảnh AI quảng cáo theo ý tưởng bài (hướng TNUT Media)'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '35b86ed3470bdab572fd9a2f0080cbcef7879f93'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="Quyết định của chủ dự án (ngoài epics.md, coi như Story 6.8): làm ảnh AI theo hướng TNUT Media — prompt là brief ý tưởng bài, cho phép chữ tiếng Việt + bố cục quảng cáo (mặc định), có tuỳ chọn ảnh chụp sạch, luôn cấm giao diện giả; dựa trên 6.3 / 6.6 / 6.7 / 7.2 / 7.4; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Ảnh AI (Soạn bài và slot chiến dịch) sạch nhưng phẳng: prompt chỉ tả cảnh, cấm mọi chữ / logo, ảnh tham khảo bị ép "chỉ đổi bối cảnh". Thử thật cùng model `gpt-image-2.5-sunburst`, cách TNUT Media (prompt = sản phẩm + brief ý tưởng bài) cho ảnh quảng cáo hoàn chỉnh, chữ tiếng Việt đúng chính tả — giả định "chữ tiếng Việt hay sai" của 6.3 không còn đúng.

**Approach:** Thêm kiểu ảnh `imageMode`: `ad` (mặc định — ảnh quảng cáo, được có tiêu đề / câu ngắn tiếng Việt, bố cục poster / collage, đạo cụ theo ý tưởng) | `clean` (ảnh chụp sạch, không chữ — gần hành vi cũ). Prompt ảnh thành brief ý tưởng bài (mô tả của chủ shop + ý tưởng + tóm ý caption). Cả hai kiểu luôn cấm giao diện giả (nút play, thanh phát video, khung điện thoại, giao diện app / mạng xã hội, con trỏ, watermark).

## Boundaries & Constraints

**Always:**
- **Hợp đồng (shared):**
  - `IMAGE_MODES = ['ad', 'clean']`, `ImageMode`.
  - `IMAGE_BRIEF_CAPTION_MAX = 400`: số ký tự tối đa của đoạn caption đưa vào brief.
  - `GenerateImagesRequest` thêm `imageMode` (mặc định `ad`), `topic?` (ý tưởng bài, ≤ `POST_TOPIC_MAX`), `caption?` (caption bài, ≤ `POST_CAPTION_MAX`; server cắt tóm ý). `prompt` giữ nguyên nghĩa và giới hạn 1–1000.
  - `ImagePromptRequest` thêm `imageMode` (mặc định `ad`).
- **Body cũ / dữ liệu cũ:** body thiếu `imageMode` → `ad` (theo quyết định "mặc định BẬT"). Ô ảnh đã ghi giữ prompt đã dựng (`media_assets.prompt`), không dựng lại.
- **Chiến dịch:** slot luôn dựng ảnh kiểu `ad`, không có cài đặt chiến dịch, không migration. Lý do: gọn (không đổi bảng `campaigns`, wizard, khoá slot 7.2 / 7.3); chủ dự án chọn `ad` là mặc định. Chiến dịch đang chạy: slot sinh SAU khi triển khai ra ảnh `ad`. Cài đặt `clean` cho chiến dịch ghi ở deferred-work.
- **Prompt ảnh (`buildImagePrompt`, dùng chung Soạn bài + slot):**
  - Phần brief đứng đầu: mô tả của chủ shop (nếu có, nguyên văn một dòng — vẫn ưu tiên), rồi `Ý tưởng bài đăng: …` (bỏ khi trùng mô tả / trống), rồi `Nội dung bài: …` (caption tóm ý: bỏ hashtag và URL, gộp một dòng, cắt ≤ 400 ở ranh giới từ).
  - Dòng gợi ý gọn của 6.7 giữ nguyên dạng `(…; mục đích; phong cách; tông màu thương hiệu)`; mở đầu đổi theo kiểu (`ad`: "Ảnh quảng cáo cho bài đăng…").
  - `ad`: được dựng bố cục quảng cáo theo ý tưởng (ghép nhiều góc, đạo cụ, nhân vật minh hoạ tự tạo); được thêm MỘT tiêu đề hoặc câu ngắn tiếng Việt lấy từ ý tưởng / nội dung bài, đúng chính tả, đủ dấu; không bịa giá, khuyến mãi, số điện thoại, thông số không có ở trên; không logo / thương hiệu bên thứ ba. KHÔNG có câu cấm chữ.
  - `clean`: không chữ, chữ số, logo trong ảnh.
  - Cả hai: câu "ảnh tĩnh" cấm UI giả (nút play, thanh phát video, khung điện thoại, giao diện ứng dụng / Facebook / Instagram, thanh trạng thái, con trỏ chuột, watermark); ý tưởng nói video / reel vẫn ra một ảnh tĩnh. Giữ câu không người nổi tiếng / nhân vật có bản quyền.
- **Ảnh tham khảo (`buildReferenceImagePrompt`):** luôn giữ NGUYÊN sản phẩm (hình dáng, màu, chất liệu, bao bì, nhãn in sẵn), không vẽ lại sản phẩm. `ad`: bỏ "chỉ đổi bối cảnh" và "không thêm chữ" — được thêm tiêu đề ngắn, nhân vật minh hoạ, bố cục quanh sản phẩm. `clean`: giữ câu "chỉ đổi bối cảnh…" và "không thêm chữ mới".
- **Slot chiến dịch:** brief = chủ đề slot (`Ý tưởng bài đăng`) + caption slot (`Nội dung bài`), phong cách `product`, mục đích + màu như 6.7. Không đổi luồng, lease, auto-approve, chi phí.
- **Chip "AI viết mô tả":** `ad` → viết brief ý tưởng ảnh quảng cáo (thông điệp, chủ thể, bố cục, đạo cụ; được đề xuất MỘT tiêu đề ngắn trong “ ” lấy từ ý tưởng); `clean` → mô tả cảnh không chữ như 6.7. Hướng `promo` ở `ad` không còn "chừa chỗ chèn chữ". Cả hai dặn ảnh tĩnh, không UI giả.
- **Soạn bài (FE):** ô chọn "Kiểu ảnh" cạnh "Phong cách" (hiện cả khi có ảnh tham khảo), mặc định "Ảnh quảng cáo". Gửi `topic` = ý tưởng; `caption` = caption tab đang mở khi bấm "Tạo ảnh AI" (không gửi khi "Tạo bằng AI" kèm ảnh — caption đang được viết lại).

**Never:** đổi model ảnh, giá, số ảnh, luồng job / hàng đợi, kích thước; thêm cột DB; sửa `sprint-status.yaml`; hậu kiểm chữ trên ảnh; log prompt.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Soạn bài `ad` | prompt=mô tả, topic=ý tưởng, caption | prompt cuối: mô tả, "Ý tưởng bài đăng", "Nội dung bài" (≤400, không hashtag/URL), gợi ý "Ảnh quảng cáo…", câu được chữ tiếng Việt, câu cấm UI giả; không câu cấm chữ | N/A |
| Body cũ | `{prompt, style}` | như `ad` với chỉ mô tả (không dòng ý tưởng / nội dung) | N/A |
| Ô mô tả trống | prompt=ý tưởng, topic=ý tưởng | không lặp dòng "Ý tưởng bài đăng" | N/A |
| `clean` | imageMode=clean | có câu không chữ / logo + câu cấm UI giả; không câu được chữ | N/A |
| Tham khảo `ad` | referenceId + ad | giữ nguyên sản phẩm, không vẽ lại; không "chỉ đổi bối cảnh", không "Không thêm chữ"; có câu cấm UI giả | ảnh tham khảo hỏng → như 6.6 |
| Tham khảo `clean` | referenceId + clean | như 6.7: chỉ đổi bối cảnh, không thêm chữ mới, + cấm UI giả | như 6.6 |
| Slot chiến dịch | slot có ảnh, chủ đề "Mẹo hay", caption | prompt `ad` có "Ý tưởng bài đăng: Mẹo hay" + "Nội dung bài: <caption tóm ý>" + mục đích + màu | lỗi ảnh → như 7.2 / 7.4 |
| Video trong ý tưởng | topic "quay video cận cảnh" | câu ảnh tĩnh, không thanh phát / nút play có mặt | N/A |
| Body sai | imageMode lạ; topic > 1000; caption > `POST_CAPTION_MAX` | 400 `VALIDATION_FAILED` + path | không ghi, không gọi AI |
| Chip `ad` / `clean` | image-prompt body có / không imageMode | `ad`: lệnh brief quảng cáo + tiêu đề ngắn; `clean`: lệnh không chữ; cả hai ảnh tĩnh | như 6.7 |

</frozen-after-approval>

## Code Map

- `packages/shared/src/content.ts` -- `ImageMode`, `IMAGE_BRIEF_CAPTION_MAX`, mở rộng `GenerateImagesRequest` / `ImagePromptRequest`.
- `server/src/modules/ai/prompts/image.ts` -- `buildImagePrompt`, `buildReferenceImagePrompt`, `imageBriefCaption`, chip theo kiểu.
- `server/src/modules/content/images.ts` -- truyền `imageMode`, `topic`, `caption` vào prompt.
- `server/src/modules/content/image-prompt.ts` -- truyền `imageMode` cho chip.
- `server/src/modules/content/slots.ts` -- prompt slot = chủ đề + caption, kiểu `ad`.
- `web/src/lib/composer.ts` -- `buildImageBody` / `buildImagePromptBody` + `IMAGE_MODE_OPTIONS`.
- `web/src/screens/Composer.tsx` -- ô "Kiểu ảnh", gửi ý tưởng / caption.
- `web/src/screens/CampaignWizard.tsx` -- câu gợi ý: ảnh chiến dịch là ảnh quảng cáo.
- `server/test/content-image-prompt.test.ts`, `content-images.test.ts`, `content-reference.test.ts`, `campaigns-preview.test.ts`, `web/src/lib/composer.test.ts` -- phủ ma trận.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/content.ts` -- thêm `ImageMode`, `IMAGE_BRIEF_CAPTION_MAX`, trường mới -- hợp đồng chung FE/BE.
- [x] `server/src/modules/ai/prompts/image.ts` (+ `prompts/index.ts`, `ai/index.ts`) -- brief + kiểu + cấm UI giả + chip theo kiểu -- lõi của story.
- [x] `server/src/modules/content/images.ts`, `image-prompt.ts`, `slots.ts` -- nối dữ liệu mới vào prompt.
- [x] `web/src/lib/composer.ts`, `web/src/screens/Composer.tsx`, `web/src/screens/CampaignWizard.tsx` -- UI chọn kiểu ảnh, gửi ý tưởng / caption, câu gợi ý.
- [x] Test server + web -- phủ ma trận (OpenAI giả): `ad` không còn câu cấm chữ, cả hai kiểu có câu cấm UI giả, prompt slot có chủ đề + caption.

**Acceptance Criteria:**
- Given Soạn bài mở mới, when nhìn mục Ảnh, then có ô "Kiểu ảnh" mặc định "Ảnh quảng cáo", đổi được sang "Ảnh chụp sạch"; ô hiện cả khi có ảnh tham khảo.
- Given chiến dịch đang chạy, when slot có ảnh được sinh, then ảnh dựng theo brief `ad`, không đổi chi phí / trạng thái slot.
- Given `npm run check` ở gốc, then xanh.

## Implementation Notes

- **Prompt (`server/src/modules/ai/prompts/image.ts`):** `briefLines` dựng phần brief (mô tả nguyên văn → `Ý tưởng bài đăng:` → `Nội dung bài:`); `imageBriefCaption` bỏ URL + hashtag, gộp một dòng, cắt ≤ 400 ở ranh giới từ (dùng chung `cutAtWord` với `cleanImageDescription`). Câu cấm UI giả export `IMAGE_NO_FAKE_UI` (test và bên thử thật dùng). `ImagePromptInput` / `ReferenceImagePromptInput` thêm `mode?`, `topic?`, `caption?` — thiếu `mode` = `ad`. Câu "watermark" chuyển từ câu không chữ sang câu cấm UI giả (có ở cả hai kiểu).
- **Chip:** `imageDescriptionInstructions` / `imageDescriptionInput` theo `mode`; hướng `promo` ở `clean` giữ câu 6.7 (chừa chỗ chèn chữ), ở `ad` có tiêu đề ngắn. "không tiêu đề" trong câu định dạng đổi thành "không đề mục" (tránh mâu thuẫn với tiêu đề in lên ảnh). `cleanImageDescription` bóc thêm nhãn "Brief:".
- **Server:** `images.ts` truyền `imageMode` / `topic` / `caption`; `image-prompt.ts` truyền `imageMode`; `slots.ts` dựng `buildImagePrompt({ description: '', topic, caption, mode: 'ad', style: 'product', … })` — bỏ hằng `IMAGE_DESCRIPTION_MAX` (600 ký tự caption làm mô tả).
- **FE:** `IMAGE_MODE_OPTIONS` / `IMAGE_MODE_HINT`; `ImageContext` thêm `imageMode?` / `caption?`; `buildImageBody` gửi `topic` khi ý tưởng khác mô tả, caption cắt ≤ 800 ký tự (server cắt tiếp). Composer: ô "Kiểu ảnh" (state theo phiên, không reset khi nạp bài khác), dòng gợi ý dưới hàng nút, câu ảnh tham khảo + gợi ý ô mô tả theo kiểu; "Tạo ảnh AI" gửi caption tab đang mở, "Tạo bằng AI" kèm ảnh thì không. Wizard: câu gợi ý ảnh chiến dịch là ảnh quảng cáo.
- **Không migration**; hợp đồng mới đều tuỳ chọn / có mặc định. Ghi deferred-work: cài đặt kiểu ảnh cho chiến dịch; chữ trên ảnh không hậu kiểm (rủi ro với "Tự đăng").
- **Test:** `content-image-prompt.test.ts` (khối 6.8: ad / clean / brief / video / tham khảo / HTTP / body sai / chip; sửa 3 khẳng định 6.7 theo mặc định `ad`), `campaigns-generate.test.ts` (prompt slot có chủ đề + caption + câu cấm UI giả, không câu cấm chữ), `web/src/lib/composer.test.ts` (body 6.8, nhãn kiểu ảnh; hai khẳng định parse thêm `imageMode: 'ad'`).

- **Kiểm:** `npm run check` xanh (server 81 tệp / 1624 test, web 25 tệp / 361 test). Xem ô "Kiểu ảnh" trên dev server (1440px): nằm trước "Phong cách", dòng gợi ý dưới hàng nút. Chưa thử OpenAI thật.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| `cleanImageDescription` bóc ngoặc bao ngoài cả khi brief `ad` mở / đóng bằng hai tiêu đề khác nhau trong “ ” (chip dặn đặt tiêu đề trong “ ”) → `Giòn rụm” … “Mua ngay`, lệch cặp ngoặc đưa vào ô Mô tả ảnh. Sửa: chỉ bóc khi bên trong không còn ngoặc cùng loại; thêm test. | real (medium) | patch |
| Prompt slot chiến dịch không có tên sản phẩm / ngành hàng — sản phẩm chỉ đến qua tóm ý caption ≤400 ký tự (6.7 là 600); chủ đề slot là tên nhóm chung ("Mẹo hay"), kiểu `ad` khuyến khích đạo cụ / nhân vật tự tạo → caption không nêu sản phẩm thì ảnh "Tự đăng" có thể vẽ sản phẩm shop không bán. | real (medium) | defer |
| Độ dài prompt cuối: `prompt` ≤1000 chỉ kiểm ở body; prompt dựng (mô tả + ý tưởng + caption ≤400 + câu cố định) ≤ ~3.000 ký tự, mọi model ảnh trong DB là `gpt-image-*` (giới hạn 32.000). | không lỗi | — |
| Caption chèn lệnh vào prompt ảnh: caption chỉ do chủ shop / AI soạn bài viết (không có nội dung khách), gộp một dòng; giá / khuyến mãi có trong caption được phép in, câu `AD_TEXT` cấm thêm cái không có. | không lỗi | — |

## Design Notes

**Bằng chứng so sánh (thử thật, cùng `gpt-image-2.5-sunburst`, cùng ảnh sản phẩm qua `/images/edits`):**
- TNUT (`FlowMate/tnut-media/web/src/CampaignPlannerPage.jsx` `genOne`: `imgPrompt = \`${product}. ${item.brief || item.title}\``, brief do model chữ viết ở `campaign-gen.service.js` `generateScheduleOptions`) → ảnh quảng cáo hoàn chỉnh: tiêu đề tiếng Việt có dấu đúng chính tả, mascot, điểm nổi bật, collage nhiều góc, đạo cụ theo ngữ cảnh. Prompt mẫu: "Móc khoá keycap phô mai kèm switch cơ (blue switch). Đăng ảnh sản phẩm kèm câu hỏi vui để hé lộ… Nhấn vào thiết kế đáng yêu và khác lạ." Lỗi duy nhất: brief "video quay cận" → vẽ thanh phát video giả → story thêm câu cấm UI giả cho mọi kiểu.
- OnTheTopMoney 6.7 (cấm chữ / logo / khung, "chỉ đổi bối cảnh") → ảnh sạch nhưng phẳng.

**Hình dạng prompt `ad` (Soạn bài, không tham khảo):**
```
<mô tả của chủ shop>
Ý tưởng bài đăng: <ý tưởng>
Nội dung bài: <caption tóm ý ≤400>

(Ảnh quảng cáo cho bài đăng …; mục đích: …; phong cách: …; tông màu thương hiệu: …)
<câu bố cục quảng cáo + câu chữ tiếng Việt ngắn, không bịa giá…>
<câu ảnh tĩnh cấm UI giả> <câu không người nổi tiếng>
```

## Verification

**Commands:**
- `npm run check` (gốc) -- expected: typecheck, lint, test server + web xanh.
