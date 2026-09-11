/*
 * pipeline.js —— 多 pass 渲染管线
 *
 * 一张卡是这样叠出来的（每一步都是一个 draw step，采样同一张卡面纹理）：
 *
 *   ① 背景         全屏    —— 一道渐变 + 缓慢横移的光带
 *   ② 投影         卡片四边形  卡片的黑色剪影（25 抽样软边）
 *   ③ 卡面 base     卡片四边形  原始印刷（或者掩膜调试图）
 *   ④..⑥ 工艺层     卡片四边形  按 js/rarities.js 里那份配方，一层一层叠上去
 *
 * 顶点阶段做了**真正的 3D 倾斜**（见 js/shaders.js 的 VERTEX）：
 * 拿实卡看闪膜本来就是捏着卡慢慢转，所以鼠标在卡上移动时卡片真的绕 X/Y 轴转动，
 * 而这两个角度同时被送去驱动闪膜的衍射相位 —— 观感才对得上。
 *
 * 卡面纹理**始终是那张没加工过的原始印刷**：所有 pass 都采样它，
 * 所以叠几层就是几层，互不污染。
 *
 * 经典脚本（非 ES module），file:// 双击可用。
 */
(function (global) {
  'use strict';

  const SH = global.CardShaders;
  const CFG = global.CardConfig;
  const RAR = global.CardRarities;
  const TEXSET = global.CardTextures;
  const TEX = (TEXSET && TEXSET.list && TEXSET.list[0]) || global.CardTexture;

  /*
   * 每张卡的"版式常量"（留白比例、纹理长宽比、卡片内容矩形、卡图窗外框）
   * 都是**跟着当前选中的卡走**的，所以这里不能在模块级别定死 ——
   * 见 `spec` getter。这一份只是万一没有卡数据的兜底。
   */
  const FALLBACK_SPEC = {
    margin: 0.04,
    aspect: 0.6729,
    contentAspect: 0.6729,
    contentUV: { x0: 0.04, y0: 0.04, x1: 0.96, y1: 0.96 },
    regions: { artOuter: { x0: 0.074, y0: 0.152, x1: 0.928, y1: 0.728 } }
  };

  // 倾斜到多大算"满视角"。0.62 弧度 ≈ 35°，再大就不像在看卡、像在翻牌了。
  const TILT_MAX = 0.62;
  // 相机：画布高的倍数。focal = dist 时 z=0 平面上 k=1，卡片不放大也不缩小。
  const CAM_DIST = 1.75;
  /*
   * 投影。这里调过两轮，结论写下来：
   *   · 一开始偏移只有 1% 画布高，几乎全藏在卡片背后 —— 看不见，参数扫描直接判它"没接通"。
   *   · 于是加到 1.7% / 1.032 倍 / 0.70 不透明 —— 扫描过了，但**卡片下面成了一道黑边**：
   *     这张卡的角是方的（见 tools/embed-card.mjs 的圆角检测），投影就是个硬邦邦的
   *     黑色矩形往下挪一点，在暗背景上看着就是一条黑边。
   * 现在是"贴着卡片的浅投影"：偏移小、放大少、不透明度低，靠**更宽的模糊**撑出过渡。
   */
  const SHADOW_DY = 0.008;
  const SHADOW_SCALE = 1.012;
  const SHADOW_ALPHA = 0.42;
  const SHADOW_BLUR = 5.0;

  function orthoPixel(w, h) {
    return new Float32Array([
      2 / w, 0, 0, 0,
      0, -2 / h, 0, 0,
      0, 0, 1, 0,
      -1, 1, 0, 1
    ]);
  }

  function compile(gl, type, src, label) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || '(无日志)';
      gl.deleteShader(sh);
      const err = new Error('[' + label + '] 着色器编译失败:\n' + log);
      err.glsl = src;
      err.shaderLabel = label;
      throw err;
    }
    return sh;
  }

  // 每个工艺用哪个"强度倍率"参数（p0.x 是所有工艺统一的第一号参数：强度）
  const CRAFT_MULT = {
    holo: 'mHolo', parallel: 'mParallel', diagonal: 'mDiagonal', prismatic: 'mPrismatic',
    emboss: 'mEmboss', metal: 'mMetal', rainbow: 'mRainbow', ghost: 'mGhost',
    glitter: 'mGlitter', stamp: 'mStamp', name: 'mName',
    starfoil: 'mPattern', mosaic: 'mPattern', voronoi: 'mPattern',
    kc: 'mPattern', millennium: 'mPattern'
  };

  class CardPipeline {
    constructor(canvas, overlay, opts) {
      opts = opts || {};
      this.canvas = canvas;
      this.overlay = overlay || null;

      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance'
      });
      if (!gl) throw new Error('此浏览器不支持 WebGL2');
      this.gl = gl;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '未知';

      this.onParamsChanged = null;
      this.params = CFG.defaults();
      this.time = 0;
      this.playing = true;
      this.speed = this.params.speed;
      this.scale = this.params.scale;
      this.lastTs = 0;
      this.frame = 0;
      this.raf = 0;
      this.cssWidth = 1;
      this.cssHeight = 1;

      this.mouse = { x: -1e5, y: -1e5, over: false, cx: 0.5, cy: 0.5 };
      this.tilt = { x: 0, y: 0 };
      this.smoothTilt = { x: 0, y: 0 };

      // ---- 纹理：懒建（要等 <img> 解码完）----
      // 多张卡时结构和掩膜是**每张一套**：this.cardImgs / this.maskImgs 按 id 存，
      // 切卡时换的是"当前用哪一套"，不是重新解码。
      this.cardSpec = TEX || FALLBACK_SPEC;
      this.cardImgs = {};
      this.maskImgs = {};
      this.cardIndex = 0;
      this.stampImage = null;
      this.tex = {};

      // ---- 着色器 ----
      this.vs = compile(gl, gl.VERTEX_SHADER, SH.VERTEX, 'vertex');
      this.programs = {};
      this.fragSources = {};
      for (const name of Object.keys(SH.EFFECTS)) {
        this.fragSources[name] = SH.EFFECTS[name];
        this.programs[name] = this.link(SH.EFFECTS[name], 'fragment:' + name);
      }

      // ---- 缓冲区 ----
      this.quadVBO = gl.createBuffer();
      this.cardVerts = new Float32Array(6 * 4);
      this.screenVerts = new Float32Array(6 * 4);
      this.cardRect = { x: 0, y: 0, w: 0, h: 0 };
      this.render = this.render.bind(this);
      this.syncSize();
    }

    // ---- 纹理上传 ---------------------------------------------------------

    /**
     * 交进解码好的图片。
     *   attachImages({ '卡 id': {card: img, mask: img}, ... }, stampImg)
     * 也兼容老的单卡调用：attachImages(cardImg, maskImg, stampImg)。
     */
    attachImages(a, b, c) {
      const gl = this.gl;
      if (a && a.nodeName === 'IMG') {
        // 老写法：一张卡
        const id = (TEXSET && TEXSET.defaultId) || (TEX && TEX.id) || 'card';
        this.cardImgs = {}; this.maskImgs = {};
        this.cardImgs[id] = a; this.maskImgs[id] = b;
        if (TEXSET) this.cardIndex = Math.max(0, TEXSET.order.indexOf(id));
        this.stampImage = c;
      } else {
        this.cardImgs = {}; this.maskImgs = {};
        for (const id of Object.keys(a || {})) {
          if (a[id] && a[id].card) this.cardImgs[id] = a[id].card;
          if (a[id] && a[id].mask) this.maskImgs[id] = a[id].mask;
        }
        this.stampImage = b;
      }
      for (const k of ['card', 'mask', 'stamp']) if (this.tex[k]) { gl.deleteTexture(this.tex[k]); this.tex[k] = null; }
      this.cardSpec = this._specAt(this.cardIndex);
      return this;
    }

    /** 一览模式与切卡都靠它：当前这一张的版式常量 */
    _specAt(i) {
      if (!TEXSET || !TEXSET.list.length) return TEX || FALLBACK_SPEC;
      const n = TEXSET.list.length;
      const k = ((Math.round(i) % n) + n) % n;
      return TEXSET.list[k];
    }

    /** 当前卡的版式常量（留白 / 长宽比 / 内容矩形 / 卡图窗外框） */
    get spec() { return this.cardSpec || FALLBACK_SPEC; }

    /** 当前卡在 CardTextures.list 里的下标 */
    get cardIdx() {
      if (!TEXSET) return 0;
      const id = this.spec && this.spec.id;
      const i = TEXSET.order.indexOf(id);
      return i < 0 ? 0 : i;
    }

    /** 换一张卡：纹理、版式常量、需要的 mipmap 都跟着换 */
    setCard(index) {
      const n = TEXSET ? TEXSET.list.length : 1;
      const k = ((Math.round(index) % n) + n) % n;
      if (k === this.cardIndex && this.tex.card) return this;
      this.cardIndex = k;
      this.cardSpec = this._specAt(k);
      const gl = this.gl;
      const id = this.cardSpec.id;
      if (this.tex.card) { gl.deleteTexture(this.tex.card); this.tex.card = null; }
      if (this.tex.mask) { gl.deleteTexture(this.tex.mask); this.tex.mask = null; }
      this._ensureTextures();
      return this;
    }

    _upload(img, opts) {
      const gl = this.gl;
      opts = opts || {};
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // 关键：不翻转。图片第 0 行（上沿）落在 v=0 ——
      // 卡片四边形把屏幕上方那条边映到 v=0，于是卡片方向就是正的。
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // 掩膜要 mipmap：卡片显示尺寸通常远小于纹理，没有 mipmap 的话
      // 区域边界会沿着边框闪（锯齿），羽化过的边也会被采丢。
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return tex;
    }

    _ensureTextures() {
      if (this.tex.card && this.tex.mask && this.tex.stamp) return;
      const id = this.cardSpec && this.cardSpec.id;
      const cardImg = this.cardImgs[id];
      const maskImg = this.maskImgs[id];
      if (!cardImg || !maskImg) throw new Error('纹理还没准备好（attachImages 尚未调用，或没有 ' + id + ' 的图）');
      if (!this.tex.card) this.tex.card = this._upload(cardImg);
      if (!this.tex.mask) this.tex.mask = this._upload(maskImg);
      if (!this.tex.stamp) this.tex.stamp = this._upload(this.stampImage);
    }

    // ---- program ---------------------------------------------------------

    link(fragSrc, label) {
      const gl = this.gl;
      const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc, label);
      const prog = gl.createProgram();
      gl.bindAttribLocation(prog, 0, 'aPos');
      gl.bindAttribLocation(prog, 1, 'aUV');
      gl.attachShader(prog, this.vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog) || '(无日志)';
        gl.deleteProgram(prog);
        throw new Error('[' + label + '] 程序链接失败:\n' + log);
      }
      prog._label = label;
      prog._src = fragSrc;
      prog._loc = {};
      return prog;
    }

    loc(prog, name) {
      if (!(name in prog._loc)) prog._loc[name] = this.gl.getUniformLocation(prog, name);
      return prog._loc[name];
    }
    u1f(p, n, v) { const l = this.loc(p, n); if (l) this.gl.uniform1f(l, v); }
    u1i(p, n, v) { const l = this.loc(p, n); if (l) this.gl.uniform1i(l, v); }
    u2f(p, n, a, b) { const l = this.loc(p, n); if (l) this.gl.uniform2f(l, a, b); }
    u4f(p, n, c) { const l = this.loc(p, n); if (l) this.gl.uniform4f(l, c[0], c[1], c[2], c[3]); }

    // ---- 尺寸 -------------------------------------------------------------

    resize(cssWidth, cssHeight, dpr) {
      if (dpr === undefined) dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(cssWidth * dpr));
      const h = Math.max(1, Math.floor(cssHeight * dpr));
      this.cssWidth = cssWidth;
      this.cssHeight = cssHeight;
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      if (this.overlay) {
        if (this.overlay.width !== w || this.overlay.height !== h) {
          this.overlay.width = w;
          this.overlay.height = h;
        }
        this.overlay.style.width = cssWidth + 'px';
        this.overlay.style.height = cssHeight + 'px';
      }
      this.syncSize();
      return { w: w, h: h };
    }

    syncSize() {
      const gl = this.gl;
      this.viewW = Math.max(2, Math.floor(this.canvas.width * this.scale));
      this.viewH = Math.max(2, Math.floor(this.canvas.height * this.scale));
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      // 全屏四边形（uv 的 v=0 在上沿，与卡片一致）
      const s = this.screenVerts;
      const W = this.viewW, H = this.viewH;
      const set = (i, x, y, u, v) => { s[i] = x; s[i + 1] = y; s[i + 2] = u; s[i + 3] = v; };
      set(0, 0, 0, 0, 0); set(4, W, 0, 1, 0); set(8, W, H, 1, 1);
      set(12, 0, 0, 0, 0); set(16, W, H, 1, 1); set(20, 0, H, 0, 1);
    }

    setScale(s) { this.scale = s; this.syncSize(); }

    /**
     * 卡片四边形。
     * uv 的 **v=0 是卡片上沿**（纹理第 0 行就是图片第 0 行，上传时没翻转），
     * 所以着色器里 `uv.y` 小 = 卡片上方，跟 LÖVE 的纹理坐标约定一致。
     */
    updateCardQuad(cx, cy, w, h) {
      const gl = this.gl;
      this.cardRect = { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
      const c = this.cardVerts;
      const x0 = cx - w / 2, x1 = cx + w / 2;
      const y0 = cy - h / 2, y1 = cy + h / 2;
      const set = (i, x, y, u, v) => { c[i] = x; c[i + 1] = y; c[i + 2] = u; c[i + 3] = v; };
      set(0, x0, y0, 0, 0); set(4, x1, y0, 1, 0); set(8, x1, y1, 1, 1);
      set(12, x0, y0, 0, 0); set(16, x1, y1, 1, 1); set(20, x0, y1, 0, 1);
    }

    cardSizePx(viewH) {
      // 卡片（含 4% 留白的那张纹理）在画布上的高度。
      //
      // 光按画布高算是不够的：卡片长宽比固定，窗口一窄（或者开着参数面板，
      // stage 少掉 312px）卡片就会横向顶出画布、被裁掉两边；
      // 反过来 cardSize 开大时又会纵向顶出去。所以两个方向都夹一遍，
      // 保证**画面上永远是完整一张卡**。
      // 注意要按"内容占纹理的比例"换算，不能直接用纹理长宽比 —— 那 4% 留白不算卡片。
      const cuv = this.spec.contentUV, cw = cuv.x1 - cuv.x0, ch = cuv.y1 - cuv.y0;
      const fitByHeight = (viewH * 0.99) / ch;
      const fitByWidth = (this.viewW * 0.99) / (this.spec.aspect * cw);
      return Math.min(viewH * this.params.cardSize, fitByHeight, fitByWidth);
    }

    // ---- 输入 -------------------------------------------------------------

    setMouse(cssX, cssY) {
      const k = this.viewH / Math.max(1, this.cssHeight);
      this.mouse.x = cssX * k;
      this.mouse.y = cssY * k;
      this.mouse.over = this.hitCard(this.mouse.x, this.mouse.y);
      if (this.mouse.over && this.cardRect.w > 1) {
        this.mouse.cx = (this.mouse.x - this.cardRect.x) / this.cardRect.w;
        this.mouse.cy = (this.mouse.y - this.cardRect.y) / this.cardRect.h;
      }
    }
    setMouseOutside() {
      this.mouse.x = -1e5; this.mouse.y = -1e5; this.mouse.over = false;
    }
    hitCard(x, y) {
      const r = this.cardRect;
      if (r.w < 1) return false;
      const hw = r.w * (this.spec.contentUV.x1 - this.spec.contentUV.x0) * 0.5 * 1.06;
      const hh = r.h * (this.spec.contentUV.y1 - this.spec.contentUV.y0) * 0.5 * 1.06;
      return Math.abs(x - (r.x + r.w * 0.5)) <= hw && Math.abs(y - (r.y + r.h * 0.5)) <= hh;
    }
    setPlaying(on) {
      if (on === this.playing) return;
      this.playing = on;
      if (on) { this.lastTs = 0; this.raf = requestAnimationFrame(this.render); }
      else { cancelAnimationFrame(this.raf); this.raf = 0; }
    }
    start() { if (!this.raf && this.playing) this.raf = requestAnimationFrame(this.render); }
    stop() { cancelAnimationFrame(this.raf); this.raf = 0; }
    reset() { this.time = 0; this.frame = 0; this.lastTs = 0; }

    // ---- 参数 -------------------------------------------------------------

    _notify() { if (typeof this.onParamsChanged === 'function') this.onParamsChanged(this.params); }
    _setParam(key, value) {
      const p = CFG.BY_KEY[key];
      if (!p) throw new Error('未知参数: ' + key);
      this.params[key] = CFG.clampParam(p, value);
      if (key === 'speed') this.speed = this.params.speed;
      else if (key === 'scale') this.setScale(this.params.scale);
      else if (key === 'card') this.setCard(this.params.card);
    }
    setParam(k, v) { this._setParam(k, v); this._notify(); return this; }
    setParams(patch) { for (const k of Object.keys(patch)) this._setParam(k, patch[k]); this._notify(); return this; }
    resetParams() {
      this.params = CFG.defaults();
      this.setScale(this.params.scale);
      this.setCard(this.params.card);
      this._notify();
      return this;
    }
    getParams() {
      const o = {};
      for (const k of Object.keys(this.params)) o[k] = this.params[k];
      return o;
    }
    currentRarity() { return RAR.ORDER[Math.round(this.params.rarity)]; }
    currentRarityInfo() { return RAR.BY_ID[this.currentRarity()]; }

    // ---- 视角 -------------------------------------------------------------

    /** 倾斜 → 闪膜衍射相位。倾斜角越大，闪膜整体扫得越远。 */
    viewVec() {
      const g = this.params.viewGain;
      const t = this.smoothTilt;
      return [
        Math.max(-1.6, Math.min(1.6, (t.y / TILT_MAX) * g)),
        Math.max(-1.6, Math.min(1.6, (t.x / TILT_MAX) * g))
      ];
    }
    /** 高光点：在卡片坐标里，往倾斜的反方向跑（像真的有光在反） */
    viewPoint() {
      const v = this.viewVec();
      return [0.5 - v[0] * 0.32, 0.5 - v[1] * 0.30];
    }

    /**
     * 目标倾斜角。**实时渲染与定格渲染共用这一个函数** ——
     * 第一版在 renderAtTime 里另抄了一份，抄的时候漏掉了 hoverOn 判断，
     * 于是"关掉鼠标驱动倾斜"之后定格画面照样跟着鼠标跑
     * （实测鼠标左右移动仍有 252 的单通道最大差），是 tools/verify.mjs 抓出来的。
     *
     * ── 关于两个轴的符号（这里曾经是错的）────────────────────────────────
     * 顶点着色器里两个旋转的**z 位移方向是反的**：
     *   绕 Y 轴：x>0 的那条边 z' = −x·sin(tilt.y)  → tilt.y > 0 时**靠近**相机（放大 = 朝你翘起）
     *   绕 X 轴：y>0 的那条边 z' = +y·sin(tilt.x)  → tilt.x > 0 时**远离**相机（缩小 = 往里沉）
     * 所以 `tx += ny*maxT; ty += nx*maxT;` 这组写法**横竖两个方向的手感是相反的**：
     * 鼠标往右，右边朝你翘；鼠标往下，下边往里沉。单看一个方向都"说得通"，
     * 斜着晃鼠标就会发现两边在打架。
     *
     * 现在两个轴统一由 tiltInvert 决定"鼠标指到哪、那一侧往里沉还是朝你翘"：
     *   s = +1（默认）→ 两侧都**往里沉**（像手指按住卡片）
     *   s = −1         → 两侧都**朝你翘起**（最初那版横向的行为）
     */
    targetTilt() {
      const P = this.params;
      const maxT = TILT_MAX * P.tiltAmount;
      let tx = 0, ty = 0;
      if (P.autoSway > 0.001) {
        const s = this.time * P.swaySpeed;
        tx += Math.sin(s * 0.83) * 0.55 * P.autoSway * maxT;
        ty += Math.sin(s * 0.61 + 1.7) * 0.45 * P.autoSway * maxT;
      }
      if (P.hoverOn && this.mouse.over && P.tiltAmount > 0.001) {
        const nx = (this.mouse.cx - 0.5) * 2;
        const ny = (this.mouse.cy - 0.5) * 2;
        // 两个轴差一个负号 —— 这是上面推导出来的，不是随手写的
        const s = P.tiltInvert ? 1 : -1;
        tx += s * ny * maxT;
        ty += -s * nx * maxT;
      }
      return { x: tx, y: ty };
    }

    updateTilt(dt) {
      const t = this.targetTilt();
      const k = Math.min(1, dt / 0.14);
      this.smoothTilt.x += (t.x - this.smoothTilt.x) * k;
      this.smoothTilt.y += (t.y - this.smoothTilt.y) * k;
    }

    // ---- 单层的 uniform ---------------------------------------------------

    /**
     * 把一层配方发成 uniform。
     * 强度（p0.x）会乘上三样东西：工艺总强度 × 该工艺的倍率参数 × （layerOnly 时的层过滤在外面处理）。
     */
    setLayerUniforms(prog, layer, seed) {
      const P = this.params;
      const multKey = CRAFT_MULT[layer.shader];
      const m = multKey ? P[multKey] : 1;
      const inten = P.intensity * m;

      const p0 = layer.p0.slice();
      const p1 = layer.p1.slice();
      const p2 = layer.p2.slice();
      let col = layer.col.slice();

      p0[0] = p0[0] * inten;

      // 几个"面板上单独可调"的数，直接改写对应槽位
      if (layer.shader === 'emboss') { p0[1] = P.embossAngle; p1[1] = P.embossDetail; }
      if (layer.shader === 'glitter') { p0[1] = P.glitterSize; }
      if (layer.shader === 'stamp') { p0[0] = p0[0] * P.stampAmount; }
      if (layer.shader === 'name' && P.nameTintOn) col = CFG.hexToRgb(P.nameTint);
      if (layer.shader === 'metal' && P.metalTintOn) col = CFG.hexToRgb(P.metalTint);

      const v = this.viewVec();
      const vp = this.viewPoint();

      this.u2f(prog, 'uResolution', this.viewW, this.viewH);
      this.u1f(prog, 'uMargin', this.spec.margin);
      const cu = this.spec.contentUV;
      this.u4f(prog, 'uContent', [cu.x0, cu.y0, cu.x1, cu.y1]);
      this.u1f(prog, 'uTime', this.time);
      this.u2f(prog, 'uView', v[0], v[1]);
      this.u2f(prog, 'uViewPt', vp[0], vp[1]);
      this.u1f(prog, 'uAspect', this.spec.contentAspect);
      // 圆角：参数按**原图像素**给，换算成 cardUV 的归一单位（纹理高 = 1）。
      // 抗锯齿半宽取屏幕上约 1.5px，不然斜边会有硬台阶。
      const texH = Math.max(1, this.spec.height);
      const cardHpx = Math.max(1, (this.cardRect && this.cardRect.h) || texH);
      this.u4f(prog, 'uCardRound', [P.cornerPx / texH, 1.5 / cardHpx, 0, 0]);
      this.u1f(prog, 'uSeed', seed || 0);
      const rr = this.regionRects();
      this.u4f(prog, 'uRectArtOuter', rr.artOuter);
      this.u4f(prog, 'uRectArtInner', rr.artInner);
      this.u4f(prog, 'uRectTextBox', rr.textBox);
      this.u4f(prog, 'uP0', p0);
      this.u4f(prog, 'uP1', p1);
      this.u4f(prog, 'uP2', p2);
      this.u4f(prog, 'uCol', [col[0], col[1], col[2], 1]);
    }

    /**
     * 三块"工艺区域"的矩形（cardUV 坐标 = **整图相对**，x 向右、y 向下，v=0 是上沿）。
     *
     * 默认走侧栏「区域」那组滑条（手调值）；把「手动区域」关掉，就回到烘焙时按每张卡
     * 自动检测、写进 js/card-textures.js 的那份值。
     *
     * 卡名带（nameBand）**不在这里** —— 它的笔画是从图里按暗度抠出来烤进掩膜 R 通道的，
     * 没法用矩形算，所以运行时改不了（也不需要改：顶部卡名实测是对的）。
     */
    regionRects() {
      const P = this.params;
      const baked = this.spec.regions;
      // u4f 是按下标取值的，所以**两条路都得返回数组** ——
      // 烘焙出来的是 {x0,y0,x1,y1} 对象，直接丢给 u4f 会取到 undefined。
      const arr = (r) => [r.x0, r.y0, r.x1, r.y1];
      if (!P.regionManual) {
        return {
          artOuter: arr(baked.artOuter),
          artInner: arr(baked.artInner),
          textBox: arr(baked.textBox)
        };
      }
      const rect = (k) => [P[k + 'X0'], P[k + 'Y0'], P[k + 'X1'], P[k + 'Y1']];
      return {
        artOuter: rect('artOuter'),
        artInner: rect('artInner'),
        textBox: rect('textBox')
      };
    }

    /** 顶点阶段的相机 / 倾斜 */
    setCamera(prog, cx, cy, tiltX, tiltY) {
      this.u2f(prog, 'uResolution', this.viewW, this.viewH);
      this.u2f(prog, 'uCenter', cx, cy);
      this.u2f(prog, 'uTilt', tiltX, tiltY);
      this.u1f(prog, 'uDist', this.viewH * CAM_DIST);
      this.u1f(prog, 'uFocal', this.viewH * CAM_DIST);
    }

    bindQuad(which) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
      gl.bufferData(gl.ARRAY_BUFFER, which === 'screen' ? this.screenVerts : this.cardVerts, gl.STREAM_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    }

    bindTextures(prog) {
      const gl = this.gl;
      this._ensureTextures();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex.card);
      this.u1i(prog, 'uTex', 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.tex.mask);
      this.u1i(prog, 'uMask', 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.tex.stamp);
      this.u1i(prog, 'uStamp', 2);
    }

    /** 画一遍卡片（一个 draw step） */
    pass(name, cx, cy, tiltX, tiltY, extra, additive) {
      const gl = this.gl;
      const prog = this.programs[name];
      if (!prog) throw new Error('没有这个着色器: ' + name);
      gl.useProgram(prog);
      // 纯加光的层（闪粉 / 扫光）走加法混合：它们只输出"多加的光"，
      // 不输出卡面颜色，所以不能按 alpha 去替换底下的画面。
      if (additive) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
      else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.setCamera(prog, cx, cy, tiltX, tiltY);
      this.bindTextures(prog);
      this.bindQuad('card');
      if (extra) extra(prog);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (additive) gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    // ---- 渲染 -------------------------------------------------------------

    render(ts) {
      if (!this.playing) return;
      let dt = 0;
      if (this.lastTs) dt = ((ts - this.lastTs) / 1000) * this.speed;
      this.lastTs = ts;
      dt = Math.min(dt, 1 / 15);
      this.time += dt;
      this.updateTilt(dt);
      this.frame++;
      this.drawFrame();
      this.raf = requestAnimationFrame(this.render);
    }

    /** 定格渲染（给定时间点，可复现）—— 无头验证与截图都走这个 */
    renderAtTime(t) {
      const wasPlaying = this.playing;
      this.stop();
      this.time = t;
      this.frame = 0;
      // 倾斜量直接到位（固定帧必须可复现），而且和实时渲染走同一个函数
      const tt = this.targetTilt();
      this.smoothTilt.x = tt.x; this.smoothTilt.y = tt.y;
      this.drawFrame();
      if (wasPlaying) this.raf = requestAnimationFrame(this.render);
    }

    drawFrame() {
      const gl = this.gl;
      const P = this.params;

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // ---- ① 背景 ----
      if (P.bgOn) {
        const bg = this.programs.bg;
        gl.useProgram(bg);
        this.setCamera(bg, 0, 0, 0, 0);
        this.u2f(bg, 'uResolution', this.viewW, this.viewH);
        this.u1f(bg, 'uMargin', this.spec.margin);
        this.u1f(bg, 'uAspect', this.spec.aspect);
        this.u1f(bg, 'uTime', this.time);
        // 底色亮度 / 暗角都做成参数了。默认那组（底色 ×0.55 的暗端 + 暗角 0.55 双重压暗）
        // 会把画面下方打到 13/255（≈5%）；卡片又大又靠下，于是"卡片下方那圈背景"
        // 看起来就是凭空多出来的一条黑边 —— 而且它是**背景**，不跟着卡片圆角变。
        const bb = P.bgBright;
        this.u4f(bg, 'uCol', [0.090 * bb, 0.104 * bb, 0.142 * bb, 1]);
        this.u4f(bg, 'uP0', [1, P.bgVignette, 0, 0]);
        this.u4f(bg, 'uP1', [P.bgSpin * 1.30, 0, 0, 0]);
        this.u4f(bg, 'uP2', [0, 0, 0, 0]);
        this.bindQuad('screen');
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }

      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      if (P.sheetOn) this.drawSheet();
      else this.drawOne(this.currentRarity(), this.viewW * 0.5, this.viewH * 0.5,
        this.cardSizePx(this.viewH), 0, this.smoothTilt.x, this.smoothTilt.y);

      this.drawOverlay();

      gl.disable(gl.BLEND);
      gl.finish();
    }

    /** 画一张卡：投影 → base → 各工艺层 */
    drawOne(rarityId, cx, cy, quadH, seed, tiltX, tiltY) {
      const gl = this.gl;
      const P = this.params;
      const info = RAR.BY_ID[rarityId];
      const quadW = quadH * this.spec.aspect;

      // ---- ② 投影 ----
      if (P.shadowOn) {
        this.updateCardQuad(cx, cy + this.viewH * SHADOW_DY, quadW * SHADOW_SCALE, quadH * SHADOW_SCALE);
        this.pass('shadow', cx, cy, tiltX, tiltY, (prog) => {
          this.u4f(prog, 'uP0', [SHADOW_ALPHA, SHADOW_BLUR, 0, 0]);
          this.u4f(prog, 'uP1', [0, 0, 0, 0]);
          this.u4f(prog, 'uP2', [0, 0, 0, 0]);
          this.u4f(prog, 'uCol', [0, 0, 0, 1]);
          this.u1f(prog, 'uTime', this.time);
          this.u1f(prog, 'uMargin', this.spec.margin);
        });
      }

      this.updateCardQuad(cx, cy, quadW, quadH);

      // ---- ③ 卡面 base（或掩膜调试）----
      const baseName = P.maskDebug ? 'maskdebug' : 'base';
      this.pass(baseName, cx, cy, tiltX, tiltY, (prog) => {
        this.setLayerUniforms(prog, { shader: 'base', p0: [0, 0, 0, 0], p1: [0, 0, 0, 0], p2: [0, 0, 0, 0], col: [1, 1, 1] }, seed);
      });

      // ---- ④..⑥ 工艺层 ----
      if (!P.maskDebug) {
        const layers = P.layerOnly ? info.layers.slice(0, 1) : info.layers;
        for (const layer of layers) {
          const additive = SH.ADDITIVE.indexOf(layer.shader) >= 0;
          this.pass(layer.shader, cx, cy, tiltX, tiltY, (prog) => {
            this.setLayerUniforms(prog, layer, seed);
          }, additive);
        }
      }
    }

    /** 一览模式：把全部罕贵度铺成一张对照表 */
    drawSheet() {
      const list = RAR.LIST;
      const n = list.length;
      const W = this.viewW, H = this.viewH;
      // 算一个尽量方的网格
      let cols = Math.ceil(Math.sqrt(n * (W / H) / this.spec.aspect * 1.0));
      cols = Math.max(4, Math.min(10, cols));
      const rows = Math.ceil(n / cols);
      const padX = 0.012, padTop = 0.055, padBot = 0.02;
      const cw = (1 - 2 * padX) / cols;
      const chAvail = (1 - padTop - padBot) / rows;
      const quadH = Math.min(chAvail, cw / this.spec.aspect) * 0.92 * H;
      const quadW = quadH * this.spec.aspect;
      const stepX = (W * (1 - 2 * padX)) / cols;
      const stepY = (H * (1 - padTop - padBot)) / rows;

      for (let i = 0; i < n; i++) {
        const r = i % cols, c = Math.floor(i / cols);
        const cx = W * padX + stepX * (r + 0.5);
        const cy = H * padTop + stepY * (c + 0.5);
        // 一览模式下不做 3D 倾斜：格子小，倾斜只会互相打架
        this.drawOne(list[i].id, cx, cy, quadH, (i * 7.13) % 100, 0, 0);
      }
      this._sheetLayout = { cols: cols, rows: rows, stepX: stepX, stepY: stepY, padX: padX, padTop: padTop };
    }

    // ---- 覆盖层（2D canvas）：一览模式的名字标签 / 图案图集 -----------------

    drawOverlay() {
      if (!this.overlay) return;
      const ctx = this.overlay.getContext('2d');
      const dpr = this.overlay.width / Math.max(1, this.cssWidth);
      const W = this.overlay.width, H = this.overlay.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const P = this.params;

      if (P.stampCells && this.stampImage) {
        const cols = global.CardStamps.COLS, rows = global.CardStamps.ROWS;
        const cell = Math.min(W / cols, H / rows) * 0.46;
        const ox = (W - cell * cols) / 2, oy = (H - cell * rows) / 2;
        ctx.fillStyle = 'rgba(8,10,16,0.92)';
        ctx.fillRect(0, 0, W, H);
        ctx.imageSmoothingEnabled = true;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const x = ox + c * cell, y = oy + r * cell;
            ctx.fillStyle = '#1b2030';
            ctx.fillRect(x, y, cell - 2, cell - 2);
            ctx.drawImage(this.stampImage, c * global.CardStamps.CELL, r * global.CardStamps.CELL,
              global.CardStamps.CELL, global.CardStamps.CELL, x, y, cell - 2, cell - 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.25)';
            ctx.strokeRect(x + 0.5, y + 0.5, cell - 3, cell - 3);
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            ctx.font = '600 ' + Math.round(15 * dpr) + 'px system-ui, sans-serif';
            ctx.fillText(global.CardStamps.build().names[r][c], x + 8 * dpr, y + cell - 10 * dpr);
          }
        }
        return;
      }

      if (P.sheetOn && this._sheetLayout) {
        const L = this._sheetLayout;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < RAR.LIST.length; i++) {
          const rr = i % L.cols, cc = Math.floor(i / L.cols);
          const cx = W * L.padX + L.stepX * (rr + 0.5);
          const cy = H * L.padTop + L.stepY * (cc + 0.5);
          const item = RAR.LIST[i];
          const h = L.stepY * 0.92;
          const ty = cy + h * 0.5;
          ctx.font = '700 ' + Math.round(15 * dpr) + 'px system-ui, "Microsoft YaHei", sans-serif';
          ctx.fillStyle = '#eaf0ff';
          ctx.fillText(item.code, cx, ty);
          ctx.font = '500 ' + Math.round(12 * dpr) + 'px system-ui, "Microsoft YaHei", sans-serif';
          ctx.fillStyle = 'rgba(200,214,240,0.72)';
          ctx.fillText(item.cn, cx, ty + 15 * dpr);
        }
      }
    }

    // ---- 取像（供无头验证） -------------------------------------------------

    pixels() {
      const gl = this.gl;
      const w = this.canvas.width, h = this.canvas.height;
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    }

    /** 卡片内容区在画布像素里的框（y 向下，readPixels 原点在左下所以另给一份） */
    cardContentRect() {
      const w = this.canvas.width, h = this.canvas.height;
      const r = this.cardRect;
      const cuv = this.spec.contentUV;
      const x0 = Math.max(0, Math.floor(r.x + r.w * cuv.x0));
      const x1 = Math.min(w, Math.ceil(r.x + r.w * cuv.x1));
      const top = r.y + r.h * cuv.y0;
      const bot = r.y + r.h * cuv.y1;
      const y0 = Math.max(0, Math.floor(h - bot));
      const y1 = Math.min(h, Math.ceil(h - top));
      return { x0: x0, x1: x1, y0: y0, y1: y1, top: top, bot: bot, w: w, h: h };
    }

    _scan(px, w, h) {
      const G = 16;
      const grid = new Float64Array(G * G), cnt = new Float64Array(G * G);
      let sum = 0, min = 255, max = 0, bright = 0, satSum = 0;
      for (let y = 0; y < h; y++) {
        const gy = Math.min(G - 1, (y * G / h) | 0);
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = px[i], g = px[i + 1], b = px[i + 2];
          const v = (r + g + b) / 3;
          sum += v;
          if (v < min) min = v;
          if (v > max) max = v;
          if (v > 120) bright++;
          satSum += Math.max(r, Math.max(g, b)) - Math.min(r, Math.min(g, b));
          const gi = gy * G + Math.min(G - 1, (x * G / w) | 0);
          grid[gi] += v; cnt[gi]++;
        }
      }
      const cells = new Array(G * G);
      for (let i = 0; i < G * G; i++) cells[i] = cnt[i] ? grid[i] / cnt[i] : 0;
      const n = w * h;
      return {
        width: w, height: h, mean: sum / n, min: min, max: max,
        brightRatio: bright / n, satMean: satSum / n, grid: cells
      };
    }

    stats() { return this._scan(this.pixels(), this.canvas.width, this.canvas.height); }

    cardRegionStats() {
      const w = this.canvas.width, h = this.canvas.height;
      const px = this.pixels();
      const b = this.cardContentRect();
      let sum = 0, n = 0, bright = 0, satSum = 0;
      for (let y = b.y0; y < b.y1; y++) {
        for (let x = b.x0; x < b.x1; x++) {
          const i = (y * w + x) * 4;
          const r = px[i], g = px[i + 1], bb = px[i + 2];
          const v = (r + g + bb) / 3;
          sum += v; n++;
          if (v > 120) bright++;
          satSum += Math.max(r, Math.max(g, bb)) - Math.min(r, Math.min(g, bb));
        }
      }
      return {
        x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0, n: n,
        mean: n ? sum / n : 0,
        brightRatio: n ? bright / n : 0,
        satMean: n ? satSum / n : 0
      };
    }

    cardRegionPixels() {
      const w = this.canvas.width, h = this.canvas.height;
      const px = this.pixels();
      const b = this.cardContentRect();
      const cw = Math.max(1, b.x1 - b.x0), ch = Math.max(1, b.y1 - b.y0);
      const out = new Uint8Array(cw * ch * 4);
      for (let y = 0; y < ch; y++) {
        const src = ((b.y0 + y) * w + b.x0) * 4;
        out.set(px.subarray(src, src + cw * 4), y * cw * 4);
      }
      return { data: out, w: cw, h: ch };
    }

    diffPixels(a, b) {
      const n = Math.min(a.length, b.length);
      let sum = 0, cnt = 0, max = 0, changed = 0;
      for (let i = 0; i < n; i++) {
        if ((i & 3) === 3) continue;
        const d = Math.abs(a[i] - b[i]);
        sum += d; cnt++;
        if (d) { changed++; if (d > max) max = d; }
      }
      return {
        meanRGB: cnt ? sum / cnt : 0,
        maxAbs: max,
        changedRatio: n ? changed / (n * 0.75) : 0
      };
    }

    /** 这一帧跑了几个 draw step */
    passCount() {
      const P = this.params;
      if (P.sheetOn) {
        let n = 1;
        for (const r of RAR.LIST) n += 1 + r.layers.length;
        return n;
      }
      let n = 2;                                  // base + 一层
      n += P.layerOnly ? Math.min(1, this.currentRarityInfo().layers.length) : this.currentRarityInfo().layers.length;
      if (P.shadowOn) n++;
      if (P.bgOn) n++;
      return n;
    }

    activeShaders() {
      const P = this.params;
      const out = [P.maskDebug ? 'maskdebug' : 'base'];
      if (P.shadowOn) out.push('shadow');
      if (P.bgOn) out.push('bg');
      if (!P.maskDebug) {
        const layers = P.layerOnly ? this.currentRarityInfo().layers.slice(0, 1) : this.currentRarityInfo().layers;
        for (const l of layers) out.push(l.shader);
      }
      return out;
    }
  }

  global.CardPipeline = {
    CardPipeline: CardPipeline,
    FALLBACK_SPEC: FALLBACK_SPEC,
    TILT_MAX: TILT_MAX
  };
})(window);
