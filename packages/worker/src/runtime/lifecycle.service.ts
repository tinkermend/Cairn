import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import type { DbHandle } from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'

/** 空转间隔。M1 接入队列轮询后，这里换成 run_queue 的 SKIP LOCKED 领取。 */
const TICK_INTERVAL_MS = 1_000

/**
 * 执行面的进程生命周期。
 *
 * createApplicationContext 不启动 HTTP 服务器，若没有任何 handle 撑住
 * 事件循环，bootstrap 返回后 Node 会立即退出。常驻进程必须自己持有
 * 存活句柄——这里是定时器，M1 之后是队列轮询循环。
 *
 * 停机同样关键：worker 会持有浏览器租约与受管 Chrome 进程，SIGTERM 时
 * 必须在退出前释放，否则租约要干等 TTL 过期、账号在此期间被锁死。
 * 这是执行面用 NestJS 独立应用而非裸 Node 的直接理由——钩子由框架保证
 * 触发，不靠手写信号处理。
 */
@Injectable()
export class LifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LifecycleService.name)
  private readonly startedAt = Date.now()
  private tick: NodeJS.Timeout | undefined

  /** 供测试断言钩子确实被框架调用 */
  shutdownSignal: string | undefined
  shutdownCalled = false

  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async onApplicationBootstrap(): Promise<void> {
    // 连不上数据库的 worker 什么也做不了，此处显式失败而非带病启动
    await this.handle.ping()

    this.tick = setInterval(() => {
      // M1：从 run_queue 领任务
    }, TICK_INTERVAL_MS)
    this.logger.log('执行面已就绪，等待任务')
  }

  isRunning(): boolean {
    return this.tick !== undefined
  }

  uptimeSeconds(): number {
    return (Date.now() - this.startedAt) / 1000
  }

  onApplicationShutdown(signal?: string): void {
    this.shutdownSignal = signal
    this.shutdownCalled = true
    if (this.tick) {
      clearInterval(this.tick)
      this.tick = undefined
    }
    this.logger.log(`收到 ${signal ?? '停机'} 信号，已停止领取任务`)
  }
}
