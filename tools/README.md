# tools

仓库级脚本（CI 检查、代码生成）。与脚本步骤沙箱 `automation/scripts/` 分开。

| 脚本 | 命令 | 卡住什么 |
| --- | --- | --- |
| `check-migrations.mjs` | `pnpm check:migrations` | 迁移文件名规范、前缀唯一、序号连续 |
| `check-deps.mjs` | `pnpm check:deps` | 包边界与依赖方向：package.json 声明的仓内依赖，以及绕开声明的跨包相对路径 import；允许边表在脚本顶部，改边界必须改脚本 |

两个检查合并为 `pnpm check`，并挂在 `pnpm test` 前面；`.github/workflows/ci.yml` 在 push 与 PR 上按同一顺序执行（install → build → check → lint → typecheck → migrate → test）。

## 集成测试与数据库

`packages/db` 与 `packages/api` 的集成测试真连 PostgreSQL，且**不接受跳过**：两个包的 vitest `globalSetup` 调用 `@cairn/db` 的 `requireReachableDb()`（实现在 `packages/db/src/testing.ts`），库不可达或配置不完整时整个包失败。

判据是「库能不能连上」，不是「环境变量在不在」——后者在干净检出、CI 漏配或临时离线时会整包变绿而一条都没跑（实测 db 包 `3 passed | 4 skipped`、退出码 0）。新增集成测试自动受这条闸门保护，不需要自己写 `skipIf`。

集成测试跑在**真实库**上：`db` 的模型与 parity 测试各自建独立 schema（`cairn_test_*`）并在结束时删除；api 的集成测试写入开发 schema，用唯一前缀命名并在 `afterAll` 清理。
