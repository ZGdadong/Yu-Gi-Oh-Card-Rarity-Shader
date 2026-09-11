/*
 * shaders.js —— 游戏王罕贵度工艺着色器
 *
 * 这份文件是**我自己写的**（不像 card-shader 那个项目搬的是 Balatro 原作）。
 * 组织方式借用那份文档里的"draw step"思路：一张卡面纹理 + 一遍遍往上叠的图层，
 * 每层自己决定输出什么颜色、留多少 alpha，再按 alpha 混合叠上去。
 *
 * ── 三个共用件 ────────────────────────────────────────────────────────────
 *
 * ① `uTex`  卡面纹理。**永远是那张没加工过的原始印刷**（所有层都采样同一张）。
 *    各层因此不会互相污染，顺序只影响混合先后。
 *
 * ② `uMask` 工艺区域掩膜，四个通道各管一块地方（由 tools/embed-card.mjs 烤出来）：
 *      R = 卡名笔画   G = 卡图内容区   B = 效果框   A = 卡框
 *    罕贵度的差别**几乎全在"哪一块被加工了"**上，所以每个效果都带一个
 *    "遮罩选择"参数（`pickMask`），而不是各写一份矩形判断。
 *
 * ③ `uStamp` 图案图集（KC / 20th / 25th / 埃及象形字），4×2 格，
 *    由 js/stamps.js 在运行时用 canvas 画出来。KC 闪 / 千年闪 / 周年水印都靠它。
 *
 * ── 坐标 ──────────────────────────────────────────────────────────────────
 *   `uv`     精灵纹理坐标（0..1，**含四周 4% 留白**，v=0 是卡片上沿）
 *   `cardUV` 卡片自己的坐标（0..1，v=0 是上沿），`(uv - margin) / (1 - 2*margin)`
 *   程序化花纹一律用 cardUV，这样留白多大都不影响观感。
 *
 * ── ⚠️ 输出约定（这一条踩过坑，写下来）──────────────────────────────────
 *
 * 每个工艺着色器返回的是 **`vec4(完整施加后的颜色, tex.a * 覆盖度)`**，
 * 而不是 `vec4(颜色, tex.a)`：
 *
 *   覆盖度 = mask * 强度   （clamp 到 0..1）
 *
 * **为什么不能直接返回 tex.a：** 返回 tex.a（卡内恒为 1）等于"这一层把整张卡重画一遍"。
 * 对于那些只加工一小块的效果（比如 `name` 只烫卡名笔画、`stamp` 只压水印），
 * 第一版写成了 `if (mask < 0.004) return tex;` —— 于是它会在**上一层的成果上面
 * 把原始印刷重新贴回来**，前面叠的金属、碎冰全被抹掉。表现是：
 * 黄金闪的边框怎么调都不变金、浮雕叠完只剩最后一层。
 * 改成"覆盖度当 alpha"之后，mask=0 的地方 alpha=0，那一片就**什么都不画**，
 * 顺序叠层才真的成立。
 *
 * 纯加光的层（`glitter` / `gloss`）另外走加法混合（见 js/pipeline.js 的 blend: 'add'），
 * 它们只输出"多加了多少光"，不输出卡面颜色。
 *
 * 经典脚本（非 ES module），file:// 双击可用。
 */
