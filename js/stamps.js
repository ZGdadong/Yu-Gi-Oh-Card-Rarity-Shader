/*
 * stamps.js —— 图案图集（运行时用 canvas 2D 画出来，再当纹理喂给着色器）
 *
 * 为什么要图集而不是在 GLSL 里画：
 *   KC 标志、周年水印、"埃及文字"这些都是**字形**。在 GLSL 里画字要手写一堆线段
 *   SDF，又长又难改；而浏览器里现成的 canvas 2D 有字体、有路径、有描边 —— 画完
 *   直接 toDataURL 当纹理上传就行。着色器那边只剩"取格子 + 按 alpha 叠上去"。
 *
 * 图集是 4×2 格（格宽 0.25、格高 0.5），格内容：
 *   (0,0) KC 标志        (1,0) "20th"        (2,0) "25th"       (3,0) 菱形徽记
 *   (0,1) 安卡           (1,1) 荷鲁斯之眼     (2,1) 王名圈        (3,1) 水波与鸟
 *
 * ⚠️ 下排那四个"埃及象形字"是**风格化近似**，不是真的圣书体字形。
 *    千年闪 / 法老闪那类工艺要的是"一眼看上去是埃及文字图案"的观感，
 *    真按博物馆字形来画既不现实也没必要。README 的"已知取舍"里写明了这一点。
 *
 * 经典脚本（非 ES module），file:// 双击可用。
 */
