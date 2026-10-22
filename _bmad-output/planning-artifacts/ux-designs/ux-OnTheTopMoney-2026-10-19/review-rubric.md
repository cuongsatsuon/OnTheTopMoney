# Spine Pair Review — OnTheTopMoney

> Rubric walker · 2026-10-19 · Kiểm tra `DESIGN.md` + `EXPERIENCE.md` (status: draft). Không có PRD (`sources: []`); danh sách yêu cầu dùng để đối chiếu là 6 quyết định gốc của người dùng trong `.memlog.md` (dòng 6–11).

## Overall verdict

Khung xương của bộ spine tốt: mô hình khái niệm Trang / Nhóm / Phạm vi kèm luật kế thừa rõ ràng, IA đủ 12 màn, giọng văn và tách màu teal/tím AI có kỷ luật, DESIGN.md gọn và đúng thứ tự. Nhưng spine **chưa đủ làm hợp đồng cho downstream**. Không flow nào có nhánh thất bại. Yêu cầu (4) "cấu hình AI trả lời theo trang hoặc nhóm" và bước thiết lập ban đầu (khoá OpenAI, webhook) không có flow nào đi qua. Bảng 8 màu nhóm không có mã hex. Hai thành phần lõi (Hội thoại, Nhãn kế thừa) thiếu đặc tả hình ảnh. Nhiều trạng thái lỗi và trống có tải trọng (gửi tin lỗi, chạm hạn mức chi phí AI, kết nối thất bại) chưa được định nghĩa.

## 1. Flow coverage — thin

Đã đối chiếu 6 yêu cầu trong memlog với 5 Key Flow: nhân vật, bước đánh số, cao trào, nhánh thất bại. Kiểm tra mọi màn IA đều có flow đi qua và mọi flow đều đáp xuống một màn đã định nghĩa.

| Yêu cầu | Flow | Ghi chú |
|---|---|---|
| (1) Kết nối FB/IG/Threads | Flow 1 b1 (1 câu) | Không có nhánh lỗi, không có kết nối lại |
| (2) Hồ sơ thương hiệu từng trang | Flow 1 b3–b5 | Đủ |
| (3) Gom nhóm đa nền tảng | Flow 1 b2 | Đủ |
| (4) CRM webhook + AI trả lời cấu hình theo trang/nhóm | Flow 2 | Có phần dùng, **không có phần cấu hình** |
| (5) Sinh bài kèm ảnh + chiến dịch nuôi page | Flow 3, Flow 4 | Flow 4 không có nhân vật; thiếu bước duyệt bài sau khi chạy |
| (6) Theo dõi hiệu suất | Flow 5 | Không có nhân vật |

Màn IA không có flow nào đi qua: **AI trả lời tự động**, **Cài đặt**, **Khách hàng** (chỉ chạm panel trong Hộp thư).