(function (global) {
  'use strict';

  const PRELUDE = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uTex;       // 卡面（原始印刷）
uniform sampler2D uMask;      // R卡名 G卡图 B效果框 A卡片剪影
uniform sampler2D uStamp;     // 图案图集 4×2 格

uniform vec4  uRectArtOuter;  // 卡图窗外框的矩形 (x0,y0,x1,y1)，卡片相对坐标
uniform vec4  uContent;       // 卡片内容在纹理里的归一化矩形（去掉四周留白）
uniform vec2  uResolution;    // 目标像素尺寸
uniform float uMargin;        // 卡图纹理四周留白比例
uniform float uTime;          // 运行时钟（秒）
uniform vec2  uView;          // 视角方向（-1..1，来自卡片倾斜）
uniform vec2  uViewPt;        // 高光点在卡片坐标里的位置
uniform float uAspect;        // 卡片宽 / 高
uniform float uSeed;          // 每张卡的固定噪声相位

uniform vec4 uP0;             // 该效果自己的参数（含义见各 effect 的注释）
uniform vec4 uP1;
uniform vec4 uP2;
uniform vec4 uCol;            // 该效果自己的工艺色

in vec2 vUV;
out vec4 fragColor;

#define TAU 6.28318530718

// ---------------------------------------------------------------- 共用件 ----

// 纹理坐标 → 卡片自己的坐标（0..1，v=0 是卡片上沿）。
// uContent 是卡片内容在纹理里的矩形，横竖两个方向的留白比例不一定相同，
// 所以这里用矩形换算而不是一个标量 margin。
vec2 cardUV(vec2 uv) { return (uv - uContent.xy) / (uContent.zw - uContent.xy); }

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s;
}

// 各向同性的"卡高比例"坐标：x 乘长宽比，于是单位长度在横竖两个方向一样长。
// 程序化的方格/圆点都要用它，否则格子会被卡片的长宽比拉扁。
vec2 isoUV(vec2 cu) { return vec2(cu.x * uAspect, cu.y); }

// 正方形网格：size 是"格子边长占卡高的比例"
vec2 squareGrid(vec2 cu, float size) { return vec2(cu.x / uAspect, cu.y) / size; }

// 软边矩形掩膜（卡片相对坐标）。soft 是羽化半宽，单位也是卡片相对坐标。
float rectMask(vec2 cu, vec4 r, float soft) {
    float mx = smoothstep(r.x - soft, r.x + soft, cu.x)
             * (1.0 - smoothstep(r.z - soft, r.z + soft, cu.x));
    float my = smoothstep(r.y - soft, r.y + soft, cu.y)
             * (1.0 - smoothstep(r.w - soft, r.w + soft, cu.y));
    return mx * my;
}

/*
 * 遮罩选择。罕贵度全靠"加工哪一块"区分，所以这份清单就是这份文档的核心词汇表：
 *   0 全卡面   1 卡图   2 卡框   3 卡名   4 效果框   5 卡图+卡框
 *   6 金属区（卡框+卡名+卡图外环）   7 卡框+卡图外环
 *   8 效果框里的字（按暗度从效果框里抠）   9 卡框+卡名   10 卡图+卡名
 *
 * 四块区域的来源：
 *   卡名 / 卡图 / 效果框 / 卡片剪影  → 掩膜纹理的 R / G / B / A
 *   卡框（= 卡片 − 卡图窗外框 − 效果框）与卡图外环（= 卡图窗外框 − 卡图内容）
 *    → 按 uRectArtOuter 这个矩形**现算**（为什么不烤进掩膜：见 embed-card.mjs 的注释）
 */
float pickMask(vec4 m, float sel, vec2 uv) {
    vec2 cu = cardUV(uv);
    float outer = rectMask(cu, uRectArtOuter, 0.006);
    float card = m.a;
    float frame = card * (1.0 - outer) * (1.0 - m.b);
    float ring = outer * (1.0 - m.g);

    float s = floor(sel + 0.5);
    if (s < 0.5) return card;
    if (s < 1.5) return m.g;
    if (s < 2.5) return frame;
    if (s < 3.5) return m.r;
    if (s < 4.5) return m.b;
    if (s < 5.5) return max(m.g, frame);
    if (s < 6.5) return max(frame, ring);
    if (s < 7.5) return max(frame, ring);
    if (s < 8.5) {
        // 效果框里的字：效果框是白底黑字，所以按暗度抠
        float g = luma(texture(uTex, uv).rgb);
        return m.b * (1.0 - smoothstep(0.25, 0.70, g));
    }
    if (s < 9.5) return max(frame, m.r);
    if (s < 10.5) return max(m.g, m.r);
    return card;
}

/*
 * 衍射光谱。闪膜的物理是**光栅衍射**：同一条纹路上的颜色随观察角整体移动，
 * 所以这里用"相位场 ph"统一驱动色相 —— 换一种花纹只需要换 ph 的算法。
 *   grain 越大 → 彩虹带越窄（越像碎冰），越小 → 越像宽光带。
 */
vec3 spectrum(float ph, float grain) {
    float s = 0.5 + 0.5 * sin(ph * TAU);
    float b = pow(clamp(s, 0.0, 1.0), max(grain, 0.05));
    vec3 hue = hsv2rgb(vec3(fract(ph * 0.62 + 0.05), 0.78, 1.0));
    return mix(vec3(1.0), hue, b);
}

/*
 * 把光谱叠到卡面上（**按满强度施加**，最后再靠 alpha 覆盖度与画面混合）。
 * 闪膜是**反光**：印刷越暗的地方越显色，亮的地方泛白 —— 这就是闪箔在亮卡面上
 * 几乎看不出来的原因（与 Balatro foil.fs 里那条 "delta = min(high, max(0.5,1-low))"
 * 是同一个道理）。
 *   dark = 0 一视同仁，dark = 1 完全按暗度加权
 */
vec3 overlaySpec(vec3 base, vec3 spec, float dark) {
    float g = luma(base);
    float w = mix(1.0, 1.0 - g, clamp(dark, 0.0, 1.0));
    vec3 col = mix(base, base * (0.45 + 0.85 * spec), w);
    return col + spec * w * 0.22;
}

// 图集里取一格（格宽 0.25、格高 0.5），f 是格内坐标 0..1
float stampAt(vec2 cellIndex, vec2 f) {
    return texture(uStamp, (cellIndex + f) * vec2(0.25, 0.5)).a;
}

// 覆盖度：遮罩 × 强度，夹到 0..1
float cover(float mask, float strength) { return clamp(mask * strength, 0.0, 1.0); }
`;

  // 每个效果的正文：定义 vec4 effect(vec2 uv)
  const BODY = {};

  // ------------------------------------------------------------ 基础三件 ----

  BODY.base = `
// 直通：原始卡面。draw step 的第一遍永远是它。
vec4 effect(vec2 uv) { return texture(uTex, uv); }
`;

  BODY.shadow = `
// 投影剪影。uP0.x = 不透明度，uP0.y = 模糊半径（像素）。
// 25 抽样做软边：卡片是方角的，硬投影会在下面留一道黑边。
vec4 effect(vec2 uv) {
    vec2 ts = max(uP0.y, 0.5) / uResolution;
    float a = 0.0;
    for (int j = -2; j <= 2; j++) {
        for (int i = -2; i <= 2; i++) {
            a += texture(uTex, uv + vec2(float(i), float(j)) * ts).a;
        }
    }
    return vec4(0.0, 0.0, 0.0, (a / 25.0) * uP0.x);
}
`;

  BODY.bg = `
// 背景。uP0.x=渐变强度 uP0.y=暗角 uCol=底色 uP1.x=斜向光带
vec4 effect(vec2 uv) {
    vec3 top = uCol.rgb * 0.55;
    vec3 bot = uCol.rgb * 1.25;
    vec3 c = mix(top, bot, smoothstep(0.0, 1.0, uv.y));
    vec2 d = (uv - 0.5) * vec2(uAspect, 1.0);
    float vig = smoothstep(1.15, 0.15, length(d) * 1.7);
    c *= mix(1.0 - uP0.y, 1.0 + uP0.y * 0.35, vig);
    // 一道缓慢横移的斜向光带，避免整屏死板。
    // 指数 3.5（不是 6）—— 太窄的话光带只占几个像素，扫过去几乎看不出来。
    float band = pow(max(0.0, sin((uv.x * 1.3 + uv.y * 0.7) * 3.1 - uTime * 0.18)), 3.5);
    c += uCol.rgb * band * uP1.x;
    return vec4(c, 1.0);
}
`;

  BODY.maskdebug = `
// 掩膜调试：把几块工艺区按颜色画出来，用来核对"区域切得对不对"。
// 红=卡名  绿=卡图  蓝=效果框  灰=卡框  黄=卡图外环
vec4 effect(vec2 uv) {
    vec4 t = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float card = pickMask(m, 0.0, uv);
    float frame = pickMask(m, 2.0, uv);
    float ring = rectMask(cardUV(uv), uRectArtOuter, 0.006) * (1.0 - m.g);
    vec3 c = vec3(0.09);
    c = mix(c, vec3(0.62), frame);
    c = mix(c, vec3(0.25, 1.0, 0.35), m.g * 0.75);
    c = mix(c, vec3(0.30, 0.45, 1.0), m.b * 0.75);
    c = mix(c, vec3(1.0, 0.85, 0.20), ring * 0.85);
    c = mix(c, vec3(1.0, 0.25, 0.25), m.r);
    return vec4(c, t.a * card);
}
`;

  // ------------------------------------------------------------ 闪膜家族 ----

  BODY.holo = `
// 全息闪膜（面闪 SR / 全卡面全息 Starlight / 平爆 NPR …）
//   uP0 = (强度, 花纹尺度, 条纹锐度, 域扭曲)
//   uP1 = (色相偏移, 视角增益, 暗部增强, 遮罩选择)
//   uP2 = (流动速度, 细颗粒, 保留, 保留)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 spy = isoUV(cardUV(uv));
    float warp = (fbm(spy * uP0.y + uSeed) - 0.5) * uP0.w;
    float ph = (spy.x * 0.95 + spy.y * 0.62) * 0.9 + warp
             + uView.x * uP1.y + uView.y * uP1.y * 0.62
             + uTime * uP2.x + uP1.x;
    vec3 spec = spectrum(ph, uP0.z);

    // 闪膜本身还有一层细颗粒（实卡的膜不是镜面）
    float grain = 0.82 + 0.36 * vnoise(spy * 260.0 + uSeed);
    spec *= mix(1.0, grain, uP2.y);

    vec3 col = overlaySpec(tex.rgb, spec, uP1.z);
    return vec4(col, tex.a * cover(region, uP0.x));
}
`;

  BODY.parallel = `
