import type { WorkerEnv } from '@cairn/shared'
import { processModelEnvKeys } from './midscene/model-client.js'
import { clearMidsceneRunDir, configureMidsceneRunDir } from './midscene/run-dir.js'

export async function assertWorkerAiStartup(env: WorkerEnv): Promise<void> {
  const leaked = processModelEnvKeys()
  if (leaked.length > 0) {
    console.error('cairn-worker 配置校验失败，进程拒绝启动：')
    console.error(`  ✗ 进程环境不得存在 ${leaked.join('、')}（正式路径只使用 CAIRN_BROWSER_AI_*）`)
    process.exit(1)
  }
  const runDir = await configureMidsceneRunDir(env.CAIRN_WORKER_ID)
  process.once('exit', () => clearMidsceneRunDir(runDir))
}
