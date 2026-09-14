/**
 * 端到端验证：在真实 Chrome 中加载扩展，打开本地测试页，检查过滤是否生效。
 * 用法：node tools/verify-in-chrome.js
 * 依赖：本机安装 Google Chrome（macOS 路径为默认值，可用 CHROME_PATH 覆盖）
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const EXT_DIR = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE_DIR = path.join(EXT_DIR, '.tmp-chrome-profile');
const PORT = Number(process.env.TEST_PORT || 8123);
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9333);

/* ---------------- 测试页面 ---------------- */
const DUPLICATE_TEXT = '这是一条重复的评论内容';
// 僵尸号刷屏特征：同一句话只换表情（外加一个内联小图，模拟 Twitter/X 的表情渲染）
const EMOJI_VARIANTS = ['🤤🐒', '🤤🐵', '🤤🐒', '🐵🤤', '🤤🐒'];
const INLINE_EMOJI_IMG = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="16" height="16" alt="🤤">';

function pageHtml() {
  const dupBlocks = Array.from({ length: 5 }, (_, i) => {
    const inline = i === 4 ? INLINE_EMOJI_IMG : '';
    return `<div class="dup-item" id="dup${i}">${DUPLICATE_TEXT}${EMOJI_VARIANTS[i]}${inline}</div>`;
  }).join('\n');

  const normalBlocks = Array.from({ length: 12 }, (_, i) =>
    `<p id="normal-extra-${i}">第 ${i} 段正常正文，用于确认页面其余内容不会被误伤。阅读使人明智。</p>`).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>净网助手测试页</title>
<style>body{font:16px/1.7 sans-serif;margin:24px;max-width:760px}
.box{border:1px solid #ddd;padding:10px;margin:8px 0}
.dups{display:grid;grid-template-columns:1fr 1fr;gap:6px;border:1px dashed #ccc;padding:8px}
img{width:300px;height:300px;display:block;margin:10px 0}
</style></head>
<body>
<h1>过滤测试页</h1>

<div class="box" id="spam1">加微信 vx889900 免费领取内部资源，日赚千元！！！</div>
<div class="box" id="porn1">这里有大量色情视频免费观看</div>
<div class="box" id="phone1">联系电话：13812345678，办理无抵押贷款秒批</div>
<div class="box" id="normal1">今天天气不错，我们一起去公园散步吧，顺便看看新开的书店。</div>
<div class="box" id="normal2">公司发布了第三季度财务报告，营收同比增长 12%，研发投入持续增加。</div>
<div class="box" id="junk1">沙发</div>
<div class="box" id="bracketed">【好消息】限时特价 秒杀 清仓甩卖 点击查看详情</div>

<h2>重复灌水</h2>
<div class="dups">${dupBlocks}</div>

<h2>疑似裸露图片（程序生成的大面积肤色图）</h2>
<img id="skinimg" alt="test" />

<h2>正常图片（风景色块）</h2>
<canvas id="normalcanvas" width="300" height="300" style="display:none"></canvas>
<img id="normalimg" alt="test2" />

${normalBlocks}
<script>
  // 生成大面积肤色图片
  function paint(id, fn) {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 300;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(300, 300);
    for (let y = 0; y < 300; y++) {
      for (let x = 0; x < 300; x++) {
        const i = (y * 300 + x) * 4;
        const [r, g, b] = fn(x, y);
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    document.getElementById(id).src = c.toDataURL('image/png');
  }
  paint('skinimg', (x, y) => [205 + ((x + y) % 6), 152, 128]);
  paint('normalimg', (x, y) => {
    const band = Math.floor(y / 60) % 3;
    if (band === 0) return [80, 150, 230];
    if (band === 1) return [70, 165, 80];
    return [225, 230, 240];
  });
</script>
</body></html>`;
}

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        const handlers = this.listeners.get(msg.method) || [];
        handlers.forEach((h) => h(msg.params));
      }
    });
  }
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败: ' + url)));
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 15000);
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error('页面脚本异常: ' + JSON.stringify(result.exceptionDetails.exception));
    }
    return result.result.value;
  }
}

/* ---------------- 工具 ---------------- */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  return resp.json();
}

async function waitForDevTools() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return true;
    } catch (e) {
      await sleep(500);
    }
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

function startServer() {
  const html = pageHtml();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const CHECK_SCRIPT = `
(async () => {
  await new Promise(r => setTimeout(r, 3500));
  const cls = (sel) => {
    const el = document.querySelector(sel);
    return el ? (el.className || '') : 'MISSING';
  };
  const hidden = (sel) => cls(sel).includes('cf-hidden');
  const soft = (sel) => cls(sel).includes('cf-soft');
  const blurred = (sel) => cls(sel).includes('cf-blur-img');
  const dupHidden = ['#dup0','#dup1','#dup2','#dup3','#dup4'].filter(s => hidden(s)).length;
  const badge = document.getElementById('cf-badge');
  return {
    spam: hidden('#spam1') ? 'hidden' : (soft('#spam1') ? 'soft' : 'visible'),
    porn: hidden('#porn1') ? 'hidden' : (soft('#porn1') ? 'soft' : 'visible'),
    phone: hidden('#phone1') ? 'hidden' : (soft('#phone1') ? 'soft' : 'visible'),
    normal1: hidden('#normal1') ? 'hidden' : (soft('#normal1') ? 'soft' : 'visible'),
    normal2: hidden('#normal2') ? 'hidden' : (soft('#normal2') ? 'soft' : 'visible'),
    normalExtraHidden: ['#normal-extra-0','#normal-extra-5','#normal-extra-11'].filter(s => hidden(s)).length,
    junk: hidden('#junk1') ? 'hidden' : (soft('#junk1') ? 'soft' : 'visible'),
    bracketed: hidden('#bracketed') ? 'hidden' : (soft('#bracketed') ? 'soft' : 'visible'),
    dupHiddenCount: dupHidden,
    skinImg: blurred('#skinimg') ? 'blurred' : 'clear',
    normalImg: blurred('#normalimg') ? 'blurred' : 'clear',
    badgeVisible: !!badge,
    badgeText: badge ? badge.textContent.trim() : '',
    guardShown: !!document.getElementById('cf-guard')
  };
})()
`;

/* ---------------- 扩展内页检查（popup / options） ---------------- */
async function inspectExtensionPage(browserCdp, url, checkScript, shotName) {
  const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
  const targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const target = targets.find((t) => t.id === targetId);
  if (!target) throw new Error('未能创建扩展页面目标: ' + url);

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    errors.push((d.exception && d.exception.description) || d.text || 'unknown error');
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      errors.push('console.error: ' + (p.args || []).map((a) => a.value || a.description || '').join(' '));
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
  await sleep(2200);

  // 可选：截图便于人工核对界面
  if (process.env.CF_SCREENSHOT && shotName) {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const dir = path.join(EXT_DIR, '.screenshots');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, shotName + '.png'), Buffer.from(shot.data, 'base64'));
      console.log('已保存截图: .screenshots/' + shotName + '.png');
    } catch (e) {
      console.log('截图失败:', e.message);
    }
  }

  let result = null;
  try {
    result = await cdp.evaluate(checkScript);
  } catch (e) {
    errors.push('检查脚本执行失败: ' + e.message);
  }
  cdp.ws.close();
  await browserCdp.send('Target.closeTarget', { targetId }).catch(() => {});
  return { errors, result };
}

const OPTIONS_CHECK = `
(async () => {
  const ta = document.getElementById('test-input');
  ta.value = '加微信 vx889900 免费领取内部资源，日赚千元！！！';
  document.getElementById('run-test').click();
  await new Promise(r => setTimeout(r, 300));
  const res = document.getElementById('test-result');
  return {
    engine: typeof CFEngine,
    engineVersion: typeof CFEngine !== 'undefined' ? CFEngine.VERSION : null,
    builtinStats: document.getElementById('builtin-stats').textContent.replace(/\\s+/g, ' ').trim(),
    testVerdict: res.textContent,
    testClass: res.className,
    hasFields: ['whitelist','blockedDomains','customPornKeywords','sensitivity','mode','minTextLength']
      .every(id => !!document.getElementById(id))
  };
})()
`;

const POPUP_CHECK = `
(async () => {
  await new Promise(r => setTimeout(r, 800));
  const ids = ['filterPorn','filterSpam','filterJunk','filterImages','pageGuard','blockThirdPartyAds'];
  return {
    engine: typeof CFEngine,
    master: !!document.getElementById('master'),
    scope: document.getElementById('scope').textContent,
    version: document.getElementById('version').textContent,
    sensitivity: document.getElementById('sensitivity').value,
    on: ids.filter(id => document.getElementById(id) && document.getElementById(id).checked),
    off: ids.filter(id => document.getElementById(id) && !document.getElementById(id).checked)
  };
})()
`;

/* ---------------- 主流程 ---------------- */
async function main() {
  if (!fs.existsSync(CHROME)) throw new Error('未找到 Chrome: ' + CHROME);
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

  const server = await startServer();
  const testUrl = `http://127.0.0.1:${PORT}/`;

  // Chrome 137+ 已移除 --load-extension，官方推荐改用 CDP 的 Extensions.loadUnpacked
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
    '--host-resolver-rules=MAP porn-test.example 127.0.0.1',
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--enable-unsafe-extension-debugging',
    '--window-size=1000,900',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const chromeLog = [];
  chrome.stdout.on('data', (d) => chromeLog.push(String(d)));
  chrome.stderr.on('data', (d) => chromeLog.push(String(d)));

  let exitCode = 0;
  let browserCdp = null;
  try {
    await waitForDevTools();
    const version = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);

    // 1) 通过 CDP 加载未打包扩展
    browserCdp = await CDP.connect(version.webSocketDebuggerUrl);
    const loaded = await browserCdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
    if (!loaded || !loaded.id) {
      throw new Error('扩展加载失败：' + JSON.stringify(loaded));
    }
    console.log('扩展已加载，ID =', loaded.id);

    // 2) 打开测试页
    await browserCdp.send('Target.createTarget', { url: testUrl });
    await sleep(2500);

    const targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT}`));
    if (!page) {
      throw new Error('未找到测试页面目标，现有目标：' + targets.map((t) => `${t.type}:${t.url}`).join(', '));
    }

    const pageCdp = await CDP.connect(page.webSocketDebuggerUrl);
    await pageCdp.send('Runtime.enable');
    const results = await pageCdp.evaluate(CHECK_SCRIPT);
    const extId = loaded.id;

    // 3) 检查 Service Worker 是否成功加载引擎（验证 importScripts 路径）
    let swVersion = 'no-service-worker-target';
    const swTarget = targets.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    if (swTarget) {
      try {
        const swCdp = await CDP.connect(swTarget.webSocketDebuggerUrl);
        await swCdp.send('Runtime.enable');
        swVersion = await swCdp.evaluate('typeof CFEngine !== "undefined" ? CFEngine.VERSION : "CFEngine missing"');
        swCdp.ws.close();
      } catch (e) {
        swVersion = 'sw-eval-failed: ' + e.message;
      }
    }

    console.log('\n=== 页面过滤结果 ===');
    console.log(JSON.stringify(results, null, 2));
    console.log('\n=== 后台 Service Worker ===');
    console.log('CFEngine 版本:', swVersion);

    // 4) 功能检查 popup 与 options 页面
    const popupUrl = `chrome-extension://${extId}/src/popup/popup.html`;
    const optionsUrl = `chrome-extension://${extId}/src/options/options.html`;
    const popup = await inspectExtensionPage(browserCdp, popupUrl, POPUP_CHECK, 'popup');
    const options = await inspectExtensionPage(browserCdp, optionsUrl, OPTIONS_CHECK, 'options');

    console.log('\n=== Popup 页面 ===');
    console.log(JSON.stringify(popup.result, null, 2));
    if (popup.errors.length) console.log('Popup 报错:', popup.errors);

    console.log('\n=== 设置页 ===');
    console.log(JSON.stringify(options.result, null, 2));
    if (options.errors.length) console.log('设置页报错:', options.errors);

    /* 5) 整页拦截 + 白名单流程（域名含高风险关键词，映射到本地测试服务器） */
    const guardUrl = `http://porn-test.example:${PORT}/`;
    const created = await browserCdp.send('Target.createTarget', { url: guardUrl });
    await sleep(2500);
    const guardTarget = (await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`))
      .find((t) => t.id === created.targetId);
    let guard = { blocked: null, afterWhitelist: null, afterReload: null };
    if (guardTarget) {
      const guardCdp = await CDP.connect(guardTarget.webSocketDebuggerUrl);
      await guardCdp.send('Runtime.enable');
      await guardCdp.send('Page.enable');
      guard.blocked = await guardCdp.evaluate(`(async () => {
        await new Promise(r => setTimeout(r, 1500));
        const box = document.getElementById('cf-guard');
        return { shown: !!box, hasWhitelistBtn: !!(box && box.querySelector('button[data-cf="whitelist"]')) };
      })()`);
      guard.afterWhitelist = await guardCdp.evaluate(`(async () => {
        const btn = document.querySelector('#cf-guard button[data-cf="whitelist"]');
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 800));
        return { shown: !!document.getElementById('cf-guard') };
      })()`);
      await guardCdp.send('Page.navigate', { url: guardUrl });
      await sleep(2200);
      guard.afterReload = await guardCdp.evaluate(`(async () => {
        await new Promise(r => setTimeout(r, 1200));
        return { shown: !!document.getElementById('cf-guard'), badge: !!document.getElementById('cf-badge') };
      })()`);
      guardCdp.ws.close();
      await browserCdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {});
    }
    console.log('\n=== 整页拦截 / 白名单 ===');
    console.log(JSON.stringify(guard, null, 2));

    /* ---------------- 断言 ---------------- */
    const problems = [];
    const expect = (cond, label) => { if (!cond) problems.push(label); };

    expect(swVersion === '1.0.0', `后台 Service Worker 未正确加载引擎（实际：${swVersion}）`);
    expect(results.spam === 'hidden', `微信引流广告应被折叠，实际：${results.spam}`);
    expect(results.porn === 'hidden', `色情文案应被折叠，实际：${results.porn}`);
    expect(results.phone === 'hidden', `贷款/电话广告应被折叠，实际：${results.phone}`);
    expect(results.normal1 === 'visible', `正常句子被误伤：${results.normal1}`);
    expect(results.normal2 === 'visible', `正常句子被误伤：${results.normal2}`);
    expect(results.normalExtraHidden === 0, `正常段落被误伤 ${results.normalExtraHidden} 处`);
    expect(results.junk !== 'visible', `灌水词应被模糊或折叠，实际：${results.junk}`);
    expect(results.dupHiddenCount === 5,
      `表情变体的同组刷屏内容应被全部回溯折叠（含内联表情图片那条），实际折叠 ${results.dupHiddenCount}/5 条`);
    expect(results.skinImg === 'blurred', `大面积肤色图片应被模糊，实际：${results.skinImg}`);
    expect(results.normalImg === 'clear', `正常风景图片被误判模糊，实际：${results.normalImg}`);
    expect(results.badgeVisible, '页面统计角标未出现');
    expect(results.guardShown === false, '正常本地测试页不应触发整页拦截');

    expect(popup.errors.length === 0, 'Popup 页面存在脚本错误：' + popup.errors.join(' | '));
    expect(popup.result && popup.result.engine === 'object', 'Popup 未加载过滤引擎');
    expect(popup.result && popup.result.version === 'v1.0.0', 'Popup 版本号显示异常：' + (popup.result && popup.result.version));
    const expectedOn = ['filterPorn', 'filterSpam', 'filterJunk', 'filterImages', 'pageGuard'];
    expect(popup.result && expectedOn.every((id) => popup.result.on.includes(id)),
      'Popup 默认应开启：' + expectedOn.join('/') + '，实际开启：' + (popup.result && popup.result.on.join('/')));
    expect(popup.result && popup.result.off.length === 1 && popup.result.off[0] === 'blockThirdPartyAds',
      '广告域名拦截应默认关闭（避免误伤站点），实际关闭项：' + (popup.result && popup.result.off.join('/')));

    expect(options.errors.length === 0, '设置页存在脚本错误：' + options.errors.join(' | '));
    expect(options.result && options.result.hasFields, '设置页缺少关键控件');
    expect(options.result && /判定：折叠/.test(options.result.testVerdict),
      '设置页规则测试器结果异常：' + (options.result && options.result.testVerdict));
    expect(options.result && options.result.engineVersion === '1.0.0', '设置页引擎版本异常');

    expect(guard.blocked && guard.blocked.shown && guard.blocked.hasWhitelistBtn,
      '高风险域名未触发整页拦截：' + JSON.stringify(guard.blocked));
    expect(guard.afterWhitelist && guard.afterWhitelist.shown === false,
      '点击“加入白名单”后遮罩未消失：' + JSON.stringify(guard.afterWhitelist));
    expect(guard.afterReload && guard.afterReload.shown === false,
      '白名单未持久化，刷新后又触发拦截：' + JSON.stringify(guard.afterReload));
    expect(guard.afterReload && guard.afterReload.badge === false,
      '白名单站点不应显示过滤角标：' + JSON.stringify(guard.afterReload));

    const extErrors = chromeLog.join('').split('\n')
      .filter((l) => /extension|manifest|importScripts/i.test(l) && /error|failed|invalid|unable/i.test(l));
    if (extErrors.length) {
      console.log('\n=== Chrome 日志中的扩展相关错误 ===');
      extErrors.slice(0, 20).forEach((l) => console.log('  ' + l.trim()));
    }

    if (problems.length) {
      console.log('\n❌ 未通过项：');
      problems.forEach((p) => console.log('  - ' + p));
      exitCode = 1;
    } else {
      console.log('\n✅ 全部检查通过（扩展已在真实 Chrome 中正确加载并生效）');
    }
    pageCdp.ws.close();
  } catch (err) {
    console.error('验证过程出错:', err.message);
    console.error('Chrome 日志尾部:\n' + chromeLog.join('').split('\n').slice(-25).join('\n'));
    exitCode = 1;
  } finally {
    if (browserCdp) browserCdp.ws.close();
    chrome.kill('SIGKILL');
    server.close();
    await sleep(300);
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

main();
