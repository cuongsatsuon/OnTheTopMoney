// Trang HTML công khai của `/privacy/*` (Story 9.1, AD-22): chính sách quyền riêng tư, trạng thái yêu cầu xoá, 404 của
// trang trạng thái. Story 9.2: trang trạng thái thêm phạm vi + tiến độ "đã xong n/m phần". HTML tĩnh, tiếng Việt, không JS, không style nội tuyến: CSS ở `/privacy/assets/privacy.css` để CSP
// của api (`PRIVACY_CSP`) chỉ cần `style-src 'self'`. Mọi giá trị từ env / DB đều qua `escapeHtml`.
// Nội dung pháp lý là khung theo AD-22 (dữ liệu, OpenAI `store: false`, thời hạn lưu, cách xoá) — chủ dự án rà lại
// trước khi nộp App Review; tên đơn vị vận hành + email lấy từ env, thiếu thì hiện chỗ trống đánh dấu rõ.
import type { DeletionRequestStatus } from '../modules/privacy/index.ts'
import { PRIVACY_PATHS } from '@ottm/shared'

/** Ngày cập nhật hiện trên trang chính sách — đổi khi sửa nội dung bên dưới. */
export const POLICY_UPDATED_AT = '24/10/2026'
export const PRIVACY_CSS_PATH = '/privacy/assets/privacy.css'
/** CSP của trang HTML `/privacy/*`: chỉ tải CSS cùng origin; không script, không form, không nhúng khung. */
export const PRIVACY_CSP = "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

