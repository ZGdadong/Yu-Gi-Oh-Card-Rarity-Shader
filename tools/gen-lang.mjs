// 生成/重建 Languages/zh-CN.js（中文语言包）。
//
// 用法：
//   node tools/gen-lang.mjs          # 文件不存在才生成（不会覆盖手改过的内容）
//   node tools/gen-lang.mjs --force  # 强制重生成（会覆盖）
//
// 为什么要有个生成器：
//   界面文案本来散在 js/config.js（38 个参数的 label/hint）和 js/rarities.js
//   （43 条罕贵度的名称与说明）里。搬到语言包时如果手抄一遍，必然抄错或者抄漏。
//   所以这里**直接从代码里读出来**，只额外补一份"界面骨架"的文案（下面 CHROME）。
//
// 生成之后 Languages/zh-CN.js 就是一份普通文件，可以手改；
// tools/doc-check.mjs 会核对它与 js/ 里的原文是否还一致，改了代码忘了改语言包会被抓出来。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outFile = resolve(root, 'Languages', 'zh-CN.js');
const force = process.argv.indexOf('--force') >= 0;

// 按 index.html 的顺序、共用一个 window 求值（config.js 依赖 rarities.js）
const win = {};
for (const f of ['js/rarities.js', 'js/config.js']) {
  // eslint-disable-next-line no-new-func
  new Function('window', readFileSync(resolve(root, f), 'utf8'))(win);
}
const RAR = win.CardRarities;
const CFG = win.CardConfig;

// 界面骨架文案（这部分不在代码里，只能写在这儿）
const CHROME = {
  'app.title': '游戏王 罕贵度',
  'app.subtitle': 'OCG / TCG 工艺着色器',

  'topbar.preset': '预设',
  'topbar.custom': '（自定义）',
  'topbar.play': '▶ 播放',
  'topbar.pause': '⏸ 暂停',
  'topbar.reset': '↻ 重置',
  'topbar.panel': '⚙ 参数',
  'topbar.copy': '🔗 复制链接',
  'topbar.lang': '语言',
  'topbar.titlePlay': '空格',
  'topbar.titleReset': 'R',
  'topbar.titlePanel': 'P',

  'info.feature': '特征',
  'info.how': '怎么做的',
  'info.layers': '图层',

  'panel.title': '参数',
  'panel.close': '关闭面板',

  'tier.base': '§1 基础罕贵度',
  'tier.high': '§2 高级与特殊罕贵度',
  'tier.parallel': '§3 平行 / 爆闪类',
  'tier.dt': '§4 Duel Terminal 系列',
  'tier.other': '§5 其他活动 / 地区 / TCG 特殊',

  'group.观看': '观看',
  'group.工艺': '工艺',
  'group.调试': '调试',

  'status.passes': '{a} pass · {b} draw steps',
  'status.copied': '链接已复制（{n} 字符）',
  'status.initFail': '初始化失败：{msg}',
  'status.texFail': '纹理加载失败：{msg}',
  'status.noPreset': '找不到预设：{name}',
  'status.sameAs': '≈ {code}',

  // 有三条罕贵度在文档里就没有拉丁文简称（code 字段本身就是中文），
  // 这三条的显示名单独给键，其它 40 条的 code 是 N/R/SR… 这种，不用翻。
  'rarity.CPTP.code': 'CP / TP 等',
  'rarity.KOREAN.code': '韩文版',
  'rarity.ASIANEN.code': '亚洲英文版',

  'card.Shooting Quasar Dragon.name': 'Shooting Quasar Dragon',
  'card.Shooting Quasar Dragon.sub': 'シューティング・クエイサー・ドラゴン · 35952884',
  'card.Shooting Quasar Dragon.stats': '龙族 / 同调 / 效果 · 光 · ★12 · ATK 4000 / DEF 4000'
};

function build() {
  const texts = {};
  // 先放界面骨架，再放罕贵度与参数（后者量大）
  for (const k of Object.keys(CHROME)) texts[k] = CHROME[k];

  for (const r of RAR.LIST) {
    texts['rarity.' + r.id + '.short'] = r.cn;
    texts['rarity.' + r.id + '.full'] = r.en;
    texts['rarity.' + r.id + '.feat'] = r.feat;
    texts['rarity.' + r.id + '.render'] = (r.like_note ? r.like_note + ' ' : '') + (r.render || '');
  }

  for (const p of CFG.SPEC) {
    texts['p.' + p.key + '.label'] = p.label;
    if (p.hint) texts['p.' + p.key + '.hint'] = p.hint;
  }

  CFG.PRESETS.forEach((preset, i) => { texts['preset.' + i] = preset.name; });

  return texts;
}

if (existsSync(outFile) && !force) {
  console.log('已存在，未覆盖：', outFile, '（要重生成加 --force）');
  process.exit(0);
}

const texts = build();
const keys = Object.keys(texts);
const q = (s) => JSON.stringify(s);

const body = keys.map((k) => '    ' + q(k) + ': ' + q(texts[k])).join(',\n');

const file = `/*
 * zh-CN.js —— 中文语言包
 *
 * ${existsSync(outFile) ? '（本文件由 tools/gen-lang.mjs 生成过一次，之后可以手改）' : '（由 tools/gen-lang.mjs 生成）'}
 * 结构：{ code, name, texts: { 键: 文案 } }
 * 文案里可以用 {name} 这种占位符，CardI18n.t(key, {name: 'x'}) 会替换。
 *
 * 键的命名：
 *   app.*  topbar.*  info.*  panel.*  status.*     界面骨架
 *   tier.*                                         五个分节的标题
 *   group.*                                        参数面板的三组
 *   p.<参数名>.label / .hint                        38 个参数
 *   rarity.<罕贵度 id>.short / .full / .feat / .render   43 条罕贵度
 *   preset.<序号>                                   22 个预设
 *   card.<图片名>.name / .sub / .stats               每张卡在侧栏显示的信息
 *
 * 新增一条罕贵度 / 一个参数之后：node tools/gen-lang.mjs --force 会重建这份文件，
 * 然后照着新出现的键补其它语言包（tools/doc-check.mjs 会检查各语言包键是否齐）。
 */
(function (global) {
  'use strict';
  global.CardI18nPack = global.CardI18nPack || {};
  global.CardI18nPack['zh-CN'] = {
    code: 'zh-CN',
    name: '中文',
    texts: {
${body}
    }
  };
})(window);
`;

writeFileSync(outFile, file, 'utf8');
console.log('写入', outFile);
console.log('  · 键', keys.length, '个（骨架', Object.keys(CHROME).length,
  '· 罕贵度', RAR.LIST.length * 4, '· 参数', CFG.SPEC.length * 2, '· 预设', CFG.PRESETS.length, '）');
console.log('  · 体积', (file.length / 1024).toFixed(1), 'KB');
