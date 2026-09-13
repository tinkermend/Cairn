# Browser Surface 受控站点

给 P5 Resolver / 浏览器步骤做 L2 回归。静态页 + 本机 Node 服务，可重置，不访问外网。

```bash
cd tests/target-surface-lab
node server.mjs
```

默认 [http://127.0.0.1:4178/](http://127.0.0.1:4178/)。换端口：`LAB_PORT=4181 node server.mjs`。

| 路径 | 覆盖 |
| --- | --- |
| `/` | 普通 DOM：导航落点、点击、填写、提取、断言 |
| `/nested` | 两层 iframe |
| `/remount` | 定时重挂载的 iframe |
| `/popup` | `window.open` |
| `/icons` | 多行重复 `aria-label`，用行内锚点消歧 |
| `/shadow` | open / closed Shadow DOM |
| `/canvas` | Canvas 目标；点击色块后出现单号（D0 视觉样本） |
| `/hybrid-missing` | 检索成功但 DOM 无单号（编造检测） |
| `/csp` | 限制 `script-src` 与 `connect-src`，供 S07-lite |
| `/missing` | 故意没有目标 |

相关页引入 `/lab-events.js`，事件记在 `window.__labEvents`。

这不是真实企业系统。L2 通过不得写成「已兼容某某业务系统」。
