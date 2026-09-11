// 卡片外沿检测的**源码文本**（供 tools/*.mjs 注入到页面里 eval）。
//
// 算法本身在 js/detect.js —— 那是唯一的实现，index.html 也直接加载它。
// 这里只负责把那份文件读成字符串，保持原来 `DETECT_SRC` 的导出名不变，
// 于是 tools/embed-card.mjs 与 tools/verify.mjs 一行都不用改。
//
// 为什么是"函数源码字符串"而不是直接 import：
// 检测要对**像素**跑，而像素只在浏览器页面里（canvas）拿得到，两个工具各自
// page.evaluate 时把这段源码注入进去。共用同一份文本 = 共用同一套算法。

import { readFileSync } from 'node:fs';

export const CARD_ASPECT = 59 / 86;   // 0.6860

export const DETECT_SRC = readFileSync(new URL('../../js/detect.js', import.meta.url), 'utf8');
