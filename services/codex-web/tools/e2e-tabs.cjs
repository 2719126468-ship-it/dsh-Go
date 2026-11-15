/* 顶部 tab 栏两态 + demo 各页签的最终实测 */
const http = require('http'); const fs = require('fs');
const TOK = fs.readFileSync(__dirname + '/../.token', 'utf8').trim();
const get = (u) => new Promise((res, rej) => http.get(u, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => res(s)); }).on('error', rej));
let passes = 0, failures = 0;
const check = (label, cond, detail) => { if (cond) { passes++; console.log('  \u2713 ' + label); } else { failures++; console.log('  \u2717 ' + label + (detail === undefined ? '' : '  \u2192 ' + String(detail).replace(/\s+/g,' ').slice(0,200))); } };
(async () => {
  const list = JSON.parse(await get('http://127.0.0.1:9222/json/list'));
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errs = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception||{}).description||m.params.exceptionDetails.text); };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params) => new Promise((res2, rej2) => { const mid = ++id; pending.set(mid, {res:res2,rej:rej2}); ws.send(JSON.stringify({id:mid,method,params})); });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'THROW ' + ((r.exceptionDetails.exception&&r.exceptionDetails.exception.description)||r.exceptionDetails.text); return r.result && r.result.value; };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

  const url = 'http://127.0.0.1:3081/?token=' + TOK + '&demo=1&theme=dark';
  await send('Page.navigate', { url });
  await wait(3500);
  const tabs = await ev('[...document.querySelectorAll(".codeside-tab")].map(b=>b.dataset.tab).join(",")');
  console.log('[tab 栏] tabs=' + tabs);
  check('五个页签且首个是会话', tabs === 'chat,files,terminal,diff,context', tabs);

  await ev('document.querySelector("[data-tab=chat]").click()'); await wait(500);
  const chat = await ev('JSON.stringify({cls:document.body.className, stage:getComputedStyle(document.querySelector(".stage")).display, grid:getComputedStyle(document.querySelector("#app")).gridTemplateColumns, side:getComputedStyle(document.querySelector("#codeside")).width})');
  console.log('  会话态: ' + chat);
  const cj = JSON.parse(chat);
  check('会话态没有 view-main', !/view-main/.test(cj.cls), cj.cls);
  check('会话态聊天区正常显示', cj.stage !== 'none', cj.stage);

  await ev('document.querySelector("[data-tab=terminal]").click()'); await wait(700);
  const term = await ev('JSON.stringify({cls:document.body.className, stage:getComputedStyle(document.querySelector(".stage")).display, grid:getComputedStyle(document.querySelector("#app")).gridTemplateColumns, rows:document.querySelectorAll("#terminal-body .term-line").length})');
  console.log('  终端态: ' + term);
  const tj = JSON.parse(term);
  check('终端态 body 有 codeside-open + view-main', /codeside-open/.test(tj.cls) && /view-main/.test(tj.cls), tj.cls);
  check('终端态 .stage 隐藏', tj.stage === 'none', tj.stage);
  check('终端态铺满（第三列吃掉剩余宽度）', /52px 260px \d{3,4}px$/.test(tj.grid), tj.grid);
  check('终端页签渲染 6 行', tj.rows === 6, tj.rows);

  // 关掉面板后再点页签：曾经的空白路径
  await ev('document.querySelector("#codeside-close").click()'); await wait(500);
  const closed = await ev('JSON.stringify({hidden:document.querySelector("#codeside").hidden, cls:document.body.className})');
  check('收起后 codeside hidden', JSON.parse(closed).hidden === true, closed);
  await ev('document.querySelector("[data-tab=diff]").click()'); await wait(900);
  const re = await ev('JSON.stringify({hidden:document.querySelector("#codeside").hidden, cls:document.body.className, rows:document.querySelectorAll("#diff-body .diff-line").length, head:document.querySelector("#diff-stat").textContent, stat:(document.querySelector("#diff-body .diff-card .diff-stat")||{}).textContent||""})');
  console.log('  收起后点变更: ' + re);
  const rj = JSON.parse(re);
  check('收起状态点页签会重新打开面板', rj.hidden === false, re);
  check('重新打开后 class 成套', /codeside-open/.test(rj.cls) && /view-main/.test(rj.cls), rj.cls);
  check('变更页签渲染 9 行', rj.rows === 9, rj.rows);
  check('变更页签头部标出是演示数据', rj.head.indexOf('演示') >= 0, rj.head);
  check('卡片统计 +4 \u22120', rj.stat.indexOf('+4') === 0 && /\u22120$/.test(rj.stat), JSON.stringify(rj.stat));

  await ev('document.querySelector("[data-tab=files]").click()'); await wait(1200);
  const files = await ev('JSON.stringify({rows:document.querySelectorAll("#files-body .side-row").length, hint:!!document.querySelector("#files-body .codeside-hint")})');
  console.log('  文件: ' + files);
  check('文件页签有行或明确提示', JSON.parse(files).rows > 0 || JSON.parse(files).hint === true, files);

  await ev('document.querySelector("[data-tab=context]").click()'); await wait(700);
  const ctx = await ev('JSON.stringify({rows:document.querySelectorAll("#context-body .ctx-row").length})');
  console.log('  上下文: ' + ctx);
  check('上下文页签有多行', JSON.parse(ctx).rows >= 5, ctx);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(__dirname + '/../.shots/final-context-full.png', Buffer.from(shot.data, 'base64'));
  console.log('\n页面异常: ' + errs.length + (errs.length ? ' | ' + errs.slice(0,2).join(' | ') : ''));
  await send('Emulation.clearDeviceMetricsOverride'); ws.close();
  console.log('');
  if (failures) { console.log('\u2717 ' + failures + ' 项失败（通过 ' + passes + '）'); process.exit(1); }
  console.log('ALL OK（' + passes + ' 项）');
})().catch(e => { console.error('ERR ' + ((e&&e.stack)||e)); process.exit(1); });
