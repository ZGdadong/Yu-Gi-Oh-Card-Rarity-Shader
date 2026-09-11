/*
 * ui.js —— 把管线接上界面
 *
 * 四块东西：
 *   左侧列表  选罕贵度（按文档的五个分节分组），条目右边那个小标签标出
 *             "与某个罕贵度同工艺"（NR = N、DT 系列 = OCG 同名、韩文/亚英 = 借用配方）
 *   说明条    当前罕贵度的"特征"（文档原话）与"怎么做的"（对应到哪几个着色器）
 *             可以折叠（▾）—— 折叠状态记在 localStorage 里
 *   参数面板  由 js/config.js 的 SPEC 自动生成，不用手写 HTML
 *   右上角    预设下拉 + 语言下拉
 *
 * ── 文案全部走 i18n（js/i18n.js）─────────────────────────────────────────
 * 代码里保留的中文是**最后一道保险**：用 `I18N.tOr(键, 原文)` 取，
 * 语言包里没有这个键就显示代码里这句，一个语言包都加载失败也不会满屏裸键。
 *
 * 经典脚本（非 ES module），file:// 双击可用。
 */
(function (global) {
  'use strict';

  const CFG = global.CardConfig;
  const RAR = global.CardRarities;
  const I18N = global.CardI18n;
  const CARDS = global.CardTextures;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined) n.textContent = txt;
    return n;
  };
  const t = (k, v) => I18N.t(k, v);
  const tOr = (k, fallback, v) => I18N.tOr(k, fallback, v);

  /**
   * 说明文字里用了 **粗体** 与 `代码` 两种写法（写在 js/rarities.js 与语言包里）。
   * 先转义再替换，避免把说明文字当 HTML 执行。
   */
  function rich(txt) {
    return String(txt)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  }

  const SEL_CSS = 'background:#0e1524;color:#d8e4f8;border:1px solid #1e2a42;border-radius:5px;' +
    'padding:3px 6px;font:inherit;font-size:11.5px;max-width:160px';
  const INFO_KEY = 'ygo_info_collapsed';

  let pipeline = null;

  // ------------------------------------------------------------------ 启动 ----

  function boot() {
    // 先把语言装好再建界面：面板的 label/hint、列表的名字都要拿翻译
    I18N.init().then(() => {
      const glCanvas = $('gl');
      const overlay = $('overlay');
      try {
        pipeline = new global.CardPipeline.CardPipeline(glCanvas, overlay);
        window.cardShader = pipeline;
      } catch (e) {
        $('status').textContent = t('status.initFail', { msg: e.message });
        console.error(e);
        return;
      }

      // ---- 解码纹理：每张卡的卡面 + 掩膜，加一张图案图集（全是 data URI，file:// 下干净）----
      const stamps = global.CardStamps.build();
      const load = (uri) => new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error('纹理解码失败'));
        img.src = uri;
      });

      const jobs = CARDS.list.map((c) => Promise.all([load(c.dataUri), load(c.maskUri)])
        .then(([card, mask]) => ({ id: c.id, card: card, mask: mask })));
      jobs.push(load(stamps.dataUri));

      Promise.all(jobs).then((res) => {
        const stampImg = res.pop();
        const byId = {};
        for (const r of res) byId[r.id] = { card: r.card, mask: r.mask };
        pipeline.attachImages(byId, stampImg);

        applyHash(pipeline);
        buildAll(pipeline);
        wire(pipeline);

        pipeline.onParamsChanged = () => {
          syncPanel(pipeline);
          syncInfo(pipeline);
          writeHash(pipeline);
        };

        resize(pipeline);
        watchStage(pipeline);
        pipeline.start();
        syncPanel(pipeline);
        syncInfo(pipeline);
        applyInfoCollapsed();
        global.__ready = true;
      }).catch((e) => {
        $('status').textContent = t('status.texFail', { msg: e.message });
        console.error(e);
      });
    });
  }

  function resize(p) {
    const stage = $('stage');
    const r = stage.getBoundingClientRect();
    p.resize(r.width, r.height, Math.min(window.devicePixelRatio || 1, 2));
  }

  /**
   * 画布要跟着**舞台**的尺寸走，而不是跟着窗口。
   *
   * 只监听 window 的 resize 是不够的 —— 打开参数面板（CSS grid 多出一列 312px）
   * 时 stage 变窄了、画布却还是原来的尺寸，CSS 把大画布**缩着显示**，
   * 观感就是"一开面板卡片就变小了"（而且糊）。
   * ResizeObserver 能看见任何布局变化：面板开合、说明条折叠、侧栏变宽、窗口缩放。
   */
  function watchStage(p) {
    if (typeof ResizeObserver !== 'function') return null;
    const ro = new ResizeObserver(() => {
      resize(p);
      if (p.playing === false) p.renderAtTime(p.time);
    });
    ro.observe($('stage'));
    return ro;
  }

  // -------------------------------------------------- 建界面（切语言时整块重建）----

  function buildAll(p) {
    buildLangSelect();
    buildPresets(p);
    buildRarityList(p);
    buildPanel(p);
    syncCardMini(p);
  }

  function buildLangSelect() {
    const sel = $('sel-lang');
    sel.innerHTML = '';
    const langs = I18N.getLanguages();
    for (const l of langs) {
      const o = el('option', null, l.name);
      o.value = l.code;
      sel.appendChild(o);
    }
    if (!langs.some((l) => l.code === I18N.getCode())) {
      const o = el('option', null, I18N.getCode());
      o.value = I18N.getCode();
      sel.appendChild(o);
    }
    sel.value = I18N.getCode();
    sel.onchange = async () => {
      const ok = await I18N.setLang(sel.value);
      if (!ok) { sel.value = I18N.getCode(); return; }
      buildAll(pipeline);
      syncPanel(pipeline);
      syncInfo(pipeline);
      syncPlayBtn(pipeline);
    };
  }

  function buildRarityList(p) {
    const nav = $('rarity-list');
    nav.innerHTML = '';
    for (const tier of Object.keys(RAR.TIERS)) {
      const items = RAR.LIST.filter((r) => r.tier === tier);
      if (!items.length) continue;
      nav.appendChild(el('div', 'tier-head', tOr('tier.' + tier, RAR.TIERS[tier])));
      for (const r of items) {
        const idx = RAR.ORDER.indexOf(r.id);
        const b = el('button', 'ritem');
        b.dataset.rarity = String(idx);
        b.appendChild(el('span', 'rcode', tOr('rarity.' + r.id + '.code', r.code)));
        b.appendChild(el('span', 'rcn', tOr('rarity.' + r.id + '.short', r.cn)));
        if (r.like) {
          const tag = el('span', 'rtag' + (r.id === 'NR' ? ' soft' : ''),
            t('status.sameAs', { code: RAR.BY_ID[r.like].code }));
          b.appendChild(tag);
        }
        b.addEventListener('click', () => pipeline.setParam('rarity', idx));
        nav.appendChild(b);
      }
    }
  }

  function syncInfo(p) {
    const info = p.currentRarityInfo();
    $('info-code').textContent = tOr('rarity.' + info.id + '.code', info.code);
    $('info-cn').textContent = tOr('rarity.' + info.id + '.short', info.cn);
    $('info-en').textContent = tOr('rarity.' + info.id + '.full', info.en);
    $('info-feat').innerHTML = rich(tOr('rarity.' + info.id + '.feat', info.feat));

    // "怎么做的"：like 那段说明也要带上，免得看的人以为漏了解释
    let txt = info.render || '';
    if (info.like_note) txt = info.like_note + ' ' + txt;
    $('info-render').innerHTML = rich(tOr('rarity.' + info.id + '.render', txt));

    const box = $('info-layers');
    box.innerHTML = '';
    for (const s of p.activeShaders()) box.appendChild(el('span', 'sh', s));

    const cur = Math.round(p.params.rarity);
    document.querySelectorAll('#rarity-list .ritem').forEach((n) => {
      n.classList.toggle('active', Number(n.dataset.rarity) === cur);
    });
  }

  /**
   * 侧栏那张"当前卡"的小卡片。
   * 卡名/副标题/属性行都走 i18n（键 `card.<图片名>.name` / `.sub` / `.stats`），
   * 语言包里没有就退回文件名 —— 所以**丢一张新图进 images/ 不会让这里变成空白**。
   */
  function syncCardMini(p) {
    const spec = p.spec;
    const key = 'card.' + spec.id + '.';
    $('card-name').textContent = tOr(key + 'name', spec.id);
    const sub = I18N.has(key + 'sub') ? t(key + 'sub') : (spec.file || '');
    const stats = I18N.has(key + 'stats') ? t(key + 'stats') : '';
    $('card-sub').textContent = sub;
    $('card-stats').textContent = stats;
    $('card-sub').style.display = sub ? '' : 'none';
    $('card-stats').style.display = stats ? '' : 'none';
  }

  function buildPresets(p) {
    const sel = $('sel-preset');
    sel.innerHTML = '';
    const none = el('option', null, t('topbar.custom'));
    none.value = '-1';
    sel.appendChild(none);
    CFG.PRESETS.forEach((preset, i) => {
      const o = el('option', null, tOr('preset.' + i, preset.name));
      o.value = String(i);
      sel.appendChild(o);
    });
    sel.onchange = () => {
      const i = Number(sel.value);
      if (i < 0) return;
      p.resetParams();
      p.setParams(CFG.PRESETS[i].patch);
      sel.blur();
    };
  }

  function syncPresetSelect(p) {
    const sel = $('sel-preset');
    const cur = p.getParams();
    let hit = '-1';
    for (let i = 0; i < CFG.PRESETS.length; i++) {
      const patch = CFG.PRESETS[i].patch;
      let ok = true;
      for (const k of Object.keys(patch)) {
        if (String(cur[k]) !== String(patch[k])) { ok = false; break; }
      }
      if (ok) { hit = String(i); break; }
    }
    sel.value = hit;
  }

  // ------------------------------------------------------------------ 面板 ----

  function buildPanel(p) {
    const body = $('panel-body');
    body.innerHTML = '';
    for (const g of CFG.GROUPS) {
      const box = el('div', 'pgroup');
      box.appendChild(el('div', 'pgroup-h', tOr('group.' + g, g)));
      for (const sp of CFG.SPEC) {
        if (sp.group !== g) continue;
        box.appendChild(paramRow(p, sp));
      }
      body.appendChild(box);
    }
  }

  function paramRow(p, sp) {
    const row = el('div', 'prow');
    row.dataset.key = sp.key;
    const label = tOr('p.' + sp.key + '.label', sp.label);
    const hint = sp.hint ? tOr('p.' + sp.key + '.hint', sp.hint) : '';

    if (sp.type === 'check') {
      const top = el('div', 'prow-top');
      const lab = el('label', 'plabel');
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.dataset.key = sp.key;
      inp.addEventListener('change', () => p.setParam(sp.key, inp.checked ? 1 : 0));
      lab.appendChild(inp);
      lab.appendChild(document.createTextNode(label));
      top.appendChild(lab);
      row.appendChild(top);
    } else if (sp.type === 'color') {
      const top = el('div', 'prow-top');
      top.appendChild(el('span', 'plabel', label));
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.dataset.key = sp.key;
      inp.addEventListener('input', () => p.setParam(sp.key, inp.value));
      top.appendChild(inp);
      row.appendChild(top);
    } else if (sp.type === 'card') {
      // 卡图选择：images/ 下有几张就列几张
      const top = el('div', 'prow-top');
      top.appendChild(el('span', 'plabel', label));
      const sel = document.createElement('select');
      sel.dataset.key = sp.key;
      sel.style.cssText = SEL_CSS;
      CARDS.list.forEach((c, i) => {
        const o = el('option', null, I18N.has('card.' + c.id + '.name') ? t('card.' + c.id + '.name') : c.id);
        o.value = String(i);
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => p.setParam(sp.key, Number(sel.value)));
      top.appendChild(sel);
      row.appendChild(top);
    } else if (sp.type === 'select') {
      const top = el('div', 'prow-top');
      top.appendChild(el('span', 'plabel', label));
      const sel = document.createElement('select');
      sel.dataset.key = sp.key;
      sel.style.cssText = SEL_CSS;
      RAR.LIST.forEach((r, i) => {
        const o = el('option', null, tOr('rarity.' + r.id + '.code', r.code) + ' · ' + tOr('rarity.' + r.id + '.short', r.cn));
        o.value = String(i);
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => p.setParam(sp.key, Number(sel.value)));
      top.appendChild(sel);
      row.appendChild(top);
    } else {
      const top = el('div', 'prow-top');
      top.appendChild(el('span', 'plabel', label));
      const val = document.createElement('input');
      val.type = 'number';
      val.className = 'pval pnum';
      val.min = String(sp.min);
      val.max = String(sp.max);
      val.step = String(sp.step);
      val.dataset.val = sp.key;
      // 读数做成**可键入**的数字框：step=0.0001 时滑条一共 10000 步，
      // 1 像素就跨 ~50 步，光靠拖根本打不准 0.1800 这种值。
      const commit = () => {
        const n = Number(val.value);
        if (val.value !== '' && !isNaN(n)) p.setParam(sp.key, n);
        syncPanel(p);
      };
      val.addEventListener('change', commit);
      val.addEventListener('blur', commit);
      top.appendChild(val);
      row.appendChild(top);
      const inp = document.createElement('input');
      inp.type = 'range';
      inp.min = String(sp.min);
      inp.max = String(sp.max);
      inp.step = String(sp.step);
      inp.dataset.key = sp.key;
      inp.addEventListener('input', () => p.setParam(sp.key, Number(inp.value)));
      row.appendChild(inp);
    }

    // 提示里的 ** 是给文档用的，面板里不需要
    if (hint) row.appendChild(el('div', 'phint', hint.replace(/\*\*/g, '')));
    return row;
  }

  /** 面板读数 ←→ 参数（两个方向都要通：面板改动、hash/预设/切卡改动） */
  function syncPanel(p) {
    const P = p.getParams();
    const body = $('panel-body');
    body.querySelectorAll('input,select').forEach((inp) => {
      const k = inp.dataset.key;
      if (!k || !(k in P)) return;
      const sp = CFG.BY_KEY[k];
      if (sp.type === 'check') inp.checked = !!P[k];
      else if (sp.type === 'color') inp.value = P[k];
      else if (document.activeElement !== inp) inp.value = String(P[k]);
    });
    body.querySelectorAll('.pval').forEach((v) => {
      const k = v.dataset.val;
      const sp = CFG.BY_KEY[k];
      if (!sp) return;
      // 小数位数跟着 step 走（CFG.decimalsOf）—— 以前这里写死 Math.round(v*100)/100，
      // 于是「区域」那组 step=0.0001 的参数永远只显示 0.18，0.183 和 0.188 看着一模一样。
      const txt = typeof P[k] === 'number' ? P[k].toFixed(CFG.decimalsOf(sp)) : String(P[k]);
      if (v.tagName === 'INPUT') { if (document.activeElement !== v) v.value = txt; }
      else v.textContent = txt;
    });
    syncPresetSelect(p);
    syncCardMini(p);
    $('status').textContent = t('status.passes', { a: p.activeShaders().length, b: p.passCount() });
  }

  // ------------------------------------------------------------------ 交互 ----

  function applyInfoCollapsed() {
    let on = false;
    try { on = localStorage.getItem(INFO_KEY) === '1'; } catch (e) { /* 忽略 */ }
    $('info').classList.toggle('collapsed', on);
    $('btn-info-toggle').textContent = on ? '▸' : '▾';
  }

  function wire(p) {
    const glCanvas = $('gl');

    glCanvas.addEventListener('mousemove', (e) => {
      const r = glCanvas.getBoundingClientRect();
      p.setMouse(e.clientX - r.left, e.clientY - r.top);
    });
    glCanvas.addEventListener('mouseleave', () => p.setMouseOutside());
    glCanvas.addEventListener('touchmove', (e) => {
      if (!e.touches.length) return;
      const r = glCanvas.getBoundingClientRect();
      p.setMouse(e.touches[0].clientX - r.left, e.touches[0].clientY - r.top);
      e.preventDefault();
    }, { passive: false });
    glCanvas.addEventListener('touchend', () => p.setMouseOutside());

    $('btn-play').addEventListener('click', () => togglePlay(p));
    $('btn-reset').addEventListener('click', () => { p.reset(); p.setPlaying(true); syncPlayBtn(p); });
    $('btn-panel').addEventListener('click', () => $('app').classList.toggle('panel-open'));
    $('btn-panel-close').addEventListener('click', () => $('app').classList.remove('panel-open'));

    $('btn-info-toggle').addEventListener('click', () => {
      const on = !$('info').classList.contains('collapsed');
      $('info').classList.toggle('collapsed', on);
      $('btn-info-toggle').textContent = on ? '▸' : '▾';
      try { localStorage.setItem(INFO_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ }
      // 说明条高度变了 → 舞台高度也变了，ResizeObserver 会把画布跟着调好
    });

    // 语言包可能是新丢进来的：重载页面即可重新扫 Languages/
    $('btn-lang-reload').addEventListener('click', () => location.reload());

    $('btn-link').addEventListener('click', () => {
      const url = location.href.split('#')[0] + '#' + CFG.encode(p.getParams());
      if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
      $('status').textContent = t('status.copied', { n: url.length });
    });

    document.addEventListener('keydown', (e) => {
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(p); }
      else if (e.key === 'r' || e.key === 'R') { p.reset(); syncPlayBtn(p); }
      else if (e.key === 'p' || e.key === 'P') $('app').classList.toggle('panel-open');
      else if (e.key === 'm' || e.key === 'M') p.setParam('maskDebug', p.params.maskDebug ? 0 : 1);
    });

    window.addEventListener('resize', () => {
      resize(p);
      if (!p.playing) p.renderAtTime(p.time);
    });

    window.addEventListener('hashchange', () => {
      p.params = CFG.decode(location.hash);
      p.setScale(p.params.scale);
      p.setCard(p.params.card);
      p.onParamsChanged && p.onParamsChanged(p.params);
    });
  }

  function togglePlay(p) {
    p.setPlaying(!p.playing);
    syncPlayBtn(p);
  }
  function syncPlayBtn(p) {
    $('btn-play').textContent = p.playing ? t('topbar.pause') : t('topbar.play');
  }

  // ------------------------------------------------------------------ hash ----

  function applyHash(p) {
    if (location.hash && location.hash.length > 1) {
      p.params = CFG.decode(location.hash);
      p.scale = p.params.scale;
      p.setCard(p.params.card);
    }
    syncPlayBtn(p);
  }

  let hashTimer = 0;
  function writeHash(p) {
    if (hashTimer) return;
    hashTimer = setTimeout(() => {
      hashTimer = 0;
      const h = '#' + CFG.encode(p.getParams());
      if (location.hash !== h) {
        try { history.replaceState(null, '', h); } catch (e) { location.hash = h; }
      }
    }, 120);
  }

  global.cardShaderUI = {
    boot: boot,
    syncPanel: syncPanel,
    syncInfo: syncInfo,
    // 把画布重新对齐到舞台尺寸（无头验证里量布局用；面板开合走的是 ResizeObserver）
    fitToStage: function () { resize(window.cardShader); },
    // 切语言（无头验证里用；界面上是语言下拉框自己调）
    setLang: async function (code) {
      const ok = await I18N.setLang(code);
      if (ok) { buildAll(pipeline); syncPanel(pipeline); syncInfo(pipeline); syncPlayBtn(pipeline); }
      return ok;
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
