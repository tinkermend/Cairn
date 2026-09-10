# 对象存储内核：put / get / delete、本地与 S3、保留清理

日期：2026-09-10。状态：**已落地**。  
对应路线图 P6 的**存储内核**，不覆盖 RF14 / RF15 的截图与 Trace。  
前置：[最小执行契约](2026-09-10-runtime-contracts.md)（已落地）、[执行内核](2026-09-10-execution-kernel.md)（账本与 `evidences` 指针列已在仓内）。

范围：能把一串字节按平台键写进去、读回来、删掉；默认走本地目录；再做一个 S3 兼容适配；按保留期清理。  
不是截图、不是 Playwright Trace、不是浏览器、不是授权下载页。

## 1. 为什么现在写

执行内核已经能跑 Echo → Delay → Fail。结构化主证据（`input` / `output` / `error`）走 `evidences.payload`。大对象指针的列早就冻在契约和表上：`object_key` / `content_type` / `byte_size` / `digest` / `missing_reason`。

缺的是**真正能写字节的那一层**。没有它，后面截图、Trace、失败复盘只能把 PNG 和 zip 塞进 JSONB，或者各写各的临时目录——两者都踩宪法：大对象进对象存储，索引和指针留在 PostgreSQL，对象存储不得当队列、锁或事务源。

路线图把「ObjectStore + 截图 + Trace + 授权下载 + evidenceStatus」捆成一个 P6。截图和 Trace 依赖浏览器（P4）。存储内核不依赖。先把内核落地，证据索引只要能存指针就算接通；采集端以后只调用同一条 `put → 写指针` 的路。

本方案从 P6 拆出这一截。不宣称 RF14 / RF15 通过。

## 2. 目标与非目标

### 目标

1. 冻结 `ObjectStore`：只有 `put` / `get` / `delete`。同一套契约测本地与 S3 适配。
2. 默认驱动是本地目录。开发与 CI **不要求** MinIO。多进程、多机要共享字节时必须换 S3 兼容端点。
3. 做一个 S3 兼容适配（MinIO / OSS / 标准 S3 共用），不按厂商再拆实现。
4. 每个对象在 PostgreSQL 有一行生命周期账本：`PENDING → AVAILABLE → PURGED`。没有跨系统事务；靠预定键、摘要校验和清理收口。
5. 证据索引能挂对象指针：`evidences.object_key` 指向一条 `AVAILABLE` 对象。`GET /runs/:runId/evidence` 已有，本期不改形状。
6. 可配置保留期与未完成上传宽限期；Worker 定期清理。过期对象删除后，已挂指针的证据行必须带 `missingReason`，不得假装还能下载。
7. Echo / Delay / Fail 与 Engine **不改行为**。本期没有生产路径写入 `screenshot` / `trace` 行。

### 非目标

- 不采集截图，不启动 Playwright Trace，不打开浏览器，不碰 Browser Session。
- 不新增 HTTP 上传 / 下载 / 预签名 URL。控制面不接受任意字节。读指针继续走现有证据列表。
- `ObjectStore` 对外不暴露 `list` / `head` / `copy` / 分片 / 流式 API。本期对象有体积上限，整包进内存。适配器**内部**为实现 D3 的幂等判定可以读一次已有对象（Local 读文件、S3 `HeadObject`），那是实现细节，不是对外能力。
- 不把对象存储当队列、锁或 Run 状态源。清理名单只来自 PostgreSQL。
- 不引入 `evidenceStatus` 与 `executionOutcome` 分列（那是截图失败但步骤已成功的语义，跟采集一起做）。
- 不按证据类型做差异保留（Debug 长留、成功 Trace 丢弃）。本期只有默认保留期；`retain_until` 列先留下，以后覆盖。
- 不加密对象正文（桶级加密是基础设施）。不遮罩截图。
- 不改 Web，不建 Evidence Viewer。
- 不把 MinIO 写进默认开发启动依赖。
- 不在 `@cairn/shared` 引入 `node:fs` 或 AWS SDK。

## 3. 决策

### D1. 新库包 `@cairn/storage`，协议在 Worker 里拼

