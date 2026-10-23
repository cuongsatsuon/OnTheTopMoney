- source_spec: `spec-1-4-kenh-realtime-va-trung-tam-thong-bao.md`
  summary: Phát `job.failed` cả khi lần thử cuối hết hạn (expireInSeconds) hoặc worker chết, không chỉ khi handler ném lỗi.
  evidence: `reportExhausted` chỉ chạy trong `catch` của wrapper (server/src/platform/jobs/boss.ts); hiện chưa queue nào `critical: true`, nên làm ở story đầu tiên khai báo queue quan trọng (vd Story 4.1 `webhook.route`) — dùng dead-letter của pg-boss hoặc cron quét job `failed`.
- source_spec: `spec-1-5-nhap-va-kiem-khoa-openai.md`
  summary: Công cụ xoay khoá mã hoá (`crypto.reencrypt`): đếm bản ghi theo keyId và mã hoá lại bằng khoá active, để runbook biết khi nào gỡ khoá cũ an toàn.
  evidence: `SecretCipher.keyIdOf` có nhưng chưa ai gọi; runbook bảo gỡ khoá cũ "khi chắc không còn bản ghi nào dùng nó" mà không có cách kiểm. Làm ở Epic 2 khi token Meta cũng được mã hoá.
- source_spec: `spec-1-3c-fe-hostinger-be-vps.md`
  summary: Test tự động cho `deploy/hostinger/publish-web-hostinger.sh` (kiểm tham số, thứ tự upload, `--prune-assets`, `--skip-build`) với đích rsync giả.
  evidence: Hiện chỉ `bash -n`; script chạy tay với hosting bên thứ ba. Làm khi tự động hoá xuất bản web.
- source_spec: `spec-1-3c-fe-hostinger-be-vps.md`
  summary: Ghi bản web đang chạy trên Hostinger (marker commit) và cảnh báo khi rollback BE lệch phiên bản web.
  evidence: Chế độ external không có tương đương `IMAGE_TAG`/`WEB_ROOT/current`; runbook 8.4 bảo checkout commit cũ nhưng không biết commit nào đang chạy.
- source_spec: `spec-1-3c-fe-hostinger-be-vps.md`
  summary: Dùng `apiUrl()` (web/src/lib/api.ts, có từ Story 4.3 cho đính kèm Hộp thư) cho link `/privacy/*` khi màn quyền riêng tư có (Epic 9).
  evidence: Story 4.3 đã thêm `apiUrl()` theo `API_ORIGIN` và CSP `media-src` cho origin api; `/media/...` không còn dùng (ảnh công khai đi URL Cloudinary). Còn `/privacy/*` chưa có màn nào.
- source_spec: `spec-1-3d-web-chay-trong-docker.md`
  summary: Kiểm nén gzip của asset web qua nginx (Content-Encoding, một Vary) trong smoke-test.
  evidence: gzip đã dời vào container web (`deploy/web-nginx.conf`); không bước nào kiểm.
- source_spec: `spec-1-3d-web-chay-trong-docker.md`
  summary: Test CI "build web lỗi → IMAGE_TAG và container đang chạy giữ nguyên".
  evidence: Bước CI "xuất bản web lỗi → không đổi current" bị bỏ cùng cơ chế WEB_ROOT; cần cách cố ý làm hỏng build `ottm-web` (vd nginx -t lỗi) trong CI.
- source_spec: `spec-media-cloudinary.md`
  summary: Dọn file mồ côi trên Cloudinary (liệt kê `<folder>/private|public/*`, so với tham chiếu trong DB), kể cả sau khi khôi phục backup.
  evidence: Adapter chưa có thao tác liệt kê theo prefix; runbook chỉ nêu chiều ngược lại. Story 6.3 thêm cron `content.media_gc` nhưng chỉ dọn theo DB (dòng `media_assets` không gắn bài quá 7 ngày + file của dòng đó); file mà DB không còn trỏ tới (xoá file lỗi lúc dọn — `fileErrors` trong log, ghi DB lỗi sau khi tải lên, khôi phục backup) vẫn nằm trên kho.
- source_spec: `spec-media-cloudinary.md`
  summary: Job CI tuỳ chọn chạy `runMediaCheck` với tài khoản Cloudinary thử (secret `CLOUDINARY_URL_TEST`).
  evidence: Fake ký bằng chính `signParams` của adapter; tải file `authenticated` qua API download chưa được kiểm với Cloudinary thật.
- source_spec: `spec-2-4-han-token-va-ket-noi-lai.md`
  summary: Thông báo bền (notification) khi trang `page.disconnected` — hiện chỉ phát realtime, chủ shop không có cảnh báo lưu lại cho ca khẩn nhất.
  evidence: `events.notifications` subscribe `page.expiring` nhưng không `page.disconnected`; thêm cần enum NotificationType + prefs + FE. Làm khi mở rộng trung tâm thông báo.
- source_spec: `spec-2-4-han-token-va-ket-noi-lai.md`
  summary: Reconnect chặt: xác nhận account Meta vừa re-auth đúng là account của pageId đã bấm (lưu platform_account_id kỳ vọng vào intent, so ở confirm).
  evidence: Hiện confirm khớp theo (platform, platformAccountId); nếu auth account khác thì cập nhật/ tạo dòng khác, pageId intent không được ép. App một chủ nên rủi ro thấp.
- source_spec: `spec-3-1-ho-so-thuong-hieu.md`
  summary: Guard điều hướng TRONG APP khi form có thay đổi chưa lưu (hiện chỉ beforeunload cho đóng/tải lại tab) — áp cả app.
  evidence: React Router chưa dùng data API/useBlocker; AutoReply cũng chỉ beforeunload. Làm khi nâng router hoặc thêm cơ chế confirm điều hướng dùng chung.
