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
 * ④ 图案膜的"可见窗口"。图案膜（KC 闪的电路、千年闪的象形字）铺满整卡，但**永远只显形
 *    一部分** —— 实卡的图案膜本来就只在一个观察角附近把光反进眼睛。两种驱动方式：
 *      `angleGate` + `filmField`  按观察角分组，一条**斜波带**扫过卡面（千年闪用）
 *      `cursorGate`               **鼠标指到哪儿，那一块附近就显形**（KC 闪用）
 *    两者的可见面积都由配方里的半径/半宽决定（千年闪夹死 ≤25%，KC 闪约 45%）。
 *    这一条是观感的关键，见 PRELUDE 里那两段注释。
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

uniform vec4  uRectArtOuter;  // 卡图窗外框的矩形 (x0,y0,x1,y1)，cardUV 坐标
uniform vec4  uRectArtInner;  // 卡图窗内沿（插画本身）
uniform vec4  uRectTextBox;   // 效果框（含 ATK/DEF 带）
uniform vec4  uRectStar;      // 星数 / 阶数带 (x0,y0,x1,y1)，名带与卡图窗之间那一条
uniform vec4  uCircleAttr;    // 属性圆 (圆心 x, 圆心 y, 半径, 软边)，半径单位是"卡高 = 1"
uniform vec4  uContent;       // 卡片内容在纹理里的归一化矩形（去掉四周留白）
uniform vec2  uResolution;    // 目标像素尺寸
uniform float uMargin;        // 卡图纹理四周留白比例
uniform float uTime;          // 运行时钟（秒）
uniform vec2  uView;          // 视角方向（-1..1，来自卡片倾斜）
uniform vec2  uViewPt;        // 高光点在卡片坐标里的位置
uniform vec2  uMouse;         // 光标在卡片坐标里的位置（0..1，v=0 是上沿）
uniform float uAspect;        // 卡片宽 / 高
uniform float uSeed;          // 每张卡的固定噪声相位
uniform vec4  uCardRound;     // 圆角：x = 半径, y = 抗锯齿半宽（都按"高 = 1"归一）

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

/*
 * 卡面遮罩 + 纹理采样包装。
 *
 * **所有**采样 uTex 的地方都走 cardTex()（25 处），而不是直接 texture(uTex, ...)。
 * 这样圆角只要在这里削一次 alpha 就对每一层都生效 —— 因为每个工艺着色器返回的都是
 * vec4(col, tex.a * 覆盖度)（见本文件顶部），全都乘 tex.a。
 * 否则得挨个改二十多个着色器的返回值，漏一个那个角上就漏个尖。
 *
 * 为什么圆角能在**运行时**调：它只是 alpha 上的一道遮罩，跟图像内容无关。
 *（对照：卡名笔画必须烘焙 —— 那是从图里按暗度抠出来的。）
 */
float cardMask(vec2 uv) {
    if (uCardRound.x <= 0.0) {
        // 不削圆角时也把卡片外面判成 0：阴影靠采样 alpha 做软边，
        // 越界后 CLAMP_TO_EDGE 会把边缘的不透明像素取回来，软边就散不开。
        return (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) ? 0.0 : 1.0;
    }
    // 归一成"高 = 1"的等比坐标，圆角才不会被横向拉成椭圆
    // （变量名别用 half —— GLSL ES 里它是保留字，编译直接失败）
    vec2 p = vec2(uv.x * uAspect, uv.y);
    vec2 hc = vec2(uAspect, 1.0) * 0.5;
    vec2 d = abs(p - hc) - (hc - vec2(uCardRound.x));
    float sdf = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - uCardRound.x;
    // 抗锯齿只往**外**过渡（0 → +aa），不能写成 smoothstep(-aa, +aa, sdf)：
    // 那样在卡片边界上（sdf 正好 = 0）alpha 是 0.5，四条边全会渗背景 ——
    // 在深色背景上就是一圈半透明的暗边，卡片一摆动它就跟着闪。
    return 1.0 - smoothstep(0.0, uCardRound.y, sdf);
}

vec4 cardTex(vec2 uv) {
    vec4 t = texture(uTex, uv);
    t.a *= cardMask(uv);
    return t;
}

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

/*
 * 同上，但**格子真的是方的**。
 *
 * ⚠️ squareGrid 名字叫"正方形"，实现却是「cu.x / uAspect」—— 除以长宽比等于
 *    把 x 又压扁一次（和正上方的 isoUV 正好相反，那边是**乘**）。结果格子是
 *    1 : 2.17 的瘦高条，贴上去的图案被横向压扁（千年闪的"图案宽度被压缩"就是它）。
 *    正确的写法是 isoUV 之后再除：单位长度在横竖两个方向一样长。
 *
 * 没有直接改 squareGrid，是因为它还被 kc / 星箔 / 马赛克 / 碎箔 / 20th 水印
 * 用着（第 441/467/490/526/584/679 行），格宽会一起变成 1.49 倍、那几个的观感
 * 都得重调。要动的话得一个一个看，所以先只在千年闪这边用新的。
 */
vec2 isoGrid(vec2 cu, float size) { return isoUV(cu) / size; }

// 软边矩形掩膜（卡片相对坐标）。soft 是羽化半宽，单位也是卡片相对坐标。
float rectMask(vec2 cu, vec4 r, float soft) {
    float mx = smoothstep(r.x - soft, r.x + soft, cu.x)
             * (1.0 - smoothstep(r.z - soft, r.z + soft, cu.x));
    float my = smoothstep(r.y - soft, r.y + soft, cu.y)
             * (1.0 - smoothstep(r.w - soft, r.w + soft, cu.y));
    return mx * my;
}

/*
 * 软边**圆**掩膜（卡片相对坐标）。属性图标（光/暗/地/水/炎/风/神）是名字后面一个圆，
 * 用矩形去框会连带把卡框那圈深色边一起加工，看着就是个方块 —— 所以单独走圆。
 *
 * c = (圆心 x, 圆心 y, 半径, 软边)；圆心是 cardUV，**半径的单位是"卡高 = 1"**
 * （和 uCardRound 同一个口径）。所以 x 要先乘长宽比换算成等比坐标，
 * 否则量出来的圆在屏幕上会被拉成横着的椭圆。
 */
float circleMask(vec2 cu, vec4 c) {
    vec2 d = vec2((cu.x - c.x) * uAspect, cu.y - c.y);
    float soft = max(c.w, 0.0005);
    return 1.0 - smoothstep(c.z - soft, c.z + soft, length(d));
}

