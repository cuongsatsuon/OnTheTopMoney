// Story 9.1 — link trang chính sách + ba URL cho Meta App.
import { describe, expect, it } from 'vitest'
import { metaAppPrivacyFields, privacyPolicyHref, threadsAppPrivacyFields } from './privacy'

describe('privacy', () => {
  it('link chính sách theo origin api (trống → tương đối, dev qua proxy Vite)', () => {
    expect(privacyPolicyHref()).toBe('/privacy/policy')
  })

  it('ba URL cho Meta App theo đúng thứ tự, lấy từ config của server', () => {
    const fields = metaAppPrivacyFields({
      policyUrl: 'https://api.example.com/privacy/policy',
      deauthorizeUrl: 'https://api.example.com/privacy/meta/deauthorize',
      dataDeletionUrl: 'https://api.example.com/privacy/meta/data-deletion',
      operatorConfigured: true,
      metaSecretConfigured: true,
      threadsUninstallUrl: 'https://api.example.com/privacy/threads/uninstall',
      threadsDeleteUrl: 'https://api.example.com/privacy/threads/delete',
      threadsSecretConfigured: true,
    })
    expect(fields.map((f) => [f.label, f.value])).toEqual([
      ['Privacy Policy URL', 'https://api.example.com/privacy/policy'],
      ['Data Deletion Callback URL', 'https://api.example.com/privacy/meta/data-deletion'],
      ['Deauthorize Callback URL', 'https://api.example.com/privacy/meta/deauthorize'],
    ])
  })

  it('ba URL cho Threads app (Story 9.4): chính sách chung + hai callback Threads', () => {
    const fields = threadsAppPrivacyFields({
      policyUrl: 'https://api.example.com/privacy/policy',
      deauthorizeUrl: 'https://api.example.com/privacy/meta/deauthorize',
      dataDeletionUrl: 'https://api.example.com/privacy/meta/data-deletion',
      operatorConfigured: true,
      metaSecretConfigured: true,
      threadsUninstallUrl: 'https://api.example.com/privacy/threads/uninstall',
      threadsDeleteUrl: 'https://api.example.com/privacy/threads/delete',
      threadsSecretConfigured: false,
    })
    expect(fields.map((f) => f.value)).toEqual([
      'https://api.example.com/privacy/policy',
      'https://api.example.com/privacy/threads/uninstall',
      'https://api.example.com/privacy/threads/delete',
    ])
  })
})
