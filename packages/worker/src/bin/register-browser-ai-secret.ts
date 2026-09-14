import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDb, newId, registerStandaloneSecret } from '@cairn/db'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { dbEnvSchema, formatEnvIssues } from '@cairn/shared'

async function main(): Promise<void> {
  const envFile = resolve(__dirname, '../../../../.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)

  const parsed = dbEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('登记浏览器仿真 AI 密钥失败，数据库配置无效：')
    for (const line of formatEnvIssues(parsed.error)) console.error(`  ✗ ${line}`)
    process.exit(1)
  }

  const apiKey = process.env.CAIRN_BROWSER_AI_API_KEY?.trim()
  if (!apiKey) {
    console.error('登记浏览器仿真 AI 密钥失败：')
    console.error('  ✗ CAIRN_BROWSER_AI_API_KEY: 必填，且不得作为命令行参数传入')
    process.exit(1)
  }

  const credentialKey = process.env.CAIRN_CREDENTIAL_KEY
  if (!credentialKey) {
    console.error('登记浏览器仿真 AI 密钥失败：')
    console.error('  ✗ CAIRN_CREDENTIAL_KEY: 必填')
    process.exit(1)
  }

  const handle = createDb(parsed.data)
  try {
    const id = newId()
    const secrets = new LocalSecretProvider(credentialKeyFromEnv(credentialKey))
    const registered = await registerStandaloneSecret(handle, {
      id,
      ciphertext: secrets.encrypt(id, apiKey),
    })
    console.log(`已登记浏览器仿真 AI 密钥，请把下面的引用写入环境配置：`)
    console.log(`CAIRN_BROWSER_AI_API_KEY_SECRET_ID=${registered.id}`)
  } finally {
    await handle.close()
  }
}

void main()
