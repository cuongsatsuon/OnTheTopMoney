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
  summary: Helper dựng URL `/media/...` (và `/privacy`) theo `API_ORIGIN` phía web.
  evidence: Chưa xác minh — chưa màn nào hiển thị media; khi có (Epic 3+), đường tương đối trên Hostinger sẽ rơi vào SPA fallback và trả index.html 200.
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
