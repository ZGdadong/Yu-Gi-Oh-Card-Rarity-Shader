// 把 images/ 下的**每一张**卡图处理成能内嵌的纹理 + **工艺区域掩膜**。
//
// 用法：node tools/embed-card.mjs [--only "文件名关键字"] [--height 1024]
//   → js/card-textures.js           （生成物：每张卡一条，含卡图 / 掩膜 data URI + 区域 + SHA-256）
//   → tools/.cache/mask-preview.png （最后一张卡的掩膜预览，核对"区域切得对不对"）
//   → tools/.cache/card-detect.json （每张卡的自动识别结果，给 verify 核对用）
//
// 为什么必须内嵌成 data URI：
//   Chrome 把每个 file:// 文件当成独立来源，用本地 <img> 做 texImage2D 会被判"来源不干净"；
//   data URI 是干净的，于是"双击 index.html 就能跑"才成立。
//
// 为什么要单独烤一张掩膜：
//   罕贵度的差别**几乎全在"哪一块被加工了"**上 ——
//   · 面闪(SR)：只有卡图窗有闪膜，卡名不闪
//   · 银字(R) ：只有卡名的**笔画**是银色烫金
//   · 收藏闪(CR)：边框 / 卡名 / 卡图窗口 都有彩虹
//   · 20th SER：卡名是红的，效果框上还有 "20th" 水印
//   所以在烘焙阶段就把这些区域算成一张 RGBA 掩膜交给着色器。
//
//   **卡名笔画**这一路是从图里抠出来的：卡名带里的字比底板暗得多，
//   按暗度取阈值再膨胀两像素，就把笔画掩膜拿到了 —— 不管字体/字距怎么变都跟得住。
//
// ── 换一张卡要改什么 ──────────────────────────────────────────────────────
// 卡片外沿（裁到哪儿）是**自动识别**的：找整行/整列一起跳变的硬边当卡片边界，
// 识别不出来或者比例不像卡就退化成整张图。所以直接丢一张新图进 images/ 再跑一遍就行。
// 但下面这些是**照着游戏王标准版式写死的比例**，只在 REGIONS 里按需覆盖：
//   · 卡名带 / 卡图窗 / 效果框 的相对位置（灵摆卡、连接怪、无效果怪版式不同）
//   · 卡名笔画的暗度阈值（假定"深字浅底"）
//   · 圆角半径（默认自动量，量不出来才用 0.042）

import { chromium } from 'playwright-core';
import { DETECT_SRC } from './lib/detect.mjs';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outDir = resolve(here, '.cache');
mkdirSync(outDir, { recursive: true });

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const ONLY = flag('only', null);
// ★ 卡面 = 整张原图：不裁、不缩、不留白 ★
//
// 之前的做法是"自动识别卡片外沿 → 裁出来 → 缩到 1024 高 → 四周补 4% 留白"。
// 但融合紫框 / 超量黑框这两张的卡沿和背景几乎同色，外沿被内部边（效果框那条横线）
// 抢走，卡片下沿连同原图那条很有质感的黑边整条被裁掉，shader 的卡图窗跟着上移 25px。
//
// 原图本来就是**成品**：813×1185、四边 26px 居中留白、边缘自带黑边。直接用整张就行。
// 外沿检测仍然跑，但**只用来把"卡片相对"的区域常量映射到整图坐标**（见 §1），
// 不再决定裁到哪儿 —— 检测准不准都不影响画面完整性，只影响掩膜区域贴得准不准。
const MARGIN = 0;            // 纹理四周留白。0 = 原图即卡面
const FORMAT = 'image/webp';
const QUALITY = 0.95;
// 圆角半径（**原图像素**）。5 ≈ 实体卡的倒角观感；--corner 0 就是不削。
// 只削纹理的 alpha 通道就够：每个工艺着色器返回的都是 vec4(col, tex.a * 覆盖度)
//（js/shaders.js:28），所有图层都乘 tex.a，会跟着一起被削，不用动着色器。
const CORNER_PX = parseInt(flag('corner', '5'), 10);