/*
 * 遮罩选择。罕贵度全靠"加工哪一块"区分，所以这份清单就是这份文档的核心词汇表：
 *   0 全卡面   1 卡图   2 卡框   3 卡名   4 效果框   5 卡图+卡框
 *   6 金属区（卡框+卡名+卡图外环）   7 卡框+卡图外环
 *   8 效果框里的字（按暗度从效果框里抠）   9 卡框+卡名   10 卡图+卡名
 *   11 星数 / 阶数带   12 属性圆（名字后面那个圆）   13 **星带 + 属性圆**（两块一起）
 *
 * 七块区域的来源：
 *   卡名（笔画）/ 卡片剪影 → 掩膜纹理的 R / A。**必须烘焙** —— 笔画是从图里按暗度抠的，
 *      没法用矩形算出来。
 *   卡图窗外框 / 卡图窗内沿 / 效果框 / 星数阶数带 / 属性圆 → 按 uRectArtOuter /
 *      uRectArtInner / uRectTextBox / uRectStar / uCircleAttr **现算**。
 *      这五块本来就是纯几何（矩形、圆），不依赖图像内容，挪到着色器里之后就能做成
 *      侧栏「区域」那组滑条**实时可调**（拖一下立刻看得见，不用重烤一次 35 秒）。
 *   卡框（= 卡片 − 卡图窗外框 − 效果框）与卡图外环（= 卡图窗外框 − 卡图内沿）由上面几块推出。
 *
 * ⚠️ 星带与属性圆**落在卡框里**，所以：
 *   · 13 交出来的是这两块**本身**（不含卡框）—— "只给星位和属性加工"用这一档
 *   · 用卡框 / 金属区 / 整卡遮罩的工艺（metal、rainbow、parallel…）**本来就已经**
 *     把这两处一起加工了，不用再单独写一层
 */
