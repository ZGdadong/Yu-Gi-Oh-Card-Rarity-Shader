/*
 * rarities.js —— 罕贵度 → 着色器配方
 *
 * 这张表就是 docs/游戏王罕贵度总结（OCG  TCG）.md 的**可执行版本**：
 * 文档里每个罕贵度的"主要特征"这一栏，在这里被翻译成一串 draw step。
 *
 * ── 一个罕贵度 = 一串图层 ────────────────────────────────────────────────
 * 每层是 { shader, p0, p1, p2, col }：
 *   shader  用 js/shaders.js 里的哪个工艺
 *   p0/p1/p2 对应着色器里的 uP0/uP1/uP2（含义逐个写在 js/shaders.js 的注释里）
 *   col     工艺色（金/银/铂金/红/白…）
 * 管线按顺序把每一层叠到卡面上（普通 alpha 混合），所以**顺序有意义**：
 * 底色工艺（金属/幽灵）在前，覆盖层（卡名/水印）在后。
 *
 * ── 遮罩选择码（见 js/shaders.js 的 pickMask）──────────────────────────
 *   0 全卡面  1 卡图  2 卡框  3 卡名  4 效果框  5 卡图+卡框
 *   6 金属区（卡框+卡名+卡图外环）  7 卡框+卡图外环
 *   8 效果框里的字  9 卡框+卡名  10 卡图+卡名
 */

