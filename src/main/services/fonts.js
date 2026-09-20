'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * 字体服务。
 *
 * 核心原则：**只展示真实可用的字体**。
 * 硬编码一个字体列表是最常见的坑——用户机器上没装「华文行楷」，
 * 点了没反应，用户就认为「这软件的换字体功能是坏的」。
 *
 * 三级策略：
 *   1. 候选清单（curated）—— 覆盖宋体/黑体/楷体/圆体/手写体等用户真正关心的
 *   2. 系统枚举 —— Windows 读注册表，macOS/Linux 走 fc-list，标记真实安装情况
 *   3. 渲染层 canvas 宽度比对 —— 最终裁决（能处理注册表与实际渲染不一致的情况）
 */

/** 候选字体清单：label 是展示名，family 是 CSS font-family，fallback 是同族兜底 */
const CURATED = [
  // —— 内置硬笔手写体（随应用分发，任何机器都可用）——
  // 说明：只收硬笔（钢笔/签字笔）风格。毛笔体笔触过粗、字形夸张，
  //       用作正文长时间阅读很累，故不收录。
  { key: 'builtin-wenkai', label: '霞鹜文楷（内置·钢笔楷书）', family: '"LXGW WenKai Lite", "LXGW WenKai", "KaiTi", serif', group: '内置手写', probe: 'LXGW WenKai Lite', builtin: true },
  { key: 'builtin-xiaowei', label: '站酷小薇（内置·签字笔细楷）', family: '"ZCOOL XiaoWei", "KaiTi", serif', group: '内置手写', probe: 'ZCOOL XiaoWei', builtin: true },
  { key: 'builtin-zhimang', label: '志莽行书（内置·钢笔行书）', family: '"Zhi Mang Xing", "KaiTi", cursive', group: '内置手写', probe: 'Zhi Mang Xing', builtin: true },
  { key: 'builtin-qingke', label: '站酷庆科黄油（内置·硬笔圆体）', family: '"ZCOOL QingKe HuangYou", "Microsoft YaHei", sans-serif', group: '内置圆体', probe: 'ZCOOL QingKe HuangYou', builtin: true },
  { key: 'builtin-zcool', label: '站酷快乐体（内置圆体）', family: '"ZCOOL KuaiLe", "Microsoft YaHei", sans-serif', group: '内置圆体', probe: 'ZCOOL KuaiLe', builtin: true },

  // —— 中文常用（衬线 / 宋体系）
  { key: 'simsun', label: '宋体', family: '"SimSun", "Songti SC", "Noto Serif CJK SC", serif', group: '中文常用', probe: 'SimSun' },
  { key: 'nsimsun', label: '新宋体', family: '"NSimSun", "SimSun", serif', group: '中文常用', probe: 'NSimSun' },
  { key: 'fangsong', label: '仿宋', family: '"FangSong", "STFangsong", serif', group: '中文常用', probe: 'FangSong' },
  { key: 'songti-sc', label: '宋体-简（Mac）', family: '"Songti SC", "Source Han Serif SC", serif', group: '中文常用', probe: 'Songti SC' },

  // —— 中文常用（无衬线 / 黑体系）
  { key: 'msyh', label: '微软雅黑', family: '"Microsoft YaHei", "PingFang SC", sans-serif', group: '中文常用', probe: 'Microsoft YaHei' },
  { key: 'simhei', label: '黑体', family: '"SimHei", "Heiti SC", sans-serif', group: '中文常用', probe: 'SimHei' },
  { key: 'dengxian', label: '等线', family: '"DengXian", "Microsoft YaHei", sans-serif', group: '中文常用', probe: 'DengXian' },
  { key: 'pingfang', label: '苹方（Mac）', family: '"PingFang SC", "Microsoft YaHei", sans-serif', group: '中文常用', probe: 'PingFang SC' },
  { key: 'source-han-sans', label: '思源黑体', family: '"Source Han Sans SC", "Noto Sans CJK SC", sans-serif', group: '中文常用', probe: 'Source Han Sans SC' },
  { key: 'source-han-serif', label: '思源宋体', family: '"Source Han Serif SC", "Noto Serif CJK SC", serif', group: '中文常用', probe: 'Source Han Serif SC' },

  // —— 圆体
  { key: 'youyuan', label: '幼圆', family: '"YouYuan", "Microsoft YaHei", sans-serif', group: '圆体', probe: 'YouYuan' },
  { key: 'yuanti', label: '圆体-简（Mac）', family: '"Yuanti SC", "YouYuan", sans-serif', group: '圆体', probe: 'Yuanti SC' },

  // —— 手写体（系统装的）
  { key: 'stxingkai', label: '华文行楷', family: '"STXingkai", "KaiTi", cursive', group: '手写体', probe: 'STXingkai' },
  { key: 'stxinwei', label: '华文新魏', family: '"STXinwei", "KaiTi", cursive', group: '手写体', probe: 'STXinwei' },
  { key: 'stcaiyun', label: '华文彩云', family: '"STCaiyun", "KaiTi", cursive', group: '手写体', probe: 'STCaiyun' },
  { key: 'stliti', label: '华文隶书', family: '"STLiti", "KaiTi", cursive', group: '手写体', probe: 'STLiti' },
  { key: 'fzshuti', label: '方正舒体', family: '"FZShuTi", "KaiTi", cursive', group: '手写体', probe: 'FZShuTi' },
  { key: 'fzyaoti', label: '方正姚体', family: '"FZYaoTi", "SimSun", serif', group: '手写体', probe: 'FZYaoTi' },

  // —— 楷体系
  { key: 'kaiti', label: '楷体', family: '"KaiTi", "STKaiti", serif', group: '楷体', probe: 'KaiTi' },
  { key: 'stkaiti', label: '华文楷体', family: '"STKaiti", "KaiTi", serif', group: '楷体', probe: 'STKaiti' },
  { key: 'kaiti-sc', label: '楷体-简（Mac）', family: '"Kaiti SC", "STKaiti", serif', group: '楷体', probe: 'Kaiti SC' },

  // —— 西文
  { key: 'georgia', label: 'Georgia', family: 'Georgia, "Times New Roman", serif', group: '西文', probe: 'Georgia' },
  { key: 'times', label: 'Times New Roman', family: '"Times New Roman", Times, serif', group: '西文', probe: 'Times New Roman' },
  { key: 'garamond', label: 'Garamond', family: 'Garamond, Georgia, serif', group: '西文', probe: 'Garamond' },
  { key: 'inter', label: 'Inter', family: 'Inter, "Segoe UI", sans-serif', group: '西文', probe: 'Inter' },
  { key: 'segoe', label: 'Segoe UI', family: '"Segoe UI", Tahoma, sans-serif', group: '西文', probe: 'Segoe UI' },
  { key: 'helvetica', label: 'Helvetica', family: 'Helvetica, Arial, sans-serif', group: '西文', probe: 'Helvetica' },
];

