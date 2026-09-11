/*
 * i18n.js —— 多语言加载器
 *
 * 语言包放在根目录的 Languages/ 下，**每个语言一个 .js 文件**：
 *   Languages/languages.js    语言清单（有哪些语言、显示名）
 *   Languages/zh-CN.js        中文
 *   Languages/en-US.js        English
 *   Languages/ja-JP.js        日本語
 *
 * 每个语言包的结构：
 *   global.CardI18nPack['zh-CN'] = { code: 'zh-CN', name: '中文', texts: { 键: 文案 } }
 *
 * ── 为什么语言包是 .js 而不是 .json ──────────────────────────────────────
 * 隔壁 Three.js-3D-Earth 那个项目用的是 JSON + fetch（那份文档的「附：多语言（i18n）说明」）。
 * 但本项目**双击 index.html 就能跑**是硬要求，而 `fetch('./Languages/zh-CN.json')` 在
 * `file://` 下会被 CORS 拦掉（每个本地文件是独立来源）。所以这里改成 .js 语言包：
 * 用 <script> 动态注入加载，`file://` 与 http 都能用，代价是语言包得写成一句
 * `CardI18nPack['xx'] = {...}` 而不是纯 JSON。
 *
 * 其余机制与那份文档一致：
 *   · localStorage 记住选择
 *   · t(key, vars) 翻译 + {var} 插值
 *   · 缺键自动回退到 zh-CN，再不行返回 key 本身
 *   · 新增语言 = 复制一个语言包改名 + 在 languages.js 里加一行，点「⟳」重载
 *
 * 经典脚本（非 ES module），file:// 双击可用。
 */
(function (global) {
  'use strict';

  const DEFAULT_CODE = 'zh-CN';
  const STORAGE_KEY = 'ygo_card_lang';
  const BASE = 'Languages/';

  let currentCode = DEFAULT_CODE;
  let currentDict = null;
  let fallbackDict = null;
  let available = [];
  let listeners = [];
  let loaded = {};          // code → 已注入过 script
  let pending = null;       // 初始化的 Promise（重复调用返回同一个）

  // ------------------------------------------------------------------ 取值 ----

  function lookup(dict, key) {
    return (dict && Object.prototype.hasOwnProperty.call(dict, key)) ? dict[key] : undefined;
  }

  /** 翻译。缺键 → 回退 zh-CN → 再缺则返回 key 本身。 */
  function t(key, vars) {
    let s = lookup(currentDict, key);
    if (s === undefined) s = lookup(fallbackDict, key);
    if (s === undefined) s = key;
    if (vars) {
      for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    }
    return s;
  }

  /**
   * 带兜底文案的翻译：语言包里没有这个键就用调用方给的默认值。
   * 这样"代码里的中文原文"可以一直留在代码里当最后一道保险 ——
   * 就算一个语言包都没加载成功，界面也不会满屏裸键。
   */
  function tOr(key, fallback, vars) {
    const has = lookup(currentDict, key) !== undefined || lookup(fallbackDict, key) !== undefined;
    return has ? t(key, vars) : (fallback === undefined ? key : fallback);
  }

  /** 语言包里到底有没有这个键（界面用它决定要不要退回代码里的原文） */
  function has(key) {
    return lookup(currentDict, key) !== undefined || lookup(fallbackDict, key) !== undefined;
  }

  function getCode() { return currentCode; }
  function getLanguages() { return available.slice(); }

  function onChange(fn) { listeners.push(fn); return fn; }
  function notify() { for (const fn of listeners) { try { fn(currentCode); } catch (e) { console.error(e); } } }

  // ------------------------------------------------------------------ 加载 ----

  function packs() { return global.CardI18nPack || {}; }

  /** 注入一个语言包的 <script>（file:// 下也能用；fetch JSON 不行） */
  function inject(code) {
    if (loaded[code]) return Promise.resolve();
    loaded[code] = true;
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = BASE + code + '.js';
      s.onload = () => resolve();
      // 文件不存在不该让整个应用挂掉：记一笔，继续
      s.onerror = () => { console.warn('语言包加载失败：' + s.src); resolve(); };
      document.head.appendChild(s);
    });
  }

  /** 语言清单：languages.js 里的 CardLangs；没有就退化成"只有 zh-CN" */
  function manifest() {
    const m = global.CardLangs;
    if (Array.isArray(m) && m.length) return m.slice();
    return [{ code: DEFAULT_CODE, name: '中文' }];
  }

  function applyStaticText() {
    document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.getAttribute('data-i18n-title')); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((n) => { n.placeholder = t(n.getAttribute('data-i18n-placeholder')); });
    const html = document.documentElement;
    if (html) html.setAttribute('lang', currentCode);
  }

  /** 加载某个语言到当前内容（不触发通知） */
  async function loadLang(code) {
    if (!packs()[code]) await inject(code);
    const data = packs()[code];
    if (!data || !data.texts) throw new Error('语言包格式无效: ' + code);
    currentCode = code;
    currentDict = data.texts;
    for (let i = 0; i < available.length; i++) {
      if (available[i].code === code) available[i].name = data.name || code;
    }
  }

  /** 初始化：读记忆 → 装载清单里的语言包 → 应用静态文案 → 通知 */
  function init() {
    if (pending) return pending;
    pending = (async () => {
      let want = DEFAULT_CODE;
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) want = saved;
      } catch (e) { /* 无 localStorage（隐私模式等） */ }

      available = manifest();
      // 语言包是**并行**注入的：每个都是独立 <script>，没有顺序依赖
      await Promise.all(available.map((l) => inject(l.code)));

      // 兜底字典：永远先把 zh-CN 装上
      if (!packs()[DEFAULT_CODE]) await inject(DEFAULT_CODE);
      fallbackDict = (packs()[DEFAULT_CODE] || {}).texts || null;

      // 记忆里的语言可能在清单里已经没有了
      if (!packs()[want]) want = DEFAULT_CODE;
      try {
        await loadLang(want);
      } catch (e) {
        currentCode = DEFAULT_CODE;
        currentDict = fallbackDict;
      }

      applyStaticText();
      notify();
      return currentCode;
    })();
    return pending;
  }

  /** 切换语言；成功返回 true */
  async function setLang(code) {
    try {
      await loadLang(code);
    } catch (e) {
      console.warn(e.message);
      return false;
    }
    try { localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* 忽略 */ }
    applyStaticText();
    notify();
    return true;
  }

  global.CardI18n = {
    t: t,
    tOr: tOr,
    has: has,
    getCode: getCode,
    getLanguages: getLanguages,
    onChange: onChange,
    init: init,
    setLang: setLang,
    applyStaticText: applyStaticText,
    DEFAULT_CODE: DEFAULT_CODE,
    STORAGE_KEY: STORAGE_KEY
  };
})(window);
