- source_spec: `spec-7-5-tam-dung-tiep-tuc-xoa.md`
  summary: Kiểm bằng trình duyệt Tạm dừng / Tiếp tục / Xoá với phiên chủ shop + worker:
    - `/chien-dich`: Tạm dừng → thẻ "Tạm dừng" + lý do, hàng đợi bỏ bài của chiến dịch đó; Tiếp tục → toast "bỏ n bài lỡ giờ" khi có; trang mất kết nối → câu lỗi theo mã;
    - Xoá (cả nháp) → hộp xác nhận → thẻ mất, bài đã đăng vẫn trên Lịch;
    - Tổng quan: nút Tạm dừng / Tiếp tục + dòng lý do; Lịch: ô "· Tạm dừng" + ghi chú trong ngăn.
  evidence: Chỉ có test API (Postgres thật, `server/test/campaigns-lifecycle.test.ts`) và test helper web (`web/src/lib/campaigns.test.ts`, `calendar.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu).
- source_spec: `spec-7-5-tam-dung-tiep-tuc-xoa.md`
  summary: Thao tác hàng loạt của chiến dịch (tạm dừng / tiếp tục huỷ bài lỡ giờ / xoá) không phát `post_target.cancelled` từng bài — chỉ một sự kiện `campaign.paused|resumed|deleted`.
  evidence: `content/slots-hold.ts`; web làm cũ Lịch theo sự kiện `campaign.*`. Consumer cần từng bài (vd Epic 8 thống kê bài huỷ, 7.6 nếu đếm theo `post_target.*`) phải đọc lại theo `campaign_id` hoặc thêm phát sự kiện theo lô.
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
- source_spec: `spec-1-3d-web-chay-trong-docker.md`
  summary: Kiểm nén gzip của asset web qua nginx (Content-Encoding, một Vary) trong smoke-test.
  evidence: gzip đã dời vào container web (`deploy/web-nginx.conf`); không bước nào kiểm.
- source_spec: `spec-1-3d-web-chay-trong-docker.md`
  summary: Test CI "build web lỗi → IMAGE_TAG và container đang chạy giữ nguyên".
  evidence: Bước CI "xuất bản web lỗi → không đổi current" bị bỏ cùng cơ chế WEB_ROOT; cần cách cố ý làm hỏng build `ottm-web` (vd nginx -t lỗi) trong CI.
- source_spec: `spec-media-cloudinary.md`
  summary: Job CI tuỳ chọn chạy `runMediaCheck` với tài khoản Cloudinary thử (secret `CLOUDINARY_URL_TEST`).
  evidence: Fake ký bằng chính `signParams` của adapter; tải file `authenticated` qua API download chưa được kiểm với Cloudinary thật.
- source_spec: `spec-2-4-han-token-va-ket-noi-lai.md`
  summary: Reconnect chặt: xác nhận account Meta vừa re-auth đúng là account của pageId đã bấm (lưu platform_account_id kỳ vọng vào intent, so ở confirm).
  evidence: Hiện confirm khớp theo (platform, platformAccountId); nếu auth account khác thì cập nhật/ tạo dòng khác, pageId intent không được ép. App một chủ nên rủi ro thấp.
- source_spec: `spec-3-1-ho-so-thuong-hieu.md`
  summary: Guard điều hướng TRONG APP khi form có thay đổi chưa lưu (hiện chỉ beforeunload cho đóng/tải lại tab) — áp cả app.
  evidence: React Router chưa dùng data API/useBlocker; AutoReply cũng chỉ beforeunload. Làm khi nâng router hoặc thêm cơ chế confirm điều hướng dùng chung.
- source_spec: `spec-4-1-cong-webhook.md`
  summary: Nhật ký webhook ở Cài đặt phân trang "xem thêm" (hiện cap 50 mục mới nhất; API đã trả nextCursor).
  evidence: useWebhookEvents chưa đọc nextCursor; panel chẩn đoán nên đủ 50 trước mắt.
- source_spec: `spec-4-2-dang-ky-webhook-va-suc-khoe.md`
  summary: Dead-letter + thông báo (critical) cho `webhook.route` hết retry — comment ở `queues.ts` từng hứa làm ở 4.2.
  evidence: 4.2 giữ `webhook.route` không critical (spec chỉ yêu cầu banner sức khoẻ, không tạo thông báo). Mục hỏng vẫn ghi `failed` + "Xử lý lại" ở nhật ký. Làm khi mở rộng trung tâm thông báo (cần NotificationType/prefs).
- source_spec: `spec-4-2-dang-ky-webhook-va-suc-khoe.md`
  summary: Cho đăng ký lại webhook một trang lỗi (nút ở Cài đặt/Chi tiết trang hoặc cron thử lại FAILED/REJECTED).
  evidence: Chạy bù chỉ chọn trang chưa có lỗi; hiện trang FAILED chỉ phục hồi bằng kết nối lại OAuth.
- source_spec: `spec-4-2-dang-ky-webhook-va-suc-khoe.md`
  summary: Gỡ trang thì huỷ đăng ký `DELETE /{page}/subscribed_apps` ở Meta.
  evidence: `removePage` xoá credential nhưng Meta vẫn gửi sự kiện của trang đã gỡ, và chúng được tính là sự kiện thật trong health.
- source_spec: `spec-4-4-binh-luan-vao-hop-thu.md`
  summary: Sửa/thu hồi tin DM (Messenger `message_edit`, IG `is_deleted`) → `inbox.updateMessageText` / `markMessageRemoved`.
  evidence: Hàm đã có từ 4.4 nhưng parser 4.1 cho IG `is_deleted` cùng khoá `messages:<mid>` với tin gốc (bị chặn như trùng) và Messenger `message_edit` thành field `messaging`; cần khoá riêng + chuẩn hoá ở `webhook-message.ts`. Hiện vẫn `ignored`.
- source_spec: `spec-4-4-binh-luan-vao-hop-thu.md`
  summary: Xác nhận dạng payload webhook Threads `replies` (dạng `values` + `root_post.owner_id`) và bình luận FB thiếu `from` bằng sự kiện thật.
  evidence: Parser/chuẩn hoá Threads theo tài liệu mẫu [ASSUMPTION AD-4]; bình luận FB không có `from.id` đang bị bỏ qua (`malformed`) — nếu Meta lược `from` thật thì cần định danh dự phòng theo id bình luận. Story 9.4 gom việc kiểm vào checklist sau Live: `deploy/app-review.md` mục 8.3.
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
  evidence: Đường gửi mới chỉ chạy với Meta giả/fake client. Threads publish lỗi tạm thì retry tạo container mới (container cũ mồ côi, vô hại). Story 9.4 gom việc kiểm vào checklist sau Live: `deploy/app-review.md` mục 8.3.
- source_spec: `spec-4-7-gui-tin-24-gio.md`
  summary: Gửi tin hết giờ / lỗi mạng (không có phản hồi HTTP) hoặc 5xx có thể đã tới Meta → không retry tự động mà ghi `failed` `SEND_UNKNOWN` (hoặc tra lại trước khi retry); Threads tách retry bước publish khỏi bước tạo container.
  evidence: `deliverMessage` (server/src/modules/inbox/send.ts) coi mọi `TRANSIENT` là retry được — `transientFailure()` của adapter gộp hết giờ, lỗi kết nối và 5xx — nên tin có thể tới khách 2–6 lần; Threads `threads_publish` hết giờ mà đã đăng thì retry tạo container mới và đăng lại. Cần adapter phân biệt "chưa gửi được" (DNS/kết nối bị từ chối) với "không rõ" (hết giờ sau khi gửi) và quyết định sản phẩm (AD-10 hiện ghi retry lỗi tạm). Story 4.5 giảm bớt: echo Messenger (`metadata`) tới trong 5 giây backoff đầu đặt tin `sent` nên lần retry không chiếm lại được; IG/Threads/bình luận và echo tới muộn vẫn có thể gửi trùng. Story 6.4 đã thêm cờ `notSent` ở adapter (`MetaFailure.notSent`: chặn trước khi gửi / không mở được kết nối) — `deliverMessage` có thể chỉ retry khi có cờ này, còn lại `SEND_UNKNOWN`, như `publish.target`.
- source_spec: `spec-4-5-nhan-dien-echo.md`
  summary: Xác nhận bằng sự kiện Meta thật: echo IG có `app_id`/`metadata` không, bình luận FB/IG của trang và trả lời Threads của tài khoản có về webhook không, IG `messaging_seen` dạng `read.mid`, Business Suite gửi `app_id` riêng.
  evidence: Phân loại echo (`server/src/modules/inbox/echo.ts`) theo tài liệu Meta; echo không `app_id` (bình luận, Threads, có thể IG) chỉ khớp được theo id/nội dung, không khớp thì sau ~15 giây coi là chủ shop trả lời ngoài app (`external_human`) — nếu Meta đổi chữ tin app gửi (vd rút gọn link) thì tin app có thể bị tính là ngoài app và tắt AI. Story 9.4 gom việc kiểm vào checklist sau Live: `deploy/app-review.md` mục 8.3.
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
  evidence: `content/images.ts` `generateImageAsset` (`put` lỗi → `markFailed`). Hướng sửa: thử `put` lại 1 lần trong job trước khi `failed`. Story 6.6 đã đóng nửa còn lại: gateway đưa `maybeBilled` vào `details` (`ai.isMaybeBilled`), job ảnh gặp lỗi này thì `failed` ngay, không retry — còn mở: kho lỗi sau khi đã có ảnh.
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
  summary: Lịch ở tab / máy khác không tự cập nhật khi đổi giờ / bỏ lịch / lên lịch bằng tay (chỉ `post_target.published|failed|cancelled|updated` và `campaign.*` có sự kiện realtime).
  evidence: `transitionTarget` không phát sự kiện cho `schedule|reschedule|unschedule|retry|approve`; web làm cũ `['post_targets']` sau mỗi lần tự chuyển trạng thái. Story 7.3: "Bắt đầu chiến dịch" phát `campaign.started` (lịch đang mở tải lại cả slot vừa tạo). Story 7.4: duyệt bài chiến dịch (`approve`, cả cron "Tự đăng") phát `post_target.updated`. Còn lại (`schedule|reschedule|unschedule|retry` của bài tay) cần sự kiện kiểu `post_target.scheduled` (shared `events.ts`).
- source_spec: `spec-7-1-wizard-chien-dich.md`
  summary: Kiểm bằng trình duyệt wizard `/chien-dich/tao` với phiên chủ shop và trang thật:
    - 3 bước theo nhóm / từng trang; trang mất kết nối / thiếu hồ sơ mờ kèm lý do;
    - tổng tỉ lệ 90% → báo dưới ô; sang bước 4 → URL `?id=`, tải lại nạp đúng nháp;
    - ghi chú "Instagram luôn cần ảnh".
  evidence: Chỉ có test API (Postgres thật, `server/test/campaigns.test.ts`) và test helper web (`web/src/lib/campaigns.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu).
