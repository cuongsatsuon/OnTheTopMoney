// Vi phạm AD-14: platform gọi adapters/media (chỉ module và entrypoint được gọi).
import { createMediaStores } from '../adapters/media/index.ts'

export const stores = createMediaStores()
