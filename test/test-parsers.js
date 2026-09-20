'use strict';

/**
 * 解析引擎单元测试（纯 Node，不依赖 Electron）。
 * 用真实的中文小说样本覆盖编码嗅探、章节切分、EPUB 解析等易错点。
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const iconv = require('iconv-lite');
const JSZip = require('jszip');

const { decodeBuffer, normalizeText, mojibakeScore } = require('../src/main/services/encoding');
const { parseTxt, isChapterTitle, textToHtml } = require('../src/main/services/txt-parser');
const { parseEpub, sanitizeHtml, ensureParagraphs, countChars } = require('../src/main/services/epub-parser');
const { guessMetaFromFilename, makeId, generateCoverSvg, coverGradient } = require('../src/main/services/library');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => {
        passed++;
        process.stdout.write(`  \u2713 ${name}\n`);
      }).catch((err) => {
        failed++;
        failures.push({ name, err });
        process.stdout.write(`  \u2717 ${name}\n      ${err.message}\n`);
      });
    }
    passed++;
    process.stdout.write(`  \u2713 ${name}\n`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    process.stdout.write(`  \u2717 ${name}\n      ${err.message}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

/* ==================== 测试样本 ==================== */

const NOVEL_CHAPTERS = [
  '第一章 初入江湖',
  '山道弯弯，雾气未散。少年背着半旧的包袱，一步步往上走。',
  '他叫林昭，今年十六岁。三日前，他还在山下的镇子里替人写书信。',
  '"喂，前面的，让一让。"身后传来一个清亮的声音。',
  '林昭回头，看见一个白衣少女牵着一匹马，正笑吟吟地望着他。',
  '',
  '第二章 白衣少女',
  '少女自称姓苏，单名一个晴字。她说自己要去山上的剑庐。',
  '"剑庐？"林昭愣了愣，"那地方不是不收外人吗？"',
  '苏晴笑了笑，没有答话，只是翻身上马，扬长而去。',
  '',
  '第三章 剑庐之下',
  '剑庐在雪山之巅，终年积雪不化。',
  '林昭花了七天七夜才爬到山门之前。',
  '他抬头望着那块写着"剑庐"二字的石匾，忽然觉得，这一趟也许值得。',
].join('\n');

const DIALOG_TEXT = [
  '楔子',
  '这个故事开始于一个雨夜。',
  '那一天，城里所有的灯都灭了。',
  '',
  '第1节 雨夜',
  '雨下得很大，大到看不清三步之外的东西。',
  '他站在屋檐下，等雨停。',
].join('\n');

/* ==================== 1. 编码嗅探 ==================== */

section('1. 编码嗅探与解码');

test('UTF-8（带 BOM）正确解码', () => {
  const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('第一章 测试', 'utf8')]);
  const r = decodeBuffer(buf);
  assert.strictEqual(r.encoding, 'utf-8');
  assert.strictEqual(r.text, '第一章 测试');
});

test('UTF-8（无 BOM）正确解码', () => {
  const buf = Buffer.from('第二章 风起云涌，江湖再起波澜。', 'utf8');
  const r = decodeBuffer(buf);
  assert.strictEqual(r.encoding, 'utf-8');
  assert.ok(r.text.includes('风起云涌'));
});

test('GBK 编码正确识别（中文小说最常见）', () => {
  const original = '第三章 少年不识愁滋味，爱上层楼。';
  const buf = iconv.encode(original, 'gbk');
  // 先确认这确实是合法 GBK 而非巧合的 UTF-8
  assert.ok(!isValidUtf8(buf), '样本应当不是合法 UTF-8');
  const r = decodeBuffer(buf);
  assert.strictEqual(r.text, original, `GBK 解码失败，得到：${r.text}`);
  assert.ok(['gb18030', 'gbk'].includes(r.encoding));
});

test('GB18030 生僻字正确解码', () => {
  const original = '第四章 龘龗靐齉爩，这些字很生僻。';
  const buf = iconv.encode(original, 'gb18030');
  const r = decodeBuffer(buf);
  assert.strictEqual(r.text, original);
});

