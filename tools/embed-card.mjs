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
//
// ⚠️ 新丢一张图进 images/ 之后**必须跑这个脚本**，卡片才会出现在参数面板的「卡图」
//    下拉框里 —— 下拉框列的是 js/card-textures.js，而这个文件是本脚本扫描 images/
//    生成的，页面自己不会去读那个目录。
//    （想在页面里当场加一张、不跑 node：面板「卡图」左边那个 ⟳ 按钮，
//      它调的是同一个 js/bake.js。）
//
// 下面这些是**照着游戏王标准版式写死的比例**，现在都住在 js/bake.js 的 REGIONS / NAME_INK 里，
// 要按卡覆盖就在下面的 CARDS 表里写：
//   · 卡名带 / 卡图窗 / 效果框 的相对位置（灵摆卡、连接怪、无效果怪版式不同）
//   · 卡名笔画的暗度阈值（自动 Otsu 栽了才需要钉死）
//   · 圆角半径（默认 0 = 不削，圆角在运行时做）

import { chromium } from 'playwright-core';
import { DETECT_SRC } from './lib/detect.mjs';
import { BAKE_SRC } from './lib/bake.mjs';
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
// MARGIN / FORMAT / QUALITY / REGIONS / NAME_INK 都搬去 **js/bake.js** 了 ——
// 那一份是页面与这个工具**共用**的烘焙核心（参数面板「卡图」左边的 ⟳ 刷新按钮
// 也用它当场烤新图）。这里不再各存一份副本，需要默认值时从页面里取（见下面 DEFAULTS）。
//
// 圆角**已经挪到运行时**了（侧栏「卡片圆角 (px)」那根滑条 → uCardRound uniform）。
// 它只是 alpha 上的一道遮罩、跟图像内容无关，烤进纹理纯属自找麻烦 —— 改一次要重烤 35 秒。
// 所以这里默认 0（不削）；保留 --corner 只是为了"要把圆角焊死在纹理里"的少数场合。
//
// 当年圆角烤在这里时靠的性质：每个工艺着色器返回的都是 vec4(col, tex.a * 覆盖度)
//（js/shaders.js 顶部），所有图层都乘 tex.a，所以削 alpha 一处就够。
// 现在同一条性质被用在着色器的 cardTex() 包装上 —— 一处削、处处削。
const CORNER_PX = parseInt(flag('corner', '0'), 10);

// 每张卡可以单独覆盖烘焙参数（文件名 → 覆盖项）。留空表示全都用默认。
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

// 把共用核心（js/detect.js + js/bake.js）注入页面，顺手把里面的默认值读出来 ——
// 这样"区域常量 / 卡名笔画参数 / 编码格式"只有 js/bake.js 一处定义，
// 页面里那个 ⟳ 刷新按钮烤出来的东西跟这里**逐字节同源**。
const DEFAULTS = await page.evaluate(([detectSrc, bakeSrc]) => {
  eval(detectSrc);
  eval(bakeSrc);
  return {
    regions: CardBake.REGIONS, nameInk: CardBake.NAME_INK,
    format: CardBake.FORMAT, quality: CardBake.QUALITY, margin: CardBake.MARGIN
  };
}, [DETECT_SRC, BAKE_SRC]);

const built = [];
for (const file of files) {
  const srcPath = join(imagesDir, file);
  const srcBytes = readFileSync(srcPath);
  const sha = createHash('sha256').update(srcBytes).digest('hex');
  const id = basename(file, extname(file));
  const mime = /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
  const override = CARDS[file] || {};

  // 归档（逐字节）
  const archive = join(resolve(projectRoot, 'assets'), file);
  copyFileSync(srcPath, archive);

  const res = await page.evaluate(async ([dataUri, detectSrc, bakeSrc, opts]) => {
    // 把共用的检测器 + 烘焙核心注入到页面作用域
    eval(detectSrc);
    eval(bakeSrc);
    const img = new Image(); img.src = dataUri; await img.decode();
    // ---- 烘焙：算法在 js/bake.js（页面那边是同一个函数）----
    return CardBake.bakeCard(img, {
      regions: opts.regions,
      nameInk: opts.nameInk,
      cornerPx: opts.cornerPx,
      cornerRadius: opts.cornerRadius,
      format: opts.format,
      quality: opts.quality,
      margin: opts.margin
    });
  }, ['data:' + mime + ';base64,' + srcBytes.toString('base64'), DETECT_SRC, BAKE_SRC, {
    regions: override.regions || null,
    nameInk: override.nameInk || null,
    // 每张卡可以钉死一个圆角比例；没给就用 --corner（默认 0 = 不削，圆角在运行时做）
    cornerRadius: override.cornerRadius === undefined ? null : override.cornerRadius,
    cornerPx: CORNER_PX,
    format: DEFAULTS.format,
    quality: DEFAULTS.quality,
    margin: DEFAULTS.margin
  }]);

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
    margin: DEFAULTS.margin,
    contentUV: res.contentUV,
    contentWidth: res.contentW, contentHeight: res.contentH,
    contentAspect: res.aspect,
    regions: res.regionsMapped, nameInk: res.nameInk,
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
 *        R = 卡名笔画（Otsu 自动分割 + 自动判极性，再膨胀 ${DEFAULTS.nameInk.dilate}px）
 *        G = 卡图内容区（插画本身，不含四周深色框）
 *        B = 效果框（含 ATK/DEF 带）
 *        A = **卡片自身的剪影**（卡内处处为 1）
 *      "卡框"与"卡图外环"不进掩膜，由着色器按 regions.artOuter / artInner 现算 ——
 *      原因是 canvas 的像素是预乘 alpha 存的，把卡框掩膜放进 alpha 通道会让卡图窗与
 *      效果框那两块的 G/B 在反预乘时被除以 0 抹掉（详见 js/bake.js 里的注释）。
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
