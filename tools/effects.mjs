// 效果扫描：逐个罕贵度、逐个参数地实测"到底有没有接通"。
//
// 用法：node tools/effects.mjs [--w 640] [--h 900] [--csv]
//
// 它回答两个问题：
//   ① 每个罕贵度相对"平卡 N"到底改了什么？（卡片区平均差 / 变化像素比例 / 饱和度）
//      —— NR、DT-N 这类**本来就该什么都没改**，报告里会明确写出来。
//   ② 每个参数真的接通了吗？（改一个参数，画面必须动）
//      判定用三种认可情形：大面积温和变化（均值差 > 0.6）、
//      小面积较强变化（> 0.4% 像素且单通道差 > 24）、极小面积极强变化（单通道差 > 60）。
//
// 逐参数扫描时会**临时合成一个"全工艺"罕贵度**（把所有罕贵度的图层并起来），
// 这样每个工艺参数都有作用对象，不会因为"当前这个罕贵度没用到这个工艺"而误判成没接通。

import { chromium } from 'playwright-core';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outDir = resolve(here, '.cache');
mkdirSync(outDir, { recursive: true });

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const W = parseInt(flag('w', '640'), 10);
const H = parseInt(flag('h', '900'), 10);
const CSV = argv.indexOf('--csv') >= 0;

const url = pathToFileURL(resolve(projectRoot, 'index.html')).href;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });

const out = await page.evaluate(() => {
  const p = window.cardShader;
  const CFG = window.CardConfig;
  const RAR = window.CardRarities;
  const SH = window.CardShaders;

  p.setPlaying(false);
  p.setMouseOutside();
  p.stop();
  p.resize(640, 900, 1);

  // 基准状态：无自动摆动、无鼠标，卡片缩小到 0.72 ——
  // **卡片不能铺满画布**：投影和背景都在卡片外面，卡片一铺满就什么都看不见了。
  // 背景/投影默认开着，这样 bgSpin、shadowOn 这些参数才有作用对象。
  const BASE = { bgOn: 1, shadowOn: 1, autoSway: 0, cardSize: 0.72 };
  function setState(patch) {
    p.resetParams();
    p.setParams(Object.assign({}, BASE, patch));
  }
  function frame(patch, time) {
    setState(patch);
    p.renderAtTime(time === undefined ? 6 : time);
    return p.cardRegionPixels();
  }
  function diff(a, b) {
    const n = Math.min(a.data.length, b.data.length);
    let sum = 0, cnt = 0, changed = 0, strong = 0, max = 0;
    for (let i = 0; i < n; i++) {
      if ((i & 3) === 3) continue;
      const d = Math.abs(a.data[i] - b.data[i]);
      sum += d; cnt++;
      if (d > 24) strong++;
      if (d) { changed++; if (d > max) max = d; }
    }
    return {
      mean: cnt ? sum / cnt : 0,
      changed: n ? changed / (n * 0.75) : 0,
      strongRatio: n ? strong / (n * 0.75) : 0,
      max: max
    };
  }
  /** 三种认可情形 */
  function connected(d) {
    return d.mean > 0.6 || (d.strongRatio > 0.004 && d.max > 24) || d.max > 60;
  }

  // ---------------------------------------------------- ① 逐罕贵度 ----
  const nIdx = RAR.ORDER.indexOf('N');
  setState({ rarity: nIdx });
  p.renderAtTime(6);
  const nPix = p.cardRegionPixels();
  const nStat = p.cardRegionStats();

  const rarityRows = [];
  for (const r of RAR.LIST) {
    const idx = RAR.ORDER.indexOf(r.id);
    setState({ rarity: idx });
    p.renderAtTime(6);
    const pix = p.cardRegionPixels();
    const st = p.cardRegionStats();
    const d = diff(nPix, pix);
    rarityRows.push({
      id: r.id, code: r.code, cn: r.cn, tier: r.tier,
      layers: r.layers.map((l) => l.shader),
      mean: d.mean, changed: d.changed, max: d.max,
      cardMean: st.mean, sat: st.satMean, bright: st.brightRatio
    });
  }

  // ---------------------------------------------------- ② 逐参数 ----
  //
  // 逐参数扫描要解决一个麻烦：**一个参数只对"用它那个工艺"有作用**。
  // 第一版的做法是把所有罕贵度的图层并成一个"全工艺"卡片，结果后面那些
  // 整卡覆盖层（棱彩/爆闪/金属…）把前面的层全盖住了，于是 mHolo 调成 0 画面
  // 一点变化都没有，被判成"没接通" —— 其实是**扫描工况不对**，不是代码不对。
  //
  // 现在的做法：
  //   · 工艺参数 → 现合成一个"只含这个参数管辖的那几个工艺"的罕贵度
  //   · 其它参数 → 用"全工艺"卡片
  //   · 判定同时看**卡片区**与**全屏**两个区域（背景/投影只在卡片外面看得出来）
  const allLayers = [];
  const seen = new Set();
  for (const r of RAR.LIST) {
    for (const l of r.layers) {
      if (seen.has(l.shader)) continue;
      seen.add(l.shader);
      allLayers.push(l);
    }
  }
  // 每个工艺挑一条"最强的"配方当代表
  const strongest = {};
  for (const r of RAR.LIST) {
    for (const l of r.layers) {
      if (!strongest[l.shader] || l.p0[0] > strongest[l.shader].p0[0]) strongest[l.shader] = l;
    }
  }
  const synthOf = (shaders) => ({
    id: '__SYN', code: '__SYN', cn: '扫描用', en: 'scan', tier: 'other',
    feat: '', render: '', layers: shaders.map((s) => strongest[s]).filter(Boolean)
  });
  // 参数名 → 它管辖的工艺（与 js/pipeline.js 的 CRAFT_MULT 必须一致）
  const CRAFT_MULT = {
    holo: 'mHolo', parallel: 'mParallel', diagonal: 'mDiagonal', prismatic: 'mPrismatic',
    emboss: 'mEmboss', metal: 'mMetal', rainbow: 'mRainbow', ghost: 'mGhost',
    glitter: 'mGlitter', stamp: 'mStamp', name: 'mName',
    starfoil: 'mPattern', mosaic: 'mPattern', voronoi: 'mPattern',
    kc: 'mPattern', millennium: 'mPattern'
  };
  const craftsOfParam = {};
  for (const sh of Object.keys(CRAFT_MULT)) {
    const k = CRAFT_MULT[sh];
    (craftsOfParam[k] = craftsOfParam[k] || []).push(sh);
  }
  // 这几个参数的名字里看不出它管哪个工艺，手工点明（不然扫描时它会被埋在别的层底下）
  const PARAM_CRAFT = {
    nameTintOn: ['name'], nameTint: ['name'],
    metalTintOn: ['metal'], metalTint: ['metal'],
    embossAngle: ['emboss'], embossDetail: ['emboss'],
    stampAmount: ['stamp'], glitterSize: ['glitter']
  };
  // 有几个参数是**成对**的：颜色本身不生效，得先把对应的开关打开
  const PARAM_ALSO = {
    nameTint: { nameTintOn: 1 },
    metalTint: { metalTintOn: 1 }
  };
  const allShaders = [];
  for (const r of RAR.LIST) for (const l of r.layers) if (allShaders.indexOf(l.shader) < 0) allShaders.push(l.shader);

  RAR.LIST.push(synthOf(allShaders));
  RAR.ORDER.push('__SYN');
  RAR.BY_ID['__SYN'] = synthOf(allShaders);
  const synIdx = RAR.ORDER.length - 1;

  p.setMouse(320 - 120, 450 - 160);       // 鼠标放在卡上：视角类参数才有效果
  const VIEW = { autoSway: 0.5, tiltAmount: 0.6, speed: 1, viewGain: 1, bgOn: 1, shadowOn: 1 };

  function grab(craftList, patch) {
    // 换掉合成罕贵度的图层，再渲染
    const arr = craftList && craftList.length ? craftList : allShaders;
    RAR.BY_ID['__SYN'].layers = arr.map((s) => strongest[s]).filter(Boolean);
    setState(Object.assign({ rarity: synIdx }, VIEW, patch));
    p.resize(640, 900, 1);
    p.renderAtTime(6);
    const full = p.pixels();
    const cr = p.cardContentRect();
    const w = p.canvas.width, hgt = p.canvas.height;
    // 卡片**下沿外侧**那一条的亮度：投影只在这里看得出来，而它又是个宽而淡的变化，
    // 用"逐像素差"去判很容易被判成"没接通"（实测就是这样）。
    let sum = 0, n = 0;
    const x0 = Math.round(cr.x0 + (cr.x1 - cr.x0) * 0.15);
    const x1 = Math.round(cr.x0 + (cr.x1 - cr.x0) * 0.85);
    for (let y = Math.round(cr.bot) + 2; y <= Math.round(cr.bot) + 22; y += 2) {
      const bufY = hgt - 1 - y;
      if (bufY < 0) continue;
      for (let x = x0; x < x1; x += 3) {
        const i = (bufY * w + x) * 4;
        sum += (full[i] + full[i + 1] + full[i + 2]) / 3;
        n++;
      }
    }
    return { card: p.cardRegionPixels(), full: full, w: w, h: hgt, belowLuma: n ? sum / n : 0 };
  }
  function diff2(a, b) {
    const dc = diff(a.card, b.card);
    // 全屏：尺寸可能被 sheetOn 改过，取了较小的一块比
    const n = Math.min(a.full.length, b.full.length);
    let sum = 0, cnt = 0, strong = 0, max = 0;
    for (let i = 0; i < n; i++) {
      if ((i & 3) === 3) continue;
      const d = Math.abs(a.full[i] - b.full[i]);
      sum += d; cnt++;
      if (d > 24) strong++;
      if (d > max) max = d;
    }
    const full = { mean: cnt ? sum / cnt : 0, strongRatio: cnt ? strong / cnt : 0, max };
    // 两个区域有一个成立就算接通；都不成立时报告**变化更大的那个**，免得读数误导
    const pass = (x) => x.mean > 0.6 || (x.strongRatio > 0.004 && x.max > 24) || x.max > 60;
    let win;
    if (pass(dc)) win = dc;
    else if (pass(full)) win = full;
    else win = full.mean > dc.mean ? full : dc;
    return { mean: win.mean, strongRatio: win.strongRatio, max: win.max, where: win === dc ? '卡片区' : '全屏' };
  }

  const paramRows = [];
  const cardCount = (window.CardTextures ? window.CardTextures.list.length : 1);
  for (const sp of CFG.SPEC) {
    // ---- card 是特例：images/ 下只有一张卡时**无从比较** ----
    if (sp.key === 'card' && cardCount < 2) {
      paramRows.push({
        key: sp.key, group: sp.group, label: sp.label, type: sp.type, value: 0,
        mean: 0, strongRatio: 0, max: 0, where: '—', ok: true,
        note: `images/ 下只有 ${cardCount} 张卡，没有第二张可切（多丢几张图再跑 node tools/embed-card.mjs 就会被真正测到）`
      });
      continue;
    }

    // ---- shadowOn 也是特例：投影是个**宽而淡**的变化，逐像素差判不出来 ----
    // 改成量"卡片下沿外侧那一条"的平均亮度：开投影必须明显变暗。
    if (sp.key === 'shadowOn') {
      const withShadow = grab(null, { shadowOn: 1, bgOn: 1 });
      const without = grab(null, { shadowOn: 0, bgOn: 1 });
      const drop = without.belowLuma - withShadow.belowLuma;
      paramRows.push({
        key: sp.key, group: sp.group, label: sp.label, type: sp.type, value: 1,
        mean: 0, strongRatio: 0, max: drop, where: '卡片外侧',
        ok: drop > 1.5,
        note: `卡片下沿外侧平均亮度 开 ${withShadow.belowLuma.toFixed(1)} / 关 ${without.belowLuma.toFixed(1)}（暗了 ${drop.toFixed(1)}）`
      });
      continue;
    }

    // ---- speed 是特例：它只改**实时播放的推进速率**，定格渲染看不出来 ----
    // 所以用合成时间戳测：喂两个相隔 10ms 的时间戳，看 this.time 前进了多少倍。
    if (sp.key === 'speed') {
      const measure = (s) => {
        RAR.BY_ID['__SYN'].layers = allShaders.map((x) => strongest[x]).filter(Boolean);
        setState({ rarity: synIdx, speed: s, autoSway: 0, bgOn: 0 });
        p.playing = true; p.lastTs = 0; p.time = 0;
        p.render(1000);
        p.render(1010);
        const dt = p.time;
        p.playing = false; p.stop();
        return dt;
      };
      const t1 = measure(1), t2 = measure(2);
      const ratio = t1 > 0 ? t2 / t1 : 0;
      paramRows.push({
        key: sp.key, group: sp.group, label: sp.label, type: sp.type, value: 2,
        mean: 0, strongRatio: 0, max: 0, where: '时钟',
        ok: t1 > 0 && Math.abs(ratio - 2) < 0.05,
        note: `10ms 时间戳 → ${t1.toFixed(4)}s / ${t2.toFixed(4)}s（比值 ${ratio.toFixed(3)}）`
      });
      continue;
    }

    let candidates;
    const cur = CFG.defaults()[sp.key];
    if (sp.type === 'check') candidates = [cur ? 0 : 1, cur ? 1 : 0];   // 两个方向都试
    else if (sp.type === 'color') candidates = [cur === '#d8e4ff' ? '#ff4444' : '#22ff88'];
    else if (sp.type === 'select') candidates = [(Math.round(cur) + 7) % RAR.ORDER.length];
    else {
      const v = (f) => sp.min + (sp.max - sp.min) * f;
      candidates = [cur, v(0), v(0.25), v(0.6), v(1)];
    }
    const craftList = craftsOfParam[sp.key] || PARAM_CRAFT[sp.key] || null;
    const also = PARAM_ALSO[sp.key] || {};
    const base = grab(craftList, Object.assign({ [sp.key]: cur }, also));

    let best = null, bestVal = null;
    for (const val of candidates) {
      let d;
      if (sp.key === 'stampCells') {
        // 它只画在覆盖层上，WebGL 像素不会变 —— 直接比覆盖层的 toDataURL
        const a = (grab(craftList, { [sp.key]: cur }), p.overlay.toDataURL());
        const b = (grab(craftList, { [sp.key]: val }), p.overlay.toDataURL());
        d = { mean: a === b ? 0 : 99, strongRatio: a === b ? 0 : 1, max: a === b ? 0 : 255, where: '覆盖层' };
      } else {
        d = diff2(base, grab(craftList, Object.assign({ [sp.key]: val }, also)));
      }
      if (!best || d.mean > best.mean) { best = d; bestVal = val; }
      if (best.mean > 0.6 || best.max > 60) break;
    }
    paramRows.push({
      key: sp.key, group: sp.group, label: sp.label, type: sp.type,
      value: bestVal, mean: best.mean, strongRatio: best.strongRatio, max: best.max,
      where: best.where, ok: best.mean > 0.6 || (best.strongRatio > 0.004 && best.max > 24) || best.max > 60
    });
  }

  // ---------------------------------------------------- ③ 逐工艺单独作用 ----
  // 借一个罕贵度的位置，把它的图层临时换成"只有这一个工艺"。
  //
  // **每个工艺要在几个时间点上各测一遍**：有些层本来就是"扫过去"的
  // （`gloss` 是卡面扫光、`glitter` 是跳动的亮点），固定某一个时间点可能正好扫到卡外，
  // 于是把一层好端端的效果判成"没接通"。取证最明显的那个时间点，并把时间记进报告。
  const TEST_TIMES = [0, 1.6, 3.2, 4.8, 6.4, 8.0, 9.6];
  const craftRows = [];
  const victim = RAR.BY_ID['SR'];
  const savedLayers = victim.layers;
  for (const shader of SH.CRAFT) {
    // 从既有配方里挑这个工艺最典型的参数（强度取最大的一条）
    let pick = null;
    for (const r of RAR.LIST) {
      for (const l of r.layers) {
        if (l.shader !== shader) continue;
        if (!pick || l.p0[0] > pick.p0[0]) pick = l;
      }
    }
    if (!pick) { craftRows.push({ shader, ok: false, note: '没有任何配方用到' }); continue; }
    victim.layers = [pick];
    let best = null, bestT = 0;
    for (const t of TEST_TIMES) {
      const a = frame({ rarity: RAR.ORDER.indexOf('SR') }, t);
      const b = frame({ rarity: nIdx }, t);
      const d = diff(b, a);
      if (!best || d.mean > best.mean) { best = d; bestT = t; }
      if (best.mean > 0.6) break;
    }
    victim.layers = savedLayers;
    craftRows.push({
      shader, ok: connected(best), t: bestT,
      mean: best.mean, changed: best.changed, max: best.max,
      params: pick.p0.map((x) => +x.toFixed(2))
    });
  }
  // 还原
  victim.layers = savedLayers;
  RAR.LIST.pop(); RAR.ORDER.pop(); delete RAR.BY_ID['__SYN'];

  // ---------------------------------------------------- ④ 预设 ----
  const presetRows = [];
  for (let i = 0; i < CFG.PRESETS.length; i++) {
    p.resetParams();
    p.setParams(CFG.PRESETS[i].patch);
    p.resize(640, 900, 1);
    p.renderAtTime(6);
    const st = p.cardRegionStats();
    presetRows.push({ i: i, name: CFG.PRESETS[i].name, mean: st.mean, ok: st.mean > 10 });
  }

  return { rarityRows, paramRows, craftRows, presetRows, nStat: nStat.mean, layersTotal: allLayers.length };
});

