/*
 * card-refresh.js —— 运行时加卡：不跑 node 也能把新图加进「卡图」下拉框
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 「卡图」下拉框列的是 js/card-textures.js 里的 CardTextures.list，而那个文件是
 * tools/embed-card.mjs **扫一遍 images/ 生成**的。页面自己从不去读 images/ 目录，
 * 所以往 images/ 里丢一张新图，下拉框不会有任何反应 —— 必须重跑那个脚本。
 * （README 里"images/ 下有几张就认几张"说的就是重跑之后的结果。）
 *
 * 这个模块把那一步搬到浏览器里：**当场烤**出卡面纹理 + 工艺区域掩膜，
 * 直接追加进 CardTextures，于是新卡立刻出现在下拉框里。
 * 烘焙算法用的是 js/bake.js —— 与 tools/embed-card.mjs **同一份**，不是另写一套。
 *
 * ── 两条路，取决于页面是怎么打开的 ────────────────────────────────────────
 *   http://  → fetch('images/') 读目录索引，自动看出哪些图还没烤过，全自动
 *   file://  → 浏览器**不允许**列目录，而且 file:// 的图会让 canvas 变"脏"、
 *              getImageData 直接抛 SecurityError（整个项目就是为了绕开这条才把
 *              卡图内嵌成 data URI 的）。所以这条路只能让用户**手动选文件**：
 *              FileReader 读成 data URI 再烤 —— 用户主动选的文件不带来源限制。
 *
 * 顺带一提，这也意味着"运行时加的卡"没有 assets/ 归档、没有 SHA-256，
 * 刷新页面就没了（它只活在这一份内存里）—— 要长期留下还是得跑 embed-card.mjs。
 *
 * 经典脚本（非 ES module），file:// 双击可用。
 */
