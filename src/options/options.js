/**
 * 净网助手 · 设置页逻辑
 */
(function () {
  'use strict';

  const Engine = window.CFEngine;
  const KEY = 'cf_settings';
  const $ = (id) => document.getElementById(id);

  const SENS_LABEL = { 1: '宽松', 2: '较宽松', 3: '标准', 4: '较严格', 5: '严格' };

  let settings = null;

  /* ---------------- 存取 ---------------- */
  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [KEY]: Engine.DEFAULT_SETTINGS }, (data) => {
        resolve(Object.assign({}, Engine.DEFAULT_SETTINGS, data[KEY] || {}));
      });
    });
  }

  function persist(next, silent) {
    settings = Object.assign({}, settings, next);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [KEY]: settings }, () => {
        void chrome.runtime.lastError;
        if (!silent) toast('已保存');
        resolve(settings);
      });
    });
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 1600);
  }

  /* ---------------- 渲染 / 收集 ---------------- */
  function linesToArray(value) {
    return String(value || '')
      .split(/[\n,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function arrayToLines(value) {
    return (value || []).join('\n');
  }

  function fill(s) {
    $('enabled').value = String(!!s.enabled);
    $('mode').value = s.mode || 'blur';
    $('sensitivity').value = String(s.sensitivity || 3);
    $('sensitivity-label').textContent = SENS_LABEL[s.sensitivity || 3] || '标准';
    $('imageSkinThreshold').value = String(s.imageSkinThreshold || 0.52);
    $('skin-label').textContent = Number(s.imageSkinThreshold || 0.52).toFixed(2);
    $('minTextLength').value = String(s.minTextLength || 2);
    $('dupMode').value = s.dupMode || 'safe';
    $('badgePosition').value = s.badgePosition || 'bottom-right';

    $('filterPorn').checked = !!s.filterPorn;
    $('filterSpam').checked = !!s.filterSpam;
    $('filterJunk').checked = !!s.filterJunk;
    $('filterImages').checked = !!s.filterImages;
    $('imageScan').checked = !!s.imageScan;
    $('pageGuard').checked = !!s.pageGuard;
    $('showBadge').checked = !!s.showBadge;
    $('blockThirdPartyAds').checked = !!s.blockThirdPartyAds;

    $('whitelist').value = arrayToLines(s.whitelist);
    $('blockedDomains').value = arrayToLines(s.blockedDomains);
    $('customPornKeywords').value = arrayToLines(s.customPornKeywords);
    $('customSpamKeywords').value = arrayToLines(s.customSpamKeywords);
    $('customAllowKeywords').value = arrayToLines(s.customAllowKeywords);
    renderReportSummary(s);
  }

  function renderReportSummary(s) {
    const keywords = (s.customAllowKeywords || []).length;
    const images = (s.imageAllowlist || []).length;
    const el = $('report-summary');
    if (!el) return;
    el.textContent = keywords + images === 0
      ? '误报记录：暂无（在网页右下角角标点「误报」即可纠正误伤）'
      : '误报记录：白名单词 ' + keywords + ' 条、图片 ' + images + ' 张';
  }

  function collect() {
    return {
      enabled: $('enabled').value === 'true',
      mode: $('mode').value,
      sensitivity: Number($('sensitivity').value) || 3,
      imageSkinThreshold: Number($('imageSkinThreshold').value) || 0.52,
      minTextLength: Math.max(1, Number($('minTextLength').value) || 2),
      dupMode: $('dupMode').value,
      badgePosition: $('badgePosition').value,
      filterPorn: $('filterPorn').checked,
      filterSpam: $('filterSpam').checked,
      filterJunk: $('filterJunk').checked,
      filterImages: $('filterImages').checked,
      imageScan: $('imageScan').checked,
      pageGuard: $('pageGuard').checked,
      showBadge: $('showBadge').checked,
      blockThirdPartyAds: $('blockThirdPartyAds').checked,
      whitelist: linesToArray($('whitelist').value),
      blockedDomains: linesToArray($('blockedDomains').value),
      customPornKeywords: linesToArray($('customPornKeywords').value),
      customSpamKeywords: linesToArray($('customSpamKeywords').value),
      customAllowKeywords: linesToArray($('customAllowKeywords').value)
    };
  }

  /* ---------------- 规则测试器 ---------------- */
  function renderBuiltin() {
    const K = Engine.KEYWORDS;
    const rows = [
      ['色情（强）', K.PORN_STRONG.length],
      ['擦边（弱）', K.PORN_WEAK.length],
      ['垃圾广告（强）', K.SPAM_STRONG.length],
      ['推广（弱）', K.SPAM_WEAK.length],
      ['低置信信号（需叠加）', K.SPAM_HINTS.length],
      ['灌水无效', K.JUNK_WEAK.length],
      ['联系方式/结构规则', Engine.CONTACT_PATTERNS.length],
      ['内置拦截域名', Engine.DEFAULT_BLOCKED_DOMAINS.length]
    ];
    $('builtin-stats').innerHTML = rows
      .map(([label, n]) => '<span>' + label + '：<b>' + n + '</b></span>')
      .join('');
    $('builtin-porn').textContent = K.PORN_STRONG.concat(K.PORN_WEAK).join(' · ');
    $('builtin-spam').textContent = K.SPAM_STRONG.concat(K.SPAM_WEAK).join(' · ');
    $('builtin-hints').textContent = K.SPAM_HINTS.join(' · ');
    $('builtin-junk').textContent = K.JUNK_WEAK.join(' · ');
  }

  function runTest() {
    const text = $('test-input').value || '';
    const result = $('test-result');
    if (!text.trim()) {
      result.className = 'result';
      result.textContent = '请先输入要测试的文本。';
      return;
    }
    const merged = Object.assign({}, settings, collect());
    const scanner = Engine.createScanner(merged);
    const verdict = scanner.scanText(text, { isContentBlock: true });
    const th = scanner.thresholds;
    const actionText = verdict.action === 'hide' ? '折叠 / 隐藏'
      : verdict.action === 'soft' ? '模糊处理' : '放行';
    result.className = 'result ' + verdict.action;
    result.textContent = [
      '判定：' + actionText,
      '风险分：' + verdict.score + '（模糊阈值 ' + th.soft + ' / 折叠阈值 ' + th.block + '）',
      '命中类别：' + (verdict.category === 'none' ? '无' : verdict.category),
      '命中原因：' + (verdict.reasons.length ? verdict.reasons.join('、') : '无')
    ].join('\n');
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    $('sensitivity').addEventListener('input', () => {
      $('sensitivity-label').textContent = SENS_LABEL[Number($('sensitivity').value)] || '标准';
    });
    $('imageSkinThreshold').addEventListener('input', () => {
      $('skin-label').textContent = Number($('imageSkinThreshold').value).toFixed(2);
    });

    $('clear-reports').addEventListener('click', async () => {
      if (!confirm('清空所有误报记录？清空后这些内容会重新参与过滤。')) return;
      await persist({ customAllowKeywords: [], imageAllowlist: [] }, true);
      fill(settings);
      toast('已清空误报记录');
    });

    $('save').addEventListener('click', async () => {
      const next = await persist(collect());
      fill(Object.assign({}, settings, next));
      if (next.blockThirdPartyAds) {
        chrome.runtime.sendMessage({ type: 'CF_SET_AD_RULESET', enabled: true }, () => void chrome.runtime.lastError);
      } else {
        chrome.runtime.sendMessage({ type: 'CF_SET_AD_RULESET', enabled: false }, () => void chrome.runtime.lastError);
      }
    });

    $('reset').addEventListener('click', async () => {
      if (!confirm('确定要恢复全部默认设置吗？自定义词库与白名单将被清空。')) return;
      await persist(Object.assign({}, Engine.DEFAULT_SETTINGS), true);
      fill(settings);
      toast('已恢复默认设置');
    });

    $('export').addEventListener('click', () => {
      const data = JSON.stringify(settings, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'jingwang-settings.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('配置已导出');
    });

    $('import').addEventListener('change', (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (!parsed || typeof parsed !== 'object') throw new Error('格式不正确');
          await persist(Object.assign({}, Engine.DEFAULT_SETTINGS, parsed), true);
          fill(settings);
          toast('配置已导入');
        } catch (e) {
          toast('导入失败：' + e.message);
        }
      };
      reader.readAsText(file, 'utf-8');
      ev.target.value = '';
    });

    $('run-test').addEventListener('click', runTest);
    $('test-sample').addEventListener('click', () => {
      $('test-input').value = '加微信 vx8899 免费领取内部资源，日赚千元，稳赚不赔！！！\n详情点击 http://spam.top/abc 进群领取';
      runTest();
    });
  }

  /* ---------------- 初始化 ---------------- */
  (async function init() {
    settings = await getSettings();
    fill(settings);
    renderBuiltin();
    bind();

    // 自动保存常用控件（下拉 / 滑块 / 复选）
    document.querySelectorAll('select, input[type="checkbox"], input[type="range"], input[type="number"]').forEach((el) => {
      el.addEventListener('change', () => persist(collect(), true));
    });

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[KEY]) return;
        settings = Object.assign({}, Engine.DEFAULT_SETTINGS, changes[KEY].newValue || {});
        fill(settings);
      });
    } catch (e) { /* 忽略 */ }
  })();
})();