字节适配器不是 Postgres，也不该进 `shared`（Web 依赖 `shared`）。API 与 Worker 以后都要碰这层；本期只有 Worker 写和清。

```text
@cairn/shared     键规则、env 片段、错误码、缺失原因常量
@cairn/storage    ObjectStore + Local + S3，零仓内包依赖除 shared
@cairn/db         stored_objects 账本；不依赖 storage，不引入 S3 SDK
@cairn/worker     预定 → put → 提交 → 挂指针；清理 tick
@cairn/api        本期不依赖 storage（没有下载出口）
```

`tools/check-deps.mjs` 允许边：

| 包 | 允许 |
| --- | --- |
| `@cairn/storage` | `@cairn/shared` |
| `@cairn/worker` | `@cairn/db`、`@cairn/shared`、`@cairn/storage` |
| `@cairn/db` | 仍只有 `@cairn/shared` |

禁止在 `api` / `worker` 各写一份适配器。Engine 源码与其测试继续不得出现 `playwright` / `midscene` / `page-agent`；**也不**直接 import `@cairn/storage`——执行调度与存字节分开，采集以后从 Executor 外侧调用，不从 Engine 内核调用。

地基方案「不新建空包」仍然成立：这个包有两个适配器和契约测试，不是空壳。

### D2. 适配器只认字节，账本只认指针

```text
ObjectStore          按 key 写 / 读 / 删字节
stored_objects       这条 key 是否 PENDING / AVAILABLE / PURGED，何时过期
evidences.object_key 产品索引：这次 Attempt 的证据指向哪条对象
```

清理、重试、保留期只查账本，再调用 `delete`。禁止 `ListObjects` 当真相。适配器契约测试可以不经账本直接 `put`；生产路径必须走 D3。

对象必须属于一次 Run：`stored_objects.run_id` → `runs` `RESTRICT`。没有 Run 就不能预定。步骤与 Attempt 的归属写在证据行上，不在账本上重复。

`contentType` 不进适配器。本地对象就是一个裸文件，没有地方放它，而 D7 又禁止嗅探——只要 `ObjectHead` 里要求 `contentType`，「同一套契约测本地与 S3」就必然在这一项上裂开。所以 `ObjectHead` 只有 `key` / `byteSize` / `digest`；`content_type` 由账本持有，托管 `getObject` 从账本读出后拼回给调用方。`put` 仍接受 `contentType` 并交给 S3 落成对象元数据（Local 直接丢弃），是为了以后接预签名下载时对象本身就是合法的；但**读回来的 `contentType` 一律以账本为准**，不采信存储端返回值。

### D3. 预定键，再写字节，再提交

DB 与对象存储没有分布式事务。上传顺序固定：

```text
1. 插入 stored_objects  PENDING，object_key 一次算死
2. store.put(key, body)
3. 校验 byteSize / digest
4. 行改为 AVAILABLE（条件：仍是 PENDING）
5. 可选：写 evidences.object_key（对象必须已是 AVAILABLE）
```

键由平台分配，调用方不得自带路径：

```text
v1/runs/{runId}/{objectId}
```

`objectId` 就是账本主键。重试同一条 PENDING 用同一把键。

`put` 幂等：

| 已有对象 | 行为 |
| --- | --- |
| 无 | 写入，返回 head |
| 同 digest | 当作成功，返回已有 head |
| 不同 digest | 失败 `OBJECT_KEY_CONFLICT`，不得覆盖 |

判定「已有对象」要真读一次：Local 读文件复算，S3 发 `HeadObject`（对外不暴露 head，见 §2 非目标）。`PutObject` 本身是覆盖语义，不 Head 就实现不了「不得覆盖」；`If-None-Match: *` 条件写 AWS 支持而 MinIO / OSS 参差，不押在上面。

代价写明白：每次 `put` 都多付一次读取，换来的保护只在实现出错时才触发——键是 `v1/runs/{runId}/{objectId}` 由平台分配，同键只可能来自「同一 `objectId` 重试时换了字节」。规则保留，因为那恰恰是最该被拦住的一类 bug。

