/**
 * 净网助手 · Popup 逻辑
 */
(function () {
  'use strict';

  const Engine = window.CFEngine;
  const KEY = 'cf_settings';

  const $ = (id) => document.getElementById(id);
  const els = {
    master: $('master'),
    scope: $('scope'),
    statImage: $('stat-image'),
    statText: $('stat-text'),
    statDup: $('stat-dup'),
    siteToggle: $('site-toggle'),
    siteHint: $('site-hint'),
    sensitivity: $('sensitivity'),
    sensValue: $('sens-value'),
    filterPorn: $('filterPorn'),
    filterSpam: $('filterSpam'),
    filterJunk: $('filterJunk'),
    filterImages: $('filterImages'),
    pageGuard: $('pageGuard'),
    blockThirdPartyAds: $('blockThirdPartyAds'),
    rescan: $('rescan'),
    reveal: $('reveal'),
    options: $('options'),
    version: $('version')
  };

  const SENS_LABEL = { 1: '宽松', 2: '较宽松', 3: '标准', 4: '较严格', 5: '严格' };

  let settings = null;
  let tab = null;
  let host = '';
  let supported = false;

  /* ---------------- 工具 ---------------- */
  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [KEY]: Engine.DEFAULT_SETTINGS }, (data) => {
        resolve(Object.assign({}, Engine.DEFAULT_SETTINGS, data[KEY] || {}));
      });
    });
  }

  function saveSettings(patch) {
    settings = Object.assign({}, settings, patch);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [KEY]: settings }, () => {
        void chrome.runtime.lastError;
        resolve(settings);
      });
    });
  }

  function parseHost(url) {
    try {
      const u = new URL(url || '');
      if (!/^https?:$/.test(u.protocol)) return '';
      return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function isWhitelisted() {
    const list = (settings.whitelist || []).map((d) => String(d).toLowerCase());
    return !!host && list.some((d) => host === d || host.endsWith('.' + d));
  }

  /* ---------------- 渲染 ---------------- */
  function fill(s) {
    els.master.checked = !!s.enabled;
    els.filterPorn.checked = !!s.filterPorn;
    els.filterSpam.checked = !!s.filterSpam;
    els.filterJunk.checked = !!s.filterJunk;
    els.filterImages.checked = !!s.filterImages;
    els.pageGuard.checked = !!s.pageGuard;
    els.blockThirdPartyAds.checked = !!s.blockThirdPartyAds;
    els.sensitivity.value = String(s.sensitivity || 3);
    els.sensValue.textContent = SENS_LABEL[s.sensitivity || 3] || '标准';
    document.body.classList.toggle('disabled', !s.enabled);
    els.version.textContent = 'v' + Engine.VERSION;
  }

  function renderStats(stats) {
    stats = stats || { image: 0, text: 0, duplicate: 0 };
    els.statImage.textContent = stats.image || 0;
    els.statText.textContent = stats.text || 0;
    els.statDup.textContent = stats.duplicate || 0;
  }

  function renderSite() {
    if (!host) {
      els.scope.textContent = '当前页面不支持过滤';
      els.siteToggle.disabled = true;
      els.siteToggle.textContent = '不可用';
      els.siteHint.textContent = 'chrome:// / 扩展商店等内置页面无法注入脚本。';
      return;
    }
    els.scope.textContent = host;
    const white = isWhitelisted();
    els.siteToggle.disabled = false;
    els.siteToggle.textContent = white ? '移出白名单' : '加入白名单';
    els.siteToggle.classList.toggle('on', white);
    els.siteHint.textContent = white
      ? '该站点已在白名单，所有过滤已暂停。'
      : '白名单站点不做任何过滤。';

    if (!supported) {
      els.siteHint.textContent = '本页未注入内容脚本（可能是内置页面或 PDF），统计不可用。';
    }
  }

  function pingContent() {
    if (!tab || !tab.id || !host) return;
    try {
      chrome.tabs.sendMessage(tab.id, { type: 'CF_GET_STATE' }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          supported = false;
          renderSite();
          return;
        }
        supported = true;
        renderStats(resp.stats);
        if (typeof resp.whitelisted === 'boolean' && resp.whitelisted !== isWhitelisted()) {
          renderSite();
        }
      });
    } catch (e) {
      supported = false;
    }
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    els.master.addEventListener('change', async () => {
      await saveSettings({ enabled: els.master.checked });
      document.body.classList.toggle('disabled', !els.master.checked);
      if (tab && tab.id && host) chrome.tabs.reload(tab.id);
    });

    const checkboxes = [
      ['filterPorn', 'filterPorn'],
      ['filterSpam', 'filterSpam'],
      ['filterJunk', 'filterJunk'],
      ['filterImages', 'filterImages'],
      ['pageGuard', 'pageGuard']
    ];
    for (const [id, key] of checkboxes) {
      els[id].addEventListener('change', () => saveSettings({ [key]: els[id].checked }));
    }

    els.blockThirdPartyAds.addEventListener('change', async () => {
      const enabled = els.blockThirdPartyAds.checked;
      await saveSettings({ blockThirdPartyAds: enabled });
      chrome.runtime.sendMessage({ type: 'CF_SET_AD_RULESET', enabled }, () => void chrome.runtime.lastError);
    });

    els.sensitivity.addEventListener('input', () => {
      const value = Number(els.sensitivity.value) || 3;
      els.sensValue.textContent = SENS_LABEL[value] || '标准';
    });
    els.sensitivity.addEventListener('change', () => {
      saveSettings({ sensitivity: Number(els.sensitivity.value) || 3 });
    });

    els.siteToggle.addEventListener('click', async () => {
      if (!host) return;
      const list = new Set((settings.whitelist || []).map((d) => String(d).toLowerCase()));
      if (list.has(host)) list.delete(host);
      else list.add(host);
      await saveSettings({ whitelist: Array.from(list) });
      renderSite();
      if (tab && tab.id) chrome.tabs.reload(tab.id);
      window.close();
    });

    els.rescan.addEventListener('click', () => {
      if (!tab || !tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'CF_RESCAN' }, (resp) => {
        void chrome.runtime.lastError;
        if (resp && resp.stats) renderStats(resp.stats);
      });
    });

    els.reveal.addEventListener('click', () => {
      if (!tab || !tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'CF_REVEAL_ALL' }, () => {
        void chrome.runtime.lastError;
        renderStats({ image: 0, text: 0, duplicate: 0 });
      });
    });

    els.options.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
      window.close();
    });
  }

  /* ---------------- 初始化 ---------------- */
  (async function init() {
    settings = await getSettings();
    fill(settings);
    bind();

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];
    host = parseHost(tab && tab.url);
    renderSite();
    pingContent();
  })();
})();
