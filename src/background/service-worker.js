/**
 * 净网助手 · Service Worker（后台）
 * 职责：
 *   1. 跨域图片像素分析（本地完成，仅用于判断肤色占比，不保存图片）
 *   2. 扩展图标角标统计
 *   3. 右键菜单快捷操作
 *   4. 广告/推广域名规则集开关
 */
importScripts('../common/filter-engine.js');

const DEFAULTS = self.CFEngine.DEFAULT_SETTINGS;
const SETTINGS_KEY = 'cf_settings';
const URL_CACHE_MAX = 600;

/** 图片分析结果缓存：URL -> analysis */
const urlCache = new Map();
const tabStats = new Map();

/* ============================================================
 * 设置读写
 * ============================================================ */
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULTS }, (data) => {
      resolve(Object.assign({}, DEFAULTS, data[SETTINGS_KEY] || {}));
    });
  });
}

function setSettings(next) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: next }, () => resolve(next));
  });
}

/* ============================================================
 * 安装 / 启动
 * ============================================================ */
chrome.runtime.onInstalled.addListener(async () => {
  const current = await getSettings();
  await setSettings(current);
  await applyRuleset(current.blockThirdPartyAds);
  buildMenus();
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
});

chrome.runtime.onStartup.addListener(async () => {
  const current = await getSettings();
  await applyRuleset(current.blockThirdPartyAds);
  buildMenus();
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
});

/* ============================================================
 * 消息处理
 * ============================================================ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;

  if (msg.type === 'CF_ANALYZE_IMAGE') {
    analyzeImageUrl(msg.url)
      .then((analysis) => sendResponse({ ok: !!analysis, analysis: analysis || null }))
      .catch(() => sendResponse({ ok: false }));
    return true; // 异步响应
  }

  if (msg.type === 'CF_STATS') {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId === 'number') {
      tabStats.set(tabId, msg.stats || {});
      updateBadge(tabId, msg.total || 0);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'CF_SET_AD_RULESET') {
    applyRuleset(!!msg.enabled).then(() => sendResponse({ ok: true }));
    return true;
  }

  return undefined;
});

chrome.tabs && chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener((tabId) => {
  tabStats.delete(tabId);
});

/* ============================================================
 * 图片分析（跨域图片由后台抓取字节，避免 content script 的画布污染）
 * ============================================================ */
async function analyzeImageUrl(url) {
  if (!url || !/^https?:/i.test(url)) return null;
  if (urlCache.has(url)) return urlCache.get(url);

  let analysis = null;
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, { credentials: 'omit', signal: controller.signal, cache: 'force-cache' });
    clearTimeout(timer);
    if (!resp.ok) return null;

    const type = resp.headers.get('content-type') || '';
    if (type && !type.startsWith('image/')) return null;
    const length = Number(resp.headers.get('content-length') || 0);
    if (length > 10 * 1024 * 1024) return null;

    const blob = await resp.blob();
    if (!blob.type.startsWith('image/') || blob.size > 10 * 1024 * 1024) return null;

    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 96 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(8, Math.round(bitmap.width * scale));
    const h = Math.max(8, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    if (typeof bitmap.close === 'function') bitmap.close();
    analysis = self.CFEngine.skinScore(data, w, h);
  } catch (e) {
    analysis = null;
  }

  if (urlCache.size >= URL_CACHE_MAX) {
    const firstKey = urlCache.keys().next().value;
    urlCache.delete(firstKey);
  }
  urlCache.set(url, analysis);
  return analysis;
}

/* ============================================================
 * 角标
 * ============================================================ */
function updateBadge(tabId, count) {
  try {
    const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
    chrome.action.setBadgeText({ tabId, text });
    if (text) chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
  } catch (e) { /* 标签页可能已关闭 */ }
}

/* ============================================================
 * 右键菜单
 * ============================================================ */
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'cf-rescan',
      title: '净网助手：重新扫描本页',
      contexts: ['page', 'frame', 'link', 'image']
    });
    chrome.contextMenus.create({
      id: 'cf-reveal',
      title: '净网助手：显示本页被过滤的内容',
      contexts: ['page', 'frame']
    });
    chrome.contextMenus.create({
      id: 'cf-whitelist',
      title: '净网助手：将本站加入白名单',
      contexts: ['page', 'frame', 'link']
    });
    chrome.contextMenus.create({
      id: 'cf-blocklist',
      title: '净网助手：将本站加入拦截名单',
      contexts: ['page', 'frame', 'link']
    });
    chrome.contextMenus.create({
      id: 'cf-options',
      title: '净网助手：打开设置',
      contexts: ['page', 'frame']
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'cf-options') {
      chrome.runtime.openOptionsPage();
      return;
    }
    if (info.menuItemId === 'cf-rescan') {
      if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: 'CF_RESCAN' }, () => void chrome.runtime.lastError);
      return;
    }
    if (info.menuItemId === 'cf-reveal') {
      if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: 'CF_REVEAL_ALL' }, () => void chrome.runtime.lastError);
      return;
    }

    const settings = await getSettings();
    let host = '';
    try { host = new URL(info.pageUrl || (tab && tab.url) || '').hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return; }
    if (!host) return;

    if (info.menuItemId === 'cf-whitelist') {
      const list = new Set((settings.whitelist || []).map((d) => String(d).toLowerCase()));
      list.add(host);
      settings.whitelist = Array.from(list);
      settings.blockedDomains = (settings.blockedDomains || []).filter((d) => d !== host);
      await setSettings(settings);
      if (tab && tab.id) chrome.tabs.reload(tab.id);
    } else if (info.menuItemId === 'cf-blocklist') {
      const list = new Set((settings.blockedDomains || []).map((d) => String(d).toLowerCase()));
      list.add(host);
      settings.blockedDomains = Array.from(list);
      settings.whitelist = (settings.whitelist || []).filter((d) => d !== host);
      await setSettings(settings);
      if (tab && tab.id) chrome.tabs.reload(tab.id);
    }
  } catch (e) { /* 忽略 */ }
});

/* ============================================================
 * 广告 / 推广域名规则集开关
 * ============================================================ */
async function applyRuleset(enabled) {
  try {
    const current = await chrome.declarativeNetRequest.getEnabledRulesets();
    const has = current.includes('junk_ads');
    if (enabled && !has) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['junk_ads'] });
    } else if (!enabled && has) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ['junk_ads'] });
    }
  } catch (e) { /* 规则集不可用时忽略 */ }
}