await browser.close();

// ------------------------------------------------------------------ 报告 ----
const pad = (s, n) => { s = String(s); let w = 0; for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); };

console.log(`状态基准：平卡 N 卡片区平均亮度 ${out.nStat.toFixed(1)}\n`);

console.log('-- ① 每个罕贵度相对"平卡 N"改了什么 --');
console.log('  ' + pad('罕贵度', 12) + pad('名称', 14) + pad('图层', 46) + pad('均值差', 9) + pad('变化像素', 10) + pad('饱和度', 8));
for (const r of out.rarityRows) {
  const unchanged = r.layers.length === 0;
  console.log('  ' + pad(r.code, 12) + pad(r.cn, 14) +
    pad(r.layers.join('+') || '（无）', 46) +
    pad(r.mean.toFixed(2), 9) + pad((r.changed * 100).toFixed(1) + '%', 10) +
    pad(r.sat.toFixed(1), 8) + (unchanged ? '  ← 本来就与平卡完全相同' : ''));
}

console.log('\n-- ② 逐工艺单独作用（借 SR 的位置，只留这一层；扫光的层在多个时间点上取最明显的）--');
console.log('  ' + pad('着色器', 14) + pad('均值差', 9) + pad('变化像素', 10) + pad('最大差', 8) + pad('取样时刻', 10) + '参数 p0');
for (const c of out.craftRows) {
  console.log('  ' + pad(c.shader, 14) + pad(c.ok ? c.mean.toFixed(2) : '—', 9) +
    pad(c.ok ? (c.changed * 100).toFixed(1) + '%' : '—', 10) +
    pad(c.ok ? c.max : '—', 8) +
    pad(c.ok ? 't=' + c.t + 's' : '—', 10) +
    (c.params ? '[' + c.params.join(', ') + ']' : (c.note || '')) +
    (c.ok ? '' : '   ← 没接通'));
}