`delete` 对不存在的键成功（幂等）。`get` 找不到则失败 `OBJECT_NOT_FOUND`，不返回空 body 冒充命中。

提交失败停在 PENDING：对象可能已在盘上。清理或重试同一 `objectId` 收口。过期的 PENDING 不得被提交成 AVAILABLE——`commit` 必须看见行仍是 PENDING，且可选校验「未超过 pending TTL」。

本期没有客户端上传 token。路线图里「过期 token 不得把旧产物关联成当前结果」落成：不得把别人的 `objectId` 提交到另一条证据；`attach` 只接受 `AVAILABLE` 且 `run_id` 一致的键。

`attach` 的状态检查与证据插入必须在**同一事务**里，并对账本行 `SELECT ... FOR UPDATE`。否则它会与 D5 的清理交错：attach 读到 `AVAILABLE` → 清理改 `PURGED` 并扫证据（此刻证据行还没插进去，扫不到）→ attach 插入，最终得到一条 `objectKey` 指向 PURGED 对象、却没有 `missingReason` 的证据行，而字节早已删除。那正是目标 6 明令禁止的「假装还能下载」。

### D4. 默认本地；S3 是同一接口的第二个实现

| `CAIRN_OBJECT_STORE` | 行为 |
| --- | --- |
| `local`（默认） | 根目录 `CAIRN_OBJECT_STORE_DIR`，默认 `.data/object-store`，相对值按仓根解析（已在 `.gitignore` 的 `.data/` 下） |
| `s3` | `@aws-sdk/client-s3`：`PutObject` / `GetObject` / `DeleteObject` |

本地写入：先写同目录临时文件，再 `rename`，避免 `get` 读到半份。键必须通过 D7 的字符规则；解析后的绝对路径必须仍落在根目录内，否则 `OBJECT_KEY_INVALID`（根目录本身先 `realpath` 再比对，避免根是软链时两侧口径不一致）。

根目录必须先解析成绝对路径再用。`.data/object-store` 是相对 CWD 的：从仓根启动 worker 和从 `packages/worker` 启动 worker 会写到两个地方，两份都合法、都不报错，症状是「刚存进去的对象读不到」。相对值一律按仓根解析；非 development 环境要求配置绝对路径，否则拒绝启动。契约测试用临时目录，不碰默认值。

S3 适配只此一份。`CAIRN_S3_ENDPOINT` + `CAIRN_S3_FORCE_PATH_STYLE` 服务 MinIO / OSS；不配 endpoint 则走 AWS 默认。Region 给 SDK 必填，默认 `us-east-1`。不引入 MinIO 专用 SDK。

S3 错误必须映射成存储域错误码，不得让 SDK 原生异常穿透给调用方：

| SDK 侧 | 映射 |
| --- | --- |
| `NoSuchKey` / `NotFound` / HTTP 404 | `OBJECT_NOT_FOUND` |
| 超时、连接失败、403、5xx、其余一切 | `OBJECT_STORE_UNAVAILABLE` |

这张表要进 mock 单测。只钉命令形状的话，测试全绿，而真连 MinIO 时 `get` 一个不存在的键会直接抛出 SDK 异常，一路穿到 Engine。

单测：契约套件永远打 Local；S3 适配用 mock 客户端钉命令形状。仓内默认 CI **不**起 MinIO。若环境里配齐了 `CAIRN_S3_*`，可另开集成测试，缺则跳过，不得把整包标 skip。

非 development 允许 `local`（单机私有化）。多 API / 多 Worker 要读同一份字节时，必须 `s3` 或所有进程能写到的共享盘——后者不作为正式模式，文档写明，schema 不假装能检测「是不是多机」。

### D5. 保留期在账本上，清理在 Worker 上

预定时写入 `retain_until = now + CAIRN_OBJECT_RETAIN_DAYS`（默认 30 天）。调用方可传入更短或更长的 `retainUntil`，供以后 Debug / 失败 Trace 覆盖；本期生产路径只用默认。

