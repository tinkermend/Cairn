# 动作模块前置验证靶场

给[动作模块开发总方案](../../docs/spec/2026-09-16-action-module-implementation.md)做**方案前置验证**：候选模块在现有 Step 能力与 Engine 上能否表达、能否执行、在哪些情况下失败。本目录不实现动作模块能力，也不是正式 Runtime。

结构参照 2026-09-16 对 [SNC DPM](../../docs/targets/snc-dpm.md) 的只读观察，仿真以下特征：

- 登录框的 class 与 DPM 相同（`input.input-account`、`button.el-button--primary[type=submit]`），并且页面上还有第二个 primary 按钮；
- 实例列表“设备名称”查询为**大小写不敏感的模糊匹配**，“Mysql_主”会命中 3 行；
- 实例详情与列表**同一 URL**，只有面包屑末级与页签变化；
- 查询期间旧的“共 N 条”保留到结果返回，无结果时显示“暂无数据”；
- 告警分析表格（首条资源）。靶场另外加了**仅靶场存在**的“处 置”写操作，用于副作用验证。

这不是真实企业系统。靶场通过不能写成“已兼容 DPM”；DPM 上只做只读验证（见下文）。

## 启动

```bash
cd tests/target-module-lab
node server.mjs            # http://127.0.0.1:4179/front/login，账号 labuser / labpass
LAB_PORT=4190 node server.mjs
```

测试中通过 `createModuleLab()` 在随机端口上启动。

## 控制接口（仅测试）

| 路径 | 作用 |
| --- | --- |
| POST `/lab/reset` | 恢复初始数据、清空会话与日志 |
| POST `/lab/config` | `{"ui":"v2"}` 把“搜 索”改名为“查 询”；`{"searchDelayMs":1500}` 查询延迟；`{"searchFail":true}` 查询接口返回 500；`{"expireSessions":true}` 让现有会话全部失效 |
| GET `/lab/state` | 当前配置、会话数、查询日志、处置日志 |

## 候选模块夹具

[`modules/candidates.json`](modules/candidates.json) 按 AM-A 草案书写契约，步骤只使用当前 `stepSchema` 已有的能力。`notExpressible` 记录当前无法表达的候选及原因。

## 可复跑检查

两个脚本使用与 `packages/worker/src/browser/runtime.ts` 相同的定位语义（role 带 name 为精确匹配、text 精确、row 锚点为 `filter({hasText})` 子串），用于核对候选模块的定位、时序与副作用假设。它们不启动识途平台，也不写目标系统。

```bash
node tests/target-module-lab/check-lab-semantics.mjs      # 靶场：定位歧义、结果时序、界面变体、副作用、会话失效

# DPM 只读核对：入口与凭据来自环境变量或 tests/target-snc-dpm/catalog.local.json，仓库内不存口令
CAIRN_L3_DPM_LOGIN_URL=... CAIRN_L3_DPM_USERNAME=... CAIRN_L3_DPM_PASSWORD=... \
  node tests/target-module-lab/check-dpm-readonly.mjs
```

结果与结论见[动作模块前置验证报告](../../docs/reviews/2026-09-16-action-module-preflight-validation.md)。Run / StepRun / Evidence 层的端到端验证尚未完成（报告第 3 节）。