test('UTF-16LE 正确解码', () => {
  const original = '第五章 编码测试';
  const buf = iconv.encode(original, 'utf-16le');
  const r = decodeBuffer(buf);
  assert.strictEqual(r.text, original);
});

test('乱码率评估能区分正确与错误编码', () => {
  const text = '天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。';
  const good = mojibakeScore(text);
  const bad = mojibakeScore('å¤©åœ°çŽ„é»„ï¼Œå®‡å®™æ´ªè’ã€‚');
  assert.ok(good < bad, `正确编码得分(${good})应低于乱码得分(${bad})`);
});

test('空缓冲区不崩溃', () => {
  const r = decodeBuffer(Buffer.alloc(0));
  assert.strictEqual(r.text, '');
});

test('normalizeText 清理零宽字符与多余空行', () => {
  const input = '第一行\u200b\n\n\n\n\n第二行\ufeff';
  const out = normalizeText(input);
  assert.ok(!out.includes('\u200b'));
  assert.ok(!out.includes('\ufeff'));
  assert.ok(!/\n{4,}/.test(out));
});

/* ==================== 2. 章节标题识别 ==================== */

section('2. 章节标题识别');

test('标准中文章头', () => {
  ['第一章 初入江湖', '第1章 测试', '第十二回 归来', '第三节 转折', '第四卷 风起'].forEach((t) => {
    assert.ok(isChapterTitle(t), `应识别为章头：${t}`);
  });
});

test('特殊章名', () => {
  ['序章', '楔子', '前言', '尾声', '后记', '番外 其一', '引子'].forEach((t) => {
    assert.ok(isChapterTitle(t), `应识别为章头：${t}`);
  });
});

test('Chapter 英文章头', () => {
  ['Chapter 1', 'CHAPTER 12', 'Chapter IV'].forEach((t) => {
    assert.ok(isChapterTitle(t), `应识别为章头：${t}`);
  });
});

test('数字与全角编号章头', () => {
  assert.ok(isChapterTitle('1'));
  assert.ok(isChapterTitle('0001'));
  assert.ok(isChapterTitle('十二、'));
});

test('正文句子不能被误判为章头', () => {
  const body = [
    '他翻开了第三章，却发现里面是空白的。',
    '"第一章写的是什么？"她问道。',
    '这一章的标题很奇怪，他觉得。',
    '这是一个很长的句子，包含逗号，绝对不应该被识别成章节标题。',
  ];
  body.forEach((t) => {
    assert.ok(!isChapterTitle(t), `不应识别为章头：${t}`);
  });
});

test('以句号结尾的短句不算章头', () => {
  assert.ok(!isChapterTitle('他走了。'));
  assert.ok(!isChapterTitle('天亮了！'));
});

/* ==================== 3. TXT 章节切分 ==================== */

section('3. TXT 章节切分');

test('标准 TXT 正确切分为 3 章', () => {
  const buf = Buffer.from(NOVEL_CHAPTERS, 'utf8');
  const r = parseTxt(buf, { title: '测试小说' });
  assert.strictEqual(r.chapters.length, 3, `期望 3 章，实际 ${r.chapters.length}`);
  assert.ok(r.chapters[0].title.includes('第一章'));
  assert.ok(r.chapters[1].title.includes('第二章'));
  assert.ok(r.chapters[2].title.includes('第三章'));
});

test('章节内容正确归属（第一章不含第二章正文）', () => {
  const buf = Buffer.from(NOVEL_CHAPTERS, 'utf8');
  const r = parseTxt(buf);
  assert.ok(r.chapters[0].html.includes('林昭'), '第一章应含林昭');
  assert.ok(!r.chapters[0].html.includes('苏晴'), '第一章不应含第二章人物');
  assert.ok(r.chapters[1].html.includes('苏晴'));
});

test('正文转换为 <p> 段落', () => {
  const buf = Buffer.from(NOVEL_CHAPTERS, 'utf8');
  const r = parseTxt(buf);
  const pCount = (r.chapters[0].html.match(/<p>/g) || []).length;
  assert.ok(pCount >= 4, `第一章应有至少 4 个段落，实际 ${pCount}`);
});

