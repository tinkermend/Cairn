# Worker 登记与执行节点治理落地

日期：2026-09-14。对应方案：[Worker 登记、内部入口与执行节点治理](../spec/2026-09-14-worker-registry-and-fleet.md)。先前评审见[修订对照](2026-09-14-worker-registry-review.md)。

按修订后的方案实施：Worker 只写数据库登记与心跳，API 读同一库并转发，Web 治理页「执行节点」查看生命周期与占用。不新增 D 阶段，不重开 B 线 Live View。

## 相对方案的进度

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| shared | 已落地 | 网络模式、广告 URL、回退规则、四值状态、投影、句柄采样、`WORKER_RESULT_UNKNOWN` |
| db | 已落地 | PG `0030` / MySQL·SQLite `0014`；冻结期限、实例条件写入、接管隔离 LOST、舰队聚合与分页；查表区分可转发关联；逻辑导入版本 `0030` |
| worker | 已落地 | 显式广告入口、先监听再登记、实例保护的 drain/stop/收尾、`reconcileOwn` 只隔离、观察/输入/逐帧复核归属；不引入控制面 HTTP 客户端 |
| api | 已落地 | 一份 `resolveWorkerRoute` 快照（含 `associationLive`）、禁跟随重定向、undici 连接 3s、SSE 不套整流超时、治理 `GET /api/workers`、入口权限投影 |
| web | 已落地 | `/workers` 列表与详情、四值生命周期、手动刷新、处置确认；侧栏与能力预览为「执行节点」 |

## WR 验收

| 编号 | 结果 | 证据 |
| --- | --- | --- |
| WR01 只写库 | 通过 | Worker `lifecycle.spec`：生产路径不向控制面发 HTTP；开放服务 `GET /open/v1/workers` 404；`check-deps` 通过 |
| WR02 去重与迟到停机 | 通过 | 三库 `worker-registry`：同 ID 双开、到期接管、迟到心跳/停机不能改新行；Worker 停机只交本实例 grant |
| WR03 横向 API | **跳过** | 未准备两个不同网络命名空间的 API，也未实际走跨机 HTTPS 访问同一 owner |
| WR04 查表转发 | 部分 / **未关** | 本机证明：库内入口优先、无效 URL 不 fetch、禁重定向。未证明两个 API 命名空间 + 可信 HTTPS + 证书错配 |
| WR05 严格回退 | 通过 | shared 回退矩阵 + 三库/路由评估：仅有效登记且库内入口为空才用旧映射 |
| WR06 地址校验 | 通过 | shared URL 矩阵与 `env.test`：无广告不自动拼 loopback、distributed 拒 loopback/缺 HTTPS、通配监听拒启、port=0 |
| WR07 计数与采样 | 通过 | 三库列表/详情：过期 ACTIVE 不算执行中；未上报 / 第一次差异 / 连续差异；遥测不改 Session 行 |
| WR08 权限 | 通过 | API HTTP：viewer 403；author 无 host/port/protocol/baseUrl；运维与自定义 `session:read+dispose` 可见入口 |
| WR09 安全与关流 | 部分通过 | 错误/日志脱敏、POST 超时 → `WORKER_RESULT_UNKNOWN`、不自动重试、SSE 头建立后不套整流超时。连接 3s 已由 API 转发的 undici `connectTimeout` 实现；**未做真实 TLS 握手/证书错配计时** |
| WR10 期限一致性 | 通过 | 三库：旧行 120s、心跳年龄 90s，申请者/扫描者 60s 不能提前接管或判 LOST；相等即过期；迟到心跳不复活 |
| WR11 Session 代次 | 通过 | 存量 null 不反填；接管把旧/未知未关闭会话隔离为 LOST；session-manager 集成按实例创建/隔离/腾位 |
| WR12 状态与有界读取 | 通过 | 四值 Schema、STOPPED 独立展示、分页与详情计数不随 Session 页变化；旧 `/browser-sessions` 信封保留，可按 `ownerWorkerId` 过滤 |
| WR13 升级 | **跳过** | 未用实际旧/新二进制对三库做升级矩阵。迁移脚本与启动门禁契约已具备；本机开发库在实施当日补到 `0030`，不能代替旧版本滚动证明 |

