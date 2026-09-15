# FlowGram Sequence Editor：10 步混编接入验证

日期：2026-09-14。范围：用户授权先做独立分支 PoC，再基于实际结果形成正式接入方案。本次按「页面或底座」级别验收，原因是增加顺序画布与结构编辑交互。正式方案见[待审草案](../spec/2026-09-14-flowgram-sequence-editor.md)。

## 结论

**10 步混编链路和顺序画布的核心编辑成立，可以进入正式接入设计。** 建议使用 FlowGram fixed-layout 的画布与布局能力，继续由识途维护 Structured Step、编译器、表单、输出引用、草稿及执行事实。

本次支持「有条件优先选择 FlowGram」。尚不能宣称它优于所有候选、正式模块已验收，或 D1/D2 的全部交付条件已经通过：React 严格模式需要局部适配，完整性能、权限矩阵、录制和 AI Authoring 联合链路未纳入本次。未做 xyflow 等框架的同条件 PoC。

## 隔离方式

- worktree：`/Users/tinker/src/singe/Cairn-flowgram-spike`；分支：`codex/flowgram-sequence-spike`。
- 原目录正在承载其他未提交工作，保持原状。本 worktree 先以 `97cf9629b119fdc734619c329b1497d2042423f9` 保存当时工作区快照，再开始验证。**只对比该提交之后的变化。**
- 前端 5186 和靶场 4186 独立启动；复用原有本地 API 3030、已运行 Worker、数据库及模型配置。未替换 Worker/API，没有为接入 FlowGram 新增执行引擎。
- 新建一个样例 Target、独立 TargetAccount 和 Scenario。样例草稿验证后已恢复原 10 步定义，revision 因真实保存增加至 r7；已发布定义保持 v1。
- 依赖锁定 `@flowgram.ai/fixed-layout-editor@1.0.15`，React `19.2.8`，MIT。升级应重新跑兼容验证。

## 真实样例

业务：查询「华东设备有限公司」采购订单，提取订单号与应付金额，填写核对表并登记，核对只登记一次。

| 顺序 | 类型 | 实际动作或契约 |
| --- | --- | --- |
| 1 | navigate | 打开采购核对工作台 |
| 2 | fill | 输入客户名称 |
| 3 | ai_action | 根据业务指令点击查询订单 |
| 4 | assert | 查询结果订单号等于 `FG-2026-0108` |
| 5 | ai_extract | 输出对象 `purchaseOrder`，含必填字符串 `orderNo`、`amount` |
| 6 | fill | 从 `purchaseOrder.orderNo` 填写核对订单号 |
| 7 | fill | 从 `purchaseOrder.amount` 填写核对金额 |
| 8 | ai_action | 点击一次「核对并登记」 |
| 9 | assert | 回执等于 `已核对 · FG-2026-0108 · 1280.00` |
| 10 | ai_assert | 只读判断客户、订单、金额和登记次数满足要求 |

这是一条真实平台运行与真实模型调用的受控 Web 靶场样例。靶场是本地测试业务系统，登录只模拟认证动作，不等于外部企业系统验收。

## 持久化运行事实

- Scenario：`01a09f26-e112-70ea-aedd-9b3fad83d31f`。
- 成功 Run：`01a09f33-6faa-75d8-9305-35ad91a043e3`，2026-09-14 17:15:44–17:16:28（UTC+8），运行耗时 **44.116 秒**。
- Run `SUCCEEDED`；10 个 StepRun 均 `SUCCEEDED`，各 1 个成功 Attempt；Evidence `COMPLETE`。
- 27 条 available Evidence：10 条 input、10 条 output、7 条 AI 调用日志。逐个核对 input/output 同时关联本次 StepRun 与 Attempt。
- 模型：`doubao-seed-2-1-turbo-260628`，共 7 次模型调用，记录输入 53,112 tokens、输出 1,047 tokens。cost 为 null，未据此估算费用。
- AI Extract 实际输出 `{"amount":"1280.00","orderNo":"FG-2026-0108"}`；最终 AI Assert 为 `passed: true`。
- 独立靶场 journal 共 1 条登记，回执 `sub-mu1139kj-a1aw`，订单、金额与客户匹配。该回执独立于平台 Step 成功状态读取。
- Web 通过原有 SSE 观察 Run；页面刷新后重新读到相同成功状态。后续草稿名称修改未改变已完成 Run 的冻结快照。

可追溯证据：[脱敏运行与回执摘要](assets/2026-09-14-flowgram/evidence-summary.json)、[桌面画布与 AI 输出](assets/2026-09-14-flowgram/desktop.png)、[390px 窄屏](assets/2026-09-14-flowgram/mobile.png)。完整运行和证据仍由平台数据库保存。