(function (global) {
  'use strict';

  const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
  const TEXSET = global.CardTextures;

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i).toLowerCase();
  }

  /** 文件名 → 卡 id（去掉扩展名、解百分号转义）。与 embed-card.mjs 的口径一致 */
  function idFromName(name) {
    let s = name;
    try { s = decodeURIComponent(name); } catch (e) { /* 名字里有裸 % 就按原样用 */ }
    const i = s.lastIndexOf('.');
    return i < 0 ? s : s.slice(0, i);
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('图片解码失败'));
      img.src = src;
    });
  }

  function readAsDataUrl(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('读取失败：' + file.name));
      fr.readAsDataURL(file);
    });
  }

  /**
   * 扫 images/ 目录。
   * @returns [{ id, file, url }]，**扫不了就返回 null**（file:// 或服务端没开目录索引）
   */
  async function scanImagesDir() {
    // file:// 下 fetch 必然被拦，而且 Chrome 会在控制台甩一条红色的
    // "URL scheme file is not supported" —— 明知不行就别去试，省得吓人。
    if (location.protocol === 'file:') return null;

    let html;
    try {
      // 带 cache-buster：不然浏览器/服务端可能把上一份目录索引喂回来，
      // 刚丢进去的图就"刷新不出来"了 —— 这正是这个按钮要解决的问题。
      const r = await fetch('images/?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('html') < 0) return null;   // 不是目录索引页（比如返回了 404 页）
      html = await r.text();
    } catch (e) {
      return null;                                // 网络/权限问题：当成"扫不了"处理
    }

    const base = new URL('images/', location.href);
    const seen = {};
    const out = [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const clean = href.split('?')[0].split('#')[0];
      // 只取 basename：不同服务端给的 href 有 'foo.jpg' / './foo.jpg' / '/images/foo.jpg'
      // 三种写法，取 basename 再拼回 images/ 就不会出现 images/images/foo.jpg
      const name = clean.slice(clean.lastIndexOf('/') + 1);
      if (!name || IMG_EXT.indexOf(extOf(name)) < 0) return;
      const id = idFromName(name);
      if (seen[id]) return;
      seen[id] = 1;
      // file 存**解码后**的名字：目录索引里给的是 A-to-Z%20Dragon.jpg 这种，
      // 直接拿去显示会在侧栏露出 %20（opts.file 是给人看的，不是给 URL 用的）
      let display = name;
      try { display = decodeURIComponent(name); } catch (e) { /* 裸 % 就按原样 */ }
      out.push({ id: id, file: display, url: new URL(name, base).href });
    });
    return out;
  }

  /** 开一个文件选择框，返回选中的 File[]（用户取消就是空数组） */
  function pickFiles() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
      inp.multiple = true;
      inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0';
      document.body.appendChild(inp);

      let done = false;
      const finish = (files) => {
        if (done) return;
        done = true;
        inp.remove();
        resolve(files);
      };
      inp.addEventListener('change', () => finish(Array.prototype.slice.call(inp.files || [])));
      // 取消时 change 根本不触发，Promise 会永远悬着 —— 用窗口重新拿到焦点兜一下。
      // 时间要给够：真的选完文件时 change 会先到（finish 是幂等的），这个兜底只在
      // "用户按了取消"时才该生效。给太短会在慢机器上把选中的文件当成取消。
      const onFocus = () => setTimeout(() => finish(Array.prototype.slice.call(inp.files || [])), 1200);
      window.addEventListener('focus', onFocus, { once: true });
      inp.click();
    });
  }

  /** 烤一张，返回 card-textures.js 里**一条记录**的形状 */
  async function bakeOne(src, id, file) {
    const img = await loadImage(src);
    // cornerPx: 0 —— 圆角是运行时做的（参数面板「卡片圆角 (px)」→ uCardRound），
    // 跟 embed-card.mjs 的默认口径一致，别在这里多削一道。
    const res = global.CardBake.bakeCard(img, { cornerPx: 0 });
    const entry = global.CardBake.toEntry(res, {
      id: id, file: file, sha256: null, margin: 0
    });
    // 标记：运行时加的，没进 assets/ 归档、没进 hash、刷新页面就没了
    entry.runtime = true;
    return entry;
  }

  function register(entry) {
    if (TEXSET.byId[entry.id]) return false;
    TEXSET.list.push(entry);
    TEXSET.byId[entry.id] = entry;
    TEXSET.order.push(entry.id);
    return true;
  }

  /**
   * 刷新卡图。
   * @param opts { pick: 直接开文件选择框（跳过目录扫描）}
   * @returns {
   *   added:  [id...]              这次加进来的卡
   *   reason: 'scanned' | 'picked' | 'nothing-new' | 'all-known' | 'cancelled' | 'scan-unsupported'
   *   scanned: 目录里一共有几张 | null（没扫成）
   *   failed: [{id, msg}...]       烤失败的
   * }
   */
  async function refresh(opts) {
    opts = opts || {};
    const out = { added: [], reason: '', scanned: null, failed: [] };

    let sources = null;
    if (!opts.pick) {
      const listed = await scanImagesDir();
      if (listed) {
        out.scanned = listed.length;
        const fresh = listed.filter((f) => !TEXSET.byId[f.id]);
        if (!fresh.length) { out.reason = 'nothing-new'; return out; }
        sources = fresh.map((f) => ({ id: f.id, file: f.file, src: f.url }));
      }
    }

    if (!sources) {
      // 扫不了目录（file:// / 没开目录索引），或者用户明确要手动选
      const scanFailed = !opts.pick;
      const files = await pickFiles();
      if (!files.length) {
        out.reason = scanFailed ? 'scan-unsupported' : 'cancelled';
        return out;
      }
      sources = [];
      for (const f of files) {
        const id = idFromName(f.name);
        if (TEXSET.byId[id]) continue;        // 已经有的别再烤一遍
        sources.push({ id: id, file: f.name, src: await readAsDataUrl(f) });
      }
      if (!sources.length) { out.reason = 'all-known'; return out; }
      out.reason = 'picked';
    } else {
      out.reason = 'scanned';
    }

    for (const s of sources) {
      try {
        register(await bakeOne(s.src, s.id, s.file));
        out.added.push(s.id);
      } catch (e) {
        out.failed.push({ id: s.id, msg: e.message });
        console.warn('烘焙失败：' + s.id, e);
      }
    }
    return out;
  }

  global.CardRefresh = {
    refresh: refresh,
    scanImagesDir: scanImagesDir,
    idFromName: idFromName
  };
})(window);