/** 内置字体：随应用分发，无需系统安装，installed 恒为 true */
const BUILTIN_KEYS = new Set([
  'builtin-wenkai',
  'builtin-xiaowei',
  'builtin-zhimang',
  'builtin-qingke',
  'builtin-zcool',
]);

/** 去掉最后的兜底 family，避免探测时总是命中兜底 */
function primaryFamily(family) {
  return String(family).split(',')[0].trim().replace(/^["']|["']$/g, '');
}

let cachedSystemFonts = null;

/**
 * Windows 字体目录扫描（注册表不可用时的兜底）。
 * 直接从 C:\Windows\Fonts 读取文件名，虽然拿不到"字体族显示名"，
 * 但足以判断某个字体文件是否存在（如 simsun.ttc / simhei.ttf）。
 */
function scanWindowsFontDir() {
  const found = new Set();
  const dirs = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts'),
  ];
  for (const dir of dirs) {
    try {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        const base = f.replace(/\.(tt[fc]|otf|fon|fnt)$/i, '');
        found.add(base);
      }
    } catch (_) {}
  }
  return found;
}

/** 文件名字 → 常见字体族名的映射（注册表读不到时补足中文名字体） */
const FILE_ALIASES = {
  simsun: ['SimSun', '宋体'],
  nsimsun: ['NSimSun', '新宋体'],
  simhei: ['SimHei', '黑体'],
  simkai: ['KaiTi', '楷体'],
  kaiti: ['KaiTi', '楷体'],
  simfang: ['FangSong', '仿宋'],
  fangsong: ['FangSong', '仿宋'],
  msyh: ['Microsoft YaHei', '微软雅黑'],
  msyhbd: ['Microsoft YaHei'],
  msyhl: ['Microsoft YaHei'],
  msjh: ['Microsoft JhengHei'],
  deng: ['DengXian', '等线'],
  dengxian: ['DengXian', '等线'],
  simyou: ['YouYuan', '幼圆'],
  youyuan: ['YouYuan', '幼圆'],
  stxingka: ['STXingkai', '华文行楷'],
  stxinwei: ['STXinwei', '华文新魏'],
  stcaiyun: ['STCaiyun', '华文彩云'],
  stliti: ['STLiti', '华文隶书'],
  stkaiti: ['STKaiti', '华文楷体'],
  stsong: ['STSong', '华文宋体'],
  sthupo: ['STHupo', '华文琥珀'],
  stxihei: ['STXihei', '华文细黑'],
  fzshuti: ['FZShuTi', '方正舒体'],
  fzyaoti: ['FZYaoTi', '方正姚体'],
  msyhsb: ['Microsoft YaHei'],
  simsunb: ['SimSun-ExtB'],
  simsunextb: ['SimSun-ExtB'],
  arial: ['Arial'],
  times: ['Times New Roman'],
  georgia: ['Georgia'],
  garamond: ['Garamond'],
  cour: ['Courier New'],
  segoeui: ['Segoe UI'],
  calibri: ['Calibri'],
  cambria: ['Cambria'],
  consola: ['Consolas'],
};

