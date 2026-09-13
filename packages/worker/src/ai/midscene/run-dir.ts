import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * SDK 的落盘目录。
 *
 * 关掉报告不等于不落盘：Node 下每个 debug topic 都会无条件写
 * `<runDir>/log/<topic>.log`，内容包含模型响应与页面描述。默认 runDir 是相对
 * 进程启动目录的 `midscene_run`，于是业务页面内容会在 Worker 的工作目录里
 * 攒出一份不受 Evidence 保留策略约束、也不进 ObjectStore 的副本。
 *
 * 因此进程启动时一次性指到 Worker 自己的临时目录，并清掉上一轮残留；
 * 不在每个 Attempt 里改这个全局配置。
 */
export async function configureMidsceneRunDir(workerId: string): Promise<string> {
  const dir = join(tmpdir(), `cairn-midscene-${workerId}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'log'), { recursive: true })
  const { setMidsceneRunDir } = await import('@midscene/shared/common')
  setMidsceneRunDir(dir)
  return dir
}

export function clearMidsceneRunDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
