// AD-1 — bảng mũi tên phụ thuộc giữa module, nguồn DUY NHẤT cho luật dependency-cruiser.
// Đổi chiều phụ thuộc = sửa ARCHITECTURE-SPINE.md trước, rồi sửa bảng này cho khớp.
//
// arrows[X] = các module X được gọi (qua `modules/<Y>/index.ts`).
// base      = module nền: mọi module được gọi; bản thân chúng không gọi module nào.
// `notifications`, `privacy` không nằm trong arrows của ai → chỉ entrypoint được gọi.
module.exports = {
  arrows: {
    webhooks: ['inbox', 'connections'],
    autoreply: ['inbox', 'profiles', 'ai'],
    campaigns: ['content', 'profiles', 'ai'],
    content: ['profiles', 'ai', 'connections'],
    analytics: ['content', 'inbox', 'connections'],
    inbox: ['connections', 'ai'],
    profiles: ['ai'],
    privacy: [],
    connections: [],
    ai: [],
    notifications: [],
  },
  base: ['pages', 'settings'],
  // AD-6 — module được import `adapters/meta` (cổng Meta duy nhất). Mọi nơi khác (kể cả app/, worker/) bị cấm.
  metaCallers: ['connections', 'inbox', 'content', 'analytics', 'webhooks'],
}
