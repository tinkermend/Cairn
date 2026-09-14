import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs, parseEnv } from 'node:util'
import { createHash } from 'node:crypto'
import { createDb } from '../packages/db/dist/index.js'
import { exportDatabase, importDatabase } from '../packages/db/dist/admin.js'
import { dbEnvSchema, apiEnvSchema } from '../packages/shared/dist/index.js'
import { createObjectStore } from '../packages/storage/dist/index.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    env: { type: 'string' },
    file: { type: 'string' },
    'writers-stopped': { type: 'boolean' },
    'allow-millisecond-precision-loss': { type: 'boolean' },
  },
})
const action = positionals[0]
if (
  !['export', 'import'].includes(action) ||
  !values.file ||
  !values.env ||
  !values['writers-stopped']
) {
  throw new Error(
    'Usage: node tools/database-transfer.mjs export|import --env <config.env> --file <archive.json> --writers-stopped [--allow-millisecond-precision-loss]',
  )
}
// Run in a dedicated process with exactly the chosen configuration. Native env
// parsing does not evaluate shell expressions and values are never printed.
const configuration = { ...process.env, ...parseEnv(await readFile(resolve(values.env), 'utf8')) }
const env = dbEnvSchema.parse(configuration)
const store = createObjectStore(apiEnvSchema.parse(configuration), {
  repoRoot: () => resolve(import.meta.dirname, '..'),
})
const database = createDb(env)
const options = {
  writersStopped: true,
  allowMillisecondPrecisionLoss: values['allow-millisecond-precision-loss'] ?? false,
  verifyObject: async ({ objectKey, digest, byteSize }) => {
    const { body } = await store.get(objectKey)
    if (
      body.byteLength !== byteSize ||
      `sha256:${createHash('sha256').update(body).digest('hex')}` !== digest
    )
      throw new Error(`Object verification failed: ${objectKey}`)
  },
}
try {
  if (action === 'export') {
    const archive = await exportDatabase(database, env, options)
    await writeFile(resolve(values.file), JSON.stringify(archive), { mode: 0o600, flag: 'wx' })
    console.log(
      JSON.stringify({
        action,
        digest: archive.digest,
        timestampPrecisionLoss: archive.timestampPrecisionLoss,
        counts: Object.fromEntries(
          Object.entries(archive.tables).map(([name, rows]) => [name, rows.length]),
        ),
      }),
    )
  } else {
    const archive = JSON.parse(await readFile(resolve(values.file), 'utf8'))
    console.log(
      JSON.stringify({ action, ...(await importDatabase(database, env, archive, options)) }),
    )
  }
} finally {
  await database.close()
}