另：`CAIRN_OBJECT_PENDING_TTL_SECONDS`（默认 3600）。超过仍为 PENDING 的行按未完成上传处理。

清理只在 Worker。控制面不跑后台任务。**独立定时器**，不得复用领取 Run 的 `busy` 锁——否则一条 Delay 或以后的浏览器 Run 会饿死清理。

停机要一并收口。`onApplicationShutdown` 现在只 `clearInterval` 领取 tick 并 `await inFlight`（`packages/worker/src/runtime/lifecycle.service.ts`）；清理定时器必须同样 clear，并 await 在途的那一轮 purge。否则要么进程关不掉，要么一轮清理被砍在「字节已删、账本未改」——虽然下次能补回来，但在测试里表现为随机残留。

一批最多 100 行。步骤：

1. `listPurgeCandidates`：**读**出到期的 `AVAILABLE`（`retain_until < now`）或过期的 `PENDING`（`created_at < now - pending TTL`）。这一步不占状态、不引入 `PURGING` 中间态，并发靠第 3 步的条件更新收口。
2. `store.delete(key)`（幂等）。
3. **一个事务**里做两件事：账本行条件更新为 `PURGED`（`WHERE status` 仍是取出时的值）并写 `purged_at` / `purge_reason`；同时给挂着该 `object_key` 且尚无 `missing_reason` 的证据行补上 `missing_reason`。两者不得拆成两个事务——中间崩溃会留下「对象已 PURGED、证据仍宣称可下载」的行。

先删字节再改账本：标记失败则下次再删一次（幂等）。反过来（先标 PURGED 再删字节）会在崩溃时留下永久孤儿字节，而这些字节以后是截图，必须能真正删掉。不删 `evidences` 行，不改 Run / StepRun / Attempt 状态。过期不是执行失败。

两个 Worker 同时清同一行：两边都会删一次字节（幂等），第 3 步条件更新 0 行的那个跳过。对象存储不当锁。

一个删不掉的键不得饿死整条保留期。账本加 `purge_attempts` 与 `last_purge_error_at`：`store.delete` 抛错就自增并记时间；`listPurgeCandidates` 按 `purge_attempts ASC, retain_until ASC` 取，失败多次的自然沉到批次末尾。否则一个因桶策略永远删不掉的键会占满每一批 100 行，后面到期的对象再也轮不到。`purge_attempts` 越过阈值只记日志告警，不改 Run，也不放弃重试。

时钟可注入，测试把 `retain_until` / `created_at` 写成过去，不要真睡 30 天。

### D6. 证据索引只挂指针，Engine 不动

已有 `GET /runs/:runId/evidence` 返回 `evidenceMetadataSchema`。本期不改 HTTP 形状，不新增路由。

`@cairn/db` 增加：

| 函数 | 作用 |
| --- | --- |
| `reserveStoredObject` | 插 PENDING，返回 `{ id, objectKey }` |
| `commitStoredObject` | PENDING → AVAILABLE，写入 size / digest / contentType |
| `listPurgeCandidates` | 到期 AVAILABLE + 过期 PENDING，按 `purge_attempts ASC, retain_until ASC` |
| `markStoredObjectPurged` | 一个事务：账本 → PURGED，并补证据 `missing_reason` |
| `markStoredObjectPurgeFailed` | `purge_attempts + 1`、`last_purge_error_at = now` |
| `recordObjectEvidence` | 一个事务：`SELECT ... FOR UPDATE` 校验 AVAILABLE 与 `run_id`，再插证据并拷贝指针 |

`recordObjectEvidence` 接受任意已有 `EvidenceType`。本期测试用 `log` + 一小段字节证明通路。生产代码不得插 `screenshot` / `trace`。

挂指针时：对象必须是 `AVAILABLE`，且 `run_id` 与证据 `run_id` 相同。禁止把 Run A 的对象挂到 Run B。

失败路径不得留下半挂的指针：reserve 成功但 `put` 或 `commit` 失败时，证据行的 `object_key` 必须为 **null**，只写 `missing_reason`。FK 本身拦不住这种写法（PENDING 行是存在的），但那会绕过上面的 AVAILABLE 规则，产品上也就多出一个指向永远读不到的对象的键。

