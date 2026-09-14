# 识途测试脚手架 (Cairn Test Harness)

为全链路功能开发与智能体自验证提供开箱即用的声明式执行环境。

## 核心特性
- **声明式构建**：只需数行代码即可拉起完整的 Target -> Account -> Scenario -> Run 执行闭环；
- **底层加速**：基于 PostgreSQL Template Database 机制，每次测试隔离库克隆仅需数十毫秒；
- **真实调度**：直连 Worker `ExecutionEngine`，验证版本冻结、租约抢占与证据落盘；
- **现场工件**：断言失败自动调用 `dumpTestFailureArtifacts`，在 `.artifacts/test-failures/` 自动抓取 DOM、截图、上下文与错误堆栈。

## 使用示例
```typescript
import { CairnTestHarness } from '../../packages/worker/src/__tests__/harness.js'

const harness = await CairnTestHarness.create()

// 1. 设置场景
const { runId, snapshotDigest } = await harness.setupScenario({
  name: '我的自测场景',
  steps: [
    {
      id: newId(),
      name: '回显步骤',
      type: 'echo',
      effectType: 'READ_ONLY',
      input: { value: 'Hello' },
    },
  ],
})

// 2. 调度执行
await harness.executeRun(runId)

// 3. 断言终态与证据
const detail = await harness.assertRunCompleted(runId, 'SUCCEEDED')
await harness.assertEvidenceCreated(runId, { minCount: 1 })

await harness.close()
```