首次试跑 `01a09f31-7714-77c0-9bce-6e6ccd375829` 因未配置 TargetAccount，在步骤开始前以 `SESSION_ACCOUNT_REQUIRED` 失败。随后补齐独立账号与登录配置，按平台原有会话路径重新试跑成功，没有绕过校验，也没有把首次失败标成成功。

## 编辑与呈现验证

真实 Chromium 操作及真实 API 验证：

1. 10 个画布节点与 Scenario Step ID 一一对应。
2. 鼠标拖动重排改变实际步骤顺序；原有结构撤销恢复原顺序。
3. 连线加号打开识途现有类型菜单，可插入第 2 步，再撤销回到 10 步。
4. 将输出生产者移到消费者之后，原 Compiler 报错，画布显示诊断且试跑禁用。
5. 属性名称经真实草稿 API 保存、刷新后保留，Step ID 和其余契约保持不变。
6. 保存请求在途时禁用画布拖动与插入。
7. 双编辑者 revision 冲突真实返回 409，本地输入保留，远端定义未被覆盖；验证后恢复样例定义。
8. 改草稿后历史 Run Snapshot 不变；刷新后 10 个节点显示对应试跑成功状态。
9. 列表/画布切换与重复挂载没有 pageerror；窄屏可从步骤进入属性。
10. 查看了 1440px、1024px、390px 实际页面。检查无页面横向溢出；修正窄屏标题挤压，画布支持滚动和缩放。

这里的撤销沿用 `useStudioDraft` 已有的单次结构撤销，**没有验证或启用 FlowGram 原生历史栈**。键盘替代路径保留原有上移/下移按钮与 Studio 快捷键；本次未做完整屏幕阅读器或触摸拖动验收。

## 框架适配中发现的问题

### React 严格模式

将 Provider 直接放入现有 StrictMode 树会触发 `Ambiguous match found for serviceIdentifier: FlowRendererRegistry`，导致页面加载失败。

PoC 通过一个独立 React root 承载第三方画布，主应用保留 StrictMode；输入文档、选择和事件通过显式 props 传递，并增加局部错误边界与卸载清理。该路径通过反复挂载、视图切换和真实编辑验证。**尚未证明上游修复，也未做长期内存与服务泄漏测试。** 正式方案应决定保留局部桥接，还是维护可上游合入的最小补丁。

### UI 材料与视口 API

只提供自定义节点不足以启用拖动：还需要 `drag-node`、插入点和拖放提示等材料。PoC 使用识途 Token 和组件自行实现这些小部件，未引入 Semi UI 整套视觉系统。

`scrollToView` 在关闭动画且省略 zoom 时会把缩放状态写成 undefined，产生 NaN 视口。显式传入当前 zoom 后恢复正常。本次调用已修正，后续视口调用集中封装。

### 状态与体积

FlowGram 只接收投影与已知 Step ID 的顺序变化。节点数据不能反向覆盖最新业务字段；未知 ID、重复 ID、缺失节点、其他节点类型和嵌套 blocks 都拒绝。

关闭 FlowGram node/form engine、variable engine 和 history；识途已有表单、引用检查、字段草稿、OCC 继续是唯一入口。本次新增画布异步 JS chunk 约 **660.55 kB / gzip 185.46 kB**，构建产生体积警告。异步加载使默认列表无需先加载画布 chunk，但这不代表 100/500 步性能已通过。

## 工程检查

- 8 条新增适配器用例通过：契约往返、旧字段覆盖防护、前向引用和不受支持结构。
- 35 条已有 Studio、studio-document、trial-dialog 用例通过；共 43 条定向用例。
- 新增 FlowGram 目录 ESLint 通过；设计检查 `pnpm check:design` 通过。
- `vite build` 打包通过，有上述画布 chunk 体积警告。
- 完整 `typecheck` **未通过**：`debug-hold-bar.tsx:74` 和 `targets/detail.test.tsx:94` 的 `.at` 目标库问题；`studio.test.tsx:783,878` 夹具缺 name/type；`workers-api.ts:20` 默认查询缺 limit。这四个文件与基线没有差异，本次新增文件没有类型诊断。
- 连同 detail.tsx 检查时存在基线已有 lint：查询键依赖、effect 内同步 setState。本次未扩大范围修改。
- 未声称完整 package build、全仓检查或生产部署通过。

复现脚本与操作顺序见[验证工具说明](../../tools/flowgram-spike/README.md)。

## 后续决策边界

可批准正式接入方案设计；不直接把 PoC 合入主线作为完成模块。正式开放前需补齐严格模式长期方案、空文档/上限/大场景、撤销模型、角色权限、录制与 AI 编写导入、触摸与键盘操作、升级回归和目标系统联合验收。交付顺序仍以[主计划](../plan/识途开发路线与工程实施计划.md)为准。
