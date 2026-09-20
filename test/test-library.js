'use strict';

/**
 * 集成测试：走真实的 Library 服务，验证从文件到章节的完整链路。
 * 同时测量大文件的解析性能。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { Store } = require('../src/main/store');
const { Library, SUPPORTED } = require('../src/main/services/library');

const SAMPLES = path.join(__dirname, 'samples');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmament-test-'));

const nodeAssert = require('assert');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const assert = nodeAssert;

(async function run() {
  const dirs = {
    dataDir: tmpDir,
    coverDir: path.join(tmpDir, 'covers'),
    fontDir: path.join(tmpDir, 'fonts'),
    cacheDir: path.join(tmpDir, 'cache'),
  };
  const store = new Store(dirs.dataDir);
  store.load();
  const lib = new Library(store, dirs);
  lib.ensureDirs();

  console.log('\n集成测试：Library 全链路\n');

  /* ---------- 导入 TXT ---------- */

  await test('导入 UTF-8 TXT 并正确解析 4 章', async () => {
    const p = path.join(SAMPLES, '剑庐遗事 - 江城子.txt');
    const r = await lib.importFile(p);
    assert(!r.duplicate, '首次导入不应判为重复');
    assert.strictEqual(r.book.chapterCount, 4, `期望 4 章，实际 ${r.book.chapterCount}`);
    assert.ok(r.book.title.includes('剑庐'), `书名推断错误：${r.book.title}`);
    assert.ok(r.book.cover.startsWith('data:image/svg+xml'), '应生成 SVG 封面');
  });

  await test('章节内容可读取且归属正确', async () => {
    const books = lib.getBooks();
    const b = books.find((x) => x.title.includes('剑庐'));
    const ch = await lib.getChapter(b.id, 0);
    assert(ch, '应返回章节');
    assert.ok(ch.html.includes('林昭'), '第一章应含主角名');
    assert.ok(!ch.html.includes('苏晴'), '第一章不应含第二章人物');
    assert.strictEqual(ch.total, 4);
  });

  await test('重复导入同一文件被识别为已存在', async () => {
    const p = path.join(SAMPLES, '剑庐遗事 - 江城子.txt');
    const r = await lib.importFile(p);
    assert(r.duplicate, '应识别为重复');
    assert.strictEqual(lib.getBooks().length, 1, '书架不应新增记录');
  });

  /* ---------- GBK ---------- */

  await test('导入 GBK 编码 TXT 无乱码', async () => {
    const p = path.join(SAMPLES, '归乡记（GBK编码）.txt');
    const r = await lib.importFile(p);
    const ch = await lib.getChapter(r.book.id, 0);
    assert.ok(ch.html.includes('火车'), `GBK 内容错误：${ch.html.slice(0, 80)}`);
    assert.ok(!ch.html.includes('\uFFFD'), '不应出现替换符');
    assert.strictEqual(r.book.encoding, 'gb18030');
  });

  /* ---------- 无章节兜底 ---------- */

  await test('无章节标记的 TXT 自动按字数切分', async () => {
    const p = path.join(SAMPLES, '无章节标记测试.txt');
    const r = await lib.importFile(p);
    assert(r.book.chapterCount > 1, `应切分为多节，实际 ${r.book.chapterCount}`);
    assert.strictEqual(r.book.format, 'txt');
  });

  /* ---------- EPUB ---------- */

  await test('导入 EPUB 并解析元数据', async () => {
    const p = path.join(SAMPLES, '沧海月明.epub');
    const r = await lib.importFile(p);
    assert.strictEqual(r.book.title, '沧海月明', `书名错误：${r.book.title}`);
    assert.strictEqual(r.book.author, '沈砚秋', `作者错误：${r.book.author}`);
    assert.strictEqual(r.book.format, 'epub');
  });

  await test('EPUB 章节与目录标题一致', async () => {
    const books = lib.getBooks();
    const b = books.find((x) => x.title === '沧海月明');
    const toc = await lib.getToc(b.id);
    assert.strictEqual(toc.length, 3, `期望 3 章，实际 ${toc.length}`);
    assert.ok(toc[0].title.includes('潮生'), `第一章标题错误：${toc[0].title}`);
    assert.ok(toc[1].title.includes('归舟'), `第二章标题错误：${toc[1].title}`);
    assert.ok(toc[2].title.includes('月明'), `第三章标题错误：${toc[2].title}`);
  });

  await test('EPUB 正文已净化（无内联样式 / class）', async () => {
    const books = lib.getBooks();
    const b = books.find((x) => x.title === '沧海月明');
    const ch = await lib.getChapter(b.id, 0);
    assert.ok(!ch.html.includes('style='), 'style 属性应被剥离');
    assert.ok(!ch.html.includes('class='), 'class 应被剥离');
    assert.ok(!ch.html.includes('<link'), 'link 应被移除');
    assert.ok(ch.html.includes('潮水'), '正文内容应在');
  });

  await test('EPUB 实体已解码为真实字符', async () => {
    const books = lib.getBooks();
    const b = books.find((x) => x.title === '沧海月明');
    const ch = await lib.getChapter(b.id, 0);
    assert.ok(!ch.html.includes('&ldquo;'), '实体应已解码');
    assert.ok(ch.html.includes('\u201c') || ch.html.includes('\u201d'), '应含中文引号');
  });

  await test('EPUB 封面被提取', async () => {
    const books = lib.getBooks();
    const b = books.find((x) => x.title === '沧海月明');
    assert.ok(b.cover.startsWith('data:image/'), `封面应为 data URL，实际：${b.cover.slice(0, 40)}`);
  });

  /* ---------- 搜索 ---------- */

  await test('全书内容搜索命中正确章节', async () => {
    const books = lib.getBooks();
    const b = books.find((x) => x.title.includes('剑庐'));
    const res = await lib.search(b.id, '苏晴', 'content');
    assert(res.length > 0, '应搜索到结果');
    assert(res.every((r) => r.type === 'content'), '结果类型应为 content');
  });

  await test('书架搜索按书名命中', async () => {
    const res = await lib.search(null, '沧海', 'library');
    assert(res.length > 0, '应命中《沧海月明》');
  });

  await test('搜索不存在的词返回空数组', async () => {
    const books = lib.getBooks();
    const b = books.find((x) => x.title.includes('剑庐'));
    const res = await lib.search(b.id, '这个词一定不存在xyz', 'content');
    assert(Array.isArray(res) && res.length === 0, '应返回空数组');
  });

  /* ---------- 大文件性能 ---------- */

  await test('300 章大文件（约 31 万字）解析在 3 秒内', async () => {
    const p = path.join(SAMPLES, '大文件压力测试（300章）.txt');
    const t0 = Date.now();
    const r = await lib.importFile(p);
    const ms = Date.now() - t0;
    assert.strictEqual(r.book.chapterCount, 300, `期望 300 章，实际 ${r.book.chapterCount}`);
    assert(ms < 3000, `解析耗时 ${ms}ms，超过 3 秒阈值`);
    console.log(`      （耗时 ${ms}ms，${r.book.chapterCount} 章，${(r.book.charCount / 10000).toFixed(1)} 万字）`);
  });

  /* ---------- 目录扫描 ---------- */

  await test('扫描文件夹发现全部样本', async () => {
    const found = lib.scanFolder(SAMPLES, 2);
    assert(found.length >= 5, `应发现至少 5 个文件，实际 ${found.length}`);
    assert(found.every((f) => SUPPORTED[path.extname(f).toLowerCase()]), '只应返回受支持格式');
  });

  await test('批量导入返回逐项结果', async () => {
    const fresh = new Library(new Store(path.join(tmpDir, 'sub')), {
      ...dirs,
      dataDir: path.join(tmpDir, 'sub'),
      coverDir: path.join(tmpDir, 'sub', 'covers'),
    });
    fresh.ensureDirs();
    const files = lib.scanFolder(SAMPLES, 2);
    const res = await fresh.importFiles(files);
    assert.strictEqual(res.failed, 0, `不应有失败项：${JSON.stringify(res.results.filter((r) => !r.ok))}`);
    assert(res.success >= 5, `应成功导入至少 5 本，实际 ${res.success}`);
  });

  await test('导入不支持的格式给出明确错误', async () => {
    const bad = path.join(tmpDir, 'test.pdf');
    fs.writeFileSync(bad, 'not a book');
    let msg = '';
    try {
      await lib.importFile(bad);
    } catch (err) {
      msg = err.message;
    }
    assert(msg.includes('不支持'), `错误信息应说明不支持的格式，实际：${msg}`);
  });

  await test('导入不存在的文件给出明确错误', async () => {
    let msg = '';
    try {
      await lib.importFile(path.join(tmpDir, '不存在.txt'));
    } catch (err) {
      msg = err.message;
    }
    assert(msg.includes('不存在'), `错误信息应说明文件不存在，实际：${msg}`);
  });

  await test('空文件被拒绝并给出可读提示', async () => {
    const empty = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(empty, '');
    let msg = '';
    try {
      await lib.importFile(empty);
    } catch (err) {
      msg = err.message;
    }
    assert(msg.length > 0, '应抛出错误');
  });

  /* ---------- 书籍管理 ---------- */

  await test('更新书籍信息', async () => {
    const b = lib.getBooks()[0];
    const updated = lib.updateBook(b.id, { title: '改名后的书', author: '新作者' });
    assert.strictEqual(updated.title, '改名后的书');
    assert.strictEqual(lib.findBook(b.id).author, '新作者');
  });

  await test('移除书籍同时清理进度与书签', async () => {
    const b = lib.getBooks()[0];
    store.update((d) => {
      d.progress[b.id] = { chapterIndex: 1, ratio: 0.5 };
      d.bookmarks[b.id] = [{ id: 'x', chapterIndex: 1 }];
    });
    lib.removeBook(b.id, false);
    assert(!lib.findBook(b.id), '书籍应被移除');
    assert(!store.get('progress')[b.id], '进度应被清理');
    assert(!store.get('bookmarks')[b.id], '书签应被清理');
  });

  await test('检测源文件失效', async () => {
    const b = lib.getBooks()[0];
    fs.renameSync(b.path, b.path + '.moved');
    const missing = lib.validateBooks();
    assert(missing.some((m) => m.id === b.id), '应检测到失效文件');
    fs.renameSync(b.path + '.moved', b.path);
  });

  /* ---------- 汇总 ---------- */

  console.log('\n' + '─'.repeat(56));
  console.log(`集成测试：通过 ${passed}，失败 ${failed}`);

  if (failed > 0) {
    console.log('\n失败用例：');
    failures.forEach((f) => console.log(`  · ${f.name}\n    ${f.err.message}`));
    process.exitCode = 1;
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
})();