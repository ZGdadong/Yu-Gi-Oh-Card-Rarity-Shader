// 重填 docs/rarity-shaders.md 里那几段**自动生成**的内容。
//
// 用法：node tools/gen-doc.mjs
//
// 为什么要有这个脚本：文档里最容易腐烂的就是"清单类"内容 —— 罕贵度表、工艺表、
// 验证结果。手工抄一遍，改了 js/rarities.js 之后必然对不上。所以这几段交给脚本填，
// tools/doc-check.mjs 再对着 js/ 里的真东西核一遍。
//
// 三段的标记（写在 docs/rarity-shaders.md 里）：
//   <!-- BEGIN:CRAFT-TABLE -->  ... 17 个工艺逐个说明表
//   <!-- BEGIN:RARITY-TABLE --> ... 43 条罕贵度 → 配方
//   <!-- BEGIN:VERIFY-SECTION --> ... 验证结果摘要（读 tools/.cache 里的报告）

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const docPath = resolve(root, 'docs', 'rarity-shaders.md');

// -------- 把经典脚本当模块求值（它们只依赖一个 window 对象）------------------
// 必须**共用一个 window、并且按 index.html 的顺序加载** ——
// config.js 里那句 `const RAR = global.CardRarities;` 是在加载时求值的。
const win = {};
function loadScript(rel) {
  // eslint-disable-next-line no-new-func
  new Function('window', readFileSync(resolve(root, rel), 'utf8'))(win);
  return win;
}
loadScript('js/shaders.js');
loadScript('js/rarities.js');
loadScript('js/config.js');
const SH = win.CardShaders;
const RAR = win.CardRarities;
const CFG = win.CardConfig;

// ---------------------------------------------------------------- 工艺说明 ----
// 参数含义是**手写的**（着色器注释里那段压缩成了表格），doc-check 会核对
// "每个工艺都在这里有说明"，漏了会报出来。
const CRAFT_DOC = {
  holo: ['宽光带全息闪膜（面闪的底子）', '强度, 花纹尺度, 条纹锐度, 域扭曲', '色相偏移, 视角增益, 暗部增强, **遮罩**', '流动速度, 细颗粒, ·, ·'],
  parallel: ['极细平行线光栅，倾斜时整片彩虹一起扫过去（爆闪）', '强度, 线密度, 线锐度, 暗部增强', '色带频率, 视角增益, 线角度, **遮罩**', '·'],
  diagonal: ['斜光栅 + 沿栅格随机的碎片色相，裂纹发白（银碎）', '强度, 碎格密度, 锐度, 暗部增强', '角度, 视角增益, 副方向混合, **遮罩**', '·'],
  prismatic: ['正反两个方向的细光栅交叉，交叉点炸白（白碎）', '强度, 密度, 交叉白, 暗部增强', '角度, 视角增益, 交叉混合, **遮罩**', '·'],
  starfoil: ['一格一颗四角星（astroid 曲线）', '强度, 密度, 星形锐度, 暗部增强', '视角增益, 星外底色, ·, **遮罩**', '·'],
  mosaic: ['方格闪膜，一格一个色相，格线压暗', '强度, 密度, 格线宽度, 暗部增强', '视角增益, 色相散布, ·, **遮罩**', '·'],
  voronoi: ['Voronoi 不规则碎片，碎片边亮（碎箔）', '强度, 碎片密度, 裂纹亮度, 暗部增强', '视角增益, 色相散布, ·, **遮罩**', '·'],
  kc: ['**电路板膜**（**两层铜**：主线路成组地朝一个方向走 + 45° 折角 + 过孔 + 粗"电源线" + 留白空地，副线路更细更稀、走向不同、与主层交叉）；配色限定在**蓝 / 黄 / 橙 / 红**四种，相邻的线常常不同色；**只有鼠标附近那一块显形** —— 以光标为圆心、半径 0.31 卡高的软斑（面积 ≈ 卡面 45%），**对焦那圈最亮、往外一路渐变**', '强度, 电路网格尺寸, 走线半宽, **可见半径**', '视角增益, 色相频率, **走线疏密阈值**, **遮罩**', '**留白阈值**, ·, ·, ·'],
  millennium: ['埃及象形字按格随机拼；一格一个字、随机镜像，字自带彩色折射。整片按波带分组，**任何角度最多 20% 的字显形**；另在整卡撒一层跟着角度变色的小金点（辅助层，很淡）。字与字之间**没有竖线**（实卡是图案膜不是线栅膜）', '强度, 可见窗口半宽, 字形强度, 字形密度', '视角增益, ·, ·, **遮罩**', '金点强度, 金点密度, 金点尺寸, ·'],
  stamp: ['周年水印（20th / 25th），按格平铺、隔行错开', '强度, 平铺尺寸, ·, **遮罩**', '图集格 x, 图集格 y, ·, ·', '偏移 x, 偏移 y, ·, ·'],
  emboss: ['把卡面明暗当高度场求梯度得法线，再用方向光打亮', '强度, 光照角度, 金属化程度, 高光', '**遮罩**, 细节尺度, 光照俯角, ·', '·'],
  ghost: ['幽灵只压遮罩选中的那一块（HR 用在**怪物图框**上，卡框 / 卡名 / 效果框不动）：去色 + 提对比 + 冷偏移 + 亮部发光；**某些角度会整片滑成面闪**（相位由观察角驱动，峰值那一段换成宽光带 + 域扭曲 + 细颗粒）', '强度, 幽灵彩虹强度, 对比度, 辉光', '**遮罩**, 面闪混合强度, 面闪花纹尺度, 面闪相位偏移', '面闪的角度增益, 面闪的流动速度, ·, ·'],
  metal: ['金 / 铂金箔：明暗映射到金属色 + 拉丝高光', '强度, 拉丝密度, 拉丝各向异性, 高光', '**遮罩**, 视角增益, 印刷保留度, ·', '·'],
  rainbow: ['以高光点为圆心按极坐标取色相的彩虹反射', '强度, 饱和度, 半径衰减, ·', '**遮罩**, 色相偏移, ·, ·', '·'],
  name: ['卡名笔画烫金 / 烫银 / 换色（走掩膜的 R 通道）', '强度, 金属明暗对比, 碎闪强度, ·', '渐变频率, 渐变相位, ·, ·', '·'],
  glitter: ['细碎亮点（**加法混合**）', '强度, 密度, 尺寸, 闪烁速度', '·, ·, ·, **遮罩**', '·'],
  gloss: ['缓慢扫过的宽高光（**加法混合**）', '强度, 频率, 锐度, 速度', '视角增益, ·, ·, **遮罩**', '·']
};

