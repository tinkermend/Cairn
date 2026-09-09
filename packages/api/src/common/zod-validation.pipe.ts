import { BadRequestException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common'
import { ZodError, type ZodType } from 'zod'

/**
 * 用 zod schema 校验入参。
 *
 * 不用 nestjs-zod：它的 peer 只到 @nestjs/common ^11，且会把
 * @nestjs/swagger 拉成 peer。本类自己拥有，不必在每个 Nest
 * 大版本上等第三方跟进。
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value)
    } catch (error) {
      if (error instanceof ZodError) {
        throw new BadRequestException({
          message: '请求参数校验失败',
          issues: error.issues.map((i) => ({
            path: i.path.join('.'),
            code: i.code,
            message: i.message,
          })),
        })
      }
      throw error
    }
  }
}