### Findings
- **high** Không flow nào trong 5 flow có nhánh thất bại (EXPERIENCE › Key Flows, dòng 119–163). *Fix:* thêm dòng "Thất bại:" cho từng flow. Flow 1: huỷ OAuth / thiếu quyền / IG chưa liên kết Fanpage. Flow 2: AI lỗi hoặc gửi tin lỗi (ngoài cửa sổ 24h). Flow 3: AI lỗi khi tạo trước 7 bài / chạm hạn mức. Flow 4: ảnh bị từ chối do chính sách / đăng lỗi lúc 19:00. Flow 5: chưa đủ dữ liệu.
- **high** Yêu cầu (4) chỉ được phủ ở phía dùng. Không flow nào thiết lập AI trả lời cho một nhóm hoặc trang, nên màn "AI trả lời tự động" (IA dòng 57, mục "Cấu hình AI trả lời tự động" dòng 165–177) không được flow nào đi qua. *Fix:* thêm Flow 6 "Thiết lập AI trả lời cho Nhóm Gia dụng": chọn phạm vi → kịch bản → kho kiến thức (tải bảng giá) → quy tắc chuyển người → giờ hoạt động → thử trong khung chat giả lập → bật. Cao trào: trang con hiện "Đang dùng cấu hình của Nhóm…". Có nhánh thất bại khi tải file lỗi.
- **high** Yêu cầu (1) chỉ là một câu trong Flow 1 b1: "bấm '+ Kết nối tài khoản' → Facebook, chọn Fanpage". Thiếu hộp thoại Meta, bước chọn nhiều Fanpage, điều kiện IG Business phải liên kết Fanpage, Threads đăng nhập riêng, kết quả sau kết nối, và luồng "Kết nối lại" khi token hết hạn. *Fix:* mở rộng Flow 1 hoặc tách flow "Kết nối tài khoản" có đủ các bước trên và nhánh lỗi.
- **high** Bước thiết lập ban đầu không có flow nào đi qua: nhập khoá OpenAI, cấu hình webhook, xác minh tin đầu tiên đã vào. Đây là tiền điều kiện của yêu cầu (4) và (5). Màn chào 3 bước (State Patterns dòng 92) cũng bỏ qua khoá OpenAI. *Fix:* thêm "Thêm khoá OpenAI" vào màn chào. Thêm flow onboarding lần đầu đi qua Cài đặt → OpenAI → Webhook (sao chép URL, verify token), với cao trào "Đã nhận tin nhắn đầu tiên".
- **medium** Flow 4 và Flow 5 không có nhân vật hay bối cảnh (dòng 150, 158). *Fix:* gắn nhân vật (vd Minh Phát chuẩn bị khuyến mãi cuối tuần; Lan Anh xem lại tháng).
- **medium** Màn "Khách hàng" (IA dòng 49) không được flow nào ghé; Flow 2 b5 chỉ dùng panel trong Hộp thư. *Fix:* thêm bước vào Flow 2 hoặc một flow ngắn: lọc khách theo thẻ "Khiếu nại", xem lịch sử nhắn tin trên nhiều trang.
- **medium** Chế độ mặc định của chiến dịch là "Duyệt trước khi đăng" (Câu hỏi mở dòng 188), nhưng sau khi chiến dịch chạy thì không flow hay màn nào nói bài chờ duyệt nằm ở đâu và duyệt thế nào. IA dòng 52 chỉ ghi "duyệt bài". *Fix:* định nghĩa hàng đợi "Chờ duyệt" (vị trí: Chiến dịch và/hoặc Tổng quan, có badge), và thêm một flow duyệt hằng ngày.
- **medium** Hộp thư nói hợp nhất tin nhắn "FB/IG/Threads" (IA dòng 48, Foundation dòng 20), nhưng "Kênh áp dụng" (dòng 176) chỉ liệt kê Messenger/IG DM. Threads API có thể không hỗ trợ tin nhắn riêng (cần xác minh). *Fix:* gắn [ASSUMPTION] và ghi rõ Threads vào Hộp thư dưới dạng gì (chỉ trả lời bài viết, hay không có).
- **medium** Hai flow đáp xuống những màn chưa được định nghĩa. Flow 1 b3/b5 vào "Chi tiết trang/nhóm" có tab con (dòng 60), nhưng màn này không có hàng IA. Flow 2 b4 dùng tab "Cần xử lý" của Hộp thư, nhưng bộ tab của Hộp thư chưa được định nghĩa. Quan hệ giữa mục sidebar "AI trả lời tự động" và tab "AI trả lời" của trang cũng chưa rõ. *Fix:* thêm hàng IA "Chi tiết trang / nhóm" kèm các tab. Liệt kê các tab của Hộp thư (vd Tất cả · Cần xử lý · AI đang xử lý · Đã xong). Ghi rõ mục sidebar AI trả lời mở danh sách nhóm/trang hay mở cấu hình của phạm vi đang chọn.
- **low** Flow 3 không nhất quán. Protagonist muốn nuôi page mới "Lan Anh Skincare", nhưng b3 chọn "Nhóm Mỹ phẩm" (3 trang của Flow 1). "30 bài" mơ hồ khi đăng đa trang với tần suất riêng từng trang. *Fix:* chọn một đích duy nhất và ghi số bài theo từng trang.
- **low** Cao trào Flow 5 ("Tạo bài tương tự bằng AI") không nói người dùng được đưa tới đâu. *Fix:* ghi "mở Soạn bài AI, điền sẵn ý tưởng và đích".

## 2. Token completeness — thin

Đã trích 22 token màu, 7 vai trò chữ, 4 bo góc, 12 spacing, 9 component. Mọi tham chiếu `{…}` trong prose và frontmatter đều phân giải được. Mọi màu khai báo đều có hex. Không có mục tiêu contrast nào được nêu, nên đã tự tính các cặp có tải trọng (WCAG):

