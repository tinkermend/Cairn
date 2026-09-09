import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { dbEnvSchema, type DbEnv } from '@cairn/shared'

export function loadEnvFile(): void {
  const file = resolve(__dirname, '../../../../.env')
  if (existsSync(file)) process.loadEnvFile(file)
}

export function loadDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  return dbEnvSchema.parse(source)
}