float pickMask(vec4 m, float sel, vec2 uv) {
    vec2 cu = cardUV(uv);
    float outer = rectMask(cu, uRectArtOuter, 0.006);
    float inner = rectMask(cu, uRectArtInner, 0.005);
    float text  = rectMask(cu, uRectTextBox, 0.005);
    float card = m.a;
    float frame = card * (1.0 - outer) * (1.0 - text);
    float ring = outer * (1.0 - inner);

    float s = floor(sel + 0.5);
    if (s < 0.5) return card;
    if (s < 1.5) return inner;
    if (s < 2.5) return frame;
    if (s < 3.5) return m.r;
    if (s < 4.5) return text;
    if (s < 5.5) return max(inner, frame);
    if (s < 6.5) return max(frame, ring);
    if (s < 7.5) return max(frame, ring);
    if (s < 8.5) {
        // 效果框里的字：效果框是白底黑字，所以按暗度抠
        float g = luma(cardTex( uv).rgb);
        return text * (1.0 - smoothstep(0.25, 0.70, g));
    }
    if (s < 9.5) return max(frame, m.r);
    if (s < 10.5) return max(inner, m.r);
    // 这三块现算（圆要算距离，别让用不到它们的层白掏这份开销）
    if (s < 11.5) return rectMask(cu, uRectStar, 0.004);   // 星数 / 阶数带
    if (s < 12.5) return circleMask(cu, uCircleAttr);      // 属性圆
    if (s < 13.5) {                                        // 星带 + 属性圆（两块一起）
        return max(rectMask(cu, uRectStar, 0.004), circleMask(cu, uCircleAttr));
    }
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

/*
 * ── 角度窗口：任何一个角度都看不到完整的一整片图案 ────────────────────────
 *
 * 这是 KC 闪与千年闪共用的那个"最多只看到 25%"的机制，值得单独写清楚。
 *
 * 实卡的图案膜（KC 闪的线路、千年闪的象形字）不是**整片一起反光**的：
 * 膜的微结构分成许许多多组，每一组只在**某个观察角附近**才把光反进眼睛 ——
 * 所以转动卡片的时候，总有一部分在闪、另一部分是暗的，
 * **任何一个角度都看不到完整图案**，看到的是"一批亮着一批灭着"。
 *
 * 这里把它做成环上的一个窗口：
 *   local —— 每个地方**自己固定的**组相位（0..1，跟着位置走，不随视角变）
 *   sel   —— 观察角给出的选择相位（0..1，见 angleSel）
 *   两者在环上的距离 < 半宽 w 的地方才显形。
 *
 * 可见比例最多是 2w（环上长度 2w 的那一段），所以 w 一律夹在 0.225 以内 ——
 * 这一条夹的是**代码**，不是参数：面板/配方里填多大都没法突破 45% 这个上限。
 * 真要改上限只能改这里（并且要同步改文档里"最多 45%"的说法）。
 *
 * 上限的历史：先是 0.125（25%），用户看下来要"看得见更多图案"，改成 0.225（45%）。
 * 只有千年闪 / 法老闪走这一条（KC 闪用的是 cursorGate，不受影响）。
 *
 * soft 是软边：smoothstep(w, w*soft, d)。硬切（soft→1）在 d≈w 的地方会让整片
 * 图案一跳一跳地全亮全灭；soft 越小边越软、越像"慢慢亮起来"。
 *
 * ⚠️ local 那个场**必须是接近均匀分布的**，这一点踩过坑（见 filmField 的注释）。
 */
float angleGate(float local, float sel, float w, float soft) {
    float hw = min(w, 0.225);                                      // ← 45% 的天花板
    float d = abs(fract(local - sel + 0.5) - 0.5);                 // 环上的距离 0..0.5
    return smoothstep(hw, hw * clamp(soft, 0.05, 0.95), d);
}

/*
 * 图案膜的"组相位"场：铺满卡片，取值在 0..1 之间**接近均匀分布**。
 *
 * ⚠️ 为什么不能随手拿一个噪声当相位（这一条是实测换出来的）：
 *    fbm / vnoise 的取值是**挤在 0.5 附近**的（5 个八度加起来，标准差只有 0.1 上下）。
 *    拿它当组相位，窗口落在 0.5 附近时几乎整片都亮、偏离一点就整片全灭 ——
 *    实测换 15 个视角，亮着的比例在 **0% 与 47% 之间跳**：
 *    有的角度整层膜消失（用户看到的是"这个角度什么都没有"），有的角度又突破 25%。
 *
 *    所以这里用"**斜向波场 + 一点噪声**"：波场本身是均匀分布的，等相位线均匀铺开，
 *    于是**任何角度亮着的面积都约等于窗口宽度**（2w ≈ 20%）；噪声那一项只是把
 *    波带揉皱，别让它是一根笔直的斜条。
 *    观感上，亮起来的是**一条会随视角滑动的波带**（转卡时像光在卡面上扫）。
 *
 * ⚠️ 两条都是实测换出来的：
 *   ① 噪声的频率/幅度**不能大**。场里"相位随位置变化多快"（梯度）决定波带的宽窄 ——
 *      梯度小的地方带子宽、梯度大的地方带子窄，于是"亮着的比例"随角度上下摆。
 *      取 fbm(spy * 1.35) * 0.55 那一版，噪声梯度（≈0.74）跟波场自己的梯度一个量级，
 *      实测 15 个视角里亮着的比例从 5% 摆到 32%。
 *   ② 波场的**频率不能低**。低频（一个卡面才一两个周期）时，相位在场里的分布很不均匀：
 *      极值附近只有很小一块地方是那个相位，正好选到那里就几乎什么都看不见。
 *      上面那一版还有一半原因是这个（5% 那一头）。
 *   现在：波场在卡面上约 3 个周期（相位分布够均匀），噪声压到 0.22 / 0.62 频
 *   （梯度只有波场的 6%）—— 千年闪（w = 0.100）扫满 81 个视角，亮着的比例在
 *   **7.0% ~ 21.7%** 之间（见 tools/.cache/probe-films.mjs）。
 *
 * 返回 0..1。uSeed 那一项是让一览模式里 43 张卡各自错开，不然它们会一模一样。
 */
float filmField(vec2 spy) {
    return fract(spy.x * 2.10 + spy.y * 1.55
               + (fbm(spy * 0.62 + uSeed * 1.7) - 0.5) * 0.22
               + uSeed * 0.37);
}

/*
 * 观察角 → 选择相位（0..1 在环上循环）。
 *   gain 越大，卡片转一点点就换一组
 * uView 是 -1.6..1.6 的倾斜量（js/pipeline.js 的 viewVec），两项分别是绕 Y / 绕 X 的
 * 倾斜；再加一点点 uTime —— 实卡不动，但鼠标停着的时候屏幕上总得有点流动感。
 */
float angleSel(float gain) {
    return fract((uView.x * 0.62 + uView.y * 0.44) * gain + uTime * 0.02);
}

/*
 * 图案膜的"可见窗口"之二：**鼠标指到哪儿，那一块附近的图案就显形**（KC 闪用这一种）。
 *
 * 为什么不跟观察角挂钩、而是跟光标走：用户看下来要的是"我鼠标放在卡片哪儿，
 * 那一块附近的线路就亮起来"—— 上面 angleGate 那套出来的是**一条斜波带**扫过卡面，
 * 不是他要的。所以这里换成以光标为圆心的一个软斑。
 *
 * radius 是**卡片高 = 1** 的等比半径（在 iso 坐标里量，所以斑是圆的，不会被长宽比拉扁）。
 * 窗口面积 = π·radius²；卡片在 iso 里是 aspect × 1 = 0.6729，所以
 *   radius 0.31  →  π×0.31² / 0.6729 ≈ **45% 的卡面**（这就是"45% 的窗口"）
 *
 * 亮度剖面：**光标那儿最亮，往外一路渐变到边缘**。
 * 用 smoothstep(1, 0.45, t)：对焦那一圈（t < 0.45）全亮，剩下 55% 的半径都在渐变。
 * 不用"中心一大块全亮、边上才收一下"那种（看着像一个实心圆盘，不像一片膜）。
 * ⚠️ 这里原来是 0.30，改成 0.45 是因为**配色分档**（蓝/黄/橙/红）要用到整条半径：
 *    0.30 的时候 t > 0.75 那一档（红）的亮度只剩 0.1，橙色那一档也才 0.3，
 *    后面两档根本看不出颜色 —— 用户要的是"外围黄、再橙、边缘红"，得让它们亮得起来。
 *    代价是窗口边缘比原来"实"一点。
 *
 * ⚠️ 实测口径说清楚（免得跟"45%"对不上）：随着渐变，**看得出明显变化**的那部分
 * 比窗口本身小一圈 —— 按"与金闪底子的逐像素差 > 10"量约 38%，再往外是一层很淡的
 * 过渡（这正是渐变要的效果）。见 tools/.cache/probe-kc-board.mjs。
 *
 * 鼠标贴到卡片边角时斑会被卡片切掉一部分，所以 45% 是**上限**（鼠标在正中间时最大）。
 * 边缘还拿噪声揉了一下（±15%），不然是个规规矩矩的圆、不像膜。
 * **颜色**由 cursorT 分档驱动（见 BODY.kc）：光标那儿蓝 → 黄 → 橙 → 边缘红，
 * 分档和这道窗口的渐变共用同一个 t，所以"红的那一圈"正好落在快看不见的地方。
 */
// 光标距离的**归一化**版本：0 = 光标，1 = 窗口边缘。KC 板的配色分档也用它 ——
// 两边必须用同一个 t，不然颜色分档会跟窗口边缘错开。
float cursorT(vec2 spy, float radius) {
    vec2 d = spy - isoUV(uMouse);
    float wob = (fbm(spy * 1.4 + uSeed * 1.7) - 0.5) * 0.30;
    return clamp(length(d) * (1.0 + wob) / max(radius, 0.02), 0.0, 1.0);
}
float cursorGate(vec2 spy, float radius) {
    return smoothstep(1.0, 0.45, cursorT(spy, radius));   // 对焦那一圈最亮，然后一路渐变到边缘
}

// 点到线段的距离（KC 闪的电路走线靠它算"离这条线多远"）
float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
}

// 覆盖度：遮罩 × 强度，夹到 0..1
float cover(float mask, float strength) { return clamp(mask * strength, 0.0, 1.0); }
`;

  // 每个效果的正文：定义 vec4 effect(vec2 uv)
  const BODY = {};

  // ------------------------------------------------------------ 基础三件 ----

  BODY.base = `
// 直通：原始卡面。draw step 的第一遍永远是它。
vec4 effect(vec2 uv) { return cardTex( uv); }
`;

  BODY.shadow = `
