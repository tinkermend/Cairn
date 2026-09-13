# AI 探针骨架

`midscene/` 是 S06 适配层：动作边 gate、显式 modelConfig、受管 Page。`page-agent/` 是 S07-lite 的 binding 与 SPI 约束。

`WorkerModule` 与 `engine/` 不得 import 本目录之外的 Midscene / page-agent。正式接入另审 P8 / P9。
