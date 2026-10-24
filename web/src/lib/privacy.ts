// Quyền riêng tư phía web (Story 9.1, AD-22): link trang chính sách + URL để chủ shop dán vào Meta App. Trang `/privacy/*`
// do api phục vụ (HTML tĩnh) và chỉ có ở host api khi web ở Hostinger → link dựng bằng `apiPublicUrl`, không dùng
// `<Link>` của router hay đường tương đối.
import { PRIVACY_PATHS, PrivacyConfigResponse } from '@ottm/shared'
import { useQuery } from '@tanstack/react-query'
import { apiFetch, apiPublicUrl } from './api'

export const PRIVACY_CONFIG_KEY = ['privacy', 'config'] as const

/** Link trang chính sách theo origin api (mở tab mới). */
export function privacyPolicyHref(): string {
  return apiPublicUrl(PRIVACY_PATHS.policy)
}

export function usePrivacyConfig() {
  return useQuery({
    queryKey: PRIVACY_CONFIG_KEY,
    queryFn: ({ signal }) => apiFetch('/privacy/config', { schema: PrivacyConfigResponse, signal }),
  })
}

/** Ba URL dán vào Meta App (thứ tự hiển thị ở Cài đặt › Tài khoản Meta). */
export function metaAppPrivacyFields(config: PrivacyConfigResponse): { label: string; hint: string; value: string }[] {
  return [
    { label: 'Privacy Policy URL', hint: 'Meta App › Settings › Basic', value: config.policyUrl },
    { label: 'Data Deletion Callback URL', hint: 'Settings › Basic › User data deletion › Data deletion callback URL', value: config.dataDeletionUrl },
    { label: 'Deauthorize Callback URL', hint: 'Facebook Login for Business › Settings', value: config.deauthorizeUrl },
  ]
}
