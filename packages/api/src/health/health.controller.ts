import { Controller, Get } from '@nestjs/common'
import type { HealthResponse } from '@cairn/shared'
import { HealthService } from './health.service'

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  check(): Promise<HealthResponse> {
    return this.health.check()
  }
}
