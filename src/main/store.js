'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 轻量 JSON 持久化。
 * 写入采用「临时文件 + 原子重命名」，避免断电/崩溃时文件半截损坏。
 */
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'store.json');
    this.cache = null;
    this.defaults = {
      version: 1,
      books: [],
      progress: {},
      bookmarks: {},
      settings: {
        theme: 'day',
        skin: 'minimal',
        background: 'none',
        bgImage: '',
        bgOpacity: 0.18,
        customBgColor: '#ffffff',

        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        customFonts: [],
        fontSize: 19,
        lineHeight: 1.8,
        letterSpacing: 0.02,
        paragraphSpacing: 0.9,
        paragraphIndent: 2,
        textAlign: 'justify',
        fontWeight: 400,

        marginTop: 64,
        marginBottom: 64,
        marginLeft: 88,
        marginRight: 88,
        contentWidth: 0,

        pageMode: 'page',
        pageAnimation: 'slide',
        pageAnimationDuration: 260,
        scrollSpeed: 42,
        autoTurnInterval: 20,
        autoTurnEnabled: false,

        brightness: 1,
        eyeCareLevel: 0.5,
        contrastAuto: true,

        bossHotkey: 'Alt+`',
        bossMode: 'fake-word',
        bossStyle: 'square',
        bossOpacity: 0.9,
        bossAlwaysOnTop: true,
        bossMute: true,
        miniBoxSize: 300,

        bookSort: 'recent',
        bookGroup: 'all',
        showProgressRing: true,
        introSound: false,
      },
    };
  }

  ensureDir() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  /** 深合并，保证新增设置项在旧数据上也有默认值 */
  static merge(base, patch) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!patch || typeof patch !== 'object') return out;
    for (const key of Object.keys(patch)) {
      const bv = base ? base[key] : undefined;
      const pv = patch[key];
      if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
        out[key] = Store.merge(bv, pv);
      } else if (pv !== undefined) {
        out[key] = pv;
      }
    }
    return out;
  }

  load() {
    if (this.cache) return this.cache;
    this.ensureDir();
    let raw = null;
    if (fs.existsSync(this.file)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (err) {
        // 主文件损坏时尝试从备份恢复，避免整库丢失
        const bak = this.file + '.bak';
        if (fs.existsSync(bak)) {
          try {
            raw = JSON.parse(fs.readFileSync(bak, 'utf8'));
          } catch (_) {
            raw = null;
          }
        }
      }
    }
    this.cache = Store.merge(this.defaults, raw || {});
    this.healSettings(this.cache.settings);
    return this.cache;
  }

  /**
   * 自愈：修正指向「已不存在的内置字体」的阅读设置。
   *
   * 场景：内置字体换代（例如毛笔体换成硬笔体）后，老用户的 store.json 里
   * 仍存着 '"Long Cang", "KaiTi", cursive' 这样的字体栈。该字族已随版本移除，
   * 浏览器会静默回退到栈里下一个族，而界面上还显示着旧名字 ——
   * 用户既不知道字体没生效，也找不到原因。
   *
   * 处理策略（分级，避免误伤）：
   *   · 字体栈的**首选**（第一个非通用族）已退役 → 直接重置为默认字体。
   *     首选已失效就说明用户的意图落空了，保留它只会让界面显示一个不存在的字体名。
   *   · 全部候选都退役 → 同样重置。
   *   · 其余情况（首选仍然有效）→ 完全不动。
   *
   * 这样可以放心地不碰用户自己导入的字体，以及仍然有效的系统字体。
   */
  healSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    this.healMargins(settings);
    this.healFonts(settings);
  }

  /**
   * 自愈：让左右页边距恢复对称。
   *
   * 场景：设置页的"左右边距"滑杆曾只把新值写进 marginRight，
   * 绑定的 marginLeft 由滑杆内部另写一次 —— 两者从此失配
   * （实测用户配置里 marginLeft=88 / marginRight=40）。
   * 表现是正文明显偏向一侧，而用户在界面上看到的只是一个"左右边距"数字，
   * 完全想不到左右可以不一致。
   *
   * 处理：变量本身就只暴露"左右"一个概念，两者必须相等。
   * 取较大的那个作为统一值（宁多留白，不少留），差值很小则直接归到左边距。
   */
  healMargins(settings) {
    const l = Number(settings.marginLeft);
    const r = Number(settings.marginRight);
    if (!Number.isFinite(l) || !Number.isFinite(r)) return;
    if (l === r) return;

    const unified = Math.max(l, r);
    settings.marginLeft = unified;
    settings.marginRight = unified;
    settings.marginHealed = true;
    settings.marginHealedFrom = { left: l, right: r };
  }

  healFonts(settings) {
    const RETIRED = [
      'Ma Shan Zheng',
      'Long Cang',
      'LXGW WenKai',      // 注意：精确匹配，不能误伤 "LXGW WenKai Lite"
    ];
    const ff = String(settings.fontFamily || '');
    if (!ff) return;

    const GENERIC = /^(serif|sans-serif|monospace|cursive|system-ui|inherit|initial)$/i;
    // 拆出字体栈里的每个族名（去引号、去空白）
    const families = ff.split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);

    const isRetired = (name) => RETIRED.some((r) => name === r);

    // 具体的字体族（排除 serif 这类通用兜底）
    const concrete = families.filter((f) => !GENERIC.test(f));
    if (!concrete.length) return;

    const primaryRetired = isRetired(concrete[0]);
    const allRetired = concrete.every(isRetired);
    if (!primaryRetired && !allRetired) return;

    settings.fontFamily = this.defaults.settings.fontFamily;
    settings.fontFamilyHealed = true;
    settings.fontFamilyHealedFrom = ff;
  }

  save() {
    this.ensureDir();
    const data = this.cache || this.load();
    const tmp = this.file + '.tmp';
    const bak = this.file + '.bak';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    if (fs.existsSync(this.file)) {
      try { fs.copyFileSync(this.file, bak); } catch (_) {}
    }
    fs.renameSync(tmp, this.file);
    return true;
  }

  get(key) {
    const d = this.load();
    return key ? d[key] : d;
  }

  set(key, value) {
    const d = this.load();
    d[key] = value;
    this.save();
    return d[key];
  }

  patchSettings(patch) {
    const d = this.load();
    d.settings = Store.merge(d.settings, patch);
    this.save();
    return d.settings;
  }

  update(fn) {
    const d = this.load();
    const res = fn(d);
    this.save();
    return res;
  }
}

function defaultDataDir(appDataPath, isDev) {
  const base = appDataPath || path.join(os.homedir(), '.firmament');
  return path.join(base, isDev ? 'FirmamentDev' : 'Firmament');
}

module.exports = { Store, defaultDataDir };