// 爆闪 / 平行闪膜（PR、NPR、RPR、SPR、UPR、Starlight 的底纹…）
//   实卡是一整面**极细的平行线光栅**，倾斜时整片彩虹一起扫过去。
//   uP0 = (强度, 线密度, 线锐度, 暗部增强)
//   uP1 = (色带频率, 视角增益, 线角度(弧度), 遮罩选择)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 spy = isoUV(cardUV(uv));
    float ca = cos(uP1.z), sa = sin(uP1.z);
    float d = (spy.x * ca + spy.y * sa) * uP0.y;
    float line = 0.5 + 0.5 * sin(d * TAU);
    float sparkle = pow(clamp(line, 0.0, 1.0), uP0.z);

    // 颜色只沿"垂直线的方向"缓慢变化 —— 这是爆闪与别的闪膜最大的观感区别
    float bandPh = (spy.x * (-sa) + spy.y * ca) * uP1.x
                 + uView.x * uP1.y + uView.y * uP1.y * 0.5 + uTime * 0.05;
    vec3 spec = spectrum(bandPh, 1.7);
    spec *= 0.45 + 0.9 * sparkle;

    vec3 col = overlaySpec(tex.rgb, spec, uP0.w);
    return vec4(col, tex.a * cover(region, uP0.x));
}
`;

  BODY.diagonal = `
