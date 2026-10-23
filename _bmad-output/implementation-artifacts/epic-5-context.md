# Epic 5 Context: AI trả lời tự động

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Cho AI tự trả lời tin nhắn (Messenger, Instagram Direct) và bình luận (công khai, nhắn riêng; Threads chỉ công khai) thay chủ shop, theo cấu hình đặt một lần cho cả nhóm và ghi đè được từng trang: kịch bản, kho kiến thức, quy tắc chuyển người, giờ hoạt động, kênh áp dụng. Chủ shop thử AI trước khi bật. AI tự chuyển hội thoại cho người khi gặp chuyện cần người hoặc khi hết hạn mức/khoá lỗi, và tự chạy lại khi sự cố đã khắc phục. Epic khép lại bằng Màn chào 4 bước chạy trọn: kết nối trang → khoá OpenAI → hồ sơ → bật AI → khách nhắn và AI đã trả lời.

## Stories

- Story 5.1: Cấu hình AI trả lời theo nhóm và trang
- Story 5.2: Kho kiến thức
- Story 5.3: Thử AI trước khi bật
- Story 5.4: AI tự trả lời tin nhắn và chuyển cho bạn
- Story 5.5: AI trả lời bình luận công khai và nhắn riêng
- Story 5.6: AI dừng và chạy lại đúng lúc khi hết hạn mức hoặc khoá lỗi
- Story 5.7: Màn chào 4 bước chạy trọn

## Requirements & Constraints

- Cấu hình AI theo Nhóm/Trang có kế thừa: bật/tắt; giờ hoạt động `always|offhours|custom` với 7 khung ngày; kịch bản; kho kiến thức (file + FAQ); quy tắc chuyển người (từ khoá, khách yêu cầu gặp người, AI không chắc chắn) kèm câu chuyển tiếp `handoffMessage` (mặc định "Shop sẽ kiểm tra và phản hồi ngay ạ" [ASSUMPTION]); kênh `AutoreplyChannel` = `messenger|ig_direct|comment_public|comment_private`.
- Kịch bản trống hoặc không có kênh nào → API từ chối bật, FE báo dưới ô. Chưa có khoá OpenAI → công tắc AI khoá kèm banner "Thêm khoá OpenAI ở Cài đặt".
- "Lấy từ Hồ sơ thương hiệu" và "Mẫu theo ngành" là template xác định phía server từ hồ sơ hiệu lực, không gọi AI.
- Bật/Tắt AI hàng loạt ở bảng Trang & Nhóm: FE xác nhận trước; trang đang theo nhóm được chuyển sang cấu hình riêng (sao chép) rồi mới đổi `enabled`. `Page.autoReply` là dẫn xuất, không có cột riêng.
- Kho kiến thức: pdf/docx/txt, kiểm magic bytes và giới hạn kích thước; file lưu riêng tư (không URL công khai); tổng văn bản `ready` + FAQ vượt 40k token [ASSUMPTION] → không cho lưu cấu hình ở trạng thái bật (`KNOWLEDGE_TOO_LARGE`).
- "Thử AI" chạy đúng hàm quyết định của pipeline với cấu hình nháp (chưa lưu), bỏ qua cổng giờ và cửa sổ gửi, không gửi gì ra Meta, tính chi phí với feature `autoreply_test`.
- AI trả lời "trong vài giây": p95 ≤ 15 giây từ webhook tới lúc tin AI được gửi (gồm thời gian gộp tin), đo bằng log lượt chạy.
- Không hai lượt AI song song cho một hội thoại; không mất tin khách đến giữa lượt; Tiếp quản giữa lúc AI đang nghĩ thì quyết định bị bỏ, không gửi gì.
- Hết hạn mức/khoá lỗi: AI ngừng, hội thoại mới vào "Cần xử lý" với lý do tương ứng, không gửi câu chuyển tiếp; khắc phục xong thì tin khách kế tiếp đưa hội thoại về AI nếu chủ shop chưa trả lời.
- Log chỉ ghi id, không ghi nội dung tin, prompt, kịch bản.