- source_spec: `spec-7-1-wizard-chien-dich.md`
  summary: Ước tính chi phí AI thật ở cột Tóm tắt của wizard. Đã bỏ số giả "~700đ/bài"; hướng làm: tính theo model đang chọn bằng `ai.estimateTextCost` / `estimateImageCost` × số bài / số bài có ảnh.
  evidence: Story 7.2 đã có lời gọi `campaign_generate` thật (ghi `ai_usage` với `ref` = target cho caption, `ref` = ô ảnh cho ảnh của slot), nên đo được chi phí thật của 7 bài xem trước. Chưa làm vì AC 7.2 không cần; hướng làm: cộng `ai_usage` theo `ref` của slot xem trước, nhân theo tổng bài / bài có ảnh ở cột Tóm tắt (hoặc ước tính bằng `estimateTextCost` / `estimateImageCost` khi chưa có bài xem trước).
- source_spec: `spec-7-1-wizard-chien-dich.md`
  summary: Trang chọn được (`GET /campaigns/page-options`) không tự cập nhật khi hồ sơ thương hiệu đổi, vì lưu hồ sơ không phát sự kiện realtime. Chỉ `page.*` làm cũ danh sách này.
  evidence: Wizard mở lâu có thể vẫn thấy "Chưa có hồ sơ thương hiệu" dù vừa tạo hồ sơ ở tab khác. Server vẫn kiểm lại khi lưu, nên không lưu sai.
- source_spec: `spec-7-2-xem-truoc-7-bai.md`
  summary: Kiểm bằng trình duyệt bước 4 wizard `/chien-dich/tao?id=` với khoá OpenAI + Cloudinary thật và worker:
    - 7 thẻ "AI đang viết…" → bài có caption, thẻ có ảnh qua "Đang tạo ảnh…";
    - Sửa / Lưu, Xoá ("Đã bỏ n bài"), Tạo lại (khoá khi thiếu khoá / hết hạn mức);
    - quay lại bước 3 đổi giờ đăng → bài không khớp được viết lại; hai tab lưu nháp → câu "Nháp đã đổi ở tab khác".
  evidence: Chỉ có test API (Postgres thật, `server/test/campaigns-preview.test.ts`) và test helper web (`web/src/lib/campaigns.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu).
- source_spec: `spec-7-2-xem-truoc-7-bai.md`
  summary: Bước 4 chỉ sửa được caption của bài xem trước, chưa đổi / bỏ / thêm ảnh. Muốn ảnh khác thì phải "Tạo lại" (viết lại cả caption).
  evidence: AC 7.2 chỉ nêu sửa / xoá / tạo lại. Hành động `edit` của `transitionTarget` chỉ nhận `caption`. Story 7.4: hàng đợi "Bài chờ duyệt" cũng chỉ sửa caption (AC không nêu ảnh); bài IG lỗi ảnh chỉ "Tạo lại" được. Hướng làm: `edit {caption, mediaIds?}` (ảnh tải lên / ảnh AI có sẵn).
- source_spec: `spec-7-3-bat-dau-chien-dich.md`
  summary: Kiểm bằng trình duyệt luồng bắt đầu chiến dịch với phiên chủ shop + worker:
    - bước 4 → "Bắt đầu chiến dịch" → toast + `/lich` có đủ slot chấm tím "AI tạo" ("AI sẽ viết · <chủ đề>" cho bài chưa viết);
    - `/chien-dich` (tab, KPI, thẻ "0/N bài", "Bài tiếp theo", nháp → "Tiếp tục thiết lập") và thẻ "Chiến dịch đang chạy" ở Tổng quan;
    - trang mất kết nối giữa lúc lưu và lúc bắt đầu → về bước 2 kèm câu dưới trang; chế độ "Tự đăng" → bài xem trước lên lịch xanh.
  evidence: Chỉ có test API (Postgres thật, `server/test/campaigns-start.test.ts`) và test helper web (`web/src/lib/campaigns.test.ts`, `calendar.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu).