| Cặp | Tỉ lệ | Kết quả |
|---|---|---|
| primary trên surface | 5,47 | AA |
| ai trên ai-soft (Nhãn AI) | 4,80 | AA |
| ai-foreground trên ai (Nút AI) | 5,70 | AA |
| **warning trên warning-soft (status-warning)** | **2,86** | **Trượt AA** |
| warning trên surface | 3,19 | Trượt cho chữ |
| success trên surface | 3,30 | Trượt cho chữ |
| danger trên surface | 4,83 | AA |
| muted-foreground trên background | 4,55 | AA (sát ngưỡng) |
| sidebar-foreground trên sidebar | 11,52 | AA |
| platform-threads trên sidebar | 1,11 | Không thấy được |

### Findings
- **critical** "Bảng 8 màu cố định" cho nhóm (DESIGN › Colors dòng 140) không có token hay hex nào. Component `group-chip` (dòng 107–110) dùng mô tả văn xuôi thay vì token. Downstream sẽ phải tự chế màu. *Fix:* thêm `group-1`…`group-8` có hex, cùng quy tắc nền nhạt dạng token (vd `group-1-soft`, hoặc ghi rõ alpha 12%), và cho `group-chip` trỏ vào đó. Kiểm tra contrast chữ màu nhóm trên nền nhạt.
- **high** Component `status-warning` (dòng 120–122) dùng cho chip "Token sắp hết hạn" chỉ đạt 2,86:1, trượt AA với chữ 12–13px. `success` dùng làm chữ cũng chỉ đạt 3,3:1. *Fix:* thêm `warning-foreground: '#92400E'` (6,37:1 trên `#FEF3C7`) và `success-foreground: '#15803D'` (5,02:1 trên trắng), rồi dùng chúng cho chữ trong chip.
- **medium** Thiếu `danger-soft`, `success-soft` và component `status-danger` / `status-success`, trong khi State Patterns cần "chip đỏ", "bài màu đỏ trên lịch" và "đã đăng". *Fix:* thêm token, ví dụ `danger-soft '#FEE2E2'` với chữ `'#B91C1C'` (5,3:1) và `success-soft '#DCFCE7'` với chữ `'#166534'` (6,49:1), cùng hai component tương ứng.
- **medium** Không nêu mục tiêu contrast nào cho các cặp có tải trọng. *Fix:* thêm bảng ngắn vào DESIGN › Colors (các cặp trong bảng trên, mục tiêu AA 4,5:1 cho chữ, 3:1 cho icon).
- **low** Không nói rõ chỉ có giao diện sáng, trong khi shadcn mặc định có dark mode. *Fix:* thêm một dòng "v1 chỉ có giao diện sáng; không có token `-dark`".
- **low** Một số giá trị thô nằm ở chỗ đã có token: `sidebar-item-active.foreground: '#FFFFFF'` (nên dùng `{colors.primary-foreground}`), "lề 24px" (dòng 148, nên dùng `{spacing.6}`). Chữ số tabular nhắc ở prose nhưng không có trong token `metric`. *Fix:* thay bằng tham chiếu token; thêm `fontFeature: 'tnum'` vào `metric`.
- **low** Icon Threads `#101010` trên sidebar tối chỉ đạt 1,11:1. *Fix:* quy định icon nền tảng trên nền tối có viền trắng hoặc dùng biến thể sáng.

## 3. Component coverage — thin

| Thành phần | DESIGN (hình ảnh) | EXPERIENCE (hành vi) |
|---|---|---|
| Nút chính / Nút AI | Có | Nút AI: có |
| Nhãn AI | Có | Không có hàng |
| Biểu tượng nền tảng | Có | Chỉ ở Accessibility |
| Chip nhóm | Có (thiếu token màu) | Không |
| Thẻ KPI | Có | Không |
| Bộ chọn phạm vi | Prose, không có khoá frontmatter | Có |
| Chip trạng thái | Chỉ `status-warning` | Không (chỉ nhắc trong State Patterns) |
| **Hội thoại / bong bóng chat** | **Không** | Có |
| **Nhãn kế thừa** | **Không** | Có |
| Thẻ chiến dịch | Không | Có |
| Bài trên lịch | Không | Có |
| Bảng trang | shadcn Table, không có delta | Có |
| Wizard bước, Xem trước bài theo nền tảng, Panel hồ sơ khách, Khung chat thử nghiệm, Màn chào, Thanh tiến độ chiến dịch, Footer lưu | Không | Không |

