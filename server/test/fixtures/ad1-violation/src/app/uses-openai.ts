// Vi phạm AD-7: entrypoint gọi thẳng adapters/openai (chỉ modules/ai được gọi).
import { checkKey } from '../adapters/openai/index.ts'

export const ok = checkKey()
