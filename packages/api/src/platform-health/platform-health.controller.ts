import { Controller, Get } from '@nestjs/common'
import { PlatformHealthService } from './platform-health.service'

@Controller('platform-health')
export class PlatformHealthController {
  constructor(private readonly service: PlatformHealthService) {}

  @Get()
  async getHealth() {
    return await this.service.getPlatformHealth()
  }
}
