import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../../packages/web/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const root = new URL("./", import.meta.url);
const css = readFileSync(new URL("tokens.css", root), "utf8");
const tokens = Object.fromEntries(
  [...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
);
function value(name, seen = new Set()) {
  assert.ok(!seen.has(name), `Circular token: ${name}`);
  assert.ok(tokens[name], `Missing token: ${name}`);
  seen.add(name);
  const v = tokens[name];
  return v.startsWith("var(") ? value(v.slice(4, -1), seen) : v;
}
for (const match of css.matchAll(/var\((--[\w-]+)\)/g)) value(match[1]);
function luminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((c) => parseInt(c, 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
const pairs = [
  ["--text-primary", "--surface-card"],
  ["--text-secondary", "--surface-page"],
  ["--text-muted", "--surface-card"],
  ["--text-muted", "--surface-page"],
  ["--action-primary-foreground", "--action-primary"],
  ["--action-primary-foreground", "--action-primary-hover"],
  ["--selection-foreground", "--selection-background"],
  ["--ai-foreground", "--ai-background"],
  ...[
    "success",
    "warning",
    "error",
    "info",
    "waiting",
    "blocked",
    "neutral",
  ].map((s) => [`--status-${s}-foreground`, `--status-${s}-background`]),
  ["--surface-card", "--status-error-foreground"],
];
for (const [fg, bg] of pairs) {
  const a = luminance(value(fg)),
    b = luminance(value(bg));
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  assert.ok(ratio >= 4.5, `${fg}/${bg}: ${ratio.toFixed(2)}:1 < 4.5`);
}
const edge = luminance(value("--border-control")),
  white = luminance(value("--surface-card"));
assert.ok((white + 0.05) / (edge + 0.05) >= 3, "Input boundary must reach 3:1");
for (const file of [
  "README.md",
  "design-language.md",
  "components.md",
  "implementation.md",
]) {
  for (const match of readFileSync(new URL(file, root), "utf8").matchAll(
    /\]\(([^)]+)\)/g,
  )) {
    const link = match[1];
    if (/^https?:|^#/.test(link)) continue;
    const url = new URL(link, new URL(file, root));
    url.hash = "";
    assert.ok(existsSync(url), `${file}: broken link ${link}`);
  }
}
// ── 源码约束 ──────────────────────────────────────────────
// 宪法 §18.18：必须遵守的约束应由自动化检查卡住，而不是依赖自觉。
// 以下三条各自对应一类真实发生过的回归，不要因为"暂时没人违反"就删掉。
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const webSrc = fileURLToPath(new URL("../../../packages/web/src/", root));
function tsxFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = dir + name;
    if (name === "__screenshots__" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full + "/"));
    else if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(full);
  }
  return out;
}
const rel = (f) => f.slice(webSrc.length);
const allTsx = tsxFiles(webSrc);