test('楔子 + 数字章头混合', () => {
  const buf = Buffer.from(DIALOG_TEXT, 'utf8');
  const r = parseTxt(buf);
  assert.ok(r.chapters.length >= 2, `期望至少 2 章，实际 ${r.chapters.length}`);
  assert.ok(r.chapters.some((c) => c.title.includes('楔子')), '应保留楔子章节');
});

test('无章头的 TXT 按字数兜底切分', () => {
  const long = '这是一段没有章节标记的连续文本。'.repeat(900); // 约 15300 字
  const buf = Buffer.from(long, 'utf8');
  const r = parseTxt(buf);
  assert.strictEqual(r.meta.chapterMode, 'length');
  assert.ok(r.chapters.length > 1, '应被切分成多节');
  assert.ok(r.chapters.every((c) => c.html.length > 0), '每节都应有内容');
});

test('GBK 编码 TXT 端到端解析无乱码', () => {
  const buf = iconv.encode(NOVEL_CHAPTERS, 'gbk');
  const r = parseTxt(buf);
  assert.strictEqual(r.chapters.length, 3);
  assert.ok(r.chapters[0].html.includes('林昭'), 'GBK 解析后应含正确中文');
  assert.ok(!r.chapters[0].html.includes('\uFFFD'), '不应出现替换符 U+FFFD');
});

test('空 TXT 不崩溃', () => {
  const r = parseTxt(Buffer.alloc(0));
  assert.strictEqual(r.chapters.length, 0);
});

test('超短 TXT 不崩溃', () => {
  const r = parseTxt(Buffer.from('你好', 'utf8'));
  assert.ok(r.chapters.length >= 0);
});

test('HTML 特殊字符被转义', () => {
  const buf = Buffer.from('第一章 测试\n<script>alert(1)</script>\n<div>注入</div>', 'utf8');
  const r = parseTxt(buf);
  const html = r.chapters[0].html;
  assert.ok(!html.includes('<script>'), 'script 标签必须被转义');
  assert.ok(html.includes('&lt;script&gt;'));
});

/* ==================== 4. HTML 净化 ==================== */

section('4. EPUB 正文净化');

test('移除 script 标签及其内容', () => {
  const out = sanitizeHtml('<p>正文</p><script>alert("xss")</script>');
  assert.ok(!out.includes('script'));
  assert.ok(out.includes('正文'));
});

test('移除 style 标签与内联样式', () => {
  const out = sanitizeHtml('<style>p{color:red}</style><p style="color:red;font-size:30px">文字</p>');
  assert.ok(!out.includes('style='), '内联 style 必须被剥离');
  assert.ok(!out.includes('<style>'));
  assert.ok(out.includes('文字'));
});

test('移除 class 与表现型属性', () => {
  const out = sanitizeHtml('<p class="calibre3" align="center" width="100">文字</p>');
  assert.ok(!out.includes('class='), 'class 必须被剥离（否则会覆盖用户字体设置）');
  assert.ok(!out.includes('align='));
  assert.ok(!out.includes('width='));
});

test('保留语义标签', () => {
  const out = sanitizeHtml('<p>段落<strong>粗</strong><em>斜</em></p><blockquote>引用</blockquote>');
  assert.ok(out.includes('<strong>'));
  assert.ok(out.includes('<em>'));
  assert.ok(out.includes('<blockquote>'));
});

test('移除 iframe / object 等危险标签', () => {
  const out = sanitizeHtml('<iframe src="http://evil.com"></iframe><p>正常</p>');
  assert.ok(!out.includes('iframe'));
  assert.ok(out.includes('正常'));
});

test('未闭合标签被补齐（不污染后续章节）', () => {
  const out = sanitizeHtml('<p>未闭合段落');
  assert.ok(out.includes('</p>'), `应补齐闭合标签，实际：${out}`);
});

test('注释与 CDATA 被移除', () => {
  const out = sanitizeHtml('<!-- 注释 --><p>正文</p><![CDATA[内容]]>');
  assert.ok(!out.includes('注释'));
  assert.ok(!out.includes('CDATA'));
  assert.ok(out.includes('正文'));
});

test('ensureParagraphs 把纯 br 文本转为段落', () => {
  const out = ensureParagraphs('第一行<br/>第二行<br>第三行');
  const pCount = (out.match(/<p>/g) || []).length;
  assert.strictEqual(pCount, 3, `期望 3 段，实际 ${pCount}：${out}`);
});