// 斜向碎冰闪膜（银碎 SER / 斜碎 ESR）
//   实卡是斜向的碎冰状膜：斜光栅 + 沿栅格随机分布的碎片色相。
//   uP0 = (强度, 碎格密度, 锐度, 暗部增强)
//   uP1 = (角度(弧度), 视角增益, 副方向混合, 遮罩选择)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 spy = isoUV(cardUV(uv));
    float ca = cos(uP1.x), sa = sin(uP1.x);
    float d1 = (spy.x * ca + spy.y * sa) * uP0.y;
    float d2 = (spy.x * (-sa) + spy.y * ca) * uP0.y * 0.41;
    vec2 g = vec2(d1, d2);
    float cell = hash21(floor(g) + uSeed);
    vec2 f = fract(g);

    // 碎片边界（两条栅格的近边）→ 冰裂纹路
    float e1 = min(f.x, 1.0 - f.x);
    float e2 = min(f.y, 1.0 - f.y);
    float edge = min(e1, e2);
    float crack = smoothstep(0.075, 0.0, edge);

    float ph = cell * 0.85 + (f.x + f.y) * 0.13
             + uView.x * uP1.y + uView.y * uP1.y * 0.55 + uTime * 0.035;
    vec3 spec = spectrum(ph, 1.0 + 9.0 * (0.5 - edge));
    spec += vec3(0.80, 0.88, 1.0) * crack * 0.85;    // 裂纹发白

    vec3 col = overlaySpec(tex.rgb, spec, uP0.w);
    return vec4(col, tex.a * cover(region, uP0.x));
}
`;

  BODY.prismatic = `
// 棱彩 / 白碎（PSER 白碎、PCR、PUR、Starlight 的全卡面平行膜）
//   正反两个方向的细光栅交叉 → 交叉点炸白，就是"白碎"那个闪法。
//   uP0 = (强度, 密度, 交叉白, 暗部增强)
//   uP1 = (角度(弧度), 视角增益, 交叉混合, 遮罩选择)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 spy = isoUV(cardUV(uv));
    float ca = cos(uP1.x), sa = sin(uP1.x);
    float a1 = (spy.x * ca + spy.y * sa) * uP0.y;
    float a2 = (spy.x * (-sa) + spy.y * ca) * uP0.y;
    float g1 = 0.5 + 0.5 * sin(a1 * TAU);
    float g2 = 0.5 + 0.5 * sin(a2 * TAU);
    float cross = pow(clamp(g1 * g2, 0.0, 1.0), 2.0);
    float mixg = mix(g1, g1 * g2, uP1.z);

    float ph = (spy.x * 0.72 + spy.y * 0.44) * 1.05
             + uView.x * uP1.y + uView.y * uP1.y * 0.6 + uTime * 0.05;
    vec3 spec = spectrum(ph, 2.2) * (0.42 + 0.95 * mixg);
    spec += vec3(1.0) * cross * uP0.z;               // 交叉点炸白
    spec += vec3(0.55, 0.72, 1.0) * pow(clamp(g1, 0.0, 1.0), 8.0) * 0.35;

    vec3 col = overlaySpec(tex.rgb, spec, uP0.w);
    return vec4(col, tex.a * cover(region, uP0.x));
}
`;

  BODY.starfoil = `
// 星箔（TCG Starfoil Rare）。星形闪膜，一格一颗四角星。
//   uP0 = (强度, 密度, 星形锐度, 暗部增强)
//   uP1 = (视角增益, 星外底色, 保留, 遮罩选择)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 g = squareGrid(cardUV(uv), 1.0 / max(uP0.y, 0.001));
    vec2 id = floor(g), f = fract(g) * 2.0 - 1.0;
    // 四角星（astroid 的变体）：|x|^p + |y|^p < 1
    float st = pow(abs(f.x), uP0.z) + pow(abs(f.y), uP0.z);
    float star = smoothstep(1.02, 0.30, st);

    float h = hash21(id + uSeed);
    float ph = h * 0.9 + uView.x * uP1.x + uView.y * uP1.x * 0.5 + uTime * 0.04;
    vec3 spec = spectrum(ph, 1.5) * (uP1.y + (1.0 - uP1.y) * 1.25 * star);
    spec += vec3(0.9, 0.95, 1.0) * pow(star, 4.0) * 0.45;

    vec3 col = overlaySpec(tex.rgb, spec, uP0.w);
    return vec4(col, tex.a * cover(region, uP0.x));
}
`;

  BODY.mosaic = `
