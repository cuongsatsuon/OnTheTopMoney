---
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - _bmad-output/planning-artifacts/ux-designs/ux-OnTheTopMoney-2026-10-19/EXPERIENCE.md
  - _bmad-output/planning-artifacts/ux-designs/ux-OnTheTopMoney-2026-10-19/DESIGN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-OnTheTopMoney-2026-10-19/.memlog.md
  - _bmad-output/planning-artifacts/architecture/architecture-OnTheTopMoney-2026-10-20/ARCHITECTURE-SPINE.md
  - web/src/data/mock.ts
---

# OnTheTopMoney - Epic Breakdown

## Overview

Tài liệu này chia công việc **backend + nối frontend** của OnTheTopMoney thành epic và story. Chưa có PRD: yêu cầu chức năng (FR) được rút trực tiếp từ `EXPERIENCE.md` (spine UX) và `.memlog.md`; quyết định kỹ thuật lấy từ `ARCHITECTURE-SPINE.md` (mã `AD-n`). Frontend React ở `web/` đã dựng xong với dữ liệu mẫu; story chỉ yêu cầu FE ở mức "nối API thay dữ liệu mẫu", không làm lại giao diện.

Quy ước trỏ nguồn trong mỗi story: **UX:** màn hình (route) và Key Flow (`F1`…`F7`) hoặc State Pattern trong `EXPERIENCE.md`; **AD:** quyết định kiến trúc ràng buộc.

## Requirements Inventory

### Functional Requirements

FR1: Kết nối Facebook qua Meta OAuth, chọn một hoặc nhiều Fanpage và tài khoản Instagram Business đã liên kết Fanpage, xin quyền tin nhắn, đăng bài, thống kê. (F1 b1, F7 b2)
FR2: Kết nối tài khoản Threads qua OAuth Threads. (F1 b1)
FR3: Khi người dùng huỷ cửa sổ Meta hoặc bỏ quyền, báo danh sách quyền thiếu và cho "Thử lại"; chọn IG cá nhân thì báo chỉ hỗ trợ IG Business đã liên kết Fanpage. (State "Kết nối bị huỷ / thiếu quyền", F7 Thất bại)
FR4: Theo dõi hạn token từng trang: còn ≤7 ngày là "Token sắp hết hạn", token hỏng là "Mất kết nối"; "Kết nối lại" mở lại Meta cho đúng trang đó. (F7 b7, State "Token sắp hết hạn", "Mất kết nối")
FR5: Tạo, sửa, xoá Nhóm (tên, màu trong bảng 8 màu); gán trang vào nhóm, mỗi trang tối đa một nhóm; chuyển trang sang nhóm khác phải cảnh báo trước. (F1 b2, F1 Thất bại)
FR6: Bảng trang chọn nhiều → Thêm vào nhóm, Bật/Tắt AI trả lời hàng loạt. (Component Patterns › Bảng trang)
FR7: Bộ chọn Phạm vi (Tất cả trang / một nhóm / một trang) lọc dữ liệu ở Tổng quan, Hộp thư, Khách hàng, Lịch nội dung, Chiến dịch, Hiệu suất. (Mô hình khái niệm › Phạm vi)
FR8: Hồ sơ thương hiệu cho Nhóm và Trang (tên, slogan, ngành, giọng điệu, độ trang trọng, xưng hô, emoji, sản phẩm + giá, khách mục tiêu, màu, hashtag, từ cấm, logo); trang mặc định "Theo nhóm", bật "Dùng hồ sơ riêng" để ghi đè; trang không nhóm bắt buộc hồ sơ riêng. (F1 b3–b5, Kế thừa cấu hình)
FR9: Mọi chỗ đang kế thừa hiển thị nguồn ("Đang dùng hồ sơ của Nhóm Mỹ phẩm"). (Kế thừa cấu hình, Component Patterns › Nhãn kế thừa)
FR10: "Viết thử bằng AI" sinh một caption theo hồ sơ đang soạn. (F1 b4)
FR11: App tự đăng ký webhook với Meta; Cài đặt › Webhook hiển thị URL nhận tin, verify token, trạng thái nhận tin gần nhất, nhật ký sự kiện. (F7 b4, Cài đặt)
FR12: Nhận tin Messenger, Instagram Direct, bình luận Facebook/Instagram và trả lời Threads vào Hộp thư hợp nhất. (F2 b1, Giới hạn nền tảng)
FR13: Hộp thư có tab Tất cả · Cần xử lý · AI đang trả lời · Đã xong; badge số cần xử lý ở sidebar; hội thoại "Cần xử lý" có lý do chuyển và đếm thời gian chờ. (IA › Hộp thư, F2 b4, State "AI chuyển cho người")
FR14: Trong hội thoại: bật/tắt AI tự trả lời, "Tiếp quản", gửi tin, "Gợi ý bằng AI", đánh dấu xong. (F2 b4, Component Patterns › Hội thoại)
FR15: Gửi tin tuân thủ cửa sổ 24 giờ của Meta; tin lỗi hiện lý do ("Quá 24 giờ…", "Trang mất kết nối", "Gửi quá nhanh…") và "Gửi lại", tin không bị mất. (State "Gửi tin lỗi", F2 Thất bại)
FR16: Cảnh báo "Chưa nhận tin mới 30 phút — Kiểm tra webhook" khi webhook ngừng nhận sự kiện trong giờ thường có tin. (State "Webhook ngừng nhận tin")
FR17: Hộp thư cập nhật thời gian thực; mất kết nối hiện "Đang kết nối lại…", tự thử lại và tải bù. (State "Mất kết nối thời gian thực", "AI đang trả lời")
FR18: Khách hàng: danh sách, thẻ, giai đoạn (Mới, Đang tư vấn, Chốt đơn, Khách quen, Khiếu nại), ghi chú, tóm tắt AI, lịch sử nhắn tin trên nhiều trang; panel khách trong Hộp thư sửa được thẻ và giai đoạn. (IA › Khách hàng, F2 b5)
FR19: Cấu hình AI trả lời tự động theo Nhóm/Trang có kế thừa: bật/tắt, giờ hoạt động (luôn bật / ngoài giờ làm việc / theo khung giờ), kịch bản (lấy từ Hồ sơ thương hiệu), kho kiến thức (tải file, FAQ), quy tắc chuyển người (từ khoá, khách yêu cầu gặp người, AI không chắc chắn), kênh áp dụng (Messenger, IG Direct, trả lời bình luận công khai, nhắn riêng người bình luận). (F6, mục "Cấu hình AI trả lời tự động")
FR20: Khung "Thử AI" mô phỏng trả lời và cho thấy khi nào AI sẽ chuyển cho bạn, trước khi bật. (F6 b6)
FR21: AI tự trả lời tin khách theo cấu hình hiệu lực và kho kiến thức; khớp quy tắc thì trả lời câu chuyển tiếp và chuyển cho bạn kèm lý do. (F2 b2–b3)
FR22: Chưa có khoá OpenAI thì công tắc AI bị khoá kèm banner; kịch bản trống thì không cho bật. (F6 Thất bại, State "Chưa nhập khoá OpenAI")
FR23: Soạn bài AI: chọn đích (trang hoặc nhóm), nhập ý tưởng, AI viết caption theo hồ sơ của từng trang (tab theo trang) và sinh 4 ảnh; chọn ảnh, tạo lại, hoặc tải ảnh lên. (F4 b1–b3)
FR24: Đăng ngay hoặc lên lịch cho nhiều trang; mỗi trang có trạng thái riêng; trang lỗi không chặn trang khác; bài lỗi đỏ trên lịch với "Đăng lại". (F4 b5, F4 Thất bại, State "Đăng bài lỗi")
FR25: Ảnh AI bị từ chối hoặc lỗi → "Không tạo được ảnh này" + "Thử mô tả khác", caption giữ nguyên. (F4 Thất bại)
FR26: Lịch nội dung theo tuần/tháng; kéo bài sang ngày khác để đổi lịch, bài đã đăng không kéo được; duyệt bài chiến dịch ngay trên lịch. (IA › Lịch nội dung, Component Patterns › Bài trên lịch)
FR27: Wizard tạo chiến dịch 4 bước: mục tiêu + thời lượng → trang đích (nhóm hoặc từng trang, tần suất riêng mỗi trang) → chủ đề + tỉ lệ (phải đủ 100%), tỉ lệ bài có ảnh AI, khung giờ đăng, chế độ "Duyệt trước khi đăng" (mặc định) hoặc "Tự đăng" → duyệt 7 bài đầu (sửa, xoá, tạo lại). (F3 b1–b5)
FR28: "Bắt đầu chiến dịch" → Lịch nội dung hiện toàn bộ bài dự kiến đánh dấu "AI tạo"; Tổng quan hiện thẻ tiến độ. (F3 b6)
FR29: Hàng đợi "Bài chờ duyệt" của chiến dịch: duyệt, sửa, tạo lại, bỏ. (IA › Chiến dịch nuôi page)
FR30: Thẻ chiến dịch: Tạm dừng/Tiếp tục ngay không cần xác nhận, xoá phải xác nhận; chiến dịch tự tạm dừng khi trang mất kết nối hoặc hết hạn mức AI, ghi lý do trên thẻ; bài AI tạo lỗi chuyển "Chờ duyệt". (F3 Thất bại, Component Patterns › Thẻ chiến dịch, State "Mất kết nối")
FR31: Hiệu suất theo Phạm vi và khoảng thời gian: KPI, biểu đồ theo nền tảng, bảng so sánh từng trang, bài tốt nhất. (F5 b1–b2)
FR32: Mục "Hiệu quả AI": số tin AI trả lời, tỉ lệ chuyển người, thời gian phản hồi trung bình, bài AI tạo vs bài tự viết. (F5 b3)
FR33: "Tạo bài tương tự" mở Soạn bài AI với ý tưởng và đích điền sẵn. (F5 b4)
FR34: Trang kết nối <7 ngày hiện "Cần thêm vài ngày dữ liệu" thay biểu đồ. (F5 Thất bại, State "Chưa đủ dữ liệu")
FR35: Tổng quan: số liệu chính, việc cần xử lý, bài sắp đăng, chiến dịch đang chạy, cảnh báo token/webhook/chiến dịch/hạn mức. (IA › Tổng quan)
FR36: Cài đặt › OpenAI: nhập khoá, app kiểm tra và báo "Đã kết nối" hoặc "Khoá không hợp lệ" (không lưu khoá sai), chọn model chữ và model ảnh, đặt hạn mức VND/tháng. (F7 b3, Cài đặt)
FR37: Hạn mức chi phí AI: đạt 80% → toast + chip vàng ở sidebar; đạt 100% → banner đỏ toàn app, AI ngừng trả lời (hội thoại mới vào "Cần xử lý" lý do "Hết hạn mức AI"), chiến dịch tự tạm dừng, nút AI ở Soạn bài bị khoá. (State "Hết hạn mức chi phí AI")
FR38: Thông báo trong app khi AI chuyển người, token sắp hết hạn, đăng bài lỗi, chiến dịch tạm dừng; bật/tắt từng loại ở Cài đặt › Thông báo. (Cài đặt, Interaction Primitives › toast)
FR39: Màn chào 4 bước khi chưa có trang: kết nối trang → thêm khoá OpenAI → hồ sơ thương hiệu → bật AI trả lời; cao trào là tin đầu tiên vào Hộp thư và AI đã trả lời. (F7, IA › Màn chào)
FR40: Bảng lệnh ⌘K tìm trang, nhóm, khách và chạy lệnh. (Interaction Primitives)

### NonFunctional Requirements

NFR1: AI trả lời tin khách "trong vài giây": p95 ≤ 15 giây từ lúc Meta gửi webhook tới lúc tin AI được gửi đi (gồm thời gian gộp tin). (F2 b2)
NFR2: Endpoint webhook trả 200 trong ≤ 1 giây p95; không mất sự kiện khi worker dừng (sự kiện đã ghi DB trước khi trả 200). (AD-4)
NFR3: Tin mới / thay đổi trạng thái hiển thị trên trình duyệt đang mở ≤ 3 giây sau khi ghi DB. (AD-3)
NFR4: Không mất và không trùng tin: nhận idempotent theo id nền tảng; tin gửi lỗi được lưu và gửi lại được. (AD-10, AD-11)
NFR5: Bí mật (token Meta, khoá OpenAI) mã hoá khi lưu, không bao giờ trả về client hay ghi log. (AD-12)
NFR6: Chi phí OpenAI không vượt hạn mức tháng quá một lời gọi. (AD-7)
NFR7: Một người dùng, không multi-tenant; mọi API cần đăng nhập trừ webhook/media/OAuth callback. (AD-19)
NFR8: Tuân thủ chính sách Meta: cửa sổ 24 giờ, giới hạn nhắn riêng bình luận, rate limit; app cần Live mode + Advanced Access + Business Verification để go-live. (AD-10, Điều kiện ngoài)
NFR9: Sao lưu Postgres + media hằng đêm, giữ 14 bản; mất dữ liệu tối đa 24 giờ. (Structural Seed)
NFR10: Web desktop ≥1280px, giao diện tiếng Việt, nền Accessibility Floor của EXPERIENCE.md giữ nguyên khi nối API. (Foundation, Accessibility Floor)

### Additional Requirements

