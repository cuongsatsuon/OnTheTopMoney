// Postgres 18 nhúng (gói `embedded-postgres`) cho máy dev không có Docker và cho test local.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'

/** Postgres nhúng cho `npm run dev` — nguồn duy nhất của cổng/URL (db-dev, dev, drizzle.config). */
export const DEV_DB_PORT = 5433
export const DEV_DB_NAME = 'ottm'
const USER = 'postgres'
const PASSWORD = 'postgres'

export function embeddedUrl(port: number, database: string): string {
  return `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${database}`
}

export const DEV_DB_URL = embeddedUrl(DEV_DB_PORT, DEV_DB_NAME)

export interface EmbeddedPg {
  url: string
  stop(): Promise<void>
}

export async function startEmbeddedPostgres(options: {
  dataDir: string
  port: number
  database: string
  persistent?: boolean
  onLog?: (message: string) => void
}): Promise<EmbeddedPg> {
  const pg = new EmbeddedPostgres({
    databaseDir: options.dataDir,
    port: options.port,
    user: USER,
    password: PASSWORD,
    persistent: options.persistent ?? true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: options.onLog ?? (() => {}),
    onError: (err) => (options.onLog ?? console.error)(String(err)),
  })
  if (!existsSync(join(options.dataDir, 'PG_VERSION'))) await pg.initialise()
  await pg.start()

  const client = pg.getPgClient('postgres', '127.0.0.1')
  await client.connect()
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [options.database])
    if (!rowCount) await pg.createDatabase(options.database)
  } finally {
    await client.end()
  }

  return {
    url: embeddedUrl(options.port, options.database),
    stop: () => pg.stop(),
  }
}
