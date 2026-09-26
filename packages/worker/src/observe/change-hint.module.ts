import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common'
import { createChangeHint, type ChangeHintBus } from '@cairn/db'
import { config, resolveDbEnv } from '../config/env'
import { RunControlHintService } from './run-control-hint.service'
import { CHANGE_HINT } from './change-hint.token'

export { CHANGE_HINT } from './change-hint.token'

@Global()
@Module({
  providers: [
    {
      provide: CHANGE_HINT,
      useFactory: (): ChangeHintBus =>
        createChangeHint({
          hint: config.CAIRN_CHANGE_HINT,
          redisUrl: config.CAIRN_REDIS_URL,
          namespace: config.CAIRN_CHANGE_HINT_NAMESPACE,
          dbEnv: resolveDbEnv(),
        }),
    },
    RunControlHintService,
  ],
  exports: [CHANGE_HINT, RunControlHintService],
})
export class ChangeHintModule implements OnApplicationShutdown {
  constructor(@Inject(CHANGE_HINT) private readonly bus: ChangeHintBus) {}

  async onApplicationShutdown(): Promise<void> {
    await this.bus.close()
  }
}