console.log('\n-- ③ 逐参数（工艺参数各用一个"只含它管辖工艺"的合成卡片扫描）--');
const bad = out.paramRows.filter((r) => !r.ok);
console.log('  ' + pad('参数', 18) + pad('组', 8) + pad('取值', 12) + pad('均值差', 9) + pad('强变化', 9) + pad('判据', 8) + '判定');
for (const r of out.paramRows) {
  console.log('  ' + pad(r.key, 18) + pad(r.group, 8) +
    pad(typeof r.value === 'number' ? r.value.toFixed(3) : String(r.value), 12) +
    pad(r.mean.toFixed(2), 9) + pad((r.strongRatio * 100).toFixed(2) + '%', 9) +
    pad(r.where || '', 8) +
    (r.ok ? '生效' : '**没接通**') + (r.note ? '  ' + r.note : ''));
}

console.log('\n-- ④ 预设 --');
console.log('  ' + out.presetRows.map((r) => r.i).join(' '));
console.log('  ' + out.presetRows.map((r) => (r.ok ? '✓' : '×')).join(' '));

const report = {
  when: new Date().toISOString(),
  rarity: out.rarityRows, params: out.paramRows, craft: out.craftRows, presets: out.presetRows
};
writeFileSync(resolve(outDir, 'effects-report.json'), JSON.stringify(report, null, 1), 'utf8');

