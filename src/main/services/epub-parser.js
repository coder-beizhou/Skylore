'use strict';

const path = require('path');
const JSZip = require('jszip');
const { normalizeText, decodeEntities } = require('./encoding');

/**
 * EPUB 解析。
 *
 * 关键设计：正文「净化」。
 * EPUB 自带 CSS 会覆盖用户的字体/字号设置，导致「换了字体有的章节变、有的没变」。
 * 所以这里剥掉 script/style/link、内联 style、class 和表现型属性，
 * 只保留语义标签，让全局排版设置完全接管。
 */

const KEEP_TAGS = new Set([
  'p', 'div', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'img', 'figure', 'figcaption', 'ruby', 'rt', 'rp', 'cite', 'q', 'abbr', 'span',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption',
]);

const DROP_TAGS = new Set([
  'script', 'style', 'link', 'meta', 'title', 'head', 'iframe', 'object', 'embed',
  'applet', 'audio', 'video', 'canvas', 'svg', 'math', 'form', 'input', 'button',
  'select', 'textarea', 'noscript', 'base', 'param', 'source', 'track',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'track', 'base', 'param']);
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'td', 'th', 'tr', 'table', 'ul', 'ol', 'figure', 'figcaption', 'hr', 'br', 'dl', 'dt', 'dd', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main']);
const KEEP_ATTRS = new Set(['src', 'alt', 'href', 'id', 'colspan', 'rowspan']);