由此，`OBJECT_MISSING_REASONS.uploadIncomplete` 在本期是**不可达**的：只有 `AVAILABLE` 才能挂指针，PENDING 行不可能被任何证据引用，D5 第 3 步里那个补写分支永远不会执行。常量先留着——采集期会出现「先挂指针、后补字节」的形态——但不要为它造一个测不出来的分支，验收里也不要求它。本期会被写进证据的缺失原因只有 `object_purged` 与 `object_store_unavailable`。

`evidences.object_key` 对外键到 `stored_objects.object_key`（可空，`ON DELETE RESTRICT`）。PURGED 行保留，外键仍在；`get` 对 PURGED 不得当成功。载荷型证据（`payload`、无对象）`object_key` 仍为 null。

### D7. 键、摘要、体积由 schema 卡住

`objectKeySchema`（`@cairn/shared`，证据字段与存储共用）：

- 长度 1–512
- 首字符字母或数字；其余只允许 `[A-Za-z0-9/._-]`
- 禁止 `..`、禁止以 `/` 开头
- 禁止空段：不得出现连续 `/`，不得以 `/` 结尾

最后一条是硬规则，不是补充说明。只有前三条时 `v1//x` 与 `a/b/` 都合法，验收 3 的「空段」根本过不了，本地路径解析也会多出一种奇怪形态。

平台分配的键另由纯函数 `objectKeyFor(runId, objectId)` 生成，单测钉死格式。现有证据单测里的示例键 `cairn-evidence/run/attempt/shot.png` 仍合法，避免为演示串再改一次契约。

这套规则会**收紧**已经冻结的 `evidenceMetadataSchema.objectKey`（现在只是 `z.string().min(1).max(512)`）。这是有意的窄化：本期还没有任何生产写入方，库里不存在历史键，代价为零。但要记住 `listRunEvidence`（`packages/db/src/runs/runs.ts`）对每一行都 `parse`——将来若有不合规的键混进库，整个 `GET /runs/:runId/evidence` 会 500，而不是跳过那一行。所以键只能由 `objectKeyFor` 生成，永远不接受调用方自带。

摘要：对正文做 SHA-256，存 `sha256:` + 64 位小写 hex（71 字符，列上限 128）。`put` / `commit` 以存储层算出的值为准，不信任调用方自报摘要去落账。`get` 读出后复算，与账本不一致则 `OBJECT_DIGEST_MISMATCH`，不得把坏字节当成功。

体积：`CAIRN_OBJECT_MAX_BYTES`，默认 33554432（32 MiB）。超限在写盘 / 上传之前拒绝，`OBJECT_TOO_LARGE`。Trace 以后若要更大，另改配置，不在本期抬默认。

`contentType` 必填，1–128，不嗅探。本期无允许清单。它由调用方声明、写进账本 `content_type`，**不进 `ObjectHead`**（见 D2）：读回来时以账本为准，不采信存储端返回值。以后接授权下载时这个值会直接决定响应头，届时需要配允许清单并强制 `Content-Disposition: attachment`；本期没有出口，先不做。

### D8. 配置跟 Worker 走，密钥不进日志

