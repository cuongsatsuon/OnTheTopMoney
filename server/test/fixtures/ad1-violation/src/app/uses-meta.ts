// Vi phạm AD-6: entrypoint gọi thẳng adapters/meta (chỉ connections, inbox, content, analytics, webhooks được gọi).
import { graph } from '../adapters/meta/index.ts'

export const ok = graph()
