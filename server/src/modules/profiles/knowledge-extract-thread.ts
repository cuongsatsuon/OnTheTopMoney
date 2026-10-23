// Trích văn bản file kho kiến thức trong `worker_threads` có timeout cứng (Story 5.2, AD-16 "worker, có timeout").
// pdf.js chạy CPU đồng bộ từng đoạn: `expireInSeconds` của pg-boss không dừng được lượt đang chạy, `Promise.race`
// cũng không. Chạy trong thread riêng thì `terminate()` huỷ hẳn, và `resourceLimits` chặn file làm phình bộ nhớ của
// worker. File này vừa là module (bên gọi dùng `runExtraction`) vừa là entry của thread (nhận diện qua `workerData`).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { extractKnowledgeText, type ExtractResult, type KnowledgeFileMime } from './knowledge-files.ts'

const THREAD_KIND = 'ottm-knowledge-extract'
/** Thời gian tối đa cho một file [ASSUMPTION]: PDF 10 MB nhiều trang đọc trong vài giây. */
export const EXTRACT_TIMEOUT_MS = 60_000
/** Heap tối đa của thread — PDF hỏng/cố ý phình bị dừng, không kéo sập worker. */
const THREAD_MAX_OLD_GENERATION_MB = 256

interface ThreadInput {
  kind: typeof THREAD_KIND
  data: Uint8Array
  mime: KnowledgeFileMime
}

/**
 * Trích văn bản trong thread riêng. Hết `timeoutMs` → huỷ thread, `EXTRACT_TIMEOUT`. Thread chết (hết bộ nhớ, lỗi
 * không bắt) → `UNREADABLE`. Không bao giờ ném.
 */
export function runExtraction(data: Buffer, mime: KnowledgeFileMime, opts: { timeoutMs?: number } = {}): Promise<ExtractResult> {
  const timeoutMs = opts.timeoutMs ?? EXTRACT_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    const input: ThreadInput = { kind: THREAD_KIND, data: new Uint8Array(data), mime }
    const worker = new Worker(new URL(import.meta.url), {
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: THREAD_MAX_OLD_GENERATION_MB },
      // Thread không cần stdin; stdout/stderr để mặc định (pdf.js đã tắt cảnh báo bằng verbosity 0).
      stdin: false,
    })
    const finish = (result: ExtractResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
      void worker.terminate().catch(() => {})
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'EXTRACT_TIMEOUT' }), timeoutMs)
    worker.once('message', (msg: ExtractResult) => finish(msg))
    worker.once('error', () => finish({ ok: false, reason: 'UNREADABLE' }))
    worker.once('exit', () => finish({ ok: false, reason: 'UNREADABLE' }))
  })
}

// ---- Entry của thread ----
const input = workerData as Partial<ThreadInput> | null
if (!isMainThread && parentPort && input?.kind === THREAD_KIND && input.data && input.mime) {
  const port = parentPort
  extractKnowledgeText(Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength), input.mime)
    .catch((): ExtractResult => ({ ok: false, reason: 'UNREADABLE' }))
    .then((result) => port.postMessage(result))
}
