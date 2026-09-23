# 系统知识地图交互原型

直接打开 [index.html](index.html)。本目录只有独立的 HTML、CSS、JavaScript；不调用 API、不写入数据，也不修改正式 Web 页面。画面中的系统、页面、对象、时间和场景均是演示样例。

可操作路径：切换目标系统；搜索页面或对象；按对象状态筛选；点击对象查看生命周期、验证维度、证据可用性和引用关系；点击场景聚焦对应连线；缩放地图。在窄屏下页面区域改为顺序卡片，关系留在列表与详情中。

可落地的数据映射：

| 原型元素 | 当前领域来源 | 含义边界 |
| --- | --- | --- |
| 目标系统、页面、对象 | `fetchMapPages` / `fetchMapObjects`，`MapAssetRef` | 页面包含对象；列表实际采用游标分页，正式页面应逐层加载 |
| 生命周期、最近验证、证据、变化 | `MapAssetListItem` / `MapAssetDetail` / `fetchMapChanges` | 变化表示需要复核，不等于运行失败；验证维度逐项展示 |
| 实线 | `confirmed_reference` 且 `resolution=resolved` | 明确引用 |
| 虚线 | `potential_match` | 可能匹配，尚未成为明确引用 |
| “覆盖未知” | `unknown_coverage` / 扫描完整性 | 仅在详情显示数量，不凭空连到场景 |
| 版本和计算时间 | `MapViewMeta` | 正式接入须区分投影与已发布版本 |

实现依据：[地图契约](../../../packages/shared/src/map-api.ts)、[现有目标知识页](../../../packages/web/src/features/map/page.tsx)和[设计语言](../../design/front/design-language.md)。原型的页面与对象名称不代表当前数据库内容；关联场景连线只表达对象与场景的关系，不表达页面导航或对象之间的因果关系。
