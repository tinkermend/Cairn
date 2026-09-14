import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../packages/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const entry = new URL('index.html', import.meta.url).href;
const shots = fileURLToPath(new URL('screenshots/', import.meta.url));
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
const action = name => page.locator('[data-action="' + name + '"]');
const choose = value => page.locator('#sample-state').selectOption(value);
const navigate = async view => { await page.locator('.nav-link[href="#' + view + '"]').click(); await page.waitForFunction(v => location.hash === '#' + v && document.querySelector('.nav-link[aria-current="page"]').hash === '#' + v, view); };
const dialogOpen = () => page.locator('#dialog').evaluate(el => el.open);
const titleText = () => page.locator('.page-head').innerText();
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log('PASS ' + name); };

try {
  await page.goto(entry);
  await check('当前与候选外观的核心控件对比度', async () => {
    for (const theme of ['current', 'candidate']) {
      await page.locator('[data-theme-choice="' + theme + '"]').click();
      const ratios = await page.evaluate(() => {
        const luminance = rgb => {
          const c = rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
          return .2126*c[0] + .7152*c[1] + .0722*c[2];
        };
        const contrast = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
        const input = getComputedStyle(document.querySelector('#bench-name'));
        const primary = getComputedStyle(document.querySelector('#bench-save'));
        return { input: contrast(input.borderTopColor,input.backgroundColor), button: contrast(primary.color,primary.backgroundColor) };
      });
      assert.ok(ratios.input >= 3, theme + ' input border: ' + ratios.input);
      assert.ok(ratios.button >= 4.5, theme + ' primary text: ' + ratios.button);
    }
  });
  await check('外观 / 密度切换保留表单值并改变 Token', async () => {
    await page.locator('#bench-name').fill('保留这次修改');
    const candidate = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--action-primary'));
    await page.locator('[data-theme-choice="current"]').click();
    const current = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--action-primary'));
    assert.notEqual(candidate, current);
    assert.equal(await page.locator('#bench-name').inputValue(), '保留这次修改');
    await page.locator('#density').selectOption('compact');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--control-height').trim()), '32px');
    await page.locator('[data-theme-choice="candidate"]').click();
    await page.locator('#density').selectOption('comfortable');
  });
  await check('表单校验 / 保存加载 / 失败保留输入', async () => {
    await page.locator('#bench-url').fill('not-a-url');
    await page.locator('#bench-name').focus();
    assert.equal(await page.locator('#bench-url').getAttribute('aria-invalid'), 'true');
    await action('bench-save').click();
    assert.equal(await action('bench-save').isDisabled(), false);
    await page.locator('#bench-url').fill('https://demo.example.test');
    const width = (await action('bench-save').boundingBox()).width;
    await action('bench-save').click();
    assert.equal(await action('bench-save').isDisabled(), true);
    assert.ok(Math.abs((await action('bench-save').boundingBox()).width - width) < 1);
    await page.waitForFunction(() => !document.querySelector('#bench-save').disabled);
    await action('bench-error').click();
    assert.equal(await page.locator('#bench-name').inputValue(), '保留这次修改');
    await action('bench-retry').click();
  });
  await check('原生弹窗 Escape 与键盘焦点 / 侧栏 / 策略保存', async () => {
    await action('bench-policy').click();
    assert.equal(await dialogOpen(), true);
    await page.locator('[data-policy="2"]').check();
    await action('save-policy').click();
    await action('bench-policy').click();
    assert.equal(await page.locator('[data-policy="2"]').isChecked(), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#dialog').open);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'bench-policy');
    await action('bench-drawer').first().click();
    assert.match(await page.locator('#dialog').getAttribute('class'), /drawer/);
    for (let i=0;i<8;i++) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true);
    await page.keyboard.press('Escape');
  });
  await navigate('targets');
  await check('创建目标系统 / 输入转义 / 添加独立目标账号', async () => {
    await action('new-target').first().click();
    await page.locator('#target-name').fill('<img src=x onerror=alert(1)>');
    await page.locator('#target-url').fill('javascript:alert(1)');
    await page.locator('button[form="target-form"]').click();
    assert.equal(await dialogOpen(), true);
    await page.locator('#target-url').fill('https://demo.example.test');
    await page.locator('button[form="target-form"]').click();
    await page.waitForFunction(() => !document.querySelector('#dialog').open);
    assert.equal(await page.locator('#target-detail img').count(), 0);
    assert.match(await page.locator('#target-detail').innerText(), /<img src=x onerror=alert\(1\)>/);
    await action('add-account').click();
    await page.locator('#account-name').fill('审批专用账号');
    await page.locator('#account-login').fill('demo_approver');
    await page.locator('button[form="account-form"]').click();
    assert.match(await page.locator('#target-detail').innerText(), /审批专用账号/);
    assert.match(await page.locator('#target-detail').innerText(), /待认证/);
    await page.locator('#target-search').fill('采购');
    assert.equal(await page.locator('.target-row').count(), 1);
    await page.locator('#target-search').fill('不存在的目标');
    assert.match(await page.locator('#target-table').innerText(), /没有匹配/);
    await action('reset-filters').click();
    assert.equal(await page.locator('.target-row').count(), 5);
    await choose('error'); await action('retry-targets').click();
    assert.equal(await page.locator('.target-row').count(), 5);
    await choose('forbidden');
    assert.equal(await action('new-target').first().isDisabled(), true);
    await choose('normal');
  });
  await navigate('studio');
  await check('步骤编辑 / 顺序移动 / AI 显式接受 / 目标约束', async () => {
    const before = await page.locator('.step-select').count();
    await action('ai-suggestion').click();
    assert.equal(await page.locator('.step-select').count(), before);
    await page.keyboard.press('Escape');
    await action('ai-suggestion').click(); await action('accept-ai').click();
    assert.equal(await page.locator('.step-select').count(), before + 1);
    await page.locator('#step-name').fill('新增供应商核验');
    await page.locator('[data-action="move-step"][data-direction="-1"]').click();
    assert.equal(await page.locator('.step-select strong').nth(before-1).innerText(), '新增供应商核验');
    await choose('unbound');
    assert.equal(await action('trial').isDisabled(), true);
    await page.locator('#studio-target').selectOption('procurement');
    await page.locator('#step-value').fill('');
    assert.equal(await action('trial').isDisabled(), true);
    await page.locator('#step-value').fill('核验供应商一致，返回 passed 和 reason。');
    await action('save-draft').click();
    await page.waitForFunction(() => !document.querySelector('#save-draft').disabled);
    assert.match(await page.locator('#save-status').innerText(), /已保存/);
  });
  await check('模拟试跑冻结步骤，之后编辑不修改历史快照', async () => {
    const frozenName = await page.locator('#step-name').inputValue();
    await action('trial').click();
    await page.locator('#step-name').fill('试跑启动之后的修改');
    await page.waitForFunction(() => !!document.querySelector('[data-action="open-trial"]'), null, { timeout: 7000 });
    await action('open-trial').click();
    await page.waitForFunction(() => document.querySelector('.nav-link[aria-current="page"]').hash === '#run');
    assert.match(await titleText(), /执行成功/);
    await action('snapshot').first().click();
    const json = JSON.parse(await page.locator('#snapshot-json').innerText());
    assert.ok(json.steps.some(step => step.name === frozenName));
    assert.ok(!json.steps.some(step => step.name === '试跑启动之后的修改'));
    assert.equal(json.target, 'procurement');
    await page.keyboard.press('Escape');
  });
  await check('重试成功 / 最终失败 / 证据缺失保持独立语义', async () => {
    await choose('retry');
    await page.locator('[data-action="attempt"][data-attempt="1"]').click();
    assert.match(await titleText(), /执行成功/);
    assert.match(await page.locator('.evidence-area').innerText(), /第一次尝试超时/);
    assert.match(await page.locator('.run-output').innerText(), /本次尝试未产生有效输出/);
    await page.locator('[data-action="attempt"][data-attempt="2"]').click();
    assert.match(await page.locator('.run-output').innerText(), /1280/);
    await choose('failed');
    assert.match(await titleText(), /执行失败/);
    assert.match(await page.locator('.run-step').nth(4).innerText(), /未执行/);
    await choose('missing');
    assert.match(await titleText(), /执行成功/);
    assert.match(await titleText(), /证据：不完整/);
    assert.equal(await action('zoom-evidence').count(), 0);
    assert.match(await page.locator('.run-output').innerText(), /1280/);
  });
  await check('认证等待 / 人工核查不暴露重放 / 断线恢复', async () => {
    await choose('auth');
    assert.match(await page.locator('.run-summary').innerText(), /尚无有效 Lease/);
    await action('auth-dialog').click(); await action('confirm-auth').click();
    assert.match(await titleText(), /执行中/);
    await page.waitForFunction(() => document.querySelector('.page-head').textContent.includes('执行成功'));
    await choose('review');
    assert.equal(await page.locator('[data-action="trial"],[data-action="retry-run"],[data-action="resume-run"]').count(), 0);
    await action('review-run').click();
    await page.locator('input[name="conclusion"][value="已判定失败"]').check();
    await page.locator('#review-reason').fill('已检查订单列表，未发现提交成功记录。');
    await page.locator('button[form="review-form"]').click();
    assert.match(await titleText(), /已判定失败/);
    assert.match(await page.locator('#main').innerText(), /已检查订单列表/);
    assert.equal(await action('review-run').count(), 0);
    await choose('offline');
    assert.match(await titleText(), /缓存状态/);
    await action('reconnect').click();
    await page.waitForFunction(() => document.querySelector('.page-head').textContent.includes('执行成功'));
  });
  await check('所有样本在常用宽度无页面横向溢出', async () => {
    // A fresh page restores the reference fixtures; the interaction tests above deliberately mutate them.
    await page.goto(entry);
    const views = {
      components: ['normal','error','loading'], targets: ['normal','empty','loading','error','forbidden'],
      studio: ['normal','unbound','readonly'], run: ['retry','failed','missing','auth','running','review','offline']
    };
    for (const width of [1920,1440,1366,1024,820,390]) {
      await page.setViewportSize({width,height:1000});
      for (const [view,samples] of Object.entries(views)) {
        await navigate(view);
        for (const sample of samples) {
          await choose(sample);
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1), view+'/'+sample+' overflows at '+width);
        }
        await choose(samples[0]);
        if (width===1440) {
          await page.locator('#page-title').evaluate(el=>el.blur());
          await page.screenshot({path:shots+'/'+view+'.png',fullPage:true});
        }
      }
    }
  });
  await check('减少动效 / 导航折叠 / 无外部请求与运行时异常', async () => {
    await page.setViewportSize({width:1440,height:1000});
    await navigate('components');
    await page.locator('#reduce-motion').check();
    assert.equal(await action('bench-policy').evaluate(el=>getComputedStyle(el).transitionDuration), '0s');
    await page.locator('#reduce-motion').uncheck();
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await action('bench-policy').evaluate(el=>getComputedStyle(el).transitionDuration), '0s');
    await page.emulateMedia({reducedMotion:'no-preference'});
    const width=await page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().width);
    await page.locator('#collapse-nav').click();
    assert.ok(await page.locator('.sidebar').evaluate(el=>el.getBoundingClientRect().width) < width);
    assert.equal(await page.locator('#collapse-nav').getAttribute('aria-expanded'), 'false');
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
  });
  console.log('All '+passed+' checks passed. Screenshots: '+shots);
} finally {
  await browser.close();
}
