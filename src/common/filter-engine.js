/**
 * 净网助手 · 核心过滤引擎 (filter-engine.js)
 * ------------------------------------------------------------
 * 纯本地、无依赖、可离线运行。同时支持三种加载方式：
 *   1. 浏览器 content script / popup / options  -> 挂载到 window.CFEngine
 *   2. Service Worker                          -> importScripts() 后使用 self.CFEngine
 *   3. Node.js (单元测试)                       -> module.exports
 *
 * 设计原则：
 *   - 所有判断都在本地完成，不上传任何页面内容、URL 或图片。
 *   - 只做“建议 + 可撤销”的处理：默认模糊/折叠，用户随时可以点开。
 *   - 规则分层：强烈色情 / 暗示色情 / 硬广垃圾 / 联系方式 / 无效灌水 / 结构特征。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CFEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  /* ============================================================
   * 1. 默认设置
   * ============================================================ */
  const DEFAULT_SETTINGS = {
    enabled: true,
    filterPorn: true,
    filterSpam: true,
    filterJunk: true,
    filterImages: true,
    pageGuard: true,          // 整页拦截高风险站点
    imageScan: true,          // 是否下载并分析图片像素
    sensitivity: 3,           // 1(宽松) ~ 5(严格)
    mode: 'hide',              // hide=标准(强命中折叠) | blur=温和(仅模糊不折叠)
    imageSkinThreshold: 0.52, // 图片肤色占比阈值
    showBadge: true,          // 页面右下角统计角标
    badgePosition: 'bottom-right',
    minTextLength: 2,         // 短于该长度不参与关键词过滤（防误伤，“沙发”等 2 字灌水词要能覆盖）
    blockThirdPartyAds: false,// 是否启用 DNR 广告域名拦截规则集
    whitelist: [],            // 站点白名单（域名或子域）
    blockedDomains: [],       // 用户自定义拦截域名
    customPornKeywords: [],
    customSpamKeywords: [],
    customAllowKeywords: [],  // 白名单词：命中则大幅降分
    maxBlocksPerPage: 1500
  };

  /* ============================================================
   * 2. 词库
   * ============================================================ */

  // 强烈色情（命中即拦截）
  const PORN_STRONG = [
    // 中文
    '色情', '色情片', '淫秽', '淫乱', '淫妻', '淫水', '黄片', '黄图', '黄网站', '黄色网站', '黄色视频',
    '成人电影', '成人视频', '成人网站', '成人内容', '成人论坛', '成人小说', '情色', '色诱', '涩情',
    '无码', '有码', '里番', '肉番', '本子', '工口', 'h漫', 'h文',
    '做爱', '性交', '性爱', '口交', '肛交', '群交', '乱伦', '兽交', '自慰', '撸管', '打飞机',
    '裸聊', '裸播', '裸舞', '脱衣舞', '约炮', '约啪', '一夜情', '援交', '卖淫', '嫖娼', '妓女', '楼凤',
    '福利姬', '探花视频', '偷拍视频', '迷奸', '春药', '催情', '三级片', '激情小说', '情色小说',
    '幼齿', '萝莉资源', '破处', '内射', '颜射', '群p', '搞黄色', '搞黄', '看黄', '涉黄',
    // 英文（加词边界，避免 sussex / sexism 之类误伤）
    'porn', 'porno', 'pornography', 'xxx', 'xxxx', 'nude', 'nudes', 'naked girls', 'hentai',
    'milf', 'blowjob', 'handjob', 'cumshot', 'creampie', 'gangbang', 'orgy', 'bdsm', 'erotica',
    'camgirl', 'escort service', 'onlyfans', 'nsfw porn', 'javbus', 'javhd', 'avgle', 'missav',
    'xvideo', 'xvideos', 'xhamster', 'pornhub', 'redtube', 'youporn', 'spankbang', 'eporner',
    'chaturbate', 'stripchat', 'livejasmin', 'bongacams', 'cam4', 'fapello', 'rule34', 'nhentai'
  ];

  // 暗示 / 擦边（需要累计分数）
  const PORN_WEAK = [
    '涩涩', '瑟瑟', '色色', '美女裸', '大尺度', '无删减', '未删减', '福利视频', '深夜福利', '福利群',
    '激情视频', '激情聊天', '视频聊天室', '一对一视频', '同城交友', '同城约', '附近的人', '附近约',
    '情趣', '性感女主播', '美女主播', '私密直播', '成人app', '成人版', '解锁姿势', '老司机资源',
    '磁力链接', '种子下载', '无圣光', '无修版', '抢版', '里世界',
    'nsfw', 'adult video', 'adult chat', 'sex chat', 'sexcam', 'sexting', 'sexy girls',
    'hot girls', 'cam2cam', 'hookup', 'sugar baby', 'sugar daddy', 'only fan', 'leaked nudes'
  ];

  // 硬广 / 诈骗垃圾
  const SPAM_STRONG = [
    '加微信', '加微信好友', '加我微信', '加个微信', '加qq', '加扣扣', '扫码加', '扫码进群', '扫码领取',
    '扫码关注', '扫码下载', '长按识别', '识别二维码', '进群领取', '进群免费', '免费领取', '点击领取',
    '限时领取', '私聊我', '私信我', '详询', '咨询办理', '代办', '代开发票', '正规发票', '办证',
    '无抵押贷款', '贷款秒批', '秒下款', '黑户贷款', '征信修复', '刷单', '刷好评', '兼职日结',
    '打字员兼职', '手机兼职', '日赚', '日入', '月入过万', '轻松赚钱', '稳赚不赔', '包赚', '躺赚',
    '内部渠道', '一手货源', '厂家直销', '招代理', '代理加盟', '微商', '博彩', '赌场', '真人荷官',
    '时时彩', '六合彩', '北京赛车', 'pk10', '澳门银河', '太阳城', '威尼斯人', '在线赌', '棋牌室',
    '薅羊毛', '羊毛党', '返利机器人', '优惠券群', '0元购', '免费送', '免费试用', '点赞返现',
    '推荐股票', '股票群', '带单', '喊单', '区块链搬砖', '虚拟币带单', '炒币群', '挖矿机',
    'viagra', 'cialis', 'levitra', 'casino bonus', 'online casino', 'sports betting', 'betting site',
    'buy followers', 'buy cheap meds', 'work from home and earn', 'make money fast', 'double your bitcoin',
    'click here to win', 'you have won', 'winner selected', 'limited time offer act now'
  ];

  // 软广 / 引流（低权重）
  const SPAM_WEAK = [
    '广告', '推广', '赞助商', '商务合作', '推广位', '软文', '带货', '直播间', '秒杀', '清仓', '甩卖',
    '限时特价', '内部价', '扫码', '下载app', '打开app', '立即下载', '点击下载', '点击查看详情',
    '更多精彩内容', '更多福利', '戳这里', '点这里', '看这里', '往下看', '评论区见',
    'sponsored', 'promoted', 'advertisement', 'affiliate link', 'download our app', 'install now'
  ];

  // 无效 / 灌水信息
  const JUNK_WEAK = [
    '沙发', '板凳', '地板', '前排', '占楼', '留名', '路过', '打酱油', '火钳刘明', '顶一下', '顶起',
    '已阅', '打卡', '签到', '灌水', '水贴', '纯属路过', '拿分走人', '赚积分', '回帖赚分', '支持一下',
    '学习了', '谢谢分享', '收藏了', 'make一下', '马克', 'mark', 'first', 'bump', 'upup', 'nice post',
    'good post', 'thanks for sharing'
  ];

  // 正则型特征：联系方式与黑话变体（在“压缩文本”上匹配，抗空格/符号混淆）
  const CONTACT_PATTERNS = [
    { re: /(微信|vx|wx|v信|威信|薇信|徽信|唯信|微❤|微信号|加v|加威)\s*[:：号]?\s*[a-z0-9_\-]{5,}/i, weight: 9, label: '微信号' },
    { re: /(qq|扣扣|企鹅)\s*[:：号]?\s*[1-9]\d{4,11}/i, weight: 9, label: 'QQ号' },
    { re: /(电报|telegram|tg|纸飞机)\s*[:：群@]?\s*[a-z0-9_]{4,}/i, weight: 8, label: 'Telegram' },
    { re: /(?:\+?86[-\s]?)?1[3-9]\d{9}/, weight: 6, label: '手机号' },
    { re: /(电话|手机|联系方式|tel)\s*[:：]?\s*[\d\-()\s]{7,}/i, weight: 6, label: '电话' },
    { re: /(加群|群号|进群|交流群|福利群|资源群)\s*[:：]?\s*\d{5,}/i, weight: 8, label: '群号' },
    { re: /https?:\/\/[^\s]*(?:\.top|\.xyz|\.vip|\.cc|\.tk|\.ml|\.ga|\.cf|\.gq|\.buzz|\.click|\.link|\.work|\.loan|\.win|\.bid|\.stream|\.download|\.racing|\.review|\.date|\.party|\.science|\.men|\.kim)/i, weight: 7, label: '可疑域名' },
    { re: /(?:https?:\/\/[^\s]+){3,}/i, weight: 6, label: '链接堆砌' }
  ];

  // 结构性噪声特征
  const STRUCTURE_RULES = [
    { id: 'bang', test: (t) => (t.match(/[!！?？]{2,}/g) || []).length, weightEach: 3, cap: 9, label: '感叹号堆砌' },
    { id: 'repeat', test: (t) => (t.match(/(.)\1{5,}/g) || []).length, weightEach: 3, cap: 6, label: '字符重复' },
    { id: 'emoji', test: (t) => (t.match(/\p{Extended_Pictographic}/gu) || []).length >= 8 ? 1 : 0, weightEach: 4, cap: 4, label: '表情刷屏' },
    { id: 'caps', test: (t) => (t.length > 12 && (t.match(/[A-Z]/g) || []).length / Math.max(1, (t.match(/[A-Za-z]/g) || []).length) > 0.7) ? 1 : 0, weightEach: 3, cap: 3, label: '全大写' },
    { id: 'digits', test: (t) => (t.match(/\d{11,}/g) || []).length >= 1 ? 1 : 0, weightEach: 4, cap: 4, label: '长数字串' }
  ];

  // 常见高风险站点（可被用户白名单覆盖）
  const DEFAULT_BLOCKED_DOMAINS = [
    // 成人站点
    'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com',
    'spankbang.com', 'eporner.com', 'beeg.com', 'tnaflix.com', 'hqporner.com', 'porntrex.com',
    'chaturbate.com', 'stripchat.com', 'livejasmin.com', 'bongacams.com', 'cam4.com',
    'missav.com', 'avgle.com', 'javbus.com', 'javhd.com', 'javmost.com', 'supjav.com',
    'hanime.tv', 'nhentai.net', 'rule34.xxx', 'e-hentai.org', 'exhentai.org', 'asmhentai.com',
    'onlyfans.com', 'fapello.com', 'thothub.tv', 'erome.com', 'thisvid.com', 'heavy-r.com',
    // 典型垃圾/跳转推广
    'adf.ly', 'sh.st', 'ouo.io', 'adfoc.us', 'bc.vc', 'shortzon.com', 'clk.sh', 'fc.lc'
  ];

  /* ============================================================
   * 3. 工具函数
   * ============================================================ */

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 全角转半角 + 归一化空白 + 小写 */
  function normalizeText(input) {
    if (!input) return '';
    let s = String(input);
    // 全角 ASCII -> 半角
    s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
    // 全角空格
    s = s.replace(/\u3000/g, ' ');
    // 去掉零宽字符与常见混淆符号
    s = s.replace(/[\u200B-\u200F\uFEFF\u2060]/g, '');
    // 折叠空白
    s = s.replace(/\s+/g, ' ').trim();
    return s.toLowerCase();
  }

  /** 进一步压缩：去掉所有分隔符号，用于识别 “微 信 : abc_123” 这类混淆 */
  function compactText(input) {
    return normalizeText(input).replace(/[\s._\-*~^·:：,，。.、|/\\()[\]{}<>"'`+＋@#!！?？]/g, '');
  }

  const CN_CHAR = /[\u4e00-\u9fff]/;

  function makeKeywordRules(list, weight, label) {
    return (list || []).filter(Boolean).map((kw) => {
      const raw = String(kw).trim();
      if (!raw) return null;
      const isLatin = /^[a-z0-9][a-z0-9 '\-]*$/i.test(raw);
      const body = escapeRegExp(raw).replace(/\s+/g, '\\s*');
      const pattern = isLatin ? '(?<![a-z0-9])' + body + '(?![a-z0-9])' : body;
      return { re: new RegExp(pattern, 'i'), weight, label, keyword: raw };
    }).filter(Boolean);
  }

  /* ============================================================
   * 4. Scanner：按设置编译规则并打分
   * ============================================================ */

  function thresholdsFor(settings) {
    const s = clamp(Number(settings.sensitivity) || 3, 1, 5);
    // 严格度越高 -> 阈值越低
    const block = 14 - s * 2;        // s=1 ->12, s=3 ->8, s=5 ->4
    const soft = Math.max(3, block - 5);
    const imageTh = clamp((Number(settings.imageSkinThreshold) || 0.52) - (s - 3) * 0.05, 0.25, 0.9);
    return { block, soft, imageSkin: imageTh, sensitivity: s };
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function createScanner(settings, blockedDomains) {
    const cfg = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const th = thresholdsFor(cfg);
    const allowRules = makeKeywordRules(cfg.customAllowKeywords, 6, '白名单词');

    const pornStrong = cfg.filterPorn
      ? makeKeywordRules(PORN_STRONG.concat(cfg.customPornKeywords), 12, '色情内容')
      : [];
    const pornWeak = cfg.filterPorn
      ? makeKeywordRules(PORN_WEAK, 5, '擦边内容')
      : [];
    const spamStrong = cfg.filterSpam
      ? makeKeywordRules(SPAM_STRONG.concat(cfg.customSpamKeywords), 10, '垃圾广告')
      : [];
    const spamWeak = cfg.filterSpam ? makeKeywordRules(SPAM_WEAK, 3, '推广信息') : [];
    const junkWeak = cfg.filterJunk ? makeKeywordRules(JUNK_WEAK, 3, '灌水信息') : [];
    const contactRules = (cfg.filterSpam || cfg.filterPorn)
      ? CONTACT_PATTERNS.map((p) => ({ re: p.re, weight: p.weight, label: p.label }))
      : [];
    const domainList = (blockedDomains || []).concat(DEFAULT_BLOCKED_DOMAINS)
      .concat(cfg.blockedDomains || [])
      .map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
      .filter(Boolean);

    /**
     * 对一段文本打分
     * @param {string} text
     * @param {{isContentBlock?:boolean}} ctx
     * @returns {{score:number, reasons:string[], action:'pass'|'soft'|'hide', category:string}}
     */
    function scanText(text, ctx) {
      const options = ctx || {};
      const result = { score: 0, reasons: [], action: 'pass', category: 'none' };
      if (!text) return result;

      const normalized = normalizeText(text);
      const compact = compactText(text);
      const characters = normalized.replace(/\s/g, '').length;
      if (characters < cfg.minTextLength) return result;

      let score = 0;
      const reasons = [];
      const categories = new Set();

      /**
       * 逐条规则计分。
       * 强词库允许全部累计（命中即已判定）；弱词库最多累计 maxHits 条，
       * 避免“限时特价 / 秒杀”这类正常营销词堆叠后被误拦。
       */
      const hitKeyword = (rules, cat, maxHits) => {
        let hits = 0;
        for (const rule of rules) {
          if (rule.re.test(normalized) || rule.re.test(compact)) {
            score += rule.weight;
            categories.add(cat);
            const reason = rule.keyword ? rule.label + '(' + rule.keyword + ')' : rule.label;
            if (reasons.indexOf(reason) === -1) reasons.push(reason);
            if (rule.weight >= 12) result.strong = true;
            hits++;
            if (hits >= (maxHits || Infinity)) break;
          }
        }
        return hits > 0;
      };

      hitKeyword(pornStrong, 'porn');
      hitKeyword(pornWeak, 'porn', 2);
      hitKeyword(spamStrong, 'spam');
      hitKeyword(spamWeak, 'spam', 2);
      hitKeyword(junkWeak, 'junk', 2);

      for (const rule of contactRules) {
        if (rule.re.test(normalized) || rule.re.test(compact)) {
          score += rule.weight;
          categories.add('spam');
          if (reasons.indexOf(rule.label) === -1) reasons.push(rule.label);
        }
      }

      if (options.isContentBlock) {
        for (const rule of STRUCTURE_RULES) {
          const hits = rule.test(normalized) || 0;
          if (hits > 0) {
            score += Math.min(rule.cap, hits * rule.weightEach);
            if (reasons.indexOf(rule.label) === -1) reasons.push(rule.label);
          }
        }
      }

      // 白名单词：命中即在该文本块内完全放行（用户自定义的纠错机制）
      for (const rule of allowRules) {
        if (rule.re.test(normalized) || rule.re.test(compact)) {
          result.score = 0;
          result.strong = false;
          result.category = 'allowed';
          result.reasons = ['白名单词：' + rule.keyword];
          result.action = 'pass';
          return result;
        }
      }

      score = Math.max(0, score);
      result.score = score;
      result.reasons = reasons;
      result.category = categories.size ? Array.from(categories).join('+') : 'none';

      if (result.strong || score >= th.block) {
        result.action = 'hide';
      } else if (score >= th.soft) {
        result.action = 'soft';
      }
      return result;
    }

    /** 域名是否在拦截列表内（后缀匹配） */
    function isBlockedDomain(hostname) {
      if (!hostname) return false;
      const host = String(hostname).toLowerCase();
      return domainList.some((d) => host === d || host.endsWith('.' + d));
    }

    /** 依据 URL / 标题判断整页风险 */
    function pageRisk(url, title) {
      const haystack = normalizeText((url || '') + ' ' + (title || ''));
      let score = 0;
      const reasons = [];
      for (const rule of pornStrong) {
        if (rule.re.test(haystack)) { score += 12; reasons.push('色情内容'); break; }
      }
      for (const rule of pornWeak) {
        if (rule.re.test(haystack)) { score += 5; reasons.push('擦边内容'); break; }
      }
      for (const rule of spamStrong) {
        if (rule.re.test(haystack)) { score += 8; reasons.push('垃圾广告'); break; }
      }
      return { score, reasons };
    }

    return {
      settings: cfg,
      thresholds: th,
      scanText,
      isBlockedDomain,
      pageRisk,
      blockedDomains: domainList,
      version: VERSION
    };
  }

  /* ============================================================
   * 5. 图片肤色启发式分析
   * ============================================================ */

  /**
   * 分析 RGBA 像素，返回疑似裸露程度 0~1
   * 思路：统计肤色像素占比 + 肤色区域的平滑度（真人皮肤通常平滑且面积大）
   * 这是纯启发式判断，只用于“先模糊、可点开”，不会删除任何内容。
   * @param {Uint8ClampedArray|Uint8Array} data
   * @param {number} width
   * @param {number} height
   */
  function skinScore(data, width, height) {
    if (!data || !width || !height) return { score: 0, skinRatio: 0, smoothness: 0, samples: 0 };
    const total = width * height;
    const step = Math.max(1, Math.floor(Math.sqrt(total / 6000))); // 约 6000 个采样点
    let samples = 0, skinCount = 0;
    let sumR = 0, sumR2 = 0, sumG = 0, sumB = 0;
    let colorful = 0;

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        samples++;
        if (a < 128) continue;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max - min > 12) colorful++;

        // 经典肤色判定（多条件并集，降低误判）
        const ruleA = r > 95 && g > 40 && b > 20 && (max - min) > 15 && Math.abs(r - g) > 15 && r > g && r > b;
        const ruleB = r > 200 && g > 190 && b > 170 && Math.abs(r - g) <= 20 && r > b && g > b;
        const ruleC = (r > 110 && r < 250) && (g > 60) && (b > 30) &&
          (r - b) > 25 && (r - b) < 130 && (r - g) > 8 && (r - g) < 90;
        const sum = r + g + b;
        const nr = r / sum, ng = g / sum;
        const ruleD = nr > 0.36 && nr < 0.52 && ng > 0.28 && ng < 0.40 && ng < nr && nr > ng;

        if (ruleA || ruleB || ruleC || ruleD) {
          skinCount++;
          sumR += r; sumR2 += r * r; sumG += g; sumB += b;
        }
      }
    }

    const skinRatio = samples ? skinCount / samples : 0;
    if (skinCount < 20 || skinRatio < 0.12) {
      return { score: 0, skinRatio, smoothness: 0, samples };
    }

    const meanR = sumR / skinCount;
    const variance = Math.max(0, sumR2 / skinCount - meanR * meanR);
    const std = Math.sqrt(variance);
    // 皮肤区域越平滑（std 小）越像是大面积裸露皮肤
    const smoothness = clamp(1 - std / 70, 0, 1);
    const colorfulness = samples ? colorful / samples : 0;

    // 面积为主，平滑度加权，画面越“彩色”越可能是正常照片而非大块肤色
    let score = skinRatio * (0.62 + 0.38 * smoothness);
    score *= (1 - 0.35 * colorfulness);
    score = clamp(score, 0, 1);

    return { score, skinRatio, smoothness, colorfulness, samples };
  }

  function shouldBlurImage(analysis, settings) {
    const th = thresholdsFor(settings || {});
    if (!analysis) return false;
    return analysis.score >= th.imageSkin;
  }

  /* ============================================================
   * 6. 导出
   * ============================================================ */
  return {
    VERSION,
    DEFAULT_SETTINGS,
    DEFAULT_BLOCKED_DOMAINS,
    KEYWORDS: {
      PORN_STRONG, PORN_WEAK, SPAM_STRONG, SPAM_WEAK, JUNK_WEAK
    },
    CONTACT_PATTERNS,
    normalizeText,
    compactText,
    thresholdsFor,
    clamp,
    createScanner,
    skinScore,
    shouldBlurImage,
    hasChinese: (s) => CN_CHAR.test(String(s || ''))
  };
});