### Findings
- **high** "Hội thoại" (dòng hội thoại, bong bóng của khách / người dùng / AI, ghi chú hệ thống khi chuyển người, chỉ báo "đang gõ") không có đặc tả hình ảnh. DESIGN chỉ nhắc màu tím cho bong bóng AI (dòng 136). Hộp thư là màn lõi. *Fix:* thêm vào DESIGN › Components và frontmatter: `conversation-row` (trạng thái chưa đọc / đang chọn / AI đang trả lời / cần xử lý) và `chat-bubble-customer` / `-agent` / `-ai` / `system-note`.
- **high** "Nhãn kế thừa" là khái niệm trung tâm của mô hình cấu hình (dòng 39, 81) nhưng không có hình ảnh. *Fix:* thêm component `inherit-banner` (vị trí đầu form, icon liên kết, chip nhóm nguồn, công tắc "Dùng cấu hình riêng", trạng thái "Đang dùng cấu hình riêng").
- **medium** Thẻ chiến dịch, Bài trên lịch, Bảng trang chỉ có hành vi. Đáng kể nhất là Bài trên lịch cần hình ảnh cho các trạng thái lên lịch / đã đăng / lỗi / AI tạo / chờ duyệt. *Fix:* thêm hàng vào DESIGN › Components cho từng thành phần, kèm các trạng thái.
- **medium** Thẻ KPI, Chip nhóm, Nhãn AI, Biểu tượng nền tảng, Chip trạng thái có hình ảnh nhưng không có hàng hành vi. Những câu hỏi còn bỏ ngỏ: nhãn "AI tạo" có còn sau khi người dùng sửa nội dung không; bấm chip "Kết nối lại" dẫn đi đâu; bấm Thẻ KPI có mở chi tiết không. *Fix:* thêm hàng vào EXPERIENCE › Component Patterns.
- **medium** Có 7 thành phần được nhắc trong flow / IA nhưng không có ở file nào: wizard 4 bước, khung xem trước bài theo nền tảng, panel hồ sơ khách, khung chat thử nghiệm, màn chào onboarding, thanh tiến độ chiến dịch, footer lưu cố định. *Fix:* thêm cặp hình ảnh + hành vi, hoặc ghi rõ thành phần nào là shadcn nguyên bản.
- **low** Khoá frontmatter tiếng Anh (`button-ai`, `ai-badge`, `platform-dot`, `group-chip`, `kpi-card`) không được ánh xạ với tên tiếng Việt dùng ở prose và EXPERIENCE. *Fix:* ghi khoá trong ngoặc ở prose, vd "Nút AI (`button-ai`)", và dùng đúng tên đó ở EXPERIENCE.

## 4. State coverage — thin

Đã duyệt 12 màn IA. Đã phủ: lần đầu chưa kết nối, thiếu khoá OpenAI, token sắp hết hạn / mất kết nối, AI đang trả lời / chuyển người, AI lỗi ở Soạn bài và Chiến dịch, đăng lỗi, đang tải (skeleton), Hộp thư trống. Còn thiếu:

