import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common'
import { createChangeHint, type ChangeHintBus } from '@cairn/db'
import { config, resolveDbEnv } from '../config/env'

export const CHANGE_HINT = Symbol('CHANGE_HINT')

@Global()
@Module({
  providers: [
    {
      provide: CHANGE_HINT,
      useFactory: (): ChangeHintBus =>
        createChangeHint({
          hint: config.CAIRN_CHANGE_HINT,
          redisUrl: config.CAIRN_REDIS_URL,
          namespace: config.CAIRN_CHANGE_HINT_NAMESPACE ?? config.CAIRN_ENV,
          dbEnv: resolveDbEnv(),
        }),
    },
  ],
  exports: [CHANGE_HINT],
})
export class ChangeHintModule implements OnApplicationShutdown {
  constructor(@Inject(CHANGE_HINT) private readonly bus: ChangeHintBus) {}

  async onApplicationShutdown(): Promise<void> {
    await this.bus.close()
  }
}
