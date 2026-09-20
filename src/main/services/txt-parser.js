'use strict';

const { decodeBuffer, normalizeText, decodeEntities } = require('./encoding');

/**
 * 章节标题识别。中文网文的章头写法极其自由，这里按「必须整行匹配」来判定，
 * 避免把正文里出现的「第三章」当成章头。
 */
const CH_PATTERNS = [
  // 第X章/节/回/卷/篇/集/部/话/幕/折 + 可选标题
  /^第\s*[0-9零一二三四五六七八九十百千万两〇○]{1,12}\s*[章节節回卷篇集部话話幕折]\s*[^\n]{0,40}$/,
  // 正文 第X章（带空格分隔）
  /^[0-9]{1,4}[、.．,，]\s*[^\n]{1,40}$/,
  // Chapter N / CHAPTER N
  /^chapter\s+[0-9ivxlc]{1,8}\b[^\n]{0,40}$/i,
  // 特殊固定章名
  /^(序章|序言|序|前言|引子|楔子|引言|自序|开篇|卷首语|尾声|后记|後記|终章|終章|结局|結局|番外|外传|外傳|附录|附録|作者的话|作者的話)[\s:：、.．]?[^\n]{0,30}$/,
  // 数字编号行：1  0001
  /^[0-9]{1,4}$/,
  // 全角/中文数字编号
  /^[零一二三四五六七八九十百千]{1,6}[、.．]?$/,
  // 卷标题：如「卷一 少年游」「第1卷」
  /^[卷部篇]\s*[0-9零一二三四五六七八九十百千万两〇○]{1,6}\s*[^\n]{0,30}$/,
  // 括号包裹的章节名
  /^[\[【(（][^\n\]]{1,30}[\]】)）]$/,
];

const MAX_CHAPTER_TITLE_LEN = 48;

function isChapterTitle(line) {
  const t = line.trim();
  if (!t) return false;
  if (t.length > MAX_CHAPTER_TITLE_LEN) return false;
  // 章头不应含句号/问号/感叹号结尾（那是正文语气），但允许书名号等
  if (/[。！？；]$/.test(t) && !/^第\s*[0-9零一二三四五六七八九十百千万两〇○]{1,12}\s*[章节節回卷篇集部话話幕折]/.test(t)) {
    return false;
  }
  // 正文句子通常较长且含逗号；章头极少含逗号
  if (t.length > 22 && /[,，]/.test(t)) return false;
  for (const re of CH_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把纯文本正文转成段落 HTML（渲染层统一按 <p> 处理） */
function textToHtml(body) {
  const paras = body
    .split(/\n+/)
    .map((p) => p.replace(/\s+$/, '').trim())
    .filter((p) => p.length > 0);
  if (!paras.length) return '';
  return paras.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
}

/** 按固定字数切分（无章头时的兜底），尽量落在句读处 */
function splitByLength(text, chunkSize) {
  const size = chunkSize || 3000;
  const chunks = [];
  let cursor = 0;
  const len = text.length;
  while (cursor < len) {
    let end = Math.min(cursor + size, len);
    if (end < len) {
      // 从目标位置往后找最近的换行，最多再容忍 800 字
      const nl = text.indexOf('\n', end);
      if (nl !== -1 && nl - end < 800) end = nl;
    }
    chunks.push([cursor, end]);
    cursor = end;
  }
  return chunks;
}

/**
 * 解析 TXT
 * @param {Buffer} buf
 * @param {object} opts
 * @returns {{meta:object, chapters:Array}}
 */
function parseTxt(buf, opts) {
  const options = opts || {};
  const { text: rawText, encoding, confidence } = decodeBuffer(buf);
  const text = normalizeText(decodeEntities(rawText));

  const lines = text.split('\n');
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    if (isChapterTitle(lines[i])) markers.push(i);
  }

  const chapters = [];
  const title = options.title || '未命名';

  if (markers.length === 0) {
    // 完全无章头：按字数切段，保证任何 TXT 都能正常阅读
    const ranges = splitByLength(text, 3000);
    ranges.forEach(([s, e], idx) => {
      chapters.push({
        index: idx,
        title: `第 ${idx + 1} 节`,
        html: textToHtml(text.slice(s, e)),
        chars: e - s,
      });
    });
    return {
      meta: { title, author: '佚名', encoding, confidence, chapterMode: 'length' },
      chapters,
    };
  }

  // 章头之前的内容作为「前言」
  if (markers[0] > 0) {
    const head = lines.slice(0, markers[0]).join('\n');
    if (head.trim().length > 30) {
      chapters.push({ index: 0, title: '前言', html: textToHtml(head), chars: head.length });
    }
  }

  markers.forEach((startLine, i) => {
    const endLine = i + 1 < markers.length ? markers[i + 1] : lines.length;
    const titleLine = lines[startLine].trim();
    const body = lines.slice(startLine + 1, endLine).join('\n');
    // 过滤掉只有标题没有正文的空章
    if (body.replace(/\s/g, '').length === 0 && endLine - startLine <= 1) return;
    chapters.push({
      index: chapters.length,
      title: titleLine,
      html: textToHtml(body),
      chars: body.length,
    });
  });

  chapters.forEach((c, i) => { c.index = i; });

  return {
    meta: { title, author: '佚名', encoding, confidence, chapterMode: 'marker' },
    chapters,
  };
}

module.exports = { parseTxt, isChapterTitle, textToHtml, escapeHtml, splitByLength };