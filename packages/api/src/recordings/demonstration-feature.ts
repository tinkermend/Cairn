import { ServiceUnavailableException } from '@nestjs/common'
import { config } from '../config/env'

/** Rollback switch closes new authoring writes; historical sources remain readable. */
export function assertDemonstrationEnabled(): void {
  if (!config.CAIRN_DEMONSTRATION_ENABLED)
    throw new ServiceUnavailableException({
      code: 'DEMONSTRATION_DISABLED',
      message: '示教导入暂未开放；现有场景与旧录制流程仍可使用',
    })
}