`objectStoreEnvShape` 放进 `workerEnvSchema`。`apiEnvSchema` 本期不加——没有读取方。以后授权下载再把同一片段并进 api，与 SecretProvider 从 api 再抽库包是同一节奏。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CAIRN_OBJECT_STORE` | `local` | `local` \| `s3` |
| `CAIRN_OBJECT_STORE_DIR` | `.data/object-store` | 仅 local；相对值按仓根解析，非 development 须绝对路径 |
| `CAIRN_OBJECT_MAX_BYTES` | `33554432` | 单对象上限 |
| `CAIRN_OBJECT_RETAIN_DAYS` | `30` | 默认保留 |
| `CAIRN_OBJECT_PENDING_TTL_SECONDS` | `3600` | 未完成上传 |
| `CAIRN_OBJECT_CLEANUP_INTERVAL_MS` | `60000` | 清理节拍 |
| `CAIRN_S3_ENDPOINT` | 无 | `s3` 时可选 |
| `CAIRN_S3_REGION` | `us-east-1` | SDK 需要 |
| `CAIRN_S3_BUCKET` | 无 | `s3` 时必填 |
| `CAIRN_S3_ACCESS_KEY` / `CAIRN_S3_SECRET_KEY` | 无 | `s3` 时必填，无开发默认值 |
| `CAIRN_S3_FORCE_PATH_STYLE` | endpoint 有则 `true`，否则 `false` | MinIO / OSS |

`driver = local` 时忽略 S3 变量。`driver = s3` 时缺桶或密钥，进程拒绝启动。`formatEnvIssues` 已不回显变量值；日志只记 `objectKey` / `byteSize` / `digest` / `runId`，禁止打正文或密钥。

`.env.example`：S3 从「已预留但本轮不校验」挪到执行面分组，并补上 driver / dir / 保留期。

## 4. 形状

### ObjectStore

```ts
// 适配器只认字节：contentType 不在 head 里，由账本持有（D2）
type ObjectHead = {
  key: string          // objectKeySchema
  byteSize: number
  digest: string       // sha256:<hex>
}

interface ObjectStore {
  // contentType 交给 S3 落成对象元数据，Local 丢弃；读回时不采信
  put(input: { key: string; body: Uint8Array; contentType: string }): Promise<ObjectHead>
  get(key: string): Promise<{ head: ObjectHead; body: Uint8Array }>
  delete(key: string): Promise<void>
}
```

错误是存储域对象，不是 HTTP 信封：

```ts
OBJECT_STORE_ERROR_CODES = [
  'OBJECT_NOT_FOUND',
  'OBJECT_KEY_INVALID',
  'OBJECT_KEY_CONFLICT',
  'OBJECT_TOO_LARGE',
  'OBJECT_DIGEST_MISMATCH',
  'OBJECT_NOT_AVAILABLE',  // 对 PENDING / PURGED 做托管 get
  'OBJECT_STORE_UNAVAILABLE',
]
```

`missingReason` 仍是自由字符串（证据 schema 不改成枚举）。生产只写这些常量，避免五种拼写：

```ts
OBJECT_MISSING_REASONS = {
  storeUnavailable: 'object_store_unavailable',
  purged: 'object_purged',
  uploadIncomplete: 'upload_incomplete',
}
```

现有单测里的 `'object store unavailable'` 改为上面的 slug。

### 托管 API（Worker）

```ts
putObject({
  runId,
  body,
  contentType,
  retainUntil?,   // 默认 now + RETAIN_DAYS
}): { objectId, objectKey, contentType, byteSize, digest }

getObject(objectKey): { head, contentType, body }
// 账本必须 AVAILABLE；复算 digest 与账本比对；contentType 取自账本，不来自存储端

recordObjectEvidence({
  runId, stepRunId?, attemptId?,
  type,                 // 测试用 log
  objectKey,
})

