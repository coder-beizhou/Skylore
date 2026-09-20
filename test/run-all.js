'use strict';

/**
 * 全量测试入口。
 * 依次执行：解析单元测试 → Library 集成测试 → 应用冒烟测试（真实 Electron）。
 *
 * 用法：node test/run-all.js
 *     node test/run-all.js --no-app   仅跑纯 Node 测试（不需要 Electron）
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const noApp = process.argv.includes('--no-app');

const results = [];

function runNodeScript(script, label) {
  console.log('\n' + '═'.repeat(58));
  console.log('  ' + label);
  console.log('═'.repeat(58));
  const r = spawnSync(process.execPath, [path.join(__dirname, script)], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  const ok = r.status === 0;
  results.push({ label, ok, detail: ok ? '通过' : `退出码 ${r.status}` });
  return ok;
}

async function runElectronSmoke() {
  console.log('\n' + '═'.repeat(58));
  console.log('  应用冒烟测试（真实 Electron 环境）');
  console.log('═'.repeat(58));

  const bin = findElectronBin();
  if (!bin) return false;

  // 确保样本存在
  if (!fs.existsSync(path.join(__dirname, 'samples'))) {
    console.log('  生成测试样本…');
    spawnSync(process.execPath, [path.join(__dirname, 'make-samples.js')], { stdio: 'inherit', cwd: ROOT });
  }

  killStaleElectron();

  const code = await new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;   // 关键：否则 Electron 会以纯 Node 模式跑，不创建窗口
    const child = spawn(bin, ['.', '--smoke-test', '--dev', '--no-gpu'], {
      stdio: 'inherit',
      cwd: ROOT,
      env,
    });
    child.on('exit', (c) => resolve(c === null ? 1 : c));
  });

  const ok = code === 0;
  results.push({ label: '应用冒烟测试', ok, detail: ok ? '通过' : `退出码 ${code}` });
  return ok;
}

/**
 * 运行一个独立的 Electron 行为测试脚本。
 *
 * 这些脚本直接对底层能力做实验（窗口几何、滚动引擎），不启动整个应用。
 * 存在的意义：应用内测出的"不正常"未必是产品缺陷 ——
 * 也可能是环境/调用时序造成的。先确认底层行为本身正确，
 * 才能判断问题出在哪一层（这次窗口 setBounds 的诊断正是靠它定位的）。
 */
async function runElectronBehavior(script, label) {
  console.log('\n' + '═'.repeat(58));
  console.log('  ' + label);
  console.log('═'.repeat(58));

  const bin = findElectronBin();
  if (!bin) {
    results.push({ label, ok: false, detail: '未安装 Electron' });
    return false;
  }
  killStaleElectron();

  const code = await new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(bin, [path.join(__dirname, script), '--no-gpu'], {
      stdio: 'inherit',
      cwd: ROOT,
      env,
    });
    child.on('exit', (c) => resolve(c === null ? 1 : c));
  });

  const ok = code === 0;
  results.push({ label, ok, detail: ok ? '通过' : `退出码 ${code}` });
  return ok;
}

function findElectronBin() {
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const exeAlt = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
  if (fs.existsSync(exe)) return exe;
  if (fs.existsSync(exeAlt)) return exeAlt;
  console.log('  ⚠ 未找到 Electron 运行时，跳过');
  console.log('    （请先执行 npm install）');
  return null;
}

function killStaleElectron() {
  // 单实例锁会让新进程静默退出，必须清掉残留
  const running = spawnSync('tasklist', [], { encoding: 'utf8', shell: true });
  if (running.stdout && /electron\.exe/i.test(running.stdout)) {
    console.log('  ⚠ 检测到残留的 Electron 进程，正在结束…');
    spawnSync('taskkill', ['/F', '/IM', 'electron.exe'], { shell: true, stdio: 'ignore' });
  }
}

(async function main() {
  console.log('\n苍穹 · Firmament Reader —— 全量测试');
  console.log('时间：' + new Date().toLocaleString('zh-CN'));

  runNodeScript('test-parsers.js', '① 解析引擎单元测试（编码 / 章节 / EPUB）');
  runNodeScript('test-library.js', '② Library 集成测试（导入 / 搜索 / 性能）');

  if (!noApp) {
    await runElectronSmoke();
  } else {
    console.log('\n（已跳过应用冒烟测试）');
  }

  console.log('\n' + '═'.repeat(58));
  console.log('  测试汇总');
  console.log('═'.repeat(58));
  results.forEach((r) => {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}  ——  ${r.detail}`);
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length === 0
    ? '全部测试通过 ✅'
    : `${failed.length} 项测试未通过 ❌`));

  process.exitCode = failed.length > 0 ? 1 : 0;
})();