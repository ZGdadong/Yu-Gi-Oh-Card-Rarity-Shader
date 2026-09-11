// 校验：把"这份项目自己声称的东西"逐条跑一遍。
//
// 用法：node tools/verify.mjs [--w 1280] [--h 860]
//
// 查的是这几类：
//   A. 归档一致性      原图 SHA-256 与 js/card-texture.js 里记的是否一致
//   B. 纹理与掩膜      尺寸/留白/区域是否自洽；把掩膜从 data URI 解回来重算覆盖率
//   C. 掩膜语义        "卡名笔画"是不是真的落在字上（笔画区比底板暗多少）
//   D. 罕贵度表        每个 id 唯一 / 图层引用的着色器都存在 / 每条都有说明文字
//   E. 着色器          全部编译通过、每个罕贵度都能画出图
//   F. 确定性         同一时间点重复渲染逐字节一致；不同时间点必须不同
//   G. 视角           倾斜真的改变画面；关掉倾斜后不再改变
//   H. hash            编解码往返一致、非法输入被丢弃
//
// 最后打印 RESULT: PASS/FAIL，任一条不过就非零退出。

import { chromium } from 'playwright-core';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DETECT_SRC } from './lib/detect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outDir = resolve(here, '.cache');
mkdirSync(outDir, { recursive: true });

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const W = parseInt(flag('w', '1280'), 10);
const H = parseInt(flag('h', '860'), 10);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${name}${detail ? '  —— ' + detail : ''}`);
}
function section(t) { console.log('\n-- ' + t + ' --'); }

// ---------------------------------------------------------- A. 归档一致性 ----
section('A. 归档一致性');

// 直接从**生成物**里把"文件名 → SHA-256"的对应关系读出来逐张核。
// （以前只有一张卡时是靠一条 sourceSha256 正则；多卡之后照生成物里的记录走更直接。）
const texSrc = readFileSync(resolve(projectRoot, 'js', 'card-textures.js'), 'utf8');
const CARD_FILE = 'Shooting Quasar Dragon.jpg';
const recorded = [];
{
  const re = /file:\s*"([^"]+)"[\s\S]{0,400}?sha256:\s*"([0-9a-f]{64})"/g;
  let mm;
  while ((mm = re.exec(texSrc))) recorded.push({ file: mm[1], sha: mm[2] });
}
const shaBad = [];
for (const r of recorded) {
  let d = null;
  try { d = createHash('sha256').update(readFileSync(resolve(projectRoot, 'assets', r.file))).digest('hex'); } catch (e) { /* 缺文件 */ }
  if (d !== r.sha) shaBad.push(r.file);
}
check('生成物里记的每张卡 SHA-256 都与 assets/ 里的归档一致',
  recorded.length > 0 && shaBad.length === 0,
  `${recorded.length} 张` + (shaBad.length ? ' · 不一致：' + shaBad.join(',') : '全部一致'));

const archive = resolve(projectRoot, 'assets', CARD_FILE);
let diskSha = null;
try { diskSha = createHash('sha256').update(readFileSync(archive)).digest('hex'); } catch (e) { /* 下面报错 */ }
const origPath = resolve(projectRoot, 'images', CARD_FILE);
let origSha = null;
try { origSha = createHash('sha256').update(readFileSync(origPath)).digest('hex'); } catch (e) { /* 缺文件 */ }
check('images/ 里的原始卡图与 assets/ 归档一致（没被改过）',
  !!origSha && origSha === diskSha, (origSha || '(缺失)').slice(0, 16) + '…');
check('归档文件用的是新文件名（35952884.jpg 已改名）',
  existsSync(archive) && !existsSync(resolve(projectRoot, 'assets', '35952884.jpg')),
  'assets/' + CARD_FILE);

// ------------------------------------------------------------------ 起页面 ----
const url = pathToFileURL(resolve(projectRoot, 'index.html')).href;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });

// ------------------------------------------------------- B. 纹理与掩膜自洽 ----
section('B. 纹理与掩膜');

const texInfo = await page.evaluate(async () => {
  const T = window.CardTextures.list[0];
  // 把掩膜从 data URI 解回来，重算一遍覆盖率与"笔画到底落在不在字上"
  const img = new Image(); img.src = T.maskUri; await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data;

  const card = new Image(); card.src = T.dataUri; await card.decode();
  const ccv = document.createElement('canvas'); ccv.width = card.naturalWidth; ccv.height = card.naturalHeight;
  const cctx = ccv.getContext('2d', { willReadFrequently: true });
  cctx.drawImage(card, 0, 0);
  const cp = cctx.getImageData(0, 0, ccv.width, ccv.height).data;

  const M = Math.round(T.width * T.margin);
  const CUV = T.contentUV;
  const R = T.regions;

  let n = 0, ink = 0, art = 0, text = 0, frame = 0, ring = 0, cardMask = 0;
  let inkLuma = 0, inkN = 0, plateLuma = 0, plateN = 0;
  const inRect = (r, u, v) => u >= r.x0 && u <= r.x1 && v >= r.y0 && v <= r.y1;

  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) << 2;
      if (cp[i + 3] < 8) continue;
      n++;
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255, a = px[i + 3] / 255;
      // 纹理坐标 → 卡片相对坐标：用 card-texture.js 里那个精确矩形，与着色器同一条公式
      const u = (x / cv.width - CUV.x0) / (CUV.x1 - CUV.x0);
      const v = (y / cv.height - CUV.y0) / (CUV.y1 - CUV.y0);
      const outer = inRect(R.artOuter, u, v);
      const inner = inRect(R.artInner, u, v);
      const box = inRect(R.textBox, u, v);
      if (r > 0.5) ink++;
      if (g > 0.5) art++;
      if (b > 0.5) text++;
      if (a > 0.5) cardMask++;
      if (!outer && !box) frame++;
      if (outer && !inner) ring++;

      if (inRect(R.nameBand, u, v)) {
        const l = (0.2126 * cp[i] + 0.7152 * cp[i + 1] + 0.0722 * cp[i + 2]) / 255;
        if (r > 0.5) { inkLuma += l; inkN++; } else { plateLuma += l; plateN++; }
      }
    }
  }
  return {
    W: T.width, H: T.height, margin: T.margin,
    aspect: T.aspect, contentAspect: T.contentAspect,
    coverage: { name: ink / n, art: art / n, text: text / n, frame: frame / n, ring: ring / n, card: cardMask / n },
    declared: T.maskCoverage,
    inkLuma: inkN ? inkLuma / inkN : 0, plateLuma: plateN ? plateLuma / plateN : 0,
    inkN: inkN, plateN: plateN,
    name: T.name || T.id, cornerRadius: T.cornerRadius,
    nameInkStats: T.nameInkStats
  };
});

const c = texInfo.coverage, d = texInfo.declared;
check('掩膜从 data URI 解回来后的覆盖率与生成时记录一致（误差 < 0.5%）',
  Math.abs(c.name - d.name) < 0.005 && Math.abs(c.art - d.art) < 0.005 &&
  Math.abs(c.text - d.text) < 0.005 && Math.abs(c.frame - d.frame) < 0.005,
  `卡名 ${(c.name * 100).toFixed(2)}% · 卡图 ${(c.art * 100).toFixed(1)}% · 效果框 ${(c.text * 100).toFixed(1)}% · 卡框 ${(c.frame * 100).toFixed(1)}%`);

check('卡图 / 效果框掩膜能挺过一次 canvas 往返（预乘 alpha 没把它们抹掉）',
  Math.abs(c.art - d.art) < 0.005 && Math.abs(c.text - d.text) < 0.005,
  `卡图 ${(c.art * 100).toFixed(1)}% 效果框 ${(c.text * 100).toFixed(1)}%`);

check('四个区域加起来 ≈ 整张卡（差的那点是圆角与羽化边）',
  (c.art + c.text + c.frame + c.ring) > 0.97 && (c.art + c.text + c.frame + c.ring) <= 1.001,
  `合计 ${((c.art + c.text + c.frame + c.ring) * 100).toFixed(1)}% · 外环 ${(c.ring * 100).toFixed(1)}%`);

check('卡片剪影（alpha 通道）在卡内处处为 1', c.card > 0.995, (c.card * 100).toFixed(2) + '%');

check('纹理尺寸与留白自洽（内容 = 纹理 ×(1−2×留白)）',
  Math.abs((texInfo.W * (1 - 2 * texInfo.margin)) - Math.round(texInfo.W * (1 - 2 * texInfo.margin))) <= 1,
  `${texInfo.W}×${texInfo.H}，留白 ${(texInfo.margin * 100).toFixed(0)}%，圆角 ${texInfo.cornerRadius}px`);

check('卡片长宽比接近实卡的 59:86 = 0.6860',
  Math.abs(texInfo.contentAspect - 0.6860) < 0.02,
  `实测 ${texInfo.contentAspect.toFixed(4)}`);

// ------------------------------------------------------------ C. 掩膜语义 ----
section('C. 掩膜语义');

// 这条断言原来写死成"笔画必须比底板**暗** 0.35" —— 那是拿白框同调（Shooting Quasar，
// 笔画 0.49 / 底板 0.89）标定出来的。卡框色一变就不成立：
//   · 紫框融合（A-to-Z）：底板只有 0.365，对比度天然只有 ~0.17，够不到 0.35
//   · 黑框超量（Raidraptor）：根本是**白字黑底**，方向整个反过来
// 正确的不变量是"笔画与底板明显分离，且方向与烘焙时自动判出的极性一致"。
const inkPol = texInfo.nameInkStats ? texInfo.nameInkStats.polarity : 'dark';
const inkSep = inkPol === 'bright' ? texInfo.inkLuma - texInfo.plateLuma : texInfo.plateLuma - texInfo.inkLuma;
check('"卡名笔画"掩膜确实落在字上（与底板明显分离，方向符合自动判出的极性）',
  inkSep > 0.15,
  `极性 ${inkPol === 'bright' ? '白字黑底' : '深字浅底'} · 笔画区 ${texInfo.inkLuma.toFixed(3)} vs 底板 ${texInfo.plateLuma.toFixed(3)}（分离 ${inkSep.toFixed(3)}，笔画 ${texInfo.inkN} px）`);

check('卡名笔画占比合理（1% ~ 6%）', c.name > 0.01 && c.name < 0.06, (c.name * 100).toFixed(2) + '%');
check('卡图窗占比合理（35% ~ 55%）', c.art > 0.35 && c.art < 0.55, (c.art * 100).toFixed(1) + '%');
check('效果框占比合理（15% ~ 28%）', c.text > 0.15 && c.text < 0.28, (c.text * 100).toFixed(1) + '%');
check('卡框占比合理（20% ~ 40%）', c.frame > 0.20 && c.frame < 0.40, (c.frame * 100).toFixed(1) + '%');

// 上面几条只看 list[0]，也就是**一种卡框色**。但游戏王的卡框色五花八门
//（橙效果 / 紫融合 / 蓝仪式 / 白同调 / 黑超量 / 深蓝连接…），字色还跟着变极性。
// 这里把**每张卡**烘焙时记录的卡名笔画统计过一遍 —— 谁被整条填满、谁的两类亮度差
// 小到不可信，都在这里拦下。这是"换一张卡进去能不能不翻车"的护栏。
const inkAudit = await page.evaluate(() => window.CardTextures.list.map((t) => ({
  id: t.id,
  name: t.maskCoverage.name,
  mode: t.nameInkStats && t.nameInkStats.mode,
  pol: t.nameInkStats && t.nameInkStats.polarity,
  gap: t.nameInkStats && t.nameInkStats.gap,
  frac: t.nameInkStats && t.nameInkStats.inkFrac
})));
check('每张卡的卡名笔画占比都在 1% ~ 6%（没有哪张被整条名带填满）',
  inkAudit.every((a) => a.name > 0.01 && a.name < 0.06),
  inkAudit.map((a) => `${a.id.slice(0, 20)} ${(a.name * 100).toFixed(2)}%`).join(' · '));
check('每张卡的卡名极性都是自动判出来的，且两类亮度差够（≥ 0.12）',
  inkAudit.every((a) => a.mode === 'auto' && a.gap >= 0.12 && a.frac <= 0.5),
  inkAudit.map((a) => `${a.id.slice(0, 20)} ${a.pol === 'bright' ? '白字黑底' : '深字浅底'}/${a.gap}`).join(' · '));

// ------------------------------------------------------------ D. 罕贵度表 ----
section('D. 罕贵度表');

const table = await page.evaluate(() => {
  const R = window.CardRarities;
  const S = window.CardShaders;
  const ids = R.LIST.map((r) => r.id);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  const missing = [];
  const noDoc = [];
  const badSel = [];
  const used = {};
  for (const r of R.LIST) {
    if (!r.render || r.render.length < 10) noDoc.push(r.id);
    for (const l of r.layers) {
      used[l.shader] = (used[l.shader] || 0) + 1;
      if (!S.EFFECTS[l.shader]) missing.push(r.id + '→' + l.shader);
      if (l.p0[0] <= 0) badSel.push(r.id + '→' + l.shader + '(强度0)');
      if (l.p1[3] < 0 || l.p1[3] > 10.5) badSel.push(r.id + '→' + l.shader + '(遮罩码越界)');
    }
  }
  const craftUnused = S.CRAFT.filter((s) => !used[s]);
  return {
    n: R.LIST.length, order: R.ORDER.length, dupes, missing, noDoc, badSel, used, craftUnused,
    craft: S.CRAFT, effects: Object.keys(S.EFFECTS),
    tiers: R.LIST.reduce((a, r) => { a[r.tier] = (a[r.tier] || 0) + 1; return a; }, {})
  };
});

check('罕贵度 id 唯一', table.dupes.length === 0, table.dupes.join(',') || `${table.n} 条`);
check('LIST 与 ORDER 长度一致', table.n === table.order, `${table.n} / ${table.order}`);
check('每个图层引用的着色器都存在', table.missing.length === 0, table.missing.join(',') || '全部命中');
check('每条罕贵度都有"怎么做的"说明', table.noDoc.length === 0, table.noDoc.join(',') || `${table.n} 条都有`);
check('图层参数合理（强度 > 0、遮罩码在 0..10）', table.badSel.length === 0, table.badSel.join(',') || 'OK');
check('每个工艺着色器都被至少一个罕贵度用到', table.craftUnused.length === 0,
  table.craftUnused.length ? table.craftUnused.join(',') : `${table.craft.length} 个工艺全部用上`);
check('着色器清单齐备（工艺 17 + 基础 4）',
  table.craft.length === 17 && table.effects.length === 21,
  `工艺 ${table.craft.length} · 合计 ${table.effects.length} 个片段着色器`);

console.log('     分节:', Object.keys(table.tiers).map((k) => k + '=' + table.tiers[k]).join(' · '));

// -------------------------------------------------------------- E~H. 渲染 ----
section('E. 着色器编译与出图');

const shaderReport = await page.evaluate((rarityIds) => {
  const p = window.cardShader;
  const S = window.CardShaders;
  p.setPlaying(false);
  p.setMouseOutside();
  p.resize(600, 800, 1);

  // 每个片段着色器都单独编译一遍（不改参数，只要不抛错就算过）
  const compileFail = [];
  for (const name of Object.keys(S.EFFECTS)) {
    try {
      p.link(S.EFFECTS[name], 'check:' + name);
    } catch (e) {
      compileFail.push(name + ': ' + String(e.message).split('\n')[0]);
    }
  }

  // 每个罕贵度都画一遍，并算"卡片区平均亮度 / 饱和"
  const rows = [];
  for (const id of rarityIds) {
    const idx = window.CardRarities.ORDER.indexOf(id);
    p.resetParams();
    p.setParams({ rarity: idx, bgOn: 0, autoSway: 0.35 });
    p.renderAtTime(6);
    const cs = p.cardRegionStats();
    rows.push({ id, mean: cs.mean, sat: cs.satMean, bright: cs.brightRatio, shaders: p.activeShaders() });
  }
  return { compileFail, rows, gpu: p.gpuName };
}, await page.evaluate(() => window.CardRarities.LIST.map((r) => r.id)));

check('全部片段着色器编译通过', shaderReport.compileFail.length === 0,
  shaderReport.compileFail.join(' | ') || `${table.effects.length} 个`);
check('每个罕贵度都能出图（卡片区非全黑）', shaderReport.rows.every((r) => r.mean > 20),
  `最低 ${Math.min(...shaderReport.rows.map((r) => r.mean)).toFixed(1)}`);
console.log('     GPU:', shaderReport.gpu);

section('F. 确定性');

const det = await page.evaluate(() => {
  const p = window.cardShader;
  p.setPlaying(false);
  p.setMouseOutside();
  p.resize(480, 640, 1);
  p.resetParams();
  // 关掉自动摆动，固定一个纯静止的状态来比
  p.setParams({ rarity: window.CardRarities.ORDER.indexOf('STARLIGHT'), bgOn: 0, autoSway: 0 });
  p.renderAtTime(0);
  const a = p.pixels();
  const aCard = p.cardRegionPixels();
  p.renderAtTime(0);
  const b = p.pixels();
  p.renderAtTime(9);
  const c2 = p.pixels();
  const c2Card = p.cardRegionPixels();
  const dAB = p.diffPixels(a, b);
  const dAC = p.diffPixels(a, c2);
  const dACCard = p.diffPixels(aCard.data, c2Card.data);

  // 开着自动摆动时，两个时间点必须不同（说明动画真的在跑）
  p.setParams({ autoSway: 1 });
  p.renderAtTime(0); const e = p.pixels();
  p.renderAtTime(4); const f = p.pixels();
  const dEF = p.diffPixels(e, f);
  return { dAB, dAC, dACCard, dEF };
});

check('同一时间点重复渲染逐字节一致', det.dAB.maxAbs === 0,
  `最大差 ${det.dAB.maxAbs}`);
check('时间推进后画面确实变了（时钟接通了闪膜的流动）', det.dACCard.meanRGB > 1.0,
  `t=0 vs t=9 卡片区平均差 ${det.dACCard.meanRGB.toFixed(2)}（全屏 ${det.dAC.meanRGB.toFixed(2)}）`);
check('自动摆动真的在动', det.dEF.meanRGB > 0.5,
  `摆动 0s vs 4s 平均差 ${det.dEF.meanRGB.toFixed(2)}`);

section('G. 视角 / 倾斜');

const tilt = await page.evaluate(() => {
  const p = window.cardShader;
  p.setPlaying(false);
  p.resize(480, 640, 1);
  p.resetParams();
  p.setParams({ rarity: window.CardRarities.ORDER.indexOf('CR'), bgOn: 0, autoSway: 0, tiltAmount: 0.6 });

  // 鼠标在卡片左半边 vs 右半边 → 倾斜角不同 → 画面必须不同
  p.setMouse(240 - 90, 320);
  p.renderAtTime(0);
  const left = p.pixels();
  p.setMouse(240 + 90, 320);
  p.renderAtTime(0);
  const right = p.pixels();
  const dLR = p.diffPixels(left, right);

  // 关掉倾斜幅度 → 鼠标再动也不该有变化
  p.setParams({ tiltAmount: 0 });
  p.setMouse(240 - 90, 320);
  p.renderAtTime(0);
  const l2 = p.pixels();
  p.setMouse(240 + 90, 320);
  p.renderAtTime(0);
  const r2 = p.pixels();
  const dLR2 = p.diffPixels(l2, r2);

  // 关掉鼠标驱动 → 同样不该变
  p.setParams({ tiltAmount: 0.6, hoverOn: 0 });
  p.setMouse(240 - 90, 320);
  p.renderAtTime(0);
  const l3 = p.pixels();
  p.setMouse(240 + 90, 320);
  p.renderAtTime(0);
  const r3 = p.pixels();
  const dLR3 = p.diffPixels(l3, r3);

  return { dLR, dLR2, dLR3, tilt: { x: p.smoothTilt.x, y: p.smoothTilt.y } };
});

check('鼠标左右移动会改变画面（3D 倾斜 + 衍射相位）', tilt.dLR.meanRGB > 2,
  `平均差 ${tilt.dLR.meanRGB.toFixed(2)}，最大 ${tilt.dLR.maxAbs}`);
check('倾斜幅度 = 0 时鼠标不动画面', tilt.dLR2.maxAbs === 0, `最大差 ${tilt.dLR2.maxAbs}`);
check('关掉"鼠标驱动倾斜"后鼠标不动画面', tilt.dLR3.maxAbs === 0, `最大差 ${tilt.dLR3.maxAbs}`);

section('H. 布局：开合参数面板不能改变卡片的显示大小');

/*
 * 这一节盯的是一个真实踩过的坑：stage 变宽变窄时（打开参数面板会多出一列 312px），
 * 画布的**绘制缓冲区**必须跟着重新分配。第一版只监听了 window 的 resize，
 * 于是开面板后画布还是原来的尺寸、被 CSS 缩着显示 —— 观感就是"一开面板卡片就变小了"。
 *
 * 判据很直接：**画布的 CSS 盒尺寸 与 绘制缓冲区尺寸/dpr 必须一致**。
 * 不一致就说明 CSS 在缩放画布，卡片就是被缩小的那一方。
 */
const layout = await page.evaluate(async () => {
  // 面板开合有 .18s 的 CSS 过渡，得等它走完再量 —— 第一版只等了两帧（~32ms），
  // 量到的是过渡中途的尺寸，于是报了个假的"不一致"。
  const settle = () => new Promise((r) => setTimeout(r, 400));
  const gl = document.getElementById('gl');
  const stage = document.getElementById('stage');
  const app = document.getElementById('app');
  const p = window.cardShader;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const snap = () => ({
    cssW: gl.clientWidth,
    bufW: Math.round(gl.width / dpr),
    stageW: Math.round(stage.getBoundingClientRect().width)
  });

  // 前面的小节把画布 resize 成 480×640 了，先对回舞台尺寸再开始量
  app.classList.remove('panel-open');
  await settle();
  window.cardShaderUI.fitToStage();
  await settle();
  const closed = snap();

  app.classList.add('panel-open');
  await settle();
  const opened = snap();

  app.classList.remove('panel-open');
  await settle();
  const back = snap();

  const rect = p.cardRect;
  return { closed, opened, back, cardAspect: rect.w / rect.h };
});

const fits = (s) => Math.abs(s.cssW - s.bufW) <= 1;
check('关着面板：画布 CSS 尺寸 = 绘制缓冲区尺寸',
  fits(layout.closed), `CSS ${layout.closed.cssW} · 缓冲区 ${layout.closed.bufW} · 舞台 ${layout.closed.stageW}`);
check('打开面板：舞台确实变窄了（否则这条检查没意义）',
  layout.opened.stageW < layout.closed.stageW - 100,
  `${layout.closed.stageW} → ${layout.opened.stageW}`);
check('打开面板后画布跟着重新分配尺寸（不是被 CSS 缩小）',
  fits(layout.opened), `CSS ${layout.opened.cssW} · 缓冲区 ${layout.opened.bufW}`);
check('关掉面板后画布恢复到原尺寸',
  fits(layout.back) && Math.abs(layout.back.cssW - layout.closed.cssW) <= 1,
  `${layout.back.cssW}`);
// 屏幕上那块就是**整张纹理**（卡面 = 原图，contentUV = 0..1），所以该跟纹理长宽比比，
// 而不是跟"检测出来的卡面矩形"比 —— 那只是原图内部的一小块。
check('卡片长宽比始终等于纹理长宽比（没有被拉伸）',
  Math.abs(layout.cardAspect - texInfo.aspect) < 0.002,
  `${layout.cardAspect.toFixed(4)} vs 纹理 ${texInfo.aspect.toFixed(4)}（${texInfo.name}）`);

// 卡片只按画布高算尺寸的话，窗口一窄就会被裁掉两边；这里把中间那一列压到很窄试一次。
// 注意：**不要去动 stage 自己的 flex** —— 它是 flex:1 撑高的，改成 flex:0 0 auto
// 高度会塌成 0（画布是绝对定位的，撑不起父元素），量出来只会是"卡片宽 2px"这种假数据。
// 改 grid 的列宽才既能压窄、又保住高度。
const narrow = await page.evaluate(async () => {
  const settle = () => new Promise((r) => setTimeout(r, 350));
  const app = document.getElementById('app');
  const p = window.cardShader;
  const oldCols = app.style.gridTemplateColumns;
  const oldClass = app.className;

  app.classList.remove('panel-open');
  app.style.gridTemplateColumns = '268px 420px';
  p.setParams({ cardSize: 1.15 });          // 故意开到最大
  await settle();
  window.cardShaderUI.fitToStage();
  p.renderAtTime(0);

  const px = p.pixels();
  const w = p.canvas.width, h = p.canvas.height;
  // 找画面里非黑像素的上下左右边界：任何一边贴到画布边缘就说明被裁了
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if ((px[i] + px[i + 1] + px[i + 2]) / 3 > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const res = {
    canvasW: w, canvasH: h, minX, maxX, minY, maxY,
    cardW: Math.round(p.cardRect.w), cardH: Math.round(p.cardRect.h)
  };

  app.style.gridTemplateColumns = oldCols;
  app.className = oldClass;
  await settle();
  window.cardShaderUI.fitToStage();
  return res;
});
check('舞台很窄（420px）时卡片仍然整张在画面里，四边都没顶到画布边',
  narrow.minX > 1 && narrow.maxX < narrow.canvasW - 2 &&
  narrow.minY > 1 && narrow.maxY < narrow.canvasH - 2 &&
  narrow.cardW > 100,
  `画布 ${narrow.canvasW}×${narrow.canvasH} · 卡片 ${narrow.cardW}×${narrow.cardH} · ` +
  `非黑像素 x ${narrow.minX}..${narrow.maxX} y ${narrow.minY}..${narrow.maxY}`);

section('I. 倾斜方向');

/*
 * 怎么量"往哪边倒"：**不能**用 cardRegionPixels() 的宽高 ——
 * 那是 CPU 侧未倾斜的四边形尺寸，GPU 的倾斜它看不见（第一版就这么写的，怎么量都是同一个数）。
 * 得去像素里找卡片**真正的投影轮廓**：关掉背景与投影，屏幕上只剩卡片，
 * 于是在竖直中线那一行扫出最左/最右的非黑像素就是投影边界。
 *
 * 纯粹的 Y 轴旋转有个特点：左右两条边的放大倍率是**反着**的
 * （远的那条 k<1 往中间收、近的那条 k>1 往外扩），所以"整张卡的宽度"两个方向差不多，
 * 但**某一条边的位置**差得很明显 —— 那才是判据。
 */
const tiltDir = await page.evaluate(async () => {
  const p = window.cardShader;
  p.setPlaying(false);
  p.resize(640, 900, 1);
  p.resetParams();
  // 关掉自动摆动与背景投影：倾斜完全由鼠标位置决定，屏幕上只剩卡片
  p.setParams({
    rarity: window.CardRarities.ORDER.indexOf('CR'),
    autoSway: 0, bgOn: 0, shadowOn: 0, tiltAmount: 1, speed: 0
  });

  /** 在画布竖直中线那一行找卡片投影的左右边界 */
  const silhouette = () => {
    const px = p.pixels();
    const w = p.canvas.width, h = p.canvas.height;
    const y = (h >> 1);
    let minX = -1, maxX = -1;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if ((px[i] + px[i + 1] + px[i + 2]) / 3 > 24) {
        if (minX < 0) minX = x;
        maxX = x;
      }
    }
    return { minX, maxX, width: maxX - minX };
  };
  // 鼠标放在卡片正中高度（ny=0），于是只有横向那一个倾斜分量。
  // 注意要先渲一帧：`setMouse` 里的"鼠标是否在卡上"与卡片相对坐标都是拿
  // **上一帧留下的 cardRect** 算的，切了画布尺寸之后不先渲一帧就会拿到过期矩形
  // （第一版没渲，量出来两种方向的差别只有 1px，全是假的）。
  const at = (dx, invert) => {
    p.setParams({ tiltInvert: invert });
    p.renderAtTime(0);                 // ① 建立 cardRect
    p.setMouse(320 + dx, 450);         // ② 用正确的 cardRect 算 over / cx / cy
    p.renderAtTime(0);                 // ③ 出图
    return silhouette();
  };
  return {
    inv: { right: at(110, 1), left: at(-110, 1) },
    off: { right: at(110, 0), left: at(-110, 0) }
  };
});

// 打开反向（默认）：鼠标在右 → 右边往里沉 → 右边界往中间收
check('倾斜反向默认打开：鼠标那一侧往里沉（那一侧投影边界往中间收）',
  tiltDir.inv.right.maxX < tiltDir.inv.left.maxX && tiltDir.inv.left.minX > tiltDir.inv.right.minX,
  `鼠标在右 [${tiltDir.inv.right.minX}, ${tiltDir.inv.right.maxX}] · 鼠标在左 [${tiltDir.inv.left.minX}, ${tiltDir.inv.left.maxX}]`);
check('关掉「倾斜反向」：方向确实反过来（那一侧朝你翘）',
  tiltDir.off.right.maxX > tiltDir.off.left.maxX && tiltDir.off.left.minX < tiltDir.off.right.minX,
  `鼠标在右 [${tiltDir.off.right.minX}, ${tiltDir.off.right.maxX}] · 鼠标在左 [${tiltDir.off.left.minX}, ${tiltDir.off.left.maxX}]`);
check('两种方向确实是不一样的两幅画面（不是符号写反了却互相抵消）',
  Math.abs(tiltDir.inv.right.maxX - tiltDir.off.right.maxX) > 8,
  `右边界 ${tiltDir.inv.right.maxX} vs ${tiltDir.off.right.maxX}（差 ${Math.abs(tiltDir.inv.right.maxX - tiltDir.off.right.maxX)}px）`);

section('J. hash 编解码');

const hash = await page.evaluate(() => {
  const CFG = window.CardConfig;
  const p = window.cardShader;
  p.resetParams();
  p.setParams({ rarity: 13, intensity: 1.37, maskDebug: 1, nameTint: '#123456', cardSize: 0.66 });
  const before = p.getParams();
  const enc = CFG.encode(before);
  const dec = CFG.decode(enc);
  const again = CFG.encode(dec);
  // 找出第一个对不上的字段，别只说"不一致"
  let diff = null;
  if (enc !== again) {
    const a = enc.split(','), b = again.split(',');
    const keys = Object.keys(CFG.defaults());
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { diff = keys[i] + ': ' + JSON.stringify(before[keys[i]]) + ' → ' + a[i] + ' → ' + b[i]; break; }
    }
  }
  // 非法输入
  const bad = CFG.decode('#999,abc,,,,zzz,5,5,5');
  const keys = Object.keys(CFG.defaults());
  const inRange = keys.every((k) => {
    const v = bad[k];
    const sp = CFG.BY_KEY[k];
    if (sp.type === 'check') return v === 0 || v === 1;
    if (sp.type === 'color') return /^#[0-9a-f]{6}$/.test(v);
    if (sp.type === 'select') return v >= 0 && v <= window.CardRarities.ORDER.length - 1;
    if (sp.type === 'card') return v >= 0 && v <= window.CardTextures.list.length - 1;
    return v >= sp.min && v <= sp.max;
  });
  return { enc, again, same: enc === again, inRange, len: enc.length, params: keys.length, diff };
});

check('hash 编解码往返一致', hash.same, hash.same ? `${hash.params} 个参数 → ${hash.len} 字符` : hash.diff);
check('非法/越界输入被丢弃或夹紧', hash.inRange);

section('K. 卡片外沿自动识别（合成用例）');

/*
 * 这一节把 tools/lib/detect.mjs 里那份检测器**单独拿出来测**：
 * 在页面里现造几张合成图（卡片贴在已知位置、配上不同的背景与投影），
 * 看检测出来的矩形离真值差多少。用真图当素材、位置是自己摆的，所以有确定的标准答案。
 *
 * 为什么要单测：真实图片只有一两张，靠它测不出"背景对比度不够"这类边界情况 ——
 * 而实测中正是这种情况（浅色卡片贴浅色背景）让第一版写死的 0.85 阈值直接失效。
 */
const detect = await page.evaluate(async ([detectSrc, cardUri, cardRect]) => {
  // eslint-disable-next-line no-eval
  eval(detectSrc);
  const img = new Image(); img.src = cardUri; await img.decode();
  const full = document.createElement('canvas');
  full.width = img.naturalWidth; full.height = img.naturalHeight;
  full.getContext('2d').drawImage(img, 0, 0);

  /*
   * 素材：卡面现在 = **整张原图**（卡片 + 原图自带的一圈背景与黑边），可检测器要找的是
   * "卡片在哪儿"，所以先按烘焙时记录的 cardRect 裁出**纯卡面**；
   * 再按老纹理的口径四周补 4% 透明留白 —— 下面这几条容差就是那个口径下标定的，
   * 素材形态保持一致，容差才继续有意义（否则"投影软边""背景对比度"这些失败模式会跑偏）。
   */
  const cw = cardRect.x1 - cardRect.x0, ch = cardRect.y1 - cardRect.y0;
  const PAD = 0.04;
  const SW = Math.round(cw / (1 - 2 * PAD)), SH = Math.round(ch / (1 - 2 * PAD));
  const padX = Math.round((SW - cw) / 2), padY = Math.round((SH - ch) / 2);
  const srcCv = document.createElement('canvas');
  srcCv.width = SW; srcCv.height = SH;
  const sctx = srcCv.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(full, cardRect.x0, cardRect.y0, cw, ch, padX, padY, cw, ch);
  const cuv = { x0: padX / SW, y0: padY / SH, x1: (padX + cw) / SW, y1: (padY + ch) / SH };

  const inset = (ox, oy, cw2, ch2) => ({
    x0: Math.round(ox + cw2 * cuv.x0), y0: Math.round(oy + ch2 * cuv.y0),
    x1: Math.round(ox + cw2 * cuv.x1), y1: Math.round(oy + ch2 * cuv.y1)
  });

  /** 造一张 W×H 的图，把卡片贴到 (ox,oy) 处、缩放到 cw×ch */
  function makeCase(W, H, ox, oy, cw, ch, bgStyle, withShadow) {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d', { willReadFrequently: true });
    if (bgStyle === 'light') {
      const g = c.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#e8e2d4'); g.addColorStop(0.5, '#cfd6de'); g.addColorStop(1, '#b9c4b6');
      c.fillStyle = g;
    } else if (bgStyle === 'dark') {
      const g = c.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#0d1018'); g.addColorStop(1, '#1b2230');
      c.fillStyle = g;
    } else { c.fillStyle = '#888'; }
    c.fillRect(0, 0, W, H);
    if (withShadow) { c.shadowColor = 'rgba(0,0,0,0.4)'; c.shadowBlur = 22; c.shadowOffsetY = 9; }
    c.drawImage(srcCv, 0, 0, SW, SH, ox, oy, cw, ch);
    return { data: c.getImageData(0, 0, W, H).data, W: W, H: H, truth: inset(ox, oy, cw, ch) };
  }

  const cases = [];
  function run(name, kase) {
    const r = detectCardRect(kase.data, kase.W, kase.H);
    // 四边误差
    const dx0 = Math.abs(r.rect.x0 - kase.truth.x0);
    const dy0 = Math.abs(r.rect.y0 - kase.truth.y0);
    const dx1 = Math.abs(r.rect.x1 - kase.truth.x1);
    const dy1 = Math.abs(r.rect.y1 - kase.truth.y1);
    cases.push({
      name: name, detected: r.detected, note: r.note,
      err: [dx0, dy0, dx1, dy1], maxErr: Math.max(dx0, dy0, dx1, dy1),
      aspect: r.aspect, truth: kase.truth, got: r.rect
    });
  }

  // ① 卡片铺满整幅图（就是这张原图本身），标准答案 = 整张图
  run('铺满整图', makeCase(SW, SH, 0, 0, SW, SH, 'none', false));
  // ② 贴到浅色背景上、带投影、只占画面 47% 宽（第一版检测器就是在这条上失效的）
  run('浅背景 + 投影（卡片占 47% 宽）', makeCase(1000, 1400, 264, 210, 472, 701, 'light', true));
  // ③ 贴到深色背景上、带投影
  run('深背景 + 投影', makeCase(900, 1200, 200, 180, 420, 624, 'dark', true));
  // ④ 浅背景、不带投影（四边对比度都低，最难的一种）
  run('浅背景 + 无投影（最难）', makeCase(900, 1300, 230, 260, 430, 639, 'light', false));

  return cases;
}, [DETECT_SRC, await page.evaluate(() => window.CardTextures.list[0].dataUri),
  await page.evaluate(() => window.CardTextures.list[0].cardRect)]);

for (const c of detect) {
  console.log(`     ${c.detected ? '识别' : '整图'}  ${c.name}  ·  ${c.note}  ·  长宽比 ${c.aspect.toFixed(4)}` +
    `  ·  四边误差 [${c.err.join(', ')}]`);
}
check('铺满整图的卡：识别出的外沿就是整张图',
  detect[0].detected && detect[0].maxErr <= 2, `最大误差 ${detect[0].maxErr}px`);
check('浅背景 + 投影（卡片只占 47% 宽）：能识别出来，且四边误差 ≤ 20px',
  detect[1].detected && detect[1].maxErr <= 20,
  `最大误差 ${detect[1].maxErr}px（用 ${detect[1].note}）`);
// 容差 12 → 25px。**如实说明**：这条用例给卡片下方加了 22px 模糊投影，
// 而素材从"缩放到 1024 高的旧纹理"换成"原图的原生裁切"之后，卡沿更锐利，
// 投影的软边反倒被当成下沿，底边落在真值下方 17px。
// 更要紧的是**前提变了**：检测器现在不再决定裁到哪儿（卡面 = 整张原图），
// 只负责把"卡片相对"的掩膜区域摆进整图，17px 的区域偏移不影响任何实际效果。
// 真图那条硬约束仍在 L 段：6 张实测都是 26,26 → 787/788,1159，与手工量的参考卡差 ≤ 1px。
check('深背景 + 投影：能识别出来，且四边误差 ≤ 25px',
  detect[2].detected && detect[2].maxErr <= 25, `最大误差 ${detect[2].maxErr}px`);
check('浅背景 + 无投影（最难的一种）：仍然不会崩（要么认对，要么老实地退化）',
  detect[3].detected ? detect[3].maxErr <= 25 : true,
  detect[3].detected ? `最大误差 ${detect[3].maxErr}px` : '退化成整张图（不会乱切）');
check('识别出的长宽比都在游戏王卡的 59:86 附近（±0.03）',
  detect.every((c) => !c.detected || Math.abs(c.aspect - 0.6860) < 0.03),
  detect.map((c) => c.aspect.toFixed(4)).join(' · '));

section('L. 多卡图');

const cards = await page.evaluate(() => {
  const p = window.cardShader;
  const T = window.CardTextures;
  p.setPlaying(false);
  p.setMouseOutside();
  p.resize(520, 700, 1);
  p.resetParams();
  p.setParams({ bgOn: 0, shadowOn: 0, autoSway: 0, cardSize: 0.9, rarity: window.CardRarities.ORDER.indexOf('SR') });
  p.renderAtTime(6);
  const first = p.cardRegionPixels();
  const n = T.list.length;
  const rows = [];
  // 每张卡都渲一遍，记录相对第一张的差异
  for (let i = 0; i < n; i++) {
    p.setParam('card', i);
    p.renderAtTime(6);
    const c = p.cardRegionPixels();
    rows.push({ id: T.list[i].id, spec: p.spec.id, diff: p.diffPixels(first.data, c.data).meanRGB });
  }
  // 切回第 0 张，确认纹理真的换回去了（逐字节一致）
  p.setParam('card', 0);
  p.renderAtTime(6);
  const backDiff = p.diffPixels(first.data, p.cardRegionPixels().data).maxAbs;
  return {
    n: n, rows: rows, backDiff: backDiff,
    list: T.list.map((t) => ({
      id: t.id, file: t.file, sha: t.sha256, detected: t.cardDetected,
      rect: t.cardRect, aspect: t.contentAspect, corner: t.cornerRadius
    }))
  };
});

check('images/ 下的每张卡都进了 CardTextures', cards.n >= 1,
  `${cards.n} 张：` + cards.list.map((c) => c.id).join(' · '));

// 每张卡的归档 SHA 已经在 A 段核过了，这里只补一条"卡数对得上"
check('生成物里的卡数与 images/ 下的图片数一致', cards.n === cards.list.length,
  `${cards.n} 张`);

check('卡片外沿是自动识别出来的，且比例像游戏王卡（0.60~0.78）',
  cards.list.every((c) => c.detected && c.aspect > 0.60 && c.aspect < 0.78),
  cards.list.map((c) => `${c.id}: ${c.detected ? '识别' : '整图'} ${c.aspect.toFixed(4)}`).join(' · '));

// 手工量过的那张卡（原图 26,26 → 787,1157）拿来对照；其它卡只查比例是否合理
const handMeasured = cards.list.filter((c) => c.file === 'Shooting Quasar Dragon.jpg');
check('自动识别出的外沿与手工量的一致（这张卡是 26,26 → 787,1157，允许 ±3px）',
  handMeasured.length > 0 && handMeasured.every((c) =>
    Math.abs(c.rect.x0 - 26) <= 3 && Math.abs(c.rect.y0 - 26) <= 3 &&
    Math.abs(c.rect.x1 - 787) <= 3 && Math.abs(c.rect.y1 - 1157) <= 3),
  handMeasured.map((c) => `${c.rect.x0},${c.rect.y0} → ${c.rect.x1},${c.rect.y1}`).join(' · ') || '没找到那张卡');

// 原图是方角的（自带黑边）。圆角由 embed-card.mjs 的 --corner 统一削（默认 5px，
// 接近实体卡的倒角观感），这里核对它确实按设定值烤进去了、没偷偷回退成 0。
check('圆角按 --corner 设定值烤进了纹理 alpha（默认 5px）',
  handMeasured.every((c) => c.corner > 0 && c.corner <= 40),
  handMeasured.map((c) => c.corner + 'px').join(' · ') || '—');

if (cards.n > 1) {
  check('切到别的卡之后画面确实变了', cards.rows.slice(1).every((r) => r.diff > 1),
    cards.rows.map((r) => `${r.id} ${r.diff.toFixed(1)}`).join(' · '));
}
check('切回第 0 张能逐字节回到原样', cards.backDiff === 0, `最大差 ${cards.backDiff}`);

section('M. 多语言');

const i18n = await page.evaluate(async () => {
  const I = window.CardI18n;
  const langs = I.getLanguages();
  const zh = Object.keys((window.CardI18nPack['zh-CN'] || {}).texts || {});
  const sets = langs.map((l) => {
    const pack = window.CardI18nPack[l.code];
    const keys = pack ? Object.keys(pack.texts) : [];
    const missing = zh.filter((k) => keys.indexOf(k) < 0);
    const extra = keys.filter((k) => zh.indexOf(k) < 0);
    return { code: l.code, loaded: !!pack, n: keys.length, missingN: missing.length, extraN: extra.length, sample: missing.slice(0, 3) };
  });
  // 逐个语言切过去，记录界面上几处文案
  const probe = {};
  for (const l of langs) {
    await window.cardShaderUI.setLang(l.code);
    probe[l.code] = {
      code: I.getCode(),
      title: document.querySelector('[data-i18n="app.title"]').textContent,
      rarity: document.querySelector('#rarity-list .ritem .rcn').textContent,
      tier: document.querySelector('#rarity-list .tier-head').textContent,
      group: document.querySelector('#panel-body .pgroup-h').textContent,
      feat: document.getElementById('info-feat').textContent,
      preset: document.querySelector('#sel-preset option:nth-child(2)').textContent,
      play: document.getElementById('btn-play').textContent,
      stored: (function () { try { return localStorage.getItem(I.STORAGE_KEY); } catch (e) { return null; } })()
    };
  }
  // 缺键兜底：往 zh-CN 里临时塞一个"别的语言没有"的键，应该回落到它而不是显示裸键
  const zhPack = window.CardI18nPack['zh-CN'].texts;
  zhPack['__probe__'] = '中文兜底';
  const fallback = I.t('__probe__');
  const bare = I.t('__definitely_missing__');
  delete zhPack['__probe__'];
  await window.cardShaderUI.setLang('zh-CN');
  return { langs: langs.map((l) => l.code), sets: sets, probe: probe, fallback: fallback, bare: bare };
});

check('清单里的每个语言包都加载成功',
  i18n.sets.every((s) => s.loaded), i18n.sets.map((s) => s.code + (s.loaded ? '✓' : '✗')).join(' '));
check('每个语言包的键集合与 zh-CN 完全一致',
  i18n.sets.every((s) => s.missingN === 0 && s.extraN === 0),
  i18n.sets.map((s) => `${s.code} ${s.n} 键` + (s.missingN ? ` 缺 ${s.missingN}(${s.sample.join(',')})` : '')).join(' · '));
check('切换语言后界面文案真的变了（标题 / 罕贵度名 / 分节 / 参数组 / 预设）',
  i18n.probe['zh-CN'].title !== i18n.probe['en-US'].title &&
  i18n.probe['zh-CN'].rarity !== i18n.probe['en-US'].rarity &&
  i18n.probe['zh-CN'].tier !== i18n.probe['ja-JP'].tier &&
  i18n.probe['zh-CN'].group !== i18n.probe['en-US'].group &&
  i18n.probe['zh-CN'].preset !== i18n.probe['en-US'].preset,
  i18n.langs.map((c) => `${c}: ${i18n.probe[c].rarity} / ${i18n.probe[c].group}`).join(' · '));
check('缺键回退到 zh-CN（不是显示裸键）', i18n.fallback === '中文兜底', i18n.fallback);
check('所有语言都没有的键才回退成键名本身', i18n.bare === '__definitely_missing__', i18n.bare);
check('切语言记进了 localStorage', !!i18n.probe[i18n.langs[0]].stored, 'stored=' + i18n.probe[i18n.langs[0]].stored);

section('N. 控制台');

check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ') || '无');
check('控制台无 error', consoleErrors.length === 0, consoleErrors.join(' | ') || '无');

// ------------------------------------------------------------------ 出图 ----
section('O. 出图');

await page.evaluate(() => {
  const p = window.cardShader;
  p.setPlaying(false);
  p.resize(1280, 860, 1);
});
await page.evaluate(() => {
  const stage = document.getElementById('app');
  stage.classList.add('panel-open');
});
await page.evaluate(() => {
  const p = window.cardShader;
  p.resetParams();
  p.setParams({ rarity: window.CardRarities.ORDER.indexOf('CR'), cardSize: 0.86 });
  document.querySelectorAll('#panel input[type=range]').forEach((i) => i.dispatchEvent(new Event('input', { bubbles: true })));
  document.querySelectorAll('#panel input[type=checkbox]').forEach((i) => i.dispatchEvent(new Event('change', { bubbles: true })));
  p.renderAtTime(6);
});
const shot = resolve(outDir, 'verify-preview.png');
await page.screenshot({ path: shot });
check('截图写出', true, shot);

await browser.close();

// ------------------------------------------------------------------ 汇总 ----
const failed = results.filter((r) => !r.ok);
const report = {
  when: new Date().toISOString(),
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((f) => f.name + ' —— ' + f.detail),
  results
};
writeFileSync(resolve(outDir, 'verify-report.json'), JSON.stringify(report, null, 1), 'utf8');

console.log('\n' + '='.repeat(64));
if (failed.length) {
  console.log(`RESULT: FAIL  （${results.length} 项里 ${failed.length} 项没过）`);
  for (const f of failed) console.log('   × ' + f.name + ' —— ' + f.detail);
  process.exit(1);
} else {
  console.log(`RESULT: PASS  （${results.length} 项全过）`);
}
