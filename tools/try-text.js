/**
 * 命令行为文本跑一遍过滤规则，便于调参和复现误判/漏判。
 * 用法：
 *   node tools/try-text.js "加微信 vx123456 免费领取"
 *   node tools/try-text.js --sensitivity 5 "擦边文案"
 *   echo "多行文本" | node tools/try-text.js --stdin
 */
'use strict';

const Engine = require('../src/common/filter-engine.js');

const argv = process.argv.slice(2);
let sensitivity = 3;
const texts = [];

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--sensitivity' || argv[i] === '-s') {
    sensitivity = Number(argv[++i]) || 3;
  } else if (argv[i] === '--stdin') {
    texts.push(...require('fs').readFileSync(0, 'utf8').split('\n'));
  } else {
    texts.push(argv[i]);
  }
}

if (!texts.length) {
  console.error('用法: node tools/try-text.js [--sensitivity 1-5] "文本" ...');
  process.exit(1);
}

const settings = Object.assign({}, Engine.DEFAULT_SETTINGS, { sensitivity });
const scanner = Engine.createScanner(settings);
const th = scanner.thresholds;

const LABEL = { hide: '折叠隐藏', soft: '模糊处理', pass: '放行' };
const ICON = { hide: '🛑', soft: '🟡', pass: '✅' };

console.log(`敏感度 ${th.sensitivity}｜模糊阈值 ${th.soft}｜折叠阈值 ${th.block}\n`);
console.log('判定      分数  原因                                    文本');
console.log('-'.repeat(96));

let hidden = 0;
for (const text of texts) {
  const clean = String(text).trim();
  if (!clean) continue;
  const r = scanner.scanText(clean, { isContentBlock: true });
  if (r.action === 'hide') hidden++;
  const reason = (r.reasons.join('、') || '—').slice(0, 38);
  console.log(
    `${ICON[r.action]} ${LABEL[r.action].padEnd(4)} ${String(r.score).padStart(4)}  ${reason.padEnd(38)}  ${clean.slice(0, 40)}`
  );
}

console.log('-'.repeat(96));
console.log(`共 ${texts.filter((t) => String(t).trim()).length} 条，其中 ${hidden} 条会被折叠。`);
console.log('\n去重指纹（同指纹的文本会被判定为重复刷屏）：');
for (const text of texts) {
  const clean = String(text).trim();
  if (!clean) continue;
  console.log(`  ${Engine.dupKey(clean)}   ← ${clean.slice(0, 30)}`);
}