purgeExpiredObjects({ limit: 100 }): { purged: number }
```

`putObject` 内部就是 D3 的 1–4。采集以后：`putObject` → `recordObjectEvidence`。

### `stored_objects`（`0007_object_store.sql`）

| 列 | 约束 |
| --- | --- |
| `id` | UUID PK，即 key 里的 `objectId` |
| `object_key` | `TEXT UNIQUE NOT NULL` |
| `run_id` | FK `runs` `RESTRICT` `NOT NULL` |
| `status` | `pending` \| `available` \| `purged` |
| `content_type` | 可空，提交时写入 |
| `byte_size` | 可空，`>= 0` |
| `digest` | 可空 |
| `retain_until` | `TIMESTAMPTZ NOT NULL` |
| `created_at` | `NOT NULL DEFAULT now()` |
| `available_at` | 可空 |
| `purged_at` | 可空 |
| `purge_reason` | 可空：`expired` / `upload_incomplete` |
| `purge_attempts` | `INTEGER NOT NULL DEFAULT 0` |
| `last_purge_error_at` | 可空 |

索引：`(status, purge_attempts, retain_until)`、`(status, created_at)`、`run_id`。  
CHECK：`status` 属于词表；`purge_reason` 为 null 或属于词表——两列同为词表，不该只卡一个。  
`evidences.object_key` 增加可空 FK → `stored_objects.object_key` `RESTRICT`。

不建第二套证据类型，不改 `EVIDENCE_TYPES`。

## 5. 文件

| 区域 | 动作 |
| --- | --- |
| `packages/shared/src/object-store.ts`、`env.ts`、`evidence.ts`、`index.ts` | 键 schema、`objectKeyFor`、错误码、缺失原因、`objectStoreEnvShape` 并入 `workerEnvSchema`；收紧 `objectKey` 字符集 |
| `packages/storage/` | 新包：`ObjectStore`、`LocalObjectStore`、`S3ObjectStore`、`createObjectStore`、契约测试 |
| `packages/db/migrations/0007_object_store.sql`、`schema/objects.ts`、`src/objects/` | 表、Repository |
| `packages/db/src/__tests__/schema-parity.test.ts` | 表清单、列断言、`0007` 的 `skipped` |
| `packages/worker/src/objects/`、`runtime/lifecycle.service.ts` | 托管 API、独立清理定时器及其停机收口 |
| `tools/check-deps.mjs` | 允许边 |
| `.env.example` | driver / 目录 / 保留期 / S3 挪到执行面 |

对照现有 `packages/db` 建包：`package.json` exports 只暴露 `"."`，`turbo` 靠 workspace 自动收。S3 依赖只出现在 `@cairn/storage`。

## 6. 实施顺序

1. **shared**：键规则、`objectKeyFor`、错误码、缺失原因、env 片段；正反例（非法键、`..`、digest 形状、s3 缺密钥启动失败、local 忽略 S3 变量）。
2. **storage**：接口 + Local + 契约测试；再 S3 适配 + mock 单测。
3. **db**：`0007` + parity + 账本 Repository（不含字节）。
4. **worker**：`createObjectStore`、`putObject` / `getObject` / `recordObjectEvidence` 编排、清理 tick；协议集成测试。
5. **回写**：本方案改为已落地；`CHANGELOG` 追加一行。（执行内核 §12 与 `docs/spec/README.md` 已指向本方案，无需再改。）

## 7. 验收

1. 空库迁移与上一版本升级通过；parity 含 `stored_objects` 与 `evidences.object_key` 外键；重复迁移的 `skipped` 含 `0007_object_store.sql`。
2. Local：`put` → `get` 字节与 digest 一致；再 `put` 同键同正文成功；同键不同正文 `OBJECT_KEY_CONFLICT` 且旧正文不变；`delete` 后再 `get` 为 `OBJECT_NOT_FOUND`；对缺失键 `delete` 成功。同一套契约用例对 Local 与 S3 mock 各跑一遍且断言相同——`ObjectHead` 不含 `contentType`，两个适配器的 head 必须逐字段相等。
3. 键 `../escape`、绝对路径、空段（`v1//x`）、以 `/` 结尾，均 `OBJECT_KEY_INVALID`；本地根目录外没有新文件。
4. 超过 `CAIRN_OBJECT_MAX_BYTES` 的 `put` 失败，盘上 / mock 桶里没有该键。
5. `reserve → put → commit` 后账本 `AVAILABLE`；`recordObjectEvidence(type=log)` 后 `listRunEvidence` / `GET /runs/:id/evidence` 带 `objectKey` / `contentType` / `byteSize` / `digest`，无正文；`contentType` 与预定时声明的一致（来自账本，不是存储端）。
6. `commit` 之后、挂指针之前进程中断：对象仍 `AVAILABLE`，无证据行；清理只按 `retain_until`，不把「尚未挂指针」当成错误关联到别的 Run。
7. `put` 成功、`commit` 失败：行停在 `PENDING`；用同一 `objectId` 重试 `put` + `commit` 成功；换一份字节再提交失败。
8. `PENDING` 超过 TTL：清理删除字节（若有），行 `PURGED`，`purge_reason = upload_incomplete`；该键不能再 `commit`。
9. `AVAILABLE` 且 `retain_until` 已过：清理后 `getObject` 失败；证据行仍在，`missingReason = object_purged`，`objectKey` 仍在；Run 状态不变。
10. S3 适配 mock：发出的是 Put / Get / Delete（幂等判定另发 Head），键与 checksum 来自正文；`NoSuchKey` / 404 映射成 `OBJECT_NOT_FOUND`，超时与 5xx 映射成 `OBJECT_STORE_UNAVAILABLE`，无 SDK 原生异常穿透；未配 MinIO 时 `pnpm test` 仍绿。
11. `CAIRN_OBJECT_STORE=s3` 且缺 `CAIRN_S3_BUCKET` 或密钥时，Worker 启动失败，输出只有变量名与规则。
12. Engine 源码与其测试不 import `@cairn/storage`；`pnpm check:deps` 禁止 `storage → db|api|worker`、`db → storage`、`shared → storage`。
13. 页面与菜单无变化。Echo / Delay / Fail 的集成断言仍只认 `payload`，不出现 `screenshot` / `trace` 行。
14. `recordObjectEvidence` 与 `purgeExpiredObjects` 并发（`retain_until` 写成过去后同时发起）：最终不存在「`objectKey` 指向 PURGED 对象且 `missingReason` 为空」的证据行。两种结局都合法——挂上了指针并带 `object_purged`，或没挂上、attach 以 `OBJECT_NOT_AVAILABLE` 失败。
15. 停机：`onApplicationShutdown` 之后清理定时器已停、在途 purge 已收尾、进程可退出；Nest 测试上下文能正常关闭。
16. 一个 `delete` 永久失败的键不饿死保留期：连续跑若干轮清理，该行 `purge_attempts` 递增，同批次其他到期对象仍被清掉。
17. `put` 或 `commit` 失败后写的证据行：`object_key` 为 null、`missing_reason` 非空；库里不存在 `object_key` 指向 PENDING 行的证据。
18. `CAIRN_OBJECT_STORE_DIR` 用相对值时，从仓根与从 `packages/worker` 两处启动解析出同一个绝对路径；非 development 配相对值则启动失败。
19. `pnpm test` 与 `pnpm lint` 通过。