跳过不等于通过。缺少第二台物理机或隔离容器网络时，同机两个端口不能关闭 WR03/WR04 的分布式验收。

## 对照复查（2026-09-14 二次）

对照方案后修过这些走偏/遗漏，不是新开范围：

1. `resolveWorkerRoute` 曾把已过期 ACTIVE 租约或过期 auth hold 当成可转发关联；现返回 `associationLive`，过期行仍可供元数据降级。
2. 观察/认证/逐帧只校验 hold 实例，未知或失配的 `ownerWorkerInstanceId` 仍能看画面；现要求本实例归属，并在串行输入前重读登记。
3. 转发没有独立连接 3s；SSE 还把 10s 头超时套在 `fetch` 的 AbortSignal 上，会在头到达后掐流。现用 undici `connectTimeout=3000`，SSE 只保留调用方信号与 `bodyTimeout=0`。
4. 启动/自愈先登记再监听，API 可能打到尚未 listen 的入口；现先绑定内部 HTTP 再写库，自愈后补 `reconcileOwn`。
5. 逻辑导入 `LOGICAL_VERSION` 仍停在 `0029`，与 `0030` 新列不同步。
6. `deploy/README.md` 未写控制面入口与 Worker TLS 代理两条链路。
7. 执行者能力预览测试仍写「治理：无」，与 `menu.workers` / `session:read` 不符。

未改、也不当作通过：WR03 双命名空间 HTTPS、WR04 证书错配、WR13 旧/新二进制矩阵、详情页 Session 状态筛选（方案 8.1 是 API 能力，§9 未要求 UI）。

## 验证范围

本机库已在 `0030`，无新迁移。重建 `@cairn/shared` / `@cairn/db` / `@cairn/api` 后重启 API 与 `local-worker`。Worker 官方 `tsc -p tsconfig.build.json` 仍因既有 `observe.ts` / `engine.ts` 失败；本次用 `--noEmitOnError false` 写出含新生命周期的 dist。

整包/定向：

- shared 整包：31 文件 / 325
- db 整包（三库）：30 文件 / 511
- api 整包：42 文件 / 227
- web：workers + 侧栏 + 角色能力预览 5 文件 / 18；`permission-matrix` 找「浏览器 AI」失败，与本线无关，未改
- worker：lifecycle / session-manager 集成 / 认证 fencing / 画面订阅 / 边界与 runtime 等 21 文件 / 90；未跑 lab / HMI / DPM / Midscene
- `check-deps`、`check-migrations` 通过
- 本机：`GET /api/workers` 未认证 401；`GET /open/v1/workers` 404；`/workers` 列表 10 节点、`/workers/local-worker` 空占用

前端验收为**页面级**（当前 Vite + 重启后的 API）：治理侧栏「执行节点」，详情独立，不嵌 BrowserView。没有 1366/1440/1920 全套人工截图。`pnpm check:design` 仍因既有 `features/runs/browser-view.tsx` 硬编码蓝色失败，与本页无关。

未宣称通过：

- WR03 / WR04 的跨命名空间 HTTPS、证书错配、TLS 终止代理实测
- WR09 的真实 TLS 握手 3s 计时
- WR13 旧进程 + 新库、新进程 + 旧库的真实二进制矩阵
- 完整 Worker 官方 tsc、全仓并行测试、Worker lab 套件

## 已知限制

- 登记与心跳的比较时钟是取得行锁之后的数据库时间；同代次重复登记不刷新 `lostAfterSeconds`，也不再撤租。
- `markLostWorkers` 只看各行 `heartbeatExpiresAt`。即使没有任何 Worker 扫描，API 也按期限拒绝转发；过期租约/hold 不再当作可转发关联。
- 新实例不继承旧浏览器句柄；未知归属 Session 保持隔离和账号键，也不能观察或输入。
- 转发 `fetch` 禁止重定向。连接超时依赖 undici Agent，不是 Node 默认 `fetch` 的总预算。
- 治理接口只挂控制面 GET，不进开放服务 API。