export interface PolicyOperator {
  /** `PRIVACY_CONTROLLER_NAME` — tên đơn vị / người vận hành app. */
  name?: string | undefined
  /** `PRIVACY_CONTACT_EMAIL` — email nhận yêu cầu về dữ liệu. */
  email?: string | undefined
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const missing = (label: string) => `<mark class="todo">[Chưa điền: ${label}]</mark>`

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${PRIVACY_CSS_PATH}">
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`
}

export function policyHtml(operator: PolicyOperator): string {
  const name = operator.name ? escapeHtml(operator.name) : missing('tên đơn vị vận hành')
  const email = operator.email
    ? `<a href="mailto:${escapeHtml(operator.email)}">${escapeHtml(operator.email)}</a>`
    : missing('email liên hệ')
  return layout(
    'Chính sách quyền riêng tư — OnTheTopMoney',
    `<header>
  <p class="brand">OnTheTopMoney</p>
  <h1>Chính sách quyền riêng tư</h1>
  <p class="muted">Cập nhật lần cuối: ${POLICY_UPDATED_AT}</p>
</header>

<section>
  <h2>1. Chúng tôi là ai</h2>
  <p>OnTheTopMoney là ứng dụng quản lý Fanpage Facebook, tài khoản Instagram Business và Threads do ${name} vận hành cho chính cửa hàng của mình: đọc và trả lời tin nhắn, bình luận của khách, soạn và đăng bài, xem số liệu. Trong chính sách này, “chúng tôi” là ${name}; “bạn” là khách nhắn tin hoặc bình luận với các trang của chúng tôi, hoặc người đã cấp quyền cho ứng dụng qua Facebook.</p>
</section>

<section>
  <h2>2. Dữ liệu chúng tôi thu thập</h2>
  <p>Từ Facebook, Instagram và Threads, qua quyền mà chủ trang cấp cho ứng dụng:</p>
  <ul>
    <li>Thông tin trang được kết nối (tên, mã định danh, ảnh đại diện) và mã truy cập của trang — lưu ở dạng mã hoá.</li>
    <li>Tin nhắn Messenger, Instagram Direct, bình luận và trả lời Threads bạn gửi tới trang: nội dung, thời điểm, tệp đính kèm (ảnh, âm thanh, video, tệp), tên hiển thị hoặc username và mã định danh nền tảng cấp cho bạn theo trang.</li>
    <li>Bài đăng của trang và số liệu thống kê (lượt xem, lượt tiếp cận, tương tác).</li>
  </ul>
  <p>Do chủ cửa hàng nhập khi chăm sóc khách: số điện thoại, ghi chú, thẻ, giai đoạn mua hàng và bản tóm tắt hội thoại do AI viết.</p>
  <p>Nhật ký kỹ thuật: bản sao sự kiện mà Meta gửi tới ứng dụng (có thể chứa nội dung tin nhắn), nhật ký các lượt AI trả lời và nhật ký chi phí AI (không chứa nội dung tin nhắn).</p>
  <p>Chúng tôi không thu thập mật khẩu Facebook, Instagram hay Threads của bạn và không đọc dữ liệu ngoài những gì nền tảng gửi cho trang.</p>
</section>

<section>
  <h2>3. Chúng tôi dùng dữ liệu để làm gì</h2>
  <ul>
    <li>Gom tin nhắn và bình luận về một hộp thư để trả lời bạn.</li>
    <li>Để trợ lý AI tự trả lời hoặc gợi ý câu trả lời theo thông tin sản phẩm của cửa hàng, và chuyển cho người khi cần.</li>
    <li>Soạn, lên lịch, đăng bài và xem hiệu quả bài đăng.</li>
  </ul>
  <p>Chúng tôi không bán dữ liệu, không dùng dữ liệu để quảng cáo nhắm mục tiêu và không chia sẻ cho bên nào ngoài các bên xử lý ở mục 4.</p>
</section>

<section>
  <h2>4. Bên xử lý dữ liệu cho chúng tôi</h2>
  <ul>
    <li><strong>Meta Platforms</strong> (Facebook, Instagram, Threads): nguồn dữ liệu và kênh gửi câu trả lời, bài đăng.</li>
    <li><strong>OpenAI</strong>: khi AI trả lời, gợi ý, tóm tắt hoặc viết bài, nội dung tin nhắn và bình luận liên quan cùng thông tin sản phẩm của cửa hàng được gửi tới API của OpenAI để tạo câu trả lời. Ứng dụng gửi với tuỳ chọn <code>store: false</code> (yêu cầu OpenAI không lưu câu trả lời để truy xuất lại). OpenAI xử lý dữ liệu gửi qua API theo chính sách dữ liệu API do OpenAI công bố.</li>
    <li><strong>Cloudinary</strong>: lưu ảnh bài đăng, logo và tệp đính kèm của khách. Tệp của khách lưu ở chế độ riêng tư, chỉ ứng dụng tải được.</li>
    <li><strong>Máy chủ ứng dụng</strong> do chúng tôi thuê: chạy ứng dụng và cơ sở dữ liệu.</li>
  </ul>
</section>

<section>
  <h2>5. Thời gian lưu trữ</h2>
  <ul>
    <li>Tin nhắn, bình luận và hồ sơ khách: tới khi chủ cửa hàng xoá, khi có yêu cầu xoá, hoặc tối đa 30 ngày sau khi trang được gỡ khỏi ứng dụng.</li>
    <li>Bản sao sự kiện Meta gửi tới: 30 ngày; sau đó chỉ giữ thông tin kỹ thuật, không giữ nội dung.</li>
    <li>Nhật ký các lượt AI trả lời: 90 ngày.</li>
    <li>Phiên đăng nhập hết hạn: xoá ngay.</li>
    <li>Bản sao lưu cơ sở dữ liệu do chủ cửa hàng tự tạo và tự giữ; dữ liệu đã xoá có thể còn trong bản sao lưu cũ tới khi bản đó bị huỷ.</li>
  </ul>
</section>

<section>
  <h2>6. Bảo mật</h2>
  <p>Mã truy cập của trang và khoá OpenAI được mã hoá khi lưu và không bao giờ hiển thị lại. Mọi kết nối dùng HTTPS. Chỉ chủ cửa hàng đăng nhập được vào ứng dụng.</p>
</section>

<section>
  <h2>7. Quyền của bạn và cách yêu cầu xoá dữ liệu</h2>
  <ul>
    <li><strong>Bạn đã cấp quyền cho ứng dụng qua Facebook:</strong> vào phần cài đặt “Ứng dụng và trang web” của Facebook, chọn ứng dụng này, gỡ ứng dụng và gửi yêu cầu xoá dữ liệu. Facebook chuyển yêu cầu tới chúng tôi; bạn nhận một mã xác nhận và đường dẫn để xem trạng thái xoá.</li>
    <li><strong>Bạn đã nhắn tin hoặc bình luận với trang của chúng tôi:</strong> gửi email tới ${email} hoặc nhắn trực tiếp cho trang, nêu tên trang và tài khoản bạn đã dùng. Chúng tôi xoá hồ sơ của bạn và toàn bộ hội thoại liên quan khỏi ứng dụng. Tin nhắn vẫn còn trên Facebook, Instagram, Threads theo chính sách của nền tảng; bạn có thể tự xoá ở đó.</li>
    <li>Bạn cũng có thể yêu cầu xem hoặc sửa thông tin của mình qua email trên.</li>
  </ul>
</section>

<section>
  <h2>8. Thay đổi chính sách</h2>
  <p>Khi chính sách thay đổi, chúng tôi cập nhật trang này và ngày “Cập nhật lần cuối” ở đầu trang.</p>
</section>

<section>
  <h2>9. Liên hệ</h2>
  <p>${name} — ${email}</p>
</section>`,
  )
}

const VN_DATE_TIME = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** Phạm vi hiện trên trang trạng thái — không bao giờ kèm tên khách / trang (trang công khai, ai có mã cũng xem được). */
const SCOPE_LABEL: Record<DeletionRequestStatus['scope'], string> = {
  contact: 'Một khách và toàn bộ hội thoại của khách',
  page: 'Dữ liệu khách và hội thoại của một trang',
  all: 'Dữ liệu gắn với tài khoản Facebook đã cấp quyền',
}

function statusView(req: DeletionRequestStatus): { label: string; detail: string; tone: 'pending' | 'done' } {
  if (req.status === 'completed') {
    return req.matched
      ? { label: 'Đã xoá xong', detail: 'Dữ liệu gắn với yêu cầu này đã được xoá khỏi ứng dụng.', tone: 'done' }
      : { label: 'Đã hoàn tất', detail: 'Ứng dụng không lưu dữ liệu nào gắn với tài khoản này, nên không có gì cần xoá.', tone: 'done' }
  }
  if (req.status === 'processing') {
    return { label: 'Đang xoá dữ liệu', detail: 'Ứng dụng đang xoá dữ liệu gắn với yêu cầu này.', tone: 'pending' }
  }
  return { label: 'Đã nhận — đang chờ xoá', detail: 'Chúng tôi đã nhận yêu cầu và sẽ xoá dữ liệu gắn với yêu cầu này.', tone: 'pending' }
}

export function statusHtml(req: DeletionRequestStatus): string {
  const view = statusView(req)
  const progress =
    req.status !== 'completed' && req.partsTotal > 0 ? `<dt>Tiến độ</dt><dd>Đã xong ${req.partsDone}/${req.partsTotal} phần</dd>` : ''
  const scope = req.matched ? `<dt>Phạm vi</dt><dd>${SCOPE_LABEL[req.scope]}</dd>` : ''
  const completed = req.completedAt
    ? `<dt>Hoàn tất lúc</dt><dd>${escapeHtml(VN_DATE_TIME.format(req.completedAt))} (giờ Việt Nam)</dd>`
    : ''
  return layout(
    'Trạng thái yêu cầu xoá dữ liệu — OnTheTopMoney',
    `<header>
  <p class="brand">OnTheTopMoney</p>
  <h1>Trạng thái yêu cầu xoá dữ liệu</h1>
</header>
<section>
  <p class="status ${view.tone}">${view.label}</p>
  <p>${view.detail}</p>
  <dl>
    <dt>Mã xác nhận</dt><dd><code>${escapeHtml(req.code)}</code></dd>
    ${scope}
    <dt>Nhận lúc</dt><dd>${escapeHtml(VN_DATE_TIME.format(req.requestedAt))} (giờ Việt Nam)</dd>
    ${progress}
    ${completed}
  </dl>
  <p class="muted"><a href="${PRIVACY_PATHS.policy}">Chính sách quyền riêng tư</a></p>
</section>`,
  )
}

export function statusNotFoundHtml(): string {
  return layout(
    'Không tìm thấy yêu cầu — OnTheTopMoney',
    `<header>
  <p class="brand">OnTheTopMoney</p>
  <h1>Không tìm thấy yêu cầu</h1>
</header>
<section>
  <p>Mã xác nhận không đúng hoặc yêu cầu không tồn tại. Kiểm tra lại đường dẫn Facebook đã gửi cho bạn.</p>
  <p class="muted"><a href="${PRIVACY_PATHS.policy}">Chính sách quyền riêng tư</a></p>
</section>`,
  )
}

export const PRIVACY_CSS = `:root { color-scheme: light; }
body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; }
main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
header { margin-bottom: 24px; }
.brand { margin: 0; font-weight: 700; color: #4f46e5; }
h1 { margin: 4px 0; font-size: 28px; line-height: 1.25; }
h2 { margin: 28px 0 8px; font-size: 19px; }
p, li, dd { color: #334155; }
ul { padding-left: 22px; }
li { margin-bottom: 6px; }
a { color: #4338ca; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; background: #eef2ff; padding: 1px 5px; border-radius: 4px; word-break: break-all; }
.muted { color: #64748b; font-size: 14px; }
.todo { background: #fef3c7; color: #92400e; padding: 0 4px; border-radius: 4px; }
.status { display: inline-block; font-weight: 600; padding: 4px 12px; border-radius: 999px; }
.status.pending { background: #fef3c7; color: #92400e; }
.status.done { background: #dcfce7; color: #166534; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
dt { color: #64748b; }
dd { margin: 0; }
`
