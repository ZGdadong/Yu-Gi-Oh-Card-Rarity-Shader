/*
 * languages.js —— 语言清单
 *
 * 加一种语言：
 *   ① 复制 Languages/zh-CN.js，改名成 xx-XX.js（BCP 47 语言标签）；
 *   ② 改里面的 code / name，把 texts 的值翻过去（**键一个都不要动**）；
 *   ③ 在这个清单里加一行；
 *   ④ 刷新页面 → 右上角语言下拉框里就有了。
 *
 * 语言代码用 BCP 47（语言-地区），例如 zh-CN（中文·中国大陆）、
 * en-US（English·美国）、ja-JP（日本語·日本）。
 *
 * tools/doc-check.mjs 会检查：这个清单里的每个语言包都存在、
 * 而且各语言包的键集合与 zh-CN 完全一致。
 */
(function (global) {
  'use strict';
  global.CardLangs = [
    { code: 'zh-CN', name: '中文' },
    { code: 'en-US', name: 'English' },
    { code: 'ja-JP', name: '日本語' }
  ];
})(window);