- source_spec: `spec-7-3-bat-dau-chien-dich.md`
  summary: `Group.activeCampaigns` (Trang & Nhóm, Chi tiết nhóm) và `pages.affectedByMove().campaigns` vẫn là dữ liệu mẫu / rỗng.
  evidence: Story 7.5 đã làm lý do tạm dừng trên thẻ + nút Tạm dừng / Tiếp tục ở `/chien-dich` và Tổng quan (`campaigns.pause_reason`). Read-model `app/read-models/campaigns.ts` là chỗ ghép `Group.activeCampaigns` khi Trang & Nhóm bỏ dữ liệu mẫu; cảnh báo chuyển nhóm cần chiến dịch gắn nhãn nhóm (`campaigns.group_id`).
- source_spec: `spec-7-4-sinh-cuon-chieu-va-hang-doi-duyet.md`
  summary: Kiểm bằng trình duyệt hàng đợi "Bài chờ duyệt" `/chien-dich` và nút "Duyệt" trên Lịch với worker + khoá OpenAI:
    - sau lượt cron, bài 3 ngày tới hiện trong hàng đợi; Duyệt / Sửa / Tạo lại / Từ chối, "Duyệt tất cả (n)";
    - bài quá giờ → chip "Quá giờ" + ô giờ mới; Lịch: ngăn bài chờ duyệt có "Duyệt", ô ghi "Chờ duyệt · Quá giờ";
    - chế độ "Tự đăng": bài viết xong lên lịch xanh, bài lỗi về hàng đợi.
  evidence: Chỉ có test API (Postgres thật, `server/test/campaigns-generate.test.ts`) và test helper web (`web/src/lib/campaigns.test.ts`, `calendar.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu).
- source_spec: `spec-7-4-sinh-cuon-chieu-va-hang-doi-duyet.md`
  summary: "Tạo lại" (kể cả `immediate`) một bài có giờ đăng xa hơn 3 ngày (bài xem trước ngày 4–7) chỉ được viết lại khi bài vào cửa sổ cuốn chiếu; trong lúc đó bài rời hàng đợi và hiện "AI sẽ viết" trên Lịch.
  evidence: Job `campaigns.generate` (stately — payload của lượt xếp sau có thể bị gộp) chỉ chọn slot theo cửa sổ. Hướng làm: đánh dấu slot "tạo lại theo yêu cầu" ở `content` để lượt kế chọn bất kể cửa sổ.
- source_spec: `spec-7-4-sinh-cuon-chieu-va-hang-doi-duyet.md`
  summary: Bài xem trước còn chờ ảnh lúc bấm "Bắt đầu" ở chế độ "Tự đăng" (job ảnh không mang cờ `autoApprove`) chỉ được duyệt ở lượt cron kế (≤ 1 giờ); bài có giờ đăng trong khoảng đó về "Chờ duyệt" quá giờ.
  evidence: `content/images.ts` lấy cờ từ payload do `generateSlot` đặt; job ảnh của bài xem trước enqueue lúc còn nháp. Hướng làm: job ảnh enqueue lại `campaigns.generate` khi slot vừa xong là slot chiến dịch đã bắt đầu, hoặc lưu cờ trên target.
- source_spec: `spec-7-4-sinh-cuon-chieu-va-hang-doi-duyet.md`
  summary: Hàng đợi "Bài chờ duyệt" đọc tối đa 200 bài (`truncated` → chip "200+"), không phân trang; "Duyệt tất cả" chạy tuần tự từng bài (lỗi giữa chừng báo "Đã xong k/n bài", không tất cả hoặc không).
  evidence: `app/read-models/campaign-queue.ts` + `PENDING_SLOTS_MAX`; route hành động slot nhận một bài mỗi lần. Hướng làm: route duyệt theo danh sách target trong một transaction (như `transitionPostTargets`).
- source_spec: `spec-7-6-tu-tam-dung-khi-su-co.md`
  summary: Kiểm bằng trình duyệt tự tạm dừng với phiên chủ shop + worker:
    - trang mất kết nối → thẻ `/chien-dich` + Tổng quan "Tự tạm dừng: trang … mất kết nối", chuông có "Trang mất kết nối"; "Tiếp tục" → câu lỗi; kết nối lại → tiếp tục được;
    - gỡ trang / trang rời nhóm nhãn → Lịch bỏ bài của trang đó (tải lại qua SSE `page.*`);
    - xoá khoá OpenAI → lượt cron kế dừng chiến dịch "khoá OpenAI chưa dùng được".
  evidence: Chỉ có test API / consumer (Postgres thật, `server/test/campaigns-auto-pause.test.ts`) và test helper web (`web/src/lib/campaigns.test.ts`, `realtime.test.ts`); chưa chạy UI.
- source_spec: `spec-7-6-tu-tam-dung-khi-su-co.md`
  summary: Thông báo `campaign_paused` vẫn mặc định TẮT (Story 1.4, theo mock) trong khi EXPERIENCE ghi "Chiến dịch … tự tạm dừng, có thông báo". Hết hạn mức dừng N chiến dịch → N thông báo riêng (không gộp).
  evidence: `DEFAULT_NOTIFICATION_PREFS` ở `packages/shared/src/notifications.ts`; mất kết nối đã có `page_disconnected` (mặc định bật), hết hạn mức có banner toàn app. Cần chủ dự án chốt mặc định; gộp thông báo nếu số chiến dịch chạy song song lớn.
- source_spec: `spec-7-6-tu-tam-dung-khi-su-co.md`
  summary: "Tiếp tục" chỉ kiểm lý do đang ghi (luật 7.5): chiến dịch dừng vì `PUBLISH_FAILURES` mà trang cũng đã mất kết nối thì tiếp tục được, rồi mới bị dừng lại (`PAGE_DISCONNECTED`) ở lần đăng lỗi / lượt sinh kế tiếp.
  evidence: `campaigns/lifecycle.ts` `assertReasonCleared`; lý do hệ thống không đè nhau (chỉ đè `MANUAL`). Hướng làm: tiếp tục kiểm mọi điều kiện chặn (trang, hồ sơ, hạn mức, khoá) bất kể lý do đã ghi.
- source_spec: `spec-8-1-thu-thap-so-lieu.md`
  summary: Kiểm bằng Meta thật bảng ánh xạ `analytics/metric-map.ts` (worker chạy, trang thật đã cấp quyền thống kê):
    - FB: `post_media_view` / `post_total_media_view_unique` qua `insights.metric(...)` lồng trong `GET /{post}`, `page_media_view`, `page_total_media_view_unique`, `page_post_engagements`, `page_daily_follows_unique` / `page_daily_unfollows_unique` với `period=day`; ngày của giá trị = `end_time` − 1 ngày (lịch Meta) [ASSUMPTION];
    - IG: `views,reach,likes,comments,shares,saved` theo media (media cũ / ít người xem có thể trả lỗi riêng — hiện bỏ bài đó), `views,reach,total_interactions` `metric_type=total_value` theo cửa sổ ngày VN, `follows_and_unfollows` `breakdown=follow_type` (FOLLOWER / NON_FOLLOWER);
    - Threads: `views,likes,replies,reposts,quotes` theo media và `threads_insights` theo cửa sổ ngày VN.
  evidence: Chỉ có test Postgres thật + Meta giả (`server/test/analytics-metrics.test.ts`); tên metric theo tài liệu lúc viết. Sai tên metric thì Meta trả lỗi 100 → bài bị bỏ (`REJECTED`) / số liệu trang `failed` — xem `metric_sync_states` sau lượt cron đầu.
- source_spec: `spec-8-1-thu-thap-so-lieu.md`
  summary: `metric_sync_states` (bảng thứ ba của `analytics`, ngoài hai bảng ở Structural Seed) chưa có trong bảng sở hữu của ARCHITECTURE-SPINE; chưa API / màn nào đọc — Story 8.2 hiện "Thiếu quyền thống kê — Kết nối lại" (`permissions_missing` / `permission_denied`).
  evidence: `server/src/modules/analytics/schema.ts`. Quyền insight không bắt buộc khi chọn trang (`PAGE_REQUIRED_SCOPES`), nên trang kết nối đủ quyền nhắn tin vẫn có thể thiếu `read_insights` / `instagram_manage_insights`.
- source_spec: `spec-8-1-thu-thap-so-lieu.md`
  summary: Số liệu trang chỉ lùi 3–4 ngày: worker / Meta dừng lâu hơn thì các ngày giữa bị thiếu, không tự lấp; trang mới kết nối không kéo lịch sử trước ngày kết nối.
  evidence: `PAGE_METRICS_LOOKBACK_DAYS` ở `analytics/collect.ts`. Hướng làm: lùi tới ngày cuối đã có dòng (tối đa 30 ngày) khi phát hiện khoảng trống; Story 8.2 dùng `insufficientData` cho trang <7 ngày nên chưa cần.
- source_spec: `spec-8-1-thu-thap-so-lieu.md`
  summary: Số liệu trang Threads: `views` của `threads_insights` là chuỗi theo ngày Meta (`end_time` giờ Thái Bình Dương) nhưng job hỏi theo cửa sổ ngày VN rồi cộng mọi giá trị — ngày VN D có thể nhận số ngày Meta D−1 (lệch một ngày so với trang FB) hoặc cộng hai ngày nếu Meta trả giá trị chồng cửa sổ; `likes` / `replies` / … (`total_value`) thì đúng cửa sổ VN.
  evidence: `PAGE_METRIC_MAP.threads` (`mode: 'per_day'`) ở `analytics/metric-map.ts` + `parseInsightTotals`. Hướng làm: kiểm bằng Meta thật; nếu đúng là chuỗi ngày thì tách `views` sang lời gọi `range` như FB (`parseInsightDaily`, ngày = `end_time` − 1 ngày).
- source_spec: `spec-8-2-man-hieu-suat.md`
  summary: Kiểm bằng trình duyệt `/hieu-suat` với phiên chủ shop + worker đã chạy lượt thu số liệu:
    - đổi Phạm vi (tất cả / nhóm / trang) và 7 / 30 / 90 ngày → KPI, % so kỳ trước (tắt công tắc → mất mũi tên), biểu đồ theo nền tảng + nét đứt "Kỳ trước";
    - trang kết nối <7 ngày → "Cần thêm vài ngày dữ liệu" thay biểu đồ / sparkline; trang thiếu `read_insights` → "Thiếu quyền thống kê — Kết nối lại" mở OAuth đúng trang;
    - bảng trang sắp xếp (ô "—" luôn cuối), bài tốt nhất có ảnh / "AI tạo" / liên kết bài gốc.
  evidence: Chỉ có test API (Postgres thật, `server/test/analytics-performance.test.ts`) và test helper web (`web/src/lib/performance.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu).