// 马赛克闪（TCG Mosaic Rare）。方格闪膜，一格一个色相，格线压暗。
//   uP0 = (强度, 密度, 格线宽度, 暗部增强)
//   uP1 = (视角增益, 色相散布, 保留, 遮罩选择)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 g = squareGrid(cardUV(uv), 1.0 / max(uP0.y, 0.001));
    vec2 id = floor(g), f = fract(g);
    float h = hash21(id + uSeed);
    float ph = h * uP1.y + uView.x * uP1.x + uView.y * uP1.x * 0.45 + uTime * 0.03;
    vec3 spec = spectrum(ph, 0.9);
    float gap = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    spec *= mix(0.28, 1.15, smoothstep(uP0.z * 0.35, uP0.z, gap));

    vec3 col = overlaySpec(tex.rgb, spec, uP0.w);
    return vec4(col, tex.a * cover(region, uP0.x));
}
`;

  BODY.voronoi = `
// 碎箔（TCG Shatterfoil Rare）。不规则碎片闪膜 —— 用 Voronoi 造碎片。
//   uP0 = (强度, 碎片密度, 裂纹亮度, 暗部增强)
//   uP1 = (视角增益, 色相散布, 保留, 遮罩选择)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 g = squareGrid(cardUV(uv), 1.0 / max(uP0.y, 0.001));
    vec2 id = floor(g), f = fract(g);
    float best = 8.0;
    vec2 bid = id;
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec2 o = vec2(float(i), float(j));
            vec2 rp = o + vec2(hash21(id + o + uSeed), hash21(id + o + 37.7 + uSeed)) - f;
            float dd = dot(rp, rp);
            if (dd < best) { best = dd; bid = id + o; }
        }
    }
    float e = sqrt(best);
    float h = hash21(bid * 1.37 + uSeed);
    float rim = smoothstep(0.18, 0.52, e);          // 越靠碎片边越亮
    float ph = h * uP1.y + uView.x * uP1.x + uView.y * uP1.x * 0.5 + uTime * 0.03;
    vec3 spec = spectrum(ph, 1.2) * mix(0.45, 1.0, rim);
    spec += vec3(0.85, 0.92, 1.0) * pow(rim, 3.0) * uP0.z;

    vec3 col = overlaySpec(tex.rgb, spec, uP0.w);
    return vec4(col, tex.a * cover(region, uP0.x));
}
`;

  // ------------------------------------------------- 加光类（blend: 'add'）--

  BODY.glitter = `
// 闪粉：细碎的亮点（给高罕贵加一层"粉"，实卡上那些细小的闪光点）。
// **加法混合**：只输出"多加了多少光"，不碰卡面颜色。
//   uP0 = (强度, 密度, 尺寸, 闪烁速度)   uP1 = (保留, 保留, 保留, 遮罩选择)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(0.0, 0.0, 0.0, 1.0);

    vec2 g = squareGrid(cardUV(uv), 1.0 / max(uP0.y, 0.001));
    vec2 id = floor(g), f = fract(g);
    // 每格一个随机相位，按时间整体跳 —— 观感就是"细粉在闪"
    float tw = hash21(id + floor(uTime * uP0.w) * 7.13 + uSeed);
    vec2 c = vec2(hash21(id + 1.7 + uSeed), hash21(id + 3.1 + uSeed));
    float dd = length(f - c);
    float sp = smoothstep(uP0.z, 0.0, dd) * step(0.68, tw);

    // 闪耀的颜色也随视角略变，免得像一层死白点
    vec3 tint = mix(vec3(1.0), hsv2rgb(vec3(fract(hash21(id + 5.5) + uView.x * 0.3), 0.5, 1.0)), 0.45);
    vec3 add = tint * sp * uP0.x * region * (0.55 + 0.55 * luma(tex.rgb));
    return vec4(add, 1.0);
}
`;

  BODY.gloss = `
// 卡面扫光。给"该有光泽"的工艺补一层缓慢扫过的宽高光。
// **加法混合**：只输出多加的光。
//   uP0 = (强度, 频率, 锐度, 速度)   uP1 = (视角增益, 保留, 保留, 遮罩选择)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(0.0, 0.0, 0.0, 1.0);

    vec2 spy = isoUV(cardUV(uv));
    float s = sin((spy.x * 1.15 + spy.y * 0.55) * uP0.y
                - uTime * uP0.w + uView.x * uP1.x);
    // 用 abs() 而不是 max(s,0)，再加一层常驻底光。
    // 只用 max(s,0) 的话，"扫过去"的那段时间整层**一点都不亮** ——
    // 实测 t=2~5s 整整四秒卡片区平均差正好是 0，一个"卡面光泽"层有四成时间是死的说不过去。
    // abs() 让高光带一个周期出现两次，0.22 的底光保证任何时候都有一层微弱反光。
    float band = 0.22 + 0.78 * pow(abs(s), max(uP0.z, 0.5));
    vec3 add = vec3(band) * uP0.x * region * (0.35 + 0.65 * luma(tex.rgb));
    return vec4(add, 1.0);
}
`;

  // ------------------------------------------------- 图案类（要 uStamp）----

  BODY.kc = `
