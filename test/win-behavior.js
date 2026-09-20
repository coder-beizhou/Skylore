'use strict';
/**
 * 窗口几何行为验证（独立于应用，直接问 Electron）。
 *
 * 待验证的三个疑点：
 *   1) setMinimumSize(120,120) 之后 getMinimumSize() 返回 [520,910]
 *      —— 最小值被顶成"当前尺寸"，导致窗口再也压不小？
 *   2) 是 setMaximizable(false) 引发的吗？
 *   3) 窗口已 show 之后再 setBounds 缩小，是否可行？
 *   4) 最大化状态下 unmaximize() 后立刻 setBounds，是否被忽略？
 *
 * 背景：摸鱼迷你框要求窗口 300×300，主窗口设了 minWidth 520 / minHeight 460。
 *      应用内实测 setBounds 完全无效，窗口尺寸纹丝不动。
 */
const { app, BrowserWindow, screen } = require('electron');

// 本机无可用 GPU：showInactive() 后 GPU 进程会反复崩溃并 FATAL 退出，
// 必须强制软件渲染，否则测试跑不完。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('use-gl', 'swiftshader');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const log = [];
const say = (s) => { log.push(s); console.log('[WINTEST] ' + s); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b = (w) => { const x = w.getBounds(); return x.width + '×' + x.height + '@' + x.x + ',' + x.y; };
const mn = (w) => JSON.stringify(w.getMinimumSize());

function mk(opts) {
  return new BrowserWindow(Object.assign({
    x: 100, y: 100, width: 900, height: 700,
    show: false, frame: false,
    webPreferences: { contextIsolation: true },
  }, opts || {}));
}

app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workAreaSize;
  say('工作区 ' + area.width + '×' + area.height);

  /* —— 疑点 1/2：setMaximizable(false) 是否破坏 setMinimumSize —— */
  say('--- A: 先 setMaximizable(false) 再 setMinimumSize ---');
  const a = mk({ minWidth: 520, minHeight: 460 });
  a.showInactive();
  await wait(400);
  say('A 初始 bounds=' + b(a) + ' min=' + mn(a));
  a.setMaximizable(false);
  await wait(200);
  say('A setMaximizable(false) 后 min=' + mn(a));
  a.setMinimumSize(120, 120);
  await wait(200);
  say('A setMinimumSize(120,120) 后 min=' + mn(a));
  a.setBounds({ x: 100, y: 100, width: 300, height: 300 }, false);
  await wait(350);
  say('A setBounds(300×300) → bounds=' + b(a) + ' min=' + mn(a));
  a.destroy();

  /* —— 疑点 3：先 setMinimumSize 再 setMaximizable —— */
  say('--- B: 先 setMinimumSize 再 setMaximizable(false) ---');
  const bb = mk({ minWidth: 520, minHeight: 460 });
  bb.showInactive();
  await wait(400);
  bb.setMinimumSize(120, 120);
  await wait(200);
  say('B setMinimumSize(120,120) 后 min=' + mn(bb));
  bb.setMaximizable(false);
  await wait(200);
  say('B setMaximizable(false) 后 min=' + mn(bb));
  bb.setBounds({ x: 100, y: 100, width: 300, height: 300 }, false);
  await wait(350);
  say('B setBounds(300×300) → bounds=' + b(bb) + ' min=' + mn(bb));
  bb.destroy();

  /* —— 疑点 4：最大化 → unmaximize → 立刻 setBounds —— */
  say('--- C: 最大化后还原，立刻 setBounds（不等落定） ---');
  const c = mk();
  c.showInactive();
  await wait(400);
  c.maximize();
  await wait(500);
  say('C maximize 后 isMax=' + c.isMaximized() + ' bounds=' + b(c));
  c.setMinimumSize(120, 120);
  c.unmaximize();
  c.setBounds({ x: 100, y: 100, width: 300, height: 300 }, false);   // 不等待
  await wait(400);
  say('C 立刻 setBounds → bounds=' + b(c) + ' isMax=' + c.isMaximized());
  c.destroy();

  /* —— 疑点 4b：等落定后再 setBounds —— */
  say('--- D: 最大化后等落定再 setBounds ---');
  const d = mk();
  d.showInactive();
  await wait(400);
  d.maximize();
  await wait(500);
  d.setMinimumSize(120, 120);
  d.unmaximize();
  // 等待真正还原
  const t0 = Date.now();
  while (d.isMaximized() && Date.now() - t0 < 800) await wait(30);
  await wait(150);
  say('D 等待 ' + (Date.now() - t0) + 'ms 落定后 isMax=' + d.isMaximized());
  d.setBounds({ x: 100, y: 100, width: 300, height: 300 }, false);
  await wait(350);
  say('D setBounds(300×300) → bounds=' + b(d));
  d.destroy();

  say('=== 结论 ===');
  log.forEach((l) => { if (l.startsWith('---') || l.includes('→')) console.log('  ' + l); });
  app.exit(0);
}).catch((e) => {
  console.log('[WINTEST] 异常：' + (e && e.stack ? e.stack : e));
  app.exit(1);
});