- source_spec: `spec-8-2-man-hieu-suat.md`
  summary: Tab "Hiệu suất" của Chi tiết trang (`PageDetail.tsx` › `PagePerformance`) và Chi tiết nhóm (`GroupDetail.tsx` › `GroupPerformance`) vẫn chạy dữ liệu mẫu (`engagement30d`, `posts`, `AI_REPLIES`).
  evidence: AC 8.2 chỉ nêu `/hieu-suat`; EXPERIENCE ghi hai tab "cùng nguồn dữ liệu". Hướng làm: dùng `usePerformance({kind:'page'|'group', id}, '30d')` của `web/src/lib/performance.ts` (cùng endpoint, không cần API mới); "tin AI trả lời" lấy từ `data.ai.aiMessages` (Story 8.3 đã có, thay `AI_REPLIES` mẫu ở `GroupDetail.tsx`).
- source_spec: `spec-8-2-man-hieu-suat.md`
  summary: Đã bỏ khỏi `/hieu-suat` hai phần chỉ có số giả và không thuộc story nào: heatmap "Giờ đăng tốt nhất" và nút "Xuất báo cáo" (chỉ hiện toast).
  evidence: Không có trong epics.md / EXPERIENCE / DESIGN — chỉ có ở bản mẫu. Nếu cần: heatmap tính được từ `post_metrics` (tương tác trung bình theo thứ × giờ đăng, giờ VN) qua `content.listPublishedInRange` + `published_at`; xuất báo cáo cần story riêng (định dạng CSV / PDF).