/** Windows：读注册表已安装字体名 */
function enumWindowsFonts() {
  return new Promise((resolve) => {
    const keys = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    ];
    const found = new Set();
    let done = 0;
    keys.forEach((key) => {
      execFile('reg', ['query', key], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (!err && stdout) {
          for (const line of stdout.split(/\r?\n/)) {
            // 形如：    SimSun & NSimSun (TrueType)    REG_SZ    simsun.ttc
            const m = /^\s{2,}(.+?)\s{4,}REG_SZ\s+(.+)$/.exec(line);
            if (!m) continue;
            const rawName = m[1].trim();
            const file = m[2].trim();
            const base = rawName.replace(/\s*\((?:TrueType|OpenType|All res|VGA res|PostScript|Type 1)\)\s*$/i, '');
            for (const part of base.split(/\s*&\s*/)) {
              const name = part.trim();
              if (name) found.add(name);
            }
            if (file) found.add(path.basename(file).replace(/\.(tt[fc]|otf|fon|ttf)$/i, ''));
          }
        }
        done++;
        if (done === keys.length) {
          // 注册表读不到（权限受限 / 被安全策略阻止）时走目录扫描兜底。
          // 这很重要：没有兜底的话字体列表会全部变成"未安装"，
          // 用户会误以为换字体功能坏了。
          if (found.size === 0) {
            const scanned = scanWindowsFontDir();
            scanned.forEach((n) => found.add(n));
            for (const [file, aliases] of Object.entries(FILE_ALIASES)) {
              if (scanned.has(file)) aliases.forEach((a) => found.add(a));
            }
            for (const f of scanned) {
              for (const a of (FILE_ALIASES[f] || [])) found.add(a);
            }
          }
          resolve(found);
        }
      });
    });
  });
}

/** macOS / Linux：fc-list */
function enumFontconfigFonts() {
  return new Promise((resolve) => {
    const found = new Set();
    execFile('fc-list', [':', 'family'], { timeout: 8000 }, (err, stdout) => {
      if (!err && stdout) {
        for (const line of stdout.split(/\r?\n/)) {
          for (const name of line.split(',')) {
            const n = name.trim();
            if (n) found.add(n);
          }
        }
      }
      resolve(found);
    });
  });
}