- source_spec: `spec-4-1-cong-webhook.md`
  summary: GC/retention cho bảng `webhook_events` (payload chứa nội dung tin của khách — PII, tăng vô hạn).
  evidence: 4.1 ghi mọi mục webhook vĩnh viễn, chưa có cron dọn. Làm cùng vòng đời dữ liệu AD-22 / Story 9.3 (privacy retention).
- source_spec: `spec-4-1-cong-webhook.md`
  summary: Nhật ký webhook ở Cài đặt phân trang "xem thêm" (hiện cap 50 mục mới nhất; API đã trả nextCursor).
  evidence: useWebhookEvents chưa đọc nextCursor; panel chẩn đoán nên đủ 50 trước mắt.
- source_spec: `spec-4-2-dang-ky-webhook-va-suc-khoe.md`
  summary: Dead-letter + thông báo (critical) cho `webhook.route` hết retry — comment ở `queues.ts` từng hứa làm ở 4.2.
  evidence: 4.2 giữ `webhook.route` không critical (spec chỉ yêu cầu banner sức khoẻ, không tạo thông báo). Mục hỏng vẫn ghi `failed` + "Xử lý lại" ở nhật ký. Làm khi mở rộng trung tâm thông báo (cần NotificationType/prefs).
- source_spec: `spec-4-2-dang-ky-webhook-va-suc-khoe.md`
  summary: API sức khoẻ webhook coi trạng thái cũ là cũ khi `webhook_health.checked_at` quá ~2 chu kỳ cron (worker/cron chết).
  evidence: `getWebhookHealth` tin dòng cron bất kể `checked_at`; worker chết thì trạng thái `ok` giữ mãi.
- source_spec: `spec-4-2-dang-ky-webhook-va-suc-khoe.md`
  summary: Cho đăng ký lại webhook một trang lỗi (nút ở Cài đặt/Chi tiết trang hoặc cron thử lại FAILED/REJECTED).
  evidence: Chạy bù chỉ chọn trang chưa có lỗi; hiện trang FAILED chỉ phục hồi bằng kết nối lại OAuth.
- source_spec: `spec-4-2-dang-ky-webhook-va-suc-khoe.md`
  summary: Gỡ trang thì huỷ đăng ký `DELETE /{page}/subscribed_apps` ở Meta.
  evidence: `removePage` xoá credential nhưng Meta vẫn gửi sự kiện của trang đã gỡ, và chúng được tính là sự kiện thật trong health.
- source_spec: `spec-4-3-tin-dm-vao-hop-thu.md`
  summary: Dọn file đính kèm trên Cloudinary khi xoá khách/hội thoại (Epic 9) và khi đính kèm tải lên xong nhưng transaction ghi `stored` thất bại.
  evidence: `message_attachments` xoá theo cascade nhưng file `authenticated` ở Cloudinary không bị xoá; `privacy` (Epic 9) cần gọi `PrivateFileStore.delete` theo ref.
- source_spec: `spec-4-4-binh-luan-vao-hop-thu.md`
  summary: Sửa/thu hồi tin DM (Messenger `message_edit`, IG `is_deleted`) → `inbox.updateMessageText` / `markMessageRemoved`.
  evidence: Hàm đã có từ 4.4 nhưng parser 4.1 cho IG `is_deleted` cùng khoá `messages:<mid>` với tin gốc (bị chặn như trùng) và Messenger `message_edit` thành field `messaging`; cần khoá riêng + chuẩn hoá ở `webhook-message.ts`. Hiện vẫn `ignored`.
- source_spec: `spec-4-4-binh-luan-vao-hop-thu.md`
  summary: Xác nhận dạng payload webhook Threads `replies` (dạng `values` + `root_post.owner_id`) và bình luận FB thiếu `from` bằng sự kiện thật.
  evidence: Parser/chuẩn hoá Threads theo tài liệu mẫu [ASSUMPTION AD-4]; bình luận FB không có `from.id` đang bị bỏ qua (`malformed`) — nếu Meta lược `from` thật thì cần định danh dự phòng theo id bình luận.
- source_spec: `spec-4-4-binh-luan-vao-hop-thu.md`
  summary: Sửa/xoá/ẩn bình luận tới trước (hoặc chạy song song) lần thêm → `missing` → `ignored`, thay đổi mất; ẩn/bỏ ẩn lệch thứ tự không có mốc để so.
  evidence: `webhook.route` concurrency 10, FB tự ẩn bình luận theo từ khoá gần như cùng lúc `add`. Cần tombstone theo `(page_id, platform_message_id)` áp khi ingest, hoặc retry `missing` khi mục còn mới (không làm `failed` mục sửa bình luận cũ trước khi kết nối); ẩn/bỏ ẩn cần mốc thời gian (`entry.time`).
- source_spec: `spec-4-4-binh-luan-vao-hop-thu.md`
  summary: Trả lời Threads lồng nhiều cấp tới trước tin cha → `thread_key` = id tin cha, tách thành hội thoại riêng.
  evidence: `ingestComment` tra hội thoại của tin cha ngoài khoá luồng; tin cha chưa ingest thì dùng `parentId`. FB/IG không bị (cha luôn là bình luận gốc). Làm khi xác nhận payload Threads thật (có `root` id của luồng hay không).