test('ensureParagraphs 清理空段落', () => {
  const out = ensureParagraphs('<p>有内容</p><p>&nbsp;</p><p>   </p>');
  assert.strictEqual((out.match(/<p>/g) || []).length, 1);
});

test('countChars 正确统计非空白字符', () => {
  const n = countChars('<p>你好世界</p><p>abc</p>');
  assert.strictEqual(n, 7);
});

/* ==================== 5. EPUB 解析 ==================== */

section('5. EPUB 解析');

/** 构造一个最小但结构完整的 EPUB3 */
async function buildEpubBuffer(opts) {
  const o = opts || {};
  const zip = new JSZip();

  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  const ch1 = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第一章</title><link rel="stylesheet" href="style.css"/><style>p{color:red}</style></head>
<body><h1>第一章 出发</h1>
<p class="c1" style="font-family:'Comic Sans'">清晨的阳光照进屋子，尘埃在光柱里浮动。</p>
<p>他收拾好行囊，准备启程。<strong>这一次</strong>，他没有回头。</p>
<script>console.log('should be removed')</script>
</body></html>`;

  const ch2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第二章</title></head>
<body><h2>第二章 相遇</h2>
<p>路上他遇见了一个老人。</p>
<p>老人说：&ldquo;年轻人，路还长。&rdquo;</p>
<p>他笑了笑，继续往前走。风从山谷里吹上来，带着松脂的味道。</p>
</body></html>`;

  zip.file('OEBPS/chapter1.xhtml', ch1);
  zip.file('OEBPS/chapter2.xhtml', ch2);
  zip.file('OEBPS/style.css', 'p { color: red; font-size: 30px; }');
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>
<li><a href="chapter1.xhtml">第一章 出发</a></li>
<li><a href="chapter2.xhtml">第二章 相遇</a></li>
</ol></nav></body></html>`);

  // 一张 1x1 的 PNG 作为封面
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  zip.file('OEBPS/cover.png', Buffer.from(pngB64, 'base64'));

  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${o.title || '测试之书'}</dc:title>
    <dc:creator>${o.author || '测试作者'}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`);

  return zip.generateAsync({ type: 'nodebuffer' });
}

test('解析 EPUB 元数据（书名 / 作者）', async () => {
  const buf = await buildEpubBuffer({ title: '苍穹之书', author: '某某' });
  const r = await parseEpub(buf);
  assert.strictEqual(r.meta.title, '苍穹之书');
  assert.strictEqual(r.meta.author, '某某');
  assert.strictEqual(r.meta.format, 'epub');
});

test('按 spine 顺序解析出章节', async () => {
  const buf = await buildEpubBuffer();
  const r = await parseEpub(buf);
  assert.ok(r.chapters.length >= 2, `期望至少 2 章，实际 ${r.chapters.length}`);
  assert.ok(r.chapters[0].html.includes('清晨的阳光'), '第一章内容应为 chapter1');
  assert.ok(r.chapters.some((c) => c.html.includes('老人')), '应包含第二章内容');
});

test('EPUB 内联样式被净化（保证换字体全局生效）', async () => {
  const buf = await buildEpubBuffer();
  const r = await parseEpub(buf);
  const all = r.chapters.map((c) => c.html).join('');
  assert.ok(!all.includes('Comic Sans'), '内联 font-family 必须被剥离');
  assert.ok(!all.includes('style='), '内联 style 必须被剥离');
  assert.ok(!all.includes('class='), 'class 必须被剥离');
  assert.ok(!all.includes('<script'), 'script 必须被移除');
});

test('EPUB 提取封面图片', async () => {
  const buf = await buildEpubBuffer();
  const r = await parseEpub(buf);
  assert.ok(r.meta.cover.startsWith('data:image/png;base64,'), '应提取到 data URL 封面');
});

test('EPUB 实体解码（&ldquo; → 中文引号）', async () => {
  const buf = await buildEpubBuffer();
  const r = await parseEpub(buf);
  const all = r.chapters.map((c) => c.html).join('');
  assert.ok(all.includes('\u201c') || all.includes('\u201d'), 'HTML 实体应被解码');
});