- source_spec: `spec-8-2-man-hieu-suat.md`
  summary: "Chưa đủ dữ liệu" theo `pages.connected_at`, mà kết nối lại trang đã mất kết nối đặt lại mốc này → trang có lịch sử số liệu vẫn hiện "Cần thêm vài ngày dữ liệu" 7 ngày sau khi kết nối lại. `reach` của KPI / bảng trang là tổng reach theo ngày (một người xem nhiều ngày bị đếm nhiều lần).
  evidence: `isInsufficient` + `add` ở `server/src/modules/analytics/performance.ts`; `upsertFromPlatform` ở `pages/service.ts`. Hướng làm: tính chưa đủ dữ liệu theo ngày đầu có dòng `page_daily_metrics` (hoặc lưu `first_connected_at`); reach duy nhất cho khoảng tuỳ ý Meta không cung cấp — có thể đổi nhãn "Tiếp cận (cộng theo ngày)".
- source_spec: `spec-8-2-man-hieu-suat.md`
  summary: % so kỳ trước tắt (`previous = null`) cho cả phạm vi khi CÓ một trang bắt đầu có số liệu sau ngày đầu kỳ trước — phạm vi `all` nhiều trang mất so sánh tới 2N ngày (90 ngày → ~180 ngày) chỉ vì thêm một trang mới.
  evidence: `lateStart` / `comparable` ở `server/src/modules/analytics/performance.ts` (review lượt 1). Hướng làm: so like-for-like — tính `current` / `previous` dùng cho % chỉ trên các trang đủ dữ liệu kỳ trước (thêm trường vào `MetricComparison`, vd. `comparableCurrent`), hiển thị tổng vẫn gồm mọi trang.
- source_spec: `spec-8-3-hieu-qua-ai.md`
  summary: Kiểm bằng trình duyệt khối "Hiệu quả AI" + KPI "Tin nhắn" ở `/hieu-suat` với phiên chủ shop + hội thoại AI thật:
    - "n tin" / "AI đã trả lời X% tin nhắn", "Chuyển cho bạn X%" / "n trên m hội thoại AI nhận", "Phản hồi trung bình" (giây / phút);
    - thanh Bài AI tạo vs Bài tự viết + "AI tạo cao hơn / thấp hơn X%"; kỳ không có tin / bài → "—" và câu trống; lưới 6 KPI ở màn hẹp.
  evidence: Chỉ có test API (Postgres thật, `server/test/analytics-ai-efficiency.test.ts`) và test helper web (`web/src/lib/performance.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu).
- source_spec: `spec-8-3-hieu-qua-ai.md`
  summary: Bỏ dòng mẫu "Bạn tự trả lời: 23 phút" (thời gian chủ shop trả lời) dưới "Phản hồi trung bình".
  evidence: Từ `messages` chưa đo đúng được: sau khi AI chuyển người, câu chuyển tiếp của AI là tin đã gửi cuối, nên tin chủ shop trả lời không neo được vào tin khách đang chờ (chính những ca cần đo). Hướng làm: neo theo tin `system` chuyển sang `handoff` / `human` (khách chờ từ tin khách cuối trước đó — cùng luật `waiting_since`) trong `inbox/stats.ts`, rồi thêm trường `avgHumanResponseSeconds`.
- source_spec: `spec-8-3-hieu-qua-ai.md`
  summary: Khối "Hiệu quả AI" chưa so với kỳ trước (chỉ KPI "Tin nhắn" có %); thời gian phản hồi là trung bình — vài lượt chậm (lỗi gửi lại, OpenAI chậm) kéo số lên.
  evidence: AC 8.3 không nêu so kỳ trước. `aiReplyStats` (`server/src/modules/inbox/stats.ts`) nhận khoảng bất kỳ — gọi thêm cho kỳ trước nếu cần; có thể trả thêm trung vị / p95 (NFR1) từ cùng tập mẫu.
- source_spec: `spec-8-4-tao-bai-tuong-tu.md`
  summary: Kiểm bằng trình duyệt luồng "Tạo bài tương tự" với phiên chủ shop + bài đã đăng có số liệu:
    - `/hieu-suat` › "Bài hiệu quả nhất" › "Tạo bài tương tự" → Soạn bài chỉ chọn trang của bài (nhóm của trang mở sẵn), ô ý tưởng đã tóm (không hashtag / link / emoji); tab Mạng không có `POST /posts/compose` / `POST /media-assets/generate` tới khi bấm "Tạo bằng AI";
    - trang của bài đã mất kết nối → chọn theo Phạm vi + dòng "Trang của bài gốc đã mất kết nối hoặc đã gỡ…" (mất khi tự chọn trang); "Lưu nháp" xoá `idea` / `trang` khỏi URL;
    - chất lượng ý tưởng tóm bằng luật (`content/similar.ts`, `SIMILAR_IDEA_MAX` 300 [ASSUMPTION]) trên caption thật nhiều dòng / nhiều emoji — nếu hay mất ý chính thì cân nhắc tóm bằng AI ngay lúc bấm "Tạo bằng AI" (vẫn không gọi AI khi mở).
  evidence: Chỉ có test API (Postgres thật, OpenAI giả — `server/test/content-compose.test.ts`, `analytics-performance.test.ts`, `content-similar.test.ts`) và test helper web (`web/src/lib/composer.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu).
