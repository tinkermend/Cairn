# deploy

私有化部署产物：compose 编排 + PostgreSQL / MinIO 初始化。

> 本机容器运行时是 podman 5.8.2，没有 docker；本地验证走 `podman compose`。

## 升级注意：产品角色

含 `0018_product_roles`（MySQL / SQLite 为 `0004_product_roles`）的版本会把系统角色收成「管理员 / 编写者 / 执行者 / 只读」。已有 `operator` 账号**不会**自动补挂编写者，升级后只能跑、不能改目标或场景，也看不见用户 / 角色 / 审计。这是预期降权，不是故障。若该用户仍要编写，由管理员在用户页补挂「编写者」。新建控制台账号默认是编写者。

