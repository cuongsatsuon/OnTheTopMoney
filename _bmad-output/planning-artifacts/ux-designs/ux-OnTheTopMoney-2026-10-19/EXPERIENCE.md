---
name: OnTheTopMoney
status: draft
updated: 2026-10-19
sources: []
stitch_project: projects/8805255510567896615
stitch_design_system: assets/4368583721681109862
---

# OnTheTopMoney — Experience Spine

> Chưa có PRD; spine này dựng trực tiếp từ mô tả của người dùng (xem `.memlog.md`). Mọi mục gắn `[ASSUMPTION]` là do Claude tự quyết theo yêu cầu "tự quyết và dựng luôn" và cần người dùng xác nhận. Nếu spine mâu thuẫn với màn hình Stitch, spine thắng.

## Foundation

- **Thiết bị:** web desktop, tối ưu cho màn hình ≥1280px. Không có bản mobile ở giai đoạn này. Từ 1280–1439px: panel khách hàng của Hộp thư và cột "Xem trước" của Soạn bài AI thu thành nút mở dạng ngăn kéo để khung chính còn ≥480px.
- **Người dùng:** một chủ sở hữu duy nhất. Không phân quyền, không nhiều workspace.
- **Hệ UI:** [ASSUMPTION] shadcn/ui trên Next.js + Tailwind. `DESIGN.md` là chuẩn hình ảnh; file này chỉ mô tả hành vi.
- **Ngôn ngữ:** giao diện tiếng Việt có dấu.
- **Nền tảng kết nối:** Facebook Fanpage, Instagram Business, Threads (qua Meta Graph API). Tin nhắn vào qua webhook.
- **AI:** OpenAI để sinh chữ (caption, trả lời tin nhắn) và ảnh. Khoá API do người dùng nhập ở Cài đặt.

## Thuật ngữ

Dùng đúng các từ này ở mọi màn hình và tài liệu.

| Thuật ngữ | Nghĩa | Không dùng |
|---|---|---|
| Trang | Một tài khoản đã kết nối (Fanpage FB, tài khoản IG Business, tài khoản Threads) | page, kênh, tài khoản (khi nói về đối tượng quản lý) |
| Nhóm | Tập trang do người dùng gom | bộ, cụm |
| Phạm vi | Bộ lọc toàn app: Tất cả trang / một nhóm / một trang | bộ lọc trang |
| Hồ sơ thương hiệu | Thông tin thương hiệu AI dùng để viết | brand profile |
| Cấu hình AI | Thiết lập AI trả lời tự động của một nhóm/trang | kịch bản bot |
| Dùng … riêng | Công tắc ghi đè kế thừa: "Dùng hồ sơ riêng", "Dùng cấu hình AI riêng" | tuỳ chỉnh riêng |
| Lịch nội dung | Màn lịch toàn app | Lịch (chỉ dùng làm nhãn ngắn trong nút) |
| Lịch đăng | Tab lịch trong chi tiết trang/nhóm | |
| Chuyển cho bạn | AI dừng và giao hội thoại cho người dùng | handoff, escalate |
| Tiếp quản | Người dùng tự trả lời, tắt AI cho hội thoại đó | |

## Mô hình khái niệm

Ba khái niệm quyết định toàn bộ giao diện:

1. **Trang** — một tài khoản đã kết nối (1 Fanpage FB, 1 tài khoản IG hoặc 1 tài khoản Threads).
2. **Nhóm** — tập trang do người dùng tự gom, có thể trộn nền tảng (vd: FB A + FB B + IG B = "Nhóm Mỹ phẩm"). [ASSUMPTION] Mỗi trang thuộc **tối đa một nhóm**, để luật kế thừa cấu hình không bị mơ hồ.
3. **Phạm vi** — chọn "Tất cả trang", một nhóm, hoặc một trang. Phạm vi lọc dữ liệu trên: Tổng quan, Hộp thư, Khách hàng, Lịch nội dung, Chiến dịch nuôi page, Hiệu suất. Không áp dụng cho: Soạn bài AI (tự chọn trang đích), Trang & Nhóm, AI trả lời tự động, Cài đặt (đây là màn cấu hình, luôn hiển thị toàn bộ). Phạm vi được nhớ giữa các lần mở app.

