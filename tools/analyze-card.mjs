// 卡图结构分析：找出这张游戏王卡各"工艺区域"的精确边界。
//
// 用法：node tools/analyze-card.mjs [图片路径]
//   → 打印 JSON 统计 + 写出 tools/.cache/analyze-overlay.png（区域叠加图，用来肉眼核对）
//
// 为什么需要它：罕贵度的差别**几乎全在"哪一块被加工了"**上 ——
//   面闪(SR) 只加工卡图窗、银字(R) 只加工卡名、收藏闪(CR) 加工边框+卡名+卡图外框。
// 所以着色器必须先知道"卡名在哪、卡图窗在哪、效果框在哪"。
//
// 这些矩形是**从这张图上量出来的**（不是抄的规格表），量完写死进 js/layout.js，
// 并且带一个可调的面板 + 调试图层，肉眼能核对。

import { chromium } from 'playwright-core';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outDir = resolve(here, '.cache');
mkdirSync(outDir, { recursive: true });

const src = process.argv[2] || resolve(projectRoot, 'images', 'Shooting Quasar Dragon.jpg');
if (!existsSync(src)) throw new Error('找不到图片: ' + src);
const imgUrl = pathToFileURL(src).href;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 1300 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

// 需要一个 file:// 页面才能在没有 --allow-file-access-from-files 的情况下
// 让 <img> 加载本地文件？—— 不行，仍然需要那个开关才能 getImageData。
// 所以这里带上开关，并且用 setContent 之后再把图片 data URI 塞进去。
await page.goto('about:blank');
const b64 = (await import('node:fs')).readFileSync(src).toString('base64');
const mime = src.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

