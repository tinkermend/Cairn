# SNC DPM 目标系统登记

把 [智慧运维管理平台](../../docs/targets/snc-dpm.md) 接到识途「目标系统」目录，供后续 L3 只读验收复用。

它不是 workspace 包。口令走 SecretProvider；本目录只放登记稿和接入脚本。

## 登记稿

[`catalog.json`](catalog.json) 是 `POST /api/targets` 的请求体（含首个目标账号）。默认口令与文档一致，可用环境变量覆盖。

```bash
# 控制台已启动时
CAIRN_API_BASE=http://127.0.0.1:3030 \
CAIRN_BOOTSTRAP_ADMIN_EMAIL=admin \
CAIRN_BOOTSTRAP_ADMIN_PASSWORD=cairn-admin \
node tests/target-snc-dpm/register.mjs
```

脚本按编码 `snc-dpm` 幂等：已存在则只更新登录 URL / 登录框定位，不覆盖口令。要改密，到控制台该账号上重设。

## L3

```bash
CAIRN_L3_DPM=1 pnpm --filter @cairn/worker test src/browser/engine.dpm.spec.ts
```

未设 `CAIRN_L3_DPM` 时该用例 skip，避免 CI 和日常 `pnpm test` 打外网。