**Giới hạn nền tảng:** Threads chưa có API tin nhắn riêng. Với trang Threads, Hộp thư chỉ nhận **trả lời/bình luận** dưới bài đăng, và AI chỉ trả lời công khai. [ASSUMPTION] Cần kiểm lại khi Meta mở API tin nhắn cho Threads.

**Kế thừa cấu hình** (áp dụng cho Hồ sơ thương hiệu và AI trả lời tự động):

| Cấp | Hành vi |
|---|---|
| Nhóm | Định nghĩa cấu hình mặc định cho mọi trang trong nhóm |
| Trang | Mặc định "Theo nhóm". Bật "Dùng cấu hình riêng" để ghi đè toàn bộ mục đó |
| Trang không có nhóm | Bắt buộc có cấu hình riêng |

Chỗ nào đang kế thừa phải luôn ghi rõ nguồn: "Đang dùng hồ sơ của Nhóm Mỹ phẩm".

## Information Architecture

Sidebar trái cố định, thanh trên có Bộ chọn phạm vi, tìm kiếm, nút "+ Tạo bài viết".

| Màn hình | Route (web/) | Vào từ | Mục đích | Flow |
|---|---|---|---|---|
| Màn chào lần đầu | `/bat-dau` | Lần mở đầu tiên khi chưa có trang | 4 bước: kết nối trang → thêm khoá OpenAI → hồ sơ thương hiệu → bật AI trả lời | 7 |
| Tổng quan | `/` | Mở app / sidebar | Số liệu chính, việc cần xử lý, bài sắp đăng, chiến dịch đang chạy | 2, 3 |
| Hộp thư | `/hop-thu` | Sidebar (badge số cần xử lý) | Tab: Tất cả · Cần xử lý · AI đang trả lời · Đã xong. CRM hợp nhất tin nhắn, AI trả lời, tiếp quản | 2 |
| Khách hàng | `/khach-hang` | Sidebar / panel khách trong Hộp thư | Danh sách khách, thẻ, giai đoạn, lịch sử trên nhiều trang | 2 |
| Soạn bài AI | `/soan-bai` | Sidebar / nút "+ Tạo bài viết" / "Tạo bài tương tự" | Sinh caption + ảnh bằng OpenAI theo hồ sơ thương hiệu, xem trước từng nền tảng, đăng/lên lịch | 4, 5 |
| Lịch nội dung | `/lich` | Sidebar | Xem/kéo thả bài theo tuần/tháng, duyệt bài chiến dịch | 3, 4 |
| Chiến dịch nuôi page | `/chien-dich` | Sidebar | Danh sách chiến dịch, hàng đợi "Bài chờ duyệt", tạm dừng/tiếp tục | 3 |
| Tạo chiến dịch | `/chien-dich/tao` | Nút "+ Tạo chiến dịch" | Wizard 4 bước: mục tiêu → trang đích → nội dung & lịch → duyệt | 3 |
| Hiệu suất | `/hieu-suat` | Sidebar | Phân tích theo trang/nhóm/nền tảng, bài tốt nhất, hiệu quả AI | 5 |
| Trang & Nhóm | `/trang-nhom` | Sidebar | Kết nối tài khoản, trạng thái token, tạo/sửa nhóm, gán trang | 1, 7 |
| Chi tiết trang | `/trang-nhom/trang/:id` | Bảng trang | Tab: Hồ sơ thương hiệu · AI trả lời · Lịch đăng · Hiệu suất | 1, 6 |
| Chi tiết nhóm | `/trang-nhom/nhom/:id` | Thẻ nhóm | Tab: Hồ sơ thương hiệu · AI trả lời · Trang thành viên · Hiệu suất | 1, 6 |
| AI trả lời tự động | `/ai-tra-loi` | Sidebar | Cây nhóm/trang bên trái, cấu hình AI của mục đang chọn, khung "Thử AI" | 6 |
| Cài đặt | `/cai-dat` | Sidebar | Khoá OpenAI, webhook, tài khoản Meta, thông báo, hạn mức chi phí AI | 7 |

