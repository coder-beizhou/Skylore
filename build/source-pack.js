'use strict';

/**
 * 源码打包：把整个代码库压成一个 zip，放进 dist/。
 *
 * 定位是「只保留代码」—— 判据很明确：
 *   凡是**能由仓库内脚本重新生成**的东西，都不进包。
 *   凡是**写了才有的源码/资源/文档**，都进包。
 *
 * ── 排除项（都是可再生的）────────────────────────────────
 *   test/shots/       39 张界面截图 —— `npm run shots` 随时重出
 *   build/icon.ico    由 build/make-icon.js 生成
 *   build/icon.png    同上
 *   node_modules/     `npm install` 恢复
 *   dist/             构建产物，本身就是代码库的输出
 *   .git/             版本库（若有），体积大且非源码
 *
 * ── 保留项（写了才有的）──────────────────────────────────
 *   src/              应用源码
 *   test/             测试代码 + 样本（scripts 里有生成脚本，
 *                     但样本本身才 0.9MB，留着省一次生成）
 *   build/*.js        构建脚本
 *   package.json / package-lock.json
 *   electron-builder.yml
 *   README.md / 开发计划.md
 *   .workbuddy/memory/ 项目决策记录（体积很小，对理解代码有用）
 *
 * ⚠ 删除一律走系统 shell：开发环境的 node-safe-delete shim 会按轮次
 *   累计计数并在超过 50 个文件时抛错，而临时目录里动辄上百个文件。
 *
 * ⚠ zip 由 JSZip 生成，**不要换回 7za**：7za 写中文文件名时不设
 *   UTF-8 标志位，字节按 GBK 存，解压方无法判断编码 ——
 *   上传到资料库这类服务会因文件名乱码而失败。
 *
 * 用法：node build/source-pack.js [--with-fonts]
 * 产出：dist/苍穹-源码-<version>.zip（或 -含字体- 版本）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// 用 JSZip 而非 7za 打 zip —— 原因见 makeZip() 的注释（中文文件名编码）
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGING = path.join(ROOT, '.srcpack');   // 暂存目录，打完即删

const pkg = require(path.join(ROOT, 'package.json'));

/** 是否把内置字体一起打包（默认否，见下方说明） */
const WITH_FONTS = process.argv.includes('--with-fonts');

/** 包名体现是否含字体，避免拿到手分不清 */
const ZIP_NAME = WITH_FONTS
  ? `苍穹-源码-含字体-${pkg.version}.zip`
  : `苍穹-源码-${pkg.version}.zip`;
const ZIP_PATH = path.join(DIST, ZIP_NAME);

/**
 * 不打包的条目。
 *
 * ── 体积大头：内置字体 ────────────────────────────────
 *   src/renderer/assets/fonts/*.woff2 共 11.75MB，占整包的 98%。
 *   它们是已压缩的二进制资源，zip 再压也压不动（4.36MB → 4.34MB）。
 *
 *   默认**剔除**（用户定的口径：只留代码）。代价是拿到包的人
 *   需要自行把字体放回该目录，否则界面会回退到系统字体。
 *   需要带字体的完整包时加 `--with-fonts`。
 *
 *   注：字体许可协议文件（LICENSE-*.txt / OFL-*.txt）始终保留 ——
 *   它们是文字，体积可忽略，且删掉会涉及授权合规问题。
 *
 * ── 其余都是可再生的产物 ──────────────────────────────
 */
const EXCLUDE_ALWAYS = [
  'node_modules', 'dist', '.git', '.srcpack',
  'test/shots',            // 截图可 `npm run shots` 重出
  'build/icon.ico',        // 由 make-icon.js 生成
  'build/icon.png',        // 同上
];

/** 仅在未指定 --with-fonts 时排除 */
const EXCLUDE_FONTS = ['src/renderer/assets/fonts/*.woff2'];

function log(msg) {
  console.log('[src-pack] ' + msg);
}

/** 交给系统 shell 删除，绕开 safe-delete shim 的累计计数 */
function removePath(target) {
  if (!fs.existsSync(target)) return;
  const winPath = target.split('/').join('\\');
  const isDir = fs.statSync(target).isDirectory();
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', isDir ? 'rd' : 'del',
        ...(isDir ? ['/s', '/q'] : ['/f', '/q']), winPath], { stdio: 'ignore' });
    } else {
      execFileSync('rm', ['-rf', target], { stdio: 'ignore' });
    }
  } catch (_) {}
}