// 区域（**卡片相对**比例，0..1；v=0 是卡片上沿，与 LÖVE 的纹理坐标约定一致）
const REGIONS = {
  // 卡名带：只用来框住"去哪儿找字"，实际笔画靠暗度抠
  nameBand:   { x0: 0.030, y0: 0.020, x1: 0.848, y1: 0.088 },
  // 卡图窗（外框，含卡图四周那圈深色框）
  artOuter:   { x0: 0.0736, y0: 0.1520, x1: 0.9277, y1: 0.7280 },
  // 卡图窗（内，插画本身）
  artInner:   { x0: 0.0920, y0: 0.1751, x1: 0.9093, y1: 0.7162 },
  // 效果框（含 ATK/DEF 带）
  textBox:    { x0: 0.0380, y0: 0.7533, x1: 0.9620, y1: 0.9806 },
  // 等级星带（给"星闪"之类的按带加工用）
  starBand:   { x0: 0.0400, y0: 0.1000, x1: 0.9600, y1: 0.1520 }
};

// 抠卡名笔画的参数。
//   auto:true  —— **自动**判极性 + 自动定阈值（默认，见下面"卡名笔画"那一段）
//   auto:false —— 退回 lo/hi 这两个**绝对**灰度阈值，口径是"暗 = 笔画"
//                 只给自动模式栽掉的怪卡手工兜底用，写进 CARDS[文件名].nameInk
//   ramp       —— 阈值两侧的软过渡半宽（灰度 0..1）。字缘要利落，别铺太宽
//   dilate     —— 笔画膨胀次数（1 次 = 3×3 取最大，约 1px）
const NAME_INK = { auto: true, lo: 0.62, hi: 0.80, ramp: 0.045, dilate: 2 };

// 每张卡可以单独覆盖上面的东西（文件名 → 覆盖项）。留空表示全都用默认。
const CARDS = {
  // 卡名笔画已经是**自动**判极性 + 自动定阈值的（Otsu + 少数派），
  // 橙 / 紫 / 蓝 / 白 / 黑 各色卡框都能跟住，连超量那种"白字黑底"也不用管。
  // 只有自动模式真的栽了的怪卡才需要在这里钉死：
  // 'Some Weird Card.jpg': {
  //   regions: { textBox: { x0: 0.04, y0: 0.62, x1: 0.96, y1: 0.80 } },
  //   nameInk: { auto: false, lo: 0.30, hi: 0.55, dilate: 2 }   // 钉死绝对阈值
  // }
};

// ------------------------------------------------------------------ 找图 ----
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const imagesDir = resolve(projectRoot, 'images');
if (!existsSync(imagesDir)) throw new Error('没有 images/ 目录');
let files = readdirSync(imagesDir)
  .filter((f) => IMG_EXT.indexOf(extname(f).toLowerCase()) >= 0)
  .sort();
if (ONLY) files = files.filter((f) => f.indexOf(ONLY) >= 0);
if (!files.length) throw new Error('images/ 下没有找到图片' + (ONLY ? '（过滤：' + ONLY + '）' : ''));

console.log('images/ 下找到', files.length, '张：', files.join(' · '));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 1300 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto('about:blank');

