/*
 * bake.js —— 卡图烘焙核心：**唯一的定义**
 *
 * 把一张解码好的卡图变成着色器要的两张纹理：
 *   ① card  —— 卡面本体（= 整张原图，只按 cornerPx 削圆角 alpha）
 *   ② mask  —— 工艺区域掩膜
 *        R = 卡名笔画（Otsu 自动分割 + 自动判极性，再膨胀 dilate 次）
 *        G = 卡图内容区（插画本身，不含四周深色框）
 *        B = 效果框（含 ATK/DEF 带）
 *        A = **卡片自身的剪影**（卡内处处为 1）
 *      "卡框"与"卡图外环"不进掩膜，由着色器按 regions.artOuter / artInner 现算 ——
 *      原因是 canvas 的像素是预乘 alpha 存的，把卡框掩膜放进 alpha 通道会让卡图窗与
 *      效果框那两块的 G/B 在反预乘时被除以 0 抹掉（见 js/shaders.js 的 pickMask）。
 *
 * 这一份被两处共用：
 *   · index.html 直接 <script> 引入 —— 参数面板「卡图」左边那个 ⟳ 刷新按钮
 *     就是用它**在浏览器里当场烤**，于是新丢进 images/ 的图不用跑 node 也能出来
 *   · tools/embed-card.mjs —— 通过 tools/lib/bake.mjs 读文件文本、在页面里 eval，
 *     逐张烤完写成 js/card-textures.js
 * 所以这里**必须是经典脚本**（不能有 import/export），而且只依赖：
 *   · js/detect.js 的 global.CardDetect.detectCardRect
 *   · canvas 2D
 * 工具那边会把两份源码都注入页面，保证"工具烤的"和"页面烤的"是同一套算法。
 *
 * ── 为什么整张原图当卡面 ────────────────────────────────────────────────
 * 之前的做法是"自动识别卡片外沿 → 裁出来 → 缩到 1024 高 → 四周补 4% 留白"。
 * 但融合紫框 / 超量黑框这两张的卡沿和背景几乎同色，外沿被内部边（效果框那条横线）
 * 抢走，卡片下沿连同原图那条很有质感的黑边整条被裁掉，shader 的卡图窗跟着上移 25px。
 * 原图本来就是**成品**：813×1185、四边 26px 居中留白、边缘自带黑边。直接用整张就行。
 * 外沿检测仍然跑，但**只用来把"卡片相对"的区域常量映射到整图坐标**（见 §1），
 * 不再决定裁到哪儿 —— 检测准不准都不影响画面完整性，只影响掩膜区域贴得准不准。
 */