- source_spec: `spec-4-7-gui-tin-24-gio.md`
  summary: Nhắn riêng tạo sẵn hội thoại `dm` với `origin_conversation_id` = hội thoại bình luận (AD-10/AD-11 bản đầy đủ).
  evidence: 4.7 chỉ gắn định danh `(page, recipient_id)` vào cùng khách; khách trả lời qua Messenger thì vào hội thoại `dm` mới của cùng khách nhưng không có liên kết ngược. (Phần "gợi ý gộp khi `recipient_id` đã thuộc khách khác" đã làm ở Story 4.9 — `contact_merge_suggestions`.) Story 5.5 (AI nhắn riêng người bình luận) làm việc này đáng làm hơn: khách trả lời tin nhắn riêng của AI qua Messenger thì vào hội thoại `dm` mới, lượt AI ở đó không thấy bình luận, caption hay câu AI vừa nhắn riêng (prompt chỉ đọc hội thoại hiện tại) — câu "ok lấy 2 cái" có thể thành `AI_UNCERTAIN`. AC 5.5 không đòi nên chưa làm.
- source_spec: `spec-4-7-gui-tin-24-gio.md`
  summary: Xác nhận bằng Meta thật: Send API `/me/messages` cho IG (token Fanpage nguồn), `metadata` cho IG, Threads publish container trả lời ngay sau khi tạo (tài liệu khuyên chờ), giới hạn ký tự IG 1000.
  evidence: Đường gửi mới chỉ chạy với Meta giả/fake client. Threads publish lỗi tạm thì retry tạo container mới (container cũ mồ côi, vô hại).
- source_spec: `spec-4-7-gui-tin-24-gio.md`
  summary: Gửi tin hết giờ / lỗi mạng (không có phản hồi HTTP) hoặc 5xx có thể đã tới Meta → không retry tự động mà ghi `failed` `SEND_UNKNOWN` (hoặc tra lại trước khi retry); Threads tách retry bước publish khỏi bước tạo container.
  evidence: `deliverMessage` (server/src/modules/inbox/send.ts) coi mọi `TRANSIENT` là retry được — `transientFailure()` của adapter gộp hết giờ, lỗi kết nối và 5xx — nên tin có thể tới khách 2–6 lần; Threads `threads_publish` hết giờ mà đã đăng thì retry tạo container mới và đăng lại. Cần adapter phân biệt "chưa gửi được" (DNS/kết nối bị từ chối) với "không rõ" (hết giờ sau khi gửi) và quyết định sản phẩm (AD-10 hiện ghi retry lỗi tạm). Story 4.5 giảm bớt: echo Messenger (`metadata`) tới trong 5 giây backoff đầu đặt tin `sent` nên lần retry không chiếm lại được; IG/Threads/bình luận và echo tới muộn vẫn có thể gửi trùng. Story 6.4 đã thêm cờ `notSent` ở adapter (`MetaFailure.notSent`: chặn trước khi gửi / không mở được kết nối) — `deliverMessage` có thể chỉ retry khi có cờ này, còn lại `SEND_UNKNOWN`, như `publish.target`.
- source_spec: `spec-4-5-nhan-dien-echo.md`
  summary: Xác nhận bằng sự kiện Meta thật: echo IG có `app_id`/`metadata` không, bình luận FB/IG của trang và trả lời Threads của tài khoản có về webhook không, IG `messaging_seen` dạng `read.mid`, Business Suite gửi `app_id` riêng.
  evidence: Phân loại echo (`server/src/modules/inbox/echo.ts`) theo tài liệu Meta; echo không `app_id` (bình luận, Threads, có thể IG) chỉ khớp được theo id/nội dung, không khớp thì sau ~15 giây coi là chủ shop trả lời ngoài app (`external_human`) — nếu Meta đổi chữ tin app gửi (vd rút gọn link) thì tin app có thể bị tính là ngoài app và tắt AI.
- source_spec: `spec-4-5-nhan-dien-echo.md`
  summary: Tin của trang vào luồng chưa có hội thoại (khách cũ trước khi kết nối, nhắn riêng từ Business Suite) đang bị bỏ (`ignored`).
  evidence: `ingestEcho` trả `no_conversation`, không tạo khách/hội thoại từ tin của trang; khi khách trả lời thì hội thoại mới không có tin trước đó của trang. Cân nhắc khi làm hội thoại `dm` từ nhắn riêng (việc hoãn của 4.7).
- source_spec: `spec-4-5-nhan-dien-echo.md`
  summary: Phản hồi tự động của Meta (Instant Reply, tin vắng mặt, câu hỏi thường gặp cấu hình trong Business Suite) bị coi là chủ shop trả lời ngoài app → hội thoại sang `human` và tắt AI.
  evidence: `echoAuthor` (server/src/modules/inbox/echo.ts) xếp mọi echo có `app_id` khác app mình vào `other_app` → `external_human` + `applyHumanReply` ngay; tin tự động của Meta có `app_id` của app Meta, payload không có cờ "tự động". Cần sự kiện thật để tìm dấu hiệu (app_id riêng, `metadata`, thời điểm ngay sau tin đầu của khách…) và quyết định sản phẩm (bỏ qua / chèn không đổi trạng thái). Story 5.4 (AI đã tự trả lời) đánh giá lại: không có dấu hiệu an toàn nào nếu chưa có payload thật — đoán theo thời điểm/nội dung có thể bỏ sót chủ shop trả lời thật trong Business Suite (AI chen ngang người). Hệ quả hiện tại: trang bật Instant Reply của Meta thì hội thoại mới sang `human` (AI tắt) ngay tin đầu → nên hướng dẫn chủ shop tắt Instant Reply / tin vắng mặt khi bật AI, cho tới khi có sự kiện thật. Story 5.7: Màn chào (pha "Đang chờ tin đầu tiên") đã nhắc chủ shop tắt Trả lời tức thì / tin vắng mặt; quyết định sản phẩm vẫn còn mở.
