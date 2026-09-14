import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../../packages/web/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const ts = require("typescript");
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
// 三层平面必须构成一道明度阶梯：画布 < 壳 < 卡片，且任意两层不得同值。
// 壳一旦也用纯白，卡片就没有更亮的空间，画布到两者的距离又相等 —— 画布会被读成孤立的色块。
{
  const canvas = luminance(value("--surface-page"));
  const nav = luminance(value("--surface-nav"));
  const card = luminance(value("--surface-card"));
  assert.ok(canvas < nav, `画布必须暗于壳：${canvas.toFixed(4)} vs ${nav.toFixed(4)}`);
  assert.ok(nav < card, `壳必须暗于卡片，纯白只留给卡片：${nav.toFixed(4)} vs ${card.toFixed(4)}`);
  const step = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  assert.ok(
    step(canvas, card) >= 1.08,
    `卡片与画布明度比 ${step(canvas, card).toFixed(3)}:1 低于 1.08 下限，白卡片会糊在画布上`,
  );
  for (const [n, a, b] of [
    ["壳/画布", nav, canvas],
    ["卡片/壳", card, nav],
  ]) {
    assert.ok(step(a, b) > 1.01, `${n} 明度撞车（${step(a, b).toFixed(3)}:1），三层必须三个值`);
  }
}

const edge = luminance(value("--border-control")),
  white = luminance(value("--surface-card"));
assert.ok((white + 0.05) / (edge + 0.05) >= 3, "Input boundary must reach 3:1");
assert.equal(
  value("--surface-control"),
  value("--surface-card"),
  "Input fill must match card white; no gray or cold-white wash",
);
for (const file of [
  "README.md",
  "design-language.md",
  "components.md",
  "implementation.md",
  "ai-workflow.md",
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

// 检查字符串与样式属性，跳过注释、JSX 正文、锚点和 selector。
// 这是静态语法护栏；动态拼接、外部 CSS 和布局效果仍需浏览器验收。
function sourceStyleIssues(source, page = true, allowedFontClasses = []) {
  const ast = ts.createSourceFile("sample.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const issues = [];
  const literalColor = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i;
  const paletteClass = /(?<![\w-])(?:bg|text|border(?:-[xysetblr])?|divide|outline|ring(?:-offset)?|shadow|accent|caret|fill|stroke|from|via|to|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)(?![\w-])/;
  const fontClass = /(?<![\w-])text-(?:xs|sm|base|lg|xl|[0-9]xl)(?![\w-])|(?<![\w-])text-\[(?:length:|font-size:)?[\d.]+(?:px|r?em|pt|vw|vh|%)\]/;
  const add = (kind, value) => issues.push({ kind, value });
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text;
      const parent = ts.isJsxExpression(node.parent) ? node.parent.parent : node.parent;
      const name = (ts.isPropertyAssignment(parent) || ts.isJsxAttribute(parent)) ? parent.name.getText(ast).replace(/['"]/g, "") : "";
      const colorProperty = /^(?:--|background|border|outline|(?:box|text)Shadow|fill$|stroke$)|color$/i.test(name);
      const arbitraryColor = [...text.matchAll(/\[[^\]]+\]/g)].some(([part]) => literalColor.test(part));
      if (paletteClass.test(text) || arbitraryColor || (colorProperty && literalColor.test(text))) add("color", text);
      if (/\btransition-all\b/.test(text)) add("motion", text);
      const fontText = text.split(/\s+/).filter(token => !allowedFontClasses.includes(token)).join(" ");
      if (page && (fontClass.test(fontText) || (name === "fontSize" && /^[\d.]+(?:px|r?em|pt|vw|vh|%)?$/.test(text)))) add("font", text);
    }
    if (page && ts.isPropertyAssignment(node) && node.name.getText(ast) === "fontSize" && ts.isNumericLiteral(node.initializer)) add("font", node.initializer.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return issues;
}

// 真实误报/漏报的回归样本。验证违规会失败，合法内容不会因类似色号被拦住。
const sourceCases = [
  ['<div className="text-body bg-card" />', [], true],
  ['<div className="bg-[#ff0000]" />', ["color"], true],
  ['<div className="hover:bg-red-500/50" />', ["color"], true],
  ['<div style={{color: "rgb(255 0 0)"}} />', ["color"], true],
  ['<svg><path fill="#fff" /></svg>', ["color"], true],
  ['<div className="text-[11px]" />', ["font"], true],
  ['<div style={{fontSize: 11}} />', ["font"], true],
  ['<div className="text-sm" />', ["font"], true],
  ['<div className="text-sm" />', [], false],
  ['<div className="transition-all" />', ["motion"], true],
  ['// 说明 #abc / transition-all\nconst s = "#abc"; const x = <a href="#abc">色号 #abc</a>;', [], true],
  ['<div style={{color:"var(--text-primary)",fontSize:"var(--font-size-body)"}} />', [], true],
  ['<div className="text-[28px] sm:text-[34px]" />', [], true, ["text-[28px]", "sm:text-[34px]"]],
  ['<div className="text-[28px] text-[11px]" />', ["font"], true, ["text-[28px]"]],
];
for (const [source, expected, page, allowed] of sourceCases) {
  assert.deepEqual(sourceStyleIssues(source, page, allowed).map(issue => issue.kind), expected, `样式检查回归：${source}`);
}

// 页面字号使用职务刻度；components/ui 保留控件自己的尺寸 API。
const contentTsx = allTsx.filter(
  (f) => rel(f).startsWith("features/") || rel(f).startsWith("components/layout/"),
);
// ponytail: 仅保留认证页现存的独立字号（设计语言 §6.1），不豁免整个文件；
// 正式迁移时把品牌及认证控件字号纳入 Token 后删除这些精确例外。
const existingAuthFonts = {
  "features/auth/auth-layout.tsx": ["text-[28px]", "sm:text-[34px]"],
};
for (const file of allTsx) {
  const issues = sourceStyleIssues(readFileSync(file, "utf8"), contentTsx.includes(file), existingAuthFonts[rel(file)]);
  assert.deepEqual(issues, [], `${rel(file)}: 样式绕过统一规则（color 用语义 Token，font 用页面刻度，motion 用明确属性）：${JSON.stringify(issues)}`);
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
    `PASS: ${pairs.length} text contrast pairs, control border, 明度阶梯, token references, document links; ${sourceCases.length} 个样式误报/漏报回归样本，${allTsx.length} tsx 静态样式检查，${contentTsx.length} 个页面文件字号检查; 5 widths; form, tabs, toggle, dialog, 5 empty states, reduced motion.`,
  );
} finally {
  await browser.close();
}
