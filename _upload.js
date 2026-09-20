'use strict';

/**
 * 用 GitHub REST API 上传源码（绕开 git 协议）。
 *
 * ⚠ 为什么不用 git push：
 *   本环境下 `git push` 走 github.com 的 git 协议时反复被中断
 *   （SIGTERM），`git ls-remote` 也报 "expected flush after ref listing"
 *   —— 代理对 git-smart-http 的响应做了截断。
 *   而 GitHub REST API（api.github.com/contents）走的是普通 HTTPS，
 *   实测 201 写入成功，稳定可用。
 *
 * 做法：把每个文件按 base64 提交到 contents API；
 *   多个文件用 Git Data API（blobs → tree → commit → ref）一次性提交，
 *   只产生一个 commit，而不是 N 个。
 *
 * 凭据只从 argv 读取，不写盘。
 */

const fs = require('fs');
const path = require('path');

const TOKEN = process.argv[2];
const OWNER = 'coder-beizhou';
const REPO = 'Skylore';
const BRANCH = 'main';
const ROOT = __dirname;

if (!TOKEN) {
  console.error('缺少 token');
  process.exit(1);
}

/** 不提交的条目（与 .gitignore 保持一致） */
const IGNORE_PARTS = [
  'node_modules', 'dist', '.git', '.workbuddy', '.srcpack', '.verify',
  'test/shots', 'build/icon.ico', 'build/icon.png',
];

function isIgnored(rel) {
  const p = rel.split(path.sep).join('/');
  return IGNORE_PARTS.some((ex) => p === ex || p.startsWith(ex + '/'));
}

function collect(dir, rel, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (isIgnored(r)) continue;
    // 跳过我们自己的临时文件
    if (/^_(push|do_push|repo|user|perm|br|r3|t|b3)\./.test(ent.name)) continue;
    if (ent.name === '_do_push.sh' || ent.name === '_push.log' || ent.name === '_pushout.txt') continue;
    if (ent.isDirectory()) collect(abs, r, out);
    else out.push({ rel: r, abs });
  }
}

/**
 * ⚠ 用 curl 而不是 Node 的 https 模块发请求。
 *
 *   原因：本机出网走的是 HTTP 代理（Clash 的 127.0.0.1:7897），
 *   Node 的 https 模块**不会**自己建立 CONNECT 隧道 ——
 *   直接连过去只会报 "socket disconnected before secure TLS
 *   connection was established"。
 *   curl 自带 `-x` 代理支持，会自动协商隧道，实测稳定可用。
 */
const { execFileSync } = require('child_process');

const PROXY = 'http://127.0.0.1:7897';
/** 请求体临时文件放在系统临时目录，不污染项目 */
const TMP_DIR = require('os').tmpdir();

/** 发一个 JSON 请求。
 *
 * ⚠ 请求体必须走**临时文件**（curl 的 -d @file），不能用 -d '<json>'：
 *   blob 内容是文件的 base64，大文件（如 4MB 字体）会让命令行参数
 *   超出 Windows 上限，报 ENAMETOOLONG。
 */
function api(method, urlPath, body) {
  const args = [
    '-sS', '-x', PROXY,
    '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: skylore-uploader',
    '-w', '\n__STATUS__%{http_code}',
    'https://api.github.com' + urlPath,
  ];

  let tmpFile = null;
  if (body) {
    tmpFile = path.join(TMP_DIR, 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.json');
    fs.writeFileSync(tmpFile, JSON.stringify(body));
    args.push('-H', 'Content-Type: application/json', '-d', '@' + tmpFile);
  }

  try {
    const out = execFileSync('curl', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    const m = out.match(/\n__STATUS__(\d+)\s*$/);
    const status = m ? Number(m[1]) : 0;
    const text = out.replace(/\n__STATUS__\d+\s*$/, '');

    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) {}

    if (status >= 200 && status < 300) return Promise.resolve(parsed);
    return Promise.reject(new Error(`HTTP ${status}: ${(parsed && parsed.message) || text.slice(0, 200)}`));
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) {} }
  }
}

function b64(file) {
  return fs.readFileSync(file).toString('base64');
}

async function main() {
  const files = [];
  collect(ROOT, '', files);
  console.log(`[upload] 待上传 ${files.length} 个文件`);

  // 1. 取当前分支的 HEAD（空仓库时不存在，需处理）
  let baseSha = null;
  try {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    baseSha = ref.object.sha;
    console.log('[upload] 现有分支 HEAD =', baseSha.slice(0, 8));
  } catch (e) {
    console.log('[upload] 分支不存在（空仓库），将创建初始提交');
  }

  // 2. 逐个创建 blob
  console.log('[upload] 创建 blob…');
  const treeItems = [];
  for (const f of files) {
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: b64(f.abs),
      encoding: 'base64',
    });
    treeItems.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
  }
  console.log(`[upload] blob 完成 ${treeItems.length} 个`);

  // 3. 创建 tree
  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    tree: treeItems,
    ...(baseSha ? {} : {}),
  });
  console.log('[upload] tree =', tree.sha.slice(0, 8));

  // 4. 创建 commit
  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: [
      '初始提交：苍穹 Skylore 桌面小说阅读器',
      '',
      '基于 Electron 的本地小说阅读器，支持 TXT / EPUB：',
      '- 自研解析管线，TXT 与 EPUB 走同一套渲染，便于统一切换字体与主题',
      '- 双阅读模式：分页（CSS 多列）与连续滚动（跨章无缝拼接）',
      '- 拟物 / 极简两套皮肤，内置 5 款硬笔风格中文字体',
      '- 摸鱼模式：Word / Excel / VS Code / 邮件伪装界面 + 正方形迷你框',
      '- 无框架无打包器：原生 ES Module + HTML/CSS',
    ].join('\n'),
    tree: tree.sha,
    ...(baseSha ? { parents: [baseSha] } : {}),
  });
  console.log('[upload] commit =', commit.sha.slice(0, 8));

  // 5. 更新 / 创建分支引用
  if (baseSha) {
    await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  } else {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }

  console.log('[upload] ✓ 完成');
  console.log('[upload] 提交 SHA =', commit.sha);
}

main().catch((e) => {
  console.error('[upload] ✗ 失败：' + e.message);
  process.exit(1);
});