Màn hình tham khảo hình ảnh: project Stitch `projects/8805255510567896615`. Mới xác minh được màn Tổng quan (bản theme tối do Stitch tự sinh, **không** theo DESIGN.md). Các màn còn lại đã gửi lệnh sinh nhưng chưa xác minh. Bản React trong `web/` là tham chiếu chính; spine thắng khi mâu thuẫn.

## Voice and Tone

Giọng thương hiệu nằm ở `DESIGN.md › Brand & Style`. Microcopy: ngắn, động từ đi đầu, xưng "bạn".

| Nên | Không nên |
|---|---|
| "4 tin nhắn cần bạn xử lý" | "Bạn có 4 mục đang chờ phản hồi từ phía bạn." |
| "AI đã trả lời 81% tin nhắn" | "Tỷ lệ tự động hoá hội thoại: 0,81" |
| "Token Threads sắp hết hạn — Kết nối lại" | "Lỗi xác thực OAuth (code 190)" |
| "Chưa có nhóm nào. Gom các trang cùng chủ đề để dùng chung cấu hình." | "Không có dữ liệu." |
| Nhãn nút: "Lưu hồ sơ", "Tạo bằng AI", "Tiếp quản" | "OK", "Submit", "Xử lý" |

## Component Patterns

Hình ảnh xem `DESIGN.md › Components`.

| Thành phần | Dùng ở | Quy tắc hành vi |
|---|---|---|
| Bộ chọn phạm vi | Thanh trên, mọi màn có dữ liệu | Lưu lựa chọn cuối cùng. Đổi phạm vi thì lọc lại màn hiện tại, không chuyển trang. Gõ để tìm trang/nhóm. |
| Nhãn kế thừa | Hồ sơ thương hiệu, AI trả lời | Hiện nguồn cấu hình. Bật "Dùng cấu hình riêng" sẽ sao chép cấu hình nhóm làm điểm xuất phát. Tắt thì hỏi xác nhận trước khi bỏ cấu hình riêng. |
| Nút AI | Soạn bài, Hộp thư, Hồ sơ | Bấm → trạng thái "AI đang viết…" ngay trong chỗ, có nút Dừng. Kết quả luôn sửa được trước khi dùng. |
| Hội thoại | Hộp thư | Bấm mở chat. AI tự trả lời là switch theo hội thoại; "Tiếp quản" tắt AI cho hội thoại đó cho tới khi bật lại. |
| Thẻ chiến dịch | Tổng quan, Chiến dịch | Tạm dừng/Tiếp tục ngay, không cần xác nhận. Xoá phải xác nhận. |
| Bài trên lịch | Lịch | Kéo sang ngày khác để đổi lịch; bài đã đăng không kéo được. |
| Bảng trang | Trang & Nhóm | Chọn nhiều → thanh thao tác: Thêm vào nhóm, Bật/Tắt AI trả lời. |

## State Patterns