test('损坏的 EPUB 抛出可读错误', async () => {
  const zip = new JSZip();
  zip.file('readme.txt', 'not an epub');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  let threw = false;
  try {
    await parseEpub(buf);
  } catch (err) {
    threw = true;
    assert.ok(err.message.length > 0);
  }
  assert.ok(threw, '应当抛出错误');
});

test('空 zip 抛出错误而非崩溃', async () => {
  const zip = new JSZip();
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  let threw = false;
  try { await parseEpub(buf); } catch (_) { threw = true; }
  assert.ok(threw);
});

/* ==================== 6. 书名作者推断 ==================== */

section('6. 文件名元数据推断');

test('《书名》作者.txt', () => {
  const r = guessMetaFromFilename('D:\\books\\《斗破苍穹》天蚕土豆.txt');
  assert.strictEqual(r.title, '斗破苍穹');
  assert.strictEqual(r.author, '天蚕土豆');
});

test('书名 - 作者.txt', () => {
  const r = guessMetaFromFilename('/home/u/凡人修仙传 - 忘语.epub');
  assert.strictEqual(r.title, '凡人修仙传');
  assert.strictEqual(r.author, '忘语');
});

test('带序号前缀的文件名', () => {
  const r = guessMetaFromFilename('/x/01. 三体.txt');
  assert.ok(r.title.includes('三体'), `实际得到：${r.title}`);
});

test('纯书名不加作者', () => {
  const r = guessMetaFromFilename('/x/活着.txt');
  assert.strictEqual(r.title, '活着');
  assert.strictEqual(r.author, '');
});

test('不把「第一卷」误判为作者', () => {
  const r = guessMetaFromFilename('/x/某小说 - 第一卷.txt');
  assert.notStrictEqual(r.author, '第一卷');
});

/* ==================== 7. 封面生成 ==================== */

section('7. 自动封面生成');

test('生成合法 SVG data URL', () => {
  const url = generateCoverSvg('测试书名', '测试作者', 'txt');
  assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'));
  const svg = decodeURIComponent(url.split(',')[1]);
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.includes('</svg>'));
});

test('封面中书名被正确转义', () => {
  const url = generateCoverSvg('<script>&"', '作者', 'txt');
  const svg = decodeURIComponent(url.split(',')[1]);
  assert.ok(!svg.includes('<script>'), '书名中的 script 必须被转义');
});

test('同一书名生成稳定配色', () => {
  const a = coverGradient('同名书');
  const b = coverGradient('同名书');
  assert.deepStrictEqual(a, b);
});

test('不同书名生成不同配色', () => {
  const set = new Set();
  ['甲', '乙', '丙', '丁', '戊'].forEach((t) => set.add(coverGradient(t).join(',')));
  assert.ok(set.size > 1, '应产生多种配色');
});

/* ==================== 8. 书籍 id 稳定性 ==================== */

section('8. 书籍标识');

test('同一路径生成相同 id（避免重复导入）', () => {
  const a = makeId('D:\\books\\书.txt');
  const b = makeId('D:\\books\\书.txt');
  assert.strictEqual(a, b);
});

test('不同路径生成不同 id', () => {
  assert.notStrictEqual(makeId('D:\\a.txt'), makeId('D:\\b.txt'));
});

test('路径大小写归一（Windows 下同文件不重复）', () => {
  assert.strictEqual(makeId('D:\\Books\\A.txt'), makeId('d:\\books\\a.txt'));
});

/* ==================== 汇总 ==================== */

process.stdout.write('\n' + '─'.repeat(56) + '\n');

module.exports = { passed: () => passed, failed: () => failed, failures };

// 给 runner 用：等所有异步用例结束
setTimeout(() => {
  process.stdout.write(`\n编码与解析测试：通过 ${passed}，失败 ${failed}\n`);
  if (failed > 0) {
    process.stdout.write('\n失败用例：\n');
    failures.forEach((f) => {
      process.stdout.write(`  · ${f.name}\n    ${f.err.stack ? f.err.stack.split('\n')[0] : f.err.message}\n`);
    });
    process.exitCode = 1;
  }
}, 1200);

function isValidUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch (_) { return false; }
}