- source_spec: `spec-8-5-tong-quan.md`
  summary: Kiểm bằng trình duyệt Tổng quan `/` với phiên chủ shop + worker:
    - KPI / biểu đồ đổi theo Phạm vi và 7 / 30 / 90 ngày, "AI đã trả lời X%", trang mới kết nối → "Cần thêm vài ngày dữ liệu";
    - "Cần bạn xử lý": tin khách mới / AI chuyển người hiện trong ≤3 giây (SSE), "Mở hộp thư" mở tab "Cần xử lý", bấm hội thoại mở đúng khách; bài lỗi → "Đăng lại" + link mở đúng ngăn trên Lịch (`/lich?bai=&ngay=`); trang mất kết nối / sắp hết hạn → "Kết nối lại" mở OAuth đúng trang; webhook ngừng / hạn mức AI / chiến dịch tự dừng / bài chờ duyệt dẫn đúng màn;
    - bài sắp đăng, thẻ chiến dịch (Tạm dừng / Tiếp tục, lý do), bảng trang (AI trả lời chỉ xem); `/chien-dich` dòng "Tương tác 7 ngày ±x%".
  evidence: Chỉ có test API (Postgres thật, `server/test/overview.test.ts`, `campaigns-start.test.ts`, `webhook-health.test.ts`) và test helper web (`web/src/lib/overview.test.ts`, `realtime.test.ts`, `calendar.test.ts`, `inbox.test.ts`, `campaigns.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu).
- source_spec: `spec-8-5-tong-quan.md`
  summary: Bảng "Trang đã kết nối" ở Tổng quan bỏ cột "Người theo dõi" (số mẫu) — `analytics` chỉ thu `followers_delta` theo ngày, không thu tổng người theo dõi của trang.
  evidence: `page_daily_metrics` không có cột tổng; Meta có `followers_count` (FB / IG) / `followers_count` Threads. Hướng làm: thêm vào lượt `analytics.page_metrics` (một giá trị mỗi ngày) rồi trả trong `GET /pages` hoặc read-model.
- source_spec: `spec-8-5-tong-quan.md`
  summary: Tương tác 7 ngày của thẻ chiến dịch dồn cả mức trọn đời của bài vào ngày snapshot đầu tiên khi bài cũ chỉ bắt đầu có số liệu trong cửa sổ 14 ngày (lúc mới bật thu 8.1 / trang mới cấp quyền thống kê) — gai một ngày trên sparkline.
  evidence: `analytics/engagement.ts` (chưa có mức trước → cả mức là phần tăng, đúng cho bài mới đăng). Hướng làm: truyền `published_at` từ `content` và chỉ tính cả mức khi bài đăng trong cửa sổ.
- source_spec: `spec-8-5-tong-quan.md`
  summary: Tổng quan refetch cả `GET /overview` (~15 câu: hội thoại, bài lỗi / sắp đăng, chiến dịch + `engagementGains`, sức khoẻ webhook, hạn mức AI) cho MỖI hint `message` / `conversation` / `contact` — tin / bình luận dồn dập (livestream) thì server tính đủ một lượt cho mỗi tin (client huỷ request đang bay nhưng server vẫn chạy).
  evidence: `ENTITY_ALSO_INVALIDATES` + `handleHint` (`invalidateQueries`, mặc định `cancelRefetch`) ở `web/src/lib/realtime.ts` (review lượt 1). Hướng làm: gom hint theo gốc khoá — throttle có lượt cuối (vd. 1 giây, vẫn ≤3 giây của AC) cho `['overview', …]`, hoặc `cancelRefetch: false` + đánh dấu "cần tải lại" khi lượt đang bay xong.
- source_spec: `spec-9-2-xoa-du-lieu.md`
  summary: Kiểm bằng trình duyệt "Xoá khách" ở `/khach-hang?id=` với phiên chủ shop + worker: hộp xác nhận (ô "Tôi hiểu…" bắt buộc), khách biến mất khỏi danh sách / Hộp thư, link "Xem trạng thái xoá" mở `/privacy/status/<code>` trên host api (cả chế độ tách) và chuyển "Đã xoá xong".
  evidence: Chỉ có test API (Postgres thật, pg-boss thật, Cloudinary giả — `server/test/privacy-purge.test.ts`) và test helper web (`web/src/lib/contacts.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu).
- source_spec: `spec-9-2-xoa-du-lieu.md`
  summary: Yêu cầu `scope=all` chỉ xoá dữ liệu khách / hội thoại / bài + `meta_accounts`; token trang và dòng `pages` giữ nguyên [quyết định hẹp]. Callback "xin xoá dữ liệu" (không kèm gỡ app) không ngắt trang → trang vẫn nhận tin mới sau khi xoá xong.
  evidence: `connections/purge.ts`, `app/privacy.ts` (chỉ deauthorize ngắt trang, như 9.1). Nếu chính sách cần "xoá xong thì không nhận thêm": ngắt trang ở data-deletion, hoặc xoá token / soft-remove trang trong phần `connections`.
- source_spec: `spec-9-2-xoa-du-lieu.md`
  summary: Yêu cầu `scope=all` của 9.1 tạo trước bản này (không có `page_ids`) không được phát lại — cron `privacy.purge_resume` bỏ qua + log cảnh báo; cần xử lý tay nếu production có dòng như vậy.
  evidence: `privacy/coordinator.ts` `resumeStalledRequests` (`skippedLegacy`). Kiểm `select id from deletion_requests where scope='all' and page_ids is null and status <> 'completed'` trước khi lên bản.
- source_spec: `spec-9-2-xoa-du-lieu.md`
  summary: Xoá `scope=page|all` không phát sự kiện realtime theo khách → Hộp thư / Khách hàng của trang vẫn đang mở (vd trang bị ngắt ở `all`) chỉ đổi khi refetch.
  evidence: `inbox/purge.ts` chỉ phát `contact.deleted` cho `scope=contact`. Hướng làm: một sự kiện tổng `privacy.purge_completed` realtime=true hoặc `conversation`/`contact` hint theo trang.
- source_spec: `spec-9-2-xoa-du-lieu.md`
  summary: Xoá khách là tác giả bình luận gốc thì cả hội thoại bình luận bị xoá, gồm trả lời của khách KHÁC trong luồng đó (và payload thô của chúng, vì `webhooks` khớp `thread_key` = id bình luận gốc) — cần quyết định sản phẩm (review lượt 1).
  evidence: `inbox/schema.ts` `conversations.contact_identity_id` NOT NULL `on delete cascade` tới định danh tác giả gốc; `inbox/purge.ts` `purgeContact` xoá theo `conversationIds`, `purgeMatchKeys` đưa `thread_key` + id tin của mọi tin trong hội thoại. Hướng làm: chuyển hội thoại cho định danh của người trả lời sớm nhất (giữ tin của họ, chỉ xoá tin của khách bị xoá) hoặc ghi rõ là chấp nhận trong chính sách.
- source_spec: `spec-9-2-xoa-du-lieu.md`
  summary: `scope=all` từ callback "xin xoá dữ liệu" (không gỡ app) xoá `meta_accounts` nhưng trang vẫn chạy → `page_credentials.meta_account_id = null`; callback deauthorize / xoá dữ liệu sau đó của cùng người thành "người lạ" (`matched=false`) → không ngắt trang, không xoá dữ liệu nhận thêm (review lượt 1).
  evidence: `connections/purge.ts` (khoá ngoại `set null`), `connections/deauthorize.ts` `findAccountId` theo `meta_accounts.fb_user_id`. Gộp với việc hoãn "token / ngắt trang khi `all`": ngắt trang ở data-deletion, hoặc giữ `fb_user_id` dạng băm để vẫn khớp.
- source_spec: `spec-9-3-don-du-lieu-theo-thoi-han.md`
  summary: Kiểm bằng trình duyệt Cài đặt › Webhook › Nhật ký sự kiện: dòng phụ "Nội dung thô chỉ giữ 30 ngày…", sự kiện đã dọn hiện "· đã dọn nội dung" và không có nút "Xử lý lại" (kể cả khi `failed`).
  evidence: Chỉ có test API (`server/test/webhooks.test.ts`) và test helper web (`web/src/lib/webhooks.test.ts`); chưa chạy UI (dev không có mật khẩu mẫu).
- source_spec: `spec-9-3-don-du-lieu-theo-thoi-han.md`
  summary: Xác nhận `MediaInventory.list` với Cloudinary thật: Admin API `resources/<resource_type>/<type>?prefix=` (Basic auth), sắp theo public_id khi có prefix, dạng `created_at`, `next_cursor`, hạn mức Admin API (gói Free ~500 lời gọi/giờ — một lượt dùng tối đa 15 trang + 100 lệnh xoá).
  evidence: `server/src/adapters/media/index.ts` (`inventory`) chỉ chạy với Cloudinary giả (`fake.ts`). Gộp với việc hoãn "job CI tuỳ chọn chạy `runMediaCheck` với tài khoản thử" — thêm bước liệt kê vào `media:check`.
