#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWorkerRoleConfig } from './lib/worker-role-config.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = resolve(root, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

try {
  const role = process.argv[2]
  const config = resolveWorkerRoleConfig(process.env).find((item) => item.role === role)
  if (!config) throw new Error(`未知 Worker 角色: ${role}`)
  // URL 为空时用占位符，便于 shell 保留第三个字段。
  console.log([config.id, config.port, config.advertiseUrl || '-'].join('\t'))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
