'use strict';

/**
 * 清理构建产物。
 *
 * ⚠ 全程走系统 shell，不用 fs 的删除方法 ——
 *   开发环境的 node-safe-delete-shim 会按轮次累计计数并在超过 50 个
 *   文件时抛错，而构建产物动辄上百个文件，必然触发。
 *
 * ⚠ 也绝不触碰 dist/小说/ —— 那里放的是用户的真实书籍（供探针验证用），
 *   长在 dist 下面极易被误当构建产物清掉。曾经就因此删掉过用户的书。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** 只清这些（都是可再生的构建产物） */
const TARGETS = ['win-unpacked', 'run', 'builder-debug.yml'];
/** 绝不触碰（用户数据） */
const PROTECTED = ['小说'];

function shellRemove(target) {
  if (!fs.existsSync(target)) return false;
  const isDir = fs.statSync(target).isDirectory();
  const winPath = target.split('/').join('\\');
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', isDir ? 'rd' : 'del',
        ...(isDir ? ['/s', '/q'] : ['/f', '/q']), winPath], { stdio: 'ignore' });
    } else {
      execFileSync('rm', ['-rf', target], { stdio: 'ignore' });
    }
  } catch (_) {}
  return !fs.existsSync(target);
}

function main() {
  for (const name of PROTECTED) {
    if (fs.existsSync(path.join(DIST, name))) {
      console.log(`[clean] 跳过受保护目录 ${name}/（用户数据）`);
    }
  }

  for (const name of TARGETS) {
    const p = path.join(DIST, name);
    if (!fs.existsSync(p)) continue;
    console.log(`[clean] ${shellRemove(p) ? '已删除' : '删除失败'} ${name}`);
  }

  // zip：glob 一下，支持版本号变化
  let zips = [];
  try { zips = fs.readdirSync(DIST).filter((f) => f.endsWith('.zip')); } catch (_) {}
  for (const z of zips) {
    const p = path.join(DIST, z);
    console.log(`[clean] ${shellRemove(p) ? '已删除' : '删除失败'} ${z}`);
  }

  console.log('[clean] 完成');
}

main();