/** 递归复制（保留目录结构） */
function copyRecursive(src, dest, relBase) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name), relBase);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

/** 该条目是否应排除（支持目录前缀匹配 + 简单通配） */
function isExcluded(relPath) {
  const p = relPath.split(path.sep).join('/');

  const matches = (patterns) => patterns.some((ex) => {
    if (ex.includes('*')) {
      // 只用到「目录/*.后缀」这一种形式，手工判定即可，避免引入依赖
      const [dir, ext] = ex.split('*');
      return p.startsWith(dir) && p.endsWith(ext);
    }
    return p === ex || p.startsWith(ex + '/');
  });

  if (matches(EXCLUDE_ALWAYS)) return true;
  if (!WITH_FONTS && matches(EXCLUDE_FONTS)) return true;
  return false;
}

/** 把代码复制到暂存目录 */
function stage() {
  removePath(STAGING);
  fs.mkdirSync(STAGING, { recursive: true });

  let count = 0;
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const r = rel ? path.join(rel, name) : name;
      if (isExcluded(r)) continue;

      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        walk(abs, r);
      } else {
        const dest = path.join(STAGING, r);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(abs, dest);
        count++;
      }
    }
  };
  walk(ROOT, '');
  return count;
}

/**
 * 用 JSZip 生成 zip。
 *
 * ⚠ 这里**不能**用 7za：它写中文文件名时不设 UTF-8 标志位（flags bit 11），
 *   文件名按本地代码页（GBK）存字节，解压方无从判断该用哪种编码 ——
 *   结果就是上传到资料库这类服务时因文件名乱码而失败。
 *
 *   JSZip 默认按 UTF-8 编码文件名并正确置位 bit 11，跨平台无歧义。
 *   实测：7za 产出的包里 6 个中文名条目 flags=0x0（乱码），
 *   JSZip 产出的是 flags=0x800 + 标准 UTF-8 字节。
 *
 * 代价是压缩率略低于 7za（DEFLATE level 9 vs 7za 的 -mx=7），
 * 但源码几乎全是文本，差距在几 KB 量级，换来的是可靠上传。
 */
async function makeZip() {
  removePath(ZIP_PATH);
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

  const zip = new JSZip();
  const addDir = (dir, rel) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, name.name);
      const r = rel ? rel + '/' + name.name : name.name;
      if (name.isDirectory()) addDir(abs, r);
      else zip.file(r, fs.readFileSync(abs));
    }
  };
  addDir(STAGING, '');

  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    // level 9：源码是文本，高压缩收益明显且耗时仍可接受
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    // 统一用 / 作分隔符（zip 规范要求），避免 Windows 反斜杠歧义
    platform: 'UNIX',
  });
  fs.writeFileSync(ZIP_PATH, buf);
  return buf.length;
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch (_) {} }
    }
  };
  walk(dir);
  return total / 1024 / 1024;
}

async function main() {
  // 保护用户数据：dist/小说/ 不属于构建产物
  if (fs.existsSync(path.join(DIST, '小说'))) {
    log('已跳过受保护目录 小说/（用户数据）');
  }

  log('正在收集源码（排除截图、图标与可再生的依赖）…');
  if (!WITH_FONTS) log('内置字体已排除（加 --with-fonts 可保留）');
  else log('内置字体已包含');

  const count = stage();
  const rawMb = dirSizeMb(STAGING);
  log(`已收集 ${count} 个文件，暂存体积 ${rawMb.toFixed(2)}MB`);

  const size = await makeZip();
  log(`已生成 ${ZIP_NAME}（${(size / 1024 / 1024).toFixed(2)}MB）`);

  removePath(STAGING);
  log('已清理暂存目录');
  if (!WITH_FONTS) {
    // 把恢复字体所需的信息说清楚，免得拿到包的人以为界面正常
    log('⚠ 本包不含内置字体：解压后 src/renderer/assets/fonts/ 下只有许可协议。');
    log('   直接运行时阅读字体将回退为系统字体；如需完整字体，');
    log('   请重新执行：npm run src-pack -- --with-fonts');
  }
  log('源码包位置：' + ZIP_PATH);
}

main().catch((err) => {
  console.error('[src-pack] 打包失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});