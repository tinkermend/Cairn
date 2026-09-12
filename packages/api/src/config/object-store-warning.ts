import type { ApiEnv } from '@cairn/shared'

/** local 驱动检测不了多机拓扑，非 development 必须把话说出来。不硬失败。 */
export function warnLocalObjectStoreTopology(
  env: Pick<ApiEnv, 'CAIRN_ENV' | 'CAIRN_OBJECT_STORE'>,
  warn: (message: string) => void,
): void {
  if (env.CAIRN_ENV !== 'development' && env.CAIRN_OBJECT_STORE === 'local') {
    warn(
      'CAIRN_OBJECT_STORE=local 且当前不是 development：API 与 Worker 若分机部署，Worker 写入的对象 API 读不到。单机部署可忽略。',
    )
  }
}
