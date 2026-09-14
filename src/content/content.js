/**
 * 净网助手 · 内容脚本
 * 负责：扫描页面文本 / 图片，模糊或折叠可疑内容，提供一键恢复。
 * 所有处理均在本地完成。
 */
(function () {
  'use strict';

  if (window.__cfNetCleanerLoaded) return;
  window.__cfNetCleanerLoaded = true;

  const Engine = window.CFEngine;
  if (!Engine) return;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'SVG', 'CANVAS', 'IFRAME', 'TEMPLATE', 'MATH', 'HEAD'
  ]);
  const MAX_BLOCK_TEXT = 500;      // 超过该长度的块按“文章”处理，绝不整块折叠
  const MAX_SCAN_NODES = 2500;     // 单次扫描处理的文本节点上限
  const MAX_IMAGE_BUDGET = 120;    // 单个页面分析的图片数量上限
  const IMAGE_MIN_SIZE = 110;      // 小于该边长的图片视为图标/头像，不分析
  const DUP_MIN_LEN = 8;           // 参与“重复刷屏”判定的最短文本
  const DUP_SAFE_THRESHOLD = 4;    // 保守模式阈值（默认）：只折叠超出的条目
  const DUP_THRESHOLD = 3;         // 严格模式阈值：整组回溯折叠
  const DUP_MAX_GROUPS = 3000;     // 去重分组上限，防止无限滚动页面内存膨胀

  const state = {
    settings: null,
    scanner: null,
    active: false,
    whitelisted: false,
    stats: { text: 0, image: 0, duplicate: 0 },
    processedBlocks: new WeakSet(),
    processedImages: new WeakSet(),
    userRevealed: new WeakSet(),
    hiddenItems: [],
    seenText: new Map(),
    imageBudget: MAX_IMAGE_BUDGET,
    observer: null,
    io: null,
    scanTimer: null,
    pendingRoots: new Set(),
    reportTimer: null,
    badge: null
  };

  /* ============================================================
   * 设置读取
   * ============================================================ */
  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ cf_settings: Engine.DEFAULT_SETTINGS }, (data) => {
          if (chrome.runtime.lastError) return resolve(Object.assign({}, Engine.DEFAULT_SETTINGS));
          resolve(Object.assign({}, Engine.DEFAULT_SETTINGS, data.cf_settings || {}));
        });
      } catch (e) {
        resolve(Object.assign({}, Engine.DEFAULT_SETTINGS));
      }
    });
  }

  function isWhitelisted() {
    const host = location.hostname.toLowerCase();
    const list = (state.settings.whitelist || []).map((d) => String(d).toLowerCase().trim()).filter(Boolean);
    return list.some((d) => host === d || host.endsWith('.' + d));
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  async function start() {
    state.settings = await loadSettings();
    state.scanner = Engine.createScanner(state.settings);

    if (!state.settings.enabled) return;
    if (isWhitelisted()) {
      state.whitelisted = true;
      return;
    }

    state.active = true;
    guardPage();

    const begin = () => {
      if (!state.active) return;
      scanRoot(document.body || document.documentElement);
      watchMutations();
    };
    if (document.body) begin();
    else document.addEventListener('DOMContentLoaded', begin, { once: true });

    watchSettings();
    listenMessages();
  }

  function watchSettings() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.cf_settings) return;
        applySettings(Object.assign({}, Engine.DEFAULT_SETTINGS, changes.cf_settings.newValue || {}));
      });
    } catch (e) { /* 忽略 */ }
  }

  function applySettings(next) {
    const wasActive = state.active;
    state.settings = next;
    state.scanner = Engine.createScanner(next);
    state.whitelisted = isWhitelisted();
    state.active = !!next.enabled && !state.whitelisted;

    if (!state.active) {
      revealAll(false);
      removeBadge();
      return;
    }
    if (!wasActive) {
      scanRoot(document.body || document.documentElement);
      watchMutations();
      guardPage();
    } else {
      fullRescan();
    }
    updateBadge();
  }

  /* ============================================================
   * 整页风险拦截
   * ============================================================ */
  const RISKY_HOST = /(porn|xxx|hentai|xvideo|xhamster|redtube|youporn|spankbang|javbus|javhd|missav|avgle|sehuatang|t66y|caoliu|fuli|18\+|成人|色情|黄网|av\b)/i;

  function sessionAllowed() {
    try { return sessionStorage.getItem('cf_site_allowed') === '1'; } catch (e) { return false; }
  }

  function guardPage() {
    if (!state.settings.pageGuard || sessionAllowed()) return;
    const host = location.hostname.toLowerCase();
    const blocked = state.scanner.isBlockedDomain(host) || RISKY_HOST.test(host);
    if (blocked) showGuard();
  }

  function showGuard() {
    if (document.getElementById('cf-guard')) return;
    const build = () => {
      if (!document.body || document.getElementById('cf-guard')) return;
      const box = document.createElement('div');
      box.id = 'cf-guard';
      box.innerHTML = [
        '<div class="cf-guard-icon">🛡️</div>',
        '<h2>净网助手已拦截此站点</h2>',
        '<p>该站点命中高风险名单（成人内容 / 垃圾推广），为避免误触已暂停页面加载内容的展示。<br>你可以继续访问，或将本站加入白名单。</p>',
        '<div class="cf-guard-actions">',
        '<button class="cf-primary" data-cf="continue">仍然继续访问</button>',
        '<button data-cf="whitelist">加入白名单</button>',
        '<button data-cf="back">返回上一页</button>',
        '</div>'
      ].join('');
      box.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-cf]');
        if (!btn) return;
        const action = btn.getAttribute('data-cf');
        if (action === 'continue') {
          try { sessionStorage.setItem('cf_site_allowed', '1'); } catch (e) {}
          box.remove();
        } else if (action === 'whitelist') {
          addToWhitelist(location.hostname);
          box.remove();
        } else if (action === 'back') {
          if (history.length > 1) history.back();
          else location.href = 'about:blank';
        }
      }, true);
      document.body.appendChild(box);
    };
    if (document.body) build();
    else document.addEventListener('DOMContentLoaded', build, { once: true });
  }

  function addToWhitelist(host) {
    if (!host) return;
    const clean = String(host).toLowerCase().replace(/^www\./, '');
    const list = new Set((state.settings.whitelist || []).map((d) => String(d).toLowerCase()));
    list.add(clean);
    state.settings.whitelist = Array.from(list);
    try { chrome.storage.local.set({ cf_settings: state.settings }); } catch (e) {}
  }

  /* ============================================================
   * 文本扫描
   * ============================================================ */
  function scanRoot(root) {
    if (!state.active || !root) return;
    try {
      if (root.tagName === 'IMG') {
        if (state.settings.filterImages && state.settings.imageScan && !isIgnoredImage(root)) {
          ensureIntersectionObserver();
          state.processedImages.add(root);
          try { state.io.observe(root); } catch (e) { analyzeImage(root); }
        }
        return;
      }
      scanTextBlocks(root);
      scanImages(root);
    } catch (e) { /* 页面结构千奇百怪，出错不影响用户 */ }
  }

  function scanTextBlocks(root) {
    const parents = new Set();
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = node.nodeValue;
        if (!value || !value.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while ((node = walker.nextNode())) {
      if (++count > MAX_SCAN_NODES) break;
      parents.add(node.parentElement);
    }
    for (const el of parents) {
      if (parents.size > MAX_SCAN_NODES) break;
      evaluateBlock(blockRoot(el));
    }
  }

  /** 向上寻找“块根”，避免只折叠单个 span 导致布局错乱 */
  function blockRoot(el) {
    let cur = el;
    for (let i = 0; i < 6; i++) {
      const parent = cur.parentElement;
      if (!parent || !parent.tagName || parent === document.body || parent === document.documentElement) break;
      if (SKIP_TAGS.has(parent.tagName)) break;
      if (parent.classList.contains('cf-hidden') || parent.classList.contains('cf-soft')) break;
      const sameText = Math.abs((parent.textContent || '').length - (cur.textContent || '').length) <= 2;
      if (parent.children.length === 1 && sameText) cur = parent;
      else break;
    }
    return cur;
  }

  function isUiChrome(el) {
    if (el.closest && el.closest('#cf-badge, #cf-guard')) return true;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'LABEL' || tag === 'OPTION' || tag === 'SELECT') return true;
    // 站点导航/菜单属于页面骨架，直接跳过，避免误伤
    return !!el.closest('nav, [role="navigation"], [role="menu"], [role="menubar"], [role="tablist"]');
  }

  function evaluateBlock(el) {
    if (!el || !el.isConnected) return;
    if (state.processedBlocks.has(el)) return;
    state.processedBlocks.add(el);
    if (state.userRevealed.has(el)) return;
    if (el.classList.contains('cf-hidden') || el.classList.contains('cf-soft')) return;
    if (isUiChrome(el)) return;

    const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (raw.length < state.settings.minTextLength) return;
    if (raw.length > MAX_BLOCK_TEXT) return; // 长文按正文处理，不折叠

    const result = state.scanner.scanText(raw, { isContentBlock: true });
    const action = (state.settings.mode === 'blur' && result.action === 'hide') ? 'soft' : result.action;

    if (action === 'hide') {
      hideBlock(el, result.reasons.join('、') || '疑似垃圾信息', result.category);
      return;
    }
    if (action === 'soft') {
      softBlock(el, result.reasons.join('、') || '疑似敏感内容');
      return;
    }
    if (state.settings.filterJunk) detectDuplicate(el, raw);
  }

  /**
   * 重复刷屏 / 僵尸号群发检测。
   * 关键点：
   *  1. 指纹用 Engine.dupKey —— 表情符号被剥离，所以“同一句话只换表情”仍算同一条；
   *  2. 阈值与是否回溯整组由设置 dupMode 决定：
   *       safe（默认，保守）—— 4 条起，只折叠超出的那几条，不动前面正常的
   *       strict（严格）    —— 3 条起，并把该组已出现的条目一并回溯折叠
   *       off              —— 完全关闭
   *     默认保守是因为“同一段文字在一页里出现 2~3 次”在正常页面上很常见
   *     （列表项、价格标签、被多处引用的标题），激进回溯会误伤正常内容。
   *  3. 内联表情在 Twitter/X 上是 <img>，因此不能因为块里有 img 就跳过；
   *     只有真正的内容图（≥100px）或视频才跳过。
   */
  function detectDuplicate(el, raw) {
    const mode = state.settings.dupMode || 'safe';
    if (mode === 'off') return;
    if (raw.length < DUP_MIN_LEN || raw.length > 160) return;
    if (hasHeavyMedia(el)) return;
    if (el.closest('nav, header, footer, aside')) return;
    const key = Engine.dupKey(raw);
    if (!key || key.length < DUP_MIN_LEN) return;

    let group = state.seenText.get(key);
    if (!group) {
      if (state.seenText.size >= DUP_MAX_GROUPS) return;
      group = { count: 0, elements: [] };
      state.seenText.set(key, group);
    }
    group.count++;
    group.elements.push(el);

    const threshold = mode === 'strict' ? DUP_THRESHOLD : DUP_SAFE_THRESHOLD;
    if (group.count < threshold) return;

    // 保守模式只处理当前这一条；严格模式回溯整组
    const targets = mode === 'strict' ? group.elements : [el];
    for (const target of targets) {
      if (!target.isConnected) continue;
      if (state.userRevealed.has(target)) continue;
      if (target.classList.contains('cf-hidden')) continue;
      hideBlock(target, '重复刷屏内容（本页相同内容 ' + group.count + ' 条）', 'junk');
    }
  }

  /** 块内是否包含真正的内容媒体（头像、表情等小图不算） */
  function hasHeavyMedia(el) {
    if (el.querySelector('video, iframe')) return true;
    const images = el.querySelectorAll('img');
    for (const img of images) {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w >= 100 && h >= 100) return true;
    }
    return false;
  }

  function hideBlock(el, reason, category) {
    state.hiddenItems.push(el);
    el.dataset.cfReason = reason;
    el.classList.add('cf-hidden');
    if (!el.title) el.title = '净网助手已过滤：' + reason + '（点击右下角角标可恢复显示）';
    if (category === 'junk') state.stats.duplicate++;
    else state.stats.text++;
    scheduleReport();
  }

  function softBlock(el, reason) {
    el.dataset.cfReason = reason;
    el.classList.add('cf-soft');
    if (!el.title) el.title = '净网助手已模糊：' + reason + '（点击可查看）';
    el.addEventListener('click', function once(ev) {
      if (el.classList.contains('cf-revealed')) return;
      ev.preventDefault();
      ev.stopPropagation();
      el.classList.add('cf-revealed');
      state.userRevealed.add(el);
      el.removeEventListener('click', once, true);
    }, true);
  }

  function revealAll(collect = true) {
    for (const el of state.hiddenItems) {
      el.classList.remove('cf-hidden');
      el.classList.add('cf-was-hidden');
      state.userRevealed.add(el);
    }
    if (collect) state.hiddenItems = [];
    document.querySelectorAll('.cf-soft').forEach((el) => el.classList.add('cf-revealed'));
    if (document.documentElement) document.documentElement.classList.add('cf-revealing');
    updateBadge(true);
  }

  function resetReveal() {
    if (document.documentElement) document.documentElement.classList.remove('cf-revealing');
    document.querySelectorAll('.cf-was-hidden').forEach((el) => el.classList.remove('cf-was-hidden'));
  }

  function fullRescan() {
    revealAll();
    resetReveal();
    state.processedBlocks = new WeakSet();
    state.userRevealed = new WeakSet();
    state.processedImages = new WeakSet();
    state.seenText = new Map();
    state.hiddenItems = [];
    state.imageBudget = MAX_IMAGE_BUDGET;
    state.stats = { text: 0, image: 0, duplicate: 0 };
    document.querySelectorAll('.cf-soft, .cf-blur-img, .cf-was-hidden').forEach((el) => {
      el.classList.remove('cf-soft', 'cf-blur-img', 'cf-revealed', 'cf-was-hidden');
    });
    state.io = null;
    scanRoot(document.body || document.documentElement);
    scheduleReport(true);
  }

  /* ============================================================
   * 图片扫描
   * ============================================================ */
  function scanImages(root) {
    if (!state.settings.filterImages || !state.settings.imageScan) return;
    const nodes = root.querySelectorAll ? root.querySelectorAll('img') : [];
    if (!nodes.length) return;
    ensureIntersectionObserver();
    for (const img of nodes) {
      if (state.processedImages.has(img)) continue;
      state.processedImages.add(img);
      if (isIgnoredImage(img)) continue;
      try { state.io.observe(img); } catch (e) { analyzeImage(img); }
    }
  }

  function isIgnoredImage(img) {
    const hint = ((img.className || '') + ' ' + (img.id || '') + ' ' + (img.getAttribute('alt') || '') + ' ' + (img.getAttribute('role') || '')).toLowerCase();
    if (/avatar|logo|icon|emoji|sprite|badge|qrcode|qr-|captcha|loading|placeholder|spinner/.test(hint)) return true;
    const src = img.currentSrc || img.src || '';
    if (!src || src.startsWith('data:image/svg')) return true;
    if (/^data:/.test(src) && src.length < 200) return true; // 极小 inline 图
    return false;
  }

  function ensureIntersectionObserver() {
    if (state.io) return;
    if (typeof IntersectionObserver !== 'function') {
      state.io = { observe: (img) => analyzeImage(img) };
      return;
    }
    state.io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        state.io.unobserve(entry.target);
        analyzeImage(entry.target);
      }
    }, { rootMargin: '400px 0px' });
  }

  function analyzeImage(img) {
    if (!state.active || !img.isConnected) return;
    if (state.imageBudget <= 0) return;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h || w < IMAGE_MIN_SIZE || h < IMAGE_MIN_SIZE) return;
    // 极端长条通常是横幅，跳过
    const ratio = w / h;
    if (ratio > 6 || ratio < 1 / 6) return;

    state.imageBudget--;
    let analysis = analyzeLocally(img);
    if (analysis) {
      evaluateImage(img, analysis);
    } else {
      const src = img.currentSrc || img.src;
      analyzeInBackground(src).then((remote) => {
        if (remote) evaluateImage(img, remote);
      });
    }
  }

  /** 本地 canvas 分析（同源 / 带 CORS 的图片可直接读取像素） */
  function analyzeLocally(img) {
    try {
      const target = 96;
      const cw = target;
      const ch = Math.max(8, Math.round(target * (img.naturalHeight / img.naturalWidth)) || target);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, cw, ch);
      const data = ctx.getImageData(0, 0, cw, ch).data;
      return Engine.skinScore(data, cw, ch);
    } catch (e) {
      return null; // 跨域污染，交给后台处理
    }
  }

  function analyzeInBackground(url) {
    return new Promise((resolve) => {
      if (!url || !/^https?:/i.test(url)) return resolve(null);
      try {
        chrome.runtime.sendMessage({ type: 'CF_ANALYZE_IMAGE', url }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) return resolve(null);
          resolve(resp.analysis || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function evaluateImage(img, analysis) {
    if (!img.isConnected || state.userRevealed.has(img)) return;
    if (!Engine.shouldBlurImage(analysis, state.settings)) return;
    blurImage(img, analysis);
  }

  function blurImage(img, analysis) {
    if (img.classList.contains('cf-blur-img')) return;
    img.classList.add('cf-blur-img');
    const pct = Math.round((analysis.score || 0) * 100);
    if (!img.title) {
      img.title = '净网助手：疑似暴露图片（置信度 ' + pct + '%），已模糊处理，点击可查看';
    }
    img.addEventListener('click', function once(ev) {
      if (img.classList.contains('cf-revealed')) return;
      ev.preventDefault();
      ev.stopPropagation();
      img.classList.add('cf-revealed');
      state.userRevealed.add(img);
      img.removeEventListener('click', once, true);
    }, true);
    state.stats.image++;
    scheduleReport();
  }

  /* ============================================================
   * DOM 变更监听
   * ============================================================ */
  function watchMutations() {
    if (state.observer || typeof MutationObserver !== 'function') return;
    state.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) state.pendingRoots.add(node);
            else if (node.nodeType === 3 && node.parentElement) state.pendingRoots.add(node.parentElement);
          }
        } else if (m.type === 'attributes' && m.target && m.target.tagName === 'IMG') {
          const img = m.target;
          state.processedImages.delete(img);
          state.pendingRoots.add(img);
        }
      }
      if (state.pendingRoots.size) scheduleScan();
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
  }

  function scheduleScan() {
    if (state.scanTimer) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      if (!state.active) return;
      const roots = Array.from(state.pendingRoots).slice(0, 300);
      state.pendingRoots.clear();
      for (const root of roots) {
        if (root.isConnected) scanRoot(root);
      }
    }, 350);
  }

  /* ============================================================
   * 统计角标 + 与后台通信
   * ============================================================ */
  function total() {
    return state.stats.text + state.stats.image + state.stats.duplicate;
  }

  function scheduleReport(force) {
    updateBadge();
    if (state.reportTimer && !force) return;
    if (force) {
      reportStats();
      return;
    }
    state.reportTimer = setTimeout(() => {
      state.reportTimer = null;
      reportStats();
    }, 500);
  }

  function reportStats() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage({ type: 'CF_STATS', total: total(), stats: state.stats }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* 扩展重载后忽略 */ }
  }

  function updateBadge(forceShow) {
    if (!state.settings || !state.settings.showBadge) {
      removeBadge();
      return;
    }
    const count = total();
    if (count === 0 && !forceShow) {
      removeBadge();
      return;
    }
    if (!document.body) return;
    if (!state.badge || !state.badge.isConnected) {
      const badge = document.createElement('div');
      badge.id = 'cf-badge';
      badge.innerHTML = '<span class="cf-badge-dot"></span><span class="cf-badge-text"></span>' +
        '<button type="button" class="cf-badge-reveal">显示</button>' +
        '<button type="button" class="cf-badge-close" title="关闭">×</button>';
      state.badge = badge;
      state.badge.addEventListener('click', (ev) => {
        const target = ev.target;
        if (target.classList.contains('cf-badge-reveal')) {
          revealAll();
          resetReveal();
          const text = badge.querySelector('.cf-badge-text');
          if (text) text.textContent = '已全部显示（再次点击扩展图标可过滤）';
          setTimeout(() => updateBadge(), 2500);
        } else if (target.classList.contains('cf-badge-close')) {
          badge.remove();
        }
      }, true);
      document.body.appendChild(badge);
    }
    const pos = 'cf-pos-' + (state.settings.badgePosition || 'bottom-right');
    state.badge.className = pos;
    const text = state.badge.querySelector('.cf-badge-text');
    if (text) {
      text.textContent = '净网助手已过滤 ' + count + ' 项' +
        (state.stats.image ? '（图片 ' + state.stats.image + '）' : '');
    }
  }

  function removeBadge() {
    if (state.badge && state.badge.isConnected) state.badge.remove();
    state.badge = null;
  }

  /* ============================================================
   * 与 popup 通信
   * ============================================================ */
  function listenMessages() {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || !msg.type) return undefined;
        switch (msg.type) {
          case 'CF_PING':
            sendResponse({ ok: true, active: state.active });
            return true;
          case 'CF_GET_STATE':
            sendResponse({
              ok: true,
              active: state.active,
              whitelisted: state.whitelisted || isWhitelisted(),
              hostname: location.hostname,
              stats: Object.assign({ total: total() }, state.stats),
              imageBudgetLeft: state.imageBudget
            });
            return true;
          case 'CF_RESCAN':
            fullRescan();
            sendResponse({ ok: true, stats: Object.assign({ total: total() }, state.stats) });
            return true;
          case 'CF_REVEAL_ALL':
            revealAll();
            resetReveal();
            sendResponse({ ok: true });
            return true;
          default:
            return undefined;
        }
      });
    } catch (e) { /* 忽略 */ }
  }

  start();
})();
