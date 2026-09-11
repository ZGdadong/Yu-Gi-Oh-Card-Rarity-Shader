// 卡片外沿检测：**唯一的定义**，被 tools/embed-card.mjs 与 tools/verify.mjs 共用。
//
// 这里导出的不是函数而是**函数源码字符串** —— 因为它要在浏览器页面里对像素跑，
// 两个工具各自 page.evaluate 时把这段源码注入进去。这样"怎么检测"只有一份实现，
// 改了一处两边都跟着变，不会出现"verify 测的是另一套算法"这种情况。
//
// 算法：
//   ① 逐行/逐列统计"有多少比例的采样像素同时跳变"（|Δluma| > 26），得到边缘强度曲线
//   ② 阈值自适应：max(0.5, 0.75 × 这批边缘里的最大值)
//      —— 写死阈值会在"卡片只占画面一半"的图上失效（实测过）
//   ③ 从上/下/左/右各找第一根过阈值的线当四边
//   ④ **用已知的卡片长宽比校正**：游戏王卡是 59:86 = 0.686，这个数是确定的。
//      如果量出来的比例明显不对，说明有一对边没找准（典型情况：浅色卡片放在浅色背景上，
//      上沿的对比度不够），这时"信边缘更强的那一对边"，用比例推出另一对。
//
// 返回：{ rect, detected, aspect, note, strength: {top,bottom,left,right} }

export const CARD_ASPECT = 59 / 86;   // 0.6860

