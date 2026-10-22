// inbox → campaigns: KHÔNG có trong bảng mũi tên AD-1.
import { campaign } from '../campaigns/index.ts'
// inbox → connections, ai: được phép.
import { connection } from '../connections/index.ts'
import { ai } from '../ai/index.ts'

export const inbox = [campaign, connection, ai].join()
