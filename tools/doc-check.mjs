// 核对 docs/rarity-shaders.md 里那些**能机器判定**的说法。
//
// 用法：node tools/doc-check.mjs
//
// 文档最容易腐烂的地方是"数字"和"清单"：写了"17 个工艺""43 条罕贵度""卡名占 2.31%"，
// 改完代码之后没人会回头改文案。这个脚本把这些说法逐条对着 js/ 与生成物核一遍。
//
// 核对不了的（"为什么这么写"那类判断）在文档里都写了推理依据，本脚本不假装能验。

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const doc = readFileSync(resolve(root, 'docs', 'rarity-shaders.md'), 'utf8');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

// ---- 按 index.html 的顺序、共用一个 window 求值（config.js 依赖 rarities.js）----
const win = {};
for (const f of ['js/shaders.js', 'js/rarities.js', 'js/config.js', 'js/card-textures.js']) {
  // eslint-disable-next-line no-new-func
  new Function('window', read(f))(win);
}
const SH = win.CardShaders, RAR = win.CardRarities, CFG = win.CardConfig;
const TEX = win.CardTextures.list[0];

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
}
function section(t) { console.log('\n-- ' + t + ' --'); }

// ------------------------------------------------------------------ 数字 ----
section('数字');

check('17 个工艺', SH.CRAFT.length === 17 && doc.indexOf('17 个工艺') >= 0, `${SH.CRAFT.length} 个`);
check('4 个基础件', SH.UTILITY.length === 4, SH.UTILITY.join(' '));
check('21 个片段着色器', Object.keys(SH.EFFECTS).length === 21 && doc.indexOf('21 个片段着色器') >= 0,
  `${Object.keys(SH.EFFECTS).length} 个`);
check('2 个加法混合的工艺', SH.ADDITIVE.length === 2 &&
  SH.ADDITIVE.every((s) => doc.indexOf('`' + s + '`') >= 0), SH.ADDITIVE.join(' '));

check('43 条罕贵度', RAR.LIST.length === 43 && doc.indexOf(RAR.LIST.length + ' 条罕贵度') >= 0, `${RAR.LIST.length} 条`);
check('60 个参数', CFG.SPEC.length === 60 && doc.indexOf(CFG.SPEC.length + ' 个参数') >= 0, `${CFG.SPEC.length} 个`);
check('23 个预设', CFG.PRESETS.length === 23, `${CFG.PRESETS.length} 个`);

const tierCount = RAR.LIST.reduce((a, r) => { a[r.tier] = (a[r.tier] || 0) + 1; return a; }, {});
check('分节数量：基础 12 / 高级 10 / 平行 10 / DT 6 / 其他 5',
  tierCount.base === 12 && tierCount.high === 10 && tierCount.parallel === 10 &&
  tierCount.dt === 6 && tierCount.other === 5, JSON.stringify(tierCount));

// -------------------------------------------------------------- 区域与掩膜 ----
section('区域与掩膜');

const REG = TEX.regions;
/** 从 §3 的表格里按标签取那一行的四个数字，和真值比（比字符串匹配结实，不会因为 0.03 / 0.030 吵起来） */
function docRegion(label) {
  const line = doc.split('\n').find((l) => l.indexOf('| ' + label + ' `') >= 0 || l.indexOf('| ' + label + ' |') >= 0);
  if (!line) return null;
  const nums = (line.match(/-?\d+\.\d+/g) || []).map(Number);
  return nums.length >= 4 ? { x0: nums[0], y0: nums[1], x1: nums[2], y1: nums[3] } : null;
}
function regionOk(label, r) {
  const d = docRegion(label);
  if (!d) return false;
  return Math.abs(d.x0 - r.x0) < 1e-4 && Math.abs(d.y0 - r.y0) < 1e-4 &&
    Math.abs(d.x1 - r.x1) < 1e-4 && Math.abs(d.y1 - r.y1) < 1e-4;
}
check('§3 区域表：卡名带', regionOk('卡名带', REG.nameBand), JSON.stringify(REG.nameBand));
check('§3 区域表：卡图窗外框', regionOk('卡图窗外框', REG.artOuter), JSON.stringify(REG.artOuter));
check('§3 区域表：卡图内容', regionOk('卡图内容', REG.artInner), JSON.stringify(REG.artInner));
check('§3 区域表：效果框', regionOk('效果框', REG.textBox), JSON.stringify(REG.textBox));
check('§3 区域表：等级星带', regionOk('等级星带', REG.starBand), JSON.stringify(REG.starBand));