(function (global) {
  'use strict';

  const CELL = 256;
  const COLS = 4, ROWS = 2;

  // 把 0..1 的格内坐标映射到画布像素
  function cellOrigin(col, row) { return { x: col * CELL, y: row * CELL }; }

  /** 在一格里画东西：先把坐标原点挪到格子左上角，并统一描边风格 */
  function inCell(ctx, col, row, fn) {
    ctx.save();
    const o = cellOrigin(col, row);
    ctx.translate(o.x, o.y);
    ctx.beginPath();
    ctx.rect(0, 0, CELL, CELL);
    ctx.clip();
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    fn(ctx);
    ctx.restore();
  }

  /** 粗描边的"手写感"字体，用它画字最容易读 */
  function text(ctx, str, size, weight) {
    ctx.font = (weight || 'bold') + ' ' + size + 'px "Arial Black", Impact, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  function drawAtlas(ctx) {
    ctx.clearRect(0, 0, COLS * CELL, ROWS * CELL);

    // ---- (0,0) KC 标志：圆环 + "KC" -------------------------------------
    inCell(ctx, 0, 0, (c) => {
      c.lineWidth = 13;
      c.beginPath();
      c.arc(CELL / 2, CELL / 2, CELL * 0.40, 0, Math.PI * 2);
      c.stroke();
      c.lineWidth = 5;
      c.beginPath();
      c.arc(CELL / 2, CELL / 2, CELL * 0.455, 0, Math.PI * 2);
      c.stroke();
      text(c, 'KC', 132, 'bold');
      c.fillText('KC', CELL / 2, CELL / 2 + 6);
    });

    // ---- (1,0) "20th" ---------------------------------------------------
    inCell(ctx, 1, 0, (c) => {
      text(c, '20th', 116, 'bold');
      c.fillText('20th', CELL / 2, CELL / 2);
    });

    // ---- (2,0) "25th" ---------------------------------------------------
    inCell(ctx, 2, 0, (c) => {
      text(c, '25th', 116, 'bold');
      c.fillText('25th', CELL / 2, CELL / 2);
    });

    // ---- (3,0) 菱形徽记（给"棱彩/纪念"那类当角标用）--------------------
    inCell(ctx, 3, 0, (c) => {
      c.lineWidth = 12;
      const r = CELL * 0.36;
      c.beginPath();
      c.moveTo(CELL / 2, CELL / 2 - r);
      c.lineTo(CELL / 2 + r * 0.72, CELL / 2);
      c.lineTo(CELL / 2, CELL / 2 + r);
      c.lineTo(CELL / 2 - r * 0.72, CELL / 2);
      c.closePath();
      c.stroke();
      c.lineWidth = 7;
      const r2 = r * 0.55;
      c.beginPath();
      c.moveTo(CELL / 2, CELL / 2 - r2);
      c.lineTo(CELL / 2 + r2 * 0.72, CELL / 2);
      c.lineTo(CELL / 2, CELL / 2 + r2);
      c.lineTo(CELL / 2 - r2 * 0.72, CELL / 2);
      c.closePath();
      c.stroke();
    });

    // ---- (0,1) 安卡（生命之符）-----------------------------------------
    inCell(ctx, 0, 1, (c) => {
      c.lineWidth = 20;
      // 上环
      c.beginPath();
      c.ellipse(CELL / 2, CELL * 0.32, CELL * 0.14, CELL * 0.19, 0, 0, Math.PI * 2);
      c.stroke();
      // 竖
      c.beginPath();
      c.moveTo(CELL / 2, CELL * 0.50);
      c.lineTo(CELL / 2, CELL * 0.86);
      c.stroke();
      // 横
      c.beginPath();
      c.moveTo(CELL * 0.24, CELL * 0.575);
      c.lineTo(CELL * 0.76, CELL * 0.575);
      c.stroke();
    });

    // ---- (1,1) 荷鲁斯之眼（简化）---------------------------------------
    inCell(ctx, 1, 1, (c) => {
      c.lineWidth = 15;
      // 眼眶：两根弧线拼成一个扁菱形眼
      c.beginPath();
      c.moveTo(CELL * 0.16, CELL * 0.46);
      c.quadraticCurveTo(CELL * 0.50, CELL * 0.20, CELL * 0.86, CELL * 0.46);
      c.quadraticCurveTo(CELL * 0.50, CELL * 0.66, CELL * 0.16, CELL * 0.46);
      c.stroke();
      // 瞳孔
      c.beginPath();
      c.arc(CELL * 0.50, CELL * 0.44, CELL * 0.095, 0, Math.PI * 2);
      c.fill();
      // 眼下的垂饰 + 卷曲
      c.beginPath();
      c.moveTo(CELL * 0.40, CELL * 0.58);
      c.lineTo(CELL * 0.36, CELL * 0.80);
      c.stroke();
      c.beginPath();
      c.moveTo(CELL * 0.62, CELL * 0.58);
      c.quadraticCurveTo(CELL * 0.80, CELL * 0.68, CELL * 0.76, CELL * 0.86);
      c.stroke();
      // 眉线
      c.lineWidth = 11;
      c.beginPath();
      c.moveTo(CELL * 0.22, CELL * 0.30);
      c.lineTo(CELL * 0.80, CELL * 0.30);
      c.stroke();
    });

    // ---- (2,1) 王名圈（椭圆形框 + 内部分隔线）--------------------------
    inCell(ctx, 2, 1, (c) => {
      c.lineWidth = 16;
      c.beginPath();
      c.ellipse(CELL / 2, CELL / 2, CELL * 0.34, CELL * 0.20, 0, 0, Math.PI * 2);
      c.stroke();
      // 圈内竖分隔（王名圈里那几笔）
      c.lineWidth = 12;
      for (let i = -1; i <= 1; i++) {
        const x = CELL / 2 + i * CELL * 0.14;
        c.beginPath();
        c.moveTo(x, CELL * 0.40);
        c.lineTo(x, CELL * 0.60);
        c.stroke();
      }
      // 底座横线
      c.lineWidth = 10;
      c.beginPath();
      c.moveTo(CELL * 0.18, CELL * 0.84);
      c.lineTo(CELL * 0.82, CELL * 0.84);
      c.stroke();
    });

    // ---- (3,1) 水波与鸟 ------------------------------------------------
    inCell(ctx, 3, 1, (c) => {
      // 三条水波
      c.lineWidth = 13;
      for (let k = 0; k < 3; k++) {
        const y = CELL * (0.30 + k * 0.16);
        c.beginPath();
        c.moveTo(CELL * 0.14, y);
        for (let i = 0; i < 3; i++) {
          const x0 = CELL * (0.14 + i * 0.24);
          c.quadraticCurveTo(x0 + CELL * 0.06, y - CELL * 0.07, x0 + CELL * 0.12, y);
          c.quadraticCurveTo(x0 + CELL * 0.18, y + CELL * 0.07, x0 + CELL * 0.24, y);
        }
        c.stroke();
      }
      // 一只简化的鸟
      c.lineWidth = 11;
      c.beginPath();
      c.moveTo(CELL * 0.30, CELL * 0.86);
      c.lineTo(CELL * 0.46, CELL * 0.60);
      c.lineTo(CELL * 0.62, CELL * 0.86);
      c.stroke();
      c.beginPath();
      c.arc(CELL * 0.52, CELL * 0.54, CELL * 0.05, 0, Math.PI * 2);
      c.fill();
    });
  }

  /** 生成图集，返回 { dataUri, width, height } */
  function build() {
    const cv = document.createElement('canvas');
    cv.width = COLS * CELL;
    cv.height = ROWS * CELL;
    const ctx = cv.getContext('2d');
    drawAtlas(ctx);
    return {
      dataUri: cv.toDataURL('image/png'),
      width: cv.width,
      height: cv.height,
      cols: COLS,
      rows: ROWS,
      // 格子的归一化尺寸（着色器里 stampAt 用的就是这两个数）
      cellW: 1 / COLS,
      cellH: 1 / ROWS,
      names: [
        ['kc', '20th', '25th', 'diamond'],
        ['ankh', 'eye', 'cartouche', 'wave']
      ]
    };
  }

  global.CardStamps = { build: build, CELL: CELL, COLS: COLS, ROWS: ROWS };
})(window);