function stripControl(s) {
  return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** 标签级净化：白名单保留、黑名单整段移除、其余解包 */
function sanitizeHtml(html, imgResolver) {
  if (!html) return '';
  let s = String(html);

  // 去掉注释 / CDATA / doctype / xml 声明
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '');
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '');

  // 整体移除黑名单标签（含其内容）
  for (const tag of DROP_TAGS) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  // 只取 body 内容
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(s);
  if (bodyMatch) s = bodyMatch[1];

  s = stripControl(s);

  const out = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)(\/?)>/g;
  let last = 0;
  let match;
  const openStack = [];

  while ((match = tagRe.exec(s)) !== null) {
    const [full, closing, rawName, rawAttrs] = match;
    const name = rawName.toLowerCase();

    // 标签之间的纯文本
    out.push(s.slice(last, match.index));
    last = match.index + full.length;

    if (DROP_TAGS.has(name)) continue;

    if (!KEEP_TAGS.has(name)) {
      // 未知标签（如 section/article/自定义命名空间）：解包，保留内部文字
      if (!closing && BLOCK_TAGS.has(name)) out.push('<br>');
      continue;
    }

    if (closing) {
      if (VOID_TAGS.has(name)) continue;
      out.push(`</${name}>`);
      continue;
    }

    // 收集保留属性
    const attrs = [];
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am;
    while ((am = attrRe.exec(rawAttrs)) !== null) {
      const an = am[1].toLowerCase();
      const av = am[2] !== undefined ? am[2] : am[3];
      if (!KEEP_ATTRS.has(an)) continue;              // 丢弃 style / class / width / align 等
      if (an === 'href') continue;                     // 站内锚点链接无意义，去掉避免跳转
      if (an === 'src') {
        const resolved = imgResolver ? imgResolver(decodeEntities(av)) : null;
        if (!resolved) continue;
        attrs.push(`src="${resolved}"`);
        continue;
      }
      attrs.push(`${an}="${String(av).replace(/"/g, '&quot;')}"`);
    }

    if (name === 'img' && !attrs.some((a) => a.startsWith('src='))) continue; // 图片取不到就丢掉

    out.push(`<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
    if (!VOID_TAGS.has(name)) openStack.push(name);
  }

  out.push(s.slice(last));

  let result = out.join('');
  // 补未闭合标签，避免污染后续章节
  while (openStack.length) result += `</${openStack.pop()}>`;
  return result;
}

/** 把「只有 br 换行」的正文转成 <p>，保证段落样式统一生效 */
function ensureParagraphs(html) {
  if (!html) return '';
  const hasBlock = /<(p|div|h[1-6]|blockquote|li|figure)\b/i.test(html);
  if (hasBlock) {
    // 清掉空段落
    return html
      .replace(/<p>\s*(?:&nbsp;|\u00a0|\s)*<\/p>/gi, '')
      .replace(/<div>\s*<\/div>/gi, '')
      .replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');
  }
  const parts = html
    .split(/(?:<br\s*\/?>\s*)+/i)
    .map((t) => t.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
  if (!parts.length) {
    const plain = html.replace(/<[^>]+>/g, '').trim();
    return plain ? `<p>${plain}</p>` : '';
  }
  return parts.map((p) => `<p>${p}</p>`).join('\n');
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '');
}

/**
 * 解码 HTML 实体到真实字符。
 * 真实 EPUB 里 &ldquo; / &mdash; / &#8220; 这类实体非常常见，
 * 不统一解码会导致正文里出现字面量的 "&ldquo;" 文字。
 *
 * 注意：此函数用于「已净化后的 HTML」的文本节点部分，
 * 所以要跳过标签内部的属性值，避免把 &amp; 在 src 里解错。
 */
function decodeHtmlEntities(html) {
  if (!html) return '';
  const parts = String(html).split(/(<[^>]*>)/);
  return parts.map((part) => {
    if (part.startsWith('<')) return part;      // 标签本身保持原样
    return decodeEntities(part);
  }).join('');
}

function countChars(html) {
  return decodeHtmlEntities(stripTags(html)).replace(/\s/g, '').length;
}

/**
 * 从 XML 文本里按标签名抓取元素。
 *
 * ⚠ 必须同时支持两种写法，否则在真实 EPUB 上会完全失效：
 *   自闭合： <item id="ch1" href="chapter1.xhtml"/>
 *   成对：   <title>第一章</title>
 * OPF 里的 <item> / <itemref> / <meta> 绝大多数是自闭合的，
 * 只匹配成对写法会导致 manifest / spine 全部读空。
 *
 * @returns {Array<{attrs: string, inner: string, selfClosing: boolean}>}
 */
function findAll(xml, tagName) {
  const out = [];
  if (!xml) return out;
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escaped}\\b([^>]*?)(\\/?)>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const selfClosing = m[2] === '/';
    if (selfClosing) {
      out.push({ attrs, inner: '', selfClosing: true });
      continue;
    }
    const closeRe = new RegExp(`<\\/${escaped}\\s*>`, 'i');
    const rest = xml.slice(re.lastIndex);
    const cm = closeRe.exec(rest);
    if (cm) {
      out.push({ attrs, inner: rest.slice(0, cm.index), selfClosing: false });
      re.lastIndex += cm.index + cm[0].length;
    } else {
      // 没有闭合标签：当成自闭合处理，避免吞掉后面全部内容
      out.push({ attrs, inner: '', selfClosing: true });
    }
  }
  return out;
}

function findFirst(xml, tagName) {
  const all = findAll(xml, tagName);
  return all.length ? all[0] : null;
}

/** 取某个容器标签的内部内容（如 manifest / spine / metadata） */
function containerInner(xml, tagName) {
  const el = findFirst(xml, tagName);
  return el ? el.inner : null;
}

function getAttr(attrStr, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(attrStr || '');
  if (!m) return null;
  return decodeEntities(m[1] !== undefined ? m[1] : m[2]);
}

/** EPUB 要求 URL 解码后再查 zip 条目 */
function normalizeZipPath(p) {
  if (!p) return '';
  let s = String(p).split('#')[0].split('?')[0];
  try { s = decodeURIComponent(s); } catch (_) {}
  return s.replace(/^\.\//, '').replace(/\\/g, '/');
}

function resolvePath(baseDir, rel) {
  const n = normalizeZipPath(rel);
  if (!n) return '';
  if (n.startsWith('/')) return n.slice(1);
  if (!baseDir) return n;
  const joined = path.posix.normalize(path.posix.join(baseDir, n));
  return joined.replace(/^\.\//, '');
}

function extToMime(p) {
  const ext = (path.extname(p) || '').toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp', '.avif': 'image/avif',
  };
  return map[ext] || 'image/jpeg';
}

/**
 * @param {Buffer} buf
 * @param {object} opts
 * @returns {Promise<{meta:object, chapters:Array}>}
 */
async function parseEpub(buf, opts) {
  const options = opts || {};
  const zip = await JSZip.loadAsync(buf);

  const fileMap = new Map();
  zip.forEach((relPath, file) => {
    if (!file.dir) fileMap.set(relPath.replace(/\\/g, '/'), file);
  });
  const lowerMap = new Map();
  for (const k of fileMap.keys()) lowerMap.set(k.toLowerCase(), k);

  const getEntry = (p) => {
    const n = normalizeZipPath(p);
    if (fileMap.has(n)) return fileMap.get(n);
    const hit = lowerMap.get(n.toLowerCase());
    return hit ? fileMap.get(hit) : null;
  };

  const readText = async (p) => {
    const e = getEntry(p);
    if (!e) return null;
    const ab = await e.async('nodebuffer');
    return new TextDecoder('utf-8').decode(ab);
  };

  // 1. container.xml → OPF 路径
  let opfPath = '';
  const container = await readText('META-INF/container.xml');
  if (container) {
    const rootfile = findFirst(container, 'rootfile');
    if (rootfile) opfPath = normalizeZipPath(getAttr(rootfile.attrs, 'full-path'));
  }
  if (!opfPath) {
    // 兜底：找任意 .opf
    for (const k of fileMap.keys()) {
      if (k.toLowerCase().endsWith('.opf')) { opfPath = k; break; }
    }
  }
  if (!opfPath) throw new Error('EPUB 结构异常：找不到 OPF 清单文件');

  const opf = await readText(opfPath);
  if (!opf) throw new Error('EPUB 结构异常：OPF 文件读取失败');

  const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);

  // 2. 元数据
  let title = options.title || '';
  let author = '';
  const dublin = findFirst(opf, 'dc:title') || findFirst(opf, 'title');
  if (dublin) title = stripTags(dublin.inner).trim();
  const creator = findFirst(opf, 'dc:creator') || findFirst(opf, 'creator');
  if (creator) author = stripTags(creator.inner).trim();
  if (!title) title = '未命名';
  if (!author) author = '佚名';

  // 3. manifest
  //
  // ⚠ 关键：必须把 <manifest> 块先取出来，再在其中匹配 <item>。
  //    findAll(opf,'item') 不会匹配到 <itemref>（因为要求后面紧跟边界符），
  //    但 findFirst/add 的"元素级"匹配若直接用整份 OPF，属性的正则可能跨标签误匹配，
  //    导致所有 spine 项都解析到同一个（错误的）href。这里严格按容器层级解析。
  const manifestBlock = containerInner(opf, 'manifest') || opf;

  const manifest = new Map();
  for (const item of findAll(manifestBlock, 'item')) {
    const id = getAttr(item.attrs, 'id');
    const href = getAttr(item.attrs, 'href');
    const mediaType = getAttr(item.attrs, 'media-type') || '';
    const properties = getAttr(item.attrs, 'properties') || '';
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href: resolvePath(opfDir, href),
      mediaType,
      properties,
    });
  }

  if (manifest.size === 0) throw new Error('EPUB 结构异常：manifest 中没有可用的资源项');

  // 4. 封面
  let coverUrl = '';
  let coverId = null;
  for (const meta of findAll(opf, 'meta')) {
    if ((getAttr(meta.attrs, 'name') || '').toLowerCase() === 'cover') {
      coverId = getAttr(meta.attrs, 'content');
    }
  }
  let coverItem = coverId ? manifest.get(coverId) : null;
  if (!coverItem) {
    for (const it of manifest.values()) {
      if (it.properties.includes('cover-image')) { coverItem = it; break; }
    }
  }
  if (!coverItem) {
    // 再次兜底：文件名含 cover 的图片
    for (const it of manifest.values()) {
      if ((it.mediaType || '').startsWith('image/') && /cover/i.test(it.href)) { coverItem = it; break; }
    }
  }
  if (coverItem) {
    const entry = getEntry(coverItem.href);
    if (entry) {
      try {
        const ab = await entry.async('base64');
        coverUrl = `data:${coverItem.mediaType || extToMime(coverItem.href)};base64,${ab}`;
      } catch (_) {}
    }
  }

  // 5. 图片解析器（相对当前章节路径）
  const imgCache = new Map();
  const makeImgResolver = (baseDir) => async (src) => {
    if (!src) return null;
    if (/^(data:|https?:)/i.test(src)) return /^data:/i.test(src) ? src : null;
    const full = resolvePath(baseDir, src);
    if (imgCache.has(full)) return imgCache.get(full);
    const entry = getEntry(full);
    if (!entry) return null;
    let url = full;
    try {
      const ab = await entry.async('base64');
      url = `data:${extToMime(full)};base64,${ab}`;
    } catch (_) {
      return null;
    }
    imgCache.set(full, url);
    return url;
  };

  // 6. spine 阅读顺序
  const spineBlock = containerInner(opf, 'spine') || '';
  const spineIds = [];
  for (const ref of findAll(spineBlock, 'itemref')) {
    const idref = getAttr(ref.attrs, 'idref');
    if (idref) spineIds.push(idref);
  }
  if (!spineIds.length) {
    // 没有 spine 时按 manifest 里的 xhtml 顺序兜底
    for (const it of manifest.values()) {
      if (/xhtml|html/i.test(it.mediaType)) spineIds.push(it.id);
    }
  }

  // 7. 目录标题映射（EPUB3 nav 优先，其次 NCX）
  const titleByHref = new Map();
  const tocTitleByHref = new Map();
  try {
    let navItem = null;
    for (const it of manifest.values()) {
      if (it.properties.split(/\s+/).includes('nav')) { navItem = it; break; }
    }
    if (!navItem) {
      for (const it of manifest.values()) {
        if (/\.ncx$/i.test(it.href) || it.mediaType === 'application/x-dtbncx+xml') { navItem = it; break; }
      }
    }
    if (navItem) {
      const navText = await readText(navItem.href);
      if (navText) {
        const navDir = path.posix.dirname(navItem.href) === '.' ? '' : path.posix.dirname(navItem.href);
        const isNcx = /\.ncx$/i.test(navItem.href);
        const pointRe = isNcx ? /<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi : /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
        let pm;
        while ((pm = pointRe.exec(navText)) !== null) {
          if (isNcx) {
            const inner = pm[1];
            const label = findFirst(inner, 'text');
            const content = findFirst(inner, 'content');
            if (!content) continue;
            const src = getAttr(content.attrs, 'src');
            const name = label ? stripTags(decodeEntities(label.inner)).trim() : '';
            if (src && name && !titleByHref.has(resolvePath(navDir, src))) {
              titleByHref.set(resolvePath(navDir, src), name);
            }
          } else {
            const src = getAttr(pm[1], 'href');
            const name = stripTags(decodeEntities(pm[2])).trim();
            if (src && name) {
              const key = resolvePath(navDir, src);
              if (!tocTitleByHref.has(key)) tocTitleByHref.set(key, name);
            }
          }
        }
      }
    }
  } catch (_) {}

  // 8. 逐章解析
  const chapters = [];
  const pending = [];
  for (const id of spineIds) {
    const item = manifest.get(id);
    if (!item) continue;
    if (!/xhtml|html|xml/i.test(item.mediaType || '') && !/\.(x?html?|xml)$/i.test(item.href)) continue;
    const raw = await readText(item.href);
    if (!raw) continue;
    const baseDir = path.posix.dirname(item.href) === '.' ? '' : path.posix.dirname(item.href);
    const resolver = makeImgResolver(baseDir);

    // 同步净化的图片解析：先收集需要解析的 src
    const srcs = [];
    const tmpRe = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
    let tm;
    while ((tm = tmpRe.exec(raw)) !== null) srcs.push(decodeEntities(tm[1] !== undefined ? tm[1] : tm[2]));
    const resolvedMap = new Map();
    for (const s of srcs) {
      if (!s || resolvedMap.has(s)) continue;
      resolvedMap.set(s, await resolver(s));
    }
    const syncResolver = (s) => {
      if (resolvedMap.has(s)) return resolvedMap.get(s);
      if (/^data:/i.test(s)) return s;
      return null;
    };

    const cleanRaw = sanitizeHtml(raw, syncResolver);
    const clean = decodeHtmlEntities(ensureParagraphs(cleanRaw));
    const chars = countChars(clean);
    const name = titleByHref.get(item.href) || tocTitleByHref.get(item.href) || '';
    pending.push({ href: item.href, title: name, html: clean, chars });
  }

  if (!pending.length) throw new Error('EPUB 正文为空：spine 未指向任何可解析的正文文档');

  // 9. 章节组织
  //
  // 规则（这是保证目录与正文一致的关键）：
  //   · 有目录标题的页 → 一律独立成章，绝不与相邻章合并
  //     （很多小说确实存在很短的章节，比如一首诗、一次转场；
  //       若按字数合并会直接破坏目录结构）
  //   · 无标题的碎片页（封面页 / 版权页 / 广告页）→ 累积起来，
  //     并入下一个有标题的章的开头；若确实内容较多则独立成章
  //   · 结尾残留的碎片 → 保留为独立章节，避免丢内容
  const MIN_CHARS = 200;
  const merged = [];
  let fragmentHtml = [];
  let fragmentChars = 0;

  const takeFragment = () => {
    const html = fragmentHtml.filter(Boolean).join('\n');
    const chars = fragmentChars;
    fragmentHtml = [];
    fragmentChars = 0;
    return { html, chars };
  };

  for (const item of pending) {
    if (!item.title) {
      fragmentHtml.push(item.html);
      fragmentChars += item.chars;
      continue;
    }
    const chapter = { title: item.title, html: item.html, chars: item.chars };
    // 把此前累积的无标题碎片并入本章开头，保持阅读顺序不丢内容
    const frag = takeFragment();
    if (frag.html && frag.chars < MIN_CHARS) {
      chapter.html = frag.html + '\n' + chapter.html;
      chapter.chars += frag.chars;
    } else if (frag.html) {
      merged.push({ title: '', html: frag.html, chars: frag.chars });
    }
    merged.push(chapter);
  }

  // 结尾残留的碎片
  const tail = takeFragment();
  if (tail.html) {
    merged.push({ title: '', html: tail.html, chars: tail.chars });
  }

  for (const c of merged) {
    if (!c.title) {
      const firstP = /<(?:p|h[1-6])[^>]*>([\s\S]{0,40}?)<\/(?:p|h[1-6])>/i.exec(c.html);
      c.title = firstP ? stripTags(firstP[1]).trim().slice(0, 30) : '';
    }
    if (!c.title) c.title = `第 ${chapters.length + 1} 章`;
    chapters.push({
      index: chapters.length,
      title: c.title,
      html: c.html,
      chars: c.chars,
    });
  }

  return {
    meta: {
      title,
      author,
      cover: coverUrl,
      format: 'epub',
      hasCover: !!coverUrl,
      chapterMode: 'spine',
    },
    chapters,
  };
}

module.exports = { parseEpub, sanitizeHtml, ensureParagraphs, stripTags, countChars, decodeHtmlEntities, findAll, findFirst, containerInner };