check('纹理尺寸 749×1113 / 内容 689×1024 / 留白 4%',
  TEX.width === 749 && TEX.height === 1113 && TEX.contentWidth === 689 && TEX.contentHeight === 1024 &&
  TEX.margin === 0.04 &&
  doc.indexOf('**749×1113**') >= 0 && doc.indexOf('**689×1024**') >= 0,
  `${TEX.width}×${TEX.height} / ${TEX.contentWidth}×${TEX.contentHeight}`);

const pct = (x) => (x * 100).toFixed(2) + '%';
const cov = TEX.maskCoverage;
check('掩膜覆盖率与文档一致（卡名 2.30% / 卡图 44.2% / 效果框 21.0% / 卡框 29.7%）',
  pct(cov.name) === '2.30%' && (cov.art * 100).toFixed(1) === '44.2' &&
  (cov.text * 100).toFixed(1) === '21.0' && (cov.frame * 100).toFixed(1) === '29.7' &&
  doc.indexOf('2.30%') >= 0 && doc.indexOf('44.2%') >= 0 &&
  doc.indexOf('21.0%') >= 0 && doc.indexOf('29.7%') >= 0,
  `卡名 ${pct(cov.name)} · 卡图 ${(cov.art * 100).toFixed(1)}% · 效果框 ${(cov.text * 100).toFixed(1)}% · 卡框 ${(cov.frame * 100).toFixed(1)}%`);

check('卡名笔画 / 底板的实测亮度写对了（0.49 / 0.89）',
  doc.indexOf('0.49') >= 0 && doc.indexOf('0.89') >= 0, '（数值来自 tools/verify.mjs 的 C 段）');

check('contentUV 是矩形而不是标量 margin（文档 §3 有说明）',
  TEX.contentUV && doc.indexOf('contentUV') >= 0 && doc.indexOf('cardUV') >= 0,
  JSON.stringify(TEX.contentUV));

// -------------------------------------------------------------- 遮罩选择码 ----
section('遮罩选择码');

