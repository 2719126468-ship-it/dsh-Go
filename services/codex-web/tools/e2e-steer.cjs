/**
 * 真浏览器 + 真后端的 steer 端到端验证。
 *
 * 覆盖 MEMORY.md 里唯一"代码已写但验证不完整"的一条：
 * steer 的 UI 路径（生成中按 Enter）此前只有 HTTP 层实测。
 *
 * 用法: node .run/cdp-steer-e2e.cjs
 *   前置: chromium-browser --headless=new --remote-debugging-port=9222
 *         且 server.js 在 3081（.token 里有 token）
 */
const http = require('http');
const fs = require('fs');

const TOK = fs.readFileSync(__dirname + '/../.token', 'utf8').trim();
const BASE = 'http://127.0.0.1:3081';
const SHOTS = __dirname + '/../.shots';

const get = (u) => new Promise((res, rej) =>
  http.get(u, (r) => { let s = ''; r.on('data', d => s += d); r.on('end', () => res(s)); }).on('error', rej));

// 注入页面：记录 chat/steer/interrupt 三个请求，不改应用代码
const RECORDER = [
  'window.__reqs = [];',
  'const __of = window.fetch;',
  'window.fetch = function (u, i) {',
  '  try {',
  '    const url = String(typeof u === "string" ? u : (u && u.url) || "");',
  '    const m = (i && i.method) || "GET";',
  '    if (/api[\\/](chat|steer|interrupt)/.test(url)) window.__reqs.push(m + " " + url.split("?")[0]);',
  '  } catch (e) {}',
  '  return __of.apply(this, arguments);',
  '};',
].join('\n');

let passes = 0, failures = 0;
function check(label, cond, detail) {
  if (cond) { passes++; console.log('  \u2713 ' + label); }
  else { failures++; console.log('  \u2717 ' + label + (detail === undefined ? '' : '  \u2192 ' + String(detail).replace(/\s+/g, ' ').slice(0, 200))); }
}