// KC 闪（KC Rare）。实卡是"线条 + KC 标志"的闪膜，有 NKC / RKC / UKC 等变体。
//   uP0 = (强度, 线密度, 线锐度, KC 标强度)
//   uP1 = (视角增益, 色带频率, 标平铺尺寸, 遮罩选择)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 spy = isoUV(cardUV(uv));
    float line = pow(clamp(0.5 + 0.5 * sin(spy.x * uP0.y * TAU), 0.0, 1.0), uP0.z);

    float ph = (spy.x * 0.55 + spy.y * 0.32) * uP1.y + uView.x * uP1.y
             + uView.y * uP1.y * 0.5 + uTime * 0.04;
    vec3 spec = spectrum(ph, 1.5) * (0.42 + 0.9 * line);

    // KC 标：按格子重复，隔行错开
    vec2 g = squareGrid(cardUV(uv), uP1.z);
    vec2 id = floor(g);
    vec2 f = fract(g + vec2(mod(id.y, 2.0) * 0.5, 0.0));
    float logo = stampAt(vec2(0.0, 0.0), f);
    spec += vec3(0.88, 0.93, 1.0) * logo * uP0.w * (0.55 + 0.55 * line);

    vec3 col = overlaySpec(tex.rgb, spec, 0.35);
    return vec4(col, tex.a * cover(region, uP0.x));
}
`;

  BODY.millennium = `
// 千年闪（Millennium Rare）。实卡是"埃及文字图案"的闪膜。
//   这里用图集下排那 4 个象形字（安卡 / 荷鲁斯之眼 / 王名圈 / 水波鸟）按格随机拼，
//   是**风格化近似**，不是真·圣书体字形（见 README 的"已知取舍"）。
//   uP0 = (强度, 线密度, 字形强度, 字形密度)
//   uP1 = (视角增益, 保留, 保留, 遮罩选择)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 spy = isoUV(cardUV(uv));
    float line = 0.5 + 0.5 * sin(spy.x * uP0.y * TAU);

    float ph = (spy.x * 0.5 + spy.y * 0.3) + uView.x * uP1.x
             + uView.y * uP1.x * 0.5 + uTime * 0.035;
    vec3 spec = spectrum(ph, 1.3) * (0.45 + 0.8 * line);

    // 象形字：一格一个字，四种字形按格随机挑
    vec2 g = squareGrid(cardUV(uv), uP0.w);
    vec2 id = floor(g);
    vec2 f = fract(g);
    // 随机镜像，否则一眼就能看出来是一格一格的重复
    if (hash21(id + 11.3) > 0.5) f.x = 1.0 - f.x;
    if (hash21(id + 23.7) > 0.5) f.y = 1.0 - f.y;
    float pick = floor(hash21(id + uSeed) * 4.0);
    vec2 cellIdx = vec2(pick, 1.0);
    float glyph = stampAt(cellIdx, f);
    // 字形之间用细线串起来，像"文字带"
    float rule = smoothstep(0.10, 0.0, abs(f.y - 0.5) - 0.42);
    spec += vec3(0.90, 0.86, 0.70) * (glyph + rule * 0.35) * uP0.z * (0.6 + 0.5 * line);

    vec3 col = overlaySpec(tex.rgb, spec, 0.30);
    return vec4(col, tex.a * cover(region, uP0.x));
}
`;

  BODY.stamp = `
// 周年水印（20th SER 的 "20th" / QCScR 的 "25th"）
//   uP0 = (强度, 平铺尺寸, 保留, 遮罩选择)
//   uP1 = (图集格 x, 图集格 y, 保留, 保留)
//   uP2 = (偏移 x, 偏移 y, 保留, 保留)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP0.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 g = squareGrid(cardUV(uv), uP0.y) + uP2.xy;
    vec2 id = floor(g);
    // 斜排：每行横向错开半格，观感更像实卡那种密排水印
    vec2 f = fract(g + vec2(mod(id.y, 2.0) * 0.5, 0.0));
    float a = stampAt(uP1.xy, f);

    // 水印是"压印"上去的：暗处变亮、亮处变暗，不是单纯叠一层色
    vec3 tint = mix(uCol.rgb * 0.55, vec3(1.0), 0.35);
    vec3 col = mix(tex.rgb, tint, a);
    return vec4(col, tex.a * cover(a, uP0.x) * region);
}
`;

  // ------------------------------------------------------------ 工艺家族 ----

  BODY.emboss = `
