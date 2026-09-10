import { SetMetadata } from '@nestjs/common'

export const IS_PUBLIC = 'cairn:isPublic'

/**
 * 显式标记免鉴权的路由。
 *
 * 全局 Guard 默认拒绝，只有挂了本装饰器的路由才放行——白名单必须
 * 逐个写出来。前一代把鉴权留到最后做，结果 56 个路由里 53 个无鉴权，
 * 任何能连到端口的人都能读凭据、发起任务。默认拒绝让「忘了加鉴权」
 * 从静默漏洞变成显式的 401。
 */
export const Public = () => SetMetadata(IS_PUBLIC, true)
