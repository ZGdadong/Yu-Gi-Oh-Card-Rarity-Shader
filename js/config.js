/*
 * config.js —— 参数表 / 预设 / 地址栏 hash 编解码
 *
 * 参数分三组：
 *   ① 看片子的   视角、倾斜、卡片大小、背景、投影
 *   ② 调工艺的   每个工艺一个**强度倍率**（作用在 js/rarities.js 那份配方之上）
 *   ③ 调试的     掩膜图层、逐层透传
 *
 * 之所以用"倍率"而不是把每个着色器的每个 uniform 都做成滑条：
 * 一份罕贵度配方有几十个数（尺度、锐度、色相、密度…），全摊开就是几百个滑条。
 * 倍率能让人**一边拖一边看这个工艺到底在干什么**，这才是要展示的东西。
 *
 * 经典脚本（非 ES module），file:// 双击可用。
 */
(function (global) {
  'use strict';

  const RAR = global.CardRarities;

  // 参数表。type: range / check / color / select
  const SPEC = [
    // ---- ① 观看 ----
    { key: 'card', group: '观看', label: '卡图', type: 'card', def: 0, hint: 'images/ 下有几张就列出几张（换图之后重跑 node tools/embed-card.mjs 即可）' },
    { key: 'rarity', group: '观看', label: '罕贵度', type: 'select', def: 2, hint: '选一个罕贵度，卡面按 js/rarities.js 里那份配方重新叠一遍' },
    { key: 'intensity', group: '观看', label: '工艺总强度', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: '所有工艺层的强度一起缩放。0 = 完全回到原始印刷' },
    { key: 'viewGain', group: '观看', label: '视角灵敏度', type: 'range', min: 0, max: 3, step: 0.01, def: 1, hint: '倾斜驱动闪膜衍射相位的力度' },
    { key: 'tiltAmount', group: '观看', label: '倾斜幅度', type: 'range', min: 0, max: 1, step: 0.01, def: 0.45, hint: '鼠标移到卡上时卡片真的转多少（度）。0 = 卡片不动，只有闪膜变' },
    { key: 'hoverOn', group: '观看', label: '鼠标驱动倾斜', type: 'check', def: 1, hint: '关掉之后鼠标在卡上移动不再改变倾斜与视角（画面只剩自动摆动）' },
    { key: 'tiltInvert', group: '观看', label: '倾斜反向（鼠标处下沉）', type: 'check', def: 1, hint: '**默认打开**：鼠标指到卡片哪一侧，那一侧就**往里沉**（像用手指按住卡片）。关掉则反过来 —— 那一侧朝你翘起来' },
    { key: 'autoSway', group: '观看', label: '自动摆动', type: 'range', min: 0, max: 1, step: 0.01, def: 0.35, hint: '鼠标离开时卡片自己慢慢摇，闪膜一直在动，不用手也有得看' },
    { key: 'swaySpeed', group: '观看', label: '摆动速度', type: 'range', min: 0, max: 2, step: 0.01, def: 0.5 },
    { key: 'speed', group: '观看', label: '时间倍率', type: 'range', min: 0, max: 3, step: 0.01, def: 1, hint: '闪膜流动/闪粉跳动的速度' },
    { key: 'cornerPx', group: '观看', label: '卡片圆角 (px)', type: 'range', min: 0, max: 60, step: 0.5, def: 30, hint: '卡片四角的圆角半径，单位是**原图像素**（原图 813×1185）。0 = 方角。这是运行时遮罩，拖一下立刻变，不用重烤' },
    { key: 'cardSize', group: '观看', label: '卡片大小', type: 'range', min: 0.35, max: 1.05, step: 0.01, def: 0.78, hint: '画面上卡片的高度占画布的比例。实际会被自动夹住 —— 保证整张卡都在画面里，不会被裁边' },
    { key: 'scale', group: '观看', label: '渲染分辨率', type: 'range', min: 0.4, max: 1, step: 0.05, def: 1, hint: '内部渲染倍率，掉帧就调低' },
    { key: 'shadowOn', group: '观看', label: '投影', type: 'check', def: 1 },
    { key: 'bgOn', group: '观看', label: '背景', type: 'check', def: 1 },
    { key: 'bgSpin', group: '观看', label: '背景流光', type: 'range', min: 0, max: 1, step: 0.01, def: 0.35 },
    // 这两根是冲着"卡片下方看起来多了一条黑边"去的 —— 那其实是**背景**：
    // 底色 ×0.55 的暗端 + 暗角两重压暗叠在画面下方，实测只剩 13/255（约 5%），
    // 跟卡片自带的深色边框糊成一片，把卡片圆角切掉也不会变（黑的是背景，不是卡片）。
    { key: 'bgBright', group: '观看', label: '背景亮度', type: 'range', min: 0.2, max: 4, step: 0.01, def: 1, hint: '背景整体明暗。**卡片下方那圈看着像黑边的背景，调大这根就能把它提起来**（现在只有 13/255）' },
    { key: 'bgVignette', group: '观看', label: '背景暗角', type: 'range', min: 0, max: 1, step: 0.01, def: 0.55, hint: '画面四周压暗的强度。0 = 完全不压暗，卡片边缘和背景的分界最清楚' },

    // ---- ② 工艺 ----
    { key: 'mName', group: '工艺', label: '卡名工艺', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: '银字 / 金名 / 红名 / 白碎名 的强度' },
    { key: 'mHolo', group: '工艺', label: '全息闪膜', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: 'holo：宽光带全息，面闪的底子' },
    { key: 'mParallel', group: '工艺', label: '爆闪（平行膜）', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: 'parallel：极细平行线光栅' },
    { key: 'mDiagonal', group: '工艺', label: '碎冰（斜碎）', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: 'diagonal：斜光栅 + 碎片色相' },
    { key: 'mPrismatic', group: '工艺', label: '棱彩（白碎）', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: 'prismatic：交叉光栅，交叉点炸白' },
    { key: 'mEmboss', group: '工艺', label: '浮雕', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: 'emboss：把卡面明暗当高度场打光' },
    { key: 'mMetal', group: '工艺', label: '金属工艺', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: 'metal：金 / 铂金箔 + 拉丝高光' },
    { key: 'mRainbow', group: '工艺', label: '彩虹反射', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: 'rainbow：收藏闪那个跟着鼠标转的彩虹' },
    { key: 'mGhost', group: '工艺', label: '幽灵（鬼闪）', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: 'ghost：整卡转银白' },
    { key: 'mGlitter', group: '工艺', label: '闪粉', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: 'glitter：细碎亮点' },
    { key: 'mPattern', group: '工艺', label: '图案膜', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: '星箔 / 马赛克 / 碎箔 / KC / 千年闪' },
    { key: 'mStamp', group: '工艺', label: '周年水印', type: 'range', min: 0, max: 2, step: 0.01, def: 1, hint: 'stamp：20th / 25th 压印水印' },
    { key: 'nameTintOn', group: '工艺', label: '覆盖卡名颜色', type: 'check', def: 0, hint: '打开后所有"卡名工艺"用下面这个颜色，用来演示 HL/DLR 那种"卡名颜色多样"' },
    // 默认色刻意选**与银/金/红/白都不一样**的青色：这个开关的意义就是"把卡名换成
    // 一个贵金属色以外的颜色"，默认值如果贴着银色，打开开关等于什么都没发生
    // （tools/effects.mjs 的逐参数扫描一度把 nameTintOn 判成"没接通"就是这个原因）。
    { key: 'nameTint', group: '工艺', label: '卡名颜色', type: 'color', def: '#7fe7ff' },
    { key: 'metalTintOn', group: '工艺', label: '覆盖金属色', type: 'check', def: 0 },
    { key: 'metalTint', group: '工艺', label: '金属色', type: 'color', def: '#e08a4a' },
    { key: 'embossAngle', group: '工艺', label: '浮雕光角', type: 'range', min: -3.15, max: 3.15, step: 0.01, def: 2.35, hint: '光源在卡面上的方向（弧度）' },
    { key: 'embossDetail', group: '工艺', label: '浮雕细节', type: 'range', min: 4, max: 120, step: 1, def: 52, hint: '梯度放大倍数：越大凹凸越夸张' },
    { key: 'stampAmount', group: '工艺', label: '水印浓度', type: 'range', min: 0, max: 1, step: 0.01, def: 1 },
    { key: 'glitterSize', group: '工艺', label: '闪粉粗细', type: 'range', min: 10, max: 120, step: 1, def: 46 },

    // ---- ④ 区域（怪物区 / 文字区）----
    // 这三块矩形原本是烘焙时按每张卡检测出来、写进 js/card-textures.js 的。
    // 但它们本来就是**纯矩形**（不依赖图像内容），所以已挪到着色器里现算 ——
    // 现在拖滑条**实时生效**，不用重烤（重烤一次要 35 秒，没法调）。
    // 卡名带不在其中：笔画是从图里按暗度抠进掩膜 R 通道的，矩形算不出来 ——
    // 而且顶部卡名实测是对的，不用调。
    //
    // 坐标是 **cardUV**（整图相对，0..1；y 向下，0 = 图片上沿）。
    // 想换算成像素：x × 813，y × 1185。
    //   例：artInnerY0 = 0.1730 → 0.1730 × 1185 ≈ 205px
    // 步长 0.0001 = 第 4 位小数：约 0.08px（横）/ 0.12px（纵）——
    // 够细，而且读数框可以直接键入精确值（滑条 1 像素 ≈ 50 步，光靠拖是打不准的）。
    { key: 'regionManual', group: '区域', label: '手动区域', type: 'check', def: 1,
      hint: '打开时下面 12 根滑条生效；关掉就回到每张卡烘焙时自动检测出来的值（两者默认值相同，所以开关本身不改变画面）' },

    { key: 'artOuterX0', group: '区域', label: '卡图窗外框 · 左', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.1009 },
    { key: 'artOuterY0', group: '区域', label: '卡图窗外框 · 上', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.1673 },
    { key: 'artOuterX1', group: '区域', label: '卡图窗外框 · 右', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.9003 },
    { key: 'artOuterY1', group: '区域', label: '卡图窗外框 · 下', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.7180 },

    { key: 'artInnerX0', group: '区域', label: '怪物区（插画）· 左', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.1181 },
    { key: 'artInnerY0', group: '区域', label: '怪物区（插画）· 上', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.1730,
      hint: '上沿实测值 0.1730（≈205px）正好压在插画起点上；调小就是往上多盖一点' },
    { key: 'artInnerX1', group: '区域', label: '怪物区（插画）· 右', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.8831 },
    { key: 'artInnerY1', group: '区域', label: '怪物区（插画）· 下', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.7067 },

    { key: 'textBoxX0', group: '区域', label: '效果文字区 · 左', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.0675 },
    { key: 'textBoxY0', group: '区域', label: '效果文字区 · 上', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.7422 },
    { key: 'textBoxX1', group: '区域', label: '效果文字区 · 右', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.9325 },
    { key: 'textBoxY1', group: '区域', label: '效果文字区 · 下', type: 'range', min: 0, max: 1, step: 0.0001, def: 0.9595 },

    // ---- ⑤ 调试 ----
    { key: 'maskDebug', group: '调试', label: '掩膜图层', type: 'check', def: 0, hint: '把"卡名 / 卡图 / 效果框 / 卡框"四块区域按颜色画出来，核对区域切得对不对' },
    { key: 'sheetOn', group: '调试', label: '一览模式', type: 'check', def: 0, hint: '把全部罕贵度铺成一张对照表（这一屏不看单个卡片的细节）' },
    { key: 'layerOnly', group: '调试', label: '只看第一层', type: 'check', def: 0, hint: '只画配方的第一层，其余层跳过 —— 用来单独看某个工艺' },
    { key: 'stampCells', group: '调试', label: '显示图案图集', type: 'check', def: 0, hint: '把 js/stamps.js 现画的 KC / 20th / 25th / 象形字图集贴到屏幕上' }
  ];

  const BY_KEY = {};
  for (const p of SPEC) BY_KEY[p.key] = p;
  const GROUPS = [];
  for (const p of SPEC) if (GROUPS.indexOf(p.group) < 0) GROUPS.push(p.group);

  function defaults() {
    const o = {};
    for (const p of SPEC) o[p.key] = p.def;
    return o;
  }

  function clampParam(p, v) {
    // 注意：check 型必须走 Number() 而不是直接判真值 ——
    // hash 解出来的是字符串，'0' 在 JS 里是**真值**，直接 `v ? 1 : 0` 会把
    // "关掉的开关"读成"打开"（tools/verify.mjs 的 hash 往返检查抓到的就是这个）。
    if (p.type === 'check') return Number(v) ? 1 : 0;
    if (p.type === 'card') {
      const n = Math.round(Number(v));
      const count = (global.CardTextures && global.CardTextures.list.length) || 1;
      return isNaN(n) ? 0 : Math.max(0, Math.min(count - 1, n));
    }
    if (p.type === 'select') {
      const n = Math.round(Number(v));
      return isNaN(n) ? p.def : Math.max(0, Math.min(RAR.ORDER.length - 1, n));
    }
    if (p.type === 'color') {
      return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : p.def;
    }
    let n = Number(v);
    if (isNaN(n)) n = p.def;
    n = Math.max(p.min, Math.min(p.max, n));
    if (p.step >= 1) n = Math.round(n);
    return n;
  }

  function hexToRgb(h) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(h));
    if (!m) return [1, 1, 1];
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function rgbToHex(c) {
    const f = (x) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0');
    return '#' + f(c[0]) + f(c[1]) + f(c[2]);
  }

  // ------------------------------------------------------------------ hash ----

  /**
   * 一个 range 参数该保留几位小数 —— **直接由 step 推出来**（step=0.0001 → 4 位）。
   *
   * 面板读数、滑条、hash 编码三处共用这一个定义，免得又对不上：
   * 以前读数写死两位（`Math.round(v*100)/100`），所以「区域」那组 step=0.0001 的参数
   * 在面板上永远显示成 0.18 —— 0.183 和 0.188 看起来一模一样，根本没法调。
   */
  function decimalsOf(p) {
    if (!p || !p.step || p.step >= 1) return 0;
    return Math.min(6, Math.max(1, Math.ceil(-Math.log10(p.step) - 1e-9)));
  }

  /** 把当前参数编码成 hash（位置编码，按 SPEC 顺序，逗号分隔） */
  function encode(params) {
    const parts = [];
    for (const p of SPEC) {
      const v = params[p.key];
      if (p.type === 'color') parts.push(String(v).replace('#', ''));
      else if (p.type === 'select' || p.type === 'card') parts.push(String(Math.round(v)));
      else if (p.type === 'check') parts.push(v ? '1' : '0');
      else {
        // 精度跟着 step 走。以前写死 3 位，step=0.0001 的参数会在 hash 里被截掉一位 ——
        // 复制链接发给别人，值就悄悄变了。
        const k = Math.pow(10, decimalsOf(p));
        parts.push(String(Math.round(Number(v) * k) / k));
      }
    }
    return parts.join(',');
  }

  /** 解码 hash。非法/缺失/越界一律回落到默认值（不抛错）。 */
  function decode(str) {
    const out = defaults();
    if (!str) return out;
    const parts = String(str).replace(/^#/, '').split(',');
    for (let i = 0; i < SPEC.length; i++) {
      const p = SPEC[i];
      const raw = parts[i];
      if (raw === undefined || raw === '') continue;
      if (p.type === 'color') {
        if (/^[0-9a-fA-F]{6}$/.test(raw)) out[p.key] = '#' + raw.toLowerCase();
      } else {
        out[p.key] = clampParam(p, raw);
      }
    }
    return out;
  }

  // ----------------------------------------------------------------- 预设 ----

  const R = (id) => RAR.ORDER.indexOf(id);

  const PRESETS = [
    { name: '默认（面闪）', patch: { rarity: R('SR') } },
    { name: '① 平卡 N（基准）', patch: { rarity: R('N'), maskDebug: 0 } },
    { name: '② 银字 R', patch: { rarity: R('R'), cardSize: 0.86 } },
    { name: '③ 面闪 SR', patch: { rarity: R('SR'), cardSize: 0.86 } },
    { name: '④ 金闪 UR', patch: { rarity: R('UR'), cardSize: 0.86 } },
    { name: '⑤ 银碎 SER', patch: { rarity: R('SER'), cardSize: 0.86 } },
    { name: '⑥ 浮雕 UTR', patch: { rarity: R('UTR'), cardSize: 0.86, embossDetail: 44 } },
    { name: '⑦ 鬼闪 HR', patch: { rarity: R('HR'), cardSize: 0.86 } },
    { name: '⑧ 收藏闪 CR', patch: { rarity: R('CR'), cardSize: 0.86 } },
    { name: '⑨ 白碎 PSER', patch: { rarity: R('PSER'), cardSize: 0.86 } },
    { name: '⑩ 红碎 20th SER', patch: { rarity: R('20SER'), cardSize: 0.86 } },
    { name: '⑪ 星光 Starlight', patch: { rarity: R('STARLIGHT'), cardSize: 0.86 } },
    { name: '⑫ 黄金闪 GUR', patch: { rarity: R('GUR'), cardSize: 0.86 } },
    { name: '⑬ 千年闪 Millennium', patch: { rarity: R('MILLENNIUM'), cardSize: 0.86 } },
    { name: '⑭ KC闪', patch: { rarity: R('KC'), cardSize: 0.86 } },
    { name: '⑮ 星箔 Starfoil', patch: { rarity: R('STARFOIL'), cardSize: 0.86 } },
    { name: '⑯ 马赛克 Mosaic', patch: { rarity: R('MOSAIC'), cardSize: 0.86 } },
    { name: '⑰ 碎箔 Shatterfoil', patch: { rarity: R('SHATTERFOIL'), cardSize: 0.86 } },
    { name: '★ 掩膜调试', patch: { rarity: R('SR'), maskDebug: 1, cardSize: 0.95 } },
    { name: '★ 区域：回到烘焙值', patch: { regionManual: 0 } },
    { name: '★ 图案图集', patch: { rarity: R('N'), stampCells: 1 } },
    { name: '★★ 一览全部罕贵度', patch: { rarity: R('SR'), sheetOn: 1 } },
    { name: '★★ 纯卡面（不加工）', patch: { rarity: R('N'), intensity: 0, cardSize: 0.95 } }
  ];

  global.CardConfig = {
    SPEC: SPEC,
    BY_KEY: BY_KEY,
    GROUPS: GROUPS,
    PRESETS: PRESETS,
    defaults: defaults,
    clampParam: clampParam,
    decimalsOf: decimalsOf,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    encode: encode,
    decode: decode
  };
})(window);