// 1. 页面不得自选色板。颜色一律走语义 Token，否则 tokens.css 改了也带不动页面。
for (const file of allTsx) {
  const hex = readFileSync(file, "utf8").match(/#[0-9a-fA-F]{3,8}\b/g);
  assert.ok(!hex, `${rel(file)}: 硬编码颜色 ${hex?.[0]} —— 改用语义 Token`);
}

// 2. transition-all 会把没打算动的属性一起动画掉，等于动效不解释任何东西。
//    设计语言 §10：动效只用于说明状态变化。
for (const file of allTsx) {
  assert.ok(
    !/\btransition-all\b/.test(readFileSync(file, "utf8")),
    `${rel(file)}: transition-all —— 改成明确的属性表，如 transition-[background-color,box-shadow]`,
  );
}

// 3. 页面层文字必须走 §4 的字号职务刻度（text-page / text-section / text-body /
//    text-small / text-label）。components/ui 是 shadcn 组件底座的控件字号，不在此列——
//    把下拉菜单项也换成 text-body 等于给它赋予"正文"语义，那是另一种错。
const contentTsx = allTsx.filter(
  (f) => rel(f).startsWith("features/") || rel(f).startsWith("components/layout/"),
);
for (const file of contentTsx) {
  const bad = readFileSync(file, "utf8").match(
    /(?<![\w-])text-(xs|sm|base|lg|xl|[0-9]xl)(?![\w-])/g,
  );
  assert.ok(
    !bad,
    `${rel(file)}: 用了 Tailwind 默认字号 ${bad?.[0]} —— 页面层改用 text-page / text-section / text-body / text-small / text-label`,
  );
}

const constitution = readFileSync(new URL("../../../CLAUDE.md", root), "utf8");
for (const match of constitution.matchAll(
  /\]\((docs\/design\/front\/[^)]+)\)/g,
)) {
  assert.ok(
    existsSync(new URL("../../../" + match[1], root)),
    `Constitution: ${match[1]}`,
  );
}
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
try {
  for (const width of [1366, 1440, 1920, 768, 375]) {
    await page.setViewportSize({ width, height: 1050 });
    await page.goto(new URL("preview.html", root).href);
    assert.equal(await page.locator("h1").count(), 1);
    const bounds = await page.evaluate(() => ({
      actual: document.documentElement.scrollWidth,
      expected: innerWidth,
    }));
    assert.ok(
      bounds.actual <= bounds.expected,
      `${width}: horizontal overflow ${bounds.actual}`,
    );
    const controls = await page
      .locator("input,select,textarea")
      .evaluateAll((els) =>
        els
          .filter((el) => !el.labels?.length && !el.getAttribute("aria-label"))
          .map((el) => el.id),
      );
    assert.deepEqual(controls, [], "Every field has a name");
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(new URL("preview.html", root).href);
  await page.getByRole("button", { name: "验证表单", exact: true }).click();
  assert.equal(
    await page.locator("#sample-name").getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "sample-name",
  );
  await page.locator("#sample-name").fill("保留我的输入");
  await page.locator("#sample-number").fill("101");
  await page.getByRole("button", { name: "验证表单", exact: true }).click();
  assert.equal(
    await page.locator("#sample-number").getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(await page.locator("#sample-name").inputValue(), "保留我的输入");
  await page.locator("#sample-number").fill("10");
  await page.getByRole("button", { name: "验证表单", exact: true }).click();
  assert.match(await page.locator("#form-result").innerText(), /校验通过/);
  await page.locator("#toggle-example").click();
  assert.equal(
    await page.locator("#toggle-example").getAttribute("aria-pressed"),
    "false",
  );
  await page.locator("#tab-overview").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "tab-details",
  );
  await page.keyboard.press("Enter");
  assert.equal(
    await page.locator("#tab-details").getAttribute("aria-selected"),
    "true",
  );
  await page.locator("#open-confirm").click();
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "cancel-confirm",
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "open-confirm",
  );
  assert.match(await page.locator("#removable-item").innerText(), /^可移除/);
  await page.locator("#open-confirm").click();
  await page.locator("#confirm-remove").click();
  assert.match(await page.locator("#removable-item").innerText(), /已移除/);
  for (const mode of ["search", "loading", "permission", "offline", "empty"]) {
    await page.locator("#empty-mode").selectOption(mode);
    assert.ok((await page.locator("#empty-preview").innerText()).length > 5);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator(".spin")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    "none",
  );
  assert.deepEqual(errors, []);
  if (process.env.DESIGN_PREVIEW_SCREENSHOT) {
    await page.goto(new URL("preview.html", root).href);
    await page.screenshot({
      path: process.env.DESIGN_PREVIEW_SCREENSHOT,
      fullPage: true,
    });
  }
  console.log(
    `PASS: ${pairs.length} text contrast pairs, control border, token references, document links; ${allTsx.length} tsx 无硬编码色 / 无 transition-all，${contentTsx.length} 个页面文件字号在刻度上; 5 widths; form, tabs, toggle, dialog, 5 empty states, reduced motion.`,
  );
} finally {
  await browser.close();
}