## Technical Decisions

- **Sở hữu bảng (AD-1):** `profiles` sở hữu `autoreply_configs`, `knowledge_items`; `autoreply` sở hữu `autoreply_runs`. Hướng gọi: `autoreply → inbox|profiles|ai`, `profiles → ai`. Chỉ entrypoint (worker) gọi `autoreply`.
- **Kế thừa (AD-8):** `autoreply_configs` lưu theo `(owner_type, owner_id)` và đăng ký là một loại cấu hình của `profiles` (`ConfigKind` thêm `autoreply`). Chỉ `profiles.resolveEffective(pageId, 'autoreply')` giải "trang dùng cấu hình nào" → `{config, source}` hoặc `CONFIG_MISSING`. Bật "Dùng cấu hình AI riêng" sao chép cấu hình nhóm làm điểm xuất phát; tắt thì xoá cấu hình riêng; cả hai chỉ có hiệu lực khi Lưu. Đổi/xoá nhóm dùng chung xử lý sự kiện của Epic 3. Mọi bản ghi do AI sinh lưu `config_source` đã dùng.
- **Pipeline (AD-16):**
  - `message.received` (inbound) → `autoreply.triage` chạy ngay → nếu `ai` thì `autoreply.run` trễ 4 giây [ASSUMPTION] để gộp tin, queue `stately` `singletonKey=conversationId`.
  - `autoreply.run` chỉ chạy khi `state=ai`, hoặc `handoff` transient mà người chưa trả lời. Đọc `{state, stateVersion, lastInboundId}` lúc bắt đầu, áp quyết định qua `inbox.applyAutoreplyDecision` (khoá lạc quan); lệch → `outcome=superseded`.
  - Cổng theo thứ tự: `conversation.ai_enabled` → cấu hình hiệu lực bật (`CONFIG_MISSING`/`AI_OFF`) → kênh (`CHANNEL_OFF`) → giờ hoạt động (`OUTSIDE_HOURS`) → khoá OpenAI → hạn mức → `canSend` (`OUTSIDE_24H`) → tin có chữ (`NON_TEXT_MESSAGE`). Rồi luật từ khoá / "khách yêu cầu gặp người" chạy xác định, không qua LLM. Cuối cùng LLM structured output `{action, reply, mode, reasonCode, confidence}`; dưới ngưỡng → `AI_UNCERTAIN` (khi bật).
  - Handoff có câu chuyển tiếp: gửi tin AI trước, tin `system` sau. Cổng tạm đóng / không áp dụng không gửi gì. Bật cả hai kênh bình luận: một quyết định có thể gồm trả lời công khai ngắn và nhắn riêng chi tiết.
- **Phân loại lý do (AD-9):** không áp dụng (`AI_OFF`, `CHANNEL_OFF`, `CONFIG_MISSING`) → `human`, không vào handoff. Tạm đóng (`OUTSIDE_HOURS`, `OPENAI_KEY_UNAVAILABLE`, `AI_BUDGET_EXCEEDED`, `AI_PROVIDER_ERROR`) → `handoff` transient. Chủ ý (`KEYWORD`, `CUSTOMER_ASKED_HUMAN`, `AI_UNCERTAIN`, `AI_POLICY_BLOCKED`, `NON_TEXT_MESSAGE`, `OUTSIDE_24H`) → `handoff` sticky. Ánh xạ lỗi gateway: key missing/invalid → `OPENAI_KEY_UNAVAILABLE`; quota/rate/transient → `AI_PROVIDER_ERROR`; content rejected → `AI_POLICY_BLOCKED`.
- **Gateway và hậu kiểm (AD-7, AD-21):** gọi OpenAI chỉ qua `ai` (`feature=autoreply|autoreply_test`, `pageId`), hạn mức reserve/settle. Mọi `reply` qua `ai.checkOutput` trước khi lưu; vi phạm thì sinh lại một lần, còn vi phạm → `AI_POLICY_BLOCKED`.
- **Kho kiến thức (AD-14, AD-24):** upload → `PrivateFileStore` → `knowledge_items(status=processing)` + job `profiles.knowledge.extract` (standard, chống trùng bằng `UPDATE … WHERE status='processing'`, retry 2, concurrency 1, có timeout) → `ready|failed|too_large`, phát `knowledge_item.processed`. Prompt nhét toàn bộ văn bản `ready` + FAQ (không RAG ở v1).
- **Hàng đợi (AD-24):** `autoreply.triage` standard, retry 3, concurrency 10; `autoreply.run` stately `conversationId`, retry 2, concurrency 5.
- **Bình luận:** prompt đọc caption từ `post_text_snapshot` của hội thoại, không gọi `content`. Threads chỉ `public_reply`.

