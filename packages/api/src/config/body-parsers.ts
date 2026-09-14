import {
  BadRequestException,
  PayloadTooLargeException,
  type INestApplication,
} from '@nestjs/common'
import { json, urlencoded, type RequestHandler, type Request } from 'express'

/** 开放服务、受管浏览器与续跑：解析前 64 KiB。控制台其它写入仍 1 MiB。 */
export function isManagedBrowserWritePath(path: string): boolean {
  const clean = (path.split('?')[0] ?? path).replace(/\/+$/, '')
  return /(?:^|\/)(?:api\/)?runs\/[^/]+\/(?:browser(?:\/.*)?|resume-auth)$/.test(clean)
}

function limitParser(parse: RequestHandler, when: (req: Request) => boolean): RequestHandler {
  return (req, res, next) => {
    if (!when(req)) return next()
    parse(req, res, (error) => {
      if (!error) return next()
      next(
        error.type === 'entity.too.large'
          ? new PayloadTooLargeException('请求体最多 64 KiB')
          : new BadRequestException('请求体无效'),
      )
    })
  }
}

/** Install once before init/listen: tighter limits must precede the console 1 MiB parser. */
export function configureBodyParsers(app: INestApplication) {
  for (const parse of [json({ limit: '64kb' }), urlencoded({ extended: true, limit: '64kb' })]) {
    app.use(limitParser(parse, (req) => req.path.startsWith('/api/open/v1')))
    app.use(limitParser(parse, (req) => isManagedBrowserWritePath(req.path)))
  }
  // Explicit parsers also cover console requests under Express 5.
  app.use(json({ limit: '1mb' }))
  app.use(urlencoded({ extended: true, limit: '1mb' }))
}
