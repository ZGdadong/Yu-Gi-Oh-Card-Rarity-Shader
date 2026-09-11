// 取景器：把某个预设 / 罕贵度渲染成 PNG，便于肉眼比对。
//
// 用法：
//   node tools/shot.mjs                       → 默认（面闪）
//   node tools/shot.mjs UR                    → 按罕贵度代码
//   node tools/shot.mjs --preset 5            → 按预设序号
//   node tools/shot.mjs SER --time 7 --out ser
//   node tools/shot.mjs --sheet               → 一览模式
//
// 输出到 tools/.cache/。

import { chromium } from 'playwright-core';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outDir = resolve(here, '.cache');
mkdirSync(outDir, { recursive: true });

const argv = process.argv.slice(2);
const VALUE_FLAGS = ['time', 'out', 'preset', 'w', 'h', 'card', 'lang'];
function flag(name, def) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.indexOf(a.slice(2)) >= 0) i++;
    continue;
  }
  positional.push(a);
}
const want = positional[0] || '';
const outName = String(flag('out', want ? String(want).toLowerCase().replace(/[^a-z0-9]/gi, '') : 'shot'));
const t = parseFloat(flag('time', '6'));
const W = parseInt(flag('w', '1280'), 10);
const H = parseInt(flag('h', '860'), 10);
const presetIdx = flag('preset', null);
const sheet = !!flag('sheet', false);
const panelOpen = !!flag('panel', false);
const CARD_IDX = flag('card', null) === null ? null : parseInt(flag('card', '0'), 10);
const LANG = flag('lang', null);

const url = pathToFileURL(resolve(projectRoot, 'index.html')).href;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });
if (panelOpen) await page.evaluate(() => document.getElementById('app').classList.add('panel-open'));

const info = await page.evaluate(async ([want, t, presetIdx, sheet, CARD_IDX, LANG]) => {
  const p = window.cardShader;
  const CFG = window.CardConfig;
  const RAR = window.CardRarities;
  p.setPlaying(false);
  p.setMouseOutside();
  p.resize(document.getElementById('stage').getBoundingClientRect().width,
    document.getElementById('stage').getBoundingClientRect().height, 1);

  if (sheet) {
    p.resetParams();
    p.setParams({ sheetOn: 1 });
  } else if (presetIdx !== null) {
    p.resetParams();
    p.setParams(CFG.PRESETS[parseInt(presetIdx, 10)].patch);
  } else if (want) {
    const idx = RAR.ORDER.indexOf(String(want).toUpperCase());
    const byCode = RAR.LIST.findIndex((r) => r.code.toUpperCase() === String(want).toUpperCase());
    const use = idx >= 0 ? idx : byCode;
    if (use < 0) throw new Error('找不到罕贵度: ' + want);
    p.resetParams();
    p.setParams({ rarity: use, cardSize: 0.88 });
  }
  // 面板读数同步
  document.querySelectorAll('#panel input[type=range]').forEach((i) => i.dispatchEvent(new Event('input', { bubbles: true })));
  document.querySelectorAll('#panel input[type=checkbox]').forEach((i) => i.dispatchEvent(new Event('change', { bubbles: true })));
  document.querySelectorAll('#panel select').forEach((i) => i.dispatchEvent(new Event('change', { bubbles: true })));
  if (CARD_IDX !== null) p.setParam('card', CARD_IDX);
  if (LANG) await window.cardShaderUI.setLang(LANG);
  p.renderAtTime(t);
  const info = p.currentRarityInfo();
  return {
    code: info.code, cn: info.cn,
    shaders: p.activeShaders(), passes: p.passCount(),
    stats: p.stats(), card: p.cardRegionStats()
  };
}, [want, t, presetIdx, sheet, CARD_IDX, LANG]);

console.log('罕贵度 :', info.code, info.cn);
console.log('图层   :', info.shaders.join(' → '), `(${info.passes} draw steps)`);
console.log('画面   : mean', info.stats.mean.toFixed(1), '· 亮部', (info.stats.brightRatio * 100).toFixed(2) + '%');
console.log('卡片区 : mean', info.card.mean.toFixed(1), '· 亮部', (info.card.brightRatio * 100).toFixed(2) + '%',
  '· 饱和', info.card.satMean.toFixed(1), '· 区域', info.card.w + '×' + info.card.h);

const out = resolve(outDir, outName + '.png');
await page.screenshot({ path: out });
console.log('→', out);

await browser.close();
