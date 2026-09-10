import { Module } from '@nestjs/common'
import { NotFoundController } from './not-found.controller'

/**
 * 必须作为 AppModule imports 的最后一项。
 *
 * Nest 按模块图顺序注册控制器；把兜底路由放在 AppModule.controllers
 * 里会先于被 import 的业务模块注册，Express 5 的 `*splat` 会把
 * /api/rbac/* 吃掉变成 404。独立成模块并放在 imports 末尾，保证
 * 所有业务路由先挂上。
 */
@Module({
  controllers: [NotFoundController],
})
export class NotFoundModule {}