### Đã có, phải dùng lại

- **Module `inbox` (Epic 4):**
  - Máy trạng thái `triage|ai|handoff|human|done` với `state_version`, tin `system` có `reasonCode`, sự kiện `conversation.state_changed`. `getTriageState` + `applyTriageDecision` (khoá lạc quan) đã có. `applyAutoreplyDecision` **chưa có** — Story 5.4 thêm.
  - `autoreply/triage.ts` (`decideTriage`) hiện **luôn** trả `human`/`AI_OFF`, chạy cho cả hội thoại `triage` và `ai`. Story 5.4 thay bằng chuỗi cổng AD-16.
  - `canSend(conversationId, mode)` là chỗ duy nhất tính cửa sổ gửi. `sendMessage` hiện chỉ ghi `origin=app_human`. Job `inbox.send` (chiếm `pending→sending`, `metadata = messages.id`) dùng lại cho tin `app_ai`.
  - `post_text_snapshot` lấy qua job `inbox.fetch_post_text` lúc ingest bình luận.
  - Echo (AD-20): tin app tự gửi được khớp theo `metadata`/nội dung; echo không phải của app → `external_human` + `HUMAN_REPLIED` (tắt AI).
  - Tiếp quản / người gửi tin → `ai_enabled=false` (`applyHumanReply`).
- **Module `profiles` (Epic 3):**
  - Registry loại cấu hình (`REGISTRY`, ops `exists/get/copy/remove`), bảng `page_config_state(page_id, kind, use_own, awaiting_group_default)`.
  - `resolveEffective`, `setUseOwn`, `applyGroupChange`, `onGroupProfileSaved`.
  - Consumer `events.profiles` lặp qua `REGISTERED_KINDS` (= `CONFIG_KINDS`). Thêm `autoreply` vào `CONFIG_KINDS`, đăng ký ops và ALTER CHECK của `page_config_state.kind` là đủ để kế thừa và đổi nhóm chạy.
- **AI (Epic 1):**
  - Gateway `generateText` (reserve/settle `ai_budget_months`, ghi `ai_usage`).
  - `AiFeature` đã có `autoreply`, `autoreply_test`.
  - `checkOutput(text, {brand, kind})` và mẫu prompt `buildReplyPrompt` (đã dùng cho Gợi ý AI).
  - Trạng thái khoá OpenAI (`getOpenAiKeyStatus`).