const built = [];
for (const file of files) {
  const srcPath = join(imagesDir, file);
  const srcBytes = readFileSync(srcPath);
  const sha = createHash('sha256').update(srcBytes).digest('hex');
  const id = basename(file, extname(file));
  const mime = /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
  const override = CARDS[file] || {};
  const regions = Object.assign({}, REGIONS, override.regions || {});
  const nameInk = Object.assign({}, NAME_INK, override.nameInk || {});

  // 归档（逐字节）
  const archive = join(resolve(projectRoot, 'assets'), file);
  copyFileSync(srcPath, archive);

  const res = await page.evaluate(async ([dataUri, FORMAT, QUALITY, regions, nameInk, cornerOverride, defaultCornerPx, detectSrc]) => {
    // 把共享的检测器注入到页面作用域
    eval(detectSrc);
    const img = new Image(); img.src = dataUri; await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight;
    const srcCv = document.createElement('canvas'); srcCv.width = W; srcCv.height = H;
    const sctx = srcCv.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0);
    const sp = sctx.getImageData(0, 0, W, H).data;
    const luma = (i) => 0.2126 * sp[i] + 0.7152 * sp[i + 1] + 0.0722 * sp[i + 2];

    // ---- 0. 自动找卡片外沿（算法在 tools/lib/detect.mjs，与 verify 共用同一份）----
    var det = detectCardRect(sp, W, H);
    var CARD = det.rect;
    var detected = det.detected;

    const cw0 = CARD.x1 - CARD.x0, ch0 = CARD.y1 - CARD.y0;
    const aspect = cw0 / ch0;

    // ---- 1. 卡面 = 整张原图；区域常量换算到整图坐标 ----
    // 着色器里的 cardUV 是"纹理 0..1"，所以区域常量必须落在**整图**坐标系里。
    // 卡片在整图里的位置由检测到的 CARD 给出，逐区域线性映射过去即可。
    const dw = W, dh = H;                  // 内容 = 整图
    const texW = W, texH = H;              // 纹理 = 内容（MARGIN = 0）
    const ox = 0, oy = 0;
    const mapped = {};
    for (const k of Object.keys(regions)) {
      const r = regions[k];
      mapped[k] = {
        x0: (CARD.x0 + r.x0 * cw0) / W, y0: (CARD.y0 + r.y0 * ch0) / H,
        x1: (CARD.x0 + r.x1 * cw0) / W, y1: (CARD.y0 + r.y1 * ch0) / H
      };
    }

    // ---- 2. 卡面本体：整图原样画上去（随后只削圆角 alpha）----
    const cardCv = document.createElement('canvas'); cardCv.width = dw; cardCv.height = dh;
    const cctx = cardCv.getContext('2d', { willReadFrequently: true });
    cctx.imageSmoothingEnabled = true; cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(srcCv, 0, 0);

    // ---- 3. 圆角 ----
    // 原图是方角的（自带黑边），这里按 CORNER_PX 削一个圆角，接近实体卡的倒角观感。
    // 只改 alpha 通道、不动 RGB，所以圆角处不会渗出黑边或白边。
    let cornerPx = defaultCornerPx, cornerSrc = 'flag';
    if (cornerOverride !== undefined) { cornerPx = Math.round(dw * cornerOverride); cornerSrc = 'override'; }
    cornerPx = Math.max(0, Math.min(Math.round(cornerPx), Math.floor(Math.min(dw, dh) / 2)));

    const rr = document.createElement('canvas'); rr.width = dw; rr.height = dh;
    const rctx = rr.getContext('2d');
    if (cornerPx > 0) {
      rctx.fillStyle = '#fff';
      rctx.beginPath();
      if (rctx.roundRect) rctx.roundRect(0, 0, dw, dh, cornerPx);
      else {
        rctx.moveTo(cornerPx, 0); rctx.lineTo(dw - cornerPx, 0); rctx.quadraticCurveTo(dw, 0, dw, cornerPx);
        rctx.lineTo(dw, dh - cornerPx); rctx.quadraticCurveTo(dw, dh, dw - cornerPx, dh);
        rctx.lineTo(cornerPx, dh); rctx.quadraticCurveTo(0, dh, 0, dh - cornerPx);
        rctx.lineTo(0, cornerPx); rctx.quadraticCurveTo(0, 0, cornerPx, 0); rctx.closePath();
      }
      rctx.fill();
      cctx.globalCompositeOperation = 'destination-in';
      cctx.drawImage(rr, 0, 0);
      cctx.globalCompositeOperation = 'source-over';
    }

    const tex = document.createElement('canvas'); tex.width = texW; tex.height = texH;
    const tctx = tex.getContext('2d');
    tctx.drawImage(cardCv, ox, oy);

    // ---- 3. 掩膜 ----
    const mv = document.createElement('canvas'); mv.width = dw; mv.height = dh;
    const mctx = mv.getContext('2d', { willReadFrequently: true });
    const cp = cctx.getImageData(0, 0, dw, dh).data;

    const rectPx = (r) => ({ x0: r.x0 * dw, y0: r.y0 * dh, x1: r.x1 * dw, y1: r.y1 * dh });
    const R = {};
    for (const k of Object.keys(mapped)) R[k] = rectPx(mapped[k]);

    // ---- 卡名笔画 ----
    // 卡名带的**底色就是卡框色**，而游戏王这一点花色极多，字色还跟着一起变：
    //   橙(效果) / 紫(融合) / 蓝(仪式) / 白(同调) / 深蓝(连接) → 深字浅底
    //   黑(超量)                                              → **白字黑底，极性相反**
    // 所以"暗 = 笔画"这种固定阈值**原理上就不可能通用** —— 实测橙框 luma≈0.60、
    // 蓝框≈0.29、黑框≈0.05，全部低于旧阈值 lo=0.62，整条名带被判成笔画。
    // （tools/verify.mjs 的 C 段正是这么抓到的：笔画 40180px = 名带全满，底板 0px。）
    //
    // 现在改成两步自适应，不依赖任何绝对灰度：
    //   ① Otsu 在名带灰度直方图上找类间方差最大的阈值；
    //   ② **像素少的那一类算笔画**（字永远只占名带一小块），极性由两类平均亮度决定
    //      （暗的那类少 → 深字浅底；亮的那类少 → 白字黑底）。
    // 自动模式仍可能栽在"名带里有两块面积相当的深浅区域"的怪图上（比如金碎那种
    // 强金属渐变把直方图摊平）。那种卡用 CARDS[文件名].nameInk = { auto:false, lo, hi } 钉死。
    const ink = new Uint8Array(dw * dh);
    const nb = R.nameBand;
    const bx0 = Math.max(0, Math.floor(nb.x0)), bx1 = Math.min(dw, Math.ceil(nb.x1));
    const by0 = Math.max(0, Math.floor(nb.y0)), by1 = Math.min(dh, Math.ceil(nb.y1));

    let inkIsDark = true, otsuL = 0.71;
    let inkStats = { mode: nameInk.auto ? 'auto' : 'fixed' };

    if (nameInk.auto) {
      const hist = new Float64Array(256);
      let bandN = 0;
      for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) {
        const i = (y * dw + x) << 2;
        if (cp[i + 3] < 8) continue;
        const l = (0.2126 * cp[i] + 0.7152 * cp[i + 1] + 0.0722 * cp[i + 2]) / 255;
        hist[Math.max(0, Math.min(255, Math.round(l * 255)))]++;
        bandN++;
      }
      let total = 0;
      for (let k = 0; k < 256; k++) total += k * hist[k];
      // Otsu：让两类之间方差最大的那个灰度
      let wB = 0, sumB = 0, bestVar = -1, best = 128;
      for (let k = 0; k < 256; k++) {
        wB += hist[k];
        if (wB === 0) continue;
        const wF = bandN - wB;
        if (wF === 0) break;
        sumB += k * hist[k];
        const mB = sumB / wB, mF = (total - sumB) / wF;
        const v = wB * wF * (mB - mF) * (mB - mF);
        if (v > bestVar) { bestVar = v; best = k; }
      }
      let nDark = 0, sumDark = 0;
      for (let k = 0; k <= best; k++) { nDark += hist[k]; sumDark += k * hist[k]; }
      const nBright = bandN - nDark;
      const mDark = nDark ? sumDark / nDark : 0;
      const mBright = nBright ? (total - sumDark) / nBright : 255;
      inkIsDark = nDark <= nBright;            // 少数派 = 笔画
      otsuL = best / 255;
      inkStats = {
        mode: 'auto',
        otsu: +otsuL.toFixed(3),
        polarity: inkIsDark ? 'dark' : 'bright',
        gap: +((mBright - mDark) / 255).toFixed(3),
        inkFrac: +((inkIsDark ? nDark : nBright) / bandN).toFixed(4)
      };
    }

    const rw = nameInk.ramp;
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const i = (y * dw + x) << 2;
        if (cp[i + 3] < 8) continue;
        const l = (0.2126 * cp[i] + 0.7152 * cp[i + 1] + 0.0722 * cp[i + 2]) / 255;
        const t = nameInk.auto
          // 以 Otsu 阈值为中心、±rw 软过渡；极性翻，过渡方向跟着翻
          ? (inkIsDark ? (otsuL + rw - l) : (l - (otsuL - rw))) / (2 * rw)
          // 手工兜底：沿用旧的"暗 = 笔画"绝对阈值
          : (nameInk.hi - l) / (nameInk.hi - nameInk.lo);
        ink[y * dw + x] = Math.max(0, Math.min(1, t)) * 255;
      }
    }
    let dilated = ink;
    for (let pass = 0; pass < nameInk.dilate; pass++) {
      const nx = new Uint8Array(dw * dh);
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          let m = 0;
          for (let j = -1; j <= 1; j++) {
            const yy = y + j; if (yy < 0 || yy >= dh) continue;
            for (let i = -1; i <= 1; i++) {
              const xx = x + i; if (xx < 0 || xx >= dw) continue;
              const v = dilated[yy * dw + xx]; if (v > m) m = v;
            }
          }
          nx[y * dw + x] = m;
        }
      }
      dilated = nx;
    }

    const mask = mctx.createImageData(dw, dh);
    const md = mask.data;
    const inRect = (r, x, y) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
    const hard = { g: new Float32Array(dw * dh), b: new Float32Array(dw * dh), a: new Float32Array(dw * dh) };
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const i = (y * dw + x) << 2;
        if (cp[i + 3] < 8) { md[i] = md[i + 1] = md[i + 2] = md[i + 3] = 0; continue; }
        const k = y * dw + x;
        hard.g[k] = inRect(R.artInner, x, y) ? 1 : 0;
        hard.b[k] = inRect(R.textBox, x, y) ? 1 : 0;
        // A 通道 = **卡片自身的剪影**（不是"卡框"）。canvas 是预乘 alpha 存的，
        // 把"卡框掩膜"放 alpha 里会让卡图/效果框那两块的 G/B 在反预乘时被除以 0 抹掉；
        // 卡框与卡图外环交给着色器按矩形现算（见 js/shaders.js 的 pickMask）。
        hard.a[k] = 1;
        md[i] = dilated[k];
      }
    }
    // 区域边界羽化 ≈1.5px（硬边在小尺寸下会沿边框闪锯齿）
    const feather = (src) => {
      const t1 = new Float32Array(dw * dh), o2 = new Float32Array(dw * dh);
      const blur1 = (s, d) => {
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
          let sum = 0, n = 0;
          for (let j = -1; j <= 1; j++) {
            const yy = y + j; if (yy < 0 || yy >= dh) continue;
            for (let i = -1; i <= 1; i++) {
              const xx = x + i; if (xx < 0 || xx >= dw) continue;
              sum += s[yy * dw + xx]; n++;
            }
          }
          d[y * dw + x] = sum / n;
        }
      };
      blur1(src, t1); blur1(t1, o2);
      return o2;
    };
    const fg = feather(hard.g), fb = feather(hard.b), fa = feather(hard.a);
    for (let k = 0; k < dw * dh; k++) {
      const i = k << 2;
      md[i + 1] = Math.round(fg[k] * 255);
      md[i + 2] = Math.round(fb[k] * 255);
      md[i + 3] = Math.round(fa[k] * 255);
    }
    mctx.putImageData(mask, 0, 0);

    const mtex = document.createElement('canvas'); mtex.width = texW; mtex.height = texH;
    mtex.getContext('2d').drawImage(mv, ox, oy);

    // ---- 4. 统计 ----
    let n = 0, inkN = 0, artN = 0, textN = 0, frameN = 0, ringN = 0;
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
      const i = (y * dw + x) << 2;
      if (cp[i + 3] < 8) continue;
      n++;
      if (md[i] > 127) inkN++;
      if (md[i + 1] > 127) artN++;
      if (md[i + 2] > 127) textN++;
      const inOuter = inRect(R.artOuter, x, y), inText = inRect(R.textBox, x, y), inInner = inRect(R.artInner, x, y);
      if (!inOuter && !inText) frameN++;
      if (inOuter && !inInner) ringN++;
    }

    // ---- 5. 掩膜预览 ----
    const pv = document.createElement('canvas'); pv.width = dw; pv.height = dh;
    const pctx = pv.getContext('2d');
    const pimg = pctx.createImageData(dw, dh);
    for (let i = 0; i < dw * dh; i++) {
      const k = i << 2;
      pimg.data[k] = md[k] * 0.85;
      pimg.data[k + 1] = md[k + 1] * 0.55;
      pimg.data[k + 2] = md[k + 2] * 0.55;
      pimg.data[k + 3] = md[k + 3] > 127 ? 190 : 40;
    }
    pctx.putImageData(pimg, 0, 0);

    return {
      srcWidth: W, srcHeight: H,
      card: CARD, detected: detected, detectNote: det.note, detectStrength: det.strength,
      cornerPx: cornerPx, cornerSrc: cornerSrc,
      texWidth: texW, texHeight: texH, contentW: dw, contentH: dh,
      cardW: cw0, cardH: ch0, aspect: aspect,
      contentUV: { x0: ox / texW, y0: oy / texH, x1: (ox + dw) / texW, y1: (oy + dh) / texH },
      regionsMapped: mapped,
      dataUri: tex.toDataURL(FORMAT, QUALITY),
      maskUri: mtex.toDataURL('image/png'),
      maskPreview: pv.toDataURL('image/png'),
      inkStats: inkStats,
      coverage: { name: inkN / n, art: artN / n, text: textN / n, frame: frameN / n, ring: ringN / n, opaque: n / (dw * dh) }
    };
  }, ['data:' + mime + ';base64,' + srcBytes.toString('base64'), FORMAT, QUALITY, regions, nameInk, override.cornerRadius, CORNER_PX, DETECT_SRC]);

  writeFileSync(join(outDir, 'mask-preview.png'), Buffer.from(res.maskPreview.split(',')[1], 'base64'));

  const fa = { x0: res.card.x0, y0: res.card.y0, x1: res.card.x1, y1: res.card.y1 };
  console.log(`\n── ${file}`);
  console.log('   识别卡片外沿:', res.detected
    ? `自动识别 ✓  x ${fa.x0}..${fa.x1}  y ${fa.y0}..${fa.y1}  (${res.cardW}×${res.cardH}，长宽比 ${res.aspect.toFixed(4)}，${res.detectNote})`
    : `没识别出来，退化成整张图 (${res.srcWidth}×${res.srcHeight})`);
  if (res.detected) {
    const s = res.detectStrength;
    console.log('   四边强度   :',
      '上', s.top.toFixed(2), '下', s.bottom.toFixed(2),
      '左', s.left.toFixed(2), '右', s.right.toFixed(2),
      res.detectNote === 'both-axes' ? '（两对边都够强，直接用）' : '（有一对边对比度不够，用 59:86 的比例补出来的）');
  }
  console.log('   圆角       :', res.cornerPx + 'px', res.cornerSrc === 'measured' ? '（量的）' : '（默认值）');
  console.log('   纹理       :', `${res.texWidth}×${res.texHeight}  = 整张原图（不裁不缩不留白）  圆角 ${res.cornerPx}px`);
  console.log('   掩膜覆盖   : 卡名', (res.coverage.name * 100).toFixed(2) + '%',
    '· 卡图', (res.coverage.art * 100).toFixed(1) + '%',
    '· 效果框', (res.coverage.text * 100).toFixed(1) + '%',
    '· 卡框', (res.coverage.frame * 100).toFixed(1) + '%',
    '· 外环', (res.coverage.ring * 100).toFixed(1) + '%');
  {
    const s = res.inkStats;
    const how = s.mode === 'auto'
      ? `自动 Otsu 阈 ${s.otsu} · 极性 ${s.polarity === 'dark' ? '深字浅底' : '白字黑底'} · 两类亮度差 ${s.gap} · 笔画占名带 ${(s.inkFrac * 100).toFixed(1)}%`
      : '手工钉死（CARDS 覆盖里给了绝对阈值）';
    // 名带被整条填满 = 极性判错或阈值失效，直接喊出来，别让它悄悄过去
    const bad = (s.mode === 'auto' && (s.gap < 0.12 || s.inkFrac > 0.5)) || res.coverage.name > 0.06;
    console.log('   卡名笔画   :', how, bad ? '  ⚠️ 可疑，去 CARDS 里手工钉 nameInk' : '');
  }
  console.log('   编码       : 卡图', (res.dataUri.length / 1024).toFixed(0), 'KB · 掩膜', (res.maskUri.length / 1024).toFixed(0), 'KB');

  built.push({
    id, file, sha256: sha, mime,
    srcWidth: res.srcWidth, srcHeight: res.srcHeight,
    cardRect: res.card,
    cardDetected: res.detected,
    cornerPx: res.cornerPx, cornerSource: res.cornerSrc,
    width: res.texWidth, height: res.texHeight,
    aspect: res.texWidth / res.texHeight,
    margin: MARGIN,
    contentUV: res.contentUV,
    contentWidth: res.contentW, contentHeight: res.contentH,
    contentAspect: res.aspect,
    regions: res.regionsMapped, nameInk,
    nameInkStats: res.inkStats,
    maskCoverage: res.coverage,
    dataUri: res.dataUri, maskUri: res.maskUri
  });
}