(function (global) {
  'use strict';

  const SEL = {
    ALL: 0, ART: 1, FRAME: 2, NAME: 3, TEXT: 4, ART_FRAME: 5,
    METAL: 6, FRAME_RING: 7, TEXT_INK: 8, FRAME_NAME: 9, ART_NAME: 10
  };

  const C = {
    silver:    [0.86, 0.90, 0.97, 1],
    gold:      [1.00, 0.80, 0.34, 1],
    goldLight: [1.00, 0.90, 0.58, 1],
    platinum:  [0.90, 0.94, 0.98, 1],
    red:       [0.90, 0.13, 0.16, 1],
    white:     [1.00, 1.00, 1.00, 1],
    red2:      [0.85, 0.25, 0.22, 1],
    green:     [0.35, 0.85, 0.45, 1],
    blue:      [0.42, 0.62, 1.00, 1],
    bronze:    [0.86, 0.62, 0.32, 1]
  };

  const R3 = (a) => [a[0], a[1], a[2]];

  function L(shader, p0, p1, p2, col) {
    return {
      shader: shader,
      p0: p0 || [0, 0, 0, 0],
      p1: p1 || [0, 0, 0, 0],
      p2: p2 || [0, 0, 0, 0],
      col: R3(col || C.white)
    };
  }

  // ---------------------------------------------------------------- 配方块 ----

  // 卡图全息（面闪的底子）。p0=(强度,尺度,条纹锐度,域扭曲) p1=(色相,视角增益,暗部增强,遮罩)
  const artHolo = (str, sel, scale) => L('holo',
    [str, scale === undefined ? 3.2 : scale, 3.0, 0.55],
    [0, 1.35, 0.55, sel === undefined ? SEL.ART : sel],
    [0.05, 1, 0, 0]);

  // 平行闪膜 / 爆闪
  const parallel = (str, sel, freq, angle) => L('parallel',
    [str, freq === undefined ? 92 : freq, 2.2, 0.35],
    [1.1, 1.60, angle === undefined ? 1.5708 : angle, sel === undefined ? SEL.ALL : sel],
    [0, 0, 0, 0]);

  // 斜向碎冰
  const diagonal = (str, sel, freq, angle) => L('diagonal',
    [str, freq === undefined ? 26 : freq, 0.55, 0.35],
    [angle === undefined ? 0.7854 : angle, 1.20, 0.35, sel === undefined ? SEL.ALL : sel],
    [0, 0, 0, 0]);

  // 棱彩 / 白碎
  const prismatic = (str, sel, freq, angle) => L('prismatic',
    [str, freq === undefined ? 46 : freq, 0.55, 0.35],
    [angle === undefined ? 0.7854 : angle, 1.60, 0.55, sel === undefined ? SEL.ALL : sel],
    [0, 0, 0, 0]);

  const starfoil = (str, sel) => L('starfoil',
    [str, 5.5, 0.55, 0.35], [1.10, 0.30, 0, sel === undefined ? SEL.ALL : sel], [0, 0, 0, 0]);

  const mosaic = (str, sel) => L('mosaic',
    [str, 13, 0.16, 0.35], [0.90, 0.55, 0, sel === undefined ? SEL.ALL : sel], [0, 0, 0, 0]);

  const voronoi = (str, sel) => L('voronoi',
    [str, 13, 0.55, 0.35], [0.95, 0.55, 0, sel === undefined ? SEL.ALL : sel], [0, 0, 0, 0]);

  const glitter = (str, sel, dens) => L('glitter',
    [str, dens === undefined ? 46 : dens, 0.30, 6.0],
    [0, 0, 0, sel === undefined ? SEL.ALL : sel], [0, 0, 0, 0]);

  const gloss = (str, sel) => L('gloss',
    [str, 2.4, 9.0, 0.85], [2.2, 0, 0, sel === undefined ? SEL.ALL : sel], [0, 0, 0, 0]);

  // 浮雕。p0=(强度,光角,金属化,高光) p1=(遮罩,细节尺度,光俯角,·) col=浮雕的金属色
  const emboss = (str, sel, metal, detail, col) => L('emboss',
    [str, 2.35, metal === undefined ? 0.45 : metal, 0.55],
    [sel === undefined ? SEL.ART : sel, detail === undefined ? 52 : detail, 0.62, 0],
    [0, 0, 0, 0], col || C.goldLight);

  // 幽灵 / 鬼闪。p0=(强度,彩虹,对比度,辉光)
  //   p1=(遮罩, **面闪混合强度**, 面闪花纹尺度, 面闪相位偏移)
  //   p2=(面闪的角度增益, 面闪的流动速度, ·, ·)
  //   遮罩默认给卡图（怪物图框）—— 鬼闪只压插画，卡框/卡名/效果框还是原印刷；
  //   GGR（鬼金闪）传 SEL.ALL，保持"整卡银白 + 金框"那一路。
  //   面闪混合强度 0.85：某些角度看过去会从鬼闪滑成面闪（见 BODY.ghost 的注释）
  const ghost = (str, rainbow, sel, holoMix) => L('ghost',
    [str, rainbow === undefined ? 0.55 : rainbow, 0.85, 0.85],
    [sel === undefined ? SEL.ART : sel, holoMix === undefined ? 0.85 : holoMix, 3.2, 0.15],
    [1.1, 0.05, 0, 0], C.silver);

  // 金属工艺（金 / 铂金）。p0=(强度,拉丝密度,各向异性,高光) p1=(遮罩,视角增益,印刷保留,·)
  const metal = (str, sel, col, brush, keepPrint) => L('metal',
    [str, brush === undefined ? 55 : brush, 0.25, 0.35],
    [sel === undefined ? SEL.METAL : sel, 1.2, keepPrint === undefined ? 0.35 : keepPrint, 0],
    [0, 0, 0, 0], col);

  // 彩虹反射（收藏闪）。p0=(强度,饱和,半径衰减,·) p1=(遮罩,色相偏移,·,·)
  const rainbow = (str, sel, sat) => L('rainbow',
    [str, sat === undefined ? 0.55 : sat, 0.85, 0],
    [sel === undefined ? SEL.METAL : sel, 0, 0, 0], [0, 0, 0, 0], C.white);

  // 卡名工艺。p0=(强度,金属明暗对比,碎闪,·) p1=(渐变频率,相位,·,·)
  const name = (col, str, contrast, shatter) => L('name',
    [str === undefined ? 1.0 : str, contrast === undefined ? 0.85 : contrast, shatter || 0, 0],
    [14.0, 0.02, 0, 0], [0, 0, 0, 0], col);

  // KC 闪的那层"电路板"膜。
  //   p0 = (强度, 电路网格尺寸, 走线半宽, **可见半径**)
  //   p1 = (视角增益, 色相频率, **走线疏密阈值**, 遮罩)
  //   p2 = (**留白阈值**, ·, ·, ·)
  //   电路网格 0.045 = 一格占 4.5% 卡高（横向约 15 格、纵向约 22 格）；
  //   走线半宽 0.12 格 → 线宽约 1.1% 卡高（1024px 的卡上是 11px 上下）
  //   疏密阈值 0.18 → 约 4/5 的"车道"有铜，平行线之间的间距 ≈ 0.055 卡高
  //   留白阈值 0.32 → 约六分之一的斑块整片没铜（真板子上一大片是空的）
  //   可见半径 0.31：以**鼠标**为圆心的软斑，窗口面积 π×0.31² ÷ 0.6729 ≈ 45% 卡面；
  //   对焦那一圈最亮、往外一路渐变（实测"看得出明显变化"的约占 34%
  //   —— 渐变的边上那圈本来就淡，见 PRELUDE 的 cursorGate）
  const kc = (str) => L('kc',
    [str, 0.040, 0.12, 0.31], [1.35, 1.0, 0.12, SEL.ALL], [0.32, 0, 0, 0], C.white);

  // 千年闪 / 法老闪的埃及文字图案膜。
  //   p0 = (强度, **可见窗口半宽**, 字形强度, 字形密度)
  //     窗口那一格原来放的是"竖线半宽"——竖线整个去掉之后，这一格改成了可见窗口半宽：
  //     0.100 → 任何角度最多 20% 的字显形
  //     （实测扫满 81 个视角：7.0% ~ 21.7%；着色器里同样夹了一道 0.125 = 25% 的硬上限）
  //   字形密度 0.138 = 一格占 13.8% 卡高（也就是字与字的间隔）
  //   p2 = (金点强度, 金点密度, 金点尺寸, ·)
  //     全图撒的小金点：颜色跟着观察角流动，权重刻意很小 —— 它是辅助层，不抢象形字
  const millennium = (str) => L('millennium',
    [str, 0.100, 0.85, 0.138], [1.10, 0, 0, SEL.ALL], [0.30, 54, 0.14, 0], C.goldLight);

  // 周年水印。uP1=(图集格 x,y,·,·)
  const stamp20 = (str, sel) => L('stamp',
    [str, 0.115, 0, sel === undefined ? SEL.TEXT : sel], [1, 0, 0, 0], [0.05, 0.12, 0, 0], C.goldLight);
  const stamp25 = (str, sel) => L('stamp',
    [str, 0.115, 0, sel === undefined ? SEL.TEXT : sel], [2, 0, 0, 0], [0.05, 0.12, 0, 0], C.goldLight);

  // ------------------------------------------------------------- 罕贵度表 ----
  //
  // tier: base 基础 / high 高级特殊 / parallel 平行爆闪 / dt Duel Terminal / other 其他
  // like: 与另一条完全同工艺（省得抄一遍，也能一眼看出"这两个只有封入率/地区不同"）

  const LIST = [
    // ── §1 基础罕贵度 ───────────────────────────────────────────────────
    {
      id: 'N', code: 'N', cn: '平卡', en: 'Normal', tier: 'base',
      feat: '无特殊加工，数量最多',
      render: '完全不加工：这一条就是"原始印刷"的基准，也是"遮罩调试"之外的对照基线。',
      layers: []
    },
    {
      id: 'R', code: 'R', cn: '银字', en: 'Rare', tier: 'base',
      feat: '卡名部分为银色烫金',
      render: '只给**卡名笔画**烫银。笔画掩膜是按暗度从图里抠出来的（R 通道），' +
        '所以银色是沿着字形走的，不是盖一个矩形。',
      layers: [name(C.silver, 1.0, 0.95, 0)]
    },
    {
      id: 'SR', code: 'SR', cn: '面闪', en: 'Super Rare', tier: 'base',
      feat: '卡图全息闪光，卡名通常不闪',
      render: '全息闪膜只盖**卡图**（遮罩=卡图），卡名不碰 —— 这正是面闪与金闪的分界线。',
      layers: [artHolo(0.95, SEL.ART), gloss(0.16, SEL.ART)]
    },
    {
      id: 'UR', code: 'UR', cn: '金闪 / 金亮', en: 'Ultra Rare', tier: 'base',
      feat: '卡图闪，卡名金色',
      render: '面闪的底子（卡图全息）+ 卡名烫金。两层，顺序无所谓但名字放后面。',
      layers: [artHolo(1.0, SEL.ART), gloss(0.14, SEL.ART), name(C.gold, 1.0, 1.0, 0)]
    },
    {
      id: 'SER', code: 'SER', cn: '银碎', en: 'Secret Rare', tier: 'base',
      feat: '斜向碎冰状全息闪膜，覆盖卡名和卡图',
      render: '斜向碎冰膜盖**卡图+卡名**（文档原话："覆盖卡名和卡图"）。' +
        '碎冰用斜光栅 + 沿栅格随机的碎片色相做出来，裂纹发白。',
      layers: [diagonal(0.95, SEL.ART_NAME, 26, 0.7854), glitter(0.22, SEL.ALL, 60)]
    },
    {
      id: 'UTR', code: 'UTR', cn: '3D / 浮雕', en: 'Ultimate Rare', tier: 'base',
      feat: '卡图有浮雕立体质感，触摸有凹凸',
      render: '把卡面明暗当高度场求梯度得法线，再用一盏方向光打亮 → 插画被"压"出立体感；' +
        '卡名与效果框文字也一起压。**"触摸有凹凸"渲染不出来**，那一条只能靠手。',
      layers: [emboss(0.95, SEL.ART, 0.40, 52), emboss(0.75, SEL.NAME, 0.80, 60),
        emboss(0.45, SEL.TEXT_INK, 0.80, 46)]
    },
    {
      id: 'HR', code: 'HR', cn: '全息 / 鬼闪', en: 'Holographic Rare (TCG: Ghost Rare)', tier: 'base',
      feat: '银白幽灵立体效果；TCG 称 Ghost Rare',
      render: '幽灵**只压怪物图框（卡图）**：插画转银白（去色 + 提对比 + 冷色偏移）、亮部发光，' +
        '再叠一层随视角走的冷色彩虹；卡框、卡名、效果框保持原来的印刷。' +
        '**某些角度会从鬼闪滑成面闪** —— 相位由观察角驱动，到了波峰那一段整片换成面闪的膜' +
        '（宽光带 + 域扭曲 + 细颗粒），所以捏着卡慢慢转会看到它"变回面闪"再变回来。' +
        '最后压一层 **0.60 工艺强度的浮雕**，插画按自己的明暗被打出凹凸，立体感强很多。',
      layers: [ghost(1.0, 0.55, SEL.ART, 0.85), emboss(0.60, SEL.ART, 0.40, 52, C.silver)]
    },
    {
      id: 'CR', code: 'CR', cn: '收藏闪 / 彩虹闪', en: "Collector's Rare", tier: 'base',
      feat: '边框、卡图、效果框等有彩虹色反射',
      render: '彩虹反射以**鼠标位置为圆心**按极坐标取色相 —— 视角一动，整圈彩虹跟着转。' +
        '遮罩分两层：金属区（卡框+卡名+卡图外环）强，卡图内部弱。',
      layers: [rainbow(0.62, SEL.METAL, 0.55), rainbow(0.26, SEL.ART, 0.45)]
    },
    {
      id: 'PSER', code: 'PSER', cn: '白碎', en: 'Prismatic Secret Rare', tier: 'base',
      feat: '全卡面平行闪膜，卡名白色碎闪',
      render: '正反两个方向的细光栅交叉铺满整卡（交叉点炸白 = "白碎"），卡名换成会跳的白色碎闪。',
      layers: [prismatic(0.92, SEL.ALL, 46), name(C.white, 1.0, 0.55, 0.9), glitter(0.18, SEL.ALL, 70)]
    },
    {
      id: '20SER', code: '20th SER', cn: '红碎', en: '20th Secret Rare', tier: 'base',
      feat: '红色卡名，效果框有"20th"水印',
      render: '碎冰膜 + **红色卡名** + 效果框上密排的 "20th" 水印（水印是"压印"，暗处变亮、亮处变暗）。',
      layers: [diagonal(0.90, SEL.ALL, 26, 0.7854), name(C.red, 1.0, 0.5, 0),
        stamp20(0.85, SEL.TEXT), glitter(0.16, SEL.ALL, 60)]
    },
    {
      id: 'STARLIGHT', code: 'Starlight Rare', cn: '星光 / 星闪', en: 'Starlight Rare', tier: 'base',
      feat: '整张卡覆盖平行全息闪膜',
      render: '整卡铺极细的平行光栅，再叠一层宽光带全息和闪粉 —— 转卡时整片一起扫过去。',
      layers: [parallel(0.85, SEL.ALL, 120, 1.5708), artHolo(0.45, SEL.ALL, 4.0), glitter(0.30, SEL.ALL, 80)]
    },
    {
      id: 'QCSCR', code: 'QCScR', cn: '25周年碎', en: 'Quarter Century Secret Rare', tier: 'base',
      feat: '25周年纪念特殊闪膜 / 标志',
      render: '棱彩碎膜铺满整卡 + 密排 "25th" 水印（压在效果框与卡图上）+ 闪粉。',
      layers: [prismatic(0.88, SEL.ALL, 44), stamp25(0.75, SEL.TEXT), glitter(0.26, SEL.ALL, 76)]
    },

    // ── §2 高级与特殊罕贵度 ─────────────────────────────────────────────
    {
      id: 'ESR', code: 'ESR', cn: '斜碎 / 额外碎', en: 'Extra Secret Rare', tier: 'high',
      feat: '特殊斜向或碎冰闪膜，多见于 EP 等',
      render: '与银碎同为斜向碎冰，但**斜得更陡、碎格更密**（角度 1.05 弧度、密度 40）—— ' +
        '这就是"额外碎"和"银碎"在观感上的差别。',
      layers: [diagonal(0.95, SEL.ART_NAME, 40, 1.05), glitter(0.24, SEL.ALL, 66)]
    },
    {
      id: 'GUR', code: 'GUR', cn: '黄金闪', en: 'Gold Rare', tier: 'high',
      feat: '金色边框、卡名、卡图纹理',
      render: '金属区（卡框+卡名+卡图外环）整块换成金箔 + 拉丝高光，卡图内部只是被镀上一层金' +
        '（印刷保留度调高，图案还得认得出来），卡名烫金。',
      layers: [metal(0.95, SEL.METAL, C.gold, 55, 0.10), metal(0.72, SEL.ART, C.gold, 70, 0.78),
        name(C.gold, 1.0, 1.0, 0)]
    },
    {
      id: 'GSCR', code: 'GScR', cn: '黄金碎', en: 'Gold Secret Rare', tier: 'high',
      feat: '黄金工艺 + 碎冰闪膜',
      render: '黄金闪的金属底，上面再压一层碎冰膜。',
      layers: [metal(0.95, SEL.METAL, C.gold, 55, 0.10), metal(0.62, SEL.ART, C.gold, 70, 0.78),
        diagonal(0.80, SEL.ALL, 26, 0.7854), name(C.gold, 1.0, 1.0, 0)]
    },
    {
      id: 'PLR', code: 'PlR', cn: '铂金闪', en: 'Platinum Rare', tier: 'high',
      feat: '铂金纹理',
      render: '与黄金闪同一套，只是底色换成铂金（更冷更亮），拉丝更细。',
      layers: [metal(0.92, SEL.METAL, C.platinum, 80, 0.10), metal(0.70, SEL.ART, C.platinum, 95, 0.78),
        name(C.platinum, 1.0, 0.95, 0)]
    },
    {
      id: 'PLSCR', code: 'PlScR', cn: '铂金碎', en: 'Platinum Secret Rare', tier: 'high',
      feat: '铂金工艺 + 碎冰闪膜',
      render: '铂金闪 + 碎冰膜。',
      layers: [metal(0.92, SEL.METAL, C.platinum, 80, 0.10), metal(0.60, SEL.ART, C.platinum, 95, 0.78),
        diagonal(0.78, SEL.ALL, 26, 0.7854), name(C.platinum, 1.0, 0.95, 0)]
    },
    {
      id: 'GGR', code: 'GGR', cn: '鬼金闪', en: 'Ghost/Gold Rare', tier: 'high',
      feat: '鬼闪 + 黄金工艺',
      render: '先走鬼闪（**整卡**银白幽灵，这一条沿用老口径、不像 HR 那样只压卡图），再把金属区染成金' +
        ' —— 文档里说的"鬼闪+黄金工艺"。',
      layers: [ghost(1.0, 0.45, SEL.ALL, 0.55), metal(0.72, SEL.METAL, C.gold, 60, 0.05), name(C.gold, 1.0, 1.0, 0)]
    },
    {
      id: 'PUR', code: 'PUR', cn: '棱彩浮雕', en: 'Prismatic Ultimate Rare', tier: 'high',
      feat: 'TCG，浮雕 + 平行闪膜',
      render: '浮雕打底（插画被压出立体感），上面再铺棱彩平行膜。',
      layers: [emboss(0.88, SEL.ART, 0.40, 52), prismatic(0.78, SEL.ALL, 46), name(C.goldLight, 1.0, 0.85, 0.25)]
    },
    {
      id: 'PCR', code: 'PCR', cn: '棱彩收藏闪', en: "Prismatic Collector's Rare", tier: 'high',
      feat: 'TCG，收藏闪 + 平行闪膜',
      render: '收藏闪的彩虹反射 + 整卡棱彩膜。',
      layers: [rainbow(0.55, SEL.METAL, 0.55), rainbow(0.22, SEL.ART, 0.45), prismatic(0.66, SEL.ALL, 46)]
    },
    {
      id: 'PHARAOH', code: "Pharaoh's Rare", cn: '法老闪', en: "Pharaoh's Rare", tier: 'high',
      feat: 'TCG 特殊埃及风闪膜',
      render: '埃及文字图案膜铺满整卡（同样一批一批显形，任何角度最多 20%），再压一层淡金工艺 —— 千年闪的"高级版"。',
      layers: [millennium(0.92), metal(0.30, SEL.METAL, C.gold, 60, 0.2), name(C.goldLight, 1.0, 0.9, 0)]
    },
    {
      id: 'NR', code: 'NR', cn: '平罕 / 隐普', en: 'Normal Rare', tier: 'high',
      feat: '外观与平卡相同，但封入率异常低',
      like: 'N',
      render: '**这一条在画面上做不出来 —— 因为它本来就没有画面差别。**' +
        '"平罕"的唯一特征是**封入率**（抽到的概率极低），卡片本身与平卡一模一样。' +
        '所以这里刻意渲染成和 N 完全相同，不改任何像素。',
      layers: []
    },

    // ── §3 平行 / 爆闪类 ────────────────────────────────────────────────
    {
      id: 'NPR', code: 'NPR', cn: '平爆 / 普钻', en: 'Normal Parallel Rare', tier: 'parallel',
      feat: '平卡基底 + 全息闪膜',
      render: '不换基底（不像银爆/面爆/金爆那样先有烫金或面闪），直接整卡铺爆闪 + 一层宽光带全息。',
      layers: [parallel(0.95, SEL.ALL, 92, 1.5708), artHolo(0.40, SEL.ALL, 4.0)]
    },
    {
      id: 'RPR', code: 'RPR', cn: '银爆', en: 'Rare Parallel Rare', tier: 'parallel',
      feat: '银字基底 + 爆闪',
      render: '银字打底，再铺爆闪。',
      layers: [name(C.silver, 1.0, 0.95, 0), parallel(0.95, SEL.ALL, 92, 1.5708)]
    },
    {
      id: 'SPR', code: 'SPR', cn: '面爆', en: 'Super Parallel Rare', tier: 'parallel',
      feat: '面闪基底 + 爆闪',
      render: '面闪（卡图全息）打底 + 爆闪。',
      layers: [artHolo(0.85, SEL.ART), parallel(0.95, SEL.ALL, 92, 1.5708)]
    },
    {
      id: 'UPR', code: 'UPR', cn: '金爆', en: 'Ultra Parallel Rare', tier: 'parallel',
      feat: '金闪基底 + 爆闪',
      render: '金闪（卡图全息 + 金卡名）打底 + 爆闪。',
      layers: [artHolo(0.9, SEL.ART), name(C.gold, 1.0, 1.0, 0), parallel(0.95, SEL.ALL, 92, 1.5708)]
    },
    {
      id: 'PR', code: 'PR', cn: '爆闪', en: 'Parallel Rare', tier: 'parallel',
      feat: '平行闪膜统称',
      render: '纯粹的平行闪膜：极细的线光栅 + 沿垂直方向的缓变色带。',
      layers: [parallel(1.0, SEL.ALL, 92, 1.5708)]
    },
    {
      id: 'KC', code: 'KC Rare', cn: 'KC闪', en: 'KC Rare', tier: 'parallel',
      feat: '线条 + "KC"标志闪膜；有 NKC、RKC、UKC 等变体',
      render: '**金闪打底**（卡图全息 + 金卡名），上面再加一层**电路板**膜，画的是**两层铜**：' +
        '主线路（走线成组地朝一个方向走、走很长一段才折一下，折角多是 **45°**）叠一层更细更稀、' +
        '走向不同的副线路，两层互相交叉；线的尽头压**过孔**，少数几根是粗一档的"电源线"，' +
        '板上还留着一片片没铜的空地 —— 是一块**板子**。整块板的配色是**蓝 / 黄 / 橙 / 红**四种' +
        '（每条线自己的颜色，相邻的线常常不同色），转卡时相位平移、颜色一条条轮换过去。' +
        '电路铺满整卡，但**只有鼠标附近那一块显形**：窗口是以光标为圆心、半径 0.31 卡高的软斑' +
        '（面积 ≈ 卡面 45%），**对焦那一圈最亮、往外一路渐变到边缘**。' +
        'NKC/RKC/UKC 是同一层膜套在不同基底上（这里用金闪基底代表）。',
      layers: [artHolo(1.0, SEL.ART), gloss(0.14, SEL.ART), name(C.gold, 1.0, 1.0, 0), kc(0.95)]
    },
    {
      id: 'MILLENNIUM', code: 'Millennium Rare', cn: '千年闪', en: 'Millennium Rare', tier: 'parallel',
      feat: '埃及文字图案闪膜；有 NMR、SMR、UMR、SEMR、GMR 等变体',
      render: '**埃及象形字**按格随机拼成的图案膜（象形字是风格化近似，见 README）：一格一个字、' +
        '随机镜像，每个字的字面是一层独立的箔，颜色跟着视角流动。' +
        '整片膜按位置分成许多组，**任何角度最多只有 20% 的字显形**，转动时一批一批地亮起来；' +
        '另外整卡撒一层**跟着角度变色的小金点**（辅助层，刻意很淡，不抢图案）。' +
        '字与字之间**没有竖线** —— 实卡的千年图案是一层图案膜，不是线栅膜。' +
        'NMR/SMR/UMR/SEMR/GMR 是同一工艺的不同基底。',
      layers: [millennium(0.95)]
    },
    {
      id: 'STARFOIL', code: 'Starfoil Rare', cn: '星箔', en: 'Starfoil Rare', tier: 'parallel',
      feat: 'TCG，星形闪膜',
      render: '一格一颗四角星的闪膜（星形用 astroid 曲线画），星内显色、星外压暗。',
      layers: [starfoil(0.95, SEL.ALL)]
    },
    {
      id: 'MOSAIC', code: 'Mosaic Rare', cn: '马赛克闪', en: 'Mosaic Rare', tier: 'parallel',
      feat: 'TCG，马赛克状闪膜',
      render: '方格闪膜：一格一个色相，格线压暗。',
      layers: [mosaic(0.95, SEL.ALL)]
    },
    {
      id: 'SHATTERFOIL', code: 'Shatterfoil Rare', cn: '碎箔闪', en: 'Shatterfoil Rare', tier: 'parallel',
      feat: 'TCG，碎裂状闪膜',
      render: 'Voronoi 造不规则碎片，碎片边亮、碎片内各一个色相 —— 这就是"碎裂状"。',
      layers: [voronoi(0.95, SEL.ALL)]
    },

    // ── §4 Duel Terminal ────────────────────────────────────────────────
    { id: 'DTN', code: 'DT-N', cn: 'DT平', en: 'Duel Terminal Normal', tier: 'dt', like: 'N',
      feat: 'DT 机台普卡', render: '与 OCG 平卡同工艺。' },
    { id: 'DTR', code: 'DT-R', cn: 'DT银', en: 'Duel Terminal Rare', tier: 'dt', like: 'R',
      feat: 'DT 银字', render: '与 OCG 银字同工艺。' },
    { id: 'DTSR', code: 'DT-SR', cn: 'DT面闪', en: 'Duel Terminal Super', tier: 'dt', like: 'SR',
      feat: 'DT 面闪', render: '与 OCG 面闪同工艺。' },
    { id: 'DTUR', code: 'DT-UR', cn: 'DT金闪', en: 'Duel Terminal Ultra', tier: 'dt', like: 'UR',
      feat: 'DT 金闪', render: '与 OCG 金闪同工艺。' },
    { id: 'DTSER', code: 'DT-SER', cn: 'DT银碎', en: 'Duel Terminal Secret', tier: 'dt', like: 'SER',
      feat: 'DT 碎冰闪', render: '与 OCG 银碎同工艺。' },
    { id: 'DTPR', code: 'DT-PR', cn: 'DT爆', en: 'Duel Terminal Parallel', tier: 'dt', like: 'PR',
      feat: 'DT 平行闪膜', render: '与 OCG 爆闪同工艺。' },

    // ── §5 其他活动 / 地区 / TCG 特殊 ───────────────────────────────────
    {
      id: 'HL', code: 'HL', cn: '联赛卡', en: 'Hobby League', tier: 'other',
      feat: '活动限定，常见特殊颜色卡名或闪膜',
      render: '文档说"常见特殊颜色卡名或闪膜"—— 那就把**卡名颜色**做成可换的：' +
        '这里给一个绿色卡名 + 爆闪的示例（面板里能改工艺色）。',
      layers: [parallel(0.80, SEL.ALL, 92, 1.5708), name(C.green, 1.0, 1.0, 0)]
    },
    {
      id: 'DLR', code: 'DLR', cn: '联赛闪', en: 'Duelist League Rare', tier: 'other',
      feat: '活动限定，卡名颜色多样',
      render: '卡名换成一个**非贵金属**的蓝色（DLR 的特点就是卡名颜色五花八门），其余走爆闪。',
      layers: [parallel(0.72, SEL.ALL, 92, 1.5708), name(C.blue, 1.0, 0.75, 0)]
    },
    {
      id: 'CPTP', code: 'CP / TP 等', cn: '比赛闪', en: 'Tournament Pack', tier: 'other',
      feat: '不同赛事、地区版本差异大',
      render: '**做不出一条"标准配方"**：文档自己就写了"不同赛事、地区版本差异大"。' +
        '这里给一个中间态（面闪 + 爆闪 + 碎冰的混合），只当示意，不代表某个具体赛事的版本。',
      layers: [artHolo(0.75, SEL.ART), parallel(0.62, SEL.ALL, 92, 1.5708), diagonal(0.40, SEL.ART_NAME, 26, 0.7854)]
    },
    {
      id: 'KOREAN', code: '韩文版', cn: '韩文卡', en: 'Korean', tier: 'other', like: 'SR',
      feat: '基本沿用 OCG / TCG 体系，但发行版本与闪膜可能不同',
      like_note: '这里借用面闪的配方当代表 —— 韩文版本身**不是一种新工艺**，' +
        '而是同一批罕贵度在韩国的发行版本，闪膜可能与日版有细微差别。',
      render: '借用面闪配方；真正的差别在"发行版本"而不在工艺，渲染不出来。',
      layers: null   // like: 'SR' 会填上
    },
    {
      id: 'ASIANEN', code: '亚洲英文版', cn: '亚英', en: 'Asian English', tier: 'other', like: 'UR',
      like_note: '同样借用金闪的配方当代表；亚英是"介于 OCG 与 TCG 之间"的地区版本。',
      feat: '介于 OCG 与 TCG 之间，罕贵与闪膜有地区特点',
      render: '借用金闪配方；地区差异渲染不出来。',
      layers: null
    }
  ];

  // ---- 解析 like：把 like 指向的图层抄过来（保持"只有一份定义"）----------
  const BY_ID = {};
  for (const r of LIST) BY_ID[r.id] = r;
  for (const r of LIST) {
    if (r.layers === null) {
      if (!r.like) throw new Error('罕见度 ' + r.id + ' 既没有 layers 也没有 like');
      const src = BY_ID[r.like];
      r.layers = src.layers.map((l) => ({
        shader: l.shader,
        p0: l.p0.slice(), p1: l.p1.slice(), p2: l.p2.slice(), col: l.col.slice()
      }));
    }
    if (r.layers === undefined) r.layers = [];
  }

  const ORDER = LIST.map((r) => r.id);

  /** 该罕贵度用到的着色器名（去重、保序） */
  function shadersOf(id) {
    const r = BY_ID[id];
    const out = ['base'];
    for (const l of r.layers) if (out.indexOf(l.shader) < 0) out.push(l.shader);
    return out;
  }

  global.CardRarities = {
    SEL: SEL,
    COLORS: C,
    LIST: LIST,
    ORDER: ORDER,
    BY_ID: BY_ID,
    TIERS: {
      base: '§1 基础罕贵度',
      high: '§2 高级与特殊罕贵度',
      parallel: '§3 平行 / 爆闪类',
      dt: '§4 Duel Terminal 系列',
      other: '§5 其他活动 / 地区 / TCG 特殊'
    },
    shadersOf: shadersOf
  };
})(window);