- source_spec: `spec-9-3-don-du-lieu-theo-thoi-han.md`
  summary: Dòng metadata của `webhook_events` (sau khi payload về null) giữ vô hạn theo AD-22 ("giữ metadata") — bảng vẫn tăng, `dedupe_key` mang id tin Meta. Cân nhắc xoá hẳn dòng quá N tháng (giữ đủ cho chống trùng + sức khoẻ: vài ngày là đủ).
  evidence: `server/src/modules/webhooks/retention.ts` chỉ đặt `payload = null`; sức khoẻ chỉ đọc `max(received_at)`, chống trùng chỉ cần cửa sổ Meta gửi lại.
- source_spec: `spec-9-4-app-review.md`
  summary: Bước của chủ dự án sau khi Meta duyệt: chuyển Live hai app, kiểm webhook đủ ba nguồn với khách thật, xác nhận secret ký webhook Threads (runbook mục 10) và dạng `signed_request` / `user_id` của callback Threads app (`/privacy/threads/{uninstall,delete}`).
  evidence: Chỉ kiểm được với app Live — `deploy/app-review.md` mục 7–8. Callback Threads giả định giống Meta App (HMAC-SHA256 bằng `THREADS_APP_SECRET`, `user_id` = id `/me` của Threads = `pages.platform_account_id`); sai thì callback trả 400 hoặc ghi người lạ (`matched=false`), không xoá nhầm. Webhook Threads có `THREADS_WEBHOOK_SECRET` để đổi secret không cần sửa code.
- source_spec: `spec-9-4-app-review.md`
  summary: Reviewer của Meta cần vào app — app chỉ có một chủ sở hữu, nên hồ sơ hướng dẫn tạm đổi mật khẩu chủ sở hữu trong kỳ duyệt; chưa có môi trường staging tách biệt.
  evidence: `deploy/app-review.md` mục 2.4. Nếu Meta đòi tài khoản thử riêng hoặc chủ shop không muốn đưa mật khẩu production, dựng VPS staging theo runbook (app Meta riêng) hoặc thêm tài khoản chỉ đọc.
- source_spec: none
  summary: Story 9.5 (diễn tập khôi phục backup) bỏ qua theo quyết định chủ dự án — hệ thống chỉ có sao lưu tay `pg_dump` (runbook mục 4), không backup tự động, chưa diễn tập khôi phục.
  evidence: AC 9.5 giả định "backup đêm qua", mâu thuẫn quyết định bỏ restic ngày 2026-10-22 (spec-bo-backup-restic.md: "Không thêm công cụ backup thay thế"). Chủ dự án chọn bỏ qua ngày 2026-10-24; RPO hiện phụ thuộc lần dump tay gần nhất.
- source_spec: `spec-6-6-anh-tham-khao-va-caption-doc-anh.md`
  summary: Kiểm bằng trình duyệt + OpenAI / Cloudinary thật, worker chạy: ảnh tải lên → "Dùng làm ảnh tham khảo" + "Yêu cầu bối cảnh" → 4 biến thể có giữ đúng sản phẩm (gpt-image-2.5 với prompt tiếng Việt, không gửi `input_fidelity`); tab có ảnh → "Tạo bằng AI" / Viết lại / Ngắn hơn / Thêm CTA → caption nhắc đúng màu / bối cảnh trong ảnh; đối chiếu `ai_usage` với hoá đơn OpenAI (token ảnh vào của edits, token ảnh của vision `detail: low`).
  evidence: Chỉ có test API (Postgres thật, pg-boss, OpenAI + Cloudinary giả — `server/test/content-reference.test.ts`, adapter / gateway) và test helper web. Dev hiện không có `CLOUDINARY_URL` nên tải ảnh lên trả 500 `MEDIA_NOT_CONFIGURED`, không chạy được UI đầu-cuối. Giả định cần xác nhận: `gpt-image-2.5-*` bỏ `input_fidelity` như `gpt-image-2`; `gpt-6-luna` / `gpt-6.1-sol` nhận `input_image`; ước tính giữ chỗ 6.000 token ảnh tham khảo / 1.600 token vision.
- source_spec: `spec-6-6-anh-tham-khao-va-caption-doc-anh.md`
  summary: Mỗi ô biến thể gửi lại ảnh tham khảo (4 job × `n=1`) → trả 4 lần token ảnh vào. Nếu chi phí đáng kể: một job `n=4` cho bộ ảnh tham khảo (mất ô lỗi / retry riêng), hoặc dùng `file_id` (Files API) cho ảnh tham khảo.
  evidence: `content/images.ts` `generateImageAsset` tải + gửi ảnh tham khảo ở mỗi ô; trang giá OpenAI: ảnh vào $8 / 1M token, gpt-image-2 luôn xử lý ảnh vào ở độ chi tiết cao.
- source_spec: `spec-6-6-anh-tham-khao-va-caption-doc-anh.md`
  summary: Ảnh tham khảo sống chừng nào còn ô AI trỏ tới (FK không cascade) — biến thể đã đăng giữ ảnh tham khảo mãi; xoá theo yêu cầu (9.2) gặp ảnh tham khảo còn biến thể thì giữ dòng, `content.media_gc` dọn sau khi biến thể bị dọn.
  evidence: `media_assets.reference_asset_id` (migration `0043_loose_starfox.sql`), `content/media-gc.ts` `notReference`. Nếu cần gọn: khi biến thể đã `ready` thì đặt `reference_asset_id = null` (biến thể không cần ảnh tham khảo nữa).
- source_spec: `spec-6-8-anh-quang-cao-theo-y-tuong.md`
  summary: Chiến dịch chưa chọn được kiểu ảnh — slot luôn dựng ảnh `ad` (ảnh quảng cáo, có thể có chữ). Nếu chủ shop cần ảnh chụp sạch cho chiến dịch: thêm cột `campaigns.image_mode` (mặc định `ad`), ô chọn ở bước 3 wizard cạnh "Bài có ảnh AI", truyền qua `runSlotBatch` → `generateSlot`.
  evidence: `content/slots.ts` `generateClaimed` gọi `buildImagePrompt({ mode: 'ad', … })`; quyết định "chọn cách gọn" trong spec 6.8 (không migration, không đổi wizard). Chữ trên ảnh không được hậu kiểm (từ cấm, chính tả) — chỉ dặn trong prompt; cần thử thật thêm với ảnh slot "Tự đăng" (duyệt luôn, không người xem trước).