| Trạng thái | Màn hình | Cách xử lý |
|---|---|---|
| Chưa kết nối trang nào | Màn chào `/bat-dau` | 4 bước "Kết nối trang → Thêm khoá OpenAI → Điền hồ sơ thương hiệu → Bật AI trả lời", nút kết nối Facebook/Instagram/Threads (Flow 7). |
| Chưa nhập khoá OpenAI | Mọi nút AI | Nút AI mờ, tooltip "Thêm khoá OpenAI ở Cài đặt" kèm liên kết. |
| Token sắp hết hạn (≤7 ngày) | Trang & Nhóm, Tổng quan | Chip vàng + "Kết nối lại". Chiến dịch liên quan vẫn chạy. |
| Mất kết nối | Như trên + Chiến dịch | Chip đỏ. Chiến dịch dùng trang đó tự tạm dừng, có thông báo. |
| AI đang trả lời | Hộp thư | Chip tím ở hội thoại, chấm "đang gõ" trong chat. |
| AI chuyển cho người | Hộp thư, Tổng quan | Vào tab "Cần xử lý", ghi chú hệ thống nêu lý do chuyển, đếm thời gian chờ. |
| AI sinh lỗi / hết hạn mức | Soạn bài, Chiến dịch | Thông báo nêu lý do + "Thử lại". Chiến dịch chuyển sang "Chờ duyệt" thay vì bỏ bài. |
| Đăng bài lỗi | Lịch, Tổng quan | Bài màu đỏ trên lịch, mở ra thấy lỗi và "Đăng lại". |
| Đang tải | Mọi màn | Skeleton theo đúng bố cục. |
| Hộp thư trống | Hộp thư | "Không còn tin nhắn cần xử lý. AI đang trông giúp bạn." |
| Gửi tin lỗi | Hộp thư | Bong bóng tin lỗi có icon đỏ + lý do: "Quá 24 giờ kể từ tin cuối của khách — Meta không cho gửi tin thường", "Trang mất kết nối", "Gửi quá nhanh, thử lại sau ít phút". Nút "Gửi lại". Tin không bị mất. |
| Webhook ngừng nhận tin | Hộp thư, Tổng quan, Cài đặt | Khi >30 phút không nhận sự kiện trong giờ thường có tin: banner vàng trên Hộp thư "Chưa nhận tin mới 30 phút — Kiểm tra webhook" dẫn tới Cài đặt › Webhook. |
| Mất kết nối thời gian thực | Hộp thư | Dải xám trên danh sách "Đang kết nối lại…"; tự thử lại; tin mới tải bù khi có lại. |
| Hết hạn mức chi phí AI (100%) | Toàn app | Banner đỏ toàn app "Đã dùng hết hạn mức AI tháng này — Tăng hạn mức". Hộp thư: AI ngừng trả lời, hội thoại mới vào thẳng "Cần xử lý" với lý do "Hết hạn mức AI". Chiến dịch: tự tạm dừng, lý do hiển thị trên thẻ. Soạn bài: nút AI bị khoá, vẫn soạn tay được. Ở 80%: chỉ cảnh báo (toast + chip vàng ở sidebar). |
| Kết nối bị huỷ / thiếu quyền | Trang & Nhóm | Modal báo "Chưa cấp đủ quyền quản lý tin nhắn" kèm danh sách quyền thiếu và nút "Thử lại". IG cá nhân: "Chỉ hỗ trợ tài khoản Instagram Business đã liên kết Fanpage". |
| Chưa đủ dữ liệu | Hiệu suất | Trang mới kết nối <7 ngày: "Cần thêm vài ngày dữ liệu" thay cho biểu đồ trống. |

## Interaction Primitives

- `⌘K` / `Ctrl+K`: bảng lệnh — tìm trang, nhóm, khách, hoặc chạy lệnh ("Tạo bài viết", "Đổi phạm vi").
- `⌘↵` gửi tin nhắn trong Hộp thư; `↑/↓` chuyển hội thoại; `T` tiếp quản.
- Lưu form: nút "Lưu" ở footer cố định; rời trang khi chưa lưu thì hỏi lại.
- Thông báo (toast) cho mọi thao tác nền: đăng bài, kết nối, AI xong.

## Accessibility Floor

- Mọi icon nền tảng có nhãn chữ cho trình đọc màn hình ("Facebook").
- Không truyền tải trạng thái chỉ bằng màu: chip trạng thái luôn có chữ.
- Toàn bộ thao tác chính dùng được bằng bàn phím, viền focus rõ.
- Nội dung do AI tạo được đánh dấu bằng chữ ("AI tạo"), không chỉ bằng màu tím.