(function (global) {
  'use strict';

  // 区域（**卡片相对**比例，0..1；v=0 是卡片上沿，与 LÖVE 的纹理坐标约定一致）
  var REGIONS = {
    // 卡名带：只用来框住"去哪儿找字"，实际笔画靠暗度抠
    nameBand:   { x0: 0.030, y0: 0.020, x1: 0.848, y1: 0.088 },
    // 卡图窗（外框，含卡图四周那圈深色框）
    artOuter:   { x0: 0.0736, y0: 0.1520, x1: 0.9277, y1: 0.7280 },
    // 卡图窗（内，插画本身）
    // y0 由 0.1751 改成 0.1580：实测插画内容的上沿在整图 y=205
    //（深色插画框 luma 46 → 插画 93 的那一跳），换算成卡片相对就是 0.1580。
    // 旧值 0.1751 对应 y=224，**比插画起点低 19px** —— 于是"卡图窗"那层闪膜盖不住
    // 插画最上面那一条，约占卡图窗高的 2.9%（"怪物头上缺一条"就是这么来的）。
    // 其余三边实测差 ≤ 2px（下沿 837/835、右沿 718/716），没动。
    artInner:   { x0: 0.0920, y0: 0.1580, x1: 0.9093, y1: 0.7162 },
    // 效果框（含 ATK/DEF 带）
    textBox:    { x0: 0.0380, y0: 0.7533, x1: 0.9620, y1: 0.9806 },
    // 等级星带（给"星闪"之类的按带加工用）
    starBand:   { x0: 0.0400, y0: 0.1000, x1: 0.9600, y1: 0.1520 }
  };

  // 抠卡名笔画的参数。
  //   auto:true  —— **自动**判极性 + 自动定阈值（默认，见下面"卡名笔画"那一段）
  //   auto:false —— 退回 lo/hi 这两个**绝对**灰度阈值，口径是"暗 = 笔画"
  //                 只给自动模式栽掉的怪卡手工兜底用，写进 CARDS[文件名].nameInk
  //   ramp       —— 阈值两侧的软过渡半宽（灰度 0..1）。字缘要利落，别铺太宽
  //   dilate     —— 笔画膨胀次数（1 次 = 3×3 取最大，约 1px）
  var NAME_INK = { auto: true, lo: 0.62, hi: 0.80, ramp: 0.045, dilate: 2 };

  var FORMAT = 'image/webp';
  var QUALITY = 0.95;
  var MARGIN = 0;              // 纹理四周留白。0 = 原图即卡面

  function merge(base, over) {
    var o = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) o[k] = base[k];
    if (over) for (var j in over) if (Object.prototype.hasOwnProperty.call(over, j)) o[j] = over[j];
    return o;
  }

  function canvasOf(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /**
   * 烤一张卡。
   *
   * @param src 已解码的图（HTMLImageElement / HTMLCanvasElement / ImageBitmap）
   *            **data URI 或同源 URL 才干净** —— file:// 下用本地文件路径当 src
   *            会让 canvas 变"脏"，getImageData 直接抛 SecurityError。
   * @param opts {
   *   regions:       局部覆盖（缺的键用 REGIONS）
   *   nameInk:       局部覆盖（缺的键用 NAME_INK）
   *   cornerPx:      圆角半径（原图像素），默认 0 = 不削
   *   cornerRadius:  给了就按原图宽度的比例覆盖 cornerPx（工具 --corner 的旧口径）
   *   format, quality, margin
   * }
   * @returns 与 js/card-textures.js 一条记录同形的对象（不含 id/file/sha256）
   */
  function bakeCard(src, opts) {
    opts = opts || {};
    var regions = merge(REGIONS, opts.regions);
    var nameInk = merge(NAME_INK, opts.nameInk);
    var FORMAT_ = opts.format || FORMAT;
    var QUALITY_ = opts.quality == null ? QUALITY : opts.quality;
    var MARGIN_ = opts.margin == null ? MARGIN : opts.margin;
    var CORNER_PX = opts.cornerPx == null ? 0 : opts.cornerPx;

    var W = src.naturalWidth || src.width;
    var H = src.naturalHeight || src.height;

    var srcCv = canvasOf(W, H);
    var sctx = srcCv.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(src, 0, 0);
    var sp = sctx.getImageData(0, 0, W, H).data;

    // ---- 0. 自动找卡片外沿（算法在 js/detect.js，与 verify 共用同一份）----
    var det = global.CardDetect.detectCardRect(sp, W, H);
    var CARD = det.rect;
    var detected = det.detected;

    var cw0 = CARD.x1 - CARD.x0, ch0 = CARD.y1 - CARD.y0;
    var aspect = cw0 / ch0;

    // ---- 1. 卡面 = 整张原图；区域常量换算到整图坐标 ----
    // 着色器里的 cardUV 是"纹理 0..1"，所以区域常量必须落在**整图**坐标系里。
    // 卡片在整图里的位置由检测到的 CARD 给出，逐区域线性映射过去即可。
    var dw = W, dh = H;                  // 内容 = 整图
    var texW = W, texH = H;              // 纹理 = 内容（MARGIN = 0）
    var ox = 0, oy = 0;
    var mapped = {};
    for (var key in regions) {
      if (!Object.prototype.hasOwnProperty.call(regions, key)) continue;
      var r0 = regions[key];
      mapped[key] = {
        x0: (CARD.x0 + r0.x0 * cw0) / W, y0: (CARD.y0 + r0.y0 * ch0) / H,
        x1: (CARD.x0 + r0.x1 * cw0) / W, y1: (CARD.y0 + r0.y1 * ch0) / H
      };
    }

    // ---- 2. 卡面本体：整图原样画上去（随后只削圆角 alpha）----
    var cardCv = canvasOf(dw, dh);
    var cctx = cardCv.getContext('2d', { willReadFrequently: true });
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(srcCv, 0, 0);

    // ---- 3. 圆角 ----
    // 原图是方角的（自带黑边），这里按 cornerPx 削一个圆角，接近实体卡的倒角观感。
    // 只改 alpha 通道、不动 RGB，所以圆角处不会渗出黑边或白边。
    //
    // 注意：圆角**已经挪到运行时**了（参数面板「卡片圆角 (px)」→ uCardRound uniform），
    // 所以默认给 0（不削）。只有"要把圆角焊死在纹理里"的少数场合才传非 0。
    var cornerPx = CORNER_PX, cornerSrc = 'flag';
    if (opts.cornerRadius !== undefined && opts.cornerRadius !== null) {
      cornerPx = Math.round(dw * opts.cornerRadius); cornerSrc = 'override';
    }
    cornerPx = Math.max(0, Math.min(Math.round(cornerPx), Math.floor(Math.min(dw, dh) / 2)));

    var rr = canvasOf(dw, dh);
    var rctx = rr.getContext('2d');
    if (cornerPx > 0) {
      rctx.fillStyle = '#fff';
      rctx.beginPath();
      if (rctx.roundRect) rctx.roundRect(0, 0, dw, dh, cornerPx);
      else {
        rctx.moveTo(cornerPx, 0); rctx.lineTo(dw - cornerPx, 0); rctx.quadraticCurveTo(dw, 0, dw, cornerPx);
        rctx.lineTo(dw, dh - cornerPx); rctx.quadraticCurveTo(dw, dh, dw - cornerPx, dh);
        rctx.lineTo(cornerPx, dh); rctx.quadraticCurveTo(0, dh, 0, dh - cornerPx);
        rctx.lineTo(0, cornerPx); rctx.quadraticCurveTo(0, 0, cornerPx, 0); rctx.closePath();
      }
      rctx.fill();
      cctx.globalCompositeOperation = 'destination-in';
      cctx.drawImage(rr, 0, 0);
      cctx.globalCompositeOperation = 'source-over';
    }

    var tex = canvasOf(texW, texH);
    var tctx = tex.getContext('2d');
    tctx.drawImage(cardCv, ox, oy);

    // ---- 4. 掩膜 ----
    var mv = canvasOf(dw, dh);
    var mctx = mv.getContext('2d', { willReadFrequently: true });
    var cp = cctx.getImageData(0, 0, dw, dh).data;

    var rectPx = function (r) { return { x0: r.x0 * dw, y0: r.y0 * dh, x1: r.x1 * dw, y1: r.y1 * dh }; };
    var R = {};
    for (var k2 in mapped) if (Object.prototype.hasOwnProperty.call(mapped, k2)) R[k2] = rectPx(mapped[k2]);

    // ---- 卡名笔画 ----
    // 卡名带的**底色就是卡框色**，而游戏王这一点花色极多，字色还跟着一起变：
    //   橙(效果) / 紫(融合) / 蓝(仪式) / 白(同调) / 深蓝(连接) → 深字浅底
    //   黑(超量)                                              → **白字黑底，极性相反**
    // 所以"暗 = 笔画"这种固定阈值**原理上就不可能通用** —— 实测橙框 luma≈0.60、
    // 蓝框≈0.29、黑框≈0.05，全部低于旧阈值 lo=0.62，整条名带被判成笔画。
    //（tools/verify.mjs 的 C 段正是这么抓到的：笔画 40180px = 名带全满，底板 0px。）
    //
    // 现在改成两步自适应，不依赖任何绝对灰度：
    //   ① Otsu 在名带灰度直方图上找类间方差最大的阈值；
    //   ② **像素少的那一类算笔画**（字永远只占名带一小块），极性由两类平均亮度决定
    //      （暗的那类少 → 深字浅底；亮的那类少 → 白字黑底）。
    // 自动模式仍可能栽在"名带里有两块面积相当的深浅区域"的怪图上（比如金碎那种
    // 强金属渐变把直方图摊平）。那种卡用 CARDS[文件名].nameInk = { auto:false, lo, hi } 钉死。
    var ink = new Uint8Array(dw * dh);
    var nb = R.nameBand;
    var bx0 = Math.max(0, Math.floor(nb.x0)), bx1 = Math.min(dw, Math.ceil(nb.x1));
    var by0 = Math.max(0, Math.floor(nb.y0)), by1 = Math.min(dh, Math.ceil(nb.y1));

    var inkIsDark = true, otsuL = 0.71;
    var inkStats = { mode: nameInk.auto ? 'auto' : 'fixed' };

    if (nameInk.auto) {
      var hist = new Float64Array(256);
      var bandN = 0;
      for (var y1 = by0; y1 < by1; y1++) for (var x1 = bx0; x1 < bx1; x1++) {
        var i1 = (y1 * dw + x1) << 2;
        if (cp[i1 + 3] < 8) continue;
        var l1 = (0.2126 * cp[i1] + 0.7152 * cp[i1 + 1] + 0.0722 * cp[i1 + 2]) / 255;
        hist[Math.max(0, Math.min(255, Math.round(l1 * 255)))]++;
        bandN++;
      }
      var total = 0;
      for (var k3 = 0; k3 < 256; k3++) total += k3 * hist[k3];
      // Otsu：让两类之间方差最大的那个灰度
      var wB = 0, sumB = 0, bestVar = -1, best = 128;
      for (var k4 = 0; k4 < 256; k4++) {
        wB += hist[k4];
        if (wB === 0) continue;
        var wF = bandN - wB;
        if (wF === 0) break;
        sumB += k4 * hist[k4];
        var mB = sumB / wB, mF = (total - sumB) / wF;
        var v = wB * wF * (mB - mF) * (mB - mF);
        if (v > bestVar) { bestVar = v; best = k4; }
      }
      var nDark = 0, sumDark = 0;
      for (var k5 = 0; k5 <= best; k5++) { nDark += hist[k5]; sumDark += k5 * hist[k5]; }
      var nBright = bandN - nDark;
      var mDark = nDark ? sumDark / nDark : 0;
      var mBright = nBright ? (total - sumDark) / nBright : 255;
      inkIsDark = nDark <= nBright;            // 少数派 = 笔画
      otsuL = best / 255;
      inkStats = {
        mode: 'auto',
        otsu: +otsuL.toFixed(3),
        polarity: inkIsDark ? 'dark' : 'bright',
        gap: +((mBright - mDark) / 255).toFixed(3),
        inkFrac: +((inkIsDark ? nDark : nBright) / bandN).toFixed(4)
      };
    }

    var rw = nameInk.ramp;
    for (var y2 = by0; y2 < by1; y2++) {
      for (var x2 = bx0; x2 < bx1; x2++) {
        var i2 = (y2 * dw + x2) << 2;
        if (cp[i2 + 3] < 8) continue;
        var l2 = (0.2126 * cp[i2] + 0.7152 * cp[i2 + 1] + 0.0722 * cp[i2 + 2]) / 255;
        var t2 = nameInk.auto
          // 以 Otsu 阈值为中心、±rw 软过渡；极性翻，过渡方向跟着翻
          ? (inkIsDark ? (otsuL + rw - l2) : (l2 - (otsuL - rw))) / (2 * rw)
          // 手工兜底：沿用旧的"暗 = 笔画"绝对阈值
          : (nameInk.hi - l2) / (nameInk.hi - nameInk.lo);
        ink[y2 * dw + x2] = Math.max(0, Math.min(1, t2)) * 255;
      }
    }
    var dilated = ink;
    for (var pass = 0; pass < nameInk.dilate; pass++) {
      var nx = new Uint8Array(dw * dh);
      for (var y3 = 0; y3 < dh; y3++) {
        for (var x3 = 0; x3 < dw; x3++) {
          var m = 0;
          for (var j = -1; j <= 1; j++) {
            var yy = y3 + j; if (yy < 0 || yy >= dh) continue;
            for (var i = -1; i <= 1; i++) {
              var xx = x3 + i; if (xx < 0 || xx >= dw) continue;
              var vv = dilated[yy * dw + xx]; if (vv > m) m = vv;
            }
          }
          nx[y3 * dw + x3] = m;
        }
      }
      dilated = nx;
    }

    var mask = mctx.createImageData(dw, dh);
    var md = mask.data;
    var inRect = function (r, x, y) { return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1; };
    var hard = { g: new Float32Array(dw * dh), b: new Float32Array(dw * dh), a: new Float32Array(dw * dh) };
    for (var y4 = 0; y4 < dh; y4++) {
      for (var x4 = 0; x4 < dw; x4++) {
        var i4 = (y4 * dw + x4) << 2;
        if (cp[i4 + 3] < 8) { md[i4] = md[i4 + 1] = md[i4 + 2] = md[i4 + 3] = 0; continue; }
        var kk = y4 * dw + x4;
        hard.g[kk] = inRect(R.artInner, x4, y4) ? 1 : 0;
        hard.b[kk] = inRect(R.textBox, x4, y4) ? 1 : 0;
        // A 通道 = **卡片自身的剪影**（不是"卡框"）。canvas 是预乘 alpha 存的，
        // 把"卡框掩膜"放 alpha 里会让卡图/效果框那两块的 G/B 在反预乘时被除以 0 抹掉；
        // 卡框与卡图外环交给着色器按矩形现算（见 js/shaders.js 的 pickMask）。
        hard.a[kk] = 1;
        md[i4] = dilated[kk];
      }
    }
    // 区域边界羽化 ≈1.5px（硬边在小尺寸下会沿边框闪锯齿）
    var feather = function (srcArr) {
      var t1 = new Float32Array(dw * dh), o2 = new Float32Array(dw * dh);
      var blur1 = function (s, d) {
        for (var y = 0; y < dh; y++) for (var x = 0; x < dw; x++) {
          var sum = 0, n = 0;
          for (var jj = -1; jj <= 1; jj++) {
            var yy2 = y + jj; if (yy2 < 0 || yy2 >= dh) continue;
            for (var ii = -1; ii <= 1; ii++) {
              var xx2 = x + ii; if (xx2 < 0 || xx2 >= dw) continue;
              sum += s[yy2 * dw + xx2]; n++;
            }
          }
          d[y * dw + x] = sum / n;
        }
      };
      blur1(srcArr, t1); blur1(t1, o2);
      return o2;
    };
    var fg = feather(hard.g), fb = feather(hard.b), fa = feather(hard.a);
    for (var k6 = 0; k6 < dw * dh; k6++) {
      var i6 = k6 << 2;
      md[i6 + 1] = Math.round(fg[k6] * 255);
      md[i6 + 2] = Math.round(fb[k6] * 255);
      md[i6 + 3] = Math.round(fa[k6] * 255);
    }
    mctx.putImageData(mask, 0, 0);

    var mtex = canvasOf(texW, texH);
    mtex.getContext('2d').drawImage(mv, ox, oy);

    // ---- 5. 统计 ----
    var n6 = 0, inkN = 0, artN = 0, textN = 0, frameN = 0, ringN = 0;
    for (var y5 = 0; y5 < dh; y5++) for (var x5 = 0; x5 < dw; x5++) {
      var i5 = (y5 * dw + x5) << 2;
      if (cp[i5 + 3] < 8) continue;
      n6++;
      if (md[i5] > 127) inkN++;
      if (md[i5 + 1] > 127) artN++;
      if (md[i5 + 2] > 127) textN++;
      var inOuter = inRect(R.artOuter, x5, y5), inText = inRect(R.textBox, x5, y5), inInner = inRect(R.artInner, x5, y5);
      if (!inOuter && !inText) frameN++;
      if (inOuter && !inInner) ringN++;
    }

    // ---- 6. 掩膜预览 ----
    var pv = canvasOf(dw, dh);
    var pctx = pv.getContext('2d');
    var pimg = pctx.createImageData(dw, dh);
    for (var i7 = 0; i7 < dw * dh; i7++) {
      var k7 = i7 << 2;
      pimg.data[k7] = md[k7] * 0.85;
      pimg.data[k7 + 1] = md[k7 + 1] * 0.55;
      pimg.data[k7 + 2] = md[k7 + 2] * 0.55;
      pimg.data[k7 + 3] = md[k7 + 3] > 127 ? 190 : 40;
    }
    pctx.putImageData(pimg, 0, 0);

    return {
      srcWidth: W, srcHeight: H,
      card: CARD, detected: detected, detectNote: det.note, detectStrength: det.strength,
      cornerPx: cornerPx, cornerSrc: cornerSrc,
      texWidth: texW, texHeight: texH, contentW: dw, contentH: dh,
      cardW: cw0, cardH: ch0, aspect: aspect,
      contentUV: { x0: ox / texW, y0: oy / texH, x1: (ox + dw) / texW, y1: (oy + dh) / texH },
      regionsMapped: mapped,
      nameInk: nameInk,
      dataUri: tex.toDataURL(FORMAT_, QUALITY_),
      maskUri: mtex.toDataURL('image/png'),
      maskPreview: pv.toDataURL('image/png'),
      inkStats: inkStats,
      coverage: { name: inkN / n6, art: artN / n6, text: textN / n6, frame: frameN / n6, ring: ringN / n6, opaque: n6 / (dw * dh) }
    };
  }

  /**
   * 把 bakeCard 的结果整理成 js/card-textures.js 里**一条记录**的形状。
   * 工具和页面共用，保证两边写出来的字段一模一样（页面那份只是没有 id/file/sha256）。
   */
  function toEntry(res, extra) {
    extra = extra || {};
    return {
      id: extra.id,
      file: extra.file,
      sha256: extra.sha256,
      sourceWidth: res.srcWidth,
      sourceHeight: res.srcHeight,
      cardRect: res.card,
      cardDetected: res.detected,
      cornerRadius: res.cornerPx,
      cornerRadiusSource: res.cornerSrc,
      width: res.texWidth,
      height: res.texHeight,
      aspect: res.texWidth / res.texHeight,
      margin: extra.margin == null ? MARGIN : extra.margin,
      contentUV: res.contentUV,
      contentWidth: res.contentW,
      contentHeight: res.contentH,
      contentAspect: res.aspect,
      regions: res.regionsMapped,
      nameInk: res.nameInk,
      nameInkStats: res.inkStats,
      maskCoverage: res.coverage,
      dataUri: res.dataUri,
      maskUri: res.maskUri
    };
  }

  global.CardBake = {
    bakeCard: bakeCard,
    toEntry: toEntry,
    REGIONS: REGIONS,
    NAME_INK: NAME_INK,
    FORMAT: FORMAT,
    QUALITY: QUALITY,
    MARGIN: MARGIN
  };
})(typeof window !== 'undefined' ? window : globalThis);
