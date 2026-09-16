# deploy

本机用 Podman 起 PostgreSQL 16 与 MinIO，给 `pnpm env:use local` 用。远端 shsnc-ah3 仍是 Docker + RustFS，见 `docs/deploy/2026-09-10-shsnc-ah3-infra.md`（未入库）。

凭据与远端一致，只有地址不同：库和 S3 都听 `127.0.0.1`，端口仍是 `5432` / `9021` / `9022`。

> 本机容器运行时是 podman 5.8.2，没有 docker。编排走 `podman compose`（底层是 Docker Compose 5）。

## 一次启动

```bash
# 若还没有 deploy/.env：从 example 复制，并填上与远端相同的库口令 / S3 密钥
cp deploy/.env.example deploy/.env

pnpm infra:up        # 等价于 podman compose -f deploy/compose.yml up -d
pnpm infra:status
pnpm env:use local   # 让仓库根 .env 指向本机画像
pnpm db:migrate      # schema cairn 仍由迁移创建，不在 compose 里预建
```

数据目录在仓库根 `.data/postgres` 与 `.data/minio`（已 gitignore）。`down` 默认保留数据。

## 端口与账号

| 服务 | 容器 | 本机地址 | 账号 |
| --- | --- | --- | --- |
| PostgreSQL | `cairn-postgres` | `127.0.0.1:5432` | 与远端相同的 `cairn` / 库名 `cairn` |
| MinIO S3 | `cairn-minio` | `http://127.0.0.1:9021` | 与远端相同的 Access Key / Secret Key |
| MinIO 控制台 | `cairn-minio` | `http://127.0.0.1:9022` | 同上（root 即管理员） |

桶 `cairn-evidence` 由 `cairn-minio-init` 在 MinIO healthy 后创建。S3 客户端必须 `forcePathStyle: true`。

## 常用命令

```bash
pnpm infra:up
pnpm infra:status
pnpm infra:logs
pnpm infra:down          # 停容器，保留 .data
```

需要清盘时再 `podman compose -f deploy/compose.yml down -v`，并手动删 `.data/postgres`、`.data/minio`。

数据库后端配置、PostgreSQL / MySQL 的受控迁移和运行观察提示通道见[数据库配置与受控迁移](database-backends.md)。PostgreSQL 默认用 LISTEN/NOTIFY；部署 MySQL 并要实时推送时，需另配 `CAIRN_REDIS_URL`，不要把 Redis 当成队列或锁。

## Worker 内部入口与控制面入口

两条链路分开，即使都用 Nginx 也不能混成注册服务：

```text
浏览器 ──► 控制面 Nginx / VIP ──► API
API ──HTTPS + HMAC──► 每 Worker 专用 TLS 入口 ──同机 loopback HTTP──► Worker
```

本机默认 `CAIRN_WORKER_NETWORK_MODE=local`，可不设 `CAIRN_WORKER_ADVERTISE_URL`，API 可用 `CAIRN_WORKER_ENDPOINTS` 回退到 `127.0.0.1`。跨机或跨容器网络必须 `distributed`：每个 Worker 设唯一 `CAIRN_WORKER_ID` 与非 loopback 的 `CAIRN_WORKER_ADVERTISE_URL=https://...`，Worker 进程仍只监听 `127.0.0.1:$CAIRN_WORKER_INTERNAL_PORT`。同机或同网络命名空间的 TLS 代理把该 HTTPS 转到 loopback；不要在 TLS 终止后再跨网络明文转发。

代理须保留内部签名头和原始请求体，关闭 SSE 缓冲，超时不短于连接 3s / 响应头 10s / 认证 POST 30s。不要把多个 Worker 随机负载均衡到同一个广告 origin，也不要关闭证书校验。HMAC 密钥继续走 `CAIRN_INTERNAL_AUTH_SECRET`，不要写进广告 URL。

排查：治理页「执行节点」看登记是否 READY、心跳是否新鲜、`routeAvailability`；库内入口无效或过期时 API 不会改去猜另一个地址。控制面入口只解决浏览器到 API，Worker 专用入口失败不要先改 CORS。

## 升级注意：会话占用协议 `session-occupancy@2`

含 `0032_session_occupancy`（MySQL 为 `0016_session_occupancy`）的版本把认证等待占用迁入 `session_leases` 用途租约，并要求 Worker 声明协议能力 `session-occupancy@2`。这是会话管理中唯一的破坏性迁移，**不能新旧二进制混跑**。

升级前：停止发放新 Run，等待 ACTIVE 执行租约与 `auth_hold_*` 占用排空（`WAITING_FOR_AUTH` 须完成、取消或超时），再部署新 API 与 Worker。未声明该能力的 Worker 不能进入 READY。LOST 和未确认停止的实例不会为升级自动放键。存量 Profile 目录首次加载按 `revision=1` 登记当前节点，不跨节点合并。回退时若已存在 `MAINTENANCE` / `AUTH_WAIT` 行或 `SESSION_OPERATION` 主体，拒绝启动旧二进制。

## 升级注意：动作模块调用与快照协议 `snapshot.moduleManifest@1`

含 `0044_scenario_action_module_refs`（MySQL 为 `0028_scenario_action_module_refs`）的版本给场景编写文档加上 V2 节点（可含动作模块调用）、`scenario_versions.authoring_document` / `module_manifest` 与 `scenario_module_refs` 引用索引。

上线顺序：迁移 → Worker → API → Web。Worker 先部署到声明 `snapshot.moduleManifest@1` 的版本；未声明的 Worker 不会领取快照带 `moduleManifest` 的 Run，不含模块调用的 Run 照常领取。

**一旦保存过含模块调用的 V2 草稿，就不能把 API 降级到不认识 V2 的版本**：旧 API 无法解析该草稿，也会拒绝写入。回退只回退二进制，不要删列——`authoring_document`、`module_manifest` 与 `scenario_module_refs` 对旧版本是多余字段，留着不影响运行。被场景版本引用的模块版本受外键 `restrict` 保护，不能物理删除。

## 升级注意：产品角色

含 `0018_product_roles`（MySQL 为 `0004_product_roles`）的版本会把系统角色收成「管理员 / 编写者 / 执行者 / 只读」。已有 `operator` 账号**不会**自动补挂编写者，升级后只能跑、不能改目标或场景，也看不见用户 / 角色 / 审计。这是预期降权，不是故障。若该用户仍要编写，由管理员在用户页补挂「编写者」。新建控制台账号默认是编写者。