- Không dùng starter template: `web/` đã có (Vite 8 + React 19 + TS 7 + Tailwind v4). Backend dựng mới trong `server/` + `packages/shared/` theo cây nguồn ở Structural Seed. Epic 1 Story 1 là khung monorepo.
- Modular monolith, 2 tiến trình `api` + `worker`, Postgres 18 làm dữ liệu + hàng đợi pg-boss + LISTEN/NOTIFY (AD-1, AD-2, AD-3).
- Hợp đồng API: REST `/api/v1`, zod ở `packages/shared`, lỗi `{error:{code,…}}`, `scope=` cho danh sách (AD-18); FE thay kiểu `mock.ts` bằng kiểu chung.
- Triển khai: một VPS Docker Compose (caddy, api, worker, postgres), migration Drizzle trước khởi động, healthz + heartbeat worker, backup hằng đêm (Structural Seed).
- Tích hợp Meta qua một adapter pin Graph `v26.0`, phân loại lỗi, backoff (AD-6); token do `connections` sở hữu, mã hoá, cron làm mới (AD-5, AD-12).
- Tích hợp OpenAI qua một AI gateway ghi `ai_usage`, chặn theo hạn mức (AD-7); ảnh AI chạy job, lưu `MediaStore` có URL công khai (AD-14).
- Đăng nhập chủ sở hữu bằng mật khẩu + session cookie (AD-19).
- Điều kiện ngoài: Meta App, App Review, Business Verification (mục "Điều kiện ngoài" của spine) — việc của người dùng, có story hướng dẫn/checklist.
- Thay đổi hợp đồng dữ liệu so với `mock.ts`: `Post` tách `PostTarget[]`; `Contact.pageIds` dẫn xuất; `Page.brandSource` dẫn xuất; thời gian là timestamp.

### UX Design Requirements

Giao diện và token thị giác (DESIGN.md) đã được dựng trong `web/`. Các UX-DR dưới đây là những hành vi trạng thái chỉ hoạt động thật khi có backend, mỗi cái phải được giữ đúng khi nối API.

UX-DR1: Skeleton theo đúng bố cục khi đang tải dữ liệu thật ở mọi màn. (State "Đang tải")
UX-DR2: Nút AI mờ + tooltip "Thêm khoá OpenAI ở Cài đặt" khi server báo `OPENAI_KEY_MISSING`. (State "Chưa nhập khoá OpenAI")
UX-DR3: Chip trạng thái kết nối (xanh/vàng/đỏ, luôn có chữ) lấy từ `ConnectionStatus` của server ở Trang & Nhóm, Tổng quan, Cài đặt › Tài khoản Meta. (State "Token sắp hết hạn", "Mất kết nối", Accessibility Floor)
UX-DR4: Chip tím "AI đang trả lời" + chấm "đang gõ" theo sự kiện `conversation.ai_typing`. (State "AI đang trả lời")
UX-DR5: Ghi chú hệ thống nêu lý do chuyển, ánh xạ từ `HandoffReason` sang microcopy tiếng Việt. (State "AI chuyển cho người")
UX-DR6: Bong bóng tin lỗi có icon đỏ + lý do theo `ErrorCode` + "Gửi lại". (State "Gửi tin lỗi")
UX-DR7: Banner vàng webhook, dải xám "Đang kết nối lại…", banner đỏ hết hạn mức, chip vàng 80% ở sidebar — điều khiển bằng dữ liệu server. (State Patterns)
UX-DR8: Toast cho mọi thao tác nền (đăng bài, kết nối, AI xong) từ sự kiện SSE. (Interaction Primitives)
UX-DR9: Trạng thái "AI đang viết…" + nút Dừng huỷ request thật. (Component Patterns › Nút AI)
UX-DR10: Nhãn chữ "AI tạo" cho nội dung do AI sinh dựa trên cờ `ai` từ server. (Accessibility Floor)
UX-DR11: Bản đồ `ErrorCode` → microcopy tiếng Việt theo Voice and Tone, đặt một chỗ trong `web/`. (Voice and Tone, AD-18)

### FR Coverage Map

FR1: Epic 2 - Kết nối Fanpage + IG Business qua Meta OAuth
FR2: Epic 2 - Kết nối Threads
FR3: Epic 2 - Huỷ/thiếu quyền, IG cá nhân
FR4: Epic 2 - Hạn token, Kết nối lại
FR5: Epic 2 (nhóm, gán, cảnh báo chuyển) + Epic 3 (giữ cấu hình khi đổi nhóm)
FR6: Epic 2 (Thêm vào nhóm hàng loạt) + Epic 5 (Bật/Tắt AI hàng loạt)
FR7: Epic 2 - Phạm vi lọc dữ liệu thật
FR8: Epic 3 - Hồ sơ thương hiệu nhóm/trang
FR9: Epic 3 - Nhãn nguồn kế thừa
FR10: Epic 3 - Viết thử bằng AI
FR11: Epic 4 - Webhook, URL, verify token, nhật ký, tự đăng ký
FR12: Epic 4 - Tin DM, bình luận, trả lời Threads vào Hộp thư
FR13: Epic 4 - Tab Hộp thư, badge, lý do, thời gian chờ
FR14: Epic 4 - Tiếp quản, gửi tin, Gợi ý bằng AI, đánh dấu xong
FR15: Epic 4 - Cửa sổ 24 giờ, tin lỗi, Gửi lại
FR16: Epic 4 - Cảnh báo webhook ngừng nhận tin
FR17: Epic 1 (kênh SSE) + Epic 4 (realtime Hộp thư)
FR18: Epic 4 - Khách hàng
FR19: Epic 5 - Cấu hình AI trả lời
FR20: Epic 5 - Thử AI
FR21: Epic 5 - AI tự trả lời và chuyển cho bạn
FR22: Epic 5 - Khoá công tắc khi thiếu khoá/kịch bản trống
FR23: Epic 6 - Soạn bài AI + 4 ảnh
FR24: Epic 6 - Đăng/lên lịch nhiều trang, trạng thái từng trang, Đăng lại
FR25: Epic 6 - Ảnh bị từ chối
FR26: Epic 6 - Lịch nội dung, kéo thả
FR27: Epic 7 - Wizard chiến dịch 4 bước
FR28: Epic 7 - Bắt đầu chiến dịch, lịch đầy đủ, thẻ tiến độ
FR29: Epic 7 - Bài chờ duyệt
FR30: Epic 7 - Tạm dừng/Tiếp tục/Xoá, tự tạm dừng
FR31: Epic 8 - Hiệu suất theo phạm vi
FR32: Epic 8 - Hiệu quả AI
FR33: Epic 8 - Tạo bài tương tự
FR34: Epic 8 - Chưa đủ dữ liệu
FR35: Epic 8 - Tổng quan
FR36: Epic 1 - Khoá OpenAI, model, hạn mức
FR37: Epic 1 (gateway, chip 80%, banner 100%) + Epic 5 (AI ngừng trả lời) + Epic 6 (khoá nút AI) + Epic 7 (chiến dịch tạm dừng)
FR38: Epic 1 - Thông báo trong app, bật/tắt theo loại
FR39: Epic 5 - Màn chào 4 bước hoàn chỉnh
FR40: Epic 4 - ⌘K tìm trang, nhóm, khách

UX-DR coverage: UX-DR1 → 1.2 (+ DoD chung); UX-DR2 → 1.5, 6.2; UX-DR3 → 2.4; UX-DR4 → 5.4; UX-DR5 → 4.6, 5.4; UX-DR6 → 4.7; UX-DR7 → 1.6, 4.2, 8.5; UX-DR8 → 1.4; UX-DR9 → 3.4, 4.8, 6.2; UX-DR10 → 6.5, 7.3; UX-DR11 → 1.2.

## Definition of Done chung

Áp cho mọi story có phần `web/` (không lặp lại trong từng story):

- Màn liên quan trong `web/` bỏ dữ liệu mẫu của phần đó, gọi API thật qua lớp client chung; kiểu dữ liệu lấy từ `packages/shared` (AD-18).
- Đang tải hiện skeleton đúng bố cục (UX-DR1); lỗi hiển thị qua bản đồ `ErrorCode` → microcopy (UX-DR11), đúng Voice and Tone.
- Giữ nguyên Accessibility Floor của EXPERIENCE.md (chip có chữ, nhãn nền tảng, điều khiển bằng bàn phím).
- Có test: unit cho nghiệp vụ, tích hợp với Postgres thật cho repo/job, fake adapter cho Meta/OpenAI.

## Epic List

> Cấu trúc epic do Claude tự duyệt theo chỉ dẫn "tự quyết, đánh dấu [ASSUMPTION]" của người dùng; các menu [C] của workflow được bỏ qua vì lý do này.

### Epic 1: Nền móng, đăng nhập và kết nối OpenAI
Chủ shop mở app trên tên miền riêng, đăng nhập an toàn, nhập khoá OpenAI đã được kiểm, đặt hạn mức và thấy chi phí AI; app có kênh realtime và trung tâm thông báo cho mọi epic sau.
**FRs covered:** FR17 (kênh), FR36, FR37 (phần chung), FR38

### Epic 2: Kết nối trang và gom nhóm
Chủ shop kết nối Fanpage, Instagram Business, Threads thật, theo dõi hạn token và kết nối lại; tạo nhóm, gán trang, và Bộ chọn phạm vi lọc dữ liệu thật.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6 (nhóm), FR7

### Epic 3: Hồ sơ thương hiệu dùng chung theo nhóm
Chủ shop soạn hồ sơ thương hiệu cho nhóm hoặc trang, thấy nguồn kế thừa, ghi đè riêng từng trang, đổi nhóm mà không mất cấu hình, và cho AI viết thử đúng giọng.
**FRs covered:** FR5 (giữ cấu hình), FR8, FR9, FR10

### Epic 4: Hộp thư hợp nhất và Khách hàng
Tin nhắn Messenger, IG Direct, bình luận và trả lời Threads về một Hộp thư realtime; chủ shop tiếp quản, trả lời đúng luật 24 giờ, dùng gợi ý AI, quản lý khách và tìm nhanh bằng ⌘K.
**FRs covered:** FR11, FR12, FR13, FR14, FR15, FR16, FR17, FR18, FR40

### Epic 5: AI trả lời tự động
Chủ shop cấu hình AI theo nhóm/trang (kịch bản, kho kiến thức, quy tắc chuyển người, giờ hoạt động, kênh), thử trước, rồi để AI tự trả lời tin nhắn và bình luận, tự chuyển cho người khi cần; Màn chào 4 bước chạy trọn.
**FRs covered:** FR6 (AI hàng loạt), FR19, FR20, FR21, FR22, FR37 (Hộp thư), FR39

### Epic 6: Soạn bài AI và Lịch nội dung
Chủ shop soạn một bài cho nhiều trang với caption và ảnh AI theo hồ sơ từng trang, đăng ngay hoặc lên lịch, xem và kéo thả trên Lịch nội dung, đăng lại khi một trang lỗi.
**FRs covered:** FR23, FR24, FR25, FR26, FR37 (Soạn bài)

### Epic 7: Chiến dịch nuôi page
Chủ shop tạo chiến dịch AI nhiều ngày qua wizard 4 bước, duyệt bài, để AI đăng đều đặn, tạm dừng/tiếp tục; chiến dịch tự dừng an toàn khi có sự cố.
**FRs covered:** FR27, FR28, FR29, FR30, FR37 (Chiến dịch)

### Epic 8: Hiệu suất và Tổng quan
Chủ shop xem hiệu suất theo trang/nhóm/nền tảng, hiệu quả AI, tạo bài tương tự từ bài tốt nhất, và có màn Tổng quan với việc cần xử lý thật.
**FRs covered:** FR31, FR32, FR33, FR34, FR35

### Epic 9: Sẵn sàng go-live và quyền riêng tư
App đủ điều kiện Meta Live mode (chính sách, xoá dữ liệu, App Review), dữ liệu khách được xoá theo yêu cầu và theo thời hạn, backup đã được diễn tập khôi phục.
**FRs covered:** (NFR5, NFR8, NFR9; AD-22)

## Epic 1: Nền móng, đăng nhập và kết nối OpenAI

Chủ shop mở app trên tên miền riêng, đăng nhập an toàn, nhập khoá OpenAI đã được kiểm, đặt hạn mức và thấy chi phí AI; app có kênh realtime và trung tâm thông báo cho mọi epic sau.

### Story 1.1: Khung monorepo, server hai tiến trình và hợp đồng chung

As a chủ shop,
I want app có backend chạy được cạnh frontend đã dựng,
So that các tính năng sau có chỗ đặt nghiệp vụ và dùng chung kiểu dữ liệu với giao diện.

**UX:** nền móng cho mọi màn trong IA. **AD:** AD-1, AD-2, AD-18, AD-24, Consistency Conventions › Monorepo, Stack.

**Acceptance Criteria:**

**Given** repo hiện chỉ có `web/`
**When** chạy `npm install` và `npm run dev` ở gốc
**Then** npm workspaces gồm `web`, `server`, `packages/shared`; `web` (Vite), `api` (Fastify) và `worker` (pg-boss) cùng chạy với Postgres 18 trong docker compose local
**And** `GET /healthz` trả 200 khi DB truy cập được và heartbeat worker (`worker_heartbeats`) mới hơn 2 phút, ngược lại 503

**Given** `packages/shared` có khung `ErrorCode`, `events.ts`, enum của Consistency Conventions
**When** `web` và `server` import cùng một zod schema
**Then** `tsc --noEmit` (TS 7.0.2) qua ở cả hai; server chạy bằng type stripping của Node 24 với `erasableSyntaxOnly`

**Given** CI chạy kiểm ranh giới
**When** một file trong `modules/inbox` import `modules/campaigns/index.ts` hoặc ruột của module khác
**Then** `dependency-cruiser` (danh sách cho phép sinh từ bảng mũi tên AD-1, có `no-circular`) báo lỗi và CI đỏ

**Given** `platform/jobs/queues.ts`
**When** worker khởi động
**Then** chỉ các queue khai báo trong file này được tạo, với policy/retry/concurrency của AD-24, cron dùng `tz: 'Asia/Ho_Chi_Minh'`
**And** có ghi chú kết quả spike: drizzle-kit 0.31.11, vitest 5.0.5 và dependency-cruiser chạy được với TS 7.0.2 (nếu không, chuyển sang phương án dự phòng của AD-1 và ghi lại)

### Story 1.2: Đăng nhập chủ sở hữu và lớp gọi API của web

