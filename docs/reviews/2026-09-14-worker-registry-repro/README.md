# Worker Registry 评审探针

对应[评审报告](../2026-09-14-worker-registry-review.md)。日期：2026-09-14。

保存的是实际执行的现状探针，使用 `.txt` 后缀避免混入正式测试套件。断言刻意验证已观察到的缺口；修复后部分用例理应失败，不能把它们当作修复回归标准。

文件：[探针源码](probe.test.ts.txt)、[执行配置](vitest.config.mts.txt)。配置中的仓库绝对路径对应本次环境；换目录时同步调整 root 和 alias。

从仓库根复跑：

```sh
mkdir -p .run/worker-registry-review
cp docs/reviews/2026-09-14-worker-registry-repro/probe.test.ts.txt .run/worker-registry-review/probe.test.ts
cp docs/reviews/2026-09-14-worker-registry-repro/vitest.config.mts.txt .run/worker-registry-review/vitest.config.mts
pnpm --filter @cairn/db exec vitest run --config "$PWD/.run/worker-registry-review/vitest.config.mts"
```

本次使用 Node 24.17.0、Vitest 4.1.11，5 个探针全部完成，总耗时 827ms。SQLite 通过现有 `openContractDb('sqlite')` 隔离创建并清理；未使用开发业务库。
