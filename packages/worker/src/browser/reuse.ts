import type { SessionReusePolicy } from '@cairn/shared'

/**
 * D8 复用档位在本进程内的页面策略。
 * - REUSE_PAGE：用会话 basePage，不新开页
 * - NEW_PAGE / RECREATE_SESSION（重建后）：新开 Run 页；释放租约时保留 last page 供空闲投影
 */
export function pageStrategyForReuse(reuse: SessionReusePolicy): 'base' | 'new' {
  return reuse === 'REUSE_PAGE' ? 'base' : 'new'
}

/** RECREATE_SESSION 在 acquire 前关闭并增代重建；其余档位复用活会话。 */
export function shouldRecreateSession(reuse: SessionReusePolicy): boolean {
  return reuse === 'RECREATE_SESSION'
}
