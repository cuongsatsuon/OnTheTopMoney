---
name: OnTheTopMoney
description: Bảng điều khiển cá nhân quản lý nhiều Fanpage Facebook, Instagram, Threads — hộp thư CRM có AI trả lời, AI sinh bài kèm ảnh, chiến dịch nuôi page và đo hiệu suất. shadcn/ui trên Next.js + Tailwind; file này chỉ mô tả lớp thương hiệu.
status: draft
updated: 2026-10-19
colors:
  # Lớp thương hiệu. Các token không liệt kê kế thừa mặc định shadcn (slate).
  primary: '#0F766E'
  primary-hover: '#115E59'
  primary-foreground: '#FFFFFF'
  primary-soft: '#CCFBF1'
  ai: '#7C3AED'
  ai-soft: '#EDE9FE'
  ai-foreground: '#FFFFFF'
  background: '#F8FAFC'
  surface: '#FFFFFF'
  border: '#E2E8F0'
  foreground: '#0F172A'
  muted-foreground: '#64748B'
  success: '#16A34A'
  success-foreground: '#15803D'
  success-soft: '#F0FDF4'
  warning: '#D97706'
  warning-foreground: '#92400E'
  warning-soft: '#FEF3C7'
  danger: '#DC2626'
  danger-foreground: '#B91C1C'
  danger-soft: '#FEF2F2'
  # Bảng màu nhóm cố định. Chip nhóm: nền = màu nhóm ở độ đậm 12%, chữ = màu nhóm.
  # Mỗi màu đạt ≥4.5:1 trên trắng; khi build cần kiểm lại tương phản chữ trên nền 12%.
  group-1: '#DB2777'
  group-2: '#2563EB'
  group-3: '#C2410C'
  group-4: '#15803D'
  group-5: '#7C3AED'
  group-6: '#0E7490'
  group-7: '#A16207'
  group-8: '#475569'
  platform-facebook: '#1877F2'
  platform-instagram: '#E1306C'
  platform-threads: '#101010'
  sidebar: '#0B1F1D'
  sidebar-foreground: '#CBD5E1'
  sidebar-active: '#134E4A'
typography:
  display:
    fontFamily: 'Be Vietnam Pro'
    fontSize: 28px
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: -0.01em
  title:
    fontFamily: 'Be Vietnam Pro'
    fontSize: 20px
    fontWeight: '600'
    lineHeight: '1.3'
  section:
    fontFamily: 'Be Vietnam Pro'
    fontSize: 16px
    fontWeight: '600'
    lineHeight: '1.4'
  body:
    fontFamily: 'Be Vietnam Pro'
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.5'
  label:
    fontFamily: 'Be Vietnam Pro'
    fontSize: 13px
    fontWeight: '500'
    lineHeight: '1.4'
  caption:
    fontFamily: 'Be Vietnam Pro'
    fontSize: 12px
    fontWeight: '400'
    lineHeight: '1.4'
  metric:
    fontFamily: 'Be Vietnam Pro'
    fontSize: 28px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
  '5': 20px
  '6': 24px
  '8': 32px
  sidebar-width: 240px
  topbar-height: 56px
  content-max: 1440px
  inbox-list-width: 340px
  inbox-panel-width: 320px
components:
  button-primary:
    background: '{colors.primary}'
    background-hover: '{colors.primary-hover}'
    foreground: '{colors.primary-foreground}'
    radius: '{rounded.md}'
  button-ai:
    background: '{colors.ai}'
    foreground: '{colors.ai-foreground}'
    radius: '{rounded.md}'
    icon: 'sparkles'
  ai-badge:
    background: '{colors.ai-soft}'
    foreground: '{colors.ai}'
    radius: '{rounded.full}'
    typography: '{typography.caption}'
  platform-dot:
    facebook: '{colors.platform-facebook}'
    instagram: '{colors.platform-instagram}'
    threads: '{colors.platform-threads}'
    size: 16px
  group-chip:
    background: '{colors.group-N} @ 12% opacity'
    foreground: '{colors.group-N}'
    dot: '{colors.group-N}'
    radius: '{rounded.full}'
  conversation-row:
    background: '{colors.surface}'
    background-selected: '{colors.primary-soft}'
    unread-indicator: '{colors.primary}'
    handoff-chip: '{components.status-warning}'
    ai-chip: '{components.ai-badge}'
    height: 72px
  chat-bubble-customer:
    background: '#F1F5F9'
    foreground: '{colors.foreground}'
    radius: '{rounded.lg}'
    align: left
  chat-bubble-human:
    background: '{colors.primary}'
    foreground: '{colors.primary-foreground}'
    radius: '{rounded.lg}'
    align: right
  chat-bubble-ai:
    background: '{colors.ai-soft}'
    foreground: '{colors.foreground}'
    label: '{components.ai-badge}'
    radius: '{rounded.lg}'
    align: right
  system-note:
    background: '{colors.warning-soft}'
    foreground: '{colors.warning-foreground}'
    radius: '{rounded.full}'
    typography: '{typography.caption}'
    align: center
  inherit-banner:
    background-inheriting: '{colors.primary-soft} @ 50%'
    border-inheriting: '{colors.primary} @ 30%'
    background-own: '#F8FAFC'
    border-own: '{colors.border}'
    radius: '{rounded.md}'
    control: 'switch "Dùng … riêng" bên phải'
  kpi-card:
    background: '{colors.surface}'
    border: '{colors.border}'
    radius: '{rounded.lg}'
    value: '{typography.metric}'
  sidebar-item-active:
    background: '{colors.sidebar-active}'
    foreground: '#FFFFFF'
    indicator: '{colors.primary-soft}'
  status-warning:
    background: '{colors.warning-soft}'
    foreground: '{colors.warning-foreground}'
  status-success:
    background: '{colors.success-soft}'
    foreground: '{colors.success-foreground}'
  status-danger:
    background: '{colors.danger-soft}'
    foreground: '{colors.danger-foreground}'
---

## Brand & Style

OnTheTopMoney là công cụ làm việc của một người vận hành nhiều page bán hàng cùng lúc. Giao diện cần cảm giác **phòng điều khiển gọn gàng**: nhiều thông tin trên một màn hình, nhưng luôn rõ việc nào cần làm ngay. Phong cách là SaaS chuyên nghiệp, sáng, mật độ cao vừa phải. Không trang trí, không gradient lớn, không minh hoạ hoạt hình.

Có hai "giọng" màu tách bạch: **xanh teal** là thương hiệu và hành động của người dùng, **tím** là dấu hiệu *AI đang làm hoặc đã làm việc này*. Người dùng phải nhìn một giây là biết nội dung nào do AI tạo, tin nhắn nào AI đã trả lời.

Kế thừa shadcn/ui; file này chỉ mô tả phần thương hiệu thay đổi. [ASSUMPTION] Hướng hình ảnh do Claude tự chọn theo yêu cầu "tự quyết"; có thể đổi màu chủ đạo mà không ảnh hưởng EXPERIENCE.md.

## Colors

- **Teal chủ đạo (`{colors.primary}`)**: nút chính, mục menu đang chọn, liên kết, thanh tiến độ chiến dịch. Gợi "tăng trưởng, tiền về" mà không lạm dụng xanh lá.
- **Tím AI (`{colors.ai}`, nền nhạt `{colors.ai-soft}`)**: chỉ dùng cho những gì liên quan AI: nút "Tạo bằng AI", nhãn "AI tạo", bong bóng tin nhắn do AI gửi, trạng thái "AI đang trả lời". Không dùng cho trang trí hay nút thường.
- **Màu nền tảng**: Facebook `{colors.platform-facebook}`, Instagram `{colors.platform-instagram}`, Threads `{colors.platform-threads}`. Chỉ dùng trong biểu tượng nền tảng và đường biểu đồ theo nền tảng.
- **Trạng thái**: `{colors.success}` đang hoạt động / đã đăng, `{colors.warning}` token sắp hết hạn / chờ duyệt, `{colors.danger}` mất kết nối / đăng lỗi. Ba màu này chỉ dùng cho chấm, icon, viền. **Chữ** trong chip trạng thái dùng biến thể `-foreground` (`{colors.success-foreground}` 5,0:1, `{colors.warning-foreground}` 6,4:1 trên nền nhạt, `{colors.danger-foreground}`) để đạt WCAG AA.
- **Sidebar tối (`{colors.sidebar}`)**: tách vùng điều hướng khỏi vùng làm việc sáng.
- **Màu nhóm (`{colors.group-1}`…`{colors.group-8}`)**: người dùng chọn một trong 8 màu cố định khi tạo nhóm. Chip nhóm dùng nền 12% của màu đó, chữ và chấm là màu đầy đủ. Không cho nhập màu tự do để luôn giữ được độ tương phản.

Các cặp chính phải đạt AA: `{colors.foreground}` trên `{colors.background}` (17:1), `{colors.muted-foreground}` trên `{colors.surface}` (4,8:1), `{colors.primary-foreground}` trên `{colors.primary}` (5,5:1), `{colors.ai}` trên `{colors.ai-soft}` (5,1:1), `{colors.sidebar-foreground}` trên `{colors.sidebar}` (11:1).

