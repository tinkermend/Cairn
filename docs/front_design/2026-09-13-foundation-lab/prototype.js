(function prototypeApp() {
  "use strict";
  const $ = (s, root = document) => root.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls = "") => `<svg class="icon ${cls}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
  const badge = (label, color = "", glyph = "") => `<span class="badge ${color}">${glyph ? icon(glyph) : ""}${esc(label)}</span>`;
  const btn = (label, action, glyph = "", cls = "", attrs = "") => `<button type="button" class="button ${cls}" data-action="${action}" ${attrs}>${glyph ? icon(glyph) : ""}${label}</button>`;
  const ibtn = (label, action, glyph, attrs = "") => `<button type="button" class="icon-button" data-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(glyph)}</button>`;
  const kinds = {
    navigate: ["打开页面", "Navigate", "ExternalLink"], fill: ["填写内容", "Fill", "TextCursorInput"],
    click: ["点击元素", "Click", "MousePointer2"], assert: ["确定性断言", "Assert", "ShieldCheck"],
    aiAction: ["AI 操作", "AI Action", "Sparkles"], aiExtract: ["AI 提取", "AI Extract", "Sparkles"], aiAssert: ["AI 断言", "AI Assert", "Sparkles"]
  };
  const initialSteps = [
    { id: 1, kind: "navigate", name: "打开订单列表", value: "/orders", timeout: 15 },
    { id: 2, kind: "fill", name: "填写订单号", value: "{{inputs.orderNo}}", timeout: 10 },
    { id: 3, kind: "click", name: "点击查询", value: 'role=button[name="查询"]', timeout: 10 },
    { id: 4, kind: "aiExtract", name: "读取订单金额", value: "读取当前订单的含税总金额与币种，输出 amount 和 currency。", timeout: 30 },
    { id: 5, kind: "assert", name: "核验金额大于零", value: "{{steps.orderTotal.amount}} > 0", timeout: 10 },
    { id: 6, kind: "aiAssert", name: "核验订单已审批", value: "确认订单已经审批通过，输出判断结果和页面上的依据。", timeout: 30 }
  ];
  const clone = value => JSON.parse(JSON.stringify(value));
  const pages = {
    components: ["组件与交互", "SlidersHorizontal", "01"],
    targets: ["目标系统", "Monitor", "02"],
    studio: ["场景编排", "ListChecks", "03"],
    run: ["运行复盘", "PanelsTopLeft", "04"]
  };
  const modes = {
    components: [["normal", "默认状态"], ["error", "保存失败"], ["loading", "加载中"]],
    targets: [["normal", "已加载"], ["empty", "尚未接入"], ["loading", "加载中"], ["error", "加载失败"], ["forbidden", "无管理权限"]],
    studio: [["normal", "编辑草稿"], ["unbound", "未绑定目标"], ["readonly", "只读权限"]],
    run: [["retry", "重试后成功"], ["success", "执行成功"], ["failed", "执行失败"], ["missing", "证据不完整"], ["auth", "等待目标认证"], ["running", "运行中"], ["review", "副作用待核查"], ["offline", "实时连接中断"], ["trial", "最近一次模拟试跑"]]
  };
  const state = {
    page: "components", mode: { components: "normal", targets: "normal", studio: "normal", run: "retry" },
    targets: [
      { id: "procurement", name: "采购管理系统", host: "procurement.example.test", env: "测试", health: "success", accounts: [{ name: "采购测试员", login: "qa_procurement", auth: true }, { name: "审批测试员", login: "qa_approver", auth: true }], scenarioCount: 12 },
      { id: "warehouse", name: "仓储管理系统", host: "warehouse.example.test", env: "预发", health: "success", accounts: [{ name: "仓库管理员", login: "qa_warehouse", auth: true }], scenarioCount: 8 },
      { id: "service", name: "客户服务系统", host: "service.example.test", env: "测试", health: "warning", accounts: [{ name: "客服测试员", login: "qa_support", auth: false }], scenarioCount: 5 },
      { id: "expenses", name: "费用报销系统", host: "expenses.example.test", env: "开发", health: "neutral", accounts: [], scenarioCount: 0 }
    ],
    target: "procurement", search: "", env: "", health: "",
    steps: clone(initialSteps), selectedStep: 4, nextStepId: 7, studioTarget: "procurement", dirty: false, saved: false,
    trial: null, trialProgress: 0, trialRunning: false, trialEpoch: 0,
    runStep: 3, attempt: 2, reviewConclusion: "",
    bench: { name: "采购订单审批巡检", url: "https://procurement.example.test", env: "测试环境", retain: true, notify: true },
    policy: [true, true, false]
  };
  const targetNow = () => state.targets.find(t => t.id === state.target) || state.targets[0];
  const statusInfo = {
    success: ["成功", "success", "CircleCheck"], error: ["失败", "error", "CircleAlert"],
    pending: ["未执行", "", "Clock3"], warning: ["待核查", "warning", "CircleAlert"],
    info: ["执行中", "info", "LoaderCircle"]
  };
  const shellHeading = (index, title, text, actions) => `<section class="page-head"><div><div class="page-index">${index} / SHITU WORKSPACE</div><h1 id="page-title" tabindex="-1">${title}</h1><div class="sub">${text}</div></div><div class="actions">${actions || ""}</div></section>`;
  const notice = (tone, title, text = "", action = "") => `<div class="notice ${tone}">${icon(tone === "ai" ? "Sparkles" : tone === "success" ? "CircleCheck" : "CircleAlert")}<div class="grow"><strong>${title}</strong>${text ? `<p>${text}</p>` : ""}</div>${action}</div>`;
  const field = (id, label, value, attrs = "", hint = "") => `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${esc(value)}" ${attrs}>${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
  function toast(message, error = false) {
    const el = document.createElement("div");
    el.className = `toast${error ? " error" : ""}`;
    el.innerHTML = `${icon(error ? "CircleAlert" : "CircleCheck", error ? "error-text" : "success-text")}<span>${esc(message)}</span>${ibtn("关闭提示", "dismiss-toast", "X")}`;
    $("#toasts").append(el);
    if (!error) setTimeout(() => el.remove(), 4500);
  }
  let dialogTrigger;
  function openDialog(title, subtitle, body, foot = "", kind = "") {
    const dialog = $("#dialog");
    if (!dialog.open) dialogTrigger = document.activeElement;
    else dialog.close();
    dialog.className = kind;
    dialog.innerHTML = `<div class="dialog-head"><div><h2 id="dialog-title">${title}</h2><p class="sub">${subtitle}</p></div>${ibtn("关闭弹窗", "close-dialog", "X")}</div><div class="dialog-body">${body}</div>${foot ? `<div class="dialog-foot">${foot}</div>` : ""}`;
    dialog.showModal();
    const input = $("input:not([type=hidden]), textarea, select", dialog);
    (input || $(".dialog-head button", dialog)).focus();
  }
  $("#dialog").addEventListener("close", () => {
    if (dialogTrigger?.isConnected) dialogTrigger.focus();
    else $("#page-title")?.focus({ preventScroll: true });
  });
  function render() {
    const focused = document.activeElement;
    const focusId = focused?.id;
    const focusAction = focused?.dataset.action;
    const focusSelector = focusAction ? ['action','id','index','attempt','direction'].filter(key=>focused.dataset[key]!==undefined).map(key=>`[data-${key}="${CSS.escape(focused.dataset[key])}"]`).join('') : '';
    const page = state.page;
    $("#main-nav").innerHTML = Object.entries(pages).map(([key, [title, glyph, num]]) => `<a class="nav-link" href="#${key}" title="${title}" ${page === key ? 'aria-current="page"' : ""}>${icon(glyph)}<span class="nav-label">${title}</span><small>${num}</small></a>`).join("");
    $("#breadcrumb-title").textContent = pages[page][0];
    $("#sample-state").innerHTML = modes[page].map(([value, label]) => `<option value="${value}" ${state.mode[page] === value ? "selected" : ""}>${label}</option>`).join("");
    $("#main").innerHTML = ({ components: renderComponents, targets: renderTargets, studio: renderStudio, run: renderRun })[page]();
    if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus({ preventScroll: true });
    else if (focusSelector) $(focusSelector)?.focus({ preventScroll: true });
  }
  function renderComponents() {
    const error = state.mode.components === "error", loading = state.mode.components === "loading";
    return shellHeading("01", "让每一次操作，都有清楚的回应", "用真实交互检验颜色、层次与节奏。点击按钮、编辑表单，感受完整状态。", btn("保存示例", "bench-save", "Check", "primary busy-width", 'id="bench-save"')) +
      (error ? `<div class="stack" style="margin-bottom:18px">${notice("error", "保存未完成", "当前修改仍保留在页面中，可以重试。", btn("重试", "bench-retry", "RotateCcw", "small"))}</div>` : "") +
      `<div class="bench-grid">
        <section class="panel"><div class="panel-head"><div><h2>操作与反馈</h2><p class="sub">一个主操作，其余按任务层级展开</p></div>${badge("可交互", "info")}</div>
          <div class="bench-group"><div class="bench-label"><h3>按钮的轻重</h3><span>ACTIONS</span></div><div class="control-sample">
            ${btn("配置策略", "bench-policy", "Settings2", "secondary")}
            ${btn("查看详情", "bench-drawer", "Eye")}
            ${btn("AI 建议", "ai-suggestion", "Sparkles", "ai")}
            ${btn("取消", "bench-cancel", "", "ghost")}
            ${btn("已停用", "noop", "", "", "disabled")}
          </div><p class="sub" style="margin-top:13px">移入、按下和键盘聚焦都有反馈；加载时保持按钮宽度。</p></div>
          <div class="bench-group"><div class="bench-label"><h3>状态各司其职</h3><span>SEMANTICS</span></div><div class="control-sample">
            ${badge("执行成功", "success", "CircleCheck")}${badge("执行中", "info", "LoaderCircle")}${badge("队列等待", "", "Clock3")}${badge("执行失败", "error", "CircleAlert")}${badge("需要核查", "warning", "CircleAlert")}${badge("证据不完整", "warning", "Camera")}${badge("已取消")}${badge("AI 建议草稿", "ai", "Sparkles")}
          </div></div>
          <div class="bench-group"><div class="bench-label"><h3>按任务选择容器</h3><span>OVERLAYS</span></div><div class="row wrap">
            ${btn("新建弹窗", "new-target", "Plus")}${btn("详情侧栏", "bench-drawer", "PanelLeftOpen")}${btn("错误反馈", "bench-error", "CircleAlert")}
            <details class="mini-menu"><summary class="button" aria-label="更多示例操作">${icon("MoreHorizontal")} 更多</summary><div class="menu-content">${btn("重置示例表单", "reset-bench", "RotateCcw")}${btn("移除示例关联", "remove-demo", "X", "error-text")}</div></details>
          </div></div>
        </section>
        <section class="panel"><div class="panel-head"><div><h2>表单与选择</h2><p class="sub">默认清楚，错误就近解释</p></div>${icon("TextCursorInput")}</div>
          <form id="bench-form" class="bench-group"><div class="form-grid">
            ${field("bench-name", "场景名称", state.bench.name, 'required maxlength="60"')}
            <div class="field"><label for="bench-env">运行环境</label><select id="bench-env">${["测试环境","预发环境"].map(env=>`<option ${state.bench.env===env?"selected":""}>${env}</option>`).join("")}</select></div>
            <div class="field full"><label for="bench-url">目标入口</label><input id="bench-url" type="url" required value="${esc(state.bench.url)}" aria-describedby="url-help url-error"><p class="hint" id="url-help">输入包含 https:// 的完整地址。</p><p id="url-error" class="field-error"></p></div>
            ${field("bench-version", "当前版本 · 只读", "v1.8", "readonly")}
            ${field("bench-locked", "发布人 · 无编辑权限", "林知远", "disabled")}
          </div><hr class="divider"><div class="row between wrap"><label class="check-row"><input type="checkbox" class="switch" id="retain-evidence" role="switch" ${state.bench.retain?"checked":""}> 失败时保留完整证据</label><label class="check-row"><input type="checkbox" id="notify-owner" ${state.bench.notify?"checked":""}> 通知负责人</label></div></form>
        </section>
        <section class="panel"><div class="panel-head"><div><h2>内容的层次</h2><p class="sub">可点击的卡片有反馈，纯信息保持稳定</p></div>${icon("Layers")}</div><div class="bench-group"><div class="sample-cards">
          <button class="interactive-card" data-action="bench-drawer"><div class="row between"><span class="large-icon">${icon("Monitor")}</span>${icon("ArrowUpRight")}</div><h3>采购管理系统</h3><p class="sub" style="margin-top:5px">12 个场景 · 2 个目标账号</p><div style="margin-top:14px">${badge("健康", "success", "CircleCheck")}</div></button>
          <div class="sample-static"><div class="eyebrow">本次运行</div><div class="metric">6<small>/ 6 步骤成功</small></div><hr class="divider"><div class="row between"><span class="sub">证据完整性</span>${badge("完整", "success")}</div><p class="sub" style="margin-top:10px">执行结果与证据采集分别呈现。</p></div>
        </div></div></section>
        <section class="panel"><div class="panel-head"><div><h2>加载与渐进展开</h2><p class="sub">等待有边界，更多信息在需要时出现</p></div>${icon("Clock3")}</div><div class="bench-group">
          ${loading ? `<div aria-busy="true" aria-label="示例加载中"><div class="skeleton" style="width:55%"></div><div class="spacer"></div><div class="skeleton"></div><div class="spacer"></div><div class="skeleton" style="width:78%"></div></div>` : notice("success", "修改已自动保留在草稿", "发布前仍可检查每一个步骤与断言。")}
          <details class="details-disclosure" style="margin-top:20px"><summary>查看证据保留策略</summary><dl class="kv"><dt>成功运行</dt><dd>步骤结果 + 按需截图</dd><dt>失败与重试</dt><dd>截图 + Trace + 错误上下文</dd><dt>保留期限</dt><dd>遵循目标系统策略</dd></dl></details>
        </div></section>
      </div>
      <section class="panel demo-strip"><div class="grow"><h3>颜色是业务语言的一部分</h3><p>同一颜色在页面、控件和状态里保持同一含义。</p></div><div class="swatches" style="flex:2">
        ${[["操作","#245ce5","发起与选中"],["成功","#08795f","健康与完成"],["警告","#925900","待处理"],["失败","#bd293b","错误与危险"],["AI","#6444d4","辅助与推理"],["辅助","#607087","等待与说明"]].map(([title,c,sub])=>`<div><div class="swatch" style="background:${c}"></div><p>${title}</p><small>${sub}</small></div>`).join("")}
      </div></section>`;
  }
  const healthBadge = t => t.health === "success" ? badge("健康","success","CircleCheck") : t.health === "warning" ? badge("待认证","warning","LockKeyhole") : badge("未验证","","Clock3");
  function targetTable() {
    const list = state.targets.filter(t => `${t.name} ${t.host}`.toLowerCase().includes(state.search.toLowerCase()) && (!state.env || t.env === state.env) && (!state.health || t.health === state.health));
    return `<div class="table-scroll"><table class="target-table"><thead><tr><th>目标系统</th><th>环境</th><th>状态</th><th>场景</th></tr></thead><tbody>${list.map(t=>`<tr class="target-row ${state.target===t.id?"selected":""}"><td><div class="target-identity"><span class="target-icon">${icon("Monitor")}</span><div><button class="target-link" data-action="select-target" data-id="${esc(t.id)}" aria-pressed="${state.target===t.id}">${esc(t.name)}</button><p class="sub">${esc(t.host)}</p></div></div></td><td>${badge(t.env)}</td><td>${healthBadge(t)}</td><td class="mono">${t.scenarioCount}</td></tr>`).join("")}</tbody></table>${!list.length?`<div class="empty"><h2>没有匹配的目标系统</h2><p>调整关键词或筛选条件。</p>${btn("清空筛选","reset-filters","RotateCcw")}</div>`:""}</div><div class="panel-foot row between"><span>共 ${list.length} 个目标系统</span><span>选中行可查看账号与会话</span></div>`;
  }
  function targetDetail() {
    const t = targetNow();
    return `<section class="panel target-detail"><div class="panel-pad"><div class="detail-title"><span class="target-icon">${icon("Monitor")}</span><div class="grow"><h2>${esc(t.name)}</h2><p class="sub">${esc(t.host)}</p></div></div><div class="tagline">${healthBadge(t)}${badge(t.env+"环境")}</div><hr class="divider"><div class="detail-columns"><div><dl class="kv"><dt>目标标识</dt><dd class="mono">${esc(t.id)}</dd><dt>入口地址</dt><dd>https://${esc(t.host)}</dd><dt>会话策略</dt><dd>健康会话优先复用</dd><dt>并发约束</dt><dd>每个目标账号独占租约</dd></dl><div style="margin-top:18px">${notice(t.health === "warning" ? "warning" : "", t.health === "warning" ? "目标账号需要重新认证" : "会话与运行分别管理", t.health === "warning" ? "认证完成后，等待中的运行才可获得执行租约。" : "一次运行结束后，健康认证状态可供下一次运行复用。")}</div></div><div><div class="row between" style="margin:22px 0 4px"><h3>目标账号 <span class="muted">${t.accounts.length}</span></h3>${btn("添加","add-account","Plus","small ghost")}</div><p class="sub" style="font-size:10px">用于登录此业务系统，与控制台成员分开。</p>${t.accounts.map(a=>`<div class="account-row"><span class="avatar">${icon("LockKeyhole")}</span><div class="grow"><strong style="font-size:11px">${esc(a.name)}</strong><p class="sub mono">${esc(a.login)}</p></div>${badge(a.auth?"已认证":"待认证",a.auth?"success":"warning")}</div>`).join("") || `<div class="empty" style="padding:26px 10px"><p>添加账号后配置目标认证。</p></div>`}</div></div></div><div class="panel-foot row between"><span>${t.scenarioCount} 个关联场景</span>${btn("打开场景编排","open-target-studio","ArrowUpRight","small ghost")}</div></section>`;
  }
  function renderTargets() {
    const mode = state.mode.targets;
    const count = state.targets.length;
    let content;
    if (["empty","loading","error","forbidden"].includes(mode)) {
      content = `<section class="panel">${mode==="loading"?`<div class="panel-head"><h2>正在读取目标系统</h2>${badge("加载中","info","LoaderCircle")}</div><div aria-busy="true">${[1,2,3,4].map(()=>`<div class="skeleton-row"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>`).join("")}</div><div class="panel-foot">可在上方“样本”中切换到已加载状态。</div>`:`<div class="empty"><div class="large-icon">${icon(mode==="forbidden"?"LockKeyhole":mode==="error"?"CircleAlert":"Monitor")}</div><h2>${mode==="empty"?"接入第一个目标系统":mode==="error"?"暂时无法加载目标系统":"当前角色没有管理权限"}</h2><p>${mode==="empty"?"先定义系统身份与入口，再创建账号和场景。":mode==="error"?"筛选条件仍然保留，可重试加载。":"请联系工作区管理员调整目标系统管理权限。"}</p>${mode==="empty"?btn("接入目标系统","new-target","Plus"):mode==="error"?btn("重新加载","retry-targets","RotateCcw"):""}</div>`}</section>`;
    } else content = `<div class="target-layout"><section class="panel"><div class="panel-head"><div><h2>所有目标系统</h2><p class="sub">系统身份、账号与场景的共同边界</p></div>${badge(count+" 个")}</div><div class="toolbar"><div class="search-field">${icon("Search")}<input id="target-search" aria-label="搜索目标系统" placeholder="搜索名称或入口…" value="${esc(state.search)}"></div><select id="target-env" aria-label="筛选环境"><option value="">所有环境</option>${["测试","预发","开发"].map(e=>`<option ${state.env===e?"selected":""}>${e}</option>`).join("")}</select><select id="target-health" aria-label="筛选状态"><option value="">所有状态</option><option value="success" ${state.health==="success"?"selected":""}>健康</option><option value="warning" ${state.health==="warning"?"selected":""}>待认证</option><option value="neutral" ${state.health==="neutral"?"selected":""}>未验证</option></select></div><div id="target-table">${targetTable()}</div></section><div id="target-detail">${targetDetail()}</div></div>`;
    return shellHeading("02", "目标系统", "从真实业务系统出发，组织账号、场景与每一次运行。", btn("接入目标系统","new-target","Plus","primary",mode==="forbidden"?"disabled":""))+
      `<div class="metrics">${[
        ["已接入系统",mode==="empty"?"0":count,"跨环境统一管理","Monitor"],
        ["健康可用",mode==="empty"?"0":state.targets.filter(t=>t.health==="success").length,"入口与认证状态正常","CircleCheck"],
        ["需要处理",mode==="empty"?"0":state.targets.filter(t=>t.health==="warning").length,"目标账号等待认证","CircleAlert"],
        ["关联场景",mode==="empty"?"0":state.targets.reduce((n,t)=>n+t.scenarioCount,0),"顺序步骤可检查、可编辑","ListChecks"]
      ].map(([l,v,h,i])=>`<div class="panel metric-box"><div class="row"><span>${l}</span>${icon(i)}</div><div class="metric">${v}</div><p class="sub">${h}</p></div>`).join("")}</div>`+content;
  }
  function renderStudio() {
    const readonly = state.mode.studio === "readonly";
    const target = state.studioTarget;
    const step = state.steps.find(s=>s.id===state.selectedStep) || state.steps[0];
    const ai = step.kind.startsWith("ai");
    const disabled = readonly ? "disabled" : "";
    const trialDisabled = !target || readonly || state.trialRunning || !validSteps();
    return shellHeading("03","采购订单审批巡检",`<span class="row wrap">${badge("草稿")}<span>已发布 v1.8</span><span>·</span><span id="save-status">${state.dirty?"有未保存修改":state.saved?"草稿已保存":"所有修改已保存"}</span></span>`,
      btn("AI 辅助","ai-suggestion","Sparkles","ai",disabled)+btn("保存草稿","save-draft","Check","busy-width",`id="save-draft" ${disabled}`)+btn(state.trialRunning?"试跑中…":"模拟试跑","trial","Play","primary",trialDisabled?"disabled":""))+
      `<div class="panel context-strip"><label for="studio-target" class="row">${icon("Monitor")}目标系统</label><select id="studio-target" ${disabled}><option value="">选择目标系统</option>${state.targets.map(t=>`<option value="${esc(t.id)}" ${target===t.id?"selected":""}>${esc(t.name)}</option>`).join("")}</select><span class="context-sep"></span><span class="row">${icon("LockKeyhole")} ${esc(state.targets.find(t=>t.id===target)?.accounts[0]?.name || "暂无目标账号")}</span><span class="grow"></span><span class="muted">顺序执行 · ${state.steps.length} 个步骤</span></div>
      ${!target?`<div style="margin-bottom:16px">${notice("warning","先绑定目标系统","场景需要明确系统边界，绑定前不能运行。")}</div>`:""}
      ${readonly?`<div style="margin-bottom:16px">${notice("","当前为只读权限","可以检查步骤与输入输出，编辑和试跑不可用。")}</div>`:""}
      <div class="studio-layout">
        <aside class="panel studio-library" aria-label="步骤库"><h2>步骤库</h2><p class="sub" style="padding:0 6px;font-size:10px">点击添加到序列末尾</p><p class="library-label">确定性步骤</p>${Object.entries(kinds).filter(([k])=>!k.startsWith("ai")).map(([k,[label,,glyph]])=>`<button class="library-item" data-action="add-step" data-kind="${k}" ${disabled}>${icon(glyph)}${label}${icon("Plus")}</button>`).join("")}<p class="library-label">AI 步骤</p>${Object.entries(kinds).filter(([k])=>k.startsWith("ai")).map(([k,[label,,glyph]])=>`<button class="library-item ai" data-action="add-step" data-kind="${k}" ${disabled}>${icon(glyph)}${label}${icon("Plus")}</button>`).join("")}<hr class="divider"><p class="sub" style="padding:0 6px;font-size:10px">AI 与确定性步骤共享同一执行序列。</p></aside>
        <section class="panel"><div class="panel-head"><div><h2>执行序列</h2><p class="sub">从上到下，逐步完成业务意图</p></div>${btn("添加","add-step-menu","Plus","small ghost",disabled)}</div><div class="step-list">${state.steps.map((s,i)=>`<div class="step-row"><span class="step-number">${String(i+1).padStart(2,"0")}</span><button class="step-select" data-action="select-step" data-id="${s.id}" aria-pressed="${s.id===step.id}"><span class="step-kind ${s.kind.startsWith("ai")?"ai":""}">${icon(kinds[s.kind][2])}</span><span class="grow"><strong>${esc(s.name || "未命名步骤")}</strong><small>${kinds[s.kind][1]}${s.kind==="aiExtract"?" · 输出 orderTotal":s.kind==="assert"?" · 引用 orderTotal.amount":""}</small></span>${icon("ChevronRight")}</button></div>`).join("")}</div><div class="sequence-foot">${icon("Database")}步骤输出通过显式变量供后续引用</div></section>
        <section class="panel studio-properties"><div class="panel-head"><div><h2>步骤属性</h2><p class="sub">${String(state.steps.indexOf(step)+1).padStart(2,"0")} · ${kinds[step.kind][1]}</p></div><div class="row" style="gap:2px">${ibtn("上移步骤","move-step","ArrowUp",`data-direction="-1" ${readonly||state.steps.indexOf(step)===0?"disabled":""}`)}${ibtn("下移步骤","move-step","ArrowDown",`data-direction="1" ${readonly||state.steps.indexOf(step)===state.steps.length-1?"disabled":""}`)}</div></div>
          <div class="properties">
            ${field("step-name","步骤名称",step.name,`required maxlength="80" ${disabled}`)}
            <div class="field"><label for="step-value">${ai?"业务意图":step.kind==="assert"?"断言表达式":step.kind==="navigate"?"目标内路径":"操作输入"}</label><textarea id="step-value" required ${disabled}>${esc(step.value)}</textarea><p class="hint">${ai?"每次运行重新理解当前页面，保留可检查的输入与输出契约。":"仅在编辑草稿中生效；历史运行使用各自的冻结快照。"}</p></div>
            ${step.kind==="aiExtract"?`<div><div class="row between"><h3>结构化输出</h3>${badge("只读提取","ai")}</div><dl class="output-grid"><dt>输出变量</dt><dd>orderTotal</dd><dt>amount</dt><dd>number</dd><dt>currency</dt><dd>string</dd></dl></div>`:""}
            <details class="details-disclosure full"><summary>执行策略</summary>${field("step-timeout","超时（秒）",step.timeout,`type="number" min="1" max="120" required ${disabled}`)}<p class="sub" style="margin-top:10px">重试仅适用于可以安全重复的步骤；副作用不明确时转人工核查。</p></details>
          </div>
        </section>
        <section class="panel trial-console"><div class="panel-head"><h2>试跑结果</h2><span class="sub">模拟运行与正式运行使用相同的信息结构</span></div><div id="trial-console-body">${trialConsole()}</div></section>
      </div>`;
  }
  function validSteps() { return state.steps.length > 0 && state.steps.every(s => s.name.trim() && s.value.trim() && s.timeout >= 1 && s.timeout <= 120); }
  function trialConsole() {
    if (state.trialRunning) return `<div class="console-body">${icon("LoaderCircle","spin trial-tag")}<div class="grow"><strong style="font-size:12px">正在模拟执行 · ${state.trialProgress} / ${state.trial.steps.length}</strong><p class="sub">使用启动时冻结的步骤副本</p><div class="trial-progress"><span style="width:${state.trialProgress/state.trial.steps.length*100}%"></span></div></div>${btn("停止","stop-trial","X","small")}</div>`;
    if (state.trial) return `<div class="console-body">${icon(state.trial.cancelled?"Clock3":"CircleCheck",state.trial.cancelled?"":"success-text")}<div class="grow"><strong style="font-size:12px">${state.trial.cancelled?"模拟试跑已取消":state.trial.steps.length+" 个步骤模拟成功"}</strong><p class="sub">快照 ${esc(state.trial.version)} · ${esc(state.trial.targetName)} · 只影响本地样本</p></div>${btn("查看运行复盘","open-trial","ArrowUpRight","small")}</div>`;
    return `<div class="console-body"><span class="large-icon" style="margin:0">${icon("FlaskConical")}</span><div class="grow"><strong style="font-size:12px">编辑完成后，验证一次完整序列</strong><p class="sub">试跑会冻结当前步骤。之后的草稿修改不会改变这次运行。</p></div>${badge("尚未试跑")}</div>`;
  }
  function runContext() {
    const mode = state.mode.run;
    const trial = mode==="trial" ? state.trial : null;
    const steps = clone(trial?.steps || initialSteps);
    if (mode==="review") { steps[2].name="提交采购订单"; steps[2].value='role=button[name="提交审批"]'; }
    let statuses = steps.map(()=>"success"), label="执行成功", tone="success", evidence="完整";
    if (mode==="failed") { statuses=steps.map((_,i)=>i<3?"success":i===3?"error":"pending");label="执行失败";tone="error"; }
    if (mode==="missing") evidence="不完整";
    if (mode==="auth") { statuses=steps.map(()=>"pending");label="等待认证";tone="warning"; evidence="尚未生成"; }
    if (mode==="review") { statuses=steps.map((_,i)=>i<2?"success":i===2?"warning":"pending"); label=state.reviewConclusion || "需要核查";tone=state.reviewConclusion==="已判定失败"?"error":state.reviewConclusion?"":"warning";evidence="部分可用"; }
    if (["offline","running"].includes(mode)) { statuses=steps.map((_,i)=>i<3?"success":i===3?"info":"pending");label=mode==="offline"?"执行中 · 缓存状态":"执行中";tone="info";evidence="部分可用"; }
    if (trial?.cancelled) { statuses=steps.map((_,i)=>i<state.trialProgress?"success":"pending");label="已取消";tone="";evidence="部分可用"; }
    if (trial && state.trialRunning) { statuses=steps.map((_,i)=>i<state.trialProgress?"success":i===state.trialProgress?"info":"pending");label="模拟执行中";tone="info";evidence="部分可用"; }
    return { mode, trial, steps, statuses, label, tone, evidence, version: trial?.version || "v1.8", targetName: trial?.targetName || "采购管理系统" };
  }
  function stepOutput(s) {
    if (s.kind==="aiExtract") return {amount:1280,currency:"CNY",orderNo:"PO-260913-018"};
    if (s.kind==="aiAssert") return {passed:true,reason:"页面审批状态为“已通过”"};
    if (s.kind==="assert") return {passed:true,actual:1280,condition:s.value};
    if (s.kind==="navigate") return {url:"https://procurement.example.test"+s.value};
    if (s.kind==="fill") return {input:"PO-260913-018",filled:true};
    return {completed:true,action:s.value};
  }
  function renderRun() {
    const c=runContext();
    state.runStep=Math.min(state.runStep,c.steps.length-1);
    const selected=c.steps[state.runStep], status=c.statuses[state.runStep];
    const hasRetry=c.mode==="retry" && state.runStep===3;
    if (!hasRetry) state.attempt=1;
    const attemptFailed=hasRetry && state.attempt===1;
    const noEvidence=status==="pending" || status==="info" || c.mode==="missing" || c.mode==="review";
    const outputReady=status==="success" && !attemptFailed;
    const ai=selected.kind.startsWith("ai");
    const actions=btn("查看快照","snapshot","LockKeyhole")+(c.mode==="review"&&!state.reviewConclusion?btn("记录核查结论","review-run","Check","primary"):c.mode==="auth"?btn("处理目标认证","auth-dialog","LockKeyhole","primary"):btn("返回场景","back-studio","ArrowUpRight"));
    return shellHeading("04",c.mode==="review"?"采购单提交验证":"采购订单审批巡检",`<span class="tagline">${badge(c.label,c.tone,c.tone==="error"?"CircleAlert":c.tone==="success"?"CircleCheck":"Clock3")}${badge("证据："+c.evidence,c.evidence==="完整"?"success":c.evidence==="尚未生成"?"":"warning","Camera")}<span class="mono">RUN-${c.trial?"LOCAL-001":"0913-018"} · ${c.version}</span></span>`,actions)+
      (c.mode==="trial"&&!c.trial?`<div style="margin-bottom:16px">${notice("","还没有本地试跑","当前显示内置成功样本；在场景编排页试跑后，这里会显示该次冻结快照。")}</div>`:"")+
      (c.mode==="offline"?`<div style="margin-bottom:16px">${notice("warning","实时连接中断，以下是最后一次同步状态","最后同步 10:42:18。运行可能仍在执行；重新连接后再确认最终结果。",btn("模拟重连","reconnect","RotateCcw","small"))}</div>`:"")+
      (c.mode==="auth"?`<div style="margin-bottom:16px">${notice("warning","采购测试员的认证状态已失效","运行尚未获得目标账号的执行租约，没有开始执行步骤。")}</div>`:"")+
      (c.mode==="review"?`<div style="margin-bottom:16px">${notice(state.reviewConclusion?"":"warning",state.reviewConclusion || "提交后连接中断，业务结果尚不明确",state.reviewConclusion?"该次模拟运行已结束，原始待核查事实继续保留。核查记录："+esc(state.reviewReason):"先核对目标订单是否已提交。当前运行不提供重试或继续执行。")}</div>`:"")+
      (c.mode==="missing"?`<div style="margin-bottom:16px">${notice("warning","业务执行成功，截图采集不完整","对象上传超时。步骤结果和结构化输出仍可复盘；不会为补截图重放业务操作。")}</div>`:"")+
      `<div class="panel run-summary"><div><p class="sub">目标系统 / 目标账号</p><strong>${esc(c.targetName)}</strong><p class="sub" style="margin:4px 0 0">${esc(c.trial?.accountName || "采购测试员")} · ${esc(c.trial?.env || "测试")}环境</p></div><div><p class="sub">步骤完成</p><strong>${c.statuses.filter(s=>s==="success").length} / ${c.steps.length}</strong><p class="sub" style="margin:4px 0 0">${c.mode==="retry"?"1 次额外尝试 · 未改变最终成功":c.mode==="auth"?"尚未执行":"按冻结顺序执行"}</p></div><div><p class="sub">浏览器会话</p><strong>${c.mode==="auth"?"等待认证":"复用已有会话"}</strong><p class="sub" style="margin:4px 0 0">${c.mode==="auth"?"尚无有效 Lease":"Session 与本次 Run 独立"}</p></div><div><p class="sub">执行定义</p><strong>${c.version} · 启动时已冻结</strong><p class="sub" style="margin:4px 0 0">${c.trial?"本地模拟快照":"2026-09-13 10:42:06"}</p></div></div>
      <div class="run-layout">
        <section class="panel"><div class="panel-head"><h2>执行步骤</h2>${badge(c.steps.length+" steps")}</div><div class="run-steps-list">${c.steps.map((s,i)=>{const st=statusInfo[c.statuses[i]];return `<button class="run-step ${st[1]}" data-action="run-step" data-index="${i}" aria-pressed="${i===state.runStep}"><span class="step-index">${String(i+1).padStart(2,"0")}</span>${icon(st[2])}<span class="grow"><strong>${esc(s.name)}</strong><small>${kinds[s.kind][1]} · ${st[0]}${c.mode==="retry"&&i===3?" · 2 次尝试":""}</small></span></button>`;}).join("")}</div><div class="panel-foot">${icon("LockKeyhole")} 此处读取该次运行的快照</div></section>
        <section class="panel"><div class="panel-head"><div><h2>${esc(selected.name)}</h2><p class="sub">StepRun ${String(state.runStep+1).padStart(2,"0")} · ${statusInfo[status][0]}</p></div>${badge(kinds[selected.kind][1],ai?"ai":"")}</div>
          <div class="attempt-tabs" role="group" aria-label="实际尝试">${status==="pending"?badge("尚无 Attempt"):Array.from({length:hasRetry?2:1},(_,i)=>`<button class="attempt-tab" data-action="attempt" data-attempt="${i+1}" aria-pressed="${state.attempt===i+1}">Attempt ${i+1}${badge(hasRetry&&i===0?"超时":statusInfo[status][0],hasRetry&&i===0?"error":statusInfo[status][1])}</button>`).join("")}</div>
          <div class="attempt-meta"><span>${status==="pending"?"步骤未开始":`关联：Run / StepRun ${state.runStep+1} / Attempt ${state.attempt}`}</span><span>${hasRetry&&state.attempt===1?"耗时 30.0s":status==="pending"?"—":"耗时 1.8s · 示例"}</span></div>
          <div class="evidence-area">
            ${attemptFailed?notice("error","第一次尝试超时","页面数据尚未稳定，AI 提取在 30 秒内未返回。此失败只属于 Attempt 1。"):c.mode==="failed"&&state.runStep===3?notice("error","重试策略已耗尽","本步骤最终失败，后续步骤未执行。已保留错误与最后页面证据。"):hasRetry?`<div style="margin-bottom:14px">${notice("success","第二次尝试成功","提取是只读操作，允许安全重试；StepRun 最终结果为成功。")}</div>`:""}
            ${noEvidence?`<div class="empty" style="padding:43px 15px"><div class="large-icon">${icon("Camera")}</div><h2>${c.mode==="missing"?"截图不可用":c.mode==="review"?"提交结果缺少确认":"暂无页面证据"}</h2><p>${c.mode==="missing"?"上传超时 · EVIDENCE_UPLOAD_TIMEOUT":c.mode==="review"?"保留了提交前输入，尚无足够证据证明业务完成。":status==="pending"?"步骤开始并产生 Attempt 后，证据会显示在这里。":"最后同步时，该步骤仍在执行中。"}</p></div>`:browserEvidence(selected,attemptFailed)}
            <div class="evidence-caption"><span>页面证据 · ${noEvidence?"未生成或缺失":"示例订单页"}<br>示意画面，不是真实目标截图</span>${!noEvidence?btn("放大查看","zoom-evidence","Maximize2","small ghost"):""}</div>
          </div><div class="artifact-row">${icon("Database")}<div class="grow"><strong>步骤输入 / 输出</strong><p class="sub" style="font-size:10px">${outputReady?"结构化结果可查看与复制":"保留输入与错误，不伪造成功输出"}</p></div>${btn("查看","step-data","Eye","small ghost")}</div><div class="artifact-row">${icon("Clock3")}<div class="grow"><strong>运行事件</strong><p class="sub" style="font-size:10px">查看与当前步骤相关的状态变化</p></div>${btn("展开","run-events","ChevronRight","small ghost")}</div>
        </section>
        <aside class="panel run-output"><div class="output-section"><div class="row between"><h3 style="margin:0">结构化输出</h3>${ibtn("复制当前输出","copy-output","Copy",outputReady?"":"disabled")}</div><div class="spacer"></div>${outputReady?`<dl class="output-grid">${Object.entries(stepOutput(selected)).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`:`<p class="sub">${attemptFailed?"本次尝试未产生有效输出。":"此状态下暂无成功输出。"}</p>`}</div>
          <div class="output-section"><h3>断言与业务判断</h3>${c.steps.filter(s=>s.kind.toLowerCase().includes("assert")).map(s=>{const ok=c.statuses[c.steps.indexOf(s)]==="success";return `<div class="assertion">${icon(ok?"CircleCheck":"Clock3",ok?"":"muted")}<div><strong>${esc(s.name)}</strong><p class="sub" style="font-size:10px">${ok?"已通过": "尚未完成"}${s.kind==="aiAssert"?" · AI Assert":""}</p></div></div>`;}).join("")}</div>
          <div class="output-section"><div class="row between"><h3 style="margin:0">${ai?"AI 执行摘要":"执行说明"}</h3>${ai?badge("AI","ai","Sparkles"):""}</div><div class="spacer"></div><p class="audit-note">${ai?(outputReady?"基于当前页面的订单区域读取数据；保留输出字段、模型路由及判断依据。":attemptFailed?"模型调用在超时窗口内未返回有效结果。":"业务意图与输出契约已冻结，实际执行信息以对应 Attempt 为准。"):"确定性步骤按冻结输入执行，页面状态由共享浏览器会话延续。"}</p><hr class="divider"><dl class="kv" style="grid-template-columns:70px 1fr"><dt>执行器</dt><dd>${ai?"AI Executor / 示例":"RPA Executor"}</dd><dt>${ai?"模型路由":"策略版本"}</dt><dd class="mono">${ai?"vision-balanced":"policy-1.2"}</dd><dt>来源</dt><dd>Run Snapshot</dd></dl></div></aside>
      </div><section class="panel run-bottom"><span class="row">${icon("ShieldCheck")} 运行快照解释当时的执行，证据记录实际发生的事。</span>${btn("查看冻结快照","snapshot","LockKeyhole","small ghost")}</section>`;
  }
  function browserEvidence(step, failed=false) {
    return `<div class="browser-preview"><div class="browser-chrome"><span></span><span></span><span></span><div class="address">procurement.example.test / orders / PO-260913-018</div>${icon("LockKeyhole")}</div><div class="mock-business"><div class="mock-brand"><span>PROCUREMENT / 采购协作</span><span>测试环境</span></div><div class="row between"><h3>采购订单详情</h3>${badge(failed?"数据加载中":"审批已通过",failed?"":"success")}</div><p class="mock-meta">PO-260913-018 · 办公设备采购 · 2026-09-13</p><div class="mock-order ${step.kind==="aiExtract"&&!failed?"highlight":""}"><div class="row between"><span class="mock-label">订单含税总额</span><span class="mock-label">人民币 CNY</span></div><div class="mock-amount">${failed?"—":"¥ 1,280.00"}</div><div class="row between"><span class="mock-label">采购部门 · 产品研发部</span><span class="mock-label">申请人 · 林**</span></div></div><div class="row between" style="font-size:9px;color:#647388;margin-top:18px"><span>审批记录</span><span>${failed?"正在加载":"部门审批完成 · 10:41"}</span></div></div></div>`;
  }
  function newTargetDialog() {
    openDialog("接入目标系统","定义业务系统的身份与入口；本原型只保存模拟数据。",
      `<form id="target-form">${field("target-name","系统名称","","name=\"name\" required maxlength=\"60\" placeholder=\"例如：采购管理系统\"")}<div class="field"><label for="target-url">系统入口</label><input id="target-url" name="url" type="url" required placeholder="https://procurement.example.test"><p class="hint">只接受 http:// 或 https:// 地址。</p></div><div class="field"><label for="new-target-env">环境</label><select id="new-target-env" name="env"><option>测试</option><option>预发</option><option>开发</option></select></div><div id="target-form-error" class="field-error" role="alert"></div></form>`,
      btn("取消","close-dialog")+`<button class="button primary" type="submit" form="target-form">${icon("Plus")}接入系统</button>`);
  }
  function addAccountDialog() {
    openDialog("添加目标账号",`${esc(targetNow().name)} · 用于登录目标业务系统`,
      notice("","账号身份独立","此账号不是识途控制台成员。此处只演示凭据引用，不收集口令。")+
      `<form id="account-form">${field("account-name","账号显示名称","","name=\"name\" required maxlength=\"60\" placeholder=\"例如：审批测试员\"")}${field("account-login","目标登录标识","","name=\"login\" required maxlength=\"80\" placeholder=\"qa_approver\"")}${field("account-secret","凭据引用（示例）","secret://demo/approval","name=\"secret\" required maxlength=\"120\"","仅保存引用；不填入真实密码或密钥。")}</form>`,
      btn("取消","close-dialog")+`<button class="button primary" type="submit" form="account-form">${icon("Plus")}添加账号</button>`,"drawer");
  }
  function aiDialog() {
    openDialog("检查 AI 建议","建议先进入可编辑草稿，由你决定是否接受。",
      notice("ai","建议补充一项业务判断","在现有步骤之后，确认订单供应商与采购主体一致。")+
      `<div class="panel panel-pad"><div class="row between"><h3>核验供应商信息</h3>${badge("AI Assert","ai")}</div><p class="sub" style="margin-top:13px">读取订单中的供应商名称，判断其是否与预期供应商一致。输出 passed、reason。</p><hr class="divider"><div class="row between"><span class="sub">变更范围</span><strong style="font-size:12px">追加 1 个步骤</strong></div></div><p class="sub" style="margin-top:15px">接受后仍可修改业务意图，不影响已发布版本与历史 Run。</p>`,
      btn("暂不采用","close-dialog")+btn("接受到草稿","accept-ai","Check","primary",state.mode.studio==="readonly"?"disabled":""));
  }
  function snapshotDialog() {
    const c=runContext();
    openDialog("运行冻结快照",`${c.version} · 仅供读取，与当前草稿分别保存`,
      `<div class="row wrap" style="margin-bottom:18px"><span class="snapshot-label">Target：${esc(c.targetName)}</span><span class="snapshot-label">${c.steps.length} 个步骤</span>${badge("不可变副本","","LockKeyhole")}</div><pre id="snapshot-json">${esc(JSON.stringify({version:c.version,target:c.trial?.target||"procurement",targetAccount:c.trial?.accountName||"采购测试员",steps:c.steps},null,2))}</pre>`,btn("关闭","close-dialog"),"wide");
  }
  function startTrial() {
    if (state.mode.studio==="readonly" || !state.studioTarget || !validSteps() || state.trialRunning) return;
    const boundTarget=state.targets.find(t=>t.id===state.studioTarget);
    state.trial={accountName:boundTarget.accounts[0]?.name || "未指定目标账号",env:boundTarget.env,steps:clone(state.steps),version:"draft-"+new Date().toLocaleTimeString("en-GB").replaceAll(":",""),target:state.studioTarget,targetName:state.targets.find(t=>t.id===state.studioTarget).name,cancelled:false};
    state.trialRunning=true;state.trialProgress=0;const epoch=++state.trialEpoch;render();
    function tick() {
      if (state.trialEpoch!==epoch || !state.trialRunning) return;
      state.trialProgress++;
      if (state.trialProgress>=state.trial.steps.length) {state.trialRunning=false;toast("模拟试跑完成，已保留启动时的快照");}
      if (state.page==="studio") {
        if (!state.trialRunning) render();
        else $("#trial-console-body").innerHTML=trialConsole();
      } else if(state.page==="run" && state.mode.run==="trial") render();
      if (state.trialRunning) setTimeout(tick,350);
    }
    setTimeout(tick,350);
  }
  function saveDraft(button) {
    if (!validSteps()) {toast("请补齐步骤名称、输入和 1–120 秒超时",true);return;}
    if (state.mode.studio==="readonly") return;
    button.disabled=true;button.innerHTML=icon("LoaderCircle","spin")+"保存中…";
    const savedSteps=JSON.stringify(state.steps);
    setTimeout(()=>{
      state.saved=true;state.dirty=JSON.stringify(state.steps)!==savedSteps;
      if(state.page==="studio")render();toast(state.dirty?"当前修改发生在保存之后，请再次保存":"草稿已保存（本地模拟）");
    },750);
  }
  function goto(page) {if (location.hash==="#"+page) {state.page=page;render();} else location.hash=page;}
  async function copyText(value) {
    try {await navigator.clipboard.writeText(value);toast("当前步骤输出已复制");}
    catch {openDialog("复制结构化输出","浏览器未开放剪贴板权限，可选中文本后手动复制。",`<textarea id="copy-manual" style="width:100%;height:200px" readonly>${esc(value)}</textarea>`,btn("关闭","close-dialog"));$("#copy-manual").select();}
  }
  document.addEventListener("click", event=>{
    const choice=event.target.closest("[data-theme-choice]");
    if(choice){document.documentElement.dataset.theme=choice.dataset.themeChoice;document.querySelectorAll("[data-theme-choice]").forEach(b=>b.setAttribute("aria-pressed",String(b===choice)));return;}
    const b=event.target.closest("[data-action]");
    if(!b || b.disabled)return;
    const action=b.dataset.action;
    if(action!=="noop") document.querySelectorAll(".mini-menu[open]").forEach(m=>m.removeAttribute("open"));
    if(action==="close-dialog")$("#dialog").close();
    else if(action==="dismiss-toast")b.closest(".toast").remove();
    else if(action==="new-target")newTargetDialog();
    else if(action==="add-account")addAccountDialog();
    else if(action==="select-target"){state.target=b.dataset.id;$("#target-table").innerHTML=targetTable();$("#target-detail").innerHTML=targetDetail();$(`[data-action="select-target"][data-id="${CSS.escape(state.target)}"]`).focus({preventScroll:true});}
    else if(action==="reset-filters"){state.search="";state.env="";state.health="";render();}
    else if(action==="retry-targets"){state.mode.targets="normal";render();toast("示例目标系统已重新加载");}
    else if(action==="bench-error"){state.mode.components="error";render();toast("模拟保存失败，修改仍保留",true);}
    else if(action==="bench-retry"){state.mode.components="normal";render();toast("重试成功，示例已保存");}
    else if(action==="bench-cancel"){toast("已取消当前示例操作");}
    else if(action==="reset-bench"){state.mode.components="normal";state.bench={name:"采购订单审批巡检",url:"https://procurement.example.test",env:"测试环境",retain:true,notify:true};render();toast("示例表单已重置");}
    else if(action==="bench-save"){
      const input=$("#bench-url");validateUrl(input);
      if(!$("#bench-form").reportValidity())return;
      b.disabled=true;b.innerHTML=icon("LoaderCircle","spin")+"保存中…";
      const error=state.mode.components==="error";
      setTimeout(()=>{if(b.isConnected){b.disabled=false;b.innerHTML=icon("Check")+"保存示例";}toast(error?"保存失败，当前表单内容仍保留":"示例表单已保存",error);},900);
    }
    else if(action==="bench-policy")openDialog("证据策略","按业务结果决定保留范围。",`<div class="stack">${["成功时保留步骤结果","失败或重试时保留截图与 Trace","所有成功运行保留完整 Trace"].map((label,i)=>`<label class="check-row"><input type="checkbox" data-policy="${i}" ${state.policy[i]?"checked":""}> ${label}</label>`).join("")}</div>`,btn("取消","close-dialog")+btn("保存策略","save-policy","Check","primary"));
    else if(action==="save-policy"){state.policy=[...document.querySelectorAll("[data-policy]")].map(input=>input.checked);$("#dialog").close();toast("证据策略已保存（示例）");}
    else if(action==="bench-drawer")openDialog("采购管理系统","目标详情 · 从当前任务侧边查看",`<div class="row wrap">${badge("健康","success","CircleCheck")}${badge("测试环境")}</div><div class="spacer"></div><dl class="kv"><dt>目标身份</dt><dd>采购管理系统</dd><dt>场景数量</dt><dd>12 个</dd><dt>目标账号</dt><dd>采购测试员、审批测试员</dd><dt>会话策略</dt><dd>优先复用已认证会话</dd></dl><hr class="divider">${notice("","当前任务保持原位","关闭侧栏后，焦点会回到刚才的入口。")}`,btn("关闭","close-dialog")+btn("查看目标系统","drawer-targets","ArrowUpRight","primary"),"drawer");
    else if(action==="drawer-targets"){$("#dialog").close();goto("targets");}
    else if(action==="remove-demo")openDialog("移除示例关联？","仅影响评审台里的提示示例。",notice("warning","这是一项需要明确确认的操作","使用动词说明后果，保留安全取消入口。"),btn("取消","close-dialog")+btn("移除关联","confirm-remove","X","danger"));
    else if(action==="confirm-remove"){$("#dialog").close();toast("示例关联已移除");}
    else if(action==="open-target-studio"){state.studioTarget=state.target;state.mode.studio="normal";goto("studio");}
    else if(action==="select-step"){state.selectedStep=Number(b.dataset.id);render();}
    else if(action==="move-step"){
      const i=state.steps.findIndex(s=>s.id===state.selectedStep),j=i+Number(b.dataset.direction);
      if(j>=0&&j<state.steps.length){[state.steps[i],state.steps[j]]=[state.steps[j],state.steps[i]];state.dirty=true;render();}
    }
    else if(action==="add-step")addStep(b.dataset.kind);
    else if(action==="add-step-menu")openDialog("添加步骤","选择语义明确的最小执行单元。",`<div class="stack">${Object.entries(kinds).map(([k,[label,,glyph]])=>btn(label,"add-step",glyph,k.startsWith("ai")?"ai":"",`data-kind="${k}"`)).join("")}</div>`,btn("取消","close-dialog"));
    else if(action==="ai-suggestion")aiDialog();
    else if(action==="accept-ai"){
      if(state.mode.studio==="readonly")return;
      state.steps.push({id:state.nextStepId++,kind:"aiAssert",name:"核验供应商信息",value:"读取订单供应商名称，判断其是否与 inputs.supplier 一致。输出 passed、reason。",timeout:30});
      state.selectedStep=state.steps.at(-1).id;state.dirty=true;$("#dialog").close();goto("studio");toast("建议已追加到可编辑草稿");
    }
    else if(action==="save-draft")saveDraft(b);
    else if(action==="trial")startTrial();
    else if(action==="stop-trial"){state.trialEpoch++;state.trialRunning=false;state.trial.cancelled=true;render();toast("模拟试跑已停止，已产生结果保留");}
    else if(action==="open-trial"){state.mode.run="trial";state.runStep=Math.min(3,state.trial.steps.length-1);state.attempt=1;goto("run");}
    else if(action==="back-studio")goto("studio");
    else if(action==="run-step"){state.runStep=Number(b.dataset.index);state.attempt=state.mode.run==="retry"&&state.runStep===3?2:1;render();}
    else if(action==="attempt"){state.attempt=Number(b.dataset.attempt);render();}
    else if(action==="snapshot")snapshotDialog();
    else if(action==="zoom-evidence"){const c=runContext();openDialog("页面证据","示意画面 · Run / StepRun "+(state.runStep+1)+" / Attempt "+state.attempt,browserEvidence(c.steps[state.runStep],c.mode==="retry"&&state.runStep===3&&state.attempt===1),btn("关闭","close-dialog"),"wide");}
    else if(action==="step-data"){
      const c=runContext(),s=c.steps[state.runStep],valid=c.statuses[state.runStep]==="success"&&!(c.mode==="retry"&&state.runStep===3&&state.attempt===1);
      openDialog("步骤输入与输出","当前选中的 StepRun / Attempt",`<h3>冻结输入</h3><pre style="margin:12px 0 23px">${esc(s.value)}</pre><h3>实际输出</h3><pre style="margin-top:12px">${esc(valid?JSON.stringify(stepOutput(s),null,2):"暂无有效成功输出")}</pre>`,btn("关闭","close-dialog"));
    }
    else if(action==="copy-output"){const c=runContext();void copyText(JSON.stringify(stepOutput(c.steps[state.runStep]),null,2));}
    else if(action==="run-events"){
      const c=runContext(),st=c.statuses[state.runStep];
      const rows=st==="pending"?[["—","此步骤尚未创建 Attempt"]]:c.mode==="retry"&&state.runStep===3?[["10:42:09","Attempt 1 开始"],["10:42:39","Attempt 1 超时；保存错误证据"],["10:42:40","符合只读重试策略；Attempt 2 开始"],["10:42:42","Attempt 2 成功；StepRun 判定成功"]]:[["10:42:06","读取冻结步骤配置"],["10:42:07","创建 StepRun 与 Attempt"],["10:42:09",st==="success"?"结果与证据已保存":st==="info"?"最后同步：执行中":st==="warning"?"副作用结果不明确，转人工核查":"步骤失败；保存错误"]];
      openDialog("运行事件","与当前步骤关联的事件示例",rows.map(([time,text])=>`<div class="event-line"><time>${time}</time><span>${text}</span></div>`).join(""),btn("关闭","close-dialog"));
    }
    else if(action==="review-run")openDialog("记录核查结论","先在目标系统核对订单，再结束本次运行。",notice("warning","提交结果不可安全重放","本原型只演示记录结论，不提供重试或恢复续跑。")+`<form id="review-form"><label class="review-choice"><input type="radio" name="conclusion" value="已判定失败" required><span><strong>判定失败并结束</strong><p class="sub">业务目标未达成，保留异常事实。</p></span></label><label class="review-choice"><input type="radio" name="conclusion" value="已取消" required><span><strong>取消并结束</strong><p class="sub">不继续执行，保留已有证据。</p></span></label><div class="field" style="margin-top:16px"><label for="review-reason">核查记录</label><textarea id="review-reason" name="reason" required minlength="3" placeholder="记录核对到的业务状态与依据"></textarea></div></form>`,btn("返回","close-dialog")+`<button class="button primary" type="submit" form="review-form">确认结论</button>`);
    else if(action==="auth-dialog")openDialog("处理目标账号认证","采购管理系统 / 采购测试员",notice("warning","目标会话需要认证","认证前不授予执行租约。本原型用按钮模拟认证完成。")+`<dl class="kv"><dt>目标账号</dt><dd>qa_procurement</dd><dt>当前状态</dt><dd>认证已过期</dd><dt>执行租约</dt><dd>尚未授予</dd></dl>`,btn("稍后处理","close-dialog")+btn("模拟认证完成","confirm-auth","Check","primary"));
    else if(action==="confirm-auth"){$("#dialog").close();state.mode.run="running";render();toast("认证已模拟完成，运行开始执行");setTimeout(()=>{if(state.mode.run==="running"){state.mode.run="success";if(state.page==="run")render();toast("该次运行已模拟完成");}},1800);}
    else if(action==="reconnect"){
      b.disabled=true;b.textContent="同步中…";
      setTimeout(()=>{if(state.mode.run==="offline"){state.mode.run="success";render();toast("已模拟恢复同步，读取到最终成功状态");}},900);
    }
  });
  function addStep(kind) {
    if(state.mode.studio==="readonly"||!kinds[kind])return;
    const defaults={navigate:"/orders",fill:"{{inputs.orderNo}}",click:'role=button[name="查询"]',assert:"{{steps.orderTotal.amount}} > 0",aiAction:"按照业务意图在当前页面完成指定操作。",aiExtract:"提取当前页面的目标字段，返回结构化数据。",aiAssert:"判断业务条件是否成立，返回 passed 与 reason。"};
    const step={id:state.nextStepId++,kind,name:kinds[kind][0],value:defaults[kind],timeout:kind.startsWith("ai")?30:10};
    state.steps.push(step);state.selectedStep=step.id;state.dirty=true;if($("#dialog").open)$("#dialog").close();render();toast("已添加步骤，可继续编辑");
  }
  function validateUrl(input) {
    if(!input)return;
    input.setCustomValidity("");
    let valid=false;
    try{const url=new URL(input.value);valid=["http:","https:"].includes(url.protocol);}catch{}
    if(input.value&&!valid)input.setCustomValidity("请输入包含 http:// 或 https:// 的完整地址");
    input.setAttribute("aria-invalid",String(!input.validity.valid));
    $("#url-error").textContent=input.validity.valid?"":"请输入包含 http:// 或 https:// 的完整地址";
  }
  document.addEventListener("focusout",e=>{if(e.target.id==="bench-url")validateUrl(e.target);});
  document.addEventListener("input",e=>{
    const t=e.target;
    if(t.id==="bench-name")state.bench.name=t.value;
    if(t.id==="bench-url")state.bench.url=t.value;
    if(t.id==="bench-url" && t.hasAttribute("aria-invalid"))validateUrl(t);
    if(t.id==="target-search"){state.search=t.value;$("#target-table").innerHTML=targetTable();}
    if(["step-name","step-value","step-timeout"].includes(t.id)){
      const step=state.steps.find(s=>s.id===state.selectedStep);
      step[t.id==="step-name"?"name":t.id==="step-value"?"value":"timeout"]=t.id==="step-timeout"?Number(t.value):t.value;state.dirty=true;
      $("#save-status").textContent="有未保存修改";
      if(t.id==="step-name")$(`[data-action="select-step"][data-id="${step.id}"] strong`).textContent=t.value||"未命名步骤";
      const trialButton=$('[data-action="trial"]');trialButton.disabled=!validSteps()||!state.studioTarget||state.trialRunning;
    }
  });
  document.addEventListener("change",e=>{
    const t=e.target;
    if(t.id==="bench-env")state.bench.env=t.value;
    if(t.id==="retain-evidence")state.bench.retain=t.checked;
    if(t.id==="notify-owner")state.bench.notify=t.checked;
    if(t.id==="density")document.documentElement.dataset.density=t.value;
    else if(t.id==="reduce-motion")document.documentElement.dataset.reducedMotion=String(t.checked);
    else if(t.id==="sample-state"){
      state.mode[state.page]=t.value;
      if(state.page==="run"){state.runStep=t.value==="review"?2:3;state.attempt=t.value==="retry"?2:1;state.reviewConclusion="";}
      if(state.page==="studio"){if(t.value==="unbound")state.studioTarget="";else if(!state.studioTarget)state.studioTarget="procurement";}
      render();
    }
    else if(t.id==="target-env"||t.id==="target-health"){state[t.id==="target-env"?"env":"health"]=t.value;$("#target-table").innerHTML=targetTable();}
    else if(t.id==="studio-target"){state.studioTarget=t.value;state.mode.studio=t.value?"normal":"unbound";state.dirty=true;render();}
  });
  document.addEventListener("submit",e=>{
    e.preventDefault();const form=e.target;
    if(form.id==="target-form"){
      const data=new FormData(form);let url;
      try{url=new URL(data.get("url"));if(!["http:","https:"].includes(url.protocol)||url.username||url.password)throw Error();}
      catch{$("#target-form-error").textContent="请输入 http(s) 地址，且不要在地址中携带账号或口令。";return;}
      const name=String(data.get("name")).trim();if(!name){$("#target-form-error").textContent="系统名称不能为空";return;}
      const t={id:"target-"+(state.targets.length+1),name,host:url.host+url.pathname.replace(/\/$/,""),env:data.get("env"),health:"neutral",accounts:[],scenarioCount:0};
      state.targets.push(t);state.target=t.id;state.search="";state.env="";state.health="";state.mode.targets="normal";$("#dialog").close();goto("targets");toast("已接入示例目标系统，下一步可添加目标账号");
    }
    else if(form.id==="account-form"){
      const d=new FormData(form);if(!String(d.get("name")).trim()||!String(d.get("login")).trim()){toast("显示名称和登录标识不能为空",true);return;}
      targetNow().accounts.push({name:String(d.get("name")).trim(),login:String(d.get("login")).trim(),auth:false,secretRef:d.get("secret")});
      $("#dialog").close();render();toast("目标账号已添加，等待认证");
    }
    else if(form.id==="review-form"){
      const d=new FormData(form);if(!String(d.get("reason")).trim()){toast("请记录核查依据",true);return;}
      state.reviewConclusion=d.get("conclusion");state.reviewReason=d.get("reason");$("#dialog").close();render();toast("核查结论已记录，本次模拟运行已结束");
    }
  });
  $("#collapse-nav").innerHTML=icon("PanelLeftClose");
  $("#collapse-nav").addEventListener("click",()=>{
    const collapsed=document.documentElement.classList.toggle("nav-collapsed");
    $("#collapse-nav").innerHTML=icon(collapsed?"PanelLeftOpen":"PanelLeftClose");
    $("#collapse-nav").setAttribute("aria-label",collapsed?"展开导航":"收起导航");
    $("#collapse-nav").setAttribute("aria-expanded",String(!collapsed));
  });
  window.addEventListener("hashchange",()=>{state.page=pages[location.hash.slice(1)]?location.hash.slice(1):"components";render();$("#page-title").focus({preventScroll:true});window.scrollTo(0,0);});
  state.page=pages[location.hash.slice(1)]?location.hash.slice(1):"components";
  render();
})();
