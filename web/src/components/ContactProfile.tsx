// Hồ sơ khách sửa được (Story 4.9) — dùng chung cho panel khách trong Hộp thư và ngăn kéo khách ở `/khach-hang`.
// - Giai đoạn và thẻ lưu ngay khi đổi (PATCH); tên, SĐT, ghi chú sửa nháp rồi bấm "Lưu" (SĐT kiểm cùng luật server).
// - "Tóm tắt bằng AI": job ở server (`contact_summary`), nút khoá theo khoá OpenAI / hạn mức (AiLockHint), đang chạy thì
//   hiện "AI đang tóm tắt…"; bản tóm tắt gắn nhãn "AI tạo" (màu tím chỉ cho thứ AI làm).
import type { ContactDetailDto, ContactStage } from '@ottm/shared'
import { Plus, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { useAiBudget } from '../lib/ai-budget'
import { useApp } from '../lib/app-context'
import { CONTACT_STAGE_LABEL, STAGE_OPTIONS, STAGE_STYLE, addTag, phoneError, summaryNote, useSummarizeContact, useUpdateContact } from '../lib/contacts'
import { errorMessageOf } from '../lib/error-messages'
import { messageTimeLabel, useNow } from '../lib/inbox'
import { AiLockHint } from './AiLockHint'
import { AiBadge, Button, Field, Input, Select, Textarea, cn } from './ui'

export function StagePill({ stage }: { stage: ContactStage }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', STAGE_STYLE[stage].pill)}>
      <span className={cn('size-1.5 rounded-full', STAGE_STYLE[stage].dot)} />
      {CONTACT_STAGE_LABEL[stage]}
    </span>
  )
}

/** Giai đoạn + thẻ + tên/SĐT/ghi chú + tóm tắt AI của một khách. `showName`: hiện ô sửa tên (ngăn kéo Khách hàng). */
export function ContactProfile({ contact, showName = false }: { contact: ContactDetailDto; showName?: boolean }) {
  const { notify } = useApp()
  const update = useUpdateContact()
  const [tagInput, setTagInput] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)
  // Chỉ giữ ô đang sửa: ô chưa đụng tới luôn hiện giá trị mới nhất của server (realtime / màn khác sửa).
  const [edits, setEdits] = useState<Partial<Record<'name' | 'phone' | 'note', string>>>({})
  const saved = { name: contact.name ?? '', phone: contact.phone ?? '', note: contact.note ?? '' }
  const draft = { name: edits.name ?? saved.name, phone: edits.phone ?? saved.phone, note: edits.note ?? saved.note }
  const dirty = draft.name !== saved.name || draft.phone !== saved.phone || draft.note !== saved.note
  const phoneErr = phoneError(draft.phone)

  const save = (patch: Parameters<typeof update.mutate>[0]['patch'], onDone?: () => void) =>
    update.mutate({ id: contact.id, patch }, { onSuccess: () => onDone?.(), onError: (err) => notify(errorMessageOf(err)) })

  const submitTag = () => {
    const r = addTag(contact.tags, tagInput)
    if ('error' in r) {
      setTagError(r.error)
      return
    }
    setTagError(null)
    save({ tags: r.tags }, () => setTagInput(''))
  }

  const saveFields = () => {
    if (!dirty || phoneErr) return
    save({ ...(showName ? { name: draft.name } : {}), phone: draft.phone, note: draft.note }, () => {
      setEdits({})
      notify('Đã lưu hồ sơ khách')
    })
  }

  return (
    <div className="space-y-4">
      <Field label="Giai đoạn">
        <Select
          options={STAGE_OPTIONS}
          value={contact.stage}
          disabled={update.isPending}
          onChange={(e) => save({ stage: e.target.value as ContactStage })}
          aria-label="Giai đoạn"
        />
      </Field>

      <div>
        <div className="mb-1.5 text-[13px] font-medium">Thẻ</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {contact.tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-1 pl-2 text-xs font-medium text-slate-700">
              {t}
              <button
                onClick={() => save({ tags: contact.tags.filter((x) => x !== t) })}
                disabled={update.isPending}
                aria-label={`Bỏ thẻ ${t}`}
                className="rounded-full p-0.5 hover:bg-slate-200"
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <input
              value={tagInput}
              onChange={(e) => {
                setTagInput(e.target.value)
                setTagError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitTag()
                }
              }}
              placeholder="Thêm thẻ…"
              aria-label="Thêm thẻ"
              className="h-6 w-28 rounded-full border border-dashed border-slate-300 px-2 text-xs focus:border-primary focus:outline-none"
            />
            {tagInput.trim() && (
              <button onClick={submitTag} disabled={update.isPending} className="rounded-full p-0.5 text-primary hover:bg-primary-soft" aria-label="Thêm thẻ">
                <Plus size={14} />
              </button>
            )}
          </span>
        </div>
        {tagError && <p className="mt-1 text-xs text-danger">{tagError}</p>}
      </div>

      {showName && (
        <Field label="Tên">
          <Input value={draft.name} onChange={(e) => setEdits({ ...edits, name: e.target.value })} placeholder="Tên khách" maxLength={200} />
        </Field>
      )}
      <Field label="Số điện thoại" hint={phoneErr ? <span className="text-danger">{phoneErr}</span> : undefined}>
        <Input value={draft.phone} onChange={(e) => setEdits({ ...edits, phone: e.target.value })} placeholder="Ví dụ: 0912 345 678" inputMode="tel" aria-invalid={!!phoneErr} />
      </Field>
      <Field label="Ghi chú">
        <Textarea rows={3} value={draft.note} onChange={(e) => setEdits({ ...edits, note: e.target.value })} placeholder="Thêm ghi chú về khách…" maxLength={5000} />
      </Field>
      {dirty && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEdits({})}>
            Huỷ
          </Button>
          <Button size="sm" variant="primary" onClick={saveFields} disabled={!!phoneErr || update.isPending}>
            Lưu
          </Button>
        </div>
      )}

      <AiSummaryBox contact={contact} />
    </div>
  )
}

