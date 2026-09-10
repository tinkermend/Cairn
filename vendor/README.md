# 整仓二开快照

识途自己的包在 `packages/`。这里只放整仓拷入的上游，**不并进**根目录 `pnpm-workspace.yaml`，各自在本目录安装和构建。

单向分叉：当本仓源码改；偶尔从上游抄功能，不合分支、不回推。

| 目录 | 上游 | 快照 | commit |
| --- | --- | --- | --- |
| `midscene/` | https://github.com/web-infra-dev/midscene | `v1.12.6`（2026-09-10） | `1f1330b63f155501ed85f5c1277e680f08246d5e` |
| `page-agent/` | https://github.com/alibaba/page-agent | `v1.12.4`（2026-09-06） | `9eb6b6646500264d9034dd466a4270cb9fc1ef1e` |

扩展仍在 fork 里编：

- Midscene：`midscene/apps/chrome-extension`
- page-agent：`page-agent/packages/extension`

安装：

```text
cd vendor/midscene && pnpm i
cd vendor/page-agent && npm i
```
