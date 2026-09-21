# 苍穹 Skylore — 开发约定

> 这份文件是给 AI 助手（以及未来的自己）看的。
> 它只写「每次都必须遵守的规矩」，不重复 README 里的功能说明。

## 一、结束任务前必须打包新版本

**每次任务结束前，都要打一个新版本，并把产物放到 `dist/`。**

流程固定为：

```powershell
# 1. 先递增版本号（package.json + package-lock.json）
#    patch：修 bug / 小调整   minor：新增功能   major：破坏性变更
npm.cmd version patch --no-git-tag-version

# 2. 跑测试
npm.cmd run test:fast        # 纯 Node 测试（快）
npm.cmd run smoke            # 冒烟测试（自动在屏幕外跑，不占用户屏幕）

# 3. 打包（产物固定输出到 dist/）
npm.cmd run build
```

### 打包相关的约定

- **产物只放 `dist/`**，不要另建 `dist-build-*`、`dist-2` 之类的目录。
  构建脚本 `build/clean.js` 会在打包前自动清理旧的 `win-unpacked` / `run` / 旧版本 zip，
  所以 `dist/` 里始终只有当前版本，不会越攒越多。
- **若构建报 "Access is denied"**：说明有进程正从 `dist/` 里运行（Windows 不允许覆盖
  正在运行的 exe/dll）。`npm run build` 已内置 `build/close-running.js`，
  会先优雅关闭这些进程再构建 —— 无需手动 taskkill，也不需要换目录。
- `dist/小说/` 是用户的真实书籍（探针验证用），`build/clean.js` 已将其列入保护名单，
  **任何时候都不要删除它**。

## 二、自动化测试必须后台运行

冒烟测试 / 截图 / 探针（`--smoke-test` / `--shots` / `--probe`）一律**不显示在用户屏幕上**。

实现方式见 `src/main/main.js` 的 `parkOffscreen()`：把窗口移到所有显示器工作区之外再
`showInactive()`，而不是 `hide()`。

> ⚠ **不要改回 `hide()`**。隐藏窗口不参与真实布局，实测 DOM 坐标会算到屏幕外几千像素
> （章末导航按钮测出 x=5822），所有依赖坐标的断言（可见性、命中测试、分页宽度）集体误报。
> 「移到屏幕外」既能让用户看不见，又保证渲染与测量真实可信。

## 三、代码注释的写法

这个项目的注释解释**为什么**，不解释**是什么**。特别注意记录：

- 踩过的坑：写清「现象 → 根因 → 为什么这样修」
- 反直觉的取舍：比如"为什么不用 XX 方案"
- 不变量：改这里必须同步改哪里（例如 `MIN_W/MIN_H` 必须与窗口创建参数一致）

已有的注释密度是基准，新增代码请保持同一水平。

## 四、改动后必须验证

- 改了阅读引擎 / 排版 → 跑 `npm run smoke`，它覆盖了分页裁剪、连续滚动跨章、
  滚轮限幅、边距收敛等几十项几何断言
- 改了摸鱼模式 → 冒烟测试里有透明浮窗真透明、双角缩放锚点、伪装界面装载正文等断言
- 改了 UI 布局 → 跑 `npm run shots`，截图产物在 `test/shots/`，逐张看效果

**不要只用"代码看起来对"作为完成标准。**

## 五、版本号与文档

- `package.json` 与 `package-lock.json` 的版本号必须一致
- 功能有增减时，同步更新 `README.md` 与 `苍穹-开发计划.md`
  （后者末尾有「迭代记录」章节，按版本追加）

## 六、窗口尺寸相关的不变量

以下常量必须保持一致，改动时全部同步：

| 常量 | 位置 | 当前值 |
|---|---|---|
| `MIN_W` / `MIN_H` | `src/main/boss.js` | 380 / 420 |
| `DEFAULT_W` / `DEFAULT_H` | `src/main/boss.js` | 900 / 960（瘦高） |
| `WINDOW_GEOMETRY_VERSION` | `src/main/main.js` | 递增即让旧窗口尺寸重置一次 |
| `win:set-size` 的下限 | `src/main/ipc.js` | 必须用 `MIN_W/MIN_H`，不得硬编码 |

> ⚠ 改默认尺寸时**必须递增 `WINDOW_GEOMETRY_VERSION`**，否则老用户的
> `window.json` 里存的旧尺寸会一直覆盖新默认值 —— 改了等于没改。