## Key Flows

### 1. Thu gom page vào nhóm và dùng chung hồ sơ

*Lan Anh bán mỹ phẩm, có 1 Fanpage, 1 Instagram, 1 Threads, tối Chủ nhật ngồi thiết lập.*

1. Mở **Trang & Nhóm**, bấm "+ Kết nối tài khoản" → Facebook, chọn Fanpage "Mỹ phẩm Lan Anh". Lặp lại với Instagram, Threads.
2. Chọn 3 trang trong bảng → "Thêm vào nhóm" → "Tạo nhóm mới": tên "Nhóm Mỹ phẩm", màu hồng.
3. Mở nhóm → tab **Hồ sơ thương hiệu**, điền giọng điệu, sản phẩm chủ lực, từ cấm.
4. Bấm "Viết thử bằng AI" ở khung xem trước: AI viết một caption đúng giọng shop.
5. **Cao trào:** Lưu hồ sơ. Cả 3 trang hiện "Đang dùng hồ sơ của Nhóm Mỹ phẩm"; Lan Anh mở trang Threads và bật "Dùng hồ sơ riêng" để giọng trẻ trung hơn riêng cho Threads.

**Thất bại:** Lan Anh chọn trang đang ở "Nhóm Gia dụng" → modal cảnh báo "Trang này sẽ chuyển khỏi Nhóm Gia dụng và dùng cấu hình của Nhóm Mỹ phẩm" trước khi xác nhận. Tắt "Dùng hồ sơ riêng" → hỏi lại vì hồ sơ riêng sẽ bị bỏ.

### 2. AI trả lời tin nhắn và chuyển cho người

*Minh Phát bán đồ gia dụng, đang giao hàng ngoài đường.*

1. Khách nhắn Fanpage "Gia dụng Minh Phát" hỏi giá nồi chiên. Webhook đưa tin vào **Hộp thư**.
2. AI trả lời trong vài giây theo kho kiến thức của Nhóm Gia dụng; hội thoại hiện chip "AI đang trả lời".
3. Khách hỏi đổi trả hàng lỗi. Đây là quy tắc chuyển người → AI trả lời "Shop sẽ kiểm tra và phản hồi ngay" và chuyển.
4. **Cao trào:** Hội thoại nhảy vào tab "Cần xử lý" kèm lý do. Minh Phát mở, bấm "Tiếp quản", dùng "Gợi ý bằng AI" để soạn câu trả lời rồi sửa và gửi.
5. Gắn thẻ "Đổi trả" và đổi giai đoạn sang "Khách quen" ở panel khách hàng.

**Thất bại:** Minh Phát trả lời khi đã quá 24 giờ kể từ tin cuối của khách → tin hiện lỗi "Meta không cho gửi tin thường sau 24 giờ", gợi ý gửi qua bình luận hoặc gọi điện. Khi đã hết hạn mức AI, bước 2 không xảy ra: hội thoại vào thẳng "Cần xử lý".

### 3. Tạo chiến dịch nuôi page 30 ngày

*Lan Anh muốn page mới "Lan Anh Skincare" có bài đều đặn mà không phải tự viết.*

1. **Chiến dịch nuôi page** → "+ Tạo chiến dịch".
2. Bước 1, Mục tiêu: "Tăng tương tác" · 30 ngày.
3. Bước 2, Đích: chọn nhóm "Nhóm Mỹ phẩm" hoặc từng trang; mỗi trang có thể đặt tần suất riêng.
4. Bước 3, Nội dung: chủ đề (mẹo chăm da, review sản phẩm, hỏi đáp), tỉ lệ bài có ảnh AI, khung giờ đăng, chế độ "Duyệt trước khi đăng" hoặc "Tự đăng".
5. Bước 4, Duyệt: AI tạo trước 7 bài đầu để xem; sửa/xoá/tạo lại từng bài.
6. **Cao trào:** Bấm "Bắt đầu chiến dịch". Lịch nội dung hiện 30 bài chấm tím "AI tạo"; Tổng quan hiện thẻ tiến độ 0/30.

