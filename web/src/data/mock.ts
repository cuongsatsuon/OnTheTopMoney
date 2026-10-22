// Dữ liệu mẫu cho giao diện. Thay bằng API thật khi nối backend.

export type Platform = 'facebook' | 'instagram' | 'threads'
export type ConnectionStatus = 'active' | 'expiring' | 'disconnected'

export interface Group {
  id: string
  name: string
  color: string
  autoReply: boolean
  activeCampaigns: number
}

export interface Page {
  id: string
  name: string
  handle: string
  platform: Platform
  groupId: string | null
  followers: number
  status: ConnectionStatus
  autoReply: boolean
  brandSource: 'own' | 'group'
  avatarColor: string
}

export const GROUP_COLORS = ['#DB2777', '#2563EB', '#C2410C', '#15803D', '#7C3AED', '#0E7490', '#A16207', '#475569']

export const groups: Group[] = [
  { id: 'g-beauty', name: 'Nhóm Mỹ phẩm', color: '#DB2777', autoReply: true, activeCampaigns: 1 },
  { id: 'g-home', name: 'Nhóm Gia dụng', color: '#2563EB', autoReply: true, activeCampaigns: 1 },
  { id: 'g-fashion', name: 'Nhóm Thời trang', color: '#C2410C', autoReply: false, activeCampaigns: 0 },
]

export const pages: Page[] = [
  { id: 'p1', name: 'Mỹ phẩm Lan Anh', handle: 'mypham.lananh', platform: 'facebook', groupId: 'g-beauty', followers: 24500, status: 'active', autoReply: true, brandSource: 'group', avatarColor: '#F9A8D4' },
  { id: 'p2', name: 'lananh.beauty', handle: 'lananh.beauty', platform: 'instagram', groupId: 'g-beauty', followers: 18200, status: 'active', autoReply: true, brandSource: 'group', avatarColor: '#FBCFE8' },
  { id: 'p3', name: 'Lan Anh Skincare', handle: 'lananh.skincare', platform: 'threads', groupId: 'g-beauty', followers: 3100, status: 'active', autoReply: true, brandSource: 'own', avatarColor: '#FCE7F3' },
  { id: 'p4', name: 'Gia dụng Minh Phát', handle: 'giadung.minhphat', platform: 'facebook', groupId: 'g-home', followers: 41800, status: 'active', autoReply: true, brandSource: 'group', avatarColor: '#93C5FD' },
  { id: 'p5', name: 'minhphat.home', handle: 'minhphat.home', platform: 'threads', groupId: 'g-home', followers: 5600, status: 'expiring', autoReply: true, brandSource: 'group', avatarColor: '#BFDBFE' },
  { id: 'p6', name: 'minhphat.store', handle: 'minhphat.store', platform: 'instagram', groupId: 'g-home', followers: 12900, status: 'active', autoReply: false, brandSource: 'group', avatarColor: '#DBEAFE' },
  { id: 'p7', name: 'Thời trang Mộc', handle: 'thoitrang.moc', platform: 'facebook', groupId: 'g-fashion', followers: 9700, status: 'disconnected', autoReply: false, brandSource: 'group', avatarColor: '#FDBA74' },
  { id: 'p8', name: 'mocfashion.vn', handle: 'mocfashion.vn', platform: 'instagram', groupId: null, followers: 6400, status: 'active', autoReply: false, brandSource: 'own', avatarColor: '#FED7AA' },
]

export const pageById = (id: string) => pages.find((p) => p.id === id)!
export const groupById = (id: string | null) => (id ? groups.find((g) => g.id === id) ?? null : null)
export const pagesInGroup = (groupId: string) => pages.filter((p) => p.groupId === groupId)

export type ConversationState = 'ai' | 'handoff' | 'human' | 'done'

export interface Message {
  id: string
  from: 'customer' | 'ai' | 'human' | 'system'
  text: string
  time: string
}

export interface Conversation {
  id: string
  customerId: string
  pageId: string
  state: ConversationState
  unread: boolean
  lastMessage: string
  time: string
  waiting?: string
  handoffReason?: string
  aiEnabled: boolean
  messages: Message[]
}

export type Stage = 'Mới' | 'Đang tư vấn' | 'Chốt đơn' | 'Khách quen' | 'Khiếu nại'

export interface Contact {
  id: string
  name: string
  phone: string
  stage: Stage
  tags: string[]
  pageIds: string[]
  handledBy: 'ai' | 'human'
  lastMessage: string
  lastTime: string
  note: string
  aiSummary: string
  avatarColor: string
}

