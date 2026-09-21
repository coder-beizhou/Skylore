'use strict';

/**
 * 关闭「正在从本项目 dist/ 运行的苍穹实例」。
 *
 * 为什么需要它：
 *   Windows 不允许覆盖正在运行的 exe / dll。若用户开着
 *   dist/win-unpacked/苍穹.exe 阅读，electron-builder 重建同名目录时
 *   会因文件被锁而报 "Access is denied" 直接失败 ——
 *   而打包失败的原因（有个窗口开着）表现得毫不直观。
 *
 * 处理策略：
 *   1. 只认「可执行文件路径位于本项目 dist/ 之下」的进程 ——
 *      别人另存到别处的苍穹（哪怕同名）一律不碰。
 *   2. 先 `taskkill /PID x /T`（**不带 /F**）请求优雅退出：
 *      Electron 会正常走关闭流程，进度在退出前落盘。
 *   3. 等最多 10 秒；仍在则 `/F /T` 强杀（此时多半是 GPU 子进程残留）。
 *   4. 可通过环境变量 SKYLORE_SKIP_CLOSE=1 跳过自动关闭
 *      （脚本会打印提示，构建大概率仍会失败，但知情权在用户）。
 *
 * ⚠ 退出前数据是安全的：进度/设置由 store.json 保存，改动即写盘（约 1 秒节流）。
 */

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
/** 这些目录下的可执行文件属于"构建产物"，可以安全关闭 */
const WATCH_DIRS = [path.join(DIST, 'win-unpacked'), path.join(DIST, 'run')];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 PowerShell 脚本转成 -EncodedCommand 参数（避开中文路径的编码坑） */
function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPs(script) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(script)],
    {
      encoding: 'utf8',
      // 用环境变量把目录传进去：路径含中文（苍穹-skylore），
      // 直接拼进脚本字符串会踩编码问题，环境变量是 UTF-16 传递，安全。
      env: Object.assign({}, process.env, { SKYLORE_WATCH: WATCH_DIRS.join(';') }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
}

/** 找出所有「从 dist 里启动」的进程，返回 [{ pid, name, path }] */
function findRunning() {
  const script = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$ErrorActionPreference = 'SilentlyContinue'
$dirs = $env:SKYLORE_WATCH -split ';' | Where-Object { $_ }
$hits = Get-Process | Where-Object {
  $p = $_.Path
  if (-not $p) { return $false }
  foreach ($d in $dirs) {
    if ($p.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}
foreach ($h in $hits) { "{0}\`t{1}" -f $h.Id, $h.Path }
`;
  try {
    const out = runPs(script);
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        if (tab < 0) return null;
        return { pid: Number(line.slice(0, tab)), path: line.slice(tab + 1) };
      })
      .filter((x) => x && Number.isFinite(x.pid) && x.pid > 0);
  } catch (_) {
    return [];
  }
}

function taskkill(pid, force) {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  try {
    execFileSync('taskkill', args, { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @returns {Promise<{closed: number, forced: number}>}
 */
async function closeRunningInstances() {
  const log = (s) => console.log('[close] ' + s);

  if (process.env.SKYLORE_SKIP_CLOSE === '1') {
    const still = findRunning();
    if (still.length) {
      log('已设置 SKYLORE_SKIP_CLOSE=1，不自动关闭正在运行的实例');
      log('但检测到 ' + still.length + ' 个进程仍在运行（PID ' + still.map((p) => p.pid).join(', ')
        + '）—— 构建很可能因文件被占用而失败');
    }
    return { closed: 0, forced: 0 };
  }

  let targets = findRunning();
  if (!targets.length) return { closed: 0, forced: 0 };

  log('检测到 ' + targets.length + ' 个从 dist/ 运行的苍穹进程（构建需要覆盖这些文件）：');
  for (const t of targets) log('  PID ' + t.pid + '  ' + t.path);

  // 先请求优雅退出（不带 /F）：让应用走正常关闭流程，进度自然落盘
  for (const t of targets) taskkill(t.pid, false);

  // 等它退干净（最多 10 秒）
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    targets = findRunning();
    if (!targets.length) {
      log('已正常关闭');
      return { closed: 1, forced: 0 };
    }
  }

  // 还有残留（通常是 GPU / 渲染子进程）→ 强杀
  log('优雅退出超时，强制结束剩余 ' + targets.length + ' 个进程');
  for (const t of targets) taskkill(t.pid, true);
  await sleep(800);

  const left = findRunning();
  if (left.length) {
    log('⚠ 仍有 ' + left.length + ' 个进程未能关闭（PID ' + left.map((p) => p.pid).join(', ') + '）');
    return { closed: 1, forced: 1 };
  }
  log('已强制关闭');
  return { closed: 1, forced: 1 };
}

module.exports = { closeRunningInstances, findRunning, WATCH_DIRS };

// 允许单独运行：node build/close-running.js
if (require.main === module) {
  closeRunningInstances().then(() => process.exit(0));
}