- source_spec: `spec-4-8-goi-y-bang-ai.md`
  summary: Kiểm bằng trình duyệt nút "Gợi ý bằng AI" (Dừng, Hoàn tác, tooltip khoá theo nguồn) và "Viết thử bằng AI" sau khi đổi cách bắt huỷ request.
  evidence: Chỉ có test HTTP thật (fetch + AbortController) và test helper web; chưa chạy UI với phiên chủ shop + trang đã kết nối + khoá OpenAI.
- source_spec: `spec-4-9-khach-hang.md`
  summary: Kiểm bằng trình duyệt màn Khách hàng (lọc, hàng loạt, ngăn kéo: hồ sơ, lịch sử, Gộp khách, Tóm tắt bằng AI) và panel khách trong Hộp thư.
  evidence: Chỉ có test API (Postgres thật, fake OpenAI) và test helper web; chưa chạy UI với phiên chủ shop + trang đã kết nối + khoá OpenAI + worker chạy job `inbox.contact_summary`.
- source_spec: `spec-4-9-khach-hang.md`
  summary: "Bỏ qua" gợi ý gộp khách (chủ shop không muốn gộp) — hiện gợi ý chỉ mất khi gộp.
  evidence: `contact_merge_suggestions` không có cờ bỏ qua; gợi ý chỉ sinh khi Meta xác nhận cùng người (nhắn riêng) nên hiếm khi sai. Thêm `DELETE /api/v1/contacts/:id/merge-suggestions/:otherId` nếu chủ shop phản ánh.
- source_spec: `spec-4-9-khach-hang.md`
  summary: Đua giữa gộp khách và nhắn riêng thành công — `linkRecipient` có thể ghi định danh / gợi ý gộp trỏ tới khách nguồn vừa bị gộp (xoá).
  evidence: `linkRecipient` (server/src/modules/inbox/send.ts) đọc `contact_id` của hội thoại rồi mới `insert contact_identities` / `suggestMerge`, không khoá dòng `contacts`; `mergeContacts` (server/src/modules/inbox/contacts.ts) commit xen giữa → lỗi khoá ngoại 23503, transaction giao tin rollback sau khi Meta đã nhận tin (retry có thể gửi trùng). Hiếm (gộp đúng lúc job gửi nhắn riêng); sửa bằng `select … for key share` dòng khách trong `linkRecipient` hoặc đọc lại `contact_id` khi gặp 23503.
- source_spec: `spec-4-10-tim-nhanh.md`
  summary: Kiểm bằng trình duyệt bảng lệnh ⌘K/Ctrl+K (mở/đóng, ↑/↓/↵/Esc, Esc không đóng ngăn kéo bên dưới, "Đổi phạm vi" mở bộ chọn, mở khách vào ngăn kéo Khách hàng) với trang/khách thật.
  evidence: Chỉ có test API (Postgres thật) và test helper web (`web/src/lib/search.test.ts`); chưa chạy UI với phiên chủ shop + dữ liệu thật.
- source_spec: `spec-5-1-cau-hinh-ai-tra-loi.md`
  summary: Kiểm bằng trình duyệt màn `/ai-tra-loi` với nhóm/trang thật: cây "Bật"/"Theo nhóm"/"Riêng · …", lưu nhóm/trang, "Dùng cấu hình AI riêng" (bật sao chép, tắt hỏi lại), "Lấy từ Hồ sơ thương hiệu"/"Mẫu theo ngành", lỗi dưới ô; Bật/Tắt AI hàng loạt có xác nhận ở Trang & Nhóm.
  evidence: Chỉ có test API (Postgres thật) và test helper web (`web/src/lib/autoreply.test.ts`); chưa chạy UI với phiên chủ shop + trang đã kết nối.
- source_spec: `spec-5-2-kho-kien-thuc.md`
  summary: Kiểm bằng trình duyệt mục Kho kiến thức ở `/ai-tra-loi` và tab "AI trả lời" (thêm FAQ, tải PDF/DOCX/TXT, dòng "AI đang đọc nội dung…" tự đổi theo realtime, xoá, mức dùng token, lỗi "cần rút gọn" khi bật, trang theo nhóm chỉ xem, bật "Dùng riêng" chưa Lưu).
  evidence: Chỉ có test API (Postgres thật, Cloudinary giả, thread trích thật) và test helper web; chưa chạy UI với phiên chủ shop + Cloudinary thật + worker.
- source_spec: `spec-5-2-kho-kien-thuc.md`
  summary: Quét mục kho kiến thức kẹt `processing` (worker chết giữa lúc trích, hết 3 lượt do `expireInSeconds`) → `failed EXTRACT_TIMEOUT`, như `inbox.send_sweep`.
  evidence: Thread trích có timeout + giới hạn bộ nhớ nên lỗi thường đã thành `failed`; chỉ khi cả tiến trình worker chết thì mục kẹt "AI đang đọc nội dung…" mãi (chủ shop xoá rồi tải lại được). Cũng gồm cửa sổ hẹp: sao chép kho kế thừa đúng lúc job kết thúc file (bản sao chèn sau `UPDATE … WHERE status='processing'`).
- source_spec: `spec-5-2-kho-kien-thuc.md`
  summary: Thử trích văn bản với file thật của chủ shop (PDF tiếng Việt xuất từ Word/Google Docs/Canva — font CID + ToUnicode, DOCX có bảng nhiều cấp) và đo thời gian/bộ nhớ với PDF 10 MB.
  evidence: Test dựng PDF Helvetica tối giản + docx tự sinh; pdf.js (`unpdf` 1.8.1) xử lý font CID nhưng chưa thử bằng file thật, giới hạn 60 giây / 256 MB heap là [ASSUMPTION].
- source_spec: `spec-5-3-thu-ai.md`
  summary: Kiểm bằng trình duyệt khung "Thử AI" với nhóm/trang thật + khoá OpenAI thật (AI đang gõ, Dừng, chọn kênh thử, ghi chú "AI sẽ chuyển cho bạn · …", thử khi AI tắt, lỗi kho quá lớn) và chất lượng câu trả lời của structured output thật (ngưỡng tin cậy 0.6 [ASSUMPTION]).
  evidence: Chỉ có test API (Postgres thật, OpenAI giả trả JSON dựng sẵn) và test helper web; chưa gọi `text.format: json_schema` với OpenAI thật, chưa chạy UI với phiên chủ shop.
- source_spec: `spec-5-4-ai-tu-tra-loi.md`
  summary: Kiểm bằng trình duyệt + Meta/OpenAI thật luồng AI tự trả lời: chip "AI đang trả lời" kèm chấm đang gõ, bong bóng "AI đang trả lời…", tin tím "AI trả lời", ghi chú chuyển người, "Gửi lại" tin AI lỗi; đo p95 NFR1 (webhook → `sent_at`) bằng câu SQL trong spec.
  evidence: Chỉ có test Postgres thật + OpenAI/Meta giả (`server/test/autoreply-run.test.ts`) và test helper web; chưa chạy worker thật với `autoreply.run` stately trễ 4 giây, chưa có số đo độ trễ thật.
- source_spec: `spec-5-5-ai-tra-loi-binh-luan.md`
  summary: Kiểm bằng trình duyệt + Meta/OpenAI thật luồng AI trả lời bình luận: hai tin (công khai + nhắn riêng) với structured output `privateReply` thật, nhắn riêng IG qua token Fanpage nguồn, trả lời Threads, nhãn "AI trả lời công khai" / "AI nhắn riêng" ở khung Thử AI, câu lý do bình luận ở Hộp thư.
  evidence: Chỉ có test Postgres thật + OpenAI/Meta giả (`server/test/autoreply-comment.test.ts`) và test helper web; chưa chạy worker thật, chưa đo thời gian chờ caption thật (`POST_TEXT_WAIT_MS` 10 giây [ASSUMPTION]).
- source_spec: `spec-5-5-ai-tra-loi-binh-luan.md`
  summary: Bình luận bị ẩn (chủ shop ẩn, hoặc Facebook tự ẩn theo bộ lọc từ khoá / số điện thoại) thì AI không trả lời và hội thoại giữ `ai` — không vào "Cần xử lý".
  evidence: Story 5.5 coi bình luận đã xoá/ẩn là "đã gỡ": tin cần trả lời bỏ qua tin `removal` khác null (`inbox/autoreply.ts` `readAutoreplyTurn`), `autoreplySendCheck` chặn trả lời công khai dưới gốc đã ẩn. Hợp với ẩn tay / spam, nhưng shop bật "ẩn bình luận có số điện thoại" thì khách để lại SĐT không ai thấy trong "Cần xử lý". Cần quyết định sản phẩm (vd ẩn → `handoff` lý do riêng, hoặc chỉ nhắn riêng) và cần sự kiện thật để biết ẩn tự động có về webhook `feed` `hide` không.
- source_spec: `spec-5-6-ai-dung-va-chay-lai.md`
  summary: Kiểm bằng trình duyệt + OpenAI thật luồng dừng/chạy lại: hết hạn mức → hội thoại mới vào "Cần xử lý" với ghi chú "Đã hết hạn mức AI…"; tăng hạn mức / sửa khoá rồi khách nhắn → ghi chú "AI đang trả lời hội thoại này", chip "AI đang trả lời" và tin AI hiện qua realtime; câu "Không gửi được tin AI cho khách".
  evidence: Chỉ có test Postgres thật + OpenAI/Meta giả (`server/test/autoreply-resume.test.ts`) và test helper web; chưa chạy worker thật với hạn mức / khoá thật.
- source_spec: `spec-5-6-ai-dung-va-chay-lai.md`
  summary: `handoff` tạm đóng giữ lý do cũ khi nguyên nhân đổi sang lý do tạm đóng khác (vd vào lúc `OUTSIDE_HOURS`, tới giờ thì hết hạn mức) — ghi chú ở Hộp thư có thể lỗi thời cho tới khi AI chạy lại.
  evidence: Spec 5.6 chọn không ghi tin `system` / thông báo mới khi lượt khôi phục vẫn tạm đóng (`run.ts` `stillClosed`, `applyAutoreplyDecision` `unchanged`) để không dồn ghi chú mỗi tin khách. Nếu chủ shop phản ánh, cập nhật `state_reason` tại chỗ (không tăng `state_version`, không tin `system`) hoặc chỉ khi lý do đổi.
- source_spec: `spec-5-6-ai-dung-va-chay-lai.md`
  summary: Hết hạn mức / khoá lỗi giữa giờ cao điểm sinh một thông báo `ai_handoff` cho MỖI hội thoại mới vào "Cần xử lý" — có thể dồn hàng chục thông báo cùng lý do.
  evidence: `notifications.draftFor` báo mọi `conversation.state_changed` sang `handoff` (dedupe theo phiên bản). Banner hạn mức / khoá đã có ở web; cân nhắc gộp thông báo tạm đóng theo lý do trong một khoảng thời gian.
- source_spec: `spec-5-6-ai-dung-va-chay-lai.md`
  summary: Chủ shop trả lời ngoài app (bình luận FB/IG, DM IG — echo không có `app_id`) rồi khách nhắn tiếp trong ~15–20 giây → lượt khôi phục `handoff → ai` không thấy tin của chủ shop, AI trả lời chen.
  evidence: `ingestEcho` (server/src/modules/inbox/echo.ts) hoãn echo tác giả `unknown` qua `inbox.echo_match` 5 giây × 3 trước khi ghi `external_human` + `applyHumanReply`; trong lúc đó hội thoại vẫn `handoff` tạm đóng, `applyAutoreplyDecision` chỉ thấy tin outbound đã ghi. Cùng cửa sổ có ở hội thoại `ai` từ 5.4 nhưng ở `handoff` chủ shop được kỳ vọng trả lời nên dễ gặp hơn. Hướng sửa: lượt khôi phục bỏ qua khi còn job `inbox.echo_match` chờ cho luồng, hoặc ghi dấu "echo chờ khớp" lên hội thoại.
- source_spec: `spec-5-6-ai-dung-va-chay-lai.md`
  summary: Dữ liệu trước 5.6: hội thoại `handoff` `AI_PROVIDER_ERROR` do tin AI gửi lỗi (trước khi có `AI_SEND_FAILED`) nay thành khôi phục được — AI có thể chạy lại ở tin khách kế tiếp dù tin `SEND_UNKNOWN` có thể đã tới khách.
  evidence: Migration `0026_material_vermin.sql` chỉ đổi CHECK, không đổi `state_reason` cũ. Chỉ đáng sửa nếu đã có dữ liệu thật từ 5.4/5.5: cập nhật `state_reason='AI_SEND_FAILED'` cho hội thoại `handoff` `AI_PROVIDER_ERROR` có tin `app_ai` `failed` (mã khác cửa sổ) ngay trước tin `system` cuối.
- source_spec: `spec-5-7-man-chao-4-buoc.md`
  summary: Kiểm bằng trình duyệt + Meta/OpenAI thật Màn chào chạy trọn: mở `/` khi chưa có trang → `/bat-dau`, "Bỏ qua" vào được Tổng quan, bước 3–4 "Xong" khi quay lại từ Chi tiết trang / AI trả lời, pha "Đang chờ tin đầu tiên" → cao trào "AI đã trả lời khách đầu tiên" qua realtime, "Mở Hộp thư" mở đúng hội thoại; Cài đặt › Webhook "vừa xong" ngay khi tin về.
  evidence: Chỉ có test API (Postgres thật) và test helper web (`web/src/lib/onboarding.test.ts`); chưa chạy UI với phiên chủ shop (dev không có mật khẩu mẫu) + worker + OpenAI thật.
- source_spec: `spec-5-7-man-chao-4-buoc.md`
  summary: Lối quay lại Màn chào từ Chi tiết trang / AI trả lời sau khi lưu hồ sơ hoặc bật AI (hiện chỉ nút Back của trình duyệt hoặc liên kết "Xem màn chào lần đầu" cuối Tổng quan).
  evidence: Bước 3–4 điều hướng sang màn khác; cao trào chỉ hiện khi đang ở `/bat-dau`. Cân nhắc tham số `?tu=bat-dau` để hai màn đó hiện "Quay lại Màn chào" nếu chủ shop lạc đường.
- source_spec: `spec-5-7-man-chao-4-buoc.md`
  summary: `GET /api/v1/onboarding` giải hồ sơ / cấu hình AI hiệu lực tuần tự từng trang (N+1): shop nhiều trang mà chưa trang nào có hồ sơ / AI bật → hàng trăm truy vấn mỗi lần gọi, Màn chào gọi lại ở mọi `message.*`.
  evidence: `server/src/app/read-models/onboarding.ts` `someAsync` gọi `profiles.resolveEffectiveOrNull` (~3–4 truy vấn/trang × 2 loại) tới trang đầu tiên thoả. Chỉ Màn chào dùng nên chấp nhận lúc này; nếu chậm, thêm hàm giải theo lô trong `profiles` (vẫn một chỗ giải kế thừa — AD-8) hoặc dùng chung với `autoreplyOverview` (cùng mẫu N+1).
- source_spec: `spec-6-1-soan-bai-nhap.md`
  summary: Kiểm bằng trình duyệt + Cloudinary thật màn Soạn bài:
    - chọn nhóm/trang theo Phạm vi, tab từng trang, bộ đếm và dòng lỗi luật nền tảng;
    - tải ảnh, gắn ảnh theo tab / cho mọi trang;
    - "Lưu nháp" rồi mở lại `/soan-bai?bai=<id>`;
    - chạy `npm run media:check` để xác nhận Cloudinary nhận `a_exif,cs_srgb,fl_force_strip.strip_profile` và ảnh ra JPEG sRGB; tải một ảnh điện thoại dọc có EXIF `Orientation` ≠ 1 + GPS, kiểm bản gốc đứng đúng chiều và không còn EXIF.
  evidence: Chỉ có test API (Postgres thật, Cloudinary giả không đọc `transformation`) và test helper web (`web/src/lib/composer.test.ts`). Chưa chạy UI với phiên chủ shop, và chưa gửi incoming transformation `cs_srgb` [ASSUMPTION] lên Cloudinary thật.
- source_spec: `spec-6-2-caption-ai.md`
  summary: Kiểm bằng trình duyệt + OpenAI thật nút AI ở Soạn bài:
    - "Tạo bằng AI" cho 3 trang (một trang chưa có hồ sơ → tab báo + "Tạo hồ sơ"), Dừng giữa chừng giữ nguyên nội dung;
    - "Viết bằng AI cho N trang", Viết lại / Ngắn hơn / Thêm CTA trên một tab, cụm vi phạm được đánh dấu;
    - khoá nút khi khoá OpenAI hỏng / hết hạn mức; chất lượng caption theo nền tảng và độ dài (`COMPOSE_MAX_OUTPUT_TOKENS` 1.200 [ASSUMPTION]).
  evidence: Chỉ có test API (Postgres thật, OpenAI giả) và test helper web (`web/src/lib/composer.test.ts`); chưa chạy UI với phiên chủ shop (dev không có mật khẩu mẫu) + khoá OpenAI thật.
- source_spec: `spec-6-2-caption-ai.md`
  summary: Trả lời công khai / Gợi ý AI / AI tự trả lời trên Threads vẫn hậu kiểm độ dài bằng code point — nên truyền `platform` vào `checkOutput` (đã hỗ trợ từ 6.2) nếu trả lời Threads cũng bị Meta đếm emoji theo byte.
  evidence: 6.2 thêm `checkOutput({platform})` và chỉ Soạn bài truyền; `inbox/suggest.ts`, `autoreply` giữ cách đếm cũ. Tài liệu Meta chỉ nêu giới hạn emoji ở "Threads Posts" (trả lời cũng là post) — cần thử bằng Meta thật trước khi đổi.
- source_spec: `spec-6-2-caption-ai.md`
  summary: Soạn bài viết song song 3 trang khi hạn mức còn sát: chỗ giữ của các trang đang chạy làm trang sau gặp `AI_BUDGET_EXCEEDED` dù hạn mức chưa hết (`remainingVnd > 0`) → thành mã dừng cho các trang chưa bắt đầu, FE khoá mọi nút AI ("hết hạn mức") tới khi trạng thái hạn mức đổi.
  evidence: `content/compose.ts` `STOP_CODES` gồm `AI_BUDGET_EXCEEDED` không phân biệt `details.remainingVnd`; `ai/budget.ts` `reserve` cộng chỗ giữ đang mở. Hướng sửa: chỉ coi là mã dừng khi `remainingVnd === 0` (còn lại → lỗi riêng trang, có "Thử lại"), FE chỉ khoá theo `lockCode` đó.
- source_spec: `spec-6-3-sinh-anh-ai.md`
  summary: Kiểm bằng trình duyệt + OpenAI / Cloudinary thật, worker chạy, luồng ảnh AI ở Soạn bài:
    - "Tạo bằng AI" (bật "Kèm 4 ảnh AI") → 4 ô "Đang tạo ảnh…" đổi dần thành ảnh qua realtime; chọn ảnh cho từng tab, "Tạo lại ảnh" giữ ảnh đang gắn;
    - mô tả vi phạm chính sách → ô "Không tạo được ảnh này" + "Thử mô tả khác" (focus ô Mô tả ảnh), caption giữ nguyên;
    - chất lượng ảnh của `gpt-image-*` với prompt tiếng Việt (`ai/prompts/image.ts`, "không chữ trong ảnh"); thời gian sinh thật so với hạn job 240 giây.
  evidence: Chỉ có test API (Postgres thật, pg-boss, OpenAI + Cloudinary giả — `server/test/content-images.test.ts`) và test helper web (`web/src/lib/composer.test.ts`); chưa chạy UI với phiên chủ shop + worker + khoá OpenAI thật.
- source_spec: `spec-6-3-sinh-anh-ai.md`
  summary: Ô ảnh AI chưa gắn tab mất khỏi lưới khi tải lại trang / mở lại nháp (FE chỉ theo dõi id của lần sinh trong phiên) — ảnh vẫn còn trên kho tới khi cron dọn sau 7 ngày.
  evidence: `media_assets` không gắn với bài; `draftFromPost` chỉ dựng kho ảnh từ ảnh đang gắn target. Nếu chủ shop phản ánh mất ảnh vừa sinh: lưu `post_id` cho ô ảnh AI (bài đã lưu) hoặc giữ danh sách id trong `sessionStorage` theo `?bai=`.
- source_spec: `spec-6-3-sinh-anh-ai.md`
  summary: Ảnh AI đã tính tiền có thể mất hoặc bị tính lại: kho (Cloudinary) lỗi tạm sau khi OpenAI đã trả ảnh → ô `failed IMAGE_FAILED` ngay, ảnh bỏ đi; lời gọi hết giờ sau khi gửi (`maybeBilled`, gateway ghi chi phí ước tính) ném `AI_PROVIDER_ERROR` 502 → job retry gọi OpenAI lần nữa (tối đa 3 lần tính tiền cho một ô).
  evidence: `content/images.ts` `generateImageAsset` (`put` lỗi → `markFailed`, `retryable` coi mọi `AI_PROVIDER_ERROR` ≥500 là thử lại được); `ai/gateway.ts` `runCall` nhánh `maybeBilled`. Hướng sửa: thử `put` lại 1 lần trong job trước khi `failed`; gateway đưa `maybeBilled` vào `details` để job không retry lời gọi có thể đã tính tiền.
- source_spec: `spec-6-4-len-lich-va-dang-bai.md`
  summary: Kiểm bằng Meta / Cloudinary thật luồng đăng bài:
    - FB `/{page}/photos` nhận `message` (không phải `caption`) và trả `post_id`; `/{page}/feed`; `permalink_url`;
    - IG container `image_url` có transformation `c_pad,w_,h_,b_white` (Cloudinary giao biến đổi theo yêu cầu — tài khoản bật "strict transformations" sẽ chặn), `status_code`, `media_publish`, `content_publishing_limit`, giới hạn 100 bài/24h;
    - Threads `IMAGE` / `TEXT`, `status`, `threads_publishing_limit` (250/24h);
    - hành vi thật khi `media_publish` / `threads_publish` hết giờ (container chuyển `PUBLISHED`?), mã lỗi IG khi hết hạn mức đăng.
  evidence: Chỉ có test với Meta giả (`server/test/content-publish.test.ts`) và test helper web (`web/src/lib/publish.test.ts`); chưa chạy worker với trang thật, chưa thử `npm run media:check` với URL `c_pad`. Thời gian hỏi container (3 giây × 20) là [ASSUMPTION].
- source_spec: `spec-6-4-len-lich-va-dang-bai.md`
  summary: Sửa nội dung target đã rời nháp:
    - target `failed` (`PUBLISH_REJECTED` — câu lỗi bảo "Sửa nội dung rồi đăng lại") chỉ "Đăng lại" được với nội dung cũ, chưa có `failed → draft` hay sửa caption của riêng target đó;
    - bài lẫn trạng thái (vd 2 trang đã đăng + 1 trang bỏ lịch về nháp, hoặc 1 trang đã xoá `cancelled` + 1 trang nháp) không sửa được nháp vì `updateDraftPost` đòi mọi target `draft` và Soạn bài khoá cả bài (`isLocked`).
  evidence: Story 6.5 đã thêm xoá (`cancel` → `cancelled` + `USER_DELETED`) và Lịch nội dung; phần sửa cần khoá theo từng tab ở Composer + `updateDraftPost` bỏ qua (không xoá) target đã rời nháp — đổi lớn ở Composer, chưa có AC nào đòi. Tạm thời: "Bỏ lịch" (bài 1 trang) rồi sửa, hoặc xoá và soạn lại.
- source_spec: `spec-6-4-len-lich-va-dang-bai.md`
  summary: Job `publish.target` hết hạn (300 giây) trong lúc handler vẫn chạy rồi trả target về `scheduled` (lỗi tạm ở bước container) → không còn job nào chiếm lại cho tới lần cron `content.requeue` kế tiếp (trễ 10–25 phút).
  evidence: `publish.ts` `retryLater` ném lỗi cho job đã hết hạn (pg-boss bỏ qua); an toàn (không đăng trùng) nhưng trễ. Hiếm vì mỗi lời gọi Meta ≤30 giây. Hướng sửa: `retryLater` enqueue job mới `startAfter` khi `job.signal` đã huỷ.
- source_spec: `spec-6-4-len-lich-va-dang-bai.md`
  summary: Bài đã lên nhưng target vẫn `failed PUBLISH_UNKNOWN` khi cron `content.requeue` đổi target kẹt `publishing` trước lúc handler cũ ghi `published`.
  evidence: `content/publish.ts` `markPublished` chỉ nhận `status='publishing'`; `finishPublished` chỉ log khi không cập nhật được. Chủ shop thấy lỗi rồi "Đăng lại" → đăng trùng. Rất hiếm (handler phải chạy >15 phút). Hướng sửa: `markPublished` nhận cả `failed` + `error_code='PUBLISH_UNKNOWN'` cùng `schedule_version` (xoá `error_code`, phát `post_target.published`).
- source_spec: `spec-6-5-lich-noi-dung.md`
  summary: Kiểm bằng trình duyệt Lịch nội dung `/lich` + tab "Lịch đăng" của Chi tiết trang với phiên chủ shop + worker (`META_FAKE=1`):
    - tuần / tháng theo giờ VN, lọc Phạm vi / nền tảng / trạng thái, ô "AI tạo", bài nhiều trang gom một ô;
    - kéo thả (HTML5 drag & drop) đổi ngày / giờ, thả về quá khứ, bài đã đăng không kéo được; bài lỗi đỏ + "Đăng lại";
    - ngăn chi tiết: Đổi giờ, Bỏ lịch, Xoá (xác nhận), Mở ở Soạn bài, Xem bài.
  evidence: Chỉ có test API (Postgres thật, `server/test/content-calendar.test.ts`) và test helper web (`web/src/lib/calendar.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu). Kéo thả HTML5 không dùng được trên màn cảm ứng — ngăn chi tiết có ô ngày giờ thay thế.
- source_spec: `spec-6-5-lich-noi-dung.md`
  summary: Lịch ở tab / máy khác không tự cập nhật khi đổi giờ / bỏ lịch / lên lịch (chỉ `post_target.published|failed|cancelled` có sự kiện realtime).
  evidence: `transitionTarget` chỉ phát sự kiện khi xoá; web làm cũ `['post_targets']` sau mỗi lần tự chuyển trạng thái. Nếu Epic 7 tự lên lịch slot thì cần sự kiện kiểu `post_target.scheduled` (shared `events.ts`) để lịch đang mở thấy ngay.
- source_spec: `spec-6-5-lich-noi-dung.md`
  summary: Kéo thả một ô slot chiến dịch (nhiều bài 1 : 1 gom theo giờ) gửi mỗi bài một request — không nguyên tử: một bài lỗi (409 / giới hạn/24h) thì các bài trước đã đổi giờ.
  evidence: `web/src/lib/calendar.ts` `groupCalls`; route chuyển trạng thái theo từng bài. Hiện `campaignId` luôn `null` (cột có ở Epic 7). Khi Epic 7 thêm slot: cân nhắc route chuyển trạng thái theo danh sách target nhiều bài, hoặc chấp nhận và báo "Đã dời n/m bài".