if (CSV) {
  const lines = ['kind,name,tier_or_group,layers_or_value,mean,changed,max'];
  for (const r of out.rarityRows) lines.push(`rarity,${r.code},${r.tier},"${r.layers.join('+')}",${r.mean.toFixed(3)},${r.changed.toFixed(4)},${r.max}`);
  for (const c of out.craftRows) lines.push(`craft,${c.shader},-,"",${(c.mean || 0).toFixed(3)},${(c.changed || 0).toFixed(4)},${c.max || 0}`);
  for (const r of out.paramRows) lines.push(`param,${r.key},${r.group},${r.value},${r.mean.toFixed(3)},${r.strongRatio.toFixed(4)},${r.max}`);
  writeFileSync(resolve(outDir, 'effects-report.csv'), lines.join('\n'), 'utf8');
}

console.log('\n' + '='.repeat(64));
const fails = [];
if (bad.length) fails.push(`${bad.length} 个参数没接通: ` + bad.map((b) => b.key).join(', '));
const craftBad = out.craftRows.filter((c) => !c.ok);
if (craftBad.length) fails.push(`${craftBad.length} 个工艺没接通: ` + craftBad.map((c) => c.shader).join(', '));
const presetBad = out.presetRows.filter((r) => !r.ok);
if (presetBad.length) fails.push(`${presetBad.length} 个预设出不了图`);
const realChanges = out.rarityRows.filter((r) => r.layers.length > 0 && r.mean < 0.6 && r.max < 24);
if (realChanges.length) fails.push(`${realChanges.length} 个罕贵度相对平卡几乎没变化: ` + realChanges.map((r) => r.code).join(', '));
if (errs.length) fails.push('控制台报错: ' + errs.join(' | '));

if (fails.length) {
  console.log('RESULT: FAIL');
  for (const f of fails) console.log('   × ' + f);
  process.exit(1);
} else {
  console.log(`RESULT: PASS  （${out.rarityRows.length} 个罕贵度 · ${out.craftRows.length} 个工艺 · ` +
    `${out.paramRows.length} 个参数 · ${out.presetRows.length} 个预设全部检查过）`);
}
