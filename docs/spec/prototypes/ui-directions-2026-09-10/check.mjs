import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../packages/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1.5 });
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
const base = new URL('index.html', import.meta.url);
try {
  for (const width of [1600, 1024, 768, 375]) {
    await page.setViewportSize({ width, height: 1100 });
    for (const theme of ['iris', 'celadon', 'glacier']) {
      for (const view of ['overview', 'studio', 'run']) {
        await page.goto(`${base}?theme=${theme}&page=${view}`);
        assert.equal(await page.locator('h1').count(), 1);
        const bounds = await page.locator('body').evaluate(el => ({ scroll: el.scrollWidth, viewport: innerWidth }));
        assert.ok(bounds.scroll <= bounds.viewport, `${width}/${theme}/${view}: horizontal overflow ${bounds.scroll}`);
        if (width === 1600) await page.screenshot({ path: new URL(`${theme}-${view}.png`, import.meta.url).pathname, fullPage: true });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}?theme=iris&page=overview`);
  await page.getByRole('button', { name: 'B 青瓷绿', exact: true }).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'celadon');
  await page.getByRole('button', { name: '场景编排', exact: true }).click();
  await page.locator('[data-step="3"]').click();
  assert.match(await page.locator('#properties').innerText(), /AI Assert/);
  const customIntent = '检查订单审批结果。';
  const customName = 'approval"<test>';
  await page.locator('#step-intent').fill(customIntent);
  await page.locator('#output-name').fill(customName);
  await page.locator('#model-route').selectOption('precise');
  await page.getByRole('button', { name: '应用配置', exact: true }).click();
  await page.getByRole('button', { name: '知道了', exact: true }).click();
  await page.locator('[data-step="0"]').click();
  await page.locator('[data-step="3"]').click();
  assert.equal(await page.locator('#step-intent').inputValue(), customIntent);
  assert.equal(await page.locator('#output-name').inputValue(), customName);
  assert.equal(await page.locator('#model-route').inputValue(), 'precise');
  await page.getByRole('button', { name: '查看运行详情', exact: false }).click();
  await page.locator('[data-evidence="attempts"]').click();
  assert.match(await page.locator('.evidence-pane').innerText(), /尝试 01 \/ 02/);
  await page.locator('[data-evidence="events"]').click();
  assert.match(await page.locator('.evidence-pane').innerText(), /会话保留/);
  await page.goto(`${base}?theme=__proto__&page=invalid`);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'iris');
  assert.deepEqual(errors, []);
  console.log('PASS: 3 light themes × 3 pages × 4 widths; navigation, editing, evidence tabs, input escaping; 9 screenshots refreshed.');
} finally {
  await browser.close();
}