**Thất bại:** Tỉ lệ chủ đề không cộng đủ 100% → không qua bước 3, báo ngay dưới ô. Giữa chiến dịch, trang mất token hoặc hết hạn mức AI → chiến dịch tự tạm dừng, thẻ ghi lý do, Tổng quan hiện cảnh báo; bài AI tạo lỗi chuyển sang "Chờ duyệt" thay vì bị bỏ.

### 4. Soạn một bài đăng nhiều trang kèm ảnh AI

1. "+ Tạo bài viết" → chọn đích: Nhóm Gia dụng (3 trang).
2. Nhập ý: "Khuyến mãi nồi chiên không dầu 20% cuối tuần". Bấm "Tạo bằng AI".
3. AI viết caption theo hồ sơ của từng trang (tab theo trang) và sinh 4 ảnh; chọn 1 ảnh, tạo lại hoặc tải ảnh lên.
4. Xem trước dạng bài Facebook / Instagram / Threads.
5. **Cao trào:** "Lên lịch" Thứ Bảy 19:00 → bài xuất hiện trên Lịch nội dung ở cả 3 trang.

**Thất bại:** OpenAI từ chối ảnh (vi phạm chính sách) hoặc lỗi → ô ảnh báo "Không tạo được ảnh này" + "Thử mô tả khác"; caption vẫn giữ. Đến giờ đăng mà một trang lỗi → bài đó đỏ trên Lịch nội dung, có "Đăng lại"; các trang khác vẫn đăng.

### 5. Xem hiệu suất theo nhóm

1. **Hiệu suất** → phạm vi "Nhóm Mỹ phẩm", 30 ngày.
2. Xem KPI, biểu đồ theo nền tảng, bảng so sánh từng trang.
3. Mục "Hiệu quả AI": số tin AI trả lời, tỉ lệ chuyển người, thời gian phản hồi trung bình; bài AI tạo vs bài tự viết.
4. **Cao trào:** Thấy bài "mẹo chăm da" tương tác gấp 3 → bấm "Tạo bài tương tự" → mở Soạn bài AI với ý tưởng điền sẵn.

**Thất bại:** Trang mới kết nối chưa đủ 7 ngày → "Cần thêm vài ngày dữ liệu" thay biểu đồ.

### 6. Thiết lập AI trả lời cho một nhóm

*Minh Phát muốn AI trả lời tin nhắn cho cả 3 trang gia dụng.*

1. **AI trả lời tự động** → chọn "Nhóm Gia dụng" ở cây bên trái.
2. Bấm "Lấy từ Hồ sơ thương hiệu" để điền kịch bản, sửa xưng hô "Shop – anh/chị".
3. Kho kiến thức: tải "Bảng giá.pdf", thêm câu hỏi "Phí giao hàng?".
4. Chuyển cho bạn khi: thêm từ khoá "đổi trả", "bảo hành"; giữ "AI không chắc chắn".
5. Giờ hoạt động: "Ngoài giờ làm việc" (18:00–08:00).
6. Khung "Thử AI": gõ "Nồi chiên bảo hành bao lâu?" → AI trả lời đúng theo kho kiến thức; gõ "muốn đổi trả" → thấy ghi chú "AI sẽ chuyển cho bạn".
7. **Cao trào:** Bật công tắc AI, "Lưu cấu hình". Cây bên trái hiện "Bật" cho nhóm; 3 trang con hiện "Theo nhóm". Minh Phát mở trang minhphat.store, bật "Dùng cấu hình AI riêng" và tắt riêng kênh bình luận.

**Thất bại:** Chưa có khoá OpenAI → công tắc AI bị khoá, banner "Thêm khoá OpenAI ở Cài đặt". Kịch bản để trống → không cho bật, báo dưới ô.

