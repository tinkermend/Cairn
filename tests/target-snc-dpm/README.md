# SNC DPM 目标系统登记

把智慧运维管理平台接到识途「目标系统」目录，供后续 L3 只读验收复用。

它不是 workspace 包。入口 URL、账号、口令不进仓库：本机写在 `docs/targets/`（已 gitignore）或本目录的 `catalog.local.json`。口令经 SecretProvider 入库。

## 登记稿

[`catalog.json`](catalog.json) 只含编码、名称和登录框定位。入口与凭据从环境变量或 `catalog.local.json` 读取：

```json
{
  "entryUrl": "https://example.invalid/app",
  "loginUrl": "https://example.invalid/login",
  "account": {
    "username": "your-user",
    "password": "your-password"
  }
}
```

```bash
# 控制台已启动，且已准备 catalog.local.json 或 CAIRN_L3_DPM_* 环境变量
CAIRN_API_BASE=http://127.0.0.1:3030 \
CAIRN_BOOTSTRAP_ADMIN_EMAIL=admin \
CAIRN_BOOTSTRAP_ADMIN_PASSWORD=cairn-admin \
node tests/target-snc-dpm/register.mjs
```

脚本按编码 `snc-dpm` 幂等：已存在则只更新入口 / 登录 URL / 登录框定位，不覆盖口令。要改密，到控制台该账号上重设。

## L3

```bash
CAIRN_L3_DPM=1 pnpm --filter @cairn/worker test src/browser/engine.dpm.spec.ts
```

未设 `CAIRN_L3_DPM` 时该用例 skip，避免 CI 和日常 `pnpm test` 打外网。开启后必须同时提供 `CAIRN_L3_DPM_URL`、`CAIRN_L3_DPM_LOGIN_URL`、`CAIRN_L3_DPM_USERNAME`、`CAIRN_L3_DPM_PASSWORD`（或本机 `catalog.local.json`），缺一项即失败，不准默认口令。