## 8. 刻意留给后续

| 阶段 | 本方案结束后仍缺的 |
| --- | --- |
| 截图采集 | 浏览器步骤出 PNG、脱敏 / 遮罩、`type=screenshot` 生产行、失败时 `missingReason` |
| Trace | 操作前开录、失败保留 / 成功丢弃、按 Run 分 chunk、不串 Session |
| 授权下载 | `GET` 或 POST 取字节、`run:read`、API 并入同一 env 片段并依赖 `@cairn/storage` |
| P6 其余 | `evidenceStatus` 与执行结果分列、必要证据失败不重放副作用、RF14 / RF15 |
| P7 | Run Observer 里展示指针与缺失原因 |
| 以后 | 流式 get、更大 Trace 上限、按类型保留策略、桶生命周期作辅助保险、预签名上传 |

P3 的 fencing 不挡本期清理：清理用条件更新，不写 Run 状态。以后若清理也要验 Worker 身份，再加，不改键格式。

## 9. 债务

1. 多 Worker + `local` 且目录不共享时，A 写下的对象 B `get` 不到。schema 检测不了拓扑，只能靠部署选 `s3`。
2. 先删字节再标 `PURGED`：标记失败会留下「盘上已无、账本仍 AVAILABLE」的短窗口，下次清理再删（幂等）再标。窗口内托管 `get` 会 `OBJECT_NOT_FOUND`，应记日志，不改 Run。
3. 不经 `reserve` 直接打适配器 `put` 的对象，账本看不见，清理不到。生产只走托管 API。
4. 审计 `.limit(200)` 静默截断仍在。本期无新审计 action（没有控制面写入口）。
5. 32 MiB 默认上限对完整 Trace 可能不够，采集方案里再调，不要在本核里预抬。