// 浮雕（UTR 终极罕贵 / PUR 棱彩浮雕）。实卡是插画被金属箔压出凹凸，
// 侧光下看得见立体感 —— 所以这里的做法是：**把卡面自己的明暗当高度场**，
// 求梯度得到法线，再用一盏方向光打亮。
//   uP0 = (强度, 光照角度(弧度), 金属化程度, 高光)
//   uP1 = (遮罩选择, 细节尺度, 光照俯角, 保留)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.x, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 ts = 1.0 / uResolution;
    float sc = uP1.y;
    float hl = luma(texture(uTex, uv - vec2(ts.x, 0.0)).rgb);
    float hr = luma(texture(uTex, uv + vec2(ts.x, 0.0)).rgb);
    float hu = luma(texture(uTex, uv - vec2(0.0, ts.y)).rgb);
    float hd = luma(texture(uTex, uv + vec2(0.0, ts.y)).rgb);
    vec3 n = normalize(vec3((hl - hr) * sc, (hu - hd) * sc, 1.0));

    vec3 L = normalize(vec3(cos(uP0.y), sin(uP0.y), max(uP1.z, 0.05)));
    float diff = max(dot(n, L), 0.0);
    float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 26.0);

    float g = luma(tex.rgb);
    // 浮雕本身：按法线打光，亮面提亮、暗面压暗
    vec3 relief = tex.rgb * (0.52 + 0.95 * diff) + uCol.rgb * spec * uP0.w;
    // 金属化：浮雕罕贵的插画本身就是金属箔压的
    vec3 metal = uCol.rgb * (0.30 + 0.95 * pow(g, 1.4)) * (0.55 + 0.85 * diff);
    metal += vec3(1.0) * spec * uP0.w * 0.6;

    vec3 col = mix(relief, metal, clamp(uP0.z, 0.0, 1.0));
    return vec4(col, tex.a * cover(region, uP0.x));
}
`;

  BODY.ghost = `
// 幽灵 / 鬼闪（HR 全息 Rare，TCG 叫 Ghost Rare）。
//   整张卡变成银白，怪兽像"幽灵"一样浮出来，倾斜时有一层冷色彩虹。
//   uP0 = (强度, 彩虹强度, 对比度, 辉光)
//   uP1 = (遮罩选择, 保留, 保留, 保留)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.x, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    float g = luma(tex.rgb);
    float gg = pow(clamp(smoothstep(0.02, 0.92, g), 0.0, 1.0), max(uP0.z, 0.05));
    vec3 silver = mix(vec3(0.26, 0.31, 0.44), vec3(1.0), gg);
    silver *= vec3(0.93, 0.98, 1.10);              // 偏冷

    vec2 spy = isoUV(cardUV(uv));
    float ph = spy.x * 0.8 + spy.y * 0.5 + (fbm(spy * 2.2 + uSeed) - 0.5) * 0.9
             + uView.x * 1.35 + uView.y * 1.35 * 0.6 + uTime * 0.05;
    vec3 spec = spectrum(ph, 3.0);

    float glow = pow(gg, 3.0) * uP0.w;
    vec3 col = silver + spec * glow * uP0.y + vec3(glow * 0.30);

    return vec4(col, tex.a * cover(region, uP0.x));
}
`;

  BODY.metal = `
// 金属工艺（GUR 黄金闪 / PlR 铂金闪 / GScR / PlScR / GGR）。
//   实卡是整块金属箔：底色换成金/铂金，印刷图案变成"金属上的浮雕"，
//   还有一层随视角走的拉丝高光。
//   uP0 = (强度, 拉丝密度, 拉丝各向异性, 高光)
//   uP1 = (遮罩选择, 视角增益, 印刷保留度, 保留)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.x, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 spy = isoUV(cardUV(uv));
    float brush = fbm(vec2(spy.x * uP0.y, spy.y * uP0.y * max(uP0.z, 0.02)) + uSeed);
    float g = clamp(luma(tex.rgb), 0.0, 1.0);

    // 金属的明暗**只由印刷的亮度决定**，而且映射回 0..1 不加增益 ——
    // 加增益会让亮的地方一起炸白、暗的地方一起提亮，最后整张卡糊成一块金板。
    float shade = 0.08 + 0.98 * pow(g, 0.90);

    // 纯金属箔（卡框就该是这样）：底色 × 明暗 × 拉丝
    vec3 foil = uCol.rgb * shade * (0.80 + 0.42 * brush);
    // 镀金印刷（插画的观感）：把原图按亮度**映射**成金色，再混回一点原印刷色，
    // 于是图案还认得出来，只是整体变金 —— 黄金闪的插画要的是这一路
    vec3 gilt = mix(tex.rgb, uCol.rgb * shade, 0.72);
    vec3 metal = mix(foil, gilt, clamp(uP1.z, 0.0, 1.0));

    // 随视角滑动的宽高光
    float sw = pow(max(0.0, sin((spy.x + spy.y) * 2.1 + uView.x * 3.0 + uTime * 0.22)), 6.0);
    metal += uCol.rgb * sw * uP0.w * 1.4;

    return vec4(metal, tex.a * cover(region, uP0.x));
}
`;

  BODY.rainbow = `