As a chủ shop,
I want đăng nhập bằng mật khẩu riêng trước khi thấy dữ liệu,
So that không ai khác trên internet điều khiển được các trang của tôi.

**UX:** [ASSUMPTION] màn đăng nhập tối giản theo DESIGN.md (EXPERIENCE.md chưa có màn này); Voice and Tone; UX-DR1, UX-DR11. **AD:** AD-19, AD-18, AD-12.

**Acceptance Criteria:**

**Given** chưa có mật khẩu
**When** chạy `server set-password` trên máy chủ
**Then** mật khẩu được lưu dạng argon2id; không có cách tạo tài khoản qua web

**Given** người dùng mở bất kỳ route nào của app khi chưa có phiên
**When** trang tải
**Then** chuyển tới màn đăng nhập; đăng nhập đúng tạo session (hạn 30 ngày trượt, xoay id) với cookie `HttpOnly; Secure; SameSite=Lax` và quay lại route ban đầu

**Given** nhập sai mật khẩu 5 lần trong 15 phút từ một IP
**When** thử lần thứ 6
**Then** API trả `RATE_LIMITED` và FE hiện "Thử lại sau ít phút"

**Given** mọi `/api/v1/*` trừ `/auth/login`
**When** gọi không có phiên hoặc request ghi có `Origin` lạ
**Then** trả 401/403 với `{error:{code}}`

**Given** lớp client API chung trong `web/`
**When** một request trả lỗi
**Then** FE ánh xạ `code` sang microcopy tiếng Việt tại một file duy nhất (UX-DR11), và mọi màn dùng skeleton khi đang tải (UX-DR1)

### Story 1.3: Triển khai production trên một VPS

As a chủ shop,
I want app chạy ổn định trên tên miền HTTPS riêng, có sao lưu,
So that Meta gửi được webhook tới app và tôi không mất dữ liệu khi máy chủ hỏng.

**UX:** Foundation (web desktop). **AD:** Structural Seed › Container và triển khai, AD-12 (backup), AD-19 (header bảo mật).

**Acceptance Criteria:**

