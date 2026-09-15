import { Controller, Get, Param, Query } from '@nestjs/common'
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

  @Get(':workerId')
  @RequirePermissions('session:read')
  get(
    @Param('workerId') workerId: string,
    @Query(new ZodValidationPipe(workerSessionListQuerySchema)) query: WorkerSessionListQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.workers.get(workerId, query, actor.permissions)
  }
}