await browser.close();

// ------------------------------------------------------------------ 写文件 ----
const total = built.reduce((a, b) => a + b.dataUri.length + b.maskUri.length, 0);
const body = built.map((b) => `  {
    id: ${JSON.stringify(b.id)},
    file: ${JSON.stringify(b.file)},
    // 原图归档 assets/${b.file} 的 SHA-256，tools/verify.mjs 会核对
    sha256: ${JSON.stringify(b.sha256)},
    // 原图尺寸；cardRect 是**自动识别**出来的卡片外沿（没识别出来就是整张图）
    sourceWidth: ${b.srcWidth},
    sourceHeight: ${b.srcHeight},
    cardRect: ${JSON.stringify(b.cardRect)},
    cardDetected: ${b.cardDetected},
    cornerRadius: ${b.cornerPx},
    cornerRadiusSource: ${JSON.stringify(b.cornerSource)},
    // 纹理 = 整张原图（不裁不缩不留白），只削了圆角 alpha
    width: ${b.width},
    height: ${b.height},
    aspect: ${b.aspect.toFixed(6)},
    margin: ${b.margin},
    // 卡片内容在纹理里的精确矩形（着色器的 cardUV 用它换算）
    contentUV: { x0: ${b.contentUV.x0.toFixed(6)}, y0: ${b.contentUV.y0.toFixed(6)}, x1: ${b.contentUV.x1.toFixed(6)}, y1: ${b.contentUV.y1.toFixed(6)} },
    contentWidth: ${b.contentWidth},
    contentHeight: ${b.contentHeight},
    contentAspect: ${b.contentAspect.toFixed(6)},
    // 工艺区域（卡片相对比例，v=0 是卡片上沿）
    regions: ${JSON.stringify(b.regions, null, 2).split('\n').join('\n    ')},
    nameInk: ${JSON.stringify(b.nameInk)},
    // 卡名笔画是怎么定出来的：自动 Otsu 的阈值 / 判出来的极性 / 两类亮度差 / 笔画占名带比例
    // （极性 = 'bright' 就是超量那种"白字黑底"，着色器不用管，掩膜已经是对的）
    nameInkStats: ${JSON.stringify(b.nameInkStats)},
    maskCoverage: ${JSON.stringify(b.maskCoverage)},
    dataUri: ${JSON.stringify(b.dataUri)},
    maskUri: ${JSON.stringify(b.maskUri)}
  }`).join(',\n');