(async () => {
  const list = JSON.parse(await get('http://127.0.0.1:9222/json/list'));
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('CDP 没有 page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
  };
  await new Promise(r => { ws.onopen = r; });

  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const rawEv = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面表达式抛错: ' + (r.exceptionDetails.text || JSON.stringify(r.exceptionDetails.exception || {})));
    return r.result && r.result.value;
  };
  const run = (fnSrc) => rawEv('(' + fnSrc + ')()');   // 在页面里立即执行一个函数源码
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOTS + '/e2e-' + name + '.png', Buffer.from(r.data, 'base64'));
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: BASE + '/?token=' + TOK });
  await wait(4500);

  console.log('[1] 页面');
  check('composer 存在', await run(() => !!document.querySelector('#composer')));
  check('启动后没有误发 chat/steer/interrupt', await run(() => window.__reqs.length === 0));

  // ------------------------------------------------------------ 起一轮真对话
  await run(() => {
    const i = document.querySelector('#input');
    i.value = '从 1 数到 40，每个数字单独一行，每行后面加一小句解释。不要提前结束，也不要调用任何工具。';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send').click();
  });
  console.log('[2] 等真实轮次进入生成中…');
  await wait(12000);

  const st = await run(() => ({
    streaming: document.body.classList.contains('streaming'),
    placeholder: document.querySelector('#input').placeholder,
    queue: document.querySelector('#queue-label').textContent,
    asstMsgs: document.querySelectorAll('.msg.assistant').length,
    reqs: window.__reqs.slice(),
    tail: ((document.querySelector('.msg.assistant:last-child') || {}).textContent || '').slice(-30),
  }));
  console.log('    状态: ' + JSON.stringify(st));
  check('进入生成中（body.streaming）', st.streaming === true, JSON.stringify(st));
  check('placeholder 切成追入口吻', st.placeholder === '向当前轮次追加输入…', st.placeholder);
  check('queue pill = 1/1 运行中', st.queue === '1/1 运行中', st.queue);
  check('只有 1 次 /api/chat', st.reqs.filter(u => /chat$/.test(u)).length === 1, st.reqs);

  if (!st.streaming) {
    console.log('    轮次已结束，steer 窗口错过（上游太快）——下面跳过 Enter 段');
    await shot('steer-miss-window');
  } else {
    await shot('steer-1-running');

    await run(() => {
      const i = document.querySelector('#input');
      i.value = '改成只数到 12，后面别写了';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(600);
    const btn = await run(() => ({
      state: document.querySelector('#send').dataset.state,
      aria: document.querySelector('#send').getAttribute('aria-label'),
      stopHidden: document.querySelector('#stop-btn').hidden,
    }));
    check('有输入时按钮 morph 成 ready', btn.state === 'ready', JSON.stringify(btn));
    check('按钮 aria-label = 追加到当前轮次', btn.aria === '追加到当前轮次', btn.aria);
    check('停止键仍可见', btn.stopHidden === false, JSON.stringify(btn));

    await run(() => {
      document.querySelector('#input')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    console.log('[3] 已派发真实 Enter，等 /api/steer 落地…');
    await wait(3000);

    const after = await run(() => ({
      reqs: window.__reqs.slice(),
      userTexts: [...document.querySelectorAll('.msg.user .bubble-text')].map(e => e.textContent),
      asstMsgs: document.querySelectorAll('.msg.assistant').length,
      streaming: document.body.classList.contains('streaming'),
      inputVal: document.querySelector('#input').value,
      toastText: document.querySelector('#toast').textContent,
      errs: [...document.querySelectorAll('.errbox')].map(e => e.textContent),
    }));
    console.log('    请求: ' + JSON.stringify(after.reqs));
    console.log('    气泡: ' + JSON.stringify(after.userTexts));

    check('命中 POST /api/steer', after.reqs.some(u => /POST .*\/api\/steer$/.test(u)), after.reqs);
    check('没有另起 /api/chat（同一轮）', after.reqs.filter(u => /chat$/.test(u)).length === 1, after.reqs);
    check('没有误触 /api/interrupt', !after.reqs.some(u => /interrupt$/.test(u)), after.reqs);
    check('steer 文本立刻成为用户气泡',
      after.userTexts.some(t => t.indexOf('只数到 12') >= 0), after.userTexts);
    check('助手气泡数不变（' + st.asstMsgs + '）', after.asstMsgs === st.asstMsgs, after.asstMsgs);
    check('输入框已清空', after.inputVal === '', JSON.stringify(after.inputVal));
    check('提示「已追加到当前轮次」', after.toastText.indexOf('已追加到当前轮次') >= 0, after.toastText);
    check('这一轮仍在跑', after.streaming === true, after.streaming);
    check('追加失败没有报错框', after.errs.length === 0, after.errs);
    await shot('steer-2-after');

    // ---------------------------------------------------- 空输入 submit = 停止
    await run(() => {
      const i = document.querySelector('#input');
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(500);
    const busy = await run(() => document.querySelector('#send').dataset.state);
    check('清空后按钮回到 busy（=停止）', busy === 'busy', busy);

    await run(() => {
      document.querySelector('#composer')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await wait(2500);
    const stopReqs = await run(() => window.__reqs.slice());
    check('空 submit 触发 POST /api/interrupt', stopReqs.some(u => /POST .*\/api\/interrupt$/.test(u)), stopReqs);
    check('空 submit 没有再发 steer', stopReqs.filter(u => /steer$/.test(u)).length === 1, stopReqs);
  }

  console.log('[4] 等回合收尾…');
  await wait(15000);
  const fin = await run(() => ({
    streaming: document.body.classList.contains('streaming'),
    placeholder: document.querySelector('#input').placeholder,
    queue: document.querySelector('#queue-label').textContent,
    reqs: window.__reqs.slice(),
  }));
  console.log('    收尾: ' + JSON.stringify(fin));
  check('全程只有一轮 /api/chat', fin.reqs.filter(u => /chat$/.test(u)).length === 1, fin.reqs);
  if (!fin.streaming) {
    check('结束后 placeholder 复位', fin.placeholder === '给 Codex 发消息…', fin.placeholder);
    check('结束后 queue pill 复位', fin.queue === '1/1 就绪', fin.queue);
  }
  await shot('steer-3-final');

  console.log('页面 JS 异常: ' + errs.length + (errs.length ? ' | ' + errs.slice(0, 3).join(' | ') : ''));
  await send('Emulation.clearDeviceMetricsOverride');
  ws.close();

  console.log('');
  if (failures) { console.log('\u2717 ' + failures + ' 项失败（通过 ' + passes + '）'); process.exit(1); }
  console.log('ALL OK（' + passes + ' 项）');
  process.exit(0);
})().catch(e => { console.error('ERR ' + ((e && e.stack) || e)); process.exit(1); });