**Given** `deploy/docker-compose.yml` gồm `caddy`, `migrate`, `api`, `worker`, `postgres`
**When** chạy `docker compose up -d` với image tag theo git SHA
**Then** `migrate` chạy migration Drizzle (chỉ tiến) xong mới khởi động `api`/`worker` (`service_completed_successfully`)
**And** Caddy cấp TLS cho `PUBLIC_BASE_URL`, chuyển `/healthz`, `/api`, `/webhooks`, `/oauth`, `/privacy` tới api, phục vụ `/media` từ volume công khai, mọi route khác trả `index.html` của `web/` (route tiếng Việt như `/hop-thu` mở trực tiếp được)
**And** Caddy đặt CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`; SSE không bị đệm (`flush_interval -1`)

**Given** `platform/config` đọc env bằng zod
**When** thiếu biến bắt buộc hoặc `NODE_ENV=production` dùng id Meta test app
**Then** tiến trình không khởi động và log rõ biến lỗi

**Given** cron backup hằng đêm
**When** chạy
**Then** `pg_dump -Fc` + media được mã hoá và đẩy sang kho của nhà cung cấp khác VPS, giữ 14 bản; `APP_ENCRYPTION_KEYS` không nằm trong backup

**Given** một dịch vụ uptime ping ngoài gọi `/healthz` mỗi 5 phút
**When** healthz trả 503 (worker chết, đĩa >85%, DB lỗi)
**Then** chủ shop nhận cảnh báo từ dịch vụ ping; `deploy/runbook.md` ghi cách xem log (Docker log rotation) và cách rollback về tag trước

### Story 1.4: Kênh realtime và trung tâm thông báo

As a chủ shop,
I want màn hình tự cập nhật và có thông báo khi việc nền xong hoặc lỗi,
So that tôi không phải tải lại trang để biết chuyện gì vừa xảy ra.

**UX:** Interaction Primitives › toast; Cài đặt › Thông báo; State "Mất kết nối thời gian thực"; UX-DR8. **AD:** AD-3, AD-24.

**Acceptance Criteria:**

**Given** một sự kiện miền có `realtime=true` được phát trong transaction
**When** transaction commit
**Then** `platform/realtime` gửi `NOTIFY realtime` với `{type, entity, id, pageId}` và mọi tab đang mở nhận qua `GET /api/v1/stream` trong ≤3 giây (NFR3)
**And** client chỉ vô hiệu hoá cache và refetch qua REST, không hiển thị dữ liệu từ payload

**Given** kết nối SSE bị ngắt
**When** client phát hiện mất heartbeat (25 giây)
**Then** hiện dải xám "Đang kết nối lại…", tự nối lại có backoff, khi có lại thì refetch các danh sách đang mở

**Given** bảng `notifications` và bộ lọc theo loại trong `settings`
**When** sự kiện thuộc loại đã bật (AI chuyển người, token sắp hết hạn, đăng bài lỗi, chiến dịch tạm dừng, `job.failed` của queue quan trọng)
**Then** tạo thông báo, đẩy toast, và hiện trong danh sách thông báo; loại đã tắt ở Cài đặt › Thông báo thì không tạo
**And** handler idempotent theo `(event, id, version)`

### Story 1.5: Nhập và kiểm khoá OpenAI

As a chủ shop,
I want dán khoá OpenAI và biết ngay khoá có dùng được không,
So that các nút AI hoạt động và khoá của tôi được giữ an toàn.

**UX:** Cài đặt › OpenAI; F7 b3, F7 Thất bại ("Khoá không hợp lệ"); State "Chưa nhập khoá OpenAI"; UX-DR2. **AD:** AD-7, AD-12.

**Acceptance Criteria:**

**Given** chủ shop dán khoá ở Cài đặt › Kết nối OpenAI
**When** bấm "Kiểm tra và lưu"
**Then** server gọi OpenAI kiểm tra; hợp lệ → lưu mã hoá `v1:<keyId>:…`, trả `{configured, last4, status: valid, checkedAt}` và FE hiện "Đã kết nối"; sai → `OPENAI_KEY_INVALID`, không lưu, FE hiện "Khoá không hợp lệ"

**Given** không có API nào trả khoá đầy đủ
**When** gọi `GET /api/v1/settings/openai`
**Then** chỉ có `last4` và trạng thái; log không chứa khoá (redact AD-12)

**Given** bảng `ai_model_prices` có seed `gpt-6-luna` (chữ) và `gpt-image-2.5-flare` (ảnh)
**When** mở Cài đặt › OpenAI
**Then** danh sách model chữ/ảnh lấy từ API (bỏ danh sách cứng trong `web/`), chọn được model, kích thước ảnh, và có ô tỉ giá VND/USD (mặc định 26.000 [ASSUMPTION])

**Given** chưa có khoá hoặc khoá `invalid`
**When** bất kỳ nút AI nào được hiển thị
**Then** nút mờ với tooltip "Thêm khoá OpenAI ở Cài đặt" kèm liên kết (UX-DR2), dựa trên trạng thái từ server

### Story 1.6: AI gateway và hạn mức chi phí

As a chủ shop,
I want đặt hạn mức chi phí AI theo tháng và được cảnh báo trước khi chạm trần,
So that hoá đơn OpenAI không vượt ngân sách của tôi.

**UX:** State "Hết hạn mức chi phí AI" (80% chip vàng + toast, 100% banner đỏ toàn app); Cài đặt › OpenAI (bảng chi phí theo hạng mục); UX-DR7. **AD:** AD-7, AD-3.

**Acceptance Criteria:**

**Given** module `ai` là nơi duy nhất gọi `adapters/openai`
**When** một tính năng gọi gateway với `feature` (enum `AiFeature`)
**Then** gateway giữ chỗ chi phí ước tính bằng `UPDATE ai_budget_months … WHERE spent + reserved + est <= limit`, gọi OpenAI với `store: false`, rồi trong một transaction ghi `ai_usage` (`cost_vnd`, `usd_micros`, token, số ảnh, `page_id`) và chuyển ước tính thành chi phí thật

**Given** chi tiêu tháng (giờ VN) vượt 80% lần đầu
**When** lời gọi hoàn tất
**Then** cờ `alerted_80` lật đúng một lần kể cả khi api và worker gọi song song, phát `ai_budget.threshold_reached` → toast + chip vàng ở sidebar

**Given** chi tiêu chạm 100% hoặc hạn mức = 0
**When** có lời gọi mới
**Then** gateway trả `AI_BUDGET_EXCEEDED` không gọi OpenAI; banner đỏ "Đã dùng hết hạn mức AI tháng này — Tăng hạn mức" hiện toàn app (NFR6)

**Given** chủ shop tăng hạn mức giữa tháng
**When** lưu
**Then** `settings.updated` → `ai` tính lại cờ, phát `ai_budget.restored`, banner biến mất

**Given** OpenAI trả 401 trong lúc chạy
**When** gateway nhận lỗi
**Then** `secrets.status=invalid`, phát `openai_key.invalidated`, các lời gọi sau trả `OPENAI_KEY_INVALID` mà không gọi ra ngoài; lỗi khác phân loại `PROVIDER_QUOTA` / `RATE_LIMITED` / `CONTENT_REJECTED` / `TRANSIENT`

**Given** Cài đặt › OpenAI
**When** mở bảng chi phí
**Then** thấy tổng tháng, % hạn mức, và chi phí + số lượng theo hạng mục "Trả lời tin nhắn / Sinh bài viết / Sinh ảnh" gộp từ `AiFeature`

## Epic 2: Kết nối trang và gom nhóm

Chủ shop kết nối Fanpage, Instagram Business, Threads thật, theo dõi hạn token và kết nối lại; tạo nhóm, gán trang, và Bộ chọn phạm vi lọc dữ liệu thật.

### Story 2.1: Meta client và Meta Test App cho môi trường dev

As a chủ shop,
I want app nói chuyện với Meta qua một cổng duy nhất và có môi trường thử riêng,
So that thử nghiệm không làm gián đoạn trang thật và lỗi Meta được xử lý nhất quán.

**UX:** nền cho Trang & Nhóm, Hộp thư, Soạn bài. **AD:** AD-6, Structural Seed › Môi trường.

**Acceptance Criteria:**

**Given** `adapters/meta` có client `graph` (pin `META_GRAPH_VERSION=v26.0`) và `threads`
**When** một lời gọi trả lỗi Meta
**Then** adapter trả lỗi đã phân loại (`TOKEN_INVALID`, `RATE_LIMITED`, `PERMISSION_DENIED`, `OUTSIDE_WINDOW`, `RECIPIENT_UNAVAILABLE`, `TRANSIENT`, `REJECTED`) theo bảng trong `errors.ts`, xét subcode trước mã chính; có unit test cho từng dòng của bảng

**Given** mỗi lời gọi khai báo hạng `interactive|publish|background`
**When** header `X-Business-Use-Case-Usage`/`X-App-Usage` cho thấy usage ≥75% (background) hoặc ≥90% (publish)
**Then** adapter ghi `meta_rate_state` và từ chối lời gọi hạng đó tới `blocked_until` với `RATE_LIMITED`; hạng `interactive` vẫn đi

**Given** adapter có `normalize.ts`
**When** chuẩn hoá id bài từ phản hồi đăng hoặc từ webhook
**Then** trả cùng dạng `PublishedRef`/`platformPostId` (FB `{pageId}_{postId}`, IG media id, Threads media id)

**Given** `deploy/runbook.md`
**When** dev làm theo hướng dẫn
**Then** tạo được Meta Test App và Threads test app riêng, có callback trỏ về tunnel local; runbook ghi rõ không bao giờ đổi callback của app production
**And** `adapters/meta/fake.ts` cho phép test các module khác không cần Meta thật

### Story 2.2: Kết nối Facebook Fanpage và Instagram Business

As a chủ shop,
I want kết nối Fanpage và tài khoản Instagram Business đã liên kết chỉ trong một cửa sổ Meta,
So that app quản lý được các trang của tôi.

**UX:** Trang & Nhóm › "+ Kết nối tài khoản"; Màn chào bước 1; F1 b1, F7 b2, F7 Thất bại; State "Kết nối bị huỷ / thiếu quyền". **AD:** AD-5, AD-23, AD-12.

**Acceptance Criteria:**

**Given** chủ shop bấm "Kết nối Facebook"
**When** hoàn tất cửa sổ Meta (Facebook Login for Business)
**Then** callback kiểm `state` gắn session, đổi token dài hạn, lưu danh sách ứng viên (Fanpage, IG liên kết, quyền đã cấp/thiếu theo `granular_scopes`) vào `oauth_results` rồi chuyển FE tới bước chọn trang

**Given** bước chọn trang
**When** chủ shop chọn Fanpage "Mỹ phẩm Lan Anh" và IG "lananh.beauty" rồi xác nhận
**Then** `POST /api/v1/connections/confirm` dùng `pages.upsertFromPlatform` tạo trang (khoá `UNIQUE(platform, platform_account_id)`), lưu token Page mã hoá; trang IG có `token_source_page_id` trỏ Fanpage, không giữ token riêng
**And** bảng Trang & Nhóm hiện hai trang mới với chip "Đang hoạt động"

**Given** chủ shop huỷ cửa sổ Meta hoặc bỏ quyền tin nhắn
**When** callback trả về
**Then** FE hiện modal "Chưa cấp đủ quyền quản lý tin nhắn" với danh sách quyền thiếu (`PERMISSIONS_MISSING`) và nút "Thử lại"; huỷ hẳn → `OAUTH_CANCELLED`

**Given** tài khoản IG là tài khoản cá nhân hoặc chưa liên kết Fanpage
**When** xuất hiện trong ứng viên
**Then** không chọn được, hiện "Chỉ hỗ trợ tài khoản Instagram Business đã liên kết Fanpage" (`IG_NOT_BUSINESS`)

### Story 2.3: Kết nối Threads

As a chủ shop,
I want kết nối tài khoản Threads của shop,
So that tôi quản lý Threads cùng chỗ với Facebook và Instagram.

**UX:** Trang & Nhóm › "+ Kết nối tài khoản" › Threads; F1 b1. **AD:** AD-5, AD-23.

**Acceptance Criteria:**

**Given** chủ shop chọn kết nối Threads
**When** hoàn tất OAuth Threads
**Then** server đổi token ngắn hạn sang dài hạn (60 ngày) bằng Threads app secret, lưu mã hoá kèm `expires_at`, tạo/khôi phục trang `platform=threads` qua `upsertFromPlatform`

**Given** trang Threads đã kết nối
**When** xem ở Trang & Nhóm và Cài đặt › Tài khoản Meta
**Then** Threads hiện là tài khoản OAuth riêng, không gộp vào tài khoản Facebook

**Given** thiếu quyền Threads bắt buộc (đăng bài, đọc/quản lý trả lời, insight)
**When** callback trả về
**Then** hiện modal quyền thiếu như Story 2.2

### Story 2.4: Theo dõi hạn token và Kết nối lại

As a chủ shop,
I want biết trước khi token sắp hết hạn và kết nối lại đúng trang đó,
So that hộp thư và lịch đăng không bị đứt.

**UX:** F7 b7; State "Token sắp hết hạn (≤7 ngày)", "Mất kết nối"; Trang & Nhóm, Tổng quan, Cài đặt › Tài khoản Meta; UX-DR3. **AD:** AD-5, AD-3.

**Acceptance Criteria:**

**Given** cron hằng ngày (giờ VN)
**When** chạy
**Then** token Threads còn ≤15 ngày và đã ≥24 giờ tuổi được làm mới; trạng thái mọi trang được tính lại (`expires_at=0` là không hết hạn; mốc sớm nhất giữa `expires_at` và `data_access_expires_at`), lưu qua `pages.setConnectionStatus`; trang chuyển sang `expiring` phát `page.expiring` một lần mỗi chu kỳ

**Given** một lời gọi Meta bất kỳ nhận `TOKEN_INVALID`
**When** adapter trả lỗi
**Then** `connections.markDisconnected` chuyển trang (và mọi trang IG cùng nguồn token) sang `disconnected` với lý do, phát `page.disconnected` cho từng trang

**Given** trang `expiring` hoặc `disconnected`
**When** hiển thị ở Trang & Nhóm, Tổng quan, Cài đặt
**Then** chip vàng "Token sắp hết hạn" / chip đỏ "Mất kết nối" có chữ, kèm "Kết nối lại"

**Given** chủ shop bấm "Kết nối lại" trên một trang
**When** OAuth với `intent=reconnect:<pageId>` và `auth_type=reauthorize` hoàn tất
**Then** cập nhật token của đúng dòng trang đó (giữ nhóm, cấu hình, lịch sử), trạng thái về `active` chỉ khi đủ quyền bắt buộc, phát `page.reconnected`

### Story 2.5: Nhóm và gán trang

As a chủ shop,
I want gom các trang cùng chủ đề vào một nhóm có tên và màu,
So that tôi dùng chung cấu hình và lọc dữ liệu theo nhóm.

**UX:** Trang & Nhóm (thẻ nhóm, bảng trang, thanh thao tác chọn nhiều); Chi tiết nhóm › Trang thành viên; F1 b2, F1 Thất bại; Component "Bảng trang". **AD:** AD-8 (thành viên nhóm), AD-23.

**Acceptance Criteria:**

**Given** chủ shop chọn 3 trang trong bảng
**When** bấm "Thêm vào nhóm" → "Tạo nhóm mới" với tên "Nhóm Mỹ phẩm" và một màu trong bảng 8 màu (`group-1…8`)
**Then** nhóm được tạo và 3 trang được gán qua `pages.assignGroup`, mỗi lần gán phát `page.group_changed` trong cùng transaction

**Given** một trang đang ở "Nhóm Gia dụng"
**When** chủ shop gán nó vào "Nhóm Mỹ phẩm"
**Then** API trả trước danh sách ảnh hưởng (nhóm cũ; chiến dịch đang chạy dùng trang này qua read-model, rỗng nếu chưa có) để FE hiện modal "Trang này sẽ chuyển khỏi Nhóm Gia dụng…"; chỉ khi xác nhận mới đổi (mỗi trang tối đa một nhóm)

**Given** chủ shop sửa tên/màu hoặc xoá nhóm
**When** xoá được xác nhận
**Then** `pages.deleteGroup` gỡ nhóm khỏi mọi trang và phát `group.deleted {groupId, memberPageIds}`

**Given** chưa có nhóm nào
**When** mở Trang & Nhóm
**Then** hiện "Chưa có nhóm nào. Gom các trang cùng chủ đề để dùng chung cấu hình."

### Story 2.6: Bộ chọn phạm vi lọc dữ liệu thật

As a chủ shop,
I want chọn Tất cả trang, một nhóm, hoặc một trang và mọi màn dữ liệu lọc theo,
So that tôi tập trung vào đúng phần việc đang xem.

**UX:** Mô hình khái niệm › Phạm vi; Component "Bộ chọn phạm vi". **AD:** AD-18.

**Acceptance Criteria:**

**Given** `pages.resolveScope(scope)` là helper duy nhất
**When** endpoint danh sách nhận `scope=all|group:<id>|page:<id>`
**Then** trả tập `pageId` tương ứng; thực thể nhiều trang thuộc phạm vi khi tập trang của nó giao tập phạm vi khác rỗng

**Given** Bộ chọn phạm vi ở thanh trên
**When** chủ shop gõ "my pham"
**Then** danh sách trang/nhóm lấy từ API, tìm được cả khi gõ không dấu; lựa chọn được nhớ ở localStorage của trình duyệt

**Given** các màn Soạn bài AI, Trang & Nhóm, AI trả lời tự động, Cài đặt
**When** đổi phạm vi
**Then** các màn này không bị lọc (đúng quy định của EXPERIENCE.md)

### Story 2.7: Gỡ trang khỏi app

As a chủ shop,
I want gỡ một trang không còn quản lý,
So that nó không còn nhận tin hay đăng bài, nhưng lịch sử vẫn còn để tra.

**UX:** [ASSUMPTION] hành động "Gỡ trang" ở Cài đặt › Tài khoản Meta (EXPERIENCE.md chưa mô tả). **AD:** AD-23, AD-3.

**Acceptance Criteria:**

**Given** chủ shop xác nhận gỡ trang
**When** API xử lý
**Then** trang được soft-delete (`removed_at`), token bị xoá, phát `page.removed`; trang biến khỏi Bộ chọn phạm vi và bảng trang

**Given** trang đã gỡ được kết nối lại sau đó
**When** confirm OAuth chạy
**Then** `upsertFromPlatform` khôi phục đúng dòng cũ (xoá `removed_at`), giữ lịch sử

## Epic 3: Hồ sơ thương hiệu dùng chung theo nhóm

Chủ shop soạn hồ sơ thương hiệu cho nhóm hoặc trang, thấy nguồn kế thừa, ghi đè riêng từng trang, đổi nhóm mà không mất cấu hình, và cho AI viết thử đúng giọng.

### Story 3.1: Soạn và lưu hồ sơ thương hiệu

As a chủ shop,
I want điền giọng điệu, sản phẩm chủ lực, từ cấm… cho một nhóm hoặc một trang,
So that AI viết đúng chất shop của tôi.

**UX:** Chi tiết nhóm › Hồ sơ thương hiệu, Chi tiết trang › Hồ sơ thương hiệu; F1 b3. **AD:** AD-8, AD-14, AD-18.

**Acceptance Criteria:**

**Given** form hồ sơ (tên, slogan, ngành, giọng điệu ≤3, độ trang trọng, xưng hô, emoji, sản phẩm + giá, khách mục tiêu, màu ≤6, hashtag, từ cấm, logo, domain cho phép)
**When** bấm "Lưu hồ sơ"
**Then** `brand_profiles` lưu theo `(owner_type, owner_id)`; tên bắt buộc; lỗi validate hiện dưới ô

**Given** chủ shop tải logo PNG/JPEG/WebP ≤2 MB
**When** tải lên
**Then** file đi qua kiểm magic bytes, bỏ EXIF, lưu qua `MediaStore` công khai (`/media/<uuidv7>.<ext>`) vào `brand_profiles.logo_path` (không vào `media_assets`); SVG bị từ chối

**Given** rời trang khi chưa lưu
**When** điều hướng
**Then** FE hỏi lại (Interaction Primitives)

### Story 3.2: Kế thừa hồ sơ và "Dùng hồ sơ riêng"

As a chủ shop,
I want các trang trong nhóm dùng chung hồ sơ nhóm, và bật hồ sơ riêng cho trang cần giọng khác,
So that tôi soạn một lần cho cả nhóm mà vẫn tuỳ biến được từng trang.

**UX:** F1 b5, F1 Thất bại (tắt "Dùng hồ sơ riêng" hỏi lại); Kế thừa cấu hình; Component "Nhãn kế thừa". **AD:** AD-8.

**Acceptance Criteria:**

**Given** `profiles.resolveEffective(pageId, 'brand')` là hàm duy nhất giải kế thừa
**When** trang thuộc nhóm có hồ sơ và `use_own_brand=false`
**Then** trả hồ sơ nhóm kèm `source {ownerType: group, name}` và FE hiện "Đang dùng hồ sơ của Nhóm Mỹ phẩm"

**Given** trang Threads trong nhóm
**When** chủ shop bật "Dùng hồ sơ riêng" rồi bấm "Lưu"
**Then** hồ sơ nhóm được sao chép làm điểm xuất phát, `use_own_brand=true`; bật công tắc mà chưa bấm Lưu thì chưa có gì thay đổi phía server

**Given** trang đang dùng hồ sơ riêng
**When** tắt "Dùng hồ sơ riêng", xác nhận và Lưu
**Then** hồ sơ riêng bị xoá, trang quay về hồ sơ nhóm

**Given** trang không thuộc nhóm nào và không có hồ sơ
**When** gọi `resolveEffective`
**Then** trả `CONFIG_MISSING`; FE yêu cầu tạo hồ sơ riêng cho trang

### Story 3.3: Đổi thành viên nhóm mà không mất cấu hình

As a chủ shop,
I want trang giữ nguyên cách AI viết khi tôi chuyển nó khỏi nhóm hoặc xoá nhóm,
So that không có trang nào bỗng dưng mất cấu hình mà tôi không biết.

**UX:** F1 Thất bại (chuyển nhóm); Kế thừa cấu hình. **AD:** AD-8, AD-3.

**Acceptance Criteria:**

**Given** `profiles` nghe `page.group_changed` và `group.deleted`, xử lý chung cho mọi loại cấu hình đã đăng ký (hồ sơ thương hiệu ở story này; cấu hình AI đăng ký ở Epic 5)
**When** một trang rời nhóm (kể cả do xoá nhóm) mà không có cấu hình riêng
**Then** cấu hình nhóm cũ được sao chép thành cấu hình riêng (`use_own_*=true`); cấu hình của nhóm đã xoá bị xoá sau đó

**Given** trang vào một nhóm đã có cấu hình loại đó
**When** sự kiện được xử lý
**Then** cấu hình riêng của trang bị xoá, `use_own_*=false`

**Given** trang vào một nhóm chưa có cấu hình loại đó
**When** sự kiện được xử lý
**Then** trang giữ cấu hình riêng, đánh dấu `awaiting_group_default`; khi cấu hình nhóm loại đó được lưu lần đầu, các trang đánh dấu chuyển về "Theo nhóm"
**And** handler idempotent khi sự kiện tới hai lần

### Story 3.4: Viết thử bằng AI theo hồ sơ

As a chủ shop,
I want bấm "Viết thử bằng AI" và thấy một caption đúng giọng shop,
So that tôi biết hồ sơ đã đủ tốt trước khi dùng thật.

**UX:** F1 b4; Component "Nút AI" ("AI đang viết…" + Dừng); Accessibility Floor ("AI tạo"); UX-DR9, UX-DR10. **AD:** AD-2, AD-7, AD-21.

**Acceptance Criteria:**

**Given** hồ sơ đang soạn (kể cả chưa lưu)
**When** bấm "Viết thử bằng AI"
**Then** api gọi gateway (`feature=brand_sample`) với mẫu prompt caption ở `modules/ai/prompts/`, trả JSON một lần; FE hiện "AI đang viết…" có nút Dừng

**Given** đang chờ kết quả
**When** bấm Dừng
**Then** request bị huỷ, server truyền `AbortSignal` sang OpenAI, không ghi chi phí cho phần chưa chạy

**Given** kết quả AI chứa từ cấm của hồ sơ (so khớp không phân biệt hoa thường, chuẩn hoá dấu) hoặc URL ngoài domain cho phép
**When** `ai.checkOutput` kiểm
**Then** sinh lại một lần; vẫn vi phạm thì trả kết quả kèm danh sách cụm vi phạm để FE đánh dấu; xem trước hiện "Đã tránh N từ cấm" khi sạch

**Given** hết hạn mức hoặc thiếu khoá
**When** bấm nút
**Then** nút bị khoá theo mã lỗi từ server (UX-DR2), vẫn sửa tay được

## Epic 4: Hộp thư hợp nhất và Khách hàng

Tin nhắn Messenger, IG Direct, bình luận và trả lời Threads về một Hộp thư realtime; chủ shop tiếp quản, trả lời đúng luật 24 giờ, dùng gợi ý AI, quản lý khách và tìm nhanh bằng ⌘K.

### Story 4.1: Cổng nhận webhook Meta và Threads

As a chủ shop,
I want app nhận an toàn mọi sự kiện Meta gửi tới và cho tôi xem nhật ký,
So that không tin nào bị mất hay bị giả mạo.

**UX:** Cài đặt › Webhook (URL nhận tin, verify token, nhật ký sự kiện, "Gửi sự kiện thử"); F7 b4. **AD:** AD-4, AD-12, AD-24.

**Acceptance Criteria:**

**Given** `POST /webhooks/meta` và `POST /webhooks/threads`
**When** Meta gửi sự kiện có `X-Hub-Signature-256`
**Then** server xác minh HMAC-SHA256 trên raw body với app secret đúng app (constant-time); sai → 401 và không ghi gì
**And** body được tách thành từng mục (parser riêng cho payload Threads), mỗi mục một dòng `webhook_events` với khoá chống trùng của mục, mỗi mục một job `webhook.route`; trả 200 trong ≤1 giây p95 (NFR2)

**Given** Meta gửi lại cùng mục với cách gom khác
**When** ghi `webhook_events`
**Then** khoá chống trùng của mục chặn bản thứ hai

**Given** `GET` xác minh với `hub.verify_token` đúng
**When** Meta gọi
**Then** trả `hub.challenge`

**Given** Cài đặt › Webhook
**When** mở
**Then** thấy hai callback URL (`/webhooks/meta`, `/webhooks/threads`) có nút sao chép, verify token đầy đủ, nhật ký gồm thời gian, trang, field, `status` (`received|routed|ignored|failed`) và lỗi; mục `failed` có "Xử lý lại"; "Gửi sự kiện thử" tạo sự kiện cờ `test` chỉ ghi nhật ký

**Given** story webhook Threads chạy với Threads test app
**When** nhận sự kiện thật
**Then** ghi lại secret nào ký chữ ký (xác nhận [ASSUMPTION] của AD-4) vào runbook

### Story 4.2: Tự đăng ký webhook trang và theo dõi sức khoẻ webhook

As a chủ shop,
I want app tự đăng ký nhận tin cho trang vừa kết nối và báo khi webhook im lặng bất thường,
So that tôi không phải vào Meta cấu hình tay và biết ngay khi tin không về.

**UX:** F7 b4, F7 b6 ("Đang chờ tin đầu tiên" → "Nhận tin gần nhất: vừa xong"); State "Webhook ngừng nhận tin"; UX-DR7. **AD:** AD-4, AD-5, AD-24.

**Acceptance Criteria:**

**Given** story này thêm việc enqueue `connections.subscribe_page` vào confirm và kết nối lại của Epic 2, và chạy một lần cho các trang đã kết nối trước đó
**When** job chạy
**Then** gọi `subscribed_apps` với field tối thiểu (Page: `messages`, `messaging_postbacks`, `message_echoes`, `feed`; IG: `messages`, `comments`); Threads `replies` theo cấu hình app; lỗi quyền hiện ở trang đó

**Given** cron 5 phút tính `webhook_health` cho `meta` và `threads`
**When** chưa từng nhận sự kiện
**Then** trạng thái `waiting_first`, Cài đặt hiện "Đang chờ tin đầu tiên"; có sự kiện → `ok` và "Nhận tin gần nhất: …"

**Given** sản phẩm có trang `active` và không có sự kiện >30 phút trong khung 08:00–22:00 giờ VN [ASSUMPTION]
**When** cron chạy
**Then** chuyển `stalled`, phát `webhook.stalled`; Hộp thư hiện banner vàng "Chưa nhận tin mới 30 phút — Kiểm tra webhook" dẫn tới Cài đặt › Webhook; có sự kiện lại → `webhook.recovered`, banner biến mất

### Story 4.3: Tin Messenger và Instagram Direct vào Hộp thư

As a chủ shop,
I want tin nhắn khách gửi Fanpage và Instagram hiện ngay trong một Hộp thư,
So that tôi không phải mở từng ứng dụng.

**UX:** Hộp thư (danh sách, chat, panel khách); F2 b1; State "Mất kết nối thời gian thực". **AD:** AD-9, AD-11, AD-3, AD-14.

**Acceptance Criteria:**

**Given** `webhook.route` nhận tin `messaging` từ khách
**When** gọi `inbox.ingest`
**Then** tạo/lấy `contact_identities(page_id, PSID|IGSID)` → `contact`, hội thoại theo `(page_id, 'dm', thread_key)`, upsert tin theo `(page_id, platform_message_id)`; `last_customer_message_at` chỉ tăng; thứ tự hiển thị theo `platform_timestamp`
**And** đính kèm (ảnh, voice…) được tải về `PrivateFileStore` và lưu ở `message_attachments` của `inbox`

**Given** hội thoại mới hoặc đang `done`
**When** có tin khách
**Then** hội thoại vào `triage` và `autoreply.triage` chạy ngay; khi chưa có cấu hình AI (trước Epic 5) nó chuyển `human` với lý do `AI_OFF`
**And** phát `message.received` (chỉ cho tin inbound) và `conversation.state_changed`

**Given** Hộp thư đang mở
**When** tin mới tới
**Then** danh sách và khung chat cập nhật trong ≤3 giây qua SSE + refetch; mất kết nối → "Đang kết nối lại…" và tải bù khi có lại (FR17)

**Given** webhook cho trang không có trong DB hoặc đã gỡ
**When** route
**Then** chỉ lưu `webhook_events` (`ignored`), không tạo hội thoại

### Story 4.4: Bình luận Facebook/Instagram và trả lời Threads vào Hộp thư

As a chủ shop,
I want bình luận dưới bài và trả lời trên Threads cũng vào Hộp thư,
So that tôi trả lời khách công khai mà không bỏ sót.

**UX:** Hộp thư; Mô hình khái niệm › Giới hạn nền tảng (Threads chỉ trả lời/bình luận). **AD:** AD-4, AD-11, AD-6.

**Acceptance Criteria:**

**Given** sự kiện `feed` (comment add) hoặc IG `comments` hoặc Threads `replies`
**When** route
**Then** hội thoại `channel=comment` theo `thread_key` = id bình luận gốc (Threads: id bài trả lời gốc), lưu `platform_post_id` dạng chuẩn của bài được bình luận

**Given** bình luận bị sửa hoặc xoá/ẩn
**When** route
**Then** `inbox.updateMessageText` / `inbox.markMessageRemoved` cập nhật tin, không tạo tin mới

**Given** sự kiện reaction, postback, loại khác
**When** route
**Then** chỉ lưu `webhook_events` với `status=ignored`

### Story 4.5: Nhận diện tin của chính trang (echo)

As a chủ shop,
I want tin do app gửi không hiện hai lần, và khi tôi trả lời từ điện thoại thì AI tự lùi lại,
So that hội thoại sạch và AI không chen ngang tôi.

**UX:** Hộp thư; Component "Hội thoại" (Tiếp quản). **AD:** AD-20, AD-9.

**Acceptance Criteria:**

**Given** `inbox.ingest` nhận tin/bình luận có tác giả là chính trang (`is_echo`, `from.id` của trang, username Threads của trang)
**When** khớp `metadata` = `messages.id`, hoặc `app_id` của app, hoặc tin `pending|sending` cùng hội thoại cùng nội dung trong 120 giây
**Then** gắn `platform_message_id`, `status=sent`, không tạo tin mới, không phát `message.received`

**Given** echo tới trước khi job gửi lưu xong id
**When** chưa khớp được
**Then** thử lại sau 5 giây, tối đa 3 lần, rồi chèn `origin=app_unmatched` không đổi trạng thái

**Given** chủ shop trả lời từ Meta Business Suite hoặc app Facebook
**When** echo không phải của app
**Then** chèn `origin=external_human`, hội thoại chuyển `human`, `ai_enabled=false`, lý do `HUMAN_REPLIED`

### Story 4.6: Tab Hộp thư, Tiếp quản và Đánh dấu xong

As a chủ shop,
I want thấy ngay hội thoại nào cần tôi, tiếp quản hoặc đánh dấu xong,
So that không khách nào bị bỏ quên.

**UX:** Hộp thư (Tất cả · Cần xử lý · AI đang trả lời · Đã xong; badge sidebar); F2 b4; State "AI chuyển cho người" (lý do, đếm thời gian chờ); Interaction Primitives (`↑/↓`, `T`); UX-DR5. **AD:** AD-9, AD-18.

**Acceptance Criteria:**

**Given** API danh sách hội thoại nhận `tab` và `scope`
**When** `tab=needs_human`
**Then** trả hội thoại `handoff`, hoặc `human` mà tin không phải `system` mới nhất là của khách, sắp theo `waiting_since`; `triage` chỉ có ở "Tất cả"; badge sidebar dùng đúng điều kiện này

**Given** hội thoại `ai` hoặc `handoff`
**When** chủ shop bấm "Tiếp quản" (hoặc phím `T`)
**Then** `inbox` chuyển `human`, `ai_enabled=false`, tăng `state_version`, ghi tin `system`, huỷ tin AI `pending` chưa gửi

**Given** hội thoại `human`
**When** bật lại công tắc "AI tự trả lời"
**Then** chuyển `ai`, `ai_enabled=true`

**Given** mọi trạng thái trừ `done`
**When** "Đánh dấu xong"
**Then** chuyển `done`, `ai_enabled=true`, xoá `waiting_since`

**Given** hội thoại `handoff`
**When** hiển thị
**Then** ghi chú hệ thống nêu lý do theo `HandoffReason` ánh xạ sang microcopy (UX-DR5) và thời gian chờ tính từ `waiting_since`

### Story 4.7: Gửi tin từ Hộp thư đúng luật 24 giờ

As a chủ shop,
I want gửi tin và biết rõ vì sao một tin không gửi được,
So that tôi không mất tin và biết cách xử lý tiếp.

**UX:** F2 b4, F2 Thất bại; State "Gửi tin lỗi"; Interaction Primitives (`⌘↵`); UX-DR6. **AD:** AD-10, AD-20, AD-24, AD-6.

**Acceptance Criteria:**

**Given** chủ shop gửi tin trong hội thoại DM
**When** `inbox.canSend(conversationId, 'dm')` cho phép (≤24 giờ từ tin cuối của khách)
**Then** tin outbound `origin=app_human`, `status=pending` được lưu và job `inbox.send` enqueue cùng transaction; job gửi kèm `metadata = messages.id`, lưu `platform_message_id`, `status=sent`, phát `message.sent`
**And** người dùng gửi tin ở `ai|handoff|triage` → hội thoại chuyển `human` (`HUMAN_REPLIED`)

**Given** đã quá 24 giờ
**When** bấm gửi
**Then** API từ chối sớm `OUTSIDE_24H`; tin vẫn được lưu `failed` và bong bóng hiện icon đỏ + "Quá 24 giờ kể từ tin cuối của khách — Meta không cho gửi tin thường", gợi ý trả lời qua bình luận hoặc gọi điện

**Given** gửi lỗi ở Meta
**When** job hết retry hoặc lỗi không retry
**Then** tin `failed` với mã (`RATE_LIMITED` → "Gửi quá nhanh, thử lại sau ít phút", `PAGE_DISCONNECTED` → "Trang mất kết nối", `RECIPIENT_UNAVAILABLE`, `SEND_REJECTED`, `SEND_FAILED`); "Gửi lại" đặt `status=pending` rồi tạo job mới cho cùng tin; `RATE_LIMITED` hoãn tới `blocked_until`, không tính vào số lần retry; lỗi retry được trả tin về `pending` để lần sau chiếm lại; tin kẹt `sending` quá 15 phút → `failed` `SEND_UNKNOWN`

**Given** hội thoại bình luận
**When** chủ shop chọn "Trả lời công khai" hoặc "Nhắn riêng"
**Then** `public_reply` luôn được (trừ bình luận đã xoá); `private_reply` chỉ một lần mỗi bình luận trong 7 ngày (FB/IG), lần hai → `PRIVATE_REPLY_USED`; tin nhắn riêng lưu trong hội thoại `comment` với `delivery=private_reply`, `recipient_id` Meta trả về gắn vào cùng contact
**And** Threads chỉ có "Trả lời công khai"

### Story 4.8: Gợi ý bằng AI khi trả lời

As a chủ shop,
I want bấm "Gợi ý bằng AI" để có bản nháp trả lời theo giọng shop,
So that tôi trả lời nhanh hơn rồi sửa trước khi gửi.

**UX:** F2 b4; Component "Nút AI"; UX-DR9. **AD:** AD-2, AD-7, AD-8, AD-21.

**Acceptance Criteria:**

**Given** hội thoại đang mở
**When** bấm "Gợi ý bằng AI"
**Then** api gọi gateway (`feature=inbox_suggest`) với hồ sơ hiệu lực của trang (`resolveEffective`) và các tin gần nhất; bản nháp điền vào ô soạn, không tự gửi; có nút Dừng

**Given** bản nháp vi phạm `ai.checkOutput`
**When** trả về
**Then** cụm vi phạm được đánh dấu để chủ shop sửa

**Given** thiếu khoá hoặc hết hạn mức
**When** hiển thị nút
**Then** nút khoá theo mã lỗi; vẫn gõ tay và gửi được

### Story 4.9: Khách hàng: danh sách, thẻ, giai đoạn, lịch sử

As a chủ shop,
I want xem và cập nhật thông tin từng khách trên mọi trang,
So that tôi chăm khách tốt hơn và không hỏi lại điều đã biết.

**UX:** Khách hàng `/khach-hang`; panel khách trong Hộp thư; F2 b5. **AD:** AD-11, AD-18, AD-7.

**Acceptance Criteria:**

**Given** danh sách Khách hàng theo `scope`
**When** lọc theo thẻ "Khiếu nại" hoặc giai đoạn
**Then** trả khách có định danh giao phạm vi; `pageIds`, `handledBy` là dẫn xuất từ read-model

**Given** panel khách trong Hộp thư
**When** gắn thẻ "Đổi trả" và đổi giai đoạn sang "Khách quen"
**Then** lưu `tags`, `stage` (`ContactStage`, FE hiện nhãn tiếng Việt), ghi chú, số điện thoại

**Given** khách có hội thoại trên nhiều trang
**When** mở chi tiết khách
**Then** thấy lịch sử nhắn tin của mọi hội thoại của khách đó, mỗi đoạn ghi rõ trang

**Given** hai khách thực ra là một người
**When** chủ shop chọn "Gộp khách"
**Then** `inbox.mergeContacts` chuyển mọi định danh, hội thoại, thẻ sang một khách

**Given** chủ shop bấm "Tóm tắt bằng AI"
**When** job chạy (`feature=contact_summary`)
**Then** `aiSummary` được cập nhật, đánh dấu "AI tạo"

### Story 4.10: Tìm nhanh bằng ⌘K

As a chủ shop,
I want gõ ⌘K để tìm trang, nhóm, khách kể cả khi gõ không dấu,
So that tôi tới đúng chỗ trong vài phím.

**UX:** Interaction Primitives › `⌘K`/`Ctrl+K`. **AD:** AD-18.

**Acceptance Criteria:**

**Given** extension `unaccent` và `pg_trgm` được bật cho cột tên trang, tên nhóm, tên và SĐT khách
**When** gọi `/api/v1/search?q=nguyen thu ha`
**Then** trả kết quả gộp từ `pages.search` và `inbox.searchContacts`, khớp "Nguyễn Thu Hà"

**Given** bảng lệnh ⌘K
**When** chọn một kết quả
**Then** mở đúng trang/nhóm/khách; các lệnh "Tạo bài viết", "Đổi phạm vi" là lệnh phía FE

## Epic 5: AI trả lời tự động

Chủ shop cấu hình AI theo nhóm/trang (kịch bản, kho kiến thức, quy tắc chuyển người, giờ hoạt động, kênh), thử trước, rồi để AI tự trả lời tin nhắn và bình luận, tự chuyển cho người khi cần; Màn chào 4 bước chạy trọn.

### Story 5.1: Cấu hình AI trả lời theo nhóm và trang

As a chủ shop,
I want thiết lập AI cho cả nhóm và ghi đè riêng một trang,
So that cấu hình một lần mà vẫn tuỳ chỉnh được nơi cần.

**UX:** AI trả lời tự động `/ai-tra-loi` (cây nhóm/trang, nhãn "Bật"/"Theo nhóm"); Chi tiết trang/nhóm › AI trả lời; F6 b1, b2, b4, b5, b7, F6 Thất bại; mục "Cấu hình AI trả lời tự động"; Component "Bảng trang" (Bật/Tắt AI trả lời). **AD:** AD-8, AD-16, AD-2.

**Acceptance Criteria:**

**Given** `autoreply_configs` theo `(owner_type, owner_id)` được đăng ký là một loại cấu hình của `profiles` (dùng chung luật kế thừa và xử lý đổi nhóm của Story 3.2, 3.3)
**When** chủ shop chọn "Nhóm Gia dụng" và lưu cấu hình (bật/tắt, giờ hoạt động `always|offhours|custom` với 7 khung ngày, kịch bản, từ khoá chuyển người, "khách yêu cầu gặp người", "AI không chắc chắn", `handoffMessage`, kênh `AutoreplyChannel`)
**Then** cây bên trái hiện "Bật" cho nhóm và các trang con hiện "Theo nhóm"

**Given** bấm "Lấy từ Hồ sơ thương hiệu" hoặc chọn "Mẫu theo ngành"
**When** server dựng kịch bản
**Then** dùng template xác định từ hồ sơ hiệu lực, không gọi AI

**Given** kịch bản trống hoặc không có kênh nào
**When** bật công tắc AI
**Then** API từ chối, FE báo dưới ô; chưa có khoá OpenAI → công tắc khoá kèm banner "Thêm khoá OpenAI ở Cài đặt"

**Given** trang minhphat.store đang theo nhóm
**When** bật "Dùng cấu hình AI riêng", tắt kênh bình luận và Lưu
**Then** cấu hình nhóm được sao chép làm điểm xuất phát rồi ghi đè

**Given** chọn nhiều trang ở bảng Trang & Nhóm
**When** "Bật/Tắt AI trả lời" hàng loạt trên trang đang theo nhóm
**Then** FE xác nhận; server bật "Dùng cấu hình AI riêng" (sao chép) rồi đổi `enabled` cho từng trang; `Page.autoReply` là dẫn xuất

### Story 5.2: Kho kiến thức

As a chủ shop,
I want tải bảng giá, chính sách và thêm câu hỏi thường gặp,
So that AI trả lời đúng thông tin shop.

**UX:** F6 b3; mục "Cấu hình AI trả lời tự động" › Kho kiến thức. **AD:** AD-14, AD-16, AD-24.

**Acceptance Criteria:**

**Given** chủ shop tải "Bảng giá.pdf" (pdf, docx, txt; kiểm magic bytes; giới hạn kích thước)
**When** tải lên
**Then** file lưu `PrivateFileStore` (không có URL công khai), tạo `knowledge_items(status=processing)` và job `profiles.knowledge.extract`

**Given** job trích văn bản chạy trong worker có timeout
**When** xong
**Then** `status=ready` kèm số token ước tính, hoặc `failed` kèm lý do; phát `knowledge_item.processed`, FE cập nhật dòng

**Given** chủ shop thêm FAQ "Phí giao hàng?" kèm câu trả lời
**When** lưu
**Then** FAQ là một `knowledge_item` loại `faq`, `ready` ngay

**Given** tổng văn bản `ready` + FAQ vượt 40k token [ASSUMPTION]
**When** lưu cấu hình ở trạng thái bật
**Then** trả `KNOWLEDGE_TOO_LARGE`, FE báo cần rút gọn kho kiến thức

### Story 5.3: Thử AI trước khi bật

As a chủ shop,
I want gõ thử câu hỏi của khách và xem AI trả lời hay chuyển cho tôi,
So that tôi tin cấu hình đúng trước khi để AI trả lời khách thật.

**UX:** F6 b6 (khung "Thử AI", ghi chú "AI sẽ chuyển cho bạn"). **AD:** AD-16, AD-7, AD-21.

**Acceptance Criteria:**

**Given** cấu hình nháp (chưa lưu) trong màn AI trả lời
**When** gõ "Nồi chiên bảo hành bao lâu?"
**Then** server chạy đúng hàm quyết định của pipeline (luật từ khoá → LLM → `checkOutput`) với cấu hình nháp, bỏ qua cổng giờ và `canSend`, không gửi gì ra Meta, ghi `ai_usage` `feature=autoreply_test`; trả lời dựa trên kho kiến thức

**Given** gõ "muốn đổi trả"
**When** khớp từ khoá chuyển người
**Then** kết quả hiện câu chuyển tiếp (`handoffMessage`) và ghi chú "AI sẽ chuyển cho bạn" kèm lý do

### Story 5.4: AI tự trả lời tin nhắn và chuyển cho bạn

As a chủ shop,
I want AI trả lời khách trong vài giây và chuyển cho tôi khi gặp chuyện cần người,
So that khách được phục vụ cả khi tôi đang bận.

**UX:** F2 b1–b4; State "AI đang trả lời" (chip tím, chấm đang gõ), "AI chuyển cho người"; UX-DR4, UX-DR5. **AD:** AD-9, AD-16, AD-20, AD-21, AD-24, AD-7.

**Acceptance Criteria:**

**Given** tin khách vào hội thoại `triage`
**When** `autoreply.triage` chạy ngay
**Then** kiểm cổng theo thứ tự AD-16: đóng loại "không áp dụng" → `human` (`AI_OFF`, `CHANNEL_OFF`, `CONFIG_MISSING`); đóng loại "tạm đóng" → `handoff` transient (`OUTSIDE_HOURS`, `OPENAI_KEY_UNAVAILABLE`, `AI_BUDGET_EXCEEDED`); mở → `ai`

**Given** hội thoại `ai`
**When** khách gửi liên tiếp nhiều tin
**Then** `autoreply.run` (queue `stately`, `singletonKey=conversationId`, trễ 4 giây) gộp chúng thành một lượt; không có hai lượt chạy song song cho một hội thoại

**Given** lượt chạy
**When** tin khớp từ khoá "đổi trả" hoặc khách yêu cầu gặp người
**Then** không gọi LLM; gửi `handoffMessage` rồi chuyển `handoff` sticky (`KEYWORD`/`CUSTOMER_ASKED_HUMAN`), ghi tin `system`; Hộp thư hiện ở "Cần xử lý" kèm lý do

**Given** không khớp luật
**When** gọi LLM với structured output `{action, reply, mode, reasonCode, confidence}` qua gateway (`feature=autoreply`)
**Then** `confidence` dưới ngưỡng → `AI_UNCERTAIN`; `reply` qua `checkOutput` (vi phạm sau một lần sinh lại → `AI_POLICY_BLOCKED`); tin không có chữ → `NON_TEXT_MESSAGE`

**Given** người dùng bấm Tiếp quản trong lúc AI đang nghĩ
**When** `inbox.applyAutoreplyDecision` được gọi với `state_version` cũ
**Then** quyết định bị bỏ (`autoreply_runs.outcome=superseded`), không gửi gì

**Given** lượt chạy đang xử lý
**When** hiển thị Hộp thư
**Then** chip tím "AI đang trả lời" và chấm "đang gõ" theo `conversation.ai_typing`; tin AI có nhãn "AI tạo"
**And** p95 từ webhook tới lúc tin AI được gửi ≤15 giây (NFR1), đo bằng log `autoreply_runs`

### Story 5.5: AI trả lời bình luận công khai và nhắn riêng

As a chủ shop,
I want AI trả lời bình luận hỏi giá ngay dưới bài và nhắn riêng chi tiết,
So that khách bình luận cũng được chăm như khách nhắn tin.

**UX:** Cấu hình AI › Kênh áp dụng (trả lời công khai / nhắn riêng); F6 b7 (tắt riêng kênh bình luận). **AD:** AD-16, AD-10, AD-6.

**Acceptance Criteria:**

**Given** kênh `comment_public` bật cho trang
**When** khách bình luận dưới một bài của trang
**Then** caption bài được lấy một lần qua `adapters/meta` khi ingest bình luận và lưu ở hội thoại (`post_text_snapshot`), đưa vào prompt; AI trả lời công khai ngắn (`mode=public_reply`)

**Given** cả `comment_public` và `comment_private` đều bật (FB/IG)
**When** AI quyết định trả lời
**Then** một quyết định có thể gồm trả lời công khai ngắn và nhắn riêng chi tiết; nhắn riêng tuân `canSend(private_reply)`

**Given** trang Threads
**When** có trả lời mới
**Then** AI chỉ trả lời công khai

**Given** kênh bình luận tắt riêng cho trang
**When** có bình luận
**Then** hội thoại về `human` với `CHANNEL_OFF`, không vào "Cần xử lý" vì lý do AI tắt mà chỉ theo luật "tin cuối từ khách"

### Story 5.6: AI dừng và chạy lại đúng lúc khi hết hạn mức hoặc khoá lỗi

As a chủ shop,
I want khi hết hạn mức hay khoá OpenAI lỗi thì tin mới vào thẳng "Cần xử lý", và AI tự chạy lại khi tôi đã khắc phục,
So that không khách nào bị bỏ lơ mà tôi cũng không phải bật lại từng hội thoại.

**UX:** State "Hết hạn mức chi phí AI" (Hộp thư: hội thoại mới vào "Cần xử lý" lý do "Hết hạn mức AI"); F2 Thất bại. **AD:** AD-7, AD-9, AD-16.

**Acceptance Criteria:**

**Given** gateway trả `AI_BUDGET_EXCEEDED`, `OPENAI_KEY_INVALID` hoặc `PROVIDER_QUOTA`
**When** triage hoặc lượt chạy gặp lỗi
**Then** hội thoại vào `handoff` transient với lý do tương ứng (`AI_BUDGET_EXCEEDED`, `OPENAI_KEY_UNAVAILABLE`, `AI_PROVIDER_ERROR`), không gửi câu chuyển tiếp

**Given** chủ shop tăng hạn mức hoặc sửa khoá
**When** khách nhắn tin tiếp trong hội thoại `handoff` transient mà chủ shop chưa trả lời
**Then** hội thoại về `ai` và AI trả lời bình thường

### Story 5.7: Màn chào 4 bước chạy trọn

As a chủ shop mới,
I want được dẫn qua 4 bước kết nối trang, thêm khoá OpenAI, điền hồ sơ, bật AI,
So that tôi có tin đầu tiên được AI trả lời ngay trong buổi thiết lập.

**UX:** Màn chào `/bat-dau`; F7 (toàn bộ, cao trào b6); State "Chưa kết nối trang nào". **AD:** AD-18, AD-23, AD-7, AD-8.

**Acceptance Criteria:**

**Given** chưa có trang nào
**When** mở app
**Then** chuyển tới `/bat-dau`; endpoint tổng hợp trả trạng thái 4 bước (có trang, có khoá hợp lệ, có hồ sơ hiệu lực, có cấu hình AI đang bật) để FE đánh dấu bước xong

**Given** đã xong 4 bước
**When** khách đầu tiên nhắn Fanpage
**Then** Cài đặt › Webhook chuyển "Nhận tin gần nhất: vừa xong", Hộp thư có hội thoại đầu tiên và tin AI đã gửi; Màn chào hiện cao trào và dẫn vào Hộp thư

## Epic 6: Soạn bài AI và Lịch nội dung

Chủ shop soạn một bài cho nhiều trang với caption và ảnh AI theo hồ sơ từng trang, đăng ngay hoặc lên lịch, xem và kéo thả trên Lịch nội dung, đăng lại khi một trang lỗi.

### Story 6.1: Soạn bài nháp cho nhiều trang

As a chủ shop,
I want chọn đích là một nhóm hoặc vài trang và soạn bài với caption, ảnh riêng từng trang,
So that một ý tưởng lên được nhiều trang mà vẫn đúng từng nền tảng.

**UX:** Soạn bài AI `/soan-bai` (chọn đích, tab theo trang, xem trước FB/IG/Threads); F4 b1, b4. **AD:** AD-13, AD-14, AD-18.

**Acceptance Criteria:**

**Given** chủ shop chọn đích "Nhóm Gia dụng (3 trang)"
**When** lưu nháp
**Then** `content.createPost({source: manual, targets[]})` tạo một `posts` và ba `post_targets` (`draft`), mỗi target có caption/ảnh có thể riêng

**Given** chủ shop tải ảnh lên
**When** tải
**Then** ảnh qua kiểm magic bytes, bỏ EXIF, lưu `MediaStore` công khai; ảnh dùng cho trang IG được chuẩn hoá JPEG sRGB

**Given** bảng ràng buộc nền tảng ở `packages/shared`
**When** caption Threads quá 500 ký tự hoặc trang IG chưa có ảnh
**Then** FE báo ngay trên tab trang đó và `content.assertPublishable` phía server trả `CAPTION_TOO_LONG` / `MEDIA_REQUIRED` khi cố lên lịch

### Story 6.2: Viết caption bằng AI theo hồ sơ từng trang

As a chủ shop,
I want nhập ý tưởng và để AI viết caption cho từng trang theo hồ sơ của trang đó,
So that mỗi trang có giọng riêng mà tôi không phải viết nhiều lần.

**UX:** F4 b2, b3 (tab theo trang); Component "Nút AI"; State "Chưa nhập khoá OpenAI", "AI sinh lỗi / hết hạn mức"; UX-DR2, UX-DR9. **AD:** AD-2, AD-7, AD-8, AD-21.

**Acceptance Criteria:**

**Given** ý tưởng "Khuyến mãi nồi chiên không dầu 20% cuối tuần" và 3 trang đích
**When** bấm "Tạo bằng AI"
**Then** api gọi gateway (`feature=compose_caption`) cho từng trang với hồ sơ hiệu lực (`resolveEffective`) và mẫu prompt chung; mỗi tab hiện caption riêng, sửa được trước khi dùng; nút Dừng huỷ request

**Given** caption vi phạm `ai.checkOutput`
**When** trả về sau một lần sinh lại
**Then** cụm vi phạm được đánh dấu trên tab trang đó

**Given** hết hạn mức (100%) hoặc khoá lỗi
**When** mở Soạn bài
**Then** nút AI khoá theo mã lỗi, vẫn soạn tay được (FR37)

**Given** trang có `CONFIG_MISSING`
**When** tạo bằng AI
**Then** tab trang đó báo cần hồ sơ thương hiệu, các trang khác vẫn được viết

### Story 6.3: Sinh ảnh AI

As a chủ shop,
I want AI sinh 4 ảnh theo ý tưởng để tôi chọn một, tạo lại hoặc tải ảnh khác,
So that bài có hình đẹp mà không cần thiết kế.

**UX:** F4 b3, F4 Thất bại ("Không tạo được ảnh này" + "Thử mô tả khác"). **AD:** AD-14, AD-7, AD-24.

**Acceptance Criteria:**

**Given** chủ shop bấm sinh ảnh
**When** api enqueue 4 job `content.image.generate` (concurrency 2)
**Then** mỗi job gọi `ai.generateImage()` (Images API, model ảnh trong Cài đặt, `output_format: jpeg`, `feature=image_generate`), `MediaStore.put()`, chèn `media_assets(status=ready)`, phát `media_asset.created`; ô ảnh trên FE cập nhật qua SSE

**Given** OpenAI từ chối ảnh vì chính sách hoặc lỗi
**When** job kết thúc
**Then** ô ảnh hiện "Không tạo được ảnh này" + "Thử mô tả khác" (`IMAGE_REJECTED`/`IMAGE_FAILED`); caption giữ nguyên

**Given** ảnh sinh ra hoặc tải lên không gắn vào bài nào quá 7 ngày [ASSUMPTION]
**When** cron dọn chạy
**Then** ảnh mồ côi bị xoá; ảnh của bài đã đăng giữ nguyên

### Story 6.4: Lên lịch và đăng bài theo từng trang

As a chủ shop,
I want đăng ngay hoặc lên lịch, và nếu một trang lỗi thì các trang khác vẫn đăng,
So that một sự cố nhỏ không làm hỏng cả đợt đăng.

**UX:** F4 b5, F4 Thất bại (đỏ trên lịch, "Đăng lại"); State "Đăng bài lỗi"; Interaction Primitives (toast). **AD:** AD-13, AD-6, AD-14, AD-24.

**Acceptance Criteria:**

**Given** bài nháp 3 trang
**When** bấm "Lên lịch" Thứ Bảy 19:00 (giờ VN)
**Then** mỗi target đi `content.transitionTarget(draft → scheduled)` qua `assertPublishable` và kiểm giới hạn đăng/24h (`PUBLISH_LIMIT_REACHED`); enqueue `publish.target` (queue `standard`) `startAfter=scheduled_at` với `{targetId, scheduleVersion}`

**Given** tới giờ đăng
**When** job chạy
**Then** version lệch → bỏ qua im lặng; trang không `active` → `failed` `PAGE_DISCONNECTED`; còn lại chiếm `scheduled → publishing` bằng `UPDATE … WHERE status='scheduled' AND schedule_version=?`, đăng qua `adapters/meta` (FB feed/photos; IG và Threads tạo container, chờ `status_code=FINISHED` rồi publish), lưu `PublishedRef`, `published`, phát `post_target.published`, toast "Đã đăng"

**Given** một trang lỗi
**When** hết retry hoặc lỗi không retry
**Then** chỉ target đó `failed` với `error_code`, phát `post_target.failed` một lần; các target khác không bị ảnh hưởng

**Given** target `failed`
**When** chủ shop bấm "Đăng lại" và chọn giờ mới (hoặc ngay)
**Then** `failed → scheduled`, tăng `schedule_version`, enqueue lại

**Given** lỗi retry được (`TRANSIENT`) khi đang `publishing`
**When** job ném lỗi
**Then** target về lại `scheduled` (giữ `schedule_version`) để lần retry chiếm lại

**Given** cron `content.requeue` 15 phút
**When** có target `scheduled`, `held=false`, quá giờ hơn 10 phút mà không có job sống
**Then** enqueue lại; target `publishing` quá 15 phút → `failed` `PUBLISH_UNKNOWN` (không tự đăng lại)

### Story 6.5: Lịch nội dung với kéo thả

As a chủ shop,
I want xem mọi bài theo tuần/tháng và kéo bài sang ngày khác,
So that tôi sắp xếp lịch đăng trực quan.

**UX:** Lịch nội dung `/lich`; Chi tiết trang › Lịch đăng; Component "Bài trên lịch"; State "Đăng bài lỗi"; UX-DR10. **AD:** AD-13, AD-18.

**Acceptance Criteria:**

**Given** `scope` và khoảng thời gian tuần/tháng
**When** mở Lịch nội dung
**Then** API trả target theo `scheduled_at` với trạng thái từng trang (`PostTargetStatus`) và cờ `ai`; bài AI có nhãn chữ "AI tạo"; slot chiến dịch 1 post : 1 target được FE gom theo giờ

**Given** bài chưa `publishing`/`published`/`cancelled`
**When** kéo sang ngày khác
**Then** `scheduled_at` đổi, `schedule_version` tăng, job cũ tự bỏ qua, job mới enqueue; bài đã đăng không kéo được

**Given** target `failed`
**When** mở trên lịch
**Then** thấy màu đỏ, lỗi theo `ErrorCode` và "Đăng lại"

**Given** chủ shop huỷ hoặc xoá một bài chưa đăng
**When** xác nhận
**Then** target → `cancelled` với `cancel_reason`

## Epic 7: Chiến dịch nuôi page

Chủ shop tạo chiến dịch AI nhiều ngày qua wizard 4 bước, duyệt bài, để AI đăng đều đặn, tạm dừng/tiếp tục; chiến dịch tự dừng an toàn khi có sự cố.

### Story 7.1: Wizard tạo chiến dịch — mục tiêu, trang đích, nội dung và lịch

As a chủ shop,
I want khai báo mục tiêu, trang đích với tần suất riêng, chủ đề và khung giờ,
So that AI biết phải nuôi page thế nào.

**UX:** Tạo chiến dịch `/chien-dich/tao` bước 1–3; F3 b1–b4, F3 Thất bại (tỉ lệ không đủ 100%). **AD:** AD-15.

**Acceptance Criteria:**

**Given** bước 1–3 của wizard
**When** chủ shop nhập mục tiêu "Tăng tương tác" · 30 ngày, chọn nhóm hoặc từng trang (tần suất mỗi trang), chủ đề + tỉ lệ, tỉ lệ bài có ảnh AI, khung giờ đăng, chế độ "Duyệt trước khi đăng" (mặc định) hoặc "Tự đăng"
**Then** chiến dịch được lưu ở `draft` cùng `campaign_topics` và cấu hình trang đích

**Given** tổng tỉ lệ chủ đề khác 100%
**When** sang bước 4
**Then** server trả lỗi validate, FE báo ngay dưới ô

**Given** đích có trang IG
**When** hiển thị tỉ lệ ảnh AI
**Then** FE ghi chú "Instagram luôn cần ảnh"; server luôn tạo slot IG có ảnh

**Given** trang đích đang `disconnected` hoặc `CONFIG_MISSING`
**When** chọn
**Then** không cho chọn, nêu lý do

### Story 7.2: Xem trước 7 bài đầu

As a chủ shop,
I want AI tạo trước 7 bài đầu để tôi sửa, xoá, tạo lại,
So that tôi yên tâm về chất lượng trước khi chiến dịch chạy.

**UX:** Tạo chiến dịch bước 4; F3 b5. **AD:** AD-15, AD-13, AD-21, AD-24.

**Acceptance Criteria:**

**Given** chiến dịch `draft` vào bước 4
**When** job `campaigns.preview` (queue `stately` theo `campaignId`) chạy
**Then** tạo 7 slot đầu qua `content.createPost({source: campaign})` (1 post : 1 target), sinh caption (`feature=campaign_generate`) và ảnh theo luật slot, qua `checkOutput`, đặt `pending_approval` với `held=true` (không đăng được trước khi bắt đầu); FE cập nhật qua SSE

**Given** một bài xem trước
**When** chủ shop sửa, xoá (→ `cancelled`) hoặc "Tạo lại" (→ `planned` rồi sinh lại)
**Then** thay đổi đi qua `content.transitionTarget` với `version`

### Story 7.3: Bắt đầu chiến dịch

As a chủ shop,
I want bấm "Bắt đầu chiến dịch" và thấy ngay toàn bộ lịch bài trên Lịch nội dung,
So that tôi biết page sẽ có bài đều đặn trong suốt chiến dịch.

**UX:** F3 b6 (Lịch hiện bài chấm tím "AI tạo"; Tổng quan hiện thẻ tiến độ 0/N); UX-DR10. **AD:** AD-15, AD-13.

**Acceptance Criteria:**

**Given** chiến dịch `draft` có 7 bài xem trước
**When** bấm "Bắt đầu chiến dịch"
**Then** `campaign_pages` được chụp; slot còn lại cho cả thời lượng được tạo idempotent theo khoá `(campaign_id, page_id, slot_at)` ở trạng thái `planned` với chủ đề theo tỉ lệ; 7 bài xem trước giữ nguyên và được bỏ `held` (chế độ "Tự đăng" chuyển chúng sang `scheduled`); chiến dịch → `running`

**Given** Lịch nội dung
**When** mở sau khi bắt đầu
**Then** toàn bộ slot hiện với nhãn "AI tạo"; read-model chiến dịch trả `postsDone/postsTotal`, `nextPost`, `trend` cho thẻ tiến độ

### Story 7.4: Sinh nội dung cuốn chiếu và hàng đợi Bài chờ duyệt

As a chủ shop,
I want AI viết trước bài cho vài ngày tới và tôi duyệt nhanh trong một hàng đợi,
So that bài luôn sẵn mà vẫn qua mắt tôi.

**UX:** Chiến dịch nuôi page › "Bài chờ duyệt"; Lịch nội dung (duyệt bài chiến dịch); State "AI sinh lỗi / hết hạn mức". **AD:** AD-15, AD-13, AD-21, AD-7.

**Acceptance Criteria:**

**Given** cron hằng giờ
**When** chạy
**Then** slot `planned` trong 3 ngày tới [ASSUMPTION] của chiến dịch `running` được sinh caption + ảnh (slot chỉ rời `planned` khi ảnh `ready` hoặc lỗi); "Duyệt trước" → `pending_approval`; "Tự đăng" → `scheduled` qua `assertPublishable`

**Given** AI lỗi, ảnh lỗi, hoặc `checkOutput` chặn
**When** sinh slot
**Then** slot → `pending_approval` kèm `error_code`, kể cả chế độ "Tự đăng"; slot không bị xoá

**Given** hàng đợi "Bài chờ duyệt" (và bài chờ duyệt trên Lịch)
**When** chủ shop duyệt
**Then** cả hai màn gọi cùng một endpoint `pending_approval → scheduled`; giờ đã qua hoặc còn dưới 2 phút → `SCHEDULE_IN_PAST`, FE hỏi giờ mới

**Given** bài chờ duyệt
**When** chủ shop từ chối hoặc tạo lại
**Then** từ chối → `cancelled`; tạo lại → `planned`, sinh lại ở lượt cron kế tiếp hoặc ngay theo yêu cầu

### Story 7.5: Tạm dừng, tiếp tục và xoá chiến dịch

As a chủ shop,
I want tạm dừng hoặc tiếp tục chiến dịch ngay lập tức và xoá khi không cần,
So that tôi kiểm soát việc đăng mà không phải xử lý từng bài.

**UX:** Component "Thẻ chiến dịch" (Tạm dừng/Tiếp tục không cần xác nhận, Xoá phải xác nhận); Chiến dịch nuôi page; Tổng quan. **AD:** AD-15, AD-13.

**Acceptance Criteria:**

**Given** chiến dịch `running`
**When** bấm "Tạm dừng"
**Then** trong cùng transaction: `paused` (`MANUAL`) và `content.holdCampaignTargets` đặt `held=true`; job đăng tới giờ thấy `held` thì không đăng; cron sinh nội dung bỏ qua chiến dịch này

**Given** chiến dịch `paused`
**When** bấm "Tiếp tục"
**Then** nếu lý do tự dừng vẫn còn (trang vẫn mất kết nối, hạn mức vẫn 100%) → từ chối với mã tương ứng; ngược lại `content.releaseCampaignTargets`: slot đã lỡ giờ → `cancelled` `MISSED_WHILE_PAUSED`, slot tương lai bỏ `held`, tăng `schedule_version`, enqueue lại; `consecutive_failures` về 0

**Given** chủ shop xoá chiến dịch và xác nhận
**When** xử lý
**Then** `content.cancelCampaignTargets` huỷ slot chưa `published`/`publishing`, bài đã đăng giữ nguyên

**Given** không còn slot `planned|pending_approval|scheduled|publishing`
**When** cron kiểm
**Then** chiến dịch → `done`, phát `campaign.completed`

### Story 7.6: Chiến dịch tự tạm dừng khi có sự cố

As a chủ shop,
I want chiến dịch tự dừng khi trang mất kết nối, hết hạn mức AI hoặc đăng lỗi liên tục, kèm lý do rõ ràng,
So that page không đăng sai và tôi biết phải sửa gì.

**UX:** F3 Thất bại; State "Mất kết nối" (chiến dịch tự tạm dừng, có thông báo), "Hết hạn mức chi phí AI" (chiến dịch tự tạm dừng, lý do trên thẻ), "Token sắp hết hạn" (chiến dịch vẫn chạy). **AD:** AD-15, AD-5, AD-7, AD-8, AD-3.

**Acceptance Criteria:**

**Given** `page.disconnected` của một trang trong `campaign_pages`, `ai_budget.threshold_reached` mức 100, hoặc `CONFIG_MISSING` khi sinh
**When** `campaigns` nhận sự kiện
**Then** chiến dịch → `paused` với `pause_reason` tương ứng, `held=true` cho slot, phát `campaign.paused` → thông báo + lý do trên thẻ + cảnh báo ở Tổng quan

**Given** `post_target.failed` cuối với `errorCode` khác `PAGE_DISCONNECTED`
**When** `campaigns` nhận (idempotent theo `targetId`)
**Then** `consecutive_failures` tăng; `post_target.published` cùng chiến dịch đặt về 0; chạm 3 → `paused` `PUBLISH_FAILURES`

**Given** `page.expiring`
**When** nhận
**Then** chiến dịch vẫn chạy

**Given** trang của chiến dịch bị gỡ
**When** nhận `page.removed`
**Then** `content` đã tự huỷ target chưa đăng (`PAGE_REMOVED`); `campaigns` chỉ bỏ trang khỏi `campaign_pages`, chiến dịch chạy tiếp với các trang còn lại

**Given** trang rời đúng nhóm mà chiến dịch gắn nhãn
**When** nhận `page.group_changed`
**Then** `content.cancelCampaignTargets(campaignId, pageId)` huỷ slot chưa đăng của trang đó với `PAGE_LEFT_GROUP`

## Epic 8: Hiệu suất và Tổng quan

Chủ shop xem hiệu suất theo trang/nhóm/nền tảng, hiệu quả AI, tạo bài tương tự từ bài tốt nhất, và có màn Tổng quan với việc cần xử lý thật.

### Story 8.1: Thu thập số liệu trang và bài

As a chủ shop,
I want app tự kéo số liệu từ Meta định kỳ,
So that màn Hiệu suất mở nhanh và không ăn quota lúc khách đang nhắn.

**UX:** nền cho Hiệu suất, Tổng quan, Chi tiết trang/nhóm › Hiệu suất. **AD:** AD-17, AD-6.

**Acceptance Criteria:**

**Given** cron 6 giờ (bài, 30 ngày gần nhất theo `platformPostId` lấy qua `content`) và cron hằng ngày (trang)
**When** chạy với hạng `background`
**Then** ghi `post_metrics` và `page_daily_metrics` theo bảng chỉ số chuẩn (`views`, `reach`, `engagement`, `followers_delta`); metric nền tảng không có → `null`; bảng ánh xạ metric là cấu hình duy nhất trong `analytics`, không dùng metric `*impressions*` đã bị bỏ

**Given** usage Meta ≥75%
**When** cron chạy
**Then** lời gọi bị hoãn tới `blocked_until`, không ảnh hưởng gửi tin

### Story 8.2: Màn Hiệu suất theo phạm vi

As a chủ shop,
I want xem KPI, biểu đồ theo nền tảng, so sánh trang và bài tốt nhất theo nhóm và khoảng thời gian,
So that tôi biết trang nào, nội dung nào hiệu quả.

**UX:** Hiệu suất `/hieu-suat`; F5 b1, b2, F5 Thất bại; State "Chưa đủ dữ liệu". **AD:** AD-17, AD-18.

**Acceptance Criteria:**

**Given** phạm vi "Nhóm Mỹ phẩm" và 30 ngày
**When** mở Hiệu suất
**Then** API (chỉ đọc bảng nội bộ) trả KPI, chuỗi theo nền tảng, bảng so sánh từng trang và danh sách bài tốt nhất; gộp nhóm theo thành viên hiện tại

**Given** trang kết nối <7 ngày
**When** hiển thị
**Then** API trả `insufficientData: true`, FE hiện "Cần thêm vài ngày dữ liệu" thay cho biểu đồ

### Story 8.3: Hiệu quả AI

As a chủ shop,
I want thấy AI đã trả lời bao nhiêu tin, chuyển cho tôi bao nhiêu, phản hồi nhanh thế nào, và bài AI so với bài tự viết,
So that tôi biết AI có đáng tiền không.

**UX:** Hiệu suất › Hiệu quả AI; F5 b3; Voice and Tone ("AI đã trả lời 81% tin nhắn"). **AD:** AD-17.

**Acceptance Criteria:**

**Given** phạm vi và khoảng thời gian
**When** mở mục Hiệu quả AI
**Then** số tin AI trả lời, tỉ lệ chuyển người, thời gian phản hồi trung bình được tính từ `messages` và tin `system` chuyển trạng thái (qua hàm đọc của `inbox`); tương tác trung bình bài AI tạo vs bài tự viết tính từ `posts`/`post_metrics`

### Story 8.4: Tạo bài tương tự

As a chủ shop,
I want từ một bài tốt nhất bấm "Tạo bài tương tự",
So that tôi nhân bản nội dung đang hiệu quả.

**UX:** F5 b4 (mở Soạn bài AI, điền sẵn ý tưởng và đích). **AD:** AD-18.

**Acceptance Criteria:**

**Given** một bài trong danh sách bài tốt nhất
**When** bấm "Tạo bài tương tự"
**Then** Soạn bài AI mở với ý tưởng tóm từ caption gốc và đích là trang của bài đó, chưa gọi AI cho tới khi chủ shop bấm "Tạo bằng AI"

### Story 8.5: Tổng quan với việc cần xử lý thật

As a chủ shop,
I want mở app là thấy số liệu chính và những việc cần tôi ngay,
So that tôi xử lý đúng việc quan trọng trước.

**UX:** Tổng quan `/`; State "Token sắp hết hạn", "AI chuyển cho người", "Đăng bài lỗi", "Webhook ngừng nhận tin", "Hết hạn mức chi phí AI"; UX-DR7. **AD:** AD-18, AD-3.

**Acceptance Criteria:**

**Given** phạm vi đang chọn
**When** mở Tổng quan
**Then** read-model ghép từ các module: số liệu chính, "N tin nhắn cần bạn xử lý" (đúng điều kiện tab "Cần xử lý"), bài lỗi, trang sắp hết hạn/mất kết nối, webhook `stalled`, mức hạn mức AI, bài sắp đăng, chiến dịch đang chạy kèm tiến độ và lý do tạm dừng

**Given** một sự kiện realtime liên quan (tin mới, bài lỗi, chiến dịch tạm dừng)
**When** xảy ra
**Then** Tổng quan refetch phần liên quan trong ≤3 giây

## Epic 9: Sẵn sàng go-live và quyền riêng tư

App đủ điều kiện Meta Live mode (chính sách, xoá dữ liệu, App Review), dữ liệu khách được xoá theo yêu cầu và theo thời hạn, backup đã được diễn tập khôi phục.

### Story 9.1: Trang chính sách và callback xoá dữ liệu của Meta

As a chủ shop,
I want app có trang chính sách quyền riêng tư và xử lý yêu cầu xoá dữ liệu của Meta,
So that app được chuyển sang Live mode.

**UX:** [ASSUMPTION] trang công khai `/privacy/*` không thuộc IA của app. **AD:** AD-22, AD-19.

**Acceptance Criteria:**

**Given** `/privacy/policy`
**When** mở công khai
**Then** nêu dữ liệu được thu thập, việc gửi nội dung tin nhắn sang OpenAI (với `store: false`), thời hạn lưu và cách yêu cầu xoá

**Given** Meta gọi `POST /privacy/meta/deauthorize` hoặc `/privacy/meta/data-deletion` với `signed_request`
**When** chữ ký hợp lệ (app secret)
**Then** tạo `deletion_requests`, phát `privacy.purge_requested` (`deauthorize` = ngắt mọi trang + `scope=all`); data-deletion trả `{url, confirmation_code}` trỏ tới `/privacy/status/<code>`; chữ ký sai → 400

### Story 9.2: Xoá khách và dữ liệu theo yêu cầu

As a chủ shop,
I want xoá một khách và toàn bộ hội thoại của họ khi được yêu cầu,
So that tôi tuân thủ quyền riêng tư của khách.

**UX:** [ASSUMPTION] hành động "Xoá khách và toàn bộ hội thoại" ở Khách hàng (EXPERIENCE.md chưa mô tả). **AD:** AD-22, AD-1, AD-3.

**Acceptance Criteria:**

**Given** chủ shop xác nhận xoá khách
**When** `privacy` phát `privacy.purge_requested{scope: contact}`
**Then** payload mang `requestId` và `conversationIds`; mỗi module tham gia tự xoá phần của mình (`autoreply`: runs; `webhooks`: payload thô liên quan; `ai`: `ref` trong `ai_usage`; `inbox` sau cùng: contact, identities, hội thoại, tin, `message_attachments`) rồi phát `privacy.purge_part_completed`; `privacy` đóng yêu cầu khi đủ

**Given** `scope: page` (trang gỡ quá 30 ngày hoặc yêu cầu từ Meta)
**When** xử lý
**Then** dữ liệu khách và hội thoại của trang được xoá theo cùng cơ chế; trạng thái hiện ở `/privacy/status/<code>`

### Story 9.3: Dọn dữ liệu theo thời hạn

As a chủ shop,
I want dữ liệu cũ không cần thiết tự được xoá,
So that app không giữ dữ liệu cá nhân lâu hơn cần.

**UX:** không có màn riêng; ảnh hưởng Cài đặt › Webhook › nhật ký sự kiện (payload thô chỉ giữ 30 ngày) và Khách hàng. **AD:** AD-22, AD-24.

**Acceptance Criteria:**

**Given** cron hằng ngày (giờ VN)
**When** chạy
**Then** payload thô `webhook_events` >30 ngày bị xoá (giữ metadata), archive pg-boss >7 ngày, `autoreply_runs` >90 ngày, session hết hạn bị xoá [ASSUMPTION các mốc]

### Story 9.4: Hồ sơ App Review và chuyển Live

As a chủ shop,
I want có danh sách việc cần làm để Meta duyệt app,
So that app nhận được tin nhắn từ khách thật.

**UX:** F7 b2 (cấp quyền tin nhắn, đăng bài, thống kê) và F7 b6 (tin của khách thật vào Hộp thư); Mô hình khái niệm › Giới hạn nền tảng. **AD:** Điều kiện ngoài (Meta), AD-4, AD-22.

**Acceptance Criteria:**

**Given** `deploy/app-review.md`
**When** chủ shop làm theo
**Then** có danh sách quyền đối chiếu tài liệu Meta lúc nộp (Messenger, Instagram qua Facebook Login for Business, Page, Threads, kể cả `pages_show_list`, `business_management`, `pages_manage_engagement`, `pages_read_user_content` nếu còn yêu cầu), kịch bản quay màn hình cho từng quyền, Privacy Policy URL, Data Deletion URL, icon, Business Verification, và Organization Verification phía OpenAI nếu model ảnh yêu cầu

**Given** app đã Live
**When** khách thật nhắn Fanpage, IG và trả lời Threads
**Then** webhook về đủ ba nguồn; secret ký webhook Threads đã được xác nhận và ghi trong runbook

### Story 9.5: Diễn tập khôi phục backup

As a chủ shop,
I want chắc chắn khôi phục được từ backup,
So that sự cố máy chủ không làm tôi mất khách và lịch đăng.

**UX:** không có màn riêng; bảo vệ dữ liệu của mọi màn trong IA (Hộp thư, Khách hàng, Lịch nội dung, Chiến dịch). **AD:** Structural Seed › Vận hành, AD-12.

**Acceptance Criteria:**

**Given** một bản backup đêm qua và `APP_ENCRYPTION_KEYS` cất riêng
**When** khôi phục lên một máy mới theo runbook
**Then** app chạy lại với đủ dữ liệu, token và khoá OpenAI giải mã được; thời gian khôi phục được ghi lại trong runbook (RPO 24 giờ)
