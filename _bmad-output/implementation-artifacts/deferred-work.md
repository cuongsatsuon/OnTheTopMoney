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
- source_spec: `spec-1-3c-fe-hostinger-be-vps.md`
  summary: Header CORS cho lỗi do nginx-api tự sinh (413/502/503/504) để web đọc được JSON lỗi.
  evidence: Hiện trình duyệt chặn phản hồi đó (không có Allow-Origin) và web báo lỗi mạng; quan trọng khi có upload media (413). Cần map `$http_origin` theo ALLOWED_ORIGINS trong nginx.
- source_spec: `spec-1-3d-web-chay-trong-docker.md`
  summary: Kiểm nén gzip của asset web qua nginx (Content-Encoding, một Vary) trong smoke-test.
  evidence: gzip đã dời vào container web (`deploy/web-nginx.conf`); không bước nào kiểm.
- source_spec: `spec-1-3d-web-chay-trong-docker.md`
  summary: Test CI "build web lỗi → IMAGE_TAG và container đang chạy giữ nguyên".
  evidence: Bước CI "xuất bản web lỗi → không đổi current" bị bỏ cùng cơ chế WEB_ROOT; cần cách cố ý làm hỏng build `ottm-web` (vd nginx -t lỗi) trong CI.
- source_spec: `spec-media-cloudinary.md`
  summary: Ánh xạ lỗi adapter media (`AUTH_FAILED`, `RATE_LIMITED`, `INVALID_REQUEST`, `NOT_FOUND`, `TRANSIENT`) sang `ErrorCode` + câu tiếng Việt (vd "ảnh quá lớn").
  evidence: Chỉ có `MEDIA_NOT_CONFIGURED`; làm ở story upload đầu tiên (3.1 logo hoặc ảnh bài).
- source_spec: `spec-media-cloudinary.md`
  summary: Dọn file mồ côi trên Cloudinary (liệt kê `<folder>/private|public/*`, so với tham chiếu trong DB), kể cả sau khi khôi phục backup.
  evidence: Adapter chưa có thao tác liệt kê theo prefix; runbook chỉ nêu chiều ngược lại.
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
- source_spec: `spec-4-6-tab-tiep-quan-danh-dau-xong.md`
  summary: Bật lại AI cho hội thoại mà khách đang chờ (tin không phải `system` mới nhất là `customer`) → cần chạy cổng AI ngay cho tin chờ sẵn (hoặc chặn/cảnh báo), không để hội thoại nằm ở tab "AI đang trả lời" mà không ai trả lời.
  evidence: `applyUserAction('enable-ai')` đặt `waiting_since=null`, hội thoại rời "Cần xử lý"; `autoreply.triage` chỉ chạy khi có `message.received` mới. Trước Epic 5 cổng luôn đóng nên AI không bao giờ trả lời tin đó. Làm cùng chuỗi cổng AD-16 ở Epic 5 (kích hoạt quyết định khi bật lại AI).
- source_spec: `spec-4-7-gui-tin-24-gio.md`
  summary: Nhắn riêng tạo sẵn hội thoại `dm` với `origin_conversation_id` = hội thoại bình luận (AD-10/AD-11 bản đầy đủ).
  evidence: 4.7 chỉ gắn định danh `(page, recipient_id)` vào cùng khách; khách trả lời qua Messenger thì vào hội thoại `dm` mới của cùng khách nhưng không có liên kết ngược. (Phần "gợi ý gộp khi `recipient_id` đã thuộc khách khác" đã làm ở Story 4.9 — `contact_merge_suggestions`.)
- source_spec: `spec-4-7-gui-tin-24-gio.md`
  summary: Gửi lại / xử lý tin `app_ai` gửi lỗi (Epic 5) — hiện "Gửi lại" chỉ cho tin `app_human`.
  evidence: `resendMessage` trả `conflict` cho tin AI; khi Epic 5 ghi tin AI qua `inbox.send` cần quyết định: chủ shop gửi lại tin AI (thành `HUMAN_REPLIED`?) hay chỉ handoff.
- source_spec: `spec-4-7-gui-tin-24-gio.md`
  summary: Xác nhận bằng Meta thật: Send API `/me/messages` cho IG (token Fanpage nguồn), `metadata` cho IG, Threads publish container trả lời ngay sau khi tạo (tài liệu khuyên chờ), giới hạn ký tự IG 1000.
  evidence: Đường gửi mới chỉ chạy với Meta giả/fake client. Threads publish lỗi tạm thì retry tạo container mới (container cũ mồ côi, vô hại).
