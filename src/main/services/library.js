'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseTxt } = require('./txt-parser');
const { parseEpub } = require('./epub-parser');
const { normalizeText } = require('./encoding');

/** 支持导入的扩展名 */
const SUPPORTED = {
  '.txt': 'txt',
  '.text': 'txt',
  '.epub': 'epub',
};

/**
 * 自动生成封面的版本号。
 * 封面排版的算法升级后（例如换行逻辑改进），旧书缓存里的 SVG 不会自动更新，
 * 用户会一直看到老封面。递增此版本号即可让老书在下次启动时自动重建封面。
 */
const COVER_VERSION = 2;

/** 生成稳定 id：同一路径重复导入不会产生重复书籍 */
function makeId(filePath) {
  const norm = path.resolve(filePath).toLowerCase();
  return crypto.createHash('md5').update(norm).digest('hex').slice(0, 16);
}

function fileFingerprint(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.size}-${Math.floor(st.mtimeMs)}`;
  } catch (_) {
    return '';
  }
}

/** 从文件名猜书名/作者：「《书名》作者.txt」「书名 - 作者.txt」 */
function guessMetaFromFilename(filePath) {
  let base = path.basename(filePath, path.extname(filePath));
  base = base.replace(/^\s*\d+[\s._-]*/, '').trim();     // 去掉开头的序号

  let title = base;
  let author = '';

  const patterns = [
    /^《([^》]+)》\s*[-—]?\s*(?:作者[:：]?)?\s*(.+)$/,
    /^(.+?)\s*[-—]\s*(?:作者[:：]?)?\s*([^\-—]+)$/,
    /^(.+?)\s+(?:by|著|作者[:：])\s*(.+)$/i,
    /^（(.+?)）\s*(.+)$/,
    /^\((.+?)\)\s*(.+)$/,
  ];
  for (const re of patterns) {
    const m = re.exec(base);
    if (m) {
      const t = (m[1] || '').trim();
      const a = (m[2] || '').trim();
      // 避免把「书名 - 第一卷」误判成作者
      if (t && a && a.length <= 20 && !/^第.+[章节卷]/.test(a)) {
        title = t.replace(/^《|》$/g, '').trim();
        author = a.replace(/^作者[:：]?/, '').trim();
        break;
      }
    }
  }
  title = title.replace(/^《|》$/g, '').trim() || base;
  return { title, author };
}

/** 从正文开头若干行里猜书名/作者（很多 TXT 前几行就是书名） */
function guessMetaFromContent(chapters, text) {
  const out = { title: '', author: '' };
  if (Array.isArray(chapters) && chapters.length) {
    const m = /^(.{1,40}?)[\s　]+(?:作者|著)[:：]\s*(.{1,20})$/.exec(chapters[0].title || '');
    if (m) {
      out.title = m[1].trim();
      out.author = m[2].trim();
    }
  }
  if (!out.title && text) {
    const head = text.slice(0, 1200);
    const m = /(?:书名|書名)[:：]\s*(.{1,40})/.exec(head);
    if (m) out.title = m[1].trim();
    const a = /(?:作者|著者)[:：]\s*(.{1,20})/.exec(head);
    if (a) out.author = a[1].trim();
  }
  return out;
}

/** 依据书名生成稳定的渐变色，用于无封面时的自动封面 */
function coverGradient(seed) {
  let h = 0;
  for (let i = 0; i < String(seed).length; i++) {
    h = (h * 31 + String(seed).charCodeAt(i)) % 360;
  }
  const palettes = [
    ['#2E4A7D', '#5B8AC9'], ['#6B3A5B', '#B06A96'], ['#2F5D50', '#5FA893'],
    ['#7A4A2B', '#C08552'], ['#3E3A66', '#7B74B8'], ['#5C3A2E', '#A6765C'],
    ['#26424F', '#54868F'], ['#5A4A21', '#AD9550'], ['#42304F', '#8469A3'],
    ['#1F4535', '#4E8A6C'],
  ];
  return palettes[h % palettes.length];
}

/**
 * 为封面切分标题行。
 *
 * 朴素地「每 5 字一行」会切出很难看的断点，例如：
 *   「归乡记（G / BK编码）」  —— 括号与英文被切开
 *   「大文件压力测试（30 / 0章）」 —— 数字被切开
 * 这里按「标签 + 宽度」估算换行，并避免在标点后立即断开。
 */
function wrapCoverTitle(title, opts) {
  const o = opts || {};
  const maxChars = o.maxChars || 6;     // 每行最多宽度（按全角字计）
  const maxLines = o.maxLines || 3;
  const text = String(title || '未命名');

  // 单个字符的视觉宽度（半角算 0.55）
  const widthOf = (ch) => (/[\x00-\xff]/.test(ch) ? 0.55 : 1);

  // 不应出现在行首的标点（避头尾）
  const noStart = '，。、；：？！）》」』】%…·,.;:?!)]}';
  // 不应出现在行尾的标点
  const noEnd = '（《「『【([{';
  // 行尾应被吞掉的"轻"字符：空格、连字符、波浪号
  const trimTail = ' -—–~～_·・';
  // 括号类需要成对处理：如果一行里只有开括号没有收括号，宁可整块挪到下一行
  const pairs = { '（': '）', '(': ')', '《': '》', '「': '」', '『': '』', '【': '】', '[': ']' };

  const lines = [];
  let i = 0;
  const chars = Array.from(text);

  while (i < chars.length && lines.length < maxLines) {
    let w = 0;
    let end = i;
    while (end < chars.length) {
      const ch = chars[end];
      const cw = widthOf(ch);
      if (w + cw > maxChars + 0.01) break;
      w += cw;
      end++;
    }
    if (end <= i) end = i + 1;   // 至少吃一个字符，避免死循环

    // 若下一字符是不该出现在行首的标点，则把它拉到本行末尾
    while (end < chars.length && noStart.includes(chars[end]) && w + widthOf(chars[end]) <= maxChars + 0.6) {
      w += widthOf(chars[end]);
      end++;
    }

    // 若本行最后一个字符是开括号类，说明括号没配对好 —— 把开括号推到下一行
    if (end > i + 1 && noEnd.includes(chars[end - 1])) {
      end--;
    }

    // 括号内部不应跨行：检查本行是否留下了未闭合的括号
    let cut = end;
    if (end < chars.length) {
      let stack = [];
      for (let k = i; k < end; k++) {
        const c = chars[k];
        if (pairs[c]) stack.push(pairs[c]);
        else if (stack.length && stack[stack.length - 1] === c) stack.pop();
      }
      if (stack.length) {
        // 有未闭合括号：回退到该开括号之前
        let back = end;
        for (let k = i; k < end; k++) {
          if (pairs[chars[k]]) { back = k; break; }
        }
        if (back > i) cut = back;
      }
    }
    end = cut;

    // 行尾的轻字符（空格、连字符）不要留在行末
    let tail = end;
    while (tail > i + 2 && trimTail.includes(chars[tail - 1])) tail--;
    if (tail > i) end = tail;

    lines.push(chars.slice(i, end).join(''));
    i = end;
  }

  // 超出最大行数时，最后一行加省略号
  if (i < chars.length) {
    const last = lines[lines.length - 1] || '';
    lines[lines.length - 1] = last.slice(0, Math.max(1, last.length - 1)) + '…';
  }

  return lines.filter(Boolean);
}

/** 生成 SVG 封面（无原图时使用），渲染层直接当 data url 用 */
function generateCoverSvg(title, author, format) {
  const [c1, c2] = coverGradient(title + author);
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const lines = wrapCoverTitle(title, { maxChars: 7, maxLines: 3 });

  // 45° 线性渐变需要长边标度；用 400x560 的对角线确保颜色铺满
  const lineEls = lines.map((ln, i) =>
    `<text x="50%" y="${33 + i * 12}%" text-anchor="middle" font-size="42" font-weight="600" fill="#ffffff" `
    + `font-family="'Microsoft YaHei','PingFang SC','Segoe UI',sans-serif" letter-spacing="2">${esc(ln)}</text>`
  ).join('');
  const authorEl = author && author !== '佚名'
    ? `<text x="50%" y="82%" text-anchor="middle" font-size="19" fill="rgba(255,255,255,.76)" font-family="'Microsoft YaHei','PingFang SC',sans-serif">${esc(String(author).slice(0, 12))}</text>`
    : '';
  const fmt = String(format || 'txt').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
</linearGradient>
</defs>
<rect width="400" height="560" fill="url(#g)"/>
<rect x="26" y="26" width="348" height="508" fill="none" stroke="rgba(255,255,255,.24)" stroke-width="1.5"/>
<rect x="18" y="0" width="12" height="560" fill="rgba(0,0,0,.15)"/>
${lineEls}
${authorEl}
<text x="50%" y="93%" text-anchor="middle" font-size="14" fill="rgba(255,255,255,.5)" font-family="'Microsoft YaHei',sans-serif" letter-spacing="2">${fmt}</text>
</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** 估算全书字数 */
function sumChars(chapters) {
  return chapters.reduce((acc, c) => acc + (c.chars || 0), 0);
}

class Library {
  constructor(store, dirs) {
    this.store = store;
    this.dirs = dirs;              // { dataDir, coverDir, fontDir, cacheDir }
    this.chapterCache = new Map(); // bookId -> chapters（内存缓存，避免重复解析）
  }

  ensureDirs() {
    for (const d of Object.values(this.dirs)) {
      if (d && !fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
  }

  getBooks() {
    return this.store.get('books') || [];
  }

  findBook(id) {
    return this.getBooks().find((b) => b.id === id) || null;
  }

  /** 解析单个文件为 { meta, chapters } */
  async parseFile(filePath, forceEncoding) {
    const ext = path.extname(filePath).toLowerCase();
    const format = SUPPORTED[ext];
    if (!format) throw new Error(`不支持的格式：${ext || '(无扩展名)'}`);

    const buf = fs.readFileSync(filePath);
    if (buf.length === 0) throw new Error('文件为空');

    const guessed = guessMetaFromFilename(filePath);
    let result;

    if (format === 'epub') {
      result = await parseEpub(buf, { title: guessed.title });
    } else {
      result = parseTxt(buf, { title: guessed.title });
      // TXT 优先用「文件名」或「正文里的作者信息」补全元数据
      const fromContent = guessMetaFromContent(result.chapters, null);
      if (guessed.author) result.meta.author = guessed.author;
      else if (fromContent.author) result.meta.author = fromContent.author;
      if (!result.meta.title) result.meta.title = guessed.title;
      result.meta.format = 'txt';
    }

    if (!result.chapters || !result.chapters.length) throw new Error('未能从文件中解析出任何正文内容');
    result.meta.format = result.meta.format || format;
    result.meta.chapterCount = result.chapters.length;
    result.meta.charCount = sumChars(result.chapters);
    return result;
  }

  /** 导入文件，返回书籍记录（已存在则返回原记录） */
  async importFile(filePath) {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${abs}`);
    const ext = path.extname(abs).toLowerCase();
    if (!SUPPORTED[ext]) throw new Error(`不支持的格式：${ext}（当前支持 TXT / EPUB）`);

    const id = makeId(abs);
    const existing = this.findBook(id);
    const fp = fileFingerprint(abs);

    if (existing && existing.fingerprint === fp) {
      return { duplicate: true, book: existing };
    }

    const parsed = await this.parseFile(abs);
    const st = fs.statSync(abs);

    // 封面：EPUB 自带优先，否则生成 SVG 封面
    let cover = parsed.meta.cover || '';
    if (!cover) {
      cover = generateCoverSvg(parsed.meta.title, parsed.meta.author, parsed.meta.format);
    }

    const record = {
      id,
      title: parsed.meta.title || path.basename(abs, ext),
      author: parsed.meta.author || '佚名',
      format: parsed.meta.format,
      encoding: parsed.meta.encoding || '',
      path: abs,
      size: st.size,
      fingerprint: fp,
      cover,
      coverVersion: COVER_VERSION,
      chapterCount: parsed.chapters.length,
      charCount: parsed.meta.charCount,
      group: (existing && existing.group) || '默认分组',
      addedAt: (existing && existing.addedAt) || Date.now(),
      lastReadAt: (existing && existing.lastReadAt) || 0,
      favorite: (existing && existing.favorite) || false,
    };

    this.store.update((d) => {
      const idx = d.books.findIndex((b) => b.id === id);
      if (idx >= 0) d.books[idx] = { ...d.books[idx], ...record };
      else d.books.unshift(record);
      return record;
    });

    // 解析结果进内存缓存
    this.chapterCache.set(id, {
      chapters: parsed.chapters,
      parsedAt: Date.now(),
    });

    return { duplicate: false, book: record, replaced: !!existing };
  }

  /** 批量导入，逐项报告成功与失败 */
  async importFiles(filePaths) {
    const results = [];
    for (const p of filePaths) {
      try {
        const r = await this.importFile(p);
        results.push({ path: p, ok: true, duplicate: r.duplicate, book: r.book });
      } catch (err) {
        results.push({ path: p, ok: false, error: err.message });
      }
    }
    return {
      total: filePaths.length,
      success: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      duplicates: results.filter((r) => r.ok && r.duplicate).length,
      results,
    };
  }

  /** 递归扫描目录下的小说文件 */
  scanFolder(dir, depth) {
    const maxDepth = typeof depth === 'number' ? depth : 4;
    const out = [];
    const walk = (cur, level) => {
      if (level > maxDepth) return;
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          if (/^[.\$]|node_modules|System Volume Information/i.test(e.name)) continue;
          walk(full, level + 1);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (SUPPORTED[ext]) out.push(full);
        }
      }
    };
    walk(dir, 0);
    return out;
  }

  /** 取章节内容；内存没命中就按需解析（大文件懒加载） */
  async getChapters(bookId, force) {
    const cached = this.chapterCache.get(bookId);
    if (cached && !force) return cached.chapters;

    const book = this.findBook(bookId);
    if (!book) throw new Error('书籍不存在');
    if (!fs.existsSync(book.path)) throw new Error(`源文件已丢失：${book.path}`);

    const parsed = await this.parseFile(book.path);
    this.chapterCache.set(bookId, { chapters: parsed.chapters, parsedAt: Date.now() });
    return parsed.chapters;
  }

  async getChapter(bookId, index) {
    const chapters = await this.getChapters(bookId);
    const i = Math.max(0, Math.min(chapters.length - 1, Number(index) || 0));
    const ch = chapters[i];
    if (!ch) return null;
    return {
      index: i,
      title: ch.title,
      html: ch.html,
      chars: ch.chars,
      total: chapters.length,
      prevTitle: i > 0 ? chapters[i - 1].title : null,
      nextTitle: i + 1 < chapters.length ? chapters[i + 1].title : null,
    };
  }

  /** 目录：只回标题，避免把全文传到渲染层 */
  async getToc(bookId) {
    const chapters = await this.getChapters(bookId);
    return chapters.map((c, i) => ({ index: i, title: c.title, chars: c.chars }));
  }

  removeBook(id, deleteFile) {
    const book = this.findBook(id);
    this.chapterCache.delete(id);
    this.store.update((d) => {
      d.books = d.books.filter((b) => b.id !== id);
      delete d.progress[id];
      delete d.bookmarks[id];
    });
    return { removed: !!book, path: book ? book.path : null, deleteFile: !!deleteFile };
  }

  updateBook(id, patch) {
    return this.store.update((d) => {
      const b = d.books.find((x) => x.id === id);
      if (!b) return null;
      Object.assign(b, patch);
      return b;
    });
  }

  /** 搜索：书名 / 作者 / 全部正文（正文搜索限量，避免卡顿） */
  async search(bookId, keyword, scope) {
    const kw = String(keyword || '').trim();
    if (!kw) return [];
    const lower = kw.toLowerCase();
    const results = [];

    if (scope === 'library' || !bookId) {
      for (const b of this.getBooks()) {
        if (b.title.toLowerCase().includes(lower) || (b.author || '').toLowerCase().includes(lower)) {
          results.push({ type: 'book', bookId: b.id, title: b.title, author: b.author, cover: b.cover });
        }
      }
      if (scope === 'library' || bookId) return results;
    }

    const chapters = await this.getChapters(bookId);
    const MAX = 300;
    for (let i = 0; i < chapters.length && results.length < MAX; i++) {
      const plain = String(chapters[i].html || '').replace(/<[^>]+>/g, '');
      let from = 0;
      let hitCount = 0;
      while (results.length < MAX && hitCount < 5) {
        const at = plain.toLowerCase().indexOf(lower, from);
        if (at === -1) break;
        results.push({
          type: 'content',
          bookId,
          chapterIndex: i,
          chapterTitle: chapters[i].title,
          snippet: plain.slice(Math.max(0, at - 30), at + kw.length + 40).replace(/\s+/g, ' '),
          offset: at,
        });
        from = at + kw.length;
        hitCount++;
      }
    }
    return results;
  }

  /** 清理无效书籍（源文件被删除/移动） */
  validateBooks() {
    const missing = [];
    for (const b of this.getBooks()) {
      if (!fs.existsSync(b.path)) missing.push({ id: b.id, title: b.title, path: b.path });
    }
    return missing;
  }

  /**
   * 重建自动生成的封面。
   *
   * 两个用途：
   *   1. 封面生成算法升级后，让老书自动更新（依据 coverVersion 判定）
   *   2. 用户手动点击「重建封面」
   *
   * 只处理「自动生成」的封面（data:image/svg+xml 且非 EPUB 提取的图片），
   * 绝不覆盖 EPUB 自带的真实封面。
   *
   * @param {object} opts { force: boolean }  force=true 时忽略版本号全部重建
   * @returns {{ updated: number }}
   */
  regenerateCovers(opts) {
    const o = opts || {};
    const books = this.getBooks();
    let updated = 0;

    this.store.update((d) => {
      for (const b of d.books) {
        const cover = b.cover || '';
        const isAutoSvg = cover.startsWith('data:image/svg+xml');
        // EPUB 提取的位图封面（data:image/png|jpeg…）保持不动
        if (!isAutoSvg) continue;
        if (!o.force && (b.coverVersion || 0) >= COVER_VERSION) continue;

        b.cover = generateCoverSvg(b.title, b.author, b.format);
        b.coverVersion = COVER_VERSION;
        updated++;
      }
      return updated;
    });

    if (updated > 0) this.chapterCache.clear();
    return { updated };
  }

  /** 重新解析指定书籍（元数据/章节变动后刷新缓存） */
  async reloadBook(id) {
    const book = this.findBook(id);
    if (!book) throw new Error('书籍不存在');
    if (!fs.existsSync(book.path)) throw new Error(`源文件已丢失：${book.path}`);

    const parsed = await this.parseFile(book.path);
    const cover = parsed.meta.cover
      || generateCoverSvg(parsed.meta.title, parsed.meta.author, parsed.meta.format);

    this.store.update((d) => {
      const b = d.books.find((x) => x.id === id);
      if (!b) return null;
      b.title = parsed.meta.title || b.title;
      b.author = parsed.meta.author || b.author;
      b.chapterCount = parsed.chapters.length;
      b.charCount = parsed.meta.charCount;
      b.cover = cover;
      b.coverVersion = COVER_VERSION;
      return b;
    });

    this.chapterCache.set(id, { chapters: parsed.chapters, parsedAt: Date.now() });
    return this.findBook(id);
  }
}

module.exports = {
  Library,
  SUPPORTED,
  makeId,
  generateCoverSvg,
  coverGradient,
  guessMetaFromFilename,
  sumChars,
};