import { Controller, Get, Param, Post, Query } from '@nestjs/common'
import {
  workerListQuerySchema,
  workerSessionListQuerySchema,
  type WorkerListQuery,
  type WorkerSessionListQuery,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { WorkersService } from './workers.service'

@Controller('workers')
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  @Get()
  @RequirePermissions('session:read')
  list(
    @Query(new ZodValidationPipe(workerListQuerySchema)) query: WorkerListQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.workers.list(query, actor.permissions)
  }

  @Post('purge-stale')
  @RequirePermissions('session:manage')
  purgeStale() {
    return this.workers.purgeStale()
  }

  @Get(':workerId')
  @RequirePermissions('session:read')
  get(
    @Param('workerId') workerId: string,
    @Query(new ZodValidationPipe(workerSessionListQuerySchema)) query: WorkerSessionListQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.workers.get(workerId, query, actor.permissions)
  }

  @Post(':workerId/disable')
  @RequirePermissions('session:manage')
  disable(@Param('workerId') workerId: string) {
    return this.workers.disable(workerId)
  }

  @Post(':workerId/enable')
  @RequirePermissions('session:manage')
  enable(@Param('workerId') workerId: string) {
    return this.workers.enable(workerId)
  }

  @Post(':workerId/remove')
  @RequirePermissions('session:manage')
  remove(@Param('workerId') workerId: string) {
    return this.workers.remove(workerId)
  }
}