function craftTable() {
  const uses = {};
  for (const r of RAR.LIST) for (const l of r.layers) (uses[l.shader] = uses[l.shader] || []).push(r.code);

  const report = readReport('effects-report.json');
  const craftMeasured = {};
  if (report && report.craft) for (const c of report.craft) craftMeasured[c.shader] = c;

  const L = [];
  L.push('## 5. 17 个工艺逐个说明');
  L.push('');
  L.push('`uP0` / `uP1` / `uP2` 就是 §4 里那三个 vec4。加粗的 **遮罩** 那一格是"加工哪一块"，取值见 §4 的遮罩选择码。');
  L.push('');
  L.push('| 着色器 | 干什么 | `uP0` | `uP1` | `uP2` | 用在 | 实测均值差 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of SH.CRAFT) {
    const d = CRAFT_DOC[s];
    if (!d) throw new Error('工艺 ' + s + ' 在 gen-doc.mjs 里没有说明文字');
    const m = craftMeasured[s];
    const used = (uses[s] || []).length;
    L.push(`| \`${s}\` | ${d[0]} | ${d[1]} | ${d[2]} | ${d[3]} | ${used} 条 | ${m ? m.mean.toFixed(2) : '—'} |`);
  }
  L.push('');
  L.push(`> "实测均值差"是 \`tools/effects.mjs\` 里"借 SR 的位置只留这一层"跑出来的卡片区平均差（0~255 尺度）。`);
  L.push('> 只有 `glitter` / `stamp` / `name` 这几个是"小面积但很强"（单通道最大差 80~255），');
  L.push('> 所以它们的均值差看着小 —— 判定接通用的是三种情形，不只看均值。');
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- 罕贵度表 ----
function rarityTable() {
  const L = [];
  for (const t of Object.keys(RAR.TIERS)) {
    L.push('');
    L.push('### ' + RAR.TIERS[t]);
    L.push('');
    L.push('| 代码 | 中文 | 图层（按叠放顺序） | `p0` | 说明 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const r of RAR.LIST.filter((x) => x.tier === t)) {
      const layers = r.layers.length ? r.layers.map((l) => '`' + l.shader + '`').join(' → ') : '**（无）**';
      const p0 = r.layers.length
        ? r.layers.map((l) => '[' + l.p0.map((v) => Math.round(v * 1000) / 1000).join(', ') + ']').join('<br>')
        : '—';
      let note = r.render || '';
      if (r.like) note = '**同 ' + RAR.BY_ID[r.like].code + '。**' + (r.like_note ? r.like_note + ' ' : '') + note;
      L.push('| **' + r.code + '** | ' + r.cn + ' | ' + layers + ' | ' + p0 + ' | ' + note.replace(/\|/g, '\\|') + ' |');
    }
  }
  L.push('');
  L.push(`> 共 **${RAR.LIST.length} 条**。带 "**同 XX**" 的是"工艺相同、只有发行版本/封入率不同"的那几条 ——`);
  L.push('> 它们在 `js/rarities.js` 里用 `like:` 指向另一条，**图层只有一份定义**，不是抄出来的。');
  L.push('');
  return L.join('\n');
}

// -------------------------------------------------------------- 验证结果段 ----
function readReport(name) {
  const p = resolve(here, '.cache', name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function verifySection() {
  const v = readReport('verify-report.json');
  const e = readReport('effects-report.json');
  const L = [];
  L.push('## 9. 验证结果');
  L.push('');
  if (!v && !e) {
    L.push('> 还没有跑过验证。先跑 `node tools/verify.mjs` 与 `node tools/effects.mjs`，再跑 `node tools/gen-doc.mjs`。');
    L.push('');
    return L.join('\n');
  }
  if (v) {
    L.push(`**\`tools/verify.mjs\` —— ${v.passed}/${v.total} 项 ${v.failed.length ? 'FAIL' : 'PASS'}**`);
    L.push('');
    L.push('| 段 | 查什么 |');
    L.push('| --- | --- |');
    L.push('| A | `assets/35952884.jpg` 的 SHA-256 与生成时记录一致；`images/` 里那张没被改过 |');
    L.push('| B | 掩膜从 data URI 解回来覆盖率不变（含预乘 alpha 那一关）；纹理留白自洽 |');
    L.push('| C | "卡名笔画"确实落在黑字上；四块区域的占比都在合理区间 |');
    L.push('| D | 罕贵度 id 唯一、图层引用的着色器都存在、每条都有说明、遮罩码不越界 |');
    L.push('| E | 21 个片段着色器全部编译通过；43 个罕贵度都能出图 |');
    L.push('| F | 同时间点重复渲染逐字节一致；时间推进画面确实变 |');
    L.push('| G | 鼠标左右移动改变画面；关掉倾斜/鼠标驱动后一个像素都不动 |');
    L.push('| H | hash 编解码往返一致；非法输入被丢弃或夹紧 |');
    L.push('');
    L.push('```');
    L.push(`RESULT: ${v.failed.length ? 'FAIL' : 'PASS'}  （${v.total} 项）`);
    if (v.failed.length) for (const f of v.failed) L.push('  × ' + f);
    L.push('```');
    L.push('');
  }
  if (e) {
    L.push(`**\`tools/effects.mjs\` —— ${e.rarity.length} 个罕贵度 · ${e.craft.length} 个工艺 · ${e.params.length} 个参数 · ${e.presets.length} 个预设**`);
    L.push('');
    const changed = e.rarity.filter((r) => r.layers.length > 0);
    const same = e.rarity.filter((r) => r.layers.length === 0);
    L.push(`- 相对"平卡 N"改动最大的三个：` +
      changed.slice().sort((a, b) => b.mean - a.mean).slice(0, 3).map((r) => `${r.code} ${r.mean.toFixed(1)}`).join(' · '));
    L.push(`- 改动最小的三个：` +
      changed.slice().sort((a, b) => a.mean - b.mean).slice(0, 3).map((r) => `${r.code} ${r.mean.toFixed(1)}`).join(' · '));
    L.push(`- **${same.map((r) => r.code).join(' / ')} 与平卡完全相同**（平均差 0.00）——这是设计如此，见 §7`);
    L.push(`- ${e.params.filter((p) => p.ok).length}/${e.params.length} 个参数实测接通`);
    L.push('');
  }
  return L.join('\n');
}

// ------------------------------------------------------------------ 写回 ----
const doc = readFileSync(docPath, 'utf8');

function replaceSection(text, tag, content) {
  const begin = `<!-- BEGIN:${tag} -->`;
  const end = `<!-- END:${tag} -->`;
  const i = text.indexOf(begin);
  const j = text.indexOf(end);
  if (i < 0 || j < 0 || j < i) throw new Error('文档里找不到 ' + tag + ' 的标记');
  return text.slice(0, i + begin.length) + '\n' + content + text.slice(j);
}

let out = doc;
out = replaceSection(out, 'CRAFT-TABLE', craftTable());
out = replaceSection(out, 'RARITY-TABLE', rarityTable());
out = replaceSection(out, 'VERIFY-SECTION', verifySection());

writeFileSync(docPath, out, 'utf8');
console.log('已重填 docs/rarity-shaders.md：');
console.log('  · 工艺表      ', SH.CRAFT.length, '个工艺');
console.log('  · 罕贵度表    ', RAR.LIST.length, '条');
console.log('  · 验证结果段  ', (existsSync(resolve(here, '.cache', 'verify-report.json')) ? '有报告' : '（还没跑过 verify）'));