### Findings
- **high** Hộp thư thiếu ba trạng thái. (a) Gửi tin lỗi: ngoài cửa sổ 24h của Meta, token mất, bị giới hạn tốc độ. (b) Webhook ngừng nhận tin: Hộp thư phải cảnh báo, không chỉ hiện ở Cài đặt. (c) Mất cập nhật realtime. *Fix:* thêm ba hàng vào State Patterns, gồm nội dung thông báo và hành động khôi phục.
- **high** Không định nghĩa điều gì xảy ra khi chạm 100% hạn mức chi phí AI (Cài đặt dòng 181 chỉ có cảnh báo 80%): AI trả lời tự động dừng hay chuyển hết cho người, chiến dịch tạm dừng hay chuyển "Chờ duyệt". *Fix:* thêm hàng "Hết hạn mức chi phí AI" phủ Hộp thư, Chiến dịch, Soạn bài, kèm banner toàn app.
- **medium** Trang & Nhóm thiếu trạng thái kết nối thất bại: huỷ OAuth, thiếu quyền, IG không phải Business hoặc chưa liên kết Fanpage, trang đã được kết nối. Xem thêm Flow coverage. *Fix:* thêm hàng vào State Patterns.
- **medium** Thiếu các trạng thái trống: Trang & Nhóm chưa có nhóm (câu này chỉ có ở Voice dòng 71), Khách hàng trống hoặc không có kết quả tìm, Chiến dịch trống, Lịch trống trong tuần, Hiệu suất chưa đủ dữ liệu hoặc đang đồng bộ insights, Tổng quan khi đã kết nối nhưng chưa có số liệu. *Fix:* thêm hàng cho từng trạng thái.
- **medium** Soạn bài AI thiếu trạng thái cho ràng buộc nền tảng: IG bắt buộc có ảnh, Threads giới hạn ký tự, caption vượt giới hạn trên một tab trang. Cũng thiếu trạng thái khi trang không có hồ sơ thương hiệu. *Fix:* thêm hàng kiểm tra hợp lệ theo nền tảng (cảnh báo ở tab trang, chặn "Lên lịch").
- **medium** AI trả lời tự động / Hồ sơ thương hiệu thiếu: trạng thái đang tắt, kho kiến thức trống, tải file đang xử lý hoặc lỗi. Luật nói trang không nhóm "bắt buộc có cấu hình riêng" (dòng 37) nhưng không nói trang đó hiển thị gì khi chưa có cấu hình. *Fix:* thêm các hàng này.
- **low** Thiếu trạng thái mất mạng toàn cục và trạng thái khoá OpenAI không hợp lệ (xác minh khi lưu ở Cài đặt). *Fix:* thêm hai hàng.

## 5. Visual reference coverage — thin

`imports/` trống. Không có `mockups/` hay `wireframes/` cục bộ. Tham chiếu duy nhất là Stitch project `projects/8805255510567896615` và design system `assets/4368583721681109862` trong frontmatter của EXPERIENCE. Câu "spine thắng khi mâu thuẫn" được nêu một lần (EXPERIENCE dòng 12). Không phạt nặng vì màn hình chỉ tồn tại trên Stitch.

### Findings
- **medium** Cột "Stitch" ở IA ghi "Có" cho cả 12 màn, nhưng memlog dòng 22 ghi mọi lệnh sinh đều timeout và `list_screens` trả rỗng, nên chưa màn nào được xác minh. *Fix:* đổi thành "Chưa xác minh", hoặc thay bằng screen ID cụ thể sau khi kiểm tra.
- **medium** Không có ảnh hay link cụ thể cho từng màn, nên consumer không có Stitch MCP không xem được tham chiếu. *Fix:* xuất ảnh chụp màn Stitch vào `mockups/`, rồi liên kết inline ở hàng IA và flow tương ứng, kèm mô tả màn đó minh hoạ điều gì.
- **low** Lần sinh đầu, Stitch tự tạo theme tối indigo "Executive Kinetic Precision", trái hướng đã chọn (memlog dòng 21). DESIGN không nhắc chuyện này, và không rõ màn nào dùng theme sai. *Fix:* thêm một dòng trong DESIGN › Brand & Style: "Màn Stitch dùng theme indigo tối là sai hướng; DESIGN.md thắng."

## 6. Bloat & overspecification — strong

Hai file gọn và dùng bảng hợp lý. "Mô hình khái niệm", "Cấu hình AI trả lời tự động" và "Cài đặt" đều chứa quyết định downstream cần dùng.

### Findings
- **low** DESIGN › Typography (dòng 144) và Components lặp lại giá trị đã có trong frontmatter ("display 28, title 20…"). *Fix:* ở prose chỉ giữ vai trò và chỗ dùng; để giá trị cho frontmatter.

## 7. Inheritance discipline — adequate

`sources: []` hợp lệ vì không có PRD. Tên 6 yêu cầu khớp memlog. Tên component trong DESIGN prose và EXPERIENCE khớp phần lớn (Bộ chọn phạm vi, Nút AI).

