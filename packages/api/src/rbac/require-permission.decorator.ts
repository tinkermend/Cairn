import { SetMetadata } from '@nestjs/common'
import type { PermissionCode } from '@cairn/shared'

export const REQUIRE_PERMISSIONS = 'cairn:requirePermissions'

/**
 * 声明本路由需要的权限，全部满足才放行（AND）。
 *
 * 未挂本装饰器的受保护路由：认证通过即可访问（例如 GET /me）。
 * 未认证的请求到不了这一层——AuthGuard 默认拒绝。
 */
export const RequirePermissions = (...codes: PermissionCode[]) =>
  SetMetadata(REQUIRE_PERMISSIONS, codes)
