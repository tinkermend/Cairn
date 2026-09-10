# 青石场站监控（目标系统联调夹具）

独立的账密登录页，用来给识途「目标系统」目录做人工验证和后续登录绑定探测。

它不是 workspace 包，也不进入正式 Run / Execution Engine。表单使用常规 HTML 字段（`username` / `password` / `submit`），方便以后按标准登录页做启发式探测。

## 怎么跑

```bash
cd tests/target-login-hmi
node server.mjs
```

浏览器打开 [http://127.0.0.1:4177/login](http://127.0.0.1:4177/login)。

| 账号 | 密码 |
| --- | --- |
| `demo` | `demo123` |
| `alice` | `alice123` |

在识途控制台登记目标系统时可用：

- 入口 URL：`http://127.0.0.1:4177/`
- 登录 URL：`http://127.0.0.1:4177/login`
- 认证方式：账号密码
- 验证码：无

换端口：`HMI_PORT=4180 node server.mjs`。

## 自检

```bash
node check.mjs
```

会拉起临时端口、检查登录表单字段，并验证错误口令与正确口令的跳转。