### Findings
- **medium** Thuật ngữ chưa đồng nhất. "Dùng cấu hình riêng" (dòng 36, 81) đối lập với "Dùng hồ sơ riêng" (Flow 1 b5). "Lịch nội dung" / "Lịch" / tab "Lịch đăng" có thể là cùng một thứ hoặc khác nhau. "Chiến dịch nuôi page" / "Chiến dịch" / memlog "Danh sách chiến dịch". "Trang" đối lập với "page", trong khi DESIGN › Do's cấm trộn tiếng Anh vào giao diện. *Fix:* thêm Glossary ngắn trong EXPERIENCE và chuẩn hoá mọi chỗ theo đó.
- **medium** Phạm vi áp dụng tới đâu mâu thuẫn giữa ba chỗ. Memlog dòng 18 nói "áp dụng toàn app". Mô hình (dòng 29) liệt kê 5 màn. Component Patterns (dòng 80) nói "mọi màn có dữ liệu". Chiến dịch, Trang & Nhóm, AI trả lời có bị lọc không thì chưa rõ. *Fix:* liệt kê dứt khoát màn nào bị Phạm vi lọc, và Bộ chọn hiển thị gì ở các màn không bị lọc.
- **medium** EXPERIENCE không tham chiếu token nào theo tên mà dùng "chip vàng", "chip đỏ", "chip tím", "chấm tím". *Fix:* dùng `{colors.warning}`, `{colors.danger}`, `{colors.ai}`, hoặc tên component trong DESIGN (`status-warning`, `ai-badge`).
- **medium** Memlog dòng 16 ghi người dùng muốn xem các hướng thiết kế mẫu rồi tự chọn. Nhưng DESIGN dòng 131 và memlog dòng 19 ghi hướng hình ảnh do Claude tự chọn. Quyết định hình ảnh chưa được người dùng chốt. *Fix:* đưa câu này vào "Câu hỏi mở" và xác nhận với người dùng trước khi chuyển `status: final`.
- **low** `sources: []` không trỏ tới nguồn yêu cầu thực tế. *Fix:* thêm tham chiếu tới `.memlog.md`, hoặc ghi chú trong frontmatter rằng 6 yêu cầu gốc nằm ở đó.

## 8. Shape fit — adequate

DESIGN.md đúng thứ tự chuẩn (Brand & Style → Colors → Typography → Layout & Spacing → Elevation & Depth → Shapes → Components → Do's and Don'ts). EXPERIENCE.md có đủ các mục mặc định bắt buộc. Các mục tự đặt (Mô hình khái niệm, Cấu hình AI trả lời tự động, Cài đặt, Câu hỏi mở) đều có lý do tồn tại.

### Findings
- **medium** Spine chỉ có một bề mặt nên mục Responsive không bắt buộc. Nhưng ở ngưỡng tối thiểu 1280px, Hộp thư 3 cột (sidebar 240 + danh sách 340 + panel 320 + lề) chỉ còn khoảng 330px cho khung chat. Chưa có quy tắc cho 1280–1440px, cũng chưa nói gì về dưới 1280px. *Fix:* thêm một dòng: dưới 1440px thì panel khách thu thành Sheet, sidebar thu về dạng icon.
- **low** Không có mục Inspiration & Anti-patterns, dù memlog có một hướng bị loại (theme tối indigo của Stitch). *Fix:* thêm mục ngắn ghi hướng bị loại và lý do.
- **low** Accessibility Floor không nêu mức WCAG mục tiêu, và không có thông báo `aria-live` cho tin nhắn mới hoặc khi AI trả lời xong. *Fix:* ghi "WCAG 2.2 AA" và thêm quy tắc thông báo cho trình đọc màn hình.

## Mechanical notes

- Mọi tham chiếu `{path.to.token}` trong DESIGN.md đều phân giải được. EXPERIENCE.md không có tham chiếu token nào.
- Tên không nhất quán: "Dùng cấu hình riêng" và "Dùng hồ sơ riêng"; "Lịch nội dung", "Lịch" và "Lịch đăng"; "Trang" và "page"; "chip vàng/đỏ/tím" và `status-warning` / `ai-badge`.
- Frontmatter DESIGN có thêm `status` và `updated`, ngoài spec nhưng vô hại. Frontmatter EXPERIENCE có thêm `stitch_project` và `stitch_design_system`, hữu ích.
- Không có sơ đồ Mermaid.
- Flow dùng "**Cao trào:**" nhất quán. Chưa flow nào có dòng "Thất bại:".
- Cột "Stitch" ở IA khẳng định 12 màn đã có, nhưng memlog cho thấy chưa xác minh được màn nào.

**Tổng số phát hiện:** critical 1 · high 9 · medium 21 · low 12.