// 彩虹反射（CR 收藏闪 / PCR 棱彩收藏闪）。
//   实卡是边框、卡名、卡图外框上有彩虹色反射 —— 反射点是**跟着视角跑**的，
//   所以这里以 uViewPt 为中心按极坐标取色相，鼠标一动整圈彩虹就跟着转。
//   uP0 = (强度, 饱和度, 半径衰减, 保留)
//   uP1 = (遮罩选择, 色相偏移, 保留, 保留)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.x, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 cu = cardUV(uv);
    vec2 d = (cu - uViewPt) * vec2(uAspect, 1.0);
    float r = length(d);
    float a = atan(d.y, d.x) / TAU;
    float ph = a + r * 1.9 - uView.x * 0.55 + uP1.y;

    vec3 rain = hsv2rgb(vec3(fract(ph + 0.5), clamp(uP0.y, 0.0, 1.0), 1.0));
    vec3 spec = mix(spectrum(ph, 0.7), rain, 0.7);

    float k = mix(1.0, smoothstep(1.15, 0.0, r), clamp(uP0.z, 0.0, 1.0));
    float g = luma(tex.rgb);
    vec3 col = tex.rgb * 0.16 + spec * (0.50 + 0.80 * g);
    return vec4(col, tex.a * cover(region * k, uP0.x));
}
`;

  BODY.name = `
// 卡名工艺（R 银字 / UR 金闪的卡名 / 20th SER 红碎 / PSER 白碎卡名）。
//   遮罩走 R 通道（**从图里按暗度抠出来的笔画**，再膨胀两像素）——
//   于是换成银色/金色时笔画会稍微变粗，正好和实卡上烫金比印刷粗一点对得上。
//   uP0 = (强度, 金属明暗对比, 碎闪强度, 保留)
//   uP1 = (渐变频率, 渐变相位, 保留, 保留)
vec4 effect(vec2 uv) {
    vec4 tex = texture(uTex, uv);
    vec4 m = texture(uMask, uv);
    if (m.r < 0.004) return vec4(tex.rgb, 0.0);

    vec2 cu = cardUV(uv);
    float t = fract(cu.y * uP1.x + uP1.y);
    float band = 0.5 + 0.5 * sin(t * TAU);
    float g = luma(tex.rgb);

    // 烫金/烫银：底 + 明暗带 + 靠暗部更亮（压在黑字上才显色）
    vec3 metal = uCol.rgb * (0.50 + uP0.y * band) * (0.70 + 0.70 * (1.0 - g));
    metal += uCol.rgb * pow(band, 6.0) * 0.30;

    // 碎闪：白色细点，随时间跳（PSER 白碎卡名就是这种感觉）
    vec2 sp = vec2(cu.x / uAspect, cu.y) * 320.0;
    float tw = hash21(floor(sp) + floor(uTime * 7.0) * 3.77 + uSeed);
    metal += vec3(1.0) * step(0.972, tw) * uP0.z;

    return vec4(metal, tex.a * cover(m.r, uP0.x));
}
`;

  // -------------------------------------------------------------- 组装 ------

  function frag(body) { return PRELUDE + body + `
void main() { fragColor = effect(vUV); }
`; }

  const EFFECTS = {};
  for (const k of Object.keys(BODY)) EFFECTS[k] = frag(BODY[k]);

  /*
   * 顶点着色器：**真正的 3D 倾斜**。
   * 拿实卡看闪膜本来就是"捏着卡慢慢转"—— 所以这里把卡片绕 X/Y 轴转起来，
   * 再用同样这两个角度去驱动闪膜的衍射相位（uView），观感才对得上。
   *
   * 为了让花纹跟着卡片一起被透视，gl_Position 的 w 用 z 给出（不是 1）——
   * 这样纹理坐标是按透视插值的，倾斜时卡面不会错位。
   */
  const VERTEX = `#version 300 es
precision highp float;

uniform vec2  uResolution;
uniform vec2  uCenter;     // 卡片中心（像素，y 向下）
uniform vec2  uTilt;       // 倾斜角（弧度）
uniform float uDist;       // 相机距离（像素）
uniform float uFocal;      // 焦距（像素）

in vec2 aPos;              // 画布像素坐标，y 向下
in vec2 aUV;
out vec2 vUV;

void main() {
    vUV = aUV;
    vec3 p = vec3(aPos - uCenter, 0.0);

    float cy = cos(uTilt.y), sy = sin(uTilt.y);
    p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
    float cx = cos(uTilt.x), sx = sin(uTilt.x);
    p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);

    float z = max(p.z + uDist, uFocal * 0.25);
    float k = uFocal / z;
    vec2 screen = uCenter + p.xy * k;

    vec2 ndc = vec2(screen.x / uResolution.x * 2.0 - 1.0,
                    1.0 - screen.y / uResolution.y * 2.0);
    float w = z / uDist;
    gl_Position = vec4(ndc * w, 0.0, w);
}
`;

  global.CardShaders = {
    PRELUDE: PRELUDE,
    BODY: BODY,
    EFFECTS: EFFECTS,
    VERTEX: VERTEX,
    // 基础件（不算罕贵度工艺）
    UTILITY: ['base', 'shadow', 'bg', 'maskdebug'],
    // 纯加光的层要用加法混合
    ADDITIVE: ['glitter', 'gloss'],
    // 工艺清单
    CRAFT: [
      'holo', 'parallel', 'diagonal', 'prismatic', 'starfoil', 'mosaic',
      'voronoi', 'glitter', 'kc', 'millennium', 'stamp', 'emboss',
      'ghost', 'metal', 'rainbow', 'name', 'gloss'
    ]
  };
})(window);