- **Shared:** `AutoreplyChannel`, `HandoffReason`/`HandoffKind`, `StateChangeReason`, `KnowledgeStatus`, `ConfigSource`/`EffectiveConfig<T>` đã khai báo. Sự kiện `conversation.ai_typing`, `knowledge_item.processed` **chưa** khai báo.
- **Web:** `web/src/screens/AutoReply.tsx` (cây nhóm/trang, `AutoReplyForm` dùng cả ở Chi tiết trang/nhóm, khung "Thử AI" mô phỏng) đang chạy trên dữ liệu mẫu. Bảng Trang & Nhóm có thao tác hàng loạt Bật/Tắt AI chỉ đổi overlay mẫu.
- **Việc hoãn gắn Epic 5:**
  - Bật lại AI cho hội thoại khách đang chờ phải chạy cổng ngay (hiện chỉ chạy khi có `message.received` mới).
  - Xử lý tin `app_ai` gửi lỗi ("Gửi lại" hiện chỉ cho `app_human`).
  - Phản hồi tự động của Meta (Instant Reply…) bị coi là `external_human` → tắt AI; cần quyết định trước khi AI trả lời thật.
  - `checkOutput` cần giới hạn độ dài theo nền tảng (`maxChars`: Threads 500, IG DM 1000) để AI tự gửi không bị Meta từ chối.
  - Gửi hết giờ / 5xx có thể trùng tin. Rủi ro này tăng khi AI tự gửi.

## UX & Interaction Patterns

- **Màn `/ai-tra-loi`:**
  - Cây nhóm/trang bên trái. Nhóm hiện "Bật"/"Tắt". Trang hiện "Theo nhóm" hoặc "Riêng · Bật/Tắt". Trang chưa có nhóm nằm mục riêng.
  - Bên phải là cấu hình của mục đang chọn, kèm khung "Thử AI".
  - Cùng form nằm ở tab "AI trả lời" của Chi tiết trang/nhóm.
- **Nhãn kế thừa:** luôn ghi nguồn. Trang theo nhóm thì form chỉ để xem. Bật "Dùng cấu hình AI riêng" sao chép cấu hình nhóm làm điểm xuất phát; tắt thì hỏi xác nhận. Trang không có nhóm bắt buộc cấu hình riêng.
- **Thất bại:** chưa có khoá → công tắc khoá kèm banner. Kịch bản trống → báo dưới ô. Không có kênh → báo dưới phần Kênh.
- **Thử AI:** khung chat giả lập. Khi AI sẽ chuyển thì có ghi chú "AI sẽ chuyển cho bạn" kèm lý do.
- **Hộp thư:**
  - Chip tím "AI đang trả lời" và chấm "đang gõ" theo `conversation.ai_typing`. Tin AI có nhãn "AI trả lời"/"AI tạo". Màu tím chỉ dành cho thứ do AI làm.
  - Ghi chú hệ thống nêu lý do chuyển (map từ `HandoffReason`).
  - Hết hạn mức: hội thoại mới vào "Cần xử lý" với lý do "Hết hạn mức AI".
- **Màn chào `/bat-dau`:** chưa có trang thì chuyển tới đây. Endpoint tổng hợp trả trạng thái 4 bước. Cao trào: Webhook "Nhận tin gần nhất: vừa xong" và Hộp thư có tin AI đã gửi.

## Cross-Story Dependencies

- 5.1 là nền cho cả epic: dựng bảng cấu hình, đăng ký kế thừa, FE màn cấu hình và Bật/Tắt hàng loạt.
- 5.2 gắn kho kiến thức vào cấu hình của 5.1, và thêm kiểm `KNOWLEDGE_TOO_LARGE` khi lưu ở trạng thái bật.
- 5.3 cần hàm quyết định (luật từ khoá → LLM → `checkOutput`), nên làm cùng hoặc sau phần lõi của 5.4.
- 5.4 cần 5.1, 5.2, thêm `applyAutoreplyDecision` vào `inbox`, `autoreply_runs` và queue `autoreply.run`.
- 5.5 mở rộng 5.4 cho kênh bình luận.
- 5.6 dùng bảng ánh xạ lỗi gateway của 5.4.
- 5.7 cần 5.1 (có cấu hình đang bật) và luồng 5.4 chạy được.
- Epic 8 đọc tin `system` và tin `app_ai` để tính "Hiệu quả AI".
