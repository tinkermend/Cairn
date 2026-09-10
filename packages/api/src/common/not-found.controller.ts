import { All, Controller, NotFoundException } from '@nestjs/common'
import { Public } from './public.decorator'

/**
 * 兜底路由。
 *
 * 没有它，未匹配的路径会落到 Express 的默认处理器，返回一个 HTML 页面
 * ——调用方拿到的不是 @cairn/shared 约定的 JSON 错误体，前端的统一
 * 错误处理会在这里断掉。挂上之后，未知路径同样走异常过滤器。
 *
 * 标记 @Public 是为了让未知路径返回 404 而非 401：路径不存在是调用方
 * 能自己发现的问题，不该被伪装成认证失败。
 */
@Public()
@Controller()
export class NotFoundController {
  @All('*splat')
  handle(): never {
    throw new NotFoundException('接口不存在')
  }
}
