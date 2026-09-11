import { Inject, Injectable } from '@nestjs/common'
import { disposeStuckSession, listSessions, type DbHandle } from '@cairn/db'
import type { DisposeSessionBody, SessionDto, SessionListResponse } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import type { RequestAccount } from '../common/request-account'
import { rethrowDomain } from '../common/domain-error'

@Injectable()
export class BrowserSessionsService {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async list(): Promise<SessionListResponse> {
    return { items: await listSessions(this.handle.db) }
  }

  /**
   * 人工处置卡死会话。
   *
   * 控制面只改持久化状态，不持有也不关闭任何浏览器——它没有句柄，也无从验证旧进程
   * 是否真的退出，所以「已停或已隔离」由操作者声明并进审计（宪法 §12）。
   * 活会话（OPEN）一律拒绝，由持有它的 Worker 自己回收。
   */
  async dispose(
    sessionId: string,
    body: DisposeSessionBody,
    actor: RequestAccount,
  ): Promise<SessionDto> {
    try {
      return await disposeStuckSession(this.handle.db, {
        sessionId,
        actor: { id: actor.id },
        note: body.note,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }
}