const outFile = resolve(projectRoot, 'js', 'card-textures.js');
const header = `/*
 * card-textures.js —— **自动生成，请勿手改**
 *
 * 由 tools/embed-card.mjs 扫描 images/ 生成，一张卡一条。
 * 命令：node tools/embed-card.mjs
 *
 * 每条包含：
 *   ① card / mask —— 卡图本体与**工艺区域掩膜**（都是 data URI，同尺寸）
 *      · 卡片外沿是**自动识别**的（找整行/整列一起跳变的硬边），识别不出来就退化成整张图
 *      · 卡面 = **整张原图**（不裁不缩不留白），只按 --corner 削一个圆角 alpha
 *   ② mask 的通道：
 *        R = 卡名笔画（Otsu 自动分割 + 自动判极性，再膨胀 ${NAME_INK.dilate}px）
 *        G = 卡图内容区（插画本身，不含四周深色框）
 *        B = 效果框（含 ATK/DEF 带）
 *        A = **卡片自身的剪影**（卡内处处为 1）
 *      "卡框"与"卡图外环"不进掩膜，由着色器按 regions.artOuter / artInner 现算 ——
 *      原因是 canvas 的像素是预乘 alpha 存的，把卡框掩膜放进 alpha 通道会让卡图窗与
 *      效果框那两块的 G/B 在反预乘时被除以 0 抹掉（详见 embed-card.mjs 里的注释）。
 *
 * 为什么必须以 data URI 内嵌：
 *   file:// 下 Chrome 把每个本地文件当成独立来源，用本地 <img> 做 texImage2D
 *   会因"来源不干净"被拒绝；data URI 没有这个问题，所以"双击 index.html 就能跑"才成立。
 *
 * tools/verify.mjs 会核对每张卡的 assets/ 归档 SHA-256 是否仍与这里记录的一致。
 */
(function (global) {
  'use strict';

  var LIST = [
${body}
  ];

  var BY_ID = {};
  for (var i = 0; i < LIST.length; i++) BY_ID[LIST[i].id] = LIST[i];

  global.CardTextures = {
    list: LIST,
    byId: BY_ID,
    order: LIST.map(function (t) { return t.id; }),
    defaultId: ${JSON.stringify(built[0].id)},
    // 兼容老名字：以前只有一张卡时叫 CardTexture
    get first() { return LIST[0]; }
  };
  global.CardTexture = LIST[0];
})(window);
`;
writeFileSync(outFile, header, 'utf8');

writeFileSync(join(outDir, 'card-detect.json'), JSON.stringify(
  built.map((b) => ({ id: b.id, file: b.file, cardRect: b.cardRect, detected: b.cardDetected, cornerPx: b.cornerPx, aspect: b.contentAspect })),
  null, 1), 'utf8');

console.log('\n写入 :', outFile, `(${(header.length / 1024).toFixed(0)} KB，${built.length} 张卡，data URI 合计 ${(total / 1024).toFixed(0)} KB)`);
console.log('识别结果 →', join(outDir, 'card-detect.json'));
console.log('掩膜预览 →', join(outDir, 'mask-preview.png'));
