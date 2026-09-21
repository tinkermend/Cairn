import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { RbacService } from '../rbac/rbac.service'

/**
 * 启动时按权限目录补齐系统角色的缺失授权。
 *
 * 首位管理员不在这里创建——它是种子数据的一部分（0091_bootstrap_admin_seed）。
 * 控制面只管鉴权，不兼任开户：否则「交付时有没有管理员」会取决于 API 起没起过、
 * 起的是哪个版本，而口令又只能来自代码常量或环境变量。
 *
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
    } catch (error) {
      this.logger.warn({ err: error }, '系统角色授权补齐跳过（数据库未就绪或查询失败）')
    }
  }
}
