/**
 * 过滤引擎单元测试
 * 运行：node --test tests/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/common/filter-engine.js');

const BASE = Object.assign({}, Engine.DEFAULT_SETTINGS);

function scan(text, patch) {
  const scanner = Engine.createScanner(Object.assign({}, BASE, patch || {}));
  return scanner.scanText(text, { isContentBlock: true });
}

/* ---------------- 色情内容 ---------------- */
test('强烈色情词直接判定为隐藏', () => {
  const r = scan('这里有大量色情视频免费观看');
  assert.equal(r.action, 'hide');
  assert.ok(r.category.includes('porn'));
  assert.ok(r.score >= 12);
});

test('英文色情词命中（带词边界）', () => {
  assert.equal(scan('best porn site ever').action, 'hide');
  assert.equal(scan('watch hentai online now').action, 'hide');
  // 不应因为包含 "porn" 子串而误伤正常单词
  assert.equal(scan('The pornography exhibition is a documentary').action, 'hide'); // 词库含 pornography
  assert.equal(scan('I visited Sussex last summer').action, 'pass');
  assert.equal(scan('This essay is about sexism in media').action, 'pass');
});

test('擦边词累积后触发模糊而非直接隐藏', () => {
  const r = scan('深夜福利 大尺度 未删减');
  assert.notEqual(r.action, 'pass');
  assert.ok(r.score >= 5);
});

/* ---------------- 垃圾广告 ---------------- */
test('典型引流广告被过滤', () => {
  const r = scan('加微信 vx889900 免费领取内部资源，日赚千元');
  assert.equal(r.action, 'hide');
  assert.ok(r.category.includes('spam'));
});

test('手机号 / 群号等联系方式被识别', () => {
  assert.notEqual(scan('联系电话：13812345678').action, 'pass');
  assert.notEqual(scan('交流群号 887766554').action, 'pass');
});

test('全角与混淆写法仍可识别', () => {
  const r = scan('加微信：ＡＢＣ１２３４５');
  assert.notEqual(r.action, 'pass');
});

test('可疑域名后缀链接加权', () => {
  const r = scan('资源在这里 http://example.top/abc');
  assert.notEqual(r.action, 'pass');
});

/* ---------------- 正常内容不应误伤 ---------------- */
test('正常语句放行', () => {
  assert.equal(scan('今天天气不错，我们一起去公园散步吧').action, 'pass');
  assert.equal(scan('公司发布了第三季度财务报告，营收同比增长 12%').action, 'pass');
  assert.equal(scan('如何正确地教育孩子保护自己').action, 'pass');
});

test('白名单词可以纠正误伤', () => {
  const text = '性教育课程应当包含色情内容的危害说明';
  assert.equal(scan(text).action, 'hide');
  const r = scan(text, { customAllowKeywords: ['性教育'] });
  assert.equal(r.action, 'pass');
  assert.ok(r.reasons.join('').includes('白名单词'));
});

test('过短文本不参与过滤', () => {
  // “色情”仅 2 个字符：最短长度设为 3 时应放行，设为 2 时应拦截
  assert.equal(scan('色情', { minTextLength: 3 }).action, 'pass');
  assert.equal(scan('色情', { minTextLength: 2 }).action, 'hide');
});

test('弱词库最多累计两条，避免正常营销词堆叠被误拦', () => {
  // 三个弱推广词：只累计两条（6 分）-> 不到折叠阈值，仅模糊
  const r = scan('限时特价 秒杀 清仓甩卖');
  assert.equal(r.action, 'soft');
  // 叠加联系方式后达到折叠阈值
  const r2 = scan('限时特价 秒杀 清仓甩卖 联系电话 13812345678');
  assert.equal(r2.action, 'hide');
});

/* ---------------- 灌水 / 结构特征 ---------------- */
test('灌水词触发模糊', () => {
  const r = scan('沙发 前排 打卡');
  assert.notEqual(r.action, 'pass');
});

test('结构噪声叠加触发隐藏', () => {
  const r = scan('FREE MONEY NOW!!!!! http://a.top http://b.top http://c.top 点击领取');
  assert.equal(r.action, 'hide');
});

test('敏感度越高阈值越低', () => {
  const loose = Engine.thresholdsFor({ sensitivity: 1 });
  const strict = Engine.thresholdsFor({ sensitivity: 5 });
  assert.ok(strict.block < loose.block);
  assert.ok(strict.soft <= loose.soft);
  assert.ok(strict.imageSkin < loose.imageSkin);
});

/* ---------------- 域名拦截 ---------------- */
test('域名后缀匹配正确且不误伤相似域名', () => {
  const scanner = Engine.createScanner(BASE);
  assert.equal(scanner.isBlockedDomain('www.pornhub.com'), true);
  assert.equal(scanner.isBlockedDomain('m.pornhub.com'), true);
  assert.equal(scanner.isBlockedDomain('pornhub.com'), true);
  assert.equal(scanner.isBlockedDomain('notpornhub.com'), false);
  assert.equal(scanner.isBlockedDomain('pornhub.com.evil.net'), false);
  assert.equal(scanner.isBlockedDomain('example.com'), false);
});

test('用户可以自定义拦截域名', () => {
  const scanner = Engine.createScanner(Object.assign({}, BASE, { blockedDomains: ['spam-site.example'] }));
  assert.equal(scanner.isBlockedDomain('www.spam-site.example'), true);
});

/* ---------------- 图片肤色分析 ---------------- */
function makeImage(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = pixel(x, y);
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  return data;
}

test('大面积平滑肤色被判为可疑', () => {
  const data = makeImage(100, 100, (x, y) => [205 + ((x + y) % 7), 152, 128]);
  const analysis = Engine.skinScore(data, 100, 100);
  assert.ok(analysis.skinRatio > 0.8, `肤色占比应很高，实际 ${analysis.skinRatio}`);
  assert.equal(Engine.shouldBlurImage(analysis, BASE), true);
});

test('自然风景/彩色图像不被误判', () => {
  const data = makeImage(100, 100, (x, y) => {
    const band = Math.floor(y / 10) % 3;
    if (band === 0) return [40, 90, 200];   // 天空
    if (band === 1) return [60, 160, 70];   // 草地
    return [220, 225, 235];                 // 云
  });
  const analysis = Engine.skinScore(data, 100, 100);
  assert.ok(analysis.skinRatio < 0.35, `肤色占比应较低，实际 ${analysis.skinRatio}`);
  assert.equal(Engine.shouldBlurImage(analysis, BASE), false);
});

test('人脸大小的少量肤色不至于触发', () => {
  // 中间 30% 区域为肤色，其余为背景
  const data = makeImage(100, 100, (x, y) => {
    const inside = x > 35 && x < 65 && y > 20 && y < 55;
    return inside ? [210, 160, 135] : [30, 34, 40];
  });
  const analysis = Engine.skinScore(data, 100, 100);
  assert.equal(Engine.shouldBlurImage(analysis, BASE), false);
});

/* ---------------- 工具函数 ---------------- */
test('文本归一化处理全角、零宽字符与大小写', () => {
  assert.equal(Engine.normalizeText('ＡＢＣ　１２３'), 'abc 123');
  assert.equal(Engine.normalizeText('微信\u200B号'), '微信号');
  assert.equal(Engine.compactText('微 信 : a_b-1'), '微信ab1');
});
