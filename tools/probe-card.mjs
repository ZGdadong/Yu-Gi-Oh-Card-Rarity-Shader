// 卡图边界的定点探针：打印几条扫描线上的亮度剖面 + 导出放大的局部裁片。
//
// 用法：node tools/probe-card.mjs
//
// 目的是把"卡片外沿 / 卡图窗框 / 效果框框"这几条硬边**量到像素**，
// 免得靠肉眼估比例（估错 2% 着色器就会把边框啃掉或者糊到卡图上）。

import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outDir = resolve(here, '.cache');
mkdirSync(outDir, { recursive: true });

const src = process.argv[2] || resolve(projectRoot, 'images', 'Shooting Quasar Dragon.jpg');
if (!existsSync(src)) throw new Error('找不到图片: ' + src);
const b64 = readFileSync(src).toString('base64');
const mime = src.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 1300 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('about:blank');

const out = await page.evaluate(async ([dataUri]) => {
  const img = new Image(); img.src = dataUri; await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;
  const L = (x, y) => {
    const i = ((y * W + x) << 2);
    return Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
  };
  const rgb = (x, y) => { const i = ((y * W + x) << 2); return [px[i], px[i + 1], px[i + 2]]; };

  const rowProfile = (y, xa, xb, step) => {
    const o = [];
    for (let x = xa; x <= xb; x += step) o.push(x + ':' + L(x, y));
    return o.join(' ');
  };
  const colProfile = (x, ya, yb, step) => {
    const o = [];
    for (let y = ya; y <= yb; y += step) o.push(y + ':' + L(x, y));
    return o.join(' ');
  };

  // 逐像素找"跳变"位置（|Δ| > 阈值），用来定位硬边
  const edgesX = (y, xa, xb, th) => {
    const o = [];
    for (let x = xa + 1; x <= xb; x++) {
      const d = L(x, y) - L(x - 1, y);
      if (Math.abs(d) > th) o.push(x + '(' + (d > 0 ? '+' : '') + d + ')');
    }
    return o.join(' ');
  };
  const edgesY = (x, ya, yb, th) => {
    const o = [];
    for (let y = ya + 1; y <= yb; y++) {
      const d = L(x, y) - L(x, y - 1);
      if (Math.abs(d) > th) o.push(y + '(' + (d > 0 ? '+' : '') + d + ')');
    }
    return o.join(' ');
  };

  const crops = {};
  const crop = (name, x, y, w, h, scale) => {
    const c = document.createElement('canvas');
    c.width = w * scale; c.height = h * scale;
    const cc = c.getContext('2d');
    cc.imageSmoothingEnabled = false;
    cc.drawImage(cv, x, y, w, h, 0, 0, w * scale, h * scale);
    crops[name] = c.toDataURL('image/png');
  };

  // 几个关键部位放大：看边界到底压在哪一列/哪一行
  crop('corner-tl', 0, 0, 120, 120, 4);
  crop('edge-left-mid', 0, 560, 120, 80, 4);
  crop('artwin-tl', 60, 190, 130, 90, 4);
  crop('artwin-br', 640, 780, 130, 90, 4);
  crop('nameband', 20, 40, 400, 130, 2);
  crop('textbox-top', 20, 850, 400, 90, 2);
  crop('bottom-band', 20, 1080, 400, 105, 2);

  return {
    W: W, H: H,
    cornerRGB: { tl: rgb(2, 2), mid: rgb(2, Math.round(H / 2)), bl: rgb(2, H - 3) },
    rightRGB: { tr: rgb(W - 3, 2), mid: rgb(W - 3, Math.round(H / 2)), br: rgb(W - 3, H - 3) },
    // 卡片外沿：在卡片中高位置横扫
    cardEdgeX: rowProfile(Math.round(H * 0.5), 0, 60, 2) + ' || ' + rowProfile(Math.round(H * 0.5), 760, 812, 2),
    cardEdgeY: colProfile(Math.round(W * 0.5), 0, 60, 2) + ' || ' + colProfile(Math.round(W * 0.5), 1130, 1184, 2),
    // 卡图窗左右框：在卡图中间高度横扫
    artEdgeX: edgesX(Math.round(H * 0.42), 30, 200, 18) + ' ||| ' + edgesX(Math.round(H * 0.42), 640, 790, 18),
    artProfileX: rowProfile(Math.round(H * 0.42), 60, 130, 2) + ' || ' + rowProfile(Math.round(H * 0.42), 690, 760, 2),
    // 卡图窗上下框：在卡图中间横扫
    artEdgeY: edgesY(Math.round(W * 0.5), 150, 280, 18) + ' ||| ' + edgesY(Math.round(W * 0.5), 800, 900, 18),
    artProfileY: colProfile(Math.round(W * 0.5), 160, 250, 2) + ' || ' + colProfile(Math.round(W * 0.5), 820, 890, 2),
    // 卡名带 / 效果框
    nameEdgeY: edgesY(60, 60, 200, 18),
    textEdgeY: edgesY(60, 880, 1140, 18),
    crops: crops
  };
}, ['data:' + mime + ';base64,' + b64]);

await browser.close();

const show = (t, s) => console.log('\n-- ' + t + ' --\n   ' + s);
console.log('尺寸:', out.W + '×' + out.H, ' 长宽比', (out.W / out.H).toFixed(4));
console.log('左边缘 RGB:', JSON.stringify(out.cornerRGB), ' 右边缘 RGB:', JSON.stringify(out.rightRGB));
show('卡片外沿（横扫 y=50%）x 0..60 / 760..812', out.cardEdgeX);
show('卡片外沿（纵扫 x=50%）y 0..60 / 1130..1184', out.cardEdgeY);
show('卡图窗左右框（跳变点）', out.artEdgeX);
show('卡图窗左右（亮度剖面）', out.artProfileX);
show('卡图窗上下框（跳变点）', out.artEdgeY);
show('卡图窗上下（亮度剖面）', out.artProfileY);
show('卡名带纵向跳变（x=60）', out.nameEdgeY);
show('效果框纵向跳变（x=60）', out.textEdgeY);

for (const k of Object.keys(out.crops)) {
  const p = resolve(outDir, 'crop-' + k + '.png');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(p, Buffer.from(out.crops[k].split(',')[1], 'base64'));
  console.log('裁片 →', p);
}
