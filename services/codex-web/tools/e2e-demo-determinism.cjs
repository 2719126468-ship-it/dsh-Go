/* demo 可重现性探测：同一 URL 连跑 N 次，DOM 读数必须完全一致。 */
const http = require('http'); const fs = require('fs');
const TOK = fs.readFileSync(__dirname + '/../.token', 'utf8').trim();
const get = (u) => new Promise((res, rej) => http.get(u, r => { let s=''; r.on('data',d=>s+=d); r.on('end',()=>res(s)); }).on('error', rej));

function openPage(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map(); const errs = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception||{}).description||m.params.exceptionDetails.text); };
    ws.onerror = rej;
    ws.onopen = () => {
      const send = (method, params) => new Promise((r2, j2) => { const mid = ++id; pending.set(mid,{res:r2,rej:j2}); ws.send(JSON.stringify({id:mid,method,params})); });
      const ev = async (e) => { const rr = await send('Runtime.evaluate',{expression:'('+e+')()',returnByValue:true,awaitPromise:true}); if (rr.exceptionDetails) throw new Error('page expr: '+rr.exceptionDetails.text); return rr.result && rr.result.value; };
      res({ ws, send, ev, errs });
    };
  });
}

async function probe(url, tab, waitMs) {
  const list = JSON.parse(await get('http://127.0.0.1:9222/json/list'));
  const page = list.find(t => t.type === 'page');
  const { ws, send, ev, errs } = await openPage(page.webSocketDebuggerUrl);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:950,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url});
  await new Promise(r=>setTimeout(r,waitMs));
  if (tab) {
    const expr = '() => { const b = document.querySelector(\'[data-tab="' + tab + '\"]\'); if (!b) return "no-tab"; b.click(); return "clicked"; }';
    console.log('   tab click -> ' + await ev(expr));
  }
  await new Promise(r=>setTimeout(r,700));
  const out = await ev(() => ({
    termRows: document.querySelectorAll('#terminal-body .term-line').length,
    termCmd: document.querySelectorAll('#terminal-body .term-line.cmd').length,
    termHint: !!document.querySelector('#terminal-body .codeside-hint'),
    diffRows: document.querySelectorAll('#diff-body .diff-line').length,
    diffStat: (document.querySelector('#diff-body .diff-stat')||{}).textContent || null,
    ghost: [...document.querySelectorAll('#diff-body .diff-line')].filter(l => /(^|\s)0\s+0(\s|$)/.test(l.textContent.trim())).length,
    planSteps: document.querySelectorAll('.plan-step').length,
    toolCards: document.querySelectorAll('.msg.assistant .tool-card').length,
    approval: document.querySelectorAll('.approval-card').length,
    tabs: [...document.querySelectorAll('.codeside-tab')].map(b=>b.dataset.tab).join(','),
    bodyCls: document.body.className,
    grid: getComputedStyle(document.querySelector('#app')).gridTemplateColumns,
    stageDisp: getComputedStyle(document.querySelector('.stage')||document.body).display,
  }));
  out.errs = errs.length;
  await send('Emulation.clearDeviceMetricsOverride');
  ws.close();
  return out;
}

(async () => {
  const B = 'http://127.0.0.1:3081/?token=' + TOK;
  const results = [];
  // demo=1：静态数据，三次必须逐字节一致；分别在不同等待时长下探（上轮不一致就是这么暴露的）
  for (const w of [2500, 4000, 6000]) {
    const r = await probe(B + '&demo=1&theme=dark', 'terminal', w);
    results.push(['demo=1 w=' + w, r]);
  }
  // 变更页签
  const rd = await probe(B + '&demo=1&theme=dark', 'diff', 3500);
  results.push(['demo=1 diff-tab', rd]);
  // tab 栏 + 铺满行为
  for (const [i, w] of [[1,2500],[2,5000]]) {
    const r = await probe(B + '&demo=stream&theme=dark', 'terminal', w);
    results.push(['demo=stream w=' + w, r]);
  }
  for (const [k, r] of results) console.log(k + '  ' + JSON.stringify(r));
  const statics = results.filter(x => x[0].startsWith('demo=1'));
  const keys = ['termRows','termCmd','termHint','diffRows','planSteps','toolCards','approval','tabs','bodyCls','grid','stageDisp','ghost','errs'];
  const sig = (o) => keys.map(k => JSON.stringify(o[k])).join('|');
  const t = statics.filter(x => x[0].includes('terminal'));
  const same = t.every(x => sig(x[1]) === sig(t[0][1]));
  console.log('');
  console.log('静态 demo 三次读数一致（跨 2.5s/4s/6s）: ' + same);
  if (!same) { t.forEach(x => console.log('  ' + sig(x[1]))); process.exit(1); }
})().catch(e => { console.error('ERR ' + ((e && e.stack) || e)); process.exit(1); });