const result = await page.evaluate(async ([dataUri]) => {
  const img = new Image();
  img.src = dataUri;
  await img.decode();

  const W = img.naturalWidth, H = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;

  const luma = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  const at = (x, y) => ((y * W + x) << 2);

  // ---- 1. 四角取样：判断图里有没有"卡片以外的背景" ----
  const corner = (x, y, s) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
      const k = at(Math.min(W - 1, x + i), Math.min(H - 1, y + j));
      r += px[k]; g += px[k + 1]; b += px[k + 2]; n++;
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  };
  const S = 8;
  const corners = {
    tl: corner(0, 0, S), tr: corner(W - S, 0, S),
    bl: corner(0, H - S, S), br: corner(W - S, H - S, S)
  };
  // 卡片自己的边框色（往里缩 12% 处取，肯定在卡上）
  const inset = {
    tl: corner(Math.round(W * 0.02), Math.round(H * 0.02), S),
    tr: corner(Math.round(W * 0.97), Math.round(H * 0.02), S),
    bl: corner(Math.round(W * 0.02), Math.round(H * 0.97), S),
    br: corner(Math.round(W * 0.97), Math.round(H * 0.97), S)
  };
  const d = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const bgVsCard = {
    tl: d(corners.tl, inset.tl), tr: d(corners.tr, inset.tr),
    bl: d(corners.bl, inset.bl), br: d(corners.br, inset.br)
  };

  // ---- 2. 行 / 列 的"强边缘"剖面 ----
  // 游戏王卡的每个工艺区域之间都是**一条硬边**（卡图窗四周、效果框四周、卡名带上下），
  // 所以找"整行/整列上大片像素同时跳变"的位置，就等于找到了区域的边界。
  const x0 = Math.round(W * 0.20), x1 = Math.round(W * 0.80);
  const y0 = Math.round(H * 0.20), y1 = Math.round(H * 0.80);

  const rowEdge = new Float64Array(H);
  for (let y = 1; y < H; y++) {
    let cnt = 0;
    for (let x = x0; x < x1; x++) {
      if (Math.abs(luma(at(x, y)) - luma(at(x, y - 1))) > 26) cnt++;
    }
    rowEdge[y] = cnt / (x1 - x0);
  }
  const colEdge = new Float64Array(W);
  for (let x = 1; x < W; x++) {
    let cnt = 0;
    for (let y = y0; y < y1; y++) {
      if (Math.abs(luma(at(x, y)) - luma(at(x - 1, y))) > 26) cnt++;
    }
    colEdge[x] = cnt / (y1 - y0);
  }

  // 在某个区间里找最强的几根边缘
  const peaks = (arr, from, to, minFrac, limit) => {
    const out = [];
    for (let i = Math.max(1, from); i < Math.min(arr.length, to); i++) {
      if (arr[i] < minFrac) continue;
      // 局部极大
      if (arr[i] >= arr[i - 1] && arr[i] >= arr[i + 1]) {
        out.push({ i: i, frac: arr[i], pos: +(i / (arr.length - 1)).toFixed(4) });
      }
    }
    out.sort((a, b) => b.frac - a.frac);
    return out.slice(0, limit).sort((a, b) => a.i - b.i);
  };

  // ---- 3. 按"区域"扫：卡图窗 / 效果框 ----
  // 卡图窗：中段最"花"（方差大）；效果框：底段最"平"（白底黑字）
  const rowVar = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0, s2 = 0, n = 0;
    for (let x = Math.round(W * 0.10); x < Math.round(W * 0.90); x++) {
      const v = luma(at(x, y)); s += v; s2 += v * v; n++;
    }
    rowVar[y] = Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
  }

  // 卡图窗的水平范围：在图像高度 35% 那一行上找"深色卡图窗边框"
  const scanRow = Math.round(H * 0.35);
  const rowProfile = [];
  for (let x = 0; x < W; x++) rowProfile.push(Math.round(luma(at(x, scanRow))));

  return {
    W: W, H: H,
    corners: corners, inset: inset, bgVsCard: bgVsCard,
    rowEdgePeaks: peaks(rowEdge, 1, H - 1, 0.45, 14),
    colEdgePeaks: peaks(colEdge, 1, W - 1, 0.45, 14),
    rowEdgeTop: peaks(rowEdge, 1, H - 1, 0.20, 30),
    rowVarProfile: Array.from(rowVar).map((v, i) => ({ y: i, p: +(i / (H - 1)).toFixed(4), v: +v.toFixed(1) }))
      .filter((_, i) => i % 5 === 0),
    scanRow: scanRow,
    rowProfile: rowProfile
  };
}, ['data:' + mime + ';base64,' + b64]);

// ---------------------------------------------------------------- 输出 ----
console.log('图片尺寸 :', result.W + '×' + result.H, '长宽比', (result.W / result.H).toFixed(4));
console.log('四角像素 :', JSON.stringify(result.corners));
console.log('内缩像素 :', JSON.stringify(result.inset));
console.log('角/内差  :', JSON.stringify(result.bgVsCard), '（=0 说明图就是整张卡，没有背景）');
console.log('\n-- 横向强边缘（y 位置，占高比例）--');
for (const p of result.rowEdgePeaks) console.log('   y=' + String(p.i).padStart(5), 'p=' + p.pos, '强度', p.frac.toFixed(3));
console.log('\n-- 纵向强边缘（x 位置，占宽比例）--');
for (const p of result.colEdgePeaks) console.log('   x=' + String(p.i).padStart(5), 'p=' + p.pos, '强度', p.frac.toFixed(3));

console.log('\n-- 逐行"花草度"（行方差，每 5 行取样一次）--');
let line = '';
for (const r of result.rowVarProfile) {
  line += r.p.toFixed(2) + ':' + String(r.v).padStart(4) + '  ';
  if (line.length > 110) { console.log('   ' + line); line = ''; }
}
if (line) console.log('   ' + line);

writeFileSync(resolve(outDir, 'analyze-card.json'), JSON.stringify(result, null, 1), 'utf8');
console.log('\n→', resolve(outDir, 'analyze-card.json'));

await browser.close();