// 投影剪影。uP0.x = 不透明度，uP0.y = 模糊半径（像素）。
// 25 抽样做软边：卡片是方角的，硬投影会在下面留一道黑边。
vec4 effect(vec2 uv) {
    vec2 ts = max(uP0.y, 0.5) / uResolution;
    float a = 0.0;
    for (int j = -2; j <= 2; j++) {
        for (int i = -2; i <= 2; i++) {
            a += cardTex( uv + vec2(float(i), float(j)) * ts).a;
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
// 红=卡名  绿=卡图  蓝=效果框  灰=卡框  黄=卡图外环  橙=星数/阶数带  紫=属性圆
vec4 effect(vec2 uv) {
    vec4 t = cardTex( uv);
    vec4 m = texture(uMask, uv);
    vec2 cu = cardUV(uv);
    float card = pickMask(m, 0.0, uv);
    float frame = pickMask(m, 2.0, uv);
    float inner = rectMask(cu, uRectArtInner, 0.005);
    float text = rectMask(cu, uRectTextBox, 0.005);
    float ring = rectMask(cu, uRectArtOuter, 0.006) * (1.0 - inner);
    float star = pickMask(m, 11.0, uv);
    float attr = pickMask(m, 12.0, uv);
    vec3 c = vec3(0.09);
    c = mix(c, vec3(0.62), frame);
    c = mix(c, vec3(0.25, 1.0, 0.35), inner * 0.75);
    c = mix(c, vec3(0.30, 0.45, 1.0), text * 0.75);
    c = mix(c, vec3(1.0, 0.85, 0.20), ring * 0.85);
    c = mix(c, vec3(1.0, 0.45, 0.08), star * 0.95);   // 橙 = 星数 / 阶数带
    c = mix(c, vec3(0.72, 0.35, 1.0), attr * 0.95);   // 紫 = 属性圆
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
    vec4 tex = cardTex( uv);
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
//   实卡是一整面**极细的平行膜**：倾斜时整片彩虹一起扫过去。
//
// ── 满卡的等距线栅已经去掉了（这里记一笔，免得以后又加回来）────────────────
//   上一版是 d = (spy 在线的法向上的投影) × uP0.y（= 92），
//   line = 0.5 + 0.5*sin(d * TAU)，再把 line 的 uP0.z 次方（= 2.2）乘进光谱 ——
//   于是亮度在 0.45 ~ 1.35 之间摆（**2.8 倍**的明暗差），在卡面上就是**一排等距的横条**。
//   卡片渲染出来只有 400 多像素高，92 个周期 = **6.6px 一根**，正落在眼睛看得清的尺度上：
//   插画、卡框、效果框全糊着横条，用户的原话是"**CRT 扫描线**"。
//   这不是"线画粗了"，是**换错了织构** —— 实卡的膜，线距比屏幕像素细得多，
//   眼睛分辨不出单根线，看到的是"一片会一起扫过去的光"，而不是一根根线。
//
//   现在换成**不规则的拉丝**：把 fbm 压成"跨过线的方向很密、沿着线的方向拉长 13 倍"
//   的各向异性噪声，再按锐度提纯成一根根亮丝。方向感（整片一起扫过去）还在，
//   但**没有周期** —— 既不会有扫描线，也不会随倾斜跟像素栅格打架（摩尔纹）。
//
//   实测（tools/.cache/probe-parallel-lines.mjs：把卡片区的行均值做 DFT，看谱上最高那一根
//   是整条谱中位数的几倍 —— 等距横条会在这条剖面上留下一根极高的谱线）：
//     换之前：**141.7 倍**，峰位正好在 k=74 ≈ 92 周期 × 卡高的 80%（就是那道线栅）
//     换之后：**21.7 倍**
//     对照（把织构整个拿掉、只留缓变色带）：15.7 倍
//   —— 也就是说已经落到"卡面自己内容的谱"上了。
//   同一张探针里其余几项基本没动：卡面均值 168.8 → 170.9、换视角的色相跨度
//   0.913 → 0.907、相对平卡 N 的可见度 29.6 → 27.0。**动的是织构，不是膜的浓淡。**
//
//   uP0 = (强度, 拉丝密度, 拉丝锐度, 暗部增强)
//   uP1 = (色带频率, 视角增益, 线角度(弧度), 遮罩选择)
vec4 effect(vec2 uv) {
    vec4 tex = cardTex( uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 spy = isoUV(cardUV(uv));
    float ca = cos(uP1.z), sa = sin(uP1.z);

    // 拉丝：跨过线方向（ca, sa）很密（uP0.y 就是"每卡高多少根丝"），
    // 沿着线方向（-sa, ca）压到 0.075 —— 于是噪声被拉成一根根细长的丝。
    // 只加 uSeed、不加 uTime：丝是膜自己的织构，不该跟着秒针爬。
    float across = dot(spy, vec2(ca, sa)) * uP0.y;
    float along  = dot(spy, vec2(-sa, ca)) * uP0.y * 0.075;
    float grain = fbm(vec2(across, along) + uSeed * 4.7);
    // 锐度：0.75 是把手上的 2.2 折成 1.65 —— 剩下的那几个常数（0.16 / 1.55 / 0.42 / 1.00）
    // 与上一版对齐过：膜的浓淡不变，只把织构换掉。
    float sheen = pow(clamp((grain - 0.16) * 1.55, 0.0, 1.0), uP0.z * 0.75);

    // 颜色只沿"垂直线的方向"缓慢变化 —— 这是爆闪与别的闪膜最大的观感区别
    float bandPh = (spy.x * (-sa) + spy.y * ca) * uP1.x
                 + uView.x * uP1.y + uView.y * uP1.y * 0.5 + uTime * 0.05;
    vec3 spec = spectrum(bandPh, 1.7);
    spec *= 0.42 + 1.00 * sheen;

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
    vec4 tex = cardTex( uv);
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
    vec4 tex = cardTex( uv);
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
    vec4 tex = cardTex( uv);
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
    vec4 tex = cardTex( uv);
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
    vec4 tex = cardTex( uv);
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
    vec4 tex = cardTex( uv);
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
    vec4 tex = cardTex( uv);
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
//
// ── 这一版做的是一层「电路板」────────────────────────────────────────────
//
//  ⚠️ 上一版是"每格画一段 L 形折线、线头都落在格边中点"—— 结果是一张**满卡的网格**，
//     看着像**迷宫**（用户的原话）。真板子不是这样：
//       ① 一大片地方是**空的**（留白区），铜不是铺满的
//       ② 走线**成组地朝一个方向走**，走很长一段才折一下，而且折角多是 **45°**
//       ③ 一条线上隔一段压一个**过孔**，线头不是满地都是
//     现在按这三条重做：
//       · **方向**来自一个低频噪声，量化成 0°/45°/90°/135° 四档 —— 一整片区域共用
//         一个方向，相邻格自然接成**长直线**；区域交界处才出现转折与端点。
//         （见 boardDir）
//       · "这条线有没有铜"由**垂直于方向的坐标**（车道号）决定，而不是每格随机 ——
//         同一条线上的格子要么都有、要么都没有，所以线是**连着的长线**，不是虚线；
//         有铜的车道只占一部分（uP1.z），于是平行线之间有间距。（见 boardLane）
//       · 线的**尽头**（前面那格没铜、或方向变了）压一个**过孔**。（见下方的 pad）
//       · 少数车道是"电源线"，线宽粗一档 —— 真板子上粗细本来就不一样。
//
// ── 颜色：板子自己是有颜色变化的 ─────────────────────────────────────────
//   底色（板底）用随观察角 + **位置**流动的相位取色（跨卡面约 1.2 个周期，
//   所以一张卡上不同区域的色相本来就不一样）；走线那一层除了角度，还加了
//   **每条车道自己的色相偏移**（±0.11）—— 一条线上下的邻居颜色略有差别，
//   不是"整块板一个色"。走线的光不用 spectrum()（它是"白 ↔ 彩色"来回摆的，
//   细线一白就看不见颜色了），直接取色相、饱和度给下限。
//
// ── 可见窗口：鼠标指到哪儿，那一块附近的电路就显形 ────────────────────────
//   以光标为圆心、半径 0.33 卡高的软斑（≈ 45% 卡面），**中心最亮、往外一路渐变**
//   （见 PRELUDE 的 cursorGate）。分工：**哪儿显形**由鼠标决定，
//   **什么颜色**由观察角决定 —— 转卡时显形那一块里的线在变色。
//   KC 标已按要求去掉，这一层只剩电路。
//
//   uP0 = (强度, 电路网格尺寸, 走线半宽, **可见半径**)
//   uP1 = (视角增益, 色相频率, **走线疏密阈值**, 遮罩选择)
//   uP2 = (**留白阈值**, ·, ·, ·)
//
// 板子的几个查询函数（都按"格号"取值，所以相邻格之间是连续的）：
//   方向：低频噪声量化成 4 档 → 一整片区域一个走向
//   ⚠️ 两个频率都别调太低：方向区域比卡面还大时整张卡只有一个走向；
//      留白斑块太大时更糟 —— 鼠标一放到斑块中间就**整片空白**、只剩底膜，
//      看着像"这一层坏了"（0.07 那一版就是这样）。
vec2 boardDir(vec2 id, vec2 off, float freq) {
    float a = floor(vnoise((id + off) * freq + uSeed * 3.1) * 4.0) * 0.7853982;
    return vec2(cos(a), sin(a));
}
//   车道号：**垂直于方向**的坐标 —— 同一条线上的格子编号相同，
//   于是"这条线有没有铜"可以整条线一起决定（线才是连着的长线，不是虚线）
float boardLane(vec2 id, vec2 dv) {
    return floor(dot(id, vec2(-dv.y, dv.x)) * 1.41421356 + 0.5);
}
//   留白：更低频的场，成片的地方没有铜（真板子上一大片是空的）
float boardZone(vec2 id, vec2 off, float freq) {
    return vnoise((id + off) * freq + 19.3 + uSeed);
}
/*
 * 带**段量化**的留白场 —— 这是"线条断开"的修法。
 *
 * 原来每一格都拿 boardZone(id) 重新判一次"这儿有没有铜"，于是同一条车道
 * 在噪声过阈值的地方会一格格断掉：线本来该是一条长走线，看着却是一截一截的
 * 虚线（用户报的就是这个）。
 *
 * 现在把**沿走线方向**的坐标量化成 SEG 格一段，整段共用同一个采样点
 * （垂距不变、只把"顺着方向走了多远"退回到段中点）—— 于是一条线至少连着 SEG 格，
 * 端点只会出现在"段与段的交界"和"方向变了"这两处，而那两处本来就要压过孔。
 * 垂直方向该怎么变还怎么变，所以留白仍然是一片一片的，不会变成整齐的条带。
 */
const float ZONE_SEG = 6.0;
float boardZoneSeg(vec2 id, vec2 dv, vec2 off, float freq) {
    float along = dot(id, dv);
    vec2 perp = id - dv * along;                       // 沿车道不变的那一半
    float seg = floor(along / ZONE_SEG) * ZONE_SEG;    // 量化到段首
    return boardZone(perp + dv * (seg + ZONE_SEG * 0.5), off, freq);
}
/*
 * 一层铜。返回 (走线, 过孔)。
 *
 * 整个图案画**两遍**（见 effect 里的 A / B）：两层的方向场、疏密、线宽都不一样，
 * 叠在一起才有真板子那种"复杂"感 —— 单层永远是一组平行线，层次不够。
 * laneSeed 让两层的车道随机数互相独立（不然两层会在同样的位置上开/关）。
 */
vec2 boardLayer(vec2 id, vec2 f, vec2 off, float dirF, float zoneF,
                float laneTh, float zoneTh, float hwIn, float laneSeed) {
    vec2 dv = boardDir(id, off, dirF);
    vec2 stepv = vec2(sign(dv.x), sign(dv.y));       // 顺着方向走一格（±1）
    float lane = boardLane(id, dv);
    // 这条车道有没有铜：整条线一起决定（所以线是连着的长线，不是虚线）
    float laneOn = step(laneTh, hash21(vec2(lane + laneSeed, 21.3) + uSeed));
    // 留白用**量化版**：沿走线方向每 ZONE_SEG 格才重判一次，
    // 所以一条线至少连着 ZONE_SEG 格（不然每格重抽会把线切成虚线，见 boardZoneSeg）
    float zoneOn = step(zoneTh, boardZoneSeg(id, dv, off, zoneF));
    float has = laneOn * zoneOn;
    // 少数车道是"电源线"，粗一档 —— 真板子上粗细本来就不一样
    float wmul = mix(1.0, 1.8, step(0.82, hash21(vec2(lane + laneSeed, 5.1) + uSeed)));
    float hwv = hwIn * wmul;

    float sd = dot(f, vec2(-dv.y, dv.x));            // 到走线中心线的垂距
    float trace = smoothstep(hwv, hwv * 0.45, abs(sd)) * has;

    // 线的**尽头**压过孔：顺着方向问一格 —— 那格没铜、或者方向变了，就在这一头收口。
    // 收口的位置 = 线出格的地方（轴方向是格边中点，45° 方向是格角）
    float nf = step(zoneTh, boardZoneSeg(id + stepv, dv, off, zoneF))
             * step(0.9, dot(boardDir(id + stepv, off, dirF), dv));
    float nb = step(zoneTh, boardZoneSeg(id - stepv, dv, off, zoneF))
             * step(0.9, dot(boardDir(id - stepv, off, dirF), dv));
    vec2 ex = 0.5 * dv / max(abs(dv.x), abs(dv.y));
    float pr = hwv * 1.6;                            // 过孔半径（比线宽粗一圈）
    float pad = max(smoothstep(pr, pr * 0.45, length(f - ex)) * (1.0 - nf),
                    smoothstep(pr, pr * 0.45, length(f + ex)) * (1.0 - nb)) * has;
    return vec2(trace, pad);
}

/*
 * 电路板的配色：**蓝 → 绿 → 黄 → 橙 → 红**，按到光标的距离**连续过渡**。
 *
 * ⚠️ 三版都踩过坑，记清楚免得又走回去：
 *   ① 第一版在 RGB 里**硬选**四色（floor + step）：颜色是对的，但卡面上一圈一圈的
 *      硬边 —— 用户的原话是"过渡太粗糙，直接就蓝色变黄色"。
 *   ② 在 RGB 里**直接插值**也不行：蓝↔黄的中点是**灰的**，整条带子会脏掉。
 *   ③ 改成在色相上**均分**插值：过渡是顺了，但蓝只在**正中心一个点**上 ——
 *      色相上"蓝→绿"跨了 0.263、"橙→红"才 0.064，均分的话稍微往外一点就已经是青绿
 *      （实测中心那一档的平均色相是 0.427 = 绿）。用户要的是"中间一片蓝"。
 *
 * 现在：色相在 [0,1] 上**分段线性**，锚点的位置**不均分**，蓝和红各留一段平台：
 *      k      0 ──── 0.26 ──── 0.50 ──── 0.70 ──── 0.87 ──── 1.0
 *      h     .593   .593      .330      .195      .077      .013
 *            蓝      蓝        绿        黄        橙        红
 *   平台是给"光标那一池蓝"和"边缘那一圈红"留的地方，中间四段才是渐变。
 *   每段内是**线性**的（不用 smoothstep）—— 用 smoothstep 会让五个锚点各自"停一下"，
 *   又变成五条带子了。
 *
 * k：0 = 光标（蓝），1 = 窗口边缘（红，快看不见了）。
 */
vec3 boardPalette(float k) {
    float kk = clamp(k, 0.0, 1.0);
    // 分段线性：每段只在 [a,b] 里生效，段外是 0/1，所以互不干扰
    float h = 0.593;                                        // 0.00 蓝
    h = mix(h, 0.330, clamp((kk - 0.26) / 0.24, 0.0, 1.0)); // 0.50 绿
    h = mix(h, 0.195, clamp((kk - 0.50) / 0.20, 0.0, 1.0)); // 0.70 黄
    h = mix(h, 0.077, clamp((kk - 0.70) / 0.17, 0.0, 1.0)); // 0.87 橙
    h = mix(h, 0.013, clamp((kk - 0.87) / 0.13, 0.0, 1.0)); // 1.00 红
    // 饱和度沿半径起伏一点（中段最饱和、两端略收）：均匀的彩虹在红端会显得比蓝端重
    float arc = sin(kk * 3.14159265);
    return hsv2rgb(vec3(h, 0.80 + 0.12 * arc, 1.0));
}

/*
 * 四层铜合起来 —— **effect 与调试探针共用这一个入口**。
 *
 * 单独抽出来是为了"只有一份层参数"：tools/.cache/probe-board.mjs 会把 effect 之前的
 * 所有内容切走、再挂一个只画几何的 effect。层参数如果写在 effect 里，探针就得手抄
 * 一遍 —— 抄过一次，改了方向场频率之后探针还画着旧几何，白看半天。
 *
 * 返回 (走线, 过孔)。
 */
vec2 boardCopper(vec2 id, vec2 f, float hw, float laneTh, float zoneTh) {
    // A/B 是原来那两层；C/D 是后加的一对 —— 铜层 2 → 4，板子的复杂度翻一倍。
    // 四层的**方向场、留白场、疏密、线宽**全都不同，叠起来既有交叉又有层次；
    // 顺带把原来"一大片全空"的地方填上（每层的留白场不一样，一片空不等于四层都空）。
    //
    // ⚠️ 方向场的频率**调低了一半**（0.28→0.14 等）。原来频率太高，方向场每隔两三格
    //    就跨过一个量化档 → 走线动不动就拐 45°/90°，再被"方向变了就在线头压过孔"
    //    那条规则盖上过孔 —— 看着就是**一截一截的短线**（用户报的"线条断开的"
    //    其实就是这个，不是留白那一层）。频率降下来之后一整片区域共用一个走向，
    //    走线能连着跑十几格，才像板子上的"街道"。
    vec2 A = boardLayer(id, f, vec2(0.0, 0.0),   0.14, 0.30, laneTh,        zoneTh,        hw,        0.0);
    vec2 B = boardLayer(id, f, vec2(3.7, 11.3),  0.11, 0.26, 0.66,          zoneTh + 0.10, hw * 0.68, 37.0);
    vec2 C = boardLayer(id, f, vec2(7.3, 2.9),   0.17, 0.22, laneTh + 0.24, zoneTh - 0.03, hw * 0.82, 71.0);
    vec2 D = boardLayer(id, f, vec2(12.1, 5.5),  0.09, 0.38, 0.76,          zoneTh + 0.14, hw * 0.58, 113.0);
    return vec2(max(max(A.x, B.x), max(C.x, D.x)),
                max(max(A.y, B.y), max(C.y, D.y)));
}

vec4 effect(vec2 uv) {
    vec4 tex = cardTex( uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 cu = cardUV(uv);
    vec2 spy = isoUV(cu);

    // ---- 可见窗口：以光标为圆心、中心最亮往外渐变的软斑 ----
    //   ct 是**归一化距离**（0 = 光标，1 = 窗口边缘），窗口和配色共用它
    float ct = cursorT(spy, uP0.w);
    float gate = smoothstep(1.0, 0.30, ct);          // 对焦那一圈最亮，然后一路渐变到边缘

    // ---- 走线：四层铜 ----
    // 格子在 iso 坐标里是**方的**（isoGrid 而不是 squareGrid —— 后者会把图案压扁，
    // 圆过孔会被拉成椭圆，见文件上方 isoGrid 的注释）。
    vec2 g = isoGrid(cu, max(uP0.y, 0.02));
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float hw = clamp(uP0.z, 0.010, 0.40);            // 走线半宽（单位：格）

    // A/B 是原来那两层；C/D 是这次加的一对 —— 层参数在 boardCopper 里（探针共用那份）
    vec2 copper = boardCopper(id, f, hw, uP1.z, uP2.x);
    float trace = copper.x;
    float pad = copper.y;

    // ---- 显色：板底一层暗箔，走线是**调色板里的彩色铜** ----
    // 颜色 = **到光标的距离**，在**蓝 → 绿 → 黄 → 橙 → 红**之间连续过渡
    //（见 boardPalette：色相上线性插值，所以是一条真正的渐变，不是五条色带）。
    // 用的是和窗口同一个 ct，所以"红的那一圈"正好落在渐隐的地方 —— 用户要的
    // "边缘快要看不到的红色"。再加一点点视角漂移（uP1.y），免得鼠标停着时完全死板。
    float pal = clamp(ct + (uView.x * 0.05 + uView.y * 0.04) * clamp(uP1.y, 0.0, 2.0), 0.0, 1.0);
    // 板底：调色板里的颜色当底，但**要压暗 + 降饱和**。
    //   ⚠️ 这里踩过一次：板底和走线原来是**同一个颜色**（都取 boardPalette(pal)，
    //      而 pal 只跟到光标的距离有关）—— 结果同一个半径上底和线一模一样，
    //      图案整个读不出来，只剩一坨蓝斑。现在把底压到 0.60 的混色、亮度也降下来，
    //      走线才是那块板上唯一"亮起来"的东西。
    vec3 tint = mix(vec3(1.0), boardPalette(pal), 0.70);
    vec3 col = overlaySpec(tex.rgb, tint * (0.28 + 0.14 * trace), 0.40);
    // ⚠️ 走线**不能用加法叠**（实测）：加法加在亮的插画上会一路白掉，四个颜色全变成
    //    粉白 —— 用户要的就是"蓝黄橙红"，白掉就白做了。所以走线是**用彩色铜替掉底色**
    //    （mix 进去），再补一点点自己的光。铜的明暗跟着印刷走（印得亮的线更亮）。
    vec3 lineCol = boardPalette(pal);
    vec3 metal = lineCol * (0.62 + 0.85 * luma(tex.rgb));
    col = mix(col, metal, clamp(trace * 0.94 + pad * 0.96, 0.0, 1.0));
    col += lineCol * (trace * 0.16 + pad * 0.22) * (0.35 + 0.65 * (1.0 - luma(tex.rgb)));

    // 覆盖度里乘上窗口：窗口外这一层**什么都不画**（alpha=0），底下的金闪原样留着
    return vec4(col, tex.a * cover(region, uP0.x) * gate);
}
`;

  BODY.millennium = `
// 千年闪（Millennium Rare）。实卡是"埃及文字图案"的闪膜。
//   这里用图集下排那 4 个象形字（安卡 / 荷鲁斯之眼 / 王名圈 / 水波鸟）按格随机拼，
//   是**风格化近似**，不是真·圣书体字形（见 README 的"已知取舍"）。
//
//   uP0 = (强度, 可见窗口半宽, 字形强度, 字形密度)
//   uP1 = (视角增益, ·, ·, 遮罩选择)
//   uP2 = (金点强度, 金点密度, 金点尺寸, ·)
//
// ── 竖线已经去掉了（这里记一笔，免得以后又加回来）────────────────────────
//   上一版在字与字之间画了一道竖线，说是"文字带"。那道线的基因其实是从 kc 闪那边
//   抄来的**线光栅**（0.5 + 0.5*sin(spy.x * 密度 * TAU)）—— 而实卡的千年图案是
//   一层**图案膜**，不是**线栅膜**：整卡铺满竖条之后，插画、卡框、效果框全糊着
//   竖纹，跟实卡那种"一格一个字"的图案根本不是一回事。现在这一层只剩象形字，
//   位置参数 uP0.y 也从"竖线半宽"改成了"可见窗口半宽"。
//
// ── 任何一个角度都看不到完整的图案（≤25%）────────────────────────────────
//   组相位用 filmField（斜向波场）：观察角给出选择相位，只有距它小于半宽的地方显形，
//   也就是**一条会随视角滑动的波带**扫过整片图案 —— 一批字亮、一批字灭，
//   永远看不到整片。半宽 0.100 ⇒ 任何角度最多 20% 的字亮着
//   （angleGate 里再夹一道 0.125 = 25% 的硬上限；扫满 81 个视角实测 7.0% ~ 21.7%）。
//
//   ⚠️ 中间试过"每个字自己一个随机相位"（想着像灯的开关那样一个一个亮），
//      量出来不行：40 来个大格子的随机相位，分布是**三角形**的而不是均匀的，
//      于是换角度时亮着的比例从 2% 摆到 28% —— 有的角度几乎看不见图案。
//      这是实测（tools/.cache/probe-films.mjs）换掉的，不是拍脑袋。
//
// ── 金点（辅助层，刻意不能喧宾夺主）──────────────────────────────────────
//   整卡撒一层很小的金点，颜色跟着观察角流动（不是死金色）。
//   它**不参与**上面那道 25% 的窗口 —— 要的是"整张卡上都有一点"，
//   所以它自己带一个很小的权重，合成时：
//     颜色 = 两个贡献的**加权平均**，alpha = 两者的较大值，
//   于是金点只在卡面上添一点点暖光，不会把象形字盖掉。
//
// ── 格子按像素等比（这是"图案宽度被压缩"的根）────────────────────────────
//   用 isoGrid 而不是 squareGrid：后者是「cu.x / uAspect」，除以长宽比等于把 x
//   又压扁一次，格子实际是 1 : 2.17 的瘦高条，贴上去的字被横向压扁。
vec4 effect(vec2 uv) {
    vec4 tex = cardTex( uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.w, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 cu = cardUV(uv);
    vec2 spy = isoUV(cu);

    float sel = angleSel(1.15);

    // ---- 象形字：一格一个字，四种字形按格随机挑 ----
    vec2 g = isoGrid(cu, max(uP0.w, 0.02));
    vec2 id = floor(g);
    vec2 f = fract(g);
    // 随机镜像，否则一眼就能看出来是一格一格的重复
    if (hash21(id + 11.3) > 0.5) f.x = 1.0 - f.x;
    if (hash21(id + 23.7) > 0.5) f.y = 1.0 - f.y;
    float pick = floor(hash21(id + uSeed) * 4.0);
    float glyph = stampAt(vec2(pick, 1.0), f);

    // 角度窗口：只有落在波带里的那些字显形（波带边上的字是半亮的，边缘就毛了）
    float gate = angleGate(filmField(spy), sel, uP0.y, 0.55);

    // ---- 字面 / 底子各是一层箔，相位错开，颜色随视角流动 ----
    float ph = (spy.x * 0.5 + spy.y * 0.3) + uView.x * uP1.x
             + uView.y * uP1.x * 0.5 + uTime * 0.035;
    float gph = ph + 0.30 + (hash21(id + 41.7) - 0.5) * 0.26;
    vec3 spec = spectrum(ph, 1.3);
    // 字内**替换**底子的色（不是叠一层白），边缘靠 stamp 自带的软过渡混
    spec = mix(spec, spectrum(gph, 1.05), clamp(glyph * uP0.z, 0.0, 1.0));
    vec3 film = overlaySpec(tex.rgb, spec, 0.30);
    // ⚠️ 字形还要**自己亮一下**：只靠 overlaySpec 那个乘法项（底色 × 光谱），字形在
    //    花花绿绿的插画上会被图案本身吃掉 —— 和 KC 闪的走线是同一个坑（那边逐像素
    //    扫出来 Δ 只有 ±7，看着就是"蒙了层膜、看不出线"）。同样按"印得越暗越显色"补一层。
    film += spectrum(gph, 1.05) * glyph * 0.26 * (0.45 + 0.55 * (1.0 - luma(tex.rgb)));

    // ---- 金点：全图撒的小点，颜色跟着角度走 ----
    vec2 sg = isoGrid(cu, 1.0 / max(uP2.y, 1.0));      // 密度 = 一个卡高里几行点
    vec2 sid = floor(sg);
    vec2 sf = fract(sg);
    vec2 sc = vec2(hash21(sid + 1.7 + uSeed), hash21(sid + 3.1 + uSeed));
    float speck = smoothstep(max(uP2.z, 0.02), 0.0, length(sf - sc));
    // 金点的色：**金色打底**，色相跟着观察角（+ 每点自己的随机相位）流动。
    // 写成"金 × 光谱"而不是"金 ↔ 光谱"：直接混太多光谱会让金点变成粉点 / 紫点
    // —— 第一版就是这样，卡片上撒了一层粉点，看着不像金。
    vec3 goldCol = uCol.rgb * mix(vec3(1.0), spectrum(sel * 1.7 + hash21(sid + 5.5) * 0.25, 1.2), 0.35);
    // 印刷暗的地方金点更显（闪箔本来就是暗处显色），亮的地方几乎看不出来
    vec3 gold = tex.rgb + goldCol * (0.30 + 0.70 * (1.0 - luma(tex.rgb))) * 0.9;

    // 两个贡献按权重合成：膜受 25% 窗口限制，金点不受、但权重刻意压得很小
    float wFilm = gate;
    float wGold = speck * clamp(uP2.x, 0.0, 2.0) * 0.55;
    float wSum = wFilm + wGold;
    vec3 col = (film * wFilm + gold * wGold) / max(wSum, 1e-4);
    return vec4(col, tex.a * cover(region, uP0.x) * min(wSum, 1.0));
}
`;

  BODY.stamp = `
// 周年水印（20th SER 的 "20th" / QCScR 的 "25th"）
//   uP0 = (强度, 平铺尺寸, 保留, 遮罩选择)
//   uP1 = (图集格 x, 图集格 y, 保留, 保留)
//   uP2 = (偏移 x, 偏移 y, 保留, 保留)
vec4 effect(vec2 uv) {
    vec4 tex = cardTex( uv);
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
    vec4 tex = cardTex( uv);
    vec4 m = texture(uMask, uv);
    float region = pickMask(m, uP1.x, uv);
    if (region < 0.004) return vec4(tex.rgb, 0.0);

    vec2 ts = 1.0 / uResolution;
    float sc = uP1.y;
    float hl = luma(cardTex( uv - vec2(ts.x, 0.0)).rgb);
    float hr = luma(cardTex( uv + vec2(ts.x, 0.0)).rgb);
    float hu = luma(cardTex( uv - vec2(0.0, ts.y)).rgb);
    float hd = luma(cardTex( uv + vec2(0.0, ts.y)).rgb);
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
//   怪兽像"幽灵"一样浮出来，倾斜时有一层冷色彩虹。
//
// ── 只作用在怪物图框里（不再是整张卡）────────────────────────────────────
//   遮罩交给配方（HR 用 SEL.ART = 卡图/怪物区）—— 于是卡框、卡名、效果框还是
//   原来的印刷，只有插画变成银白幽灵。实卡的鬼闪本来也是**插画那一片**在做浮雕感，
//   整卡一起变银白会把卡框和效果框的印刷也吃掉，看着像一张没印好的卡。
//   （遮罩是 uP1.x，别的工艺大多把遮罩放在 uP1.w —— 这里保持原样，改的是配方传的值）
//
// ── 某些角度会"从鬼闪滑向面闪" ───────────────────────────────────────────
//   这是这一版新加的：相位由**观察角**驱动，sin 的波峰附近才是"面闪时刻" ——
//   那一段里整片幽灵换成面闪那一套膜（宽光带 + 域扭曲 + 细颗粒，参数与 BODY.holo
//   同一路），其余角度是纯鬼闪。所以捏着卡慢慢转，会看到它一会儿是鬼闪、
//   某个角度忽然变成面闪那样的彩虹，再转回来。平方（pow 2）是为了让"面闪时刻"
//   窄一点，不然一半的角度都停在中间的混合态上。
//
//   uP0 = (强度, 幽灵彩虹强度, 对比度, 辉光)
//   uP1 = (遮罩选择, 面闪混合强度, 面闪花纹尺度, 面闪相位偏移)
//   uP2 = (面闪的角度增益, 面闪的流动速度, ·, ·)
vec4 effect(vec2 uv) {
    vec4 tex = cardTex( uv);
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
    vec3 ghost = silver + spec * glow * uP0.y + vec3(glow * 0.30);

    // ---- "面闪时刻"：某些角度整片换成面闪那一套膜 ----
    float hb = pow(0.5 + 0.5 * sin((uView.x * uP2.x + uView.y * uP2.x * 0.7
                                  + uTime * uP2.y) * TAU + uP1.w), 2.0)
             * clamp(uP1.y, 0.0, 1.0);
    // 与 BODY.holo 同一路：域扭曲的宽光带 + 膜自己的细颗粒
    float hwarp = (fbm(spy * uP1.z + uSeed) - 0.5) * 0.55;
    float hph = (spy.x * 0.95 + spy.y * 0.62) * 0.9 + hwarp
              + uView.x * 1.35 + uView.y * 1.35 * 0.62 + uTime * uP2.y * 3.0;
    vec3 hspec = spectrum(hph, 3.0) * (0.82 + 0.36 * vnoise(spy * 260.0 + uSeed));
    vec3 holo = overlaySpec(tex.rgb, hspec, 0.55);

    vec3 col = mix(ghost, holo, hb);

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
    vec4 tex = cardTex( uv);
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
    vec4 tex = cardTex( uv);
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
    vec4 tex = cardTex( uv);
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





