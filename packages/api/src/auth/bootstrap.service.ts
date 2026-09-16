import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { ADMIN_ROLE_KEY } from '@cairn/shared'
import { config } from '../config/env'
import { RbacService } from '../rbac/rbac.service'

/**
 * 空库时种下首位管理员。已有 admin 则什么都不做。
 * 数据库未就绪（测试里常是空 mock）时只打日志，不让进程起不来。
 */
@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapService.name)

  constructor(private readonly rbac: RbacService) {}

  async onModuleInit(): Promise<void> {
    try {
      const { inserted } = await this.rbac.reconcileSystemRolePermissions()
      if (inserted > 0) {
        this.logger.warn({ inserted }, '已按权限目录补齐系统角色缺失授权')
      }
      await this.ensureAdmin()
    } catch (error) {
      this.logger.warn({ err: error }, 'bootstrap admin 跳过（数据库未就绪或查询失败）')
    }
  }

  private async ensureAdmin(): Promise<void> {
    const accounts = await this.rbac.listAccounts()
    const hasAdmin = accounts.items.some((account) => account.roles.some((role) => role.key === ADMIN_ROLE_KEY))
    if (hasAdmin) return

    const roles = await this.rbac.listRoles()
    const adminRole = roles.items.find((role) => role.key === ADMIN_ROLE_KEY)
    if (!adminRole) {
      throw new Error('系统角色 admin 缺失（0002_rbac 未执行？）')
    }

    await this.rbac.createAccount(
      {
        displayName: config.CAIRN_BOOTSTRAP_ADMIN_NAME,
        email: config.CAIRN_BOOTSTRAP_ADMIN_EMAIL,
        password: config.CAIRN_BOOTSTRAP_ADMIN_PASSWORD,
        roleIds: [adminRole.id],
      },
      null,
    )
    this.logger.warn(
      { email: config.CAIRN_BOOTSTRAP_ADMIN_EMAIL },
      '已创建首位管理员。生产环境请立刻改密，并覆盖 CAIRN_JWT_SECRET / CAIRN_BOOTSTRAP_ADMIN_PASSWORD',
    )
  }
}
