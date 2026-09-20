---
name: shitu-stack-acceptance
description: 用本机进程探活标尺确认 api / worker / web 是否真的可访问。在宣称开发完成、交付、服务正常，或改动了可能让进程起不来的代码之后使用。
---

# 识途本机服务验收标尺

单测、接口测试、方案存在都不能证明用户正在用的前后端还活着。本 skill 只确认**本机进程与接线**。功能对不对仍按改动范围做定向验收；前端交互另走[前端验收](../../../.agents/skills/shitu-frontend-acceptance/SKILL.md)。

## 何时必须跑

改到 `packages/api`、`packages/worker`、`packages/web`、`packages/db`、`packages/shared`、环境变量、迁移，或准备说「开发完成 / 服务正常 / 可以验收」时，先跑探活。只写方案、只改文档、只做不启动进程的纯算法可以跳过，并写明未探活。

## 标尺

| 级 | 命令证明什么 | 通过 | 失败时禁止说 |
| --- | --- | --- | --- |
| S1 | 端口在听 | `pnpm check:stack` 的 `S1 listen` 为 pass | 服务已启动 |
| S2 | 控制面 `/health` 契约成立且数据库 up | `S2 health` 为 pass | 后端正常 |
| S3 | Web 吐出 HTML，且经 Web 代理打到 `/health` | `S3 wire` 为 pass | 前后端接通 |
| S4 | 本次改动的业务路径 | 定向测试或前端验收 | 功能已验收 |

`STACK_OK` 只覆盖 S1–S3。`STACK_DEGRADED` 表示进程可访问但控制面降级，通常是 changeHint；可以继续做 S4，不得写成全部正常。`STACK_DOWN` / `STACK_UNHEALTHY` 一律未完成。

Worker 的 S1 仍看内部端口是否在听。监听之后必须用节点健康 HMAC（`GET /internal/node/health`，签 `CAIRN_WORKER_ID`）确认 `node.loopAlive === true`。在听但 loop 已停、缺 `CAIRN_INTERNAL_AUTH_SECRET`、签不出或解析失败，一律 `STACK_UNHEALTHY`，禁止回退成只做 TCP。

## 怎么跑

1. 先看已有终端，复用已在跑的 `pnpm dev` / `pnpm start`，不要再开一套抢端口。
2. 没有进程时再启动：开发热重载用 `pnpm dev`（或 `dev:backend` / `dev:web`）；验证构建产物用 `pnpm start`。
3. 启动后执行 `pnpm check:stack`。只动后端用 `backend`，只动控制台用 `web`（仍会探 api）。`--strict` 把降级也判失败。
4. 失败先读对应终端或 `logs/*.log`，修到 RESULT 为 `STACK_OK` 或可解释的 `STACK_DEGRADED`。
5. 再做 S4。需要浏览器时先有 S3。

## 结束口径

- 通过：写明 `pnpm check:stack` 的 RESULT 与范围，以及 S4 实际做了什么。
- 未通过：写明失败级、命令输出、未验证项。不要改口说测试已经证明服务正常。
- 环境缺失：列出缺哪一级，不要用 mock、截图或旧终端状态顶替。