### 7. Lần đầu sử dụng: kết nối và cài đặt

*Lan Anh vừa đăng ký, chưa có trang nào.*

1. App mở **Màn chào** (4 bước).
2. Bước 1: "Kết nối Facebook" → cửa sổ Meta → chọn Fanpage "Mỹ phẩm Lan Anh" và IG "lananh.beauty" (đã liên kết Fanpage) → cấp quyền tin nhắn, đăng bài, thống kê.
3. Bước 2: dán khoá OpenAI ở Cài đặt › Kết nối OpenAI; app kiểm tra khoá, báo "Đã kết nối"; đặt hạn mức 1.000.000đ/tháng.
4. Cài đặt › Webhook: app tự đăng ký webhook với Meta; trạng thái "Đang chờ tin đầu tiên".
5. Bước 3–4: điền Hồ sơ thương hiệu, bật AI trả lời (Flow 1, Flow 6).
6. **Cao trào:** Có khách nhắn Fanpage → webhook chuyển sang "Nhận tin gần nhất: vừa xong", Hộp thư có hội thoại đầu tiên và AI đã trả lời.
7. Về sau, khi token còn ≤7 ngày: chip vàng "Token sắp hết hạn" ở Trang & Nhóm và Tổng quan → "Kết nối lại" mở lại cửa sổ Meta cho đúng trang đó.

**Thất bại:** Người dùng huỷ cửa sổ Meta hoặc bỏ quyền tin nhắn → modal liệt kê quyền thiếu + "Thử lại". Chọn IG cá nhân → báo cần IG Business đã liên kết Fanpage. Khoá OpenAI sai → "Khoá không hợp lệ", không lưu.

## Cấu hình AI trả lời tự động

Màn này có nhiều quyết định riêng nên tách mục.

| Phần | Nội dung |
|---|---|
| Phạm vi áp dụng | Chọn nhóm hoặc trang; hiện nguồn kế thừa. |
| Bật/Tắt & giờ hoạt động | Luôn bật / chỉ ngoài giờ làm việc / theo khung giờ. |
| Kịch bản (system prompt) | Soạn tự do; có mẫu theo ngành. Mặc định lấy từ Hồ sơ thương hiệu. |
| Kho kiến thức | Câu hỏi thường gặp, bảng giá, chính sách; tải file hoặc nhập tay. |
| Quy tắc chuyển người | Từ khoá (đổi trả, khiếu nại, hoàn tiền), khách yêu cầu gặp người, AI không chắc chắn. |
| Kênh áp dụng | Tin nhắn (Messenger/IG DM), bình luận (trả lời công khai / nhắn riêng). [ASSUMPTION] Có trả lời bình luận. |
| Thử nghiệm | Khung chat giả lập để thử AI trước khi bật. |

## Cài đặt

- **OpenAI:** khoá API, model chữ, model ảnh, hạn mức chi tiêu/tháng, cảnh báo khi đạt 80%.
- **Webhook:** URL nhận tin (chỉ đọc, nút sao chép), verify token, trạng thái nhận tin gần nhất, nhật ký sự kiện.
- **Thông báo:** khi AI chuyển người, token sắp hết hạn, đăng bài lỗi, chiến dịch tạm dừng.
- **Tài khoản Meta:** danh sách trang đã kết nối với ngày hết hạn token và "Kết nối lại".

## Câu hỏi mở

- [ASSUMPTION] Mỗi trang chỉ thuộc một nhóm. Nếu cần một trang nằm trong nhiều nhóm, luật kế thừa phải có thứ tự ưu tiên.
- [ASSUMPTION] Chiến dịch mặc định "Duyệt trước khi đăng"; "Tự đăng" là lựa chọn người dùng chủ động bật.
- Có cần trả lời bình luận công khai hay chỉ tin nhắn?
- Có cần bản mobile cho Hộp thư sau này không?
