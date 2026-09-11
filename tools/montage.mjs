// 拼图：把一批罕贵度渲染成一张对照表（每个格子一张卡 + 标签）。
//
// 用法：
//   node tools/montage.mjs                     → 全部罕贵度，7 列
//   node tools/montage.mjs N,R,SR,UR,SER       → 指定几个
//   node tools/montage.mjs --tier base         → 只拼某个分节
//   node tools/montage.mjs --cols 4 --cell 300x420 --out base
//
// 全部在页面里完成：每个格子把 WebGL 画布按指定分辨率重画一遍再 drawImage 进拼图，
// 所以不需要任何图像库。

import { chromium } from 'playwright-core';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outDir = resolve(here, '.cache');
mkdirSync(outDir, { recursive: true });

const argv = process.argv.slice(2);
// 带值的开关名（用来把它们的值从"位置参数"里排除掉，不然 `--cols 6` 里的 6
// 会被当成罕贵度列表）
const VALUE_FLAGS = ['ids', 'tier', 'cols', 'cell', 'time', 'out', 'patch', 'maxw'];
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
const ids = String(flag('ids', positional[0] || '')).trim();
const tier = flag('tier', null);
const cols = parseInt(flag('cols', '7'), 10);
const cellSpec = String(flag('cell', '236x330')).split('x');
const CW = parseInt(cellSpec[0], 10), CH = parseInt(cellSpec[1], 10);
const t = parseFloat(flag('time', '6'));
const outName = String(flag('out', 'montage'));
const withBg = !!flag('bg', false);
const patchJson = flag('patch', null);

const url = pathToFileURL(resolve(projectRoot, 'index.html')).href;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });

const res = await page.evaluate(([ids, tier, cols, CW, CH, t, withBg, patchJson, MAXW, JPG]) => {
  const p = window.cardShader;
  const RAR = window.CardRarities;
  p.setPlaying(false);
  p.setMouseOutside();
  p.stop();

  let list;
  if (ids) {
    list = ids.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (tier) {
    list = RAR.LIST.filter((r) => r.tier === tier).map((r) => r.id);
  } else {
    list = RAR.LIST.map((r) => r.id);
  }

  const rows = Math.ceil(list.length / cols);
  const big = document.createElement('canvas');
  big.width = cols * CW;
  big.height = rows * CH;
  const bx = big.getContext('2d');
  bx.fillStyle = '#04060a';
  bx.fillRect(0, 0, big.width, big.height);

  const extra = patchJson ? JSON.parse(patchJson) : null;

  for (let i = 0; i < list.length; i++) {
    const idx = RAR.ORDER.indexOf(list[i]);
    if (idx < 0) throw new Error('未知罕贵度: ' + list[i]);
    p.resetParams();
    p.setParams(Object.assign({ rarity: idx, cardSize: 0.94, autoSway: 0.35, bgOn: withBg ? 1 : 0 }, extra || {}));
    p.resize(CW, CH, 1);
    p.renderAtTime(t);
    const gl = document.getElementById('gl');
    const c = i % cols, r = Math.floor(i / cols);
    bx.drawImage(gl, 0, 0, CW, CH, c * CW, r * CH, CW, CH);

    // 标签（画在卡片上方那条空处）
    const info = RAR.LIST[idx];
    bx.textAlign = 'center';
    bx.textBaseline = 'top';
    bx.font = '700 15px system-ui, "Microsoft YaHei", sans-serif';
    bx.fillStyle = '#eaf1ff';
    bx.fillText(info.code, c * CW + CW / 2, r * CH + 6);
    bx.font = '500 12px system-ui, "Microsoft YaHei", sans-serif';
    bx.fillStyle = 'rgba(170,190,220,0.75)';
    bx.fillText(info.cn, c * CW + CW / 2, r * CH + 24);
    bx.strokeStyle = 'rgba(255,255,255,0.06)';
    bx.strokeRect(c * CW + 0.5, r * CH + 0.5, CW - 1, CH - 1);
  }

  // 复原画布尺寸，免得影响后面
  let uri = big.toDataURL('image/png');
  // 需要缩小时再画一遍。PNG 里全是闪膜的高频细节，原尺寸能到好几 MB，进 README 太沉；
  // --jpg 再用 JPEG 编码一次（默认 PNG）。
  const fmt = JPG ? 'image/jpeg' : 'image/png';
  if ((MAXW && big.width > MAXW) || JPG) {
    const k = MAXW && big.width > MAXW ? MAXW / big.width : 1;
    const sm = document.createElement('canvas');
    sm.width = Math.round(big.width * k);
    sm.height = Math.round(big.height * k);
    const sx = sm.getContext('2d');
    sx.imageSmoothingEnabled = true;
    sx.imageSmoothingQuality = 'high';
    if (JPG) { sx.fillStyle = '#04060a'; sx.fillRect(0, 0, sm.width, sm.height); }
    sx.drawImage(big, 0, 0, sm.width, sm.height);
    uri = sm.toDataURL(fmt, 0.86);
  }
  return { dataUri: uri, n: list.length, cols: cols, rows: rows };
}, [ids, tier, cols, CW, CH, t, withBg, patchJson, parseInt(flag('maxw', '0'), 10), !!flag('jpg', false)]);

const out = resolve(outDir, /\.(png|jpg|jpeg)$/i.test(outName) ? outName : outName + (flag('jpg', false) ? '.jpg' : '.png'));
writeFileSync(out, Buffer.from(res.dataUri.split(',')[1], 'base64'));
console.log(`${res.n} 个罕贵度 · ${res.cols}×${res.rows} 格 · 每格 ${CW}×${CH} · ${(res.dataUri.length / 1024).toFixed(0)} KB`);
console.log('→', out);

await browser.close();