export const DETECT_SRC = `
function detectCardRect(sp, W, H) {
  var CARD_ASPECT = ${CARD_ASPECT};
  var EDGE_TH = 26;        // 多大的亮度跳变算"一根边"
  var luma = function (x, y) {
    var i = ((y * W + x) << 2);
    return 0.2126 * sp[i] + 0.7152 * sp[i + 1] + 0.0722 * sp[i + 2];
  };
  // 采样带取中间 60%：避开照片四周的暗角/边框
  var xa = Math.round(W * 0.20), xb = Math.round(W * 0.80);
  var ya = Math.round(H * 0.20), yb = Math.round(H * 0.80);
  var rowEdge = new Float64Array(H), colEdge = new Float64Array(W);
  var maxRow = 0, maxCol = 0, y, x, n;
  for (y = 1; y < H; y++) {
    n = 0;
    for (x = xa; x < xb; x++) if (Math.abs(luma(x, y) - luma(x, y - 1)) > EDGE_TH) n++;
    rowEdge[y] = n / (xb - xa);
    if (rowEdge[y] > maxRow) maxRow = rowEdge[y];
  }
  for (x = 1; x < W; x++) {
    n = 0;
    for (y = ya; y < yb; y++) if (Math.abs(luma(x, y) - luma(x - 1, y)) > EDGE_TH) n++;
    colEdge[x] = n / (yb - ya);
    if (colEdge[x] > maxCol) maxCol = colEdge[x];
  }
  // 边缘门槛：保持原来的自适应口径 max(0.5, max*0.75)。
  //
  // 试过放宽到 max(0.32, max*0.5)（想直接够到弱边），**不行**：
  // 深背景 + 投影的合成用例里，投影的软边强度正好落在 0.5~0.75 之间，
  // 门槛一低就捡投影不捡卡片（实测误差 2px → 19px）。
  // 试过"先严后宽扫两遍"，**也不行**：严档扫出来的东西长宽比看着像卡（其实不对），
  // 于是永远不会去试宽档 —— 反倒把这个用例彻底扫崩（退化成整图，误差 396px）。
  //
  // 弱边改由下面的**对称镜像**去救，比动门槛精确得多，也不影响任何合成用例。
  var rowTh = Math.max(0.5, maxRow * 0.75);
  var colTh = Math.max(0.5, maxCol * 0.75);
  var top = -1, bot = -1, left = -1, right = -1;
  for (y = 1; y < H && top < 0; y++) if (rowEdge[y] >= rowTh) top = y;
  for (y = H - 1; y > 0 && bot < 0; y--) if (rowEdge[y] >= rowTh) bot = y;
  for (x = 1; x < W && left < 0; x++) if (colEdge[x] >= colTh) left = x;
  for (x = W - 1; x > 0 && right < 0; x--) if (colEdge[x] >= colTh) right = x;

  var note = 'both-axes';
  var detected = top > 0 && left > 0 && right > left && bot > top;
  if (detected) {
    var w = right + 1 - left, h = bot + 1 - top;
    var ar = w / h;
    var area = (w * h) / (W * H);
    if (Math.abs(ar - CARD_ASPECT) > 0.03) {
      // 比例不像卡 → 至少有一对边没找准。
      //
      // 先试"留白对称补边"：卡图基本都是从同一个模板**居中**导出的，被内部边抢走的那一侧
      // 可以用对边镜像补回来。这一步专门救**超量黑框**那种卡沿与背景几乎同色、边缘强度为
      // 0 的图 —— 任何门槛都找不到它的下沿，只能靠镜像
      //（Raidraptor 实测：下沿捡到 1124，镜像后 1158，正是卡片真正的下沿）。
      //
      // 判据：只认 ① 镜像后长宽比真的像卡（|Δ| ≤ 0.03）② 比原来更接近 的候选；
      // 都满足时取**面积最大**的那个 —— 失效方向是"多包一点背景"，而不是把卡片裁掉。
      //
      // 注意**不能**拿"最接近 59:86"当判据：这套图的实拍比例是 0.6726 而不是 0.686，
      // 按 0.686 挑反而会选中矮了 10px 的那个。
      var best = null;
      for (var mv = 0; mv < 2; mv++) {
        for (var mh = 0; mh < 2; mh++) {
          var t2 = top, b2 = bot, l2 = left, r2 = right;
          if (mv) { if (rowEdge[top] >= rowEdge[bot]) b2 = H - 1 - top; else t2 = H - 1 - bot; }
          if (mh) { if (colEdge[left] >= colEdge[right]) r2 = W - 1 - left; else l2 = W - 1 - right; }
          var cw2 = r2 + 1 - l2, ch2 = b2 + 1 - t2;
          if (cw2 <= 0 || ch2 <= 0) continue;
          var d2 = Math.abs(cw2 / ch2 - CARD_ASPECT);
          if (d2 > 0.03 || d2 >= Math.abs(ar - CARD_ASPECT)) continue;
          if (!best || cw2 * ch2 > best.area) best = { area: cw2 * ch2, t: t2, b: b2, l: l2, r: r2, mv: mv, mh: mh };
        }
      }
      if (best) {
        top = best.t; bot = best.b; left = best.l; right = best.r;
        note = best.mv && best.mh ? 'mirror-both' : (best.mv ? 'mirror-v' : 'mirror-h');
      } else {
        // 镜像也救不回来 → 退回原来那套：信"边缘更强"的那一对，用 59:86 推出另一对。
        var vStrength = Math.min(colEdge[left], colEdge[right]);
        var hStrength = Math.min(rowEdge[top], rowEdge[bot]);
        if (vStrength >= hStrength) {
          var newH = Math.round(w / CARD_ASPECT);
          // 锚在更强的那一条横边上：上沿更可信就往下展开，下沿更可信就往上收
          if (rowEdge[top] >= rowEdge[bot]) bot = top + newH - 1;
          else top = bot - newH + 1;
          note = 'width-led';
        } else {
          var newW = Math.round(h * CARD_ASPECT);
          if (colEdge[left] >= colEdge[right]) right = left + newW - 1;
          else left = right - newW + 1;
          note = 'height-led';
        }
      }
      w = right + 1 - left; h = bot + 1 - top;
      ar = w / h;
      area = (w * h) / (W * H);
    }
    // 夹回图像范围内
    if (top < 0 || left < 0 || right >= W || bot >= H) detected = false;
    // 比例得像游戏王卡（59:86），面积也不能太离谱
    else if (ar < 0.60 || ar > 0.78 || area < 0.12) detected = false;
  }
  var rect = detected
    ? { x0: left, y0: top, x1: right + 1, y1: bot + 1 }
    : { x0: 0, y0: 0, x1: W, y1: H };
  return {
    rect: rect,
    detected: detected,
    note: note,
    aspect: (rect.x1 - rect.x0) / (rect.y1 - rect.y0),
    strength: { top: top > 0 ? rowEdge[top] : 0, bottom: bot > 0 ? rowEdge[bot] : 0,
                left: left > 0 ? colEdge[left] : 0, right: right > 0 ? colEdge[right] : 0 }
  };
}
`;