/** macOS 额外用 system_profiler 兜底 */
function enumMacFonts() {
  return new Promise((resolve) => {
    execFile('system_profiler', ['SPFontsDataType', '-json'], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const found = new Set();
      if (!err && stdout) {
        try {
          const data = JSON.parse(stdout);
          const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (node._name) found.add(String(node._name).split(':')[0].trim());
            if (node.family) found.add(String(node.family).trim());
            for (const k of Object.keys(node)) walk(node[k]);
          };
          walk(data);
        } catch (_) {}
      }
      resolve(found);
    });
  });
}

async function enumSystemFonts(force) {
  if (cachedSystemFonts && !force) return cachedSystemFonts;
  let found = new Set();
  try {
    if (process.platform === 'win32') {
      found = await enumWindowsFonts();
    } else if (process.platform === 'darwin') {
      found = await enumMacFonts();
      const fc = await enumFontconfigFonts();
      fc.forEach((f) => found.add(f));
    } else {
      found = await enumFontconfigFonts();
    }
  } catch (_) {
    found = new Set();
  }
  cachedSystemFonts = found;
  return found;
}

function fuzzyHas(set, name) {
  if (!name || !set.size) return false;
  const target = name.toLowerCase().replace(/\s+/g, '');
  for (const item of set) {
    const s = String(item).toLowerCase().replace(/\s+/g, '');
    if (!s) continue;
    if (s === target) return true;
    // 注册表里常有 "SimSun-ExtB" 之类变体，前缀匹配能覆盖
    if (s.startsWith(target) || target.startsWith(s)) return true;
  }
  return false;
}

const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.woff', '.woff2']);

/** 读取用户导入的字体文件（存放在 userData/fonts） */
function listUserFonts(fontDir) {
  try {
    if (!fs.existsSync(fontDir)) return [];
    return fs.readdirSync(fontDir)
      .filter((f) => FONT_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => {
        const st = fs.statSync(path.join(fontDir, f));
        const base = path.basename(f, path.extname(f));
        return {
          key: 'user:' + f,
          label: base,
          file: f,
          size: st.size,
          user: true,
          group: '我的字体',
          family: `"${base}"`,
          probe: base,
          url: `firmament-font://local/${encodeURIComponent(f)}`,
        };
      });
  } catch (_) {
    return [];
  }
}

/** 把导入的字体复制到 fonts 目录，重名自动加序号 */
function importUserFont(fontDir, srcPath) {
  const ext = path.extname(srcPath).toLowerCase();
  if (!FONT_EXT.has(ext)) throw new Error(`不支持的字体格式：${ext}（支持 ttf / otf / ttc / woff / woff2）`);
  if (!fs.existsSync(fontDir)) fs.mkdirSync(fontDir, { recursive: true });
  let name = path.basename(srcPath);
  let dest = path.join(fontDir, name);
  let i = 1;
  while (fs.existsSync(dest)) {
    const base = path.basename(srcPath, ext);
    name = `${base} (${i})${ext}`;
    dest = path.join(fontDir, name);
    i++;
  }
  fs.copyFileSync(srcPath, dest);
  return name;
}

/**
 * 组合出给渲染层的字体清单
 * installed 判定：注册表命中 或 用户导入。渲染层还会用 canvas 再校验一次。
 */
async function getFontList(fontDir) {
  const sys = await enumSystemFonts();
  const userFonts = listUserFonts(fontDir);

  const list = CURATED.map((f) => {
    const probe = f.probe || primaryFamily(f.family);
    // 内置字体随应用分发，不依赖系统安装，恒为可用
    const installed = f.builtin ? true
      : (sys.size === 0 ? null : fuzzyHas(sys, probe));  // null = 无法枚举，交给渲染层判断
    return {
      key: f.key,
      label: f.label,
      family: f.family,
      group: f.group,
      probe,
      user: false,
      builtin: !!f.builtin,
      installed,
    };
  });

  const merged = [...userFonts, ...list];
  merged.push({
    key: 'inherit',
    label: '跟随主题默认',
    family: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif',
    group: '系统',
    probe: '',
    user: false,
    installed: true,
  });
  return merged;
}

module.exports = {
  getFontList,
  enumSystemFonts,
  listUserFonts,
  importUserFont,
  primaryFamily,
  CURATED,
  BUILTIN_KEYS,
  FONT_EXT,
};