export const contacts: Contact[] = [
  { id: 'c1', name: 'Nguyễn Thu Hà', phone: '0912 345 678', stage: 'Đang tư vấn', tags: ['Quan tâm serum', 'Khách mới'], pageIds: ['p1', 'p2'], handledBy: 'ai', lastMessage: 'Serum vitamin C giá bao nhiêu vậy shop?', lastTime: '2 phút', note: 'Da dầu, hay nổi mụn vùng chữ T.', aiSummary: 'Khách quan tâm serum vitamin C, đã hỏi giá 2 lần, chưa chốt đơn. Có thể gợi ý combo serum + kem chống nắng.', avatarColor: '#FDE68A' },
  { id: 'c2', name: 'Trần Bảo Long', phone: '0987 222 111', stage: 'Khiếu nại', tags: ['Đổi trả'], pageIds: ['p4'], handledBy: 'human', lastMessage: 'Nồi chiên bị lỗi nút nguồn, shop đổi giúp mình', lastTime: '12 phút', note: 'Mua nồi chiên 5L ngày 12/10.', aiSummary: 'Khách báo nồi chiên lỗi nút nguồn sau 1 tuần, yêu cầu đổi hàng. AI đã chuyển cho bạn.', avatarColor: '#BFDBFE' },
  { id: 'c3', name: 'Hương Giang', phone: '0903 555 888', stage: 'Chốt đơn', tags: ['VIP'], pageIds: ['p2'], handledBy: 'ai', lastMessage: 'Ok shop, chị lấy 2 hộp nhé', lastTime: '25 phút', note: '', aiSummary: 'Khách quen, đặt 2 hộp kem chống nắng. Cần xác nhận địa chỉ giao hàng.', avatarColor: '#FBCFE8' },
  { id: 'c4', name: 'Đức Thịnh', phone: '0938 777 123', stage: 'Mới', tags: ['Quan tâm nồi chiên'], pageIds: ['p5'], handledBy: 'human', lastMessage: 'Có giao Đà Nẵng không shop?', lastTime: '40 phút', note: '', aiSummary: 'Khách hỏi phí và thời gian giao hàng ra Đà Nẵng. AI không chắc chính sách vùng xa nên đã chuyển cho bạn.', avatarColor: '#C7D2FE' },
  { id: 'c5', name: 'Phạm Minh Châu', phone: '0977 101 202', stage: 'Khách quen', tags: ['VIP', 'Quan tâm serum'], pageIds: ['p1', 'p3'], handledBy: 'ai', lastMessage: 'Cảm ơn shop nha', lastTime: '1 giờ', note: 'Thích quà tặng kèm.', aiSummary: 'Khách quen mua 5 lần. Vừa cảm ơn sau khi nhận hàng.', avatarColor: '#A7F3D0' },
  { id: 'c6', name: 'Lê Hoàng Yến', phone: '0911 333 444', stage: 'Đang tư vấn', tags: ['Khách mới'], pageIds: ['p8'], handledBy: 'human', lastMessage: 'Áo này còn size M không ạ?', lastTime: '2 giờ', note: '', aiSummary: 'Hỏi size áo len BST thu. Trang chưa bật AI trả lời.', avatarColor: '#FED7AA' },
  { id: 'c7', name: 'Vũ Quang Huy', phone: '0966 888 999', stage: 'Đang tư vấn', tags: ['Quan tâm nồi chiên'], pageIds: ['p4', 'p6'], handledBy: 'ai', lastMessage: 'Nồi 5L với 7L khác nhau sao shop?', lastTime: '3 giờ', note: '', aiSummary: 'So sánh nồi chiên 5L và 7L, gia đình 4 người.', avatarColor: '#FECACA' },
]

export const contactById = (id: string) => contacts.find((c) => c.id === id)!

export const conversations: Conversation[] = [
  {
    id: 'cv1', customerId: 'c1', pageId: 'p1', state: 'ai', unread: true, aiEnabled: true,
    lastMessage: 'Serum vitamin C giá bao nhiêu vậy shop?', time: '2 phút',
    messages: [
      { id: 'm1', from: 'customer', text: 'Chào shop, cho mình hỏi serum vitamin C còn hàng không?', time: '20:41' },
      { id: 'm2', from: 'ai', text: 'Dạ chào chị Hà ạ! Serum Vitamin C 15% bên shop vẫn còn hàng nha chị. Sản phẩm giúp làm sáng da và mờ thâm sau 4 tuần sử dụng ạ ✨', time: '20:41' },
      { id: 'm3', from: 'customer', text: 'Serum vitamin C giá bao nhiêu vậy shop?', time: '20:43' },
      { id: 'm4', from: 'ai', text: 'Dạ serum 30ml giá 450.000đ ạ. Tuần này shop đang tặng kèm mini kem chống nắng cho đơn từ 400k đó chị. Chị muốn shop lên đơn luôn không ạ?', time: '20:43' },
    ],
  },
  {
    id: 'cv2', customerId: 'c2', pageId: 'p4', state: 'handoff', unread: true, aiEnabled: false,
    lastMessage: 'Nồi chiên bị lỗi nút nguồn, shop đổi giúp mình', time: '12 phút', waiting: '12 phút', handoffReason: 'Khách yêu cầu đổi trả hàng lỗi',
    messages: [
      { id: 'm1', from: 'customer', text: 'Shop ơi nồi chiên mình mua tuần trước bị lỗi rồi', time: '20:31' },
      { id: 'm2', from: 'ai', text: 'Dạ shop rất tiếc vì sự cố này ạ. Anh mô tả giúp shop lỗi cụ thể được không ạ?', time: '20:31' },
      { id: 'm3', from: 'customer', text: 'Nồi chiên bị lỗi nút nguồn, shop đổi giúp mình', time: '20:32' },
      { id: 'm4', from: 'system', text: 'AI chuyển cho bạn: khách yêu cầu đổi trả hàng lỗi', time: '20:32' },
      { id: 'm5', from: 'ai', text: 'Dạ shop đã ghi nhận, nhân viên sẽ kiểm tra đơn và phản hồi anh ngay ạ.', time: '20:32' },
    ],
  },
  {
    id: 'cv3', customerId: 'c3', pageId: 'p2', state: 'ai', unread: false, aiEnabled: true,
    lastMessage: 'Ok shop, chị lấy 2 hộp nhé', time: '25 phút',
    messages: [
      { id: 'm1', from: 'customer', text: 'Kem chống nắng còn ưu đãi không em?', time: '20:10' },
      { id: 'm2', from: 'ai', text: 'Dạ còn ạ chị, mua 2 hộp giảm 10% và freeship ạ.', time: '20:10' },
      { id: 'm3', from: 'customer', text: 'Ok shop, chị lấy 2 hộp nhé', time: '20:18' },
    ],
  },
  {
    id: 'cv4', customerId: 'c4', pageId: 'p5', state: 'handoff', unread: true, aiEnabled: false,
    lastMessage: 'Có giao Đà Nẵng không shop?', time: '40 phút', waiting: '40 phút', handoffReason: 'AI không chắc chắn câu trả lời',
    messages: [
      { id: 'm1', from: 'customer', text: 'Có giao Đà Nẵng không shop?', time: '20:03' },
      { id: 'm2', from: 'system', text: 'AI chuyển cho bạn: AI không chắc chắn về chính sách giao vùng xa', time: '20:03' },
    ],
  },
  {
    id: 'cv5', customerId: 'c5', pageId: 'p3', state: 'done', unread: false, aiEnabled: true,
    lastMessage: 'Cảm ơn shop nha', time: '1 giờ',
    messages: [
      { id: 'm1', from: 'customer', text: 'Nhận hàng rồi nha shop, đóng gói xinh lắm', time: '19:40' },
      { id: 'm2', from: 'ai', text: 'Dạ shop cảm ơn chị Châu nhiều ạ 💕 Chị dùng có gì thắc mắc cứ nhắn shop nha!', time: '19:40' },
      { id: 'm3', from: 'customer', text: 'Cảm ơn shop nha', time: '19:42' },
    ],
  },
  {
    id: 'cv6', customerId: 'c6', pageId: 'p8', state: 'human', unread: true, aiEnabled: false,
    lastMessage: 'Áo này còn size M không ạ?', time: '2 giờ',
    messages: [{ id: 'm1', from: 'customer', text: 'Áo này còn size M không ạ?', time: '18:50' }],
  },
  {
    id: 'cv7', customerId: 'c7', pageId: 'p6', state: 'ai', unread: false, aiEnabled: true,
    lastMessage: 'Nồi 5L với 7L khác nhau sao shop?', time: '3 giờ',
    messages: [
      { id: 'm1', from: 'customer', text: 'Nồi 5L với 7L khác nhau sao shop?', time: '17:30' },
      { id: 'm2', from: 'ai', text: 'Dạ nồi 7L phù hợp gia đình 4–6 người, nướng được gà nguyên con ạ. Nồi 5L gọn hơn, hợp 2–4 người. Nhà mình mấy người ạ?', time: '17:30' },
    ],
  },
]

export type PostStatus = 'scheduled' | 'pending' | 'published' | 'failed' | 'draft'

export interface Post {
  id: string
  title: string
  caption: string
  pageIds: string[]
  date: string // YYYY-MM-DD
  time: string
  status: PostStatus
  ai: boolean
  campaignId?: string
  image: string
  reach?: number
  engagement?: number
}

const img = (seed: string) => `https://picsum.photos/seed/${seed}/600/600`

export const posts: Post[] = [
  { id: 'po1', title: 'Mẹo chăm da mùa hanh khô', caption: 'Da khô căng mỗi sáng? 3 bước dưỡng ẩm đơn giản giúp da mềm mịn cả ngày 💧 #lananhbeauty', pageIds: ['p1', 'p2'], date: '2026-10-20', time: '11:30', status: 'scheduled', ai: true, campaignId: 'cp1', image: img('skin1') },
  { id: 'po2', title: 'Khuyến mãi nồi chiên 20%', caption: 'Cuối tuần này: Nồi chiên không dầu giảm 20%! Chiên giòn, ít dầu, cả nhà khoẻ 🍗', pageIds: ['p4', 'p5', 'p6'], date: '2026-10-25', time: '19:00', status: 'scheduled', ai: true, image: img('fryer') },
  { id: 'po3', title: 'Review serum vitamin C', caption: '4 tuần dùng serum vitamin C: da sáng hơn, thâm mờ rõ rệt. Xem kết quả thật từ khách hàng 👇', pageIds: ['p1'], date: '2026-10-21', time: '19:30', status: 'pending', ai: true, campaignId: 'cp1', image: img('serum') },
  { id: 'po4', title: 'Hỏi đáp: da dầu dùng gì?', caption: 'Da dầu có cần dưỡng ẩm không? Câu trả lời có thể khiến bạn bất ngờ!', pageIds: ['p3'], date: '2026-10-22', time: '11:30', status: 'failed', ai: true, campaignId: 'cp1', image: img('oily') },
  { id: 'po5', title: 'Mẹo nhà bếp: khử mùi tủ lạnh', caption: 'Chỉ với 1 lát chanh và baking soda, tủ lạnh thơm tho cả tuần 🍋', pageIds: ['p5'], date: '2026-10-20', time: '19:30', status: 'scheduled', ai: true, campaignId: 'cp2', image: img('kitchen') },
  { id: 'po6', title: 'BST áo len thu', caption: 'Thu về, áo len Mộc đã sẵn sàng. Ấm áp, tối giản, dễ phối 🍂', pageIds: ['p7', 'p8'], date: '2026-10-23', time: '20:00', status: 'draft', ai: false, image: img('sweater') },
  { id: 'po7', title: 'Combo dưỡng da 3 bước', caption: 'Combo làm sạch – serum – kem chống nắng, tiết kiệm 25% 💕', pageIds: ['p2'], date: '2026-10-18', time: '19:30', status: 'published', ai: true, campaignId: 'cp1', image: img('combo'), reach: 18400, engagement: 1520 },
  { id: 'po8', title: 'Mẹo chăm da: thứ tự skincare', caption: 'Bôi gì trước, bôi gì sau? Lưu lại để không bao giờ nhầm nhé!', pageIds: ['p1'], date: '2026-10-16', time: '11:30', status: 'published', ai: true, campaignId: 'cp1', image: img('order'), reach: 32100, engagement: 2980 },
  { id: 'po9', title: 'Nồi chiên làm bánh', caption: 'Ai bảo nồi chiên chỉ để chiên? 5 món bánh dễ làm cho cuối tuần 🧁', pageIds: ['p4'], date: '2026-10-15', time: '19:00', status: 'published', ai: false, image: img('cake'), reach: 21500, engagement: 1310 },
  { id: 'po10', title: 'Hậu trường đóng gói', caption: 'Mỗi đơn hàng đều được gói bằng cả trái tim 💌', pageIds: ['p2', 'p3'], date: '2026-10-24', time: '11:30', status: 'pending', ai: true, campaignId: 'cp1', image: img('pack') },
  { id: 'po11', title: 'Mẹo: vệ sinh nồi chiên', caption: '3 phút vệ sinh nồi chiên sạch bong không cần chà', pageIds: ['p5'], date: '2026-10-21', time: '19:30', status: 'scheduled', ai: true, campaignId: 'cp2', image: img('clean') },
  { id: 'po12', title: 'Kem chống nắng nâng tông', caption: 'Chống nắng + nâng tông nhẹ, đi làm không cần makeup ☀️', pageIds: ['p1', 'p2'], date: '2026-10-27', time: '19:30', status: 'pending', ai: true, campaignId: 'cp1', image: img('sunscreen') },
]

export type CampaignStatus = 'running' | 'paused' | 'done' | 'draft'

export interface Campaign {
  id: string
  name: string
  goal: string
  pageIds: string[]
  groupId?: string
  mode: 'review' | 'auto'
  status: CampaignStatus
  pauseReason?: string
  daysDone: number
  daysTotal: number
  postsDone: number
  postsTotal: number
  nextPost: string
  trend: number[]
  topics: { name: string; share: number }[]
}

export const campaigns: Campaign[] = [
  { id: 'cp1', name: 'Nuôi page Mỹ phẩm – 30 ngày', goal: 'Tăng tương tác', pageIds: ['p1', 'p2', 'p3'], groupId: 'g-beauty', mode: 'review', status: 'running', daysDone: 12, daysTotal: 30, postsDone: 36, postsTotal: 90, nextPost: 'Hôm nay 19:30', trend: [12, 18, 15, 22, 28, 26, 34], topics: [{ name: 'Mẹo chăm da', share: 40 }, { name: 'Review sản phẩm', share: 30 }, { name: 'Hỏi đáp', share: 20 }, { name: 'Hậu trường', share: 10 }] },
  { id: 'cp2', name: 'Threads Gia dụng – mẹo nhà bếp', goal: 'Tăng người theo dõi', pageIds: ['p5'], groupId: 'g-home', mode: 'auto', status: 'paused', pauseReason: 'Trang minhphat.home sắp hết hạn token', daysDone: 8, daysTotal: 21, postsDone: 16, postsTotal: 42, nextPost: 'Tạm dừng', trend: [8, 9, 12, 11, 14, 13, 15], topics: [{ name: 'Mẹo nhà bếp', share: 60 }, { name: 'Công thức', share: 40 }] },
  { id: 'cp3', name: 'Gia dụng Minh Phát – mùa lễ hội', goal: 'Bán hàng', pageIds: ['p4', 'p6'], groupId: 'g-home', mode: 'review', status: 'running', daysDone: 3, daysTotal: 14, postsDone: 6, postsTotal: 28, nextPost: 'Mai 11:30', trend: [5, 9, 14, 12, 18, 21, 25], topics: [{ name: 'Khuyến mãi', share: 50 }, { name: 'Mẹo dùng', share: 50 }] },
  { id: 'cp4', name: 'Thời trang Mộc – BST thu', goal: 'Ra mắt sản phẩm', pageIds: ['p7', 'p8'], groupId: 'g-fashion', mode: 'review', status: 'draft', daysDone: 0, daysTotal: 14, postsDone: 0, postsTotal: 28, nextPost: 'Chưa bắt đầu', trend: [0, 0, 0, 0, 0, 0, 0], topics: [{ name: 'Phối đồ', share: 60 }, { name: 'Hậu trường', share: 40 }] },
]

export const engagement30d = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(2026, 8, 20 + i)
  const wave = Math.sin(i / 3) * 80
  return {
    day: `${d.getDate()}/${d.getMonth() + 1}`,
    facebook: Math.round(620 + i * 9 + wave),
    instagram: Math.round(410 + i * 7 + wave * 0.8),
    threads: Math.round(120 + i * 4 + wave * 0.4),
  }
})

export const brandProfile = {
  name: 'Mỹ phẩm Lan Anh',
  tagline: 'Mỹ phẩm chính hãng, tư vấn đúng loại da',
  industry: 'Mỹ phẩm',
  tones: ['Thân thiện', 'Chuyên gia', 'Trẻ trung'],
  formality: 70,
  pronoun: 'Shop – chị/bạn',
  emoji: 'Vừa phải',
  products: [
    { name: 'Serum Vitamin C 15%', price: '450.000đ' },
    { name: 'Kem chống nắng nâng tông', price: '320.000đ' },
    { name: 'Sữa rửa mặt dịu nhẹ', price: '210.000đ' },
  ],
  audience: 'Nữ 22–35 tuổi, dân văn phòng, da dầu hoặc hỗn hợp, quan tâm skincare tối giản.',
  colors: ['#DB2777', '#FCE7F3', '#1F2937'],
  hashtags: ['#lananhbeauty', '#skincare', '#myphamchinhhang'],
  banned: ['trị dứt điểm', 'cam kết 100%', 'thần dược'],
}

export const formatNumber = (n: number) => n.toLocaleString('vi-VN')
export const compact = (n: number) =>
  n >= 1000 ? `${(n / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}K` : String(n)

