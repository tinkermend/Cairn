# 评审与验证报告目录

本目录存放代码 Review、实施复查、测试验证、验收结果及整改记录。每份报告注明日期、对应方案或审查范围、发现与验证结果；技术设计和验收标准仍维护在 [docs/spec](../spec/README.md) 的对应方案中。

| 日期 | 报告 | 对应方案 | 状态 |
| --- | --- | --- | --- |
| 2026-09-15 | [FlowGram 蛇形排布与工作区留白修正](2026-09-15-flowgram-snake-layout.md) | [接入方案](../spec/2026-09-14-flowgram-sequence-editor.md) | 同字号下可见节点由 4 到 8；空列修正，14 组浏览器交互及 43 项定向测试通过；用户授权验收后合入 |
| 2026-09-15 | [FlowGram 编辑便捷性修正](2026-09-15-flowgram-editor-ux.md) | [正式接入草案](../spec/2026-09-14-flowgram-sequence-editor.md) | 恢复并排常驻属性、中性步骤边框，补直接定位；7 组交互检查及 36 项定向测试通过，完整工程门禁限制见报告 |
| 2026-09-15 | [受管浏览器 Studio 控制台用户路径](2026-09-15-managed-browser-studio-console.md) | [受管浏览器查看与认证](../spec/2026-09-13-managed-browser-view-and-auth.md) | 控制台走完等待认证、输入、续跑与证据；同日补续跑后只读画面与 dispose hold 绑定。BV08 p95、断线条款控制台重测、D1 与系统弹窗未宣称 |
| 2026-09-15 | [变化提示与 SSE 鉴权故障隔离](2026-09-15-change-hint-and-sse-auth.md) | [Run 实时观察](../spec/2026-09-13-run-realtime-observation.md) | ABC 复查 A 线第 1、8 项已修；提示失败不拖垮进程，库故障不清登录；PG LISTEN 可多次重连。MySQL/SQLite 实时仍按方案依赖 Redis |
| 2026-09-14 | [FlowGram 10 步混编接入验证](2026-09-14-flowgram-sequence-spike.md) | [正式接入草案](../spec/2026-09-14-flowgram-sequence-editor.md) | 独立 PoC：10/10 真实试跑成功、27 条证据；编辑与冲突验证通过，StrictMode 桥接和完整工程门禁限制见报告 |
| 2026-09-14 | [Worker 登记与执行节点治理落地](2026-09-14-worker-registry-implementation.md) | [Worker 登记与治理](../spec/2026-09-14-worker-registry-and-fleet.md) | 二次对照后补齐过期关联、归属实例、连接 3s、先监听再登记；WR03/WR13 及 TLS 证明仍跳过≠通过 |
| 2026-09-14 | [资源生命周期接续实施](2026-09-14-resource-lifecycle-and-lists-implementation.md) | [资源生命周期与列表管理](../spec/2026-09-14-resource-lifecycle-and-list-management.md) | 二次对照后补齐会话关闭、在途证据、历史已删除展示、运行完整筛选、插件分页与版本桶按 VersionId 清理；真 AWS 版本桶与根目录全量门禁仍未宣称通过 |
| 2026-09-14 | [编写观察面接续实施](2026-09-14-authoring-observation-debug-steps-implementation.md) | [编写观察面](../spec/2026-09-14-authoring-observation-debug-steps.md) | I1–I5 二次收口指认/覆盖/Resolver/页变/grant；I6 保持 assist closed；定向回归见报告，AO01–AO20 控制台全量未宣称交付 |
| 2026-09-14 | [识途助手浮窗整改](2026-09-14-assistant-dialog-redesign.md) | [平台助手一期](../spec/2026-09-14-platform-assistant-phase-one.md) | 改为右下角可拖动非模态浮窗；9 项浮窗与 5 项入口用例、桌面/窄屏、真实拖动及主页面操作通过 |
| 2026-09-14 | [Worker 登记与执行节点治理方案评审](2026-09-14-worker-registry-review.md) | [Worker 登记与治理](../spec/2026-09-14-worker-registry-and-fleet.md) | 3 项 P1、3 项 P2 已写入方案并按此实施；初评 5 项探针仍是缺口证据。落地结果见[实施报告](2026-09-14-worker-registry-implementation.md) |
| 2026-09-14 | [助手头像替换与自由拖动](2026-09-14-assistant-icon-replacement.md) | [平台助手一期](../spec/2026-09-14-platform-assistant-phase-one.md) | 只显示头像，支持拖动与位置记忆；补三档 WebP，浏览器实载由 784.8 降至 4.17 KiB；14 项组件用例与资源打包通过，完整构建的范围外类型错误见报告 |
| 2026-09-14 | [平台助手一期落地验证](2026-09-14-platform-assistant-phase-one-implementation.md) | [平台助手一期](../spec/2026-09-14-platform-assistant-phase-one.md) | 权限先行已实施；离线契约与三库/HTTP 验证见报告；真实模型 60 条与用户效果门槛未跑 |
| 2026-09-14 | [平台助手一期方案审查](2026-09-14-platform-assistant-phase-one-review.md) | [平台助手一期](../spec/2026-09-14-platform-assistant-phase-one.md) | 有条件批准后的 P1 已写入方案并按此实现 |
| 2026-09-14 | [宪法瘦身审查与实施](2026-09-14-constitution-slimming-review.md) | [宪法全文](../../CLAUDE.md)、关联方案与当前契约代码 | 已按审查建议瘦身：359 → 114 行，保留核心原则、工程约定与阅读入口；旧节号映射、规范归属及检查引用同步更新 |
| 2026-09-14 | [受管浏览器认证 fencing 与画面回收](2026-09-14-managed-browser-auth-fence.md) | [受管浏览器查看与认证](../spec/2026-09-13-managed-browser-view-and-auth.md) | ABC 复查 B 线 P1/P2 已修；Worker 侧循环与等待认证续跑由 S-LIVE 关上；Studio 用户路径见 [2026-09-15 控制台报告](2026-09-15-managed-browser-studio-console.md) |
| 2026-09-14 | [目标、场景、录制与运行的管理闭环复查](2026-09-14-resource-lifecycle-and-lists-review.md) | [资源生命周期与列表管理](../spec/2026-09-14-resource-lifecycle-and-list-management.md) | 删除、修改、筛选与分页缺口已核对；4 项隔离 SQLite 现状探针完成；后续实施见上份接续报告 |
| 2026-09-14 | [A/B/C 三线实施与衔接复查](2026-09-14-abc-integration-review.md) | Run 实时观察、受管浏览器与认证、录制与 Studio 集成 | A 线第 1、8 项见[提示与 SSE 鉴权整改](2026-09-15-change-hint-and-sse-auth.md)；B 线第 2、7 项见上份整改；其余 C 线 P1/P2 与 D1/D2 联合验收仍按原报告 |
| 2026-09-14 | [平台配置中心实施复查](2026-09-14-platform-configuration-center-review.md) | [平台动态配置与参数中心](../spec/2026-09-13-platform-configuration-center-assessment.md) | 6 项缺陷已修复，137 项定向回归通过；完整验证范围与限制见报告 |