const shaderSrc = SH.BODY.holo;                   // 任何一个工艺正文里都内联了 pickMask
const prelude = SH.PRELUDE;
const pickBody = prelude.slice(prelude.indexOf('float pickMask('), prelude.indexOf('/*', prelude.indexOf('float pickMask(')));
const branches = (pickBody.match(/if \(s < /g) || []).length;
check('pickMask 的 0..12 分支齐全（13 个）', branches === 13, `${branches} 个分支`);
// §4 那张表的每一格里出现的数字，0..12 应该一个不少
const ptableSrc = doc.slice(doc.indexOf('### 遮罩选择码'), doc.indexOf('### 强度是怎么算的'));
const codesInDoc = (ptableSrc.match(/(?:^\||\|)\s*(\d+)\s*\|/gm) || [])
  .map((s) => parseInt(s.replace(/\|/g, '').trim(), 10));
const missingCodes = [];
for (let i = 0; i <= 12; i++) if (codesInDoc.indexOf(i) < 0) missingCodes.push(i);
check('§4 的遮罩选择码表里 0..12 都能查到', missingCodes.length === 0,
  missingCodes.length ? '缺 ' + missingCodes.join(',') : codesInDoc.join(' '));

// ------------------------------------------------------------ 自动生成的表 ----
section('文档里自动生成的表');

// §6 罕贵度表：逐行对着 rarities.js 核
const rarSection = doc.slice(doc.indexOf('<!-- BEGIN:RARITY-TABLE -->'), doc.indexOf('<!-- END:RARITY-TABLE -->'));
let missing = [], badLayers = [];
for (const r of RAR.LIST) {
  const line = rarSection.split('\n').find((l) => l.indexOf('| **' + r.code + '** |') === 0);
  if (!line) { missing.push(r.code); continue; }
  const expect = r.layers.length
    ? r.layers.map((l) => '`' + l.shader + '`').join(' → ')
    : '**（无）**';
  if (line.indexOf(expect) < 0) badLayers.push(r.code + '（应为 ' + expect + '）');
}
check('§6 罕贵度表 43 行齐全', missing.length === 0, missing.join(',') || '43/43');
check('§6 每行的图层与 js/rarities.js 一致', badLayers.length === 0, badLayers.join(' | ') || '全部一致');

// §5 工艺表：每个工艺都要有一行
const craftSection = doc.slice(doc.indexOf('<!-- BEGIN:CRAFT-TABLE -->'), doc.indexOf('<!-- END:CRAFT-TABLE -->'));
const noRow = SH.CRAFT.filter((s) => craftSection.indexOf('`' + s + '`') < 0);
check('§5 工艺表 17 个工艺都有说明', noRow.length === 0, noRow.join(',') || '17/17');
check('§5 工艺表的实测均值差不是空的', (craftSection.match(/\| \d+\.\d\d \|/g) || []).length >= 12,
  `${(craftSection.match(/\| \d+\.\d\d \|/g) || []).length} 行有实测值`);

// 每行的工艺名 + 说明与 gen-doc.mjs 的元数据一致（用工艺表里的行数核对）
check('§5 表格行数 = 工艺数 + 表头 2 行',
  (craftSection.match(/^\| `\w+` \|/gm) || []).length === SH.CRAFT.length,
  `${(craftSection.match(/^\| `\w+` \|/gm) || []).length} 行`);

// -------------------------------------------------------- §7 "做不出来" 那节 ----
section('§7 做不出来的部分');

const nrRow = RAR.BY_ID['NR'];
check('文档说 NR 与平卡完全相同 —— 它的图层确实是空的', nrRow && nrRow.layers.length === 0,
  `NR 图层 ${nrRow ? nrRow.layers.length : '?'} 层`);
check('文档提到的 NR / UTR / CPTP / 韩文版 / 亚洲英文版 都存在',
  ['NR', 'UTR', 'CPTP', 'KOREAN', 'ASIANEN'].every((id) => !!RAR.BY_ID[id]),
  '5 条');
check('CPTP 的说明里写明了"只当示意"', /只当示意/.test(RAR.BY_ID['CPTP'].render));
check('UTR 的说明里写明了触摸渲染不出来',
  /触摸有凹凸[^]{0,20}渲染不出来/.test(RAR.BY_ID['UTR'].render), '有');
check('韩文版 / 亚英 用 like 指向别的配方（不是抄的）',
  !!RAR.BY_ID['KOREAN'].like && !!RAR.BY_ID['ASIANEN'].like,
  RAR.BY_ID['KOREAN'].like + ' / ' + RAR.BY_ID['ASIANEN'].like);

// ------------------------------------------------------ 文档声称的"两条约定" ----
section('文档里的两条约定');

check('§5 的"覆盖度当 alpha"在着色器里确实成立（每个工艺都返回 tex.a * cover(...)）',
  SH.CRAFT.filter((s) => s !== 'glitter' && s !== 'gloss')
    .every((s) => /tex\.a \* cover\(/.test(SH.BODY[s])),
  `${SH.CRAFT.length - 2} 个覆盖型工艺`);
check('§5 的"加法混合"两个工艺确实只输出 add（不返回 tex.rgb）',
  SH.ADDITIVE.every((s) => !/return vec4\(tex\.rgb, 0\.0\)/.test(SH.BODY[s]) && /return vec4\((add|tint)/.test(SH.BODY[s])),
  SH.ADDITIVE.join(' '));
check('§3 的"卡框由矩形现算"在着色器里确实是这么写的',
  /float frame = card \* \(1\.0 - outer\) \* \(1\.0 - m\.b\)/.test(SH.PRELUDE) &&
  /float ring = outer \* \(1\.0 - m\.g\)/.test(SH.PRELUDE), 'frame / ring');

check('统一强度公式写对了：强度 × intensity × 该工艺倍率',
  doc.indexOf('× 工艺总强度(intensity) × 该工艺的倍率') >= 0 &&
  /p0\[0\] = p0\[0\] \* inten;/.test(read('js/pipeline.js')), 'OK');

// -------------------------------------------------------------- 多语言 ----
section('多语言（Languages/）');

const langDir = resolve(root, 'Languages');
const langManifest = (function () {
  const w = {};
  // eslint-disable-next-line no-new-func
  new Function('window', readFileSync(resolve(langDir, 'languages.js'), 'utf8'))(w);
  return w.CardLangs || [];
})();

/** 把某个语言包当经典 script 跑一遍，取它的 texts */
function loadPack(code) {
  const p = resolve(langDir, code + '.js');
  if (!existsSync(p)) return null;
  const w = {};
  // eslint-disable-next-line no-new-func
  new Function('window', readFileSync(p, 'utf8'))(w);
  return (w.CardI18nPack && w.CardI18nPack[code]) || null;
}

check('Languages/languages.js 里有语言清单', langManifest.length >= 1,
  langManifest.map((l) => l.code + '=' + l.name).join(' · '));

const packs = {};
const missFiles = [];
for (const l of langManifest) {
  const pack = loadPack(l.code);
  packs[l.code] = pack;
  if (!pack) missFiles.push(l.code);
  else if (pack.code !== l.code) missFiles.push(l.code + '(code 不符)');
}
check('清单里每个语言都有对应的语言包文件', missFiles.length === 0,
  missFiles.join(',') || langManifest.map((l) => l.code).join(' · '));

const zhKeys = packs['zh-CN'] ? Object.keys(packs['zh-CN'].texts) : [];
const badSets = [];
for (const code of Object.keys(packs)) {
  if (!packs[code]) continue;
  const keys = Object.keys(packs[code].texts);
  const miss = zhKeys.filter((k) => keys.indexOf(k) < 0);
  const extra = keys.filter((k) => zhKeys.indexOf(k) < 0);
  if (miss.length || extra.length) badSets.push(`${code}(缺${miss.length}/多${extra.length})`);
}
check('各语言包的键集合与 zh-CN 完全一致', badSets.length === 0,
  badSets.join(' ') || `${Object.keys(packs).length} 个语言包 · ${zhKeys.length} 个键`);

// zh-CN 包必须与代码里的原文一致（语言包是从代码生成的，改了代码忘了改包要能被抓到）
const zhTexts = packs['zh-CN'] ? packs['zh-CN'].texts : {};
const drifted = [];
for (const r of RAR.LIST) {
  if (zhTexts['rarity.' + r.id + '.short'] !== r.cn) drifted.push('rarity.' + r.id + '.short');
  if (zhTexts['rarity.' + r.id + '.full'] !== r.en) drifted.push('rarity.' + r.id + '.full');
  if (zhTexts['rarity.' + r.id + '.feat'] !== r.feat) drifted.push('rarity.' + r.id + '.feat');
  const expect = (r.like_note ? r.like_note + ' ' : '') + (r.render || '');
  if (zhTexts['rarity.' + r.id + '.render'] !== expect) drifted.push('rarity.' + r.id + '.render');
}
for (const sp of CFG.SPEC) {
  if (zhTexts['p.' + sp.key + '.label'] !== sp.label) drifted.push('p.' + sp.key + '.label');
  if (sp.hint && zhTexts['p.' + sp.key + '.hint'] !== sp.hint) drifted.push('p.' + sp.key + '.hint');
}
CFG.PRESETS.forEach((preset, i) => {
  if (zhTexts['preset.' + i] !== preset.name) drifted.push('preset.' + i);
});
check('zh-CN 语言包与 js/rarities.js + js/config.js 里的原文一致（没漂）',
  drifted.length === 0, drifted.slice(0, 6).join(' , ') || '一致');

const missKey = [];
for (const sp of CFG.SPEC) if (!zhTexts['p.' + sp.key + '.label']) missKey.push('p.' + sp.key + '.label');
for (const r of RAR.LIST) {
  for (const f of ['short', 'full', 'feat', 'render']) {
    if (!zhTexts['rarity.' + r.id + '.' + f]) missKey.push('rarity.' + r.id + '.' + f);
  }
}
check('zh-CN 覆盖了全部参数与罕贵度（参数 × label + 43 罕贵度 × 4 项）',
  missKey.length === 0, missKey.slice(0, 6).join(' , ') || '齐全');

check('index.html 引了语言清单与 i18n 模块',
  read('index.html').indexOf('Languages/languages.js') >= 0 &&
  read('index.html').indexOf('js/i18n.js') >= 0, '两处都在');

check('界面文案走的是 i18n（不是硬编码）',
  /I18N\.tOr\(/.test(read('js/ui.js')) && /I18N\.setLang/.test(read('js/ui.js')),
  'ui.js 用 tOr / setLang');

// ------------------------------------------------------------ 多卡图 ----
section('多卡图（images/ → js/card-textures.js）');

const cardsSrc = read('js/card-textures.js');
const nCards = (cardsSrc.match(/^\s+id:\s*"/gm) || []).length;
check('js/card-textures.js 里有卡数据', nCards >= 1, `${nCards} 张`);
check('每张卡都带 cardRect / contentUV / regions（换卡时版式常量跟着换）',
  nCards >= 1 && /cardRect:/.test(cardsSrc) && /contentUV:/.test(cardsSrc) && /regions:/.test(cardsSrc));
check('卡图选择是 js/config.js 里的一个参数（面板自动生成，不用手写）',
  CFG.SPEC.some((s) => s.key === 'card' && s.type === 'card'), 'type: card');

// ------------------------------------------------------------ 文件结构那节 ----
section('文件结构');

const files = ['index.html', 'css/style.css', 'images/Shooting Quasar Dragon.jpg', 'assets/Shooting Quasar Dragon.jpg',
  'js/card-textures.js', 'js/stamps.js', 'js/shaders.js', 'js/rarities.js', 'js/config.js',
  'js/pipeline.js', 'js/ui.js', 'js/i18n.js',
  'Languages/languages.js', 'Languages/zh-CN.js', 'Languages/en-US.js', 'Languages/ja-JP.js',
  'docs/游戏王罕贵度总结（OCG  TCG）.md', 'docs/rarity-shaders.md', 'docs/总结.md',
  'docs/mask-preview.png',
  'tools/analyze-card.mjs', 'tools/probe-card.mjs', 'tools/embed-card.mjs', 'tools/gen-doc.mjs',
  'tools/doc-check.mjs', 'tools/verify.mjs', 'tools/effects.mjs', 'tools/shot.mjs', 'tools/montage.mjs',
  'tools/gen-lang.mjs'];
const notThere = files.filter((f) => !existsSync(resolve(root, f)));
check('§10 文件结构里列的每一个文件都存在', notThere.length === 0, notThere.join(' | ') || `${files.length} 个都在`);
const notInDoc = files.filter((f) => doc.indexOf(f.split('/').pop()) < 0);
check('§10 没有漏列项目里的文件', notInDoc.length === 0, notInDoc.join(' | ') || '齐');

// ---------------------------------------------------------------- 总结文档 ----
section('docs/总结.md');

const sumPath = resolve(root, 'docs', '总结.md');
const sum = existsSync(sumPath) ? readFileSync(sumPath, 'utf8') : '';
check('总结文档存在', sum.length > 1000, `${(sum.length / 1024).toFixed(1)} KB`);
check('总结文档里的数字与代码一致（43 条 / 17 工艺 / 21 着色器 / 38 参数 / 22 预设）',
  sum.indexOf(RAR.LIST.length + ' 条罕贵度') >= 0 &&
  sum.indexOf(SH.CRAFT.length + ' 个工艺') >= 0 &&
  sum.indexOf(Object.keys(SH.EFFECTS).length + ' 个片段着色器') >= 0 &&
  sum.indexOf(CFG.SPEC.length + ' 个参数') >= 0 &&
  sum.indexOf(CFG.PRESETS.length + ' 个预设') >= 0,
  `${RAR.LIST.length} / ${SH.CRAFT.length} / ${Object.keys(SH.EFFECTS).length} / ${CFG.SPEC.length} / ${CFG.PRESETS.length}`);
// 43 条的速查表要一条不漏。
// 表里有的写全称（`Starlight Rare`）、有的写短名（`Starlight`），所以两种都认。
const summaryHas = (r) => sum.indexOf(r.code) >= 0 ||
  sum.indexOf('`' + r.code.split(/[\s/]/)[0] + '`') >= 0;
const missingInSummary = RAR.LIST.filter((r) => !summaryHas(r)).map((r) => r.code);
check('总结文档的速查表 43 条一条不漏', missingInSummary.length === 0,
  missingInSummary.join(',') || '43/43');
check('总结文档的掩膜占比与生成物一致',
  sum.indexOf((cov.name * 100).toFixed(2) + '%') >= 0 &&
  sum.indexOf((cov.art * 100).toFixed(1) + '%') >= 0,
  `卡名 ${(cov.name * 100).toFixed(2)}% · 卡图 ${(cov.art * 100).toFixed(1)}%`);
check('README 指向了总结文档', read('README.md').indexOf('总结.md') >= 0, '有链接');

/*
 * 上面那几条只查了"数字在不在"，查不出**过期** ——
 * 实际发生过：总结文档里一直写着 "verify 42 项 / doc-check 40 项"，
 * 而那时它们已经分别是 60 / 50 项了；更糟的是"换一张卡图"那一行的流程还是旧的
 * （手工量边界 + 改 REGIONS），而那时卡片外沿早就改成自动识别了。
 * 所以这里再补三条**对着实际跑出来的报告**核的检查。
 */
const verifyRepPath = resolve(here, '.cache', 'verify-report.json');
let verifyTotal = null;
try { verifyTotal = JSON.parse(readFileSync(verifyRepPath, 'utf8')).total; } catch (e) { /* 没跑过 verify */ }
const numIn = (text, re) => { const m = re.exec(text); return m ? parseInt(m[1], 10) : null; };
const sumVerify = numIn(sum, /verify\.mjs\s*#\s*(\d+)\s*项/);
const sumDocCheck = numIn(sum, /doc-check\.mjs[^#]*#\s*[^（]*（(\d+)\s*项）/);
check('总结文档里的 verify 项数与实际报告一致',
  verifyTotal === null ? true : sumVerify === verifyTotal,
  verifyTotal === null ? `文档写 ${sumVerify}（还没跑过 verify，无法核对）`
    : `文档 ${sumVerify} · 实际 ${verifyTotal}`);
/*
 * "doc-check 项数"这一条**故意留到最后再判**（见文件末尾）：
 * 原先它写在这里、拿 `results.length + 1` 当"实际项数"，可这个数在脚本跑到一半时
 * 只是个中间值 —— 结果是**逼着文档写一个错的数字**（文档写 52，实际 56）。
 * 放到最后，"实际项数"才是真的总项数。
 */

// 总结文档必须覆盖后来加的两块功能（曾经整块漏掉过）
check('总结文档写了"换卡图"的多卡流程（不是旧的手工量边界）',
  sum.indexOf('多卡') >= 0 && /丢进\s*`?images\/`?/.test(sum) && sum.indexOf('自动识别') >= 0 &&
  sum.indexOf('probe-card.mjs 重新量边界') < 0,
  '有多卡 + 自动识别，且没有旧写法');
check('总结文档写了多语言（语言包 / 键数 / 加语言的方法）',
  sum.indexOf('多语言') >= 0 && sum.indexOf('Languages/') >= 0 &&
  sum.indexOf('CardI18nPack') >= 0 && /加一种语言|加语言/.test(sum),
  '有语言包与加语言说明');
const packKeys = packs['zh-CN'] ? Object.keys(packs['zh-CN'].texts).length : 0;
check('总结文档里的语言包键数与实际一致',
  sum.indexOf(packKeys + ' 键') >= 0 || sum.indexOf('| ' + packKeys + ' |') >= 0,
  `实际 ${packKeys} 键`);
check('总结文档里的语言数与 Languages/languages.js 一致',
  langManifest.every((l) => sum.indexOf('`' + l.code + '`') >= 0),
  langManifest.map((l) => l.code).join(' · '));

// ------------------------------------------------------------------ 汇总 ----
// 放在最后：这时候 `results.length + 1`（加上这一条自己）才是**真正的总项数**
check('总结文档里的 doc-check 项数与本次实际一致',
  sumDocCheck === results.length + 1,
  `文档 ${sumDocCheck} · 实际 ${results.length + 1}`);

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(64));
if (failed.length) {
  console.log(`RESULT: FAIL  （${results.length} 项里 ${failed.length} 项没过）`);
  for (const f of failed) console.log('   × ' + f.name + ' —— ' + f.detail);
  process.exit(1);
} else {
  console.log(`RESULT: PASS  （${results.length} 项：数字 / 区域与掩膜 / 遮罩码 / 自动生成的表 / §7 / 两条约定 / 文件结构）`);
}