## Typography

Toàn bộ dùng **Be Vietnam Pro**: thiết kế cho tiếng Việt, dấu không bị cắt hay chồng. Thang chữ: `display` 28 cho tiêu đề trang, `title` 20, `section` 16 cho tiêu đề khối, `body` 14 mặc định, `label` 13 cho nhãn form và cột bảng, `caption` 12 cho thời gian và metadata. Số liệu KPI dùng `metric` 28 đậm, chữ số dạng tabular.

## Layout & Spacing

Thang 4px. Khung ứng dụng: sidebar `{spacing.sidebar-width}` + thanh trên `{spacing.topbar-height}` + vùng nội dung rộng tối đa `{spacing.content-max}`, lề 24px. Thiết kế cho màn hình ≥1280px.

Hộp thư dùng bố cục 3 cột: danh sách hội thoại `{spacing.inbox-list-width}`, khung chat co giãn, hồ sơ khách `{spacing.inbox-panel-width}`. Trang cấu hình (Brand profile, AI trả lời) dùng 2 cột: menu mục con bên trái, form bên phải, và có thể thêm cột xem trước.

## Elevation & Depth

Phân lớp bằng màu nền và viền 1px `{colors.border}`, không bằng bóng. Bóng nhẹ chỉ dùng cho dropdown, popover, dialog và thẻ đang kéo trên lịch.

## Shapes

`{rounded.sm}` cho input và chip nhỏ, `{rounded.md}` cho nút, `{rounded.lg}` cho thẻ và dialog, `{rounded.full}` cho avatar, badge, chip nhóm.

## Components

Dùng nguyên shadcn: Button (biến thể phụ), Card, Dialog, Sheet, Tabs, Table, DropdownMenu, Command, Switch, Toast, Calendar, Popover.

Thành phần riêng:

- **Nút AI**: nền `{colors.ai}`, icon lấp lánh (sparkles) bên trái. Chỉ dùng cho hành động gọi AI.
- **Nhãn AI**: chip `{colors.ai-soft}` / chữ `{colors.ai}`, nội dung "AI tạo" hoặc "AI trả lời".
- **Biểu tượng nền tảng**: icon 16px đúng màu nền tảng, gắn góc dưới phải avatar page.
- **Chip nhóm**: bo tròn, nền là màu nhóm nhạt, chữ là màu nhóm.
- **Thẻ KPI**: nền trắng, viền, giá trị `metric`, dòng so sánh kỳ trước có mũi tên xanh/đỏ.
- **Bộ chọn phạm vi**: dropdown ở thanh trên; mục gồm "Tất cả trang", các nhóm (kèm chip màu) và từng page (kèm icon nền tảng).
- **Dòng hội thoại (`conversation-row`)**: cao 72px; avatar khách kèm icon nền tảng; dòng 1 tên + giờ, dòng 2 trích tin cuối, dòng 3 tên trang + chip trạng thái. Chưa đọc: chấm teal và tên đậm. Đang chọn: nền `{colors.primary-soft}`.
- **Bong bóng chat**: khách bên trái nền xám nhạt; người dùng bên phải nền teal chữ trắng; AI bên phải nền `{colors.ai-soft}` có nhãn "AI trả lời" phía trên. Chỉ báo "đang gõ" là 3 chấm cùng màu với người gửi.
- **Ghi chú hệ thống (`system-note`)**: viên thuốc ở giữa khung chat, nền vàng nhạt, chữ `{colors.warning-foreground}`, nêu lý do AI chuyển cho người.
- **Nhãn kế thừa (`inherit-banner`)**: dải ngang trên đầu form cấu hình. Đang kế thừa: nền teal nhạt, viền teal 30%, câu "Đang dùng … của <tên nhóm>". Đang dùng riêng: nền xám nhạt, viền thường. Công tắc "Dùng … riêng" luôn ở bên phải.

## Do's and Don'ts

| Nên | Không nên |
|---|---|
| Dùng tím chỉ cho thứ do AI tạo hoặc thực hiện | Dùng tím làm màu trang trí hay nút thường |
| Luôn hiện icon nền tảng cạnh tên page | Phân biệt nền tảng chỉ bằng chữ |
| Phân lớp bằng viền và nền | Đổ bóng đậm cho mọi thẻ |
| Viết toàn bộ giao diện bằng tiếng Việt có dấu | Trộn nhãn tiếng Anh vào giao diện chính (trừ tên nền tảng) |
| Một nút chính teal trên mỗi khu vực | Nhiều nút chính cạnh tranh nhau |
