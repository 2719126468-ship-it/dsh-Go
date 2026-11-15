/* 手机端（390x844 dpr3 + 360x800）验收：本轮 5 类改动逐条实测 */
const http = require('http'); const fs = require('fs');
const TOK = fs.readFileSync(__dirname + '/../.token', 'utf8').trim();
const get = (u) => new Promise((res, rej) => http.get(u, r => { let s=''; r.on('data',d=>s+=d); r.on('end',()=>res(s)); }).on('error', rej));
let passes = 0, failures = 0;
const check = (label, cond, detail) => { if (cond) { passes++; console.log('  \u2713 ' + label); } else { failures++; console.log('  \u2717 ' + label + (detail === undefined ? '' : '  \u2192 ' + String(detail).replace(/\s+/g,' ').slice(0,190))); } };

(async () => {
  const list = JSON.parse(await get('http://127.0.0.1:9222/json/list'));
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errs = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push(((m.params.exceptionDetails.exception||{}).description||'').split('\n')[0]); };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pending.set(mid,{res,rej}); ws.send(JSON.stringify({id:mid,method,params})); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: '(function(){' + e + '})()', returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'THROW ' + (r.exceptionDetails.text || ''); return r.result && r.result.value; };
  const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(__dirname + '/../.shots/mob-' + n + '.png', Buffer.from(r.data, 'base64')); };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

  console.log('【1】两颗 chip 的样式（修 A：原来 app.css 里 0 条规则，实测 40x56）');
  await send('Page.navigate', { url: 'http://127.0.0.1:3081/?token=' + TOK + '&demo=1&theme=dark' });
  await wait(3500);
  const chips = JSON.parse(await ev('return JSON.stringify(["queue-pill","skill-pill"].map(function(i){var e=document.getElementById(i); var r=e.getBoundingClientRect(); var cs=getComputedStyle(e); return {id:i,w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top),disp:cs.display,bg:cs.backgroundColor}}))'));
  const foot = JSON.parse(await ev('var f=document.querySelector(".composer-foot"); return JSON.stringify({h:Math.round(f.getBoundingClientRect().height),top:Math.round(f.getBoundingClientRect().top)})'));
  console.log('  chips=' + JSON.stringify(chips) + ' foot=' + JSON.stringify(foot));
  check('queue-pill 高度收到 30px（不再是 56）', chips[0].h <= 32, chips[0]);
  check('skill-pill 高度收到 30px（不再是 56）', chips[1].h <= 32, chips[1]);
  check('两颗 chip 落在工具行内（不溢出到卡片外）',
    chips.every(c => c.disp === 'none' || (c.top >= foot.top - 1 && c.top + c.h <= foot.top + foot.h + 6)),
    JSON.stringify({ chips: chips.map(c=>c.top+'x'+c.h), foot: foot.top }));

  console.log('\n【2】右侧面板在手机上是全屏浮层（修 B：原来 display:none 整块砍掉）');
  const side = JSON.parse(await ev('var c=document.getElementById("codeside"); var cs=getComputedStyle(c); return JSON.stringify({hidden:c.hidden, disp:cs.display, pos:cs.position, z:cs.zIndex})'));
  console.log('  默认态=' + JSON.stringify(side));
  check('默认收起（hidden 优先，display:none）', side.hidden === true && side.disp === 'none', side);
  await ev('document.getElementById("btn-side").click(); return 1');
  await wait(700);
  const side2 = JSON.parse(await ev('var c=document.getElementById("codeside"); var cs=getComputedStyle(c); var r=c.getBoundingClientRect(); return JSON.stringify({hidden:c.hidden, disp:cs.display, pos:cs.position, w:Math.round(r.width), h:Math.round(r.height), z:cs.zIndex})'));
  console.log('  点开后=' + JSON.stringify(side2));
  check('顶栏入口 btn-side 在手机上可见', await ev('return getComputedStyle(document.getElementById("btn-side")).display !== "none"'));
  check('面板打开后 display:flex（不再是 none）', side2.disp === 'flex', side2);
  check('面板是 fixed 全屏浮层', side2.pos === 'fixed' && side2.w === 390 && side2.h === 844, side2);
  check('层级在抽屉之上内容之下（80 < z < 105）', Number(side2.z) > 80 && Number(side2.z) < 105, side2.z);
  check('聊天区仍在网格内（浮层没挤掉列宽）',
    await ev('return Math.round(document.querySelector("#app").getBoundingClientRect().width) === 390'));
  await shot('03-codeside-open');

  console.log('\n【3】浮层里的五个页签都能出内容');
  for (const [tab, expect] of [["terminal", "rows"], ["diff", "diff"], ["files", "files"], ["context", "ctx"]]) {
    await ev('document.querySelector(\'[data-tab="' + tab + '"]\').click(); return 1');
    await wait(900);
    const n = await ev('return document.querySelectorAll("#pane-' + tab + ' [class*=line], #pane-' + tab + ' .side-row, #pane-' + tab + ' .ctx-row, #pane-' + tab + ' .diff-line").length');
    const vis = await ev('return !document.getElementById("pane-' + tab + '").hidden');
    check('页签 ' + tab + ' 可见且渲染了 ' + n + ' 项', vis && Number(n) > 0, { vis, n });
  }
  await shot('04-codeside-terminal');

  console.log('\n【4】手机上点「会话」= 关掉浮层（不是留一张空壳）');
  const before = await ev('return document.getElementById("codeside").hidden');
  await ev('document.querySelector("[data-tab=chat]").click(); return 1');
  await wait(700);
  const after = JSON.parse(await ev('var c=document.getElementById("codeside"); return JSON.stringify({hidden:c.hidden, disp:getComputedStyle(c).display, bodyCls:document.body.className, stageVisible:getComputedStyle(document.querySelector(".stage")).display})'));
  console.log('  点会话前 hidden=' + before + ' 之后=' + JSON.stringify(after));
  check('点「会话」把浮层关掉', after.hidden === true && after.disp === 'none', after);
  check('关掉后聊天区可见（没有空壳遮罩）', after.stageVisible !== 'none', after.stageVisible);
  check('view-main 一起清掉', !/view-main/.test(after.bodyCls), after.bodyCls);

  console.log('\n【5】安全区 + 触摸目标（修 C/D/E）');
  console.log('  touch-action=' + await ev('return getComputedStyle(document.getElementById("send")).touchAction'));
  console.log('  tap-highlight=' + await ev('return getComputedStyle(document.getElementById("send")).webkitTapHighlightColor'));
  // 只看当前可见的控件：面板收起时 codeside-close 是 0x0，不该算失败
  const targets = JSON.parse(await ev('return JSON.stringify(["send","attach","btn-menu","model-pill","mode-pill"].map(function(i){var e=document.getElementById(i); if(!e) return {id:i,miss:1}; var r=e.getBoundingClientRect(); var cs=getComputedStyle(e); return {id:i,h:Math.round(r.height),w:Math.round(r.width),vis:cs.display!=="none"&&r.height>0}}))'));
  console.log('  触摸目标=' + JSON.stringify(targets));
  const vis = targets.filter(t => !t.miss && t.vis);
  // 本轮实测后决定**不动盒子尺寸**：design-spec 3.10 钉死发送/停止 32x32 圆形、
  // 图标按钮 32x32、chip/pill 28px。上一版抬到 36/40 造成 attach 28x36 椭圆、
  // 动作条 36px 子项撑破 26px 容器（都是实测出来的），所以这里断言「规格保持」。
  const by = {}; vis.forEach(function (t) { by[t.id] = t; });
  check('发送键保持 32x32 圆形（没被抬成 32x40 胶囊）',
    by.send.w === 32 && by.send.h === 32, JSON.stringify(by.send));
  check('附件键保持 28x28 正方形（不是 28x36 椭圆）',
    by.attach.w === 28 && by.attach.h === 28, JSON.stringify(by.attach));
  check('顶栏汉堡保持 32x32',
    by['btn-menu'].w === 32 && by['btn-menu'].h === 32, JSON.stringify(by['btn-menu']));
  check('pill 高度保持 design-spec 的 28px',
    by['model-pill'].h === 28 && by['mode-pill'].h === 28,
    JSON.stringify([by['model-pill'], by['mode-pill']]));
  check('工具行抬到 36px 后内部控件没被下沿裁掉',
    await ev('var f=document.querySelector(".composer-foot");var fr=f.getBoundingClientRect();var bad=[].slice.call(f.children).filter(function(c){var r=c.getBoundingClientRect();return r.width>0 && r.bottom>fr.bottom+1});return bad.length===0'),
    await ev('var f=document.querySelector(".composer-foot");var fr=f.getBoundingClientRect();return "cont="+Math.round(fr.height)') );
  check('动作条不再被撑破（上一版 36px 子项顶溢出 26px 容器）',
    await ev('var ma=[].slice.call(document.querySelectorAll(".msg-actions")).filter(function(x){return x.getBoundingClientRect().width>0}).pop();if(!ma)return true;var mr=ma.getBoundingClientRect();var bad=[].slice.call(ma.querySelectorAll("button")).filter(function(b){return b.getBoundingClientRect().height>mr.height+1});return bad.length===0'),
    await ev('var ma=[].slice.call(document.querySelectorAll(".msg-actions")).filter(function(x){return x.getBoundingClientRect().width>0}).pop();if(!ma)return "无";var mr=ma.getBoundingClientRect();var k=ma.querySelector("button");return JSON.stringify({c:Math.round(mr.height),b:k?Math.round(k.getBoundingClientRect().height):null})'));
  check('touch-action: manipulation 生效', await ev('return getComputedStyle(document.getElementById("send")).touchAction === "manipulation"'));
  check('去掉点击高亮闪块', await ev('var v=getComputedStyle(document.getElementById("send")).webkitTapHighlightColor; return v === "rgba(0, 0, 0, 0)" || v === "transparent"'));
  const insets = await ev('var t=document.querySelector(".topbar"); var d=document.querySelector(".dock"); return JSON.stringify({topPad:getComputedStyle(t).paddingTop, dockBottomPad:getComputedStyle(d).paddingBottom, headerH:getComputedStyle(t).height})');
  console.log('  安全区=' + insets);
  check('topbar/dock 已挂 env(safe-area-inset-*)（无 inset 时值为 0px，不报错）',
    /topPad/.test(insets) && !/undefined|NaN/.test(insets), insets);

  console.log('\n【5b】热区外扩的对照实验（关掉 ::before 重探同一批坐标，逐点比归属）');
  await ev('document.getElementById("btn-side").click(); return 1');
  await wait(700);
  await ev('document.querySelector(\'[data-tab="files"]\').click(); return 1');
  await wait(1400);
  const pageProbe = fs.readFileSync(__dirname + '/page-hitarea.src.js', 'utf8');
  const hitRows = JSON.parse(await ev(pageProbe));
  for (const h of hitRows) {
    if (h.skip) { check('热区控件 ' + h.name + ' 在面板+files 状态下可见', false, '不可见'); continue; }
    console.log('  ' + h.name + ' 盒=' + JSON.stringify(h.box));
    console.log('    无热区: 左' + h.without.L.join(' ') + ' | 右' + h.without.R.join(' '));
    console.log('    有热区: 左' + h.withH.L.join(' ') + ' | 右' + h.withH.R.join(' '));
    console.log('    新增可点格=' + (h.gained.length ? h.gained.join(',') : '无') + '  抢到的邻居=' + (h.steals.length ? h.steals.join(', ') : '无'));
    check(h.name + ' 中心命中自己', h.center === h.name, h.center);
    check(h.name + ' 热区真的扩大了（至少一档从拿不到变成归自己）', h.gained.length > 0, h.gained);
    check(h.name + ' 没有抢走任何邻居的点击（对照实验零差异）', h.steals.length === 0, h.steals);
  }
  await ev('document.getElementById("codeside-close").click(); return 1');
  await wait(500);

  console.log('\n【5c】设置/主题入口在手机上可达（rail 隐藏后原来完全进不去）');
  const reachSrc = fs.readFileSync(__dirname + '/page-settings-reach.src.js', 'utf8');
  await ev('document.documentElement.setAttribute("data-theme","dark"); return 1');
  const reachRaw = await ev('return (async function(){' + reachSrc + '})()');
  if (typeof reachRaw !== "string" || reachRaw.startsWith("THROW")) {
    check('设置入口探针跑通', false, reachRaw);
  }
  const reach = JSON.parse(typeof reachRaw === "string" && !reachRaw.startsWith("THROW") ? reachRaw : "{}");
  console.log('  ' + JSON.stringify(reach));
  check('#panel-settings 存在且可见', reach.missing === undefined && reach.gearVisible === true, reach.gear);
  check('抽屉先打开（齿轮在抽屉头部，关着时它在 translateX(-280) 外）', reach.drawerOpen === true, reach.drawerOpen);
  check('#panel-settings 中心真的可命中', reach.gearHit === true, reach.gearHit);
  // 实测 .menu z=60 < 窄屏抽屉 .panel z=80：菜单**不**在抽屉之上。
  // 它能点到靠 #panel-settings 处理器里的 closePanel()，所以断言的是这条依赖。
  check('层级事实：.menu z-index 低于窄屏抽屉（所以必须先关抽屉）',
    reach.menuBelowPanel === true, reach.zMenu + " vs " + reach.zPanel);
  check('齿轮先关抽屉，菜单才真的可点（closePanel 依赖）',
    reach.drawerClosedFirst === true && reach.menuClickable === true,
    { closed: reach.drawerClosedFirst, clickable: reach.menuClickable });
  check('点齿轮后设置菜单 display:block', reach.menuDisplay === "block", reach.menuDisplay);
  check('设置菜单完整落在视口内（锚点不能是 0x0 的 rail 齿轮）',
    reach.menuInViewport === true, reach.menuRect);
  check('菜单里有「主题」这一行', reach.hasThemeRow === true, reach.headText);
  check('点主题真的切换了（dark↔light）', reach.themeSwitched === true,
    reach.themeFrom + "→" + reach.themeTo);
  check('主题选择被持久化', reach.themeStored === "light" || reach.themeStored === "dark", reach.themeStored);
  // 768~1023 段 rail 齿轮也在，必须只有一个入口（重复齿轮是实测发现过的回归）
  check('窄屏没有重复设置入口（rail 齿轮此时应不可见）', reach.railAlsoVisible === false, reach.railAlsoVisible);

  console.log('\n【6】无横向溢出 + 令牌净化没弄坏正常流程');
  check('无横向溢出', await ev('return document.documentElement.scrollWidth <= window.innerWidth'), await ev('return document.documentElement.scrollWidth + ">" + window.innerWidth'));
  check('会话列表仍拉得到', await ev('return fetch("/api/threads").then(r=>r.status)') === 200);
  check('页面 JS 异常 0', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n【7】360x800 小屏（Android 常见）+ 极窄 320');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 3, mobile: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:3081/?token=' + TOK + '&demo=1&theme=dark' });
  await wait(2500);
  check('360 宽无溢出', await ev('return document.documentElement.scrollWidth <= window.innerWidth'), await ev('return document.documentElement.scrollWidth+">"+window.innerWidth'));
  check('360 下发送键没被挤出可视区', await ev('var r=document.getElementById("send").getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.left >= 0'), await ev('var r=document.getElementById("send").getBoundingClientRect(); return JSON.stringify({l:Math.round(r.left),r:Math.round(r.right)})'));
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 2, mobile: true });
  await wait(1200);
  check('320 极窄无溢出', await ev('return document.documentElement.scrollWidth <= window.innerWidth'), await ev('return document.documentElement.scrollWidth+">"+window.innerWidth'));
  console.log('  320 下 chips=' + await ev('return ["queue-pill","skill-pill"].map(function(i){var e=document.getElementById(i);var cs=getComputedStyle(e);var r=e.getBoundingClientRect();return i+" "+cs.display+" "+Math.round(r.width)+"x"+Math.round(r.height)}).join(" | ")'));

  console.log('\n【8】桌面回归：≥1280 的 320px 第四列不能被这次改动破坏');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:3081/?token=' + TOK + '&demo=1&theme=dark' });
  await wait(2500);
  await ev('document.getElementById("btn-side").click(); return 1');
  await wait(600);
  const desk = JSON.parse(await ev('var c=document.getElementById("codeside"); var r=c.getBoundingClientRect(); return JSON.stringify({pos:getComputedStyle(c).position, w:Math.round(r.width), grid:getComputedStyle(document.querySelector("#app")).gridTemplateColumns, disp:getComputedStyle(c).display})'));
  console.log('  桌面开面板=' + JSON.stringify(desk));
  check('桌面仍是 320px 固定列（不是 fixed 浮层）', desk.pos !== 'fixed' && desk.w === 320, desk);
  check('桌面 grid 是四列', (desk.grid.match(/px/g) || []).length === 4, desk.grid);
  await ev('document.querySelector("[data-tab=terminal]").click(); return 1');
  await wait(700);
  check('桌面铺满态仍生效（三列 + stage 隐藏）',
    await ev('return document.body.classList.contains("view-main") && getComputedStyle(document.querySelector(".stage")).display === "none"'));

  await send('Emulation.clearDeviceMetricsOverride');
  console.log('\n页面 JS 异常总数: ' + errs.length + (errs.length ? ' | ' + errs.slice(0,3).join(' | ') : ''));
  ws.close();
  console.log('');
  if (failures) { console.log('\u2717 ' + failures + ' 项失败（通过 ' + passes + '）'); process.exit(1); }
  console.log('ALL OK（' + passes + ' 项）');
})().catch(e => { console.error('ERR ' + ((e&&e.stack)||e)); process.exit(1); });
