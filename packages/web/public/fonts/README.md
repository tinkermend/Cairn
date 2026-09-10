# 自托管字体

`Inter` v20 拉丁子集（variable weight 400–700），取自 Google Fonts，
授权 SIL Open Font License 1.1 — https://github.com/rsms/inter/blob/master/LICENSE.txt

- `inter-latin.woff2` — U+0000-00FF 及常用标点
- `inter-latin-ext.woff2` — 扩展拉丁

CJK 不由 Inter 承担，按 `tokens.css` 的 `--font-sans` 回落到系统中文字体。
`@font-face` 声明在 `packages/web/src/styles/index.css`。