- source_spec: `spec-7-7-anh-san-pham-chien-dich.md`
  summary: Kiểm bằng trình duyệt + OpenAI / Cloudinary thật, worker chạy: wizard bước 3 tải ảnh sản phẩm (xem trước, Đổi ảnh, Bỏ ảnh) → bước 4 hiện ảnh đang dùng, 7 bài có ảnh giữ đúng sản phẩm (`gpt-image-2.5-sunburst` qua edits, không `input_fidelity`); đổi ảnh ở nháp → ảnh bài xem trước làm lại, caption giữ; chiến dịch "Tự đăng" đăng ảnh edits. So chất lượng prompt tham khảo `ad` không có dòng "Shop bán" với có dòng đó.
  evidence: Chỉ có test API (`server/test/campaigns-product-image.test.ts`, OpenAI + Cloudinary giả) và test helper web. Dev không có `CLOUDINARY_URL` (tải ảnh lên trả `MEDIA_NOT_CONFIGURED`) và trang dev chưa có hồ sơ thương hiệu nên chưa vào được bước 3 trên trình duyệt; chỉ thấy dòng "Ảnh sản phẩm · Không có" ở cột Tóm tắt.
- source_spec: `spec-7-7-anh-san-pham-chien-dich.md`
  summary: Đổi ảnh sản phẩm sau khi chiến dịch đã bắt đầu (v1 khoá như trang / tần suất / chủ đề). Nếu cần: endpoint riêng đổi `product_image_id` của chiến dịch `running|paused`, chỉ slot sinh SAU khi đổi dùng ảnh mới (slot đã có ảnh giữ nguyên), kiểm ảnh như lúc lưu nháp.
  evidence: `campaigns/drafts.ts` `updateCampaignDraft` từ chối chiến dịch đã rời `draft` (409); `generate.ts` đọc ảnh từ dòng chiến dịch ở mỗi lượt nên chỉ cần cho phép ghi cột.
- source_spec: `spec-7-7-anh-san-pham-chien-dich.md`
  summary: Bấm "Bắt đầu" ngay sau khi đổi ảnh ở nháp, lúc lượt xem trước đang viết dở một bài: bài đó có thể giữ ảnh sinh từ ảnh cũ (lượt sau chỉ làm lại ảnh khi chiến dịch còn nháp). Cửa sổ hẹp; chủ shop vẫn thấy ảnh ở hàng đợi duyệt (chế độ "Duyệt trước") và Tạo lại được.
  evidence: `campaigns/preview.ts` `runPreview` gọi `content.refreshSlotImages` chỉ khi `draft`; `runGenerate` không làm lại ảnh.
- source_spec: `spec-7-7-anh-san-pham-chien-dich.md`
  summary: Lưu nháp đổi ảnh sản phẩm đúng lúc job ảnh của một bài xem trước vừa xong có thể deadlock (thứ tự khoá ngược: `refreshSlotImages` khoá `post_targets` rồi cập nhật ô ảnh `pending`; job ảnh khoá ô ảnh rồi `settle` slot). Postgres huỷ một bên — lưu nháp trả 500 (bấm lại là được) hoặc job ảnh retry rồi `skipped`; không hỏng dữ liệu. Nếu gặp: trong `refreshSlotImages` khoá các ô ảnh ứng viên (`FOR UPDATE` theo id) trước khi khoá slot.
  evidence: `content/slots.ts` `refreshSlotImages` (`for('update', { of: postTargets })` rồi `update(mediaAssets)`), `content/images.ts` `generateImageAsset` (cập nhật `media_assets` rồi `settleSlotImage` → `settle`).
- source_spec: `spec-7-8-ke-hoach-noi-dung-da-dang.md`
  summary: Thử thật bằng OpenAI (model chữ mặc định + `gpt-image-2.5-sunburst`): chiến dịch một chủ đề → 7 bài xem trước có định dạng / góc / câu mở / bố cục ảnh khác nhau; model trả đúng schema strict (đủ bài, `slot` đúng số thứ tự, không bịa `promo` / `feedback`); lô cuốn chiếu sau không lặp brief / câu mở lô trước; `maxOutputTokens` (1.500 + 800 × số bài, trần 9.000) đủ cho model có suy luận. So ảnh có / không ảnh sản phẩm khi ý ảnh tả bối cảnh.
  evidence: Chỉ có test với OpenAI giả (`server/test/campaigns-plan.test.ts`, `campaign-plan-prompt.test.ts`). Hàm để thử: `ai.buildCampaignPlanPrompt` / `parseCampaignPlanOutput`, `ai.buildComposePrompt({plan, recent})`, `content.slotImagePrompt({plan})`; lời gọi ở `content/slot-plans.ts` `planCampaignSlots`.
- source_spec: `spec-7-8-ke-hoach-noi-dung-da-dang.md`
  summary: Chủ shop chưa sửa được brief (định dạng / góc / tiêu đề) bằng tay, chỉ "Tạo lại" (brief mới). Nếu cần: hành động slot `edit_plan` cho bài `planned` chưa viết / chờ duyệt, ghi `post_targets.plan` (giữ `status:'ok'`), bài chờ duyệt thì Tạo lại theo brief đã sửa thay vì xoá brief.
  evidence: `content/transitions.ts` `regenerate` đặt `plan = null`; `CampaignSlotActionRequest` không có hành động sửa brief.
- source_spec: `spec-7-8-ke-hoach-noi-dung-da-dang.md`
  summary: Brief lên theo từng trang (một lời gọi mỗi trang mỗi lô): chiến dịch nhiều trang cùng hồ sơ nhóm có thể đăng cùng góc ở các trang khác nhau cùng ngày, và chi phí kế hoạch nhân theo số trang. Nếu thành vấn đề: gom trang cùng hồ sơ hiệu lực vào một lời gọi, kèm luật "mỗi trang một góc".
  evidence: `content/slot-plans.ts` gom `byPage`; ngữ cảnh lịch sử lọc theo `(campaign_id, page_id)`.
- source_spec: `spec-7-8-ke-hoach-noi-dung-da-dang.md`
  summary: Lời gọi kế hoạch một trang lô 9 bài (~5–7k token ra) có thể chạm `RESPONSE_TIMEOUT_MS` 120 giây với model chậm / có suy luận → gateway coi là có thể đã tính tiền → cả lô `failed` (mất tiền, bài viết theo chủ đề như cũ). Thời gian kế hoạch (≤ 120 giây × số vòng 3 trang) cũng cộng vào lô 900 giây của `campaigns.generate`. Nếu đo thật thấy chậm: chia lời gọi theo ≤ 4–5 bài, hoặc timeout riêng cho lời gọi kế hoạch.
  evidence: `content/slot-plans.ts` `planPage` (một `generateText` mỗi trang), `adapters/openai/index.ts` `RESPONSE_TIMEOUT_MS = 120_000`, `platform/jobs/queues.ts` `campaigns.generate.expireInSeconds = 900`, `campaigns/generate.ts` `GENERATE_BATCH = 9` (tần suất `3_per_day` × cửa sổ 3 ngày = 9 bài một trang).
