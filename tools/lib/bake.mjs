// 烘焙核心的**源码文本**（供 tools/embed-card.mjs 注入到页面里 eval）。
//
// 核心在 js/bake.js —— 那是唯一的实现，index.html 也直接加载它（参数面板那个
// ⟳ 刷新按钮就是用它当场烤新图的）。这里只负责读成字符串。
//
// 同理 tools/lib/detect.mjs：像素只在浏览器页面里拿得到，所以两边都得把源码
// 注入页面再跑。共用同一份文本 = 共用同一套算法，不会出现"工具烤的"和
// "页面烤的"不一样。

import { readFileSync } from 'node:fs';

export const BAKE_SRC = readFileSync(new URL('../../js/bake.js', import.meta.url), 'utf8');
