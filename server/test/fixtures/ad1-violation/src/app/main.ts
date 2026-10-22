// Entrypoint được import mọi module, nhưng chỉ qua index.ts.
import { reply } from '../modules/inbox/reply.ts'

export const main = reply
