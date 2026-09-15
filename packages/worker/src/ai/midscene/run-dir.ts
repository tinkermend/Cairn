import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

/** 有 Agent 在途时单代日志的上限：超过就轮换，切断的是诊断日志，不影响执行与证据。 */
export const MIDSCENE_LOG_MAX_BYTES = 64 * 1024 * 1024

type LogRotation = {
  root: string
  generation: number
  active: number
  maxBytes: number
  setResolver: (resolver: (() => string) | undefined) => void
}

let rotation: LogRotation | undefined

/**
 * SDK 的落盘目录。
 *
 * 关掉报告不等于不落盘：Node 下每个 debug topic 都会无条件写
 * `<runDir>/log/<topic>.log`，内容包含模型响应与页面描述。默认 runDir 是相对
 * 进程启动目录的 `midscene_run`，于是业务页面内容会在 Worker 的工作目录里
 * 攒出一份不受 Evidence 保留策略约束、也不进 ObjectStore 的副本。
 *
 * 因此进程启动时一次性指到 Worker 自己的临时目录，并清掉上一轮残留；
 * 不在每个 Attempt 里改这个全局配置。日志按代写进 `log/<n>/`，轮换见 beginMidsceneLogScope。
 */
export async function configureMidsceneRunDir(
  workerId: string,
  options: { maxLogBytes?: number } = {},
): Promise<string> {
  const dir = join(tmpdir(), `cairn-midscene-${workerId}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'log'), { recursive: true })
  const { setMidsceneRunDir } = await import('@midscene/shared/common')
  setMidsceneRunDir(dir)
  const { setLogDirectoryResolver } = await import('@midscene/shared/logger')
  rotation = {
    root: join(dir, 'log'),
    generation: 0,
    active: 0,
    maxBytes: options.maxLogBytes ?? MIDSCENE_LOG_MAX_BYTES,
    setResolver: setLogDirectoryResolver,
  }
  openGeneration(rotation)
  return dir
}

/**
 * SDK 的 debug 日志没有关闭开关，每个 topic 常开一个追加流，不管就会一直涨到 Worker 退出。
 * 以 Agent 存活期计数：全部结束时轮换到新一代目录并删掉旧代；仍有 Agent 在途但单代超过上限也轮换。
 * 返回的结束函数可重复调用。未配置（测试、非 Worker 进程）时是空操作。
 */
export function beginMidsceneLogScope(): () => void {
  const state = rotation
  if (!state) return () => {}
  state.active += 1
  let ended = false
  return () => {
    if (ended) return
    ended = true
    state.active -= 1
    if (rotation !== state) return
    if (state.active === 0 || directoryBytes(generationDir(state)) > state.maxBytes) rotate(state)
  }
}

export function clearMidsceneRunDir(dir: string): void {
  if (rotation && (rotation.root === dir || rotation.root.startsWith(dir + sep))) {
    rotation = undefined
  }
  rmSync(dir, { recursive: true, force: true })
}

function generationDir(state: LogRotation): string {
  return join(state.root, String(state.generation))
}

function openGeneration(state: LogRotation): void {
  const dir = generationDir(state)
  // 先建目录再切换：流打开失败会让该 topic 在本进程里永久停写。
  mkdirSync(dir, { recursive: true })
  state.setResolver(() => dir)
}

/** 切换 resolver 时 SDK 会 end 掉旧流，旧代目录随后可以直接删。 */
function rotate(state: LogRotation): void {
  const previous = generationDir(state)
  state.generation += 1
  openGeneration(state)
  rmSync(previous, { recursive: true, force: true })
}

function directoryBytes(dir: string): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) {
    try {
      total += statSync(join(dir, name)).size
    } catch {
      // 并发轮换时文件可能已被删掉
    }
  }
  return total
}
