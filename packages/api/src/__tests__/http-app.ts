import type { INestApplication } from '@nestjs/common'
import type { ChangeHintBus } from '@cairn/db'

/** 装配测试用的空提示通道，避免 LISTEN 真实数据库。 */
export const unusedChangeHint: ChangeHintBus = {
  driver: 'none',
  realtime: false,
  namespace: 'test',
  publish: async () => undefined,
  subscribe: async () => undefined,
  ping: async () => true,
  close: async () => undefined,
}

/**
 * 让应用在整份用例文件期间持有一个固定端口，供 supertest 复用。
 *
 * supertest 在目标服务器还没 listen 时，会为**每一个请求**临时 `listen(0)`、
 * 请求结束再 close。实测连续五次 await 拿到 58230 / 58232 / 58234 / 58236 / 58238，
 * 结束后 `server.address()` 为 null——端口是一次一换的。
 *
 * api 包十六份用例并行、每份几十个请求，机器上就有大量临时端口在快速占用与
 * 释放，而操作系统会很快复用刚释放的端口号。于是某个请求可能连到另一个进程
 * 刚绑上的服务器，那个 app 没有这条路由，回一个 404。
 *
 * 这条竞态的表现是「本该存在的路由返回 404」，实测三种同源：
 * `GET /health` 得 404、`POST /rbac/roles` 得 404、未匹配路径拿到 Express 默认的
 * HTML 404（说明打到了没挂兜底路由的另一个 app）。整包并行约十次一现，串行不复现。
 *
 * 先 listen 一次，supertest 看到 `address()` 非空就直接复用，不再开关端口。
 * 端口由内核分配（0），`app.close()` 照旧在 afterAll 里收。
 */
export async function listenForSupertest<T extends INestApplication>(app: T): Promise<T> {
  await app.listen(0)
  return app
}