- source_spec: `spec-4-7-gui-tin-24-gio.md`
  summary: Gửi tin hết giờ / lỗi mạng (không có phản hồi HTTP) hoặc 5xx có thể đã tới Meta → không retry tự động mà ghi `failed` `SEND_UNKNOWN` (hoặc tra lại trước khi retry); Threads tách retry bước publish khỏi bước tạo container.
  evidence: `deliverMessage` (server/src/modules/inbox/send.ts) coi mọi `TRANSIENT` là retry được — `transientFailure()` của adapter gộp hết giờ, lỗi kết nối và 5xx — nên tin có thể tới khách 2–6 lần; Threads `threads_publish` hết giờ mà đã đăng thì retry tạo container mới và đăng lại. Cần adapter phân biệt "chưa gửi được" (DNS/kết nối bị từ chối) với "không rõ" (hết giờ sau khi gửi) và quyết định sản phẩm (AD-10 hiện ghi retry lỗi tạm). Story 4.5 giảm bớt: echo Messenger (`metadata`) tới trong 5 giây backoff đầu đặt tin `sent` nên lần retry không chiếm lại được; IG/Threads/bình luận và echo tới muộn vẫn có thể gửi trùng.
- source_spec: `spec-4-5-nhan-dien-echo.md`
  summary: Xác nhận bằng sự kiện Meta thật: echo IG có `app_id`/`metadata` không, bình luận FB/IG của trang và trả lời Threads của tài khoản có về webhook không, IG `messaging_seen` dạng `read.mid`, Business Suite gửi `app_id` riêng.
  evidence: Phân loại echo (`server/src/modules/inbox/echo.ts`) theo tài liệu Meta; echo không `app_id` (bình luận, Threads, có thể IG) chỉ khớp được theo id/nội dung, không khớp thì sau ~15 giây coi là chủ shop trả lời ngoài app (`external_human`) — nếu Meta đổi chữ tin app gửi (vd rút gọn link) thì tin app có thể bị tính là ngoài app và tắt AI.
- source_spec: `spec-4-5-nhan-dien-echo.md`
  summary: Tin của trang vào luồng chưa có hội thoại (khách cũ trước khi kết nối, nhắn riêng từ Business Suite) đang bị bỏ (`ignored`).
  evidence: `ingestEcho` trả `no_conversation`, không tạo khách/hội thoại từ tin của trang; khi khách trả lời thì hội thoại mới không có tin trước đó của trang. Cân nhắc khi làm hội thoại `dm` từ nhắn riêng (việc hoãn của 4.7).
- source_spec: `spec-4-5-nhan-dien-echo.md`
  summary: Phản hồi tự động của Meta (Instant Reply, tin vắng mặt, câu hỏi thường gặp cấu hình trong Business Suite) bị coi là chủ shop trả lời ngoài app → hội thoại sang `human` và tắt AI.
  evidence: `echoAuthor` (server/src/modules/inbox/echo.ts) xếp mọi echo có `app_id` khác app mình vào `other_app` → `external_human` + `applyHumanReply` ngay; tin tự động của Meta có `app_id` của app Meta, payload không có cờ "tự động". Cần sự kiện thật để tìm dấu hiệu (app_id riêng, `metadata`, thời điểm ngay sau tin đầu của khách…) và quyết định sản phẩm (bỏ qua / chèn không đổi trạng thái) trước khi AI trả lời thật ở Epic 5.
- source_spec: `spec-4-8-goi-y-bang-ai.md`
  summary: Hậu kiểm độ dài bản nháp AI theo giới hạn nền tảng (Threads 500, tin nhắn Instagram 1000) thay vì chỉ theo `kind` (`reply` 2000 / `comment` 1000).
  evidence: `ai.checkOutput` nhận `{brand, kind}`; gợi ý chỉ nêu giới hạn nền tảng trong prompt, còn ô soạn đếm ký tự và chặn nút Gửi khi quá `sendTextLimit`. Epic 5 (AI tự gửi) cần vi phạm `too_long` đúng nền tảng để sinh lại / handoff — thêm `maxChars` (hoặc kind theo nền tảng) cho `checkOutput`.
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