function AiSummaryBox({ contact }: { contact: ContactDetailDto }) {
  const { notify, aiLock } = useApp()
  const budgetBlocked = useAiBudget().data?.state === 'blocked'
  const summarize = useSummarizeContact()
  const note = summaryNote(contact)
  const pending = contact.aiSummaryStatus === 'pending' || summarize.isPending
  const noHistory = contact.conversations.length === 0
  const locked = aiLock.locked || budgetBlocked
  const lockHint = budgetBlocked ? 'Đã hết hạn mức chi phí AI tháng này' : undefined
  const now = useNow()

  return (
    <div className="rounded-md border border-violet-200 bg-ai-soft/60 p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ai">
          <Sparkles size={14} /> Tóm tắt bằng AI
        </span>
        <AiLockHint locked={locked} align="end" {...(lockHint ? { hint: lockHint } : {})}>
          <Button
            size="sm"
            variant="ai"
            disabled={locked || pending || noHistory}
            title={noHistory ? 'Khách chưa có tin nhắn' : undefined}
            onClick={() => summarize.mutate(contact.id, { onError: (err) => notify(errorMessageOf(err)) })}
          >
            {pending ? 'Đang tóm tắt…' : contact.aiSummary ? 'Tóm tắt lại' : 'Tóm tắt'}
          </Button>
        </AiLockHint>
      </div>
      {contact.aiSummary ? (
        <>
          <p className="text-[13px] leading-relaxed text-slate-700">{contact.aiSummary.text}</p>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <AiBadge /> {messageTimeLabel(contact.aiSummary.generatedAt, now)}
          </div>
        </>
      ) : (
        !note && <p className="text-xs text-muted-foreground">Chưa có tóm tắt. AI đọc tin nhắn trên mọi trang và tóm tắt nhu cầu của khách.</p>
      )}
      {note && <p className={cn('mt-1.5 text-xs', note.tone === 'error' ? 'text-danger' : 'text-ai')}>{note.text}</p>}
    </div>
  )
}
