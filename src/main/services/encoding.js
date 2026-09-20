'use strict';

const iconv = require('iconv-lite');

/**
 * 中文网络小说 TXT 编码极其混乱：GBK / GB18030 / UTF-8 / UTF-16 / BIG5 都常见，
 * 且不少文件是「无 BOM 的 GBK」。用 Node 默认按 UTF-8 读会整篇乱码。
 *
 * 策略（优先级从高到低）：
 *   1. BOM 嗅探 —— 最可靠，直接决定
 *   2. 严格 UTF-8 校验 —— TextDecoder(fatal) 不抛异常即为合法 UTF-8
 *   3. jschardet 统计嗅探 —— 兜底判断 GBK/BIG5
 *   4. 打分裁决 —— 对候选编码解码后评估「乱码率」选最优
 */

let jschardet = null;
try {
  jschardet = require('jschardet');
} catch (_) {
  jschardet = null;
}

const BOMS = [
  { name: 'utf-8', bytes: [0xef, 0xbb, 0xbf], len: 3 },
  { name: 'utf-16le', bytes: [0xff, 0xfe], len: 2 },
  { name: 'utf-16be', bytes: [0xfe, 0xff], len: 2 },
];

function detectBom(buf) {
  for (const bom of BOMS) {
    if (buf.length < bom.len) continue;
    let hit = true;
    for (let i = 0; i < bom.len; i++) {
      if (buf[i] !== bom.bytes[i]) { hit = false; break; }
    }
    if (hit) return bom;
  }
  return null;
}

/** 严格校验是否为合法 UTF-8（用 fatal 让非法字节直接抛错） */
function isStrictUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 乱码率评估：解码后的文本里，替换符、控制字符、生僻私用区字符越多越可能是错编码。
 * 这是「猜错编码」和「猜对编码」最有效的区分特征。
 */
function mojibakeScore(text) {
  if (!text) return 1;
  const sample = text.length > 20000 ? text.slice(0, 20000) : text;
  let bad = 0;
  let cjk = 0;
  let total = 0;
  for (let i = 0; i < sample.length; i++) {
    const ch = sample.charCodeAt(i);
    total++;
    if (ch === 0xfffd) { bad += 3; continue; }                       // 替换符，最强负信号
    if (ch >= 0xe000 && ch <= 0xf8ff) { bad += 2; continue; }        // 私用区
    if (ch < 0x20 && ch !== 0x09 && ch !== 0x0a && ch !== 0x0d) { bad += 2; continue; } // 控制字符
    if (ch >= 0x4e00 && ch <= 0x9fff) { cjk++; continue; }           // 常用汉字
    if (ch >= 0x3400 && ch <= 0x4dbf) { cjk += 0.5; continue; }      // 扩展A
    if (ch >= 0x3000 && ch <= 0x303f) { cjk += 0.5; continue; }      // 中文标点
    if (ch >= 0xff00 && ch <= 0xffef) { cjk += 0.3; continue; }      // 全角
  }
  if (total === 0) return 1;
  // 得分越低越好：乱码惩罚 + 汉字占比奖励
  return (bad / total) * 2 + (1 - cjk / total);
}

function normalizeName(enc) {
  if (!enc) return null;
  const e = String(enc).toLowerCase().replace(/[_\s]/g, '-');
  const map = {
    'utf8': 'utf-8',
    'utf-8': 'utf-8',
    'ascii': 'utf-8',
    'us-ascii': 'utf-8',
    'gb2312': 'gb18030',       // GB2312 是 GB18030 子集，用超集解码更安全
    'gbk': 'gb18030',
    'gb18030': 'gb18030',
    'x-gbk': 'gb18030',
    'big5': 'big5',
    'big5-hkscs': 'big5',
    'utf-16': 'utf-16le',
    'utf16le': 'utf-16le',
    'utf-16le': 'utf-16le',
    'utf-16be': 'utf-16be',
    'windows-1252': 'gb18030',
    'iso-8859-1': 'gb18030',
  };
  return map[e] || (iconv.encodingExists(e) ? e : null);
}

/**
 * @param {Buffer} buf
 * @returns {{text: string, encoding: string, confidence: number}}
 */
function decodeBuffer(buf) {
  if (!buf || buf.length === 0) return { text: '', encoding: 'utf-8', confidence: 1 };

  // 1. BOM
  const bom = detectBom(buf);
  if (bom) {
    const body = buf.slice(bom.len);
    let enc = bom.name;
    let text;
    if (enc === 'utf-8') text = body.toString('utf8');
    else text = iconv.decode(body, enc);
    return { text, encoding: enc, confidence: 1 };
  }

  // 2. 严格 UTF-8
  if (isStrictUtf8(buf)) {
    return { text: buf.toString('utf8'), encoding: 'utf-8', confidence: 0.99 };
  }

  // 3. 候选集打分
  const candidates = [];
  const seen = new Set();
  const push = (name, conf) => {
    const norm = normalizeName(name);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    candidates.push({ name: norm, conf: conf || 0.5 });
  };

  if (jschardet) {
    try {
      const det = jschardet.detect(buf.slice(0, 300000));
      if (det && det.encoding) push(det.encoding, det.confidence || 0.5);
    } catch (_) {}
  }
  // 中文小说最常见的两种，无论如何都参与评选
  push('gb18030', 0.6);
  push('big5', 0.3);
  push('utf-16le', 0.2);

  let best = null;
  for (const c of candidates) {
    let text;
    try {
      text = iconv.decode(buf, c.name);
    } catch (_) {
      continue;
    }
    const score = mojibakeScore(text) - c.conf * 0.15; // 嗅探置信度给一点加权
    if (!best || score < best.score) best = { name: c.name, score, text };
  }

  if (best) return { text: best.text, encoding: best.name, confidence: 0.8 };
  return { text: iconv.decode(buf, 'gb18030'), encoding: 'gb18030', confidence: 0.4 };
}

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7',
};

function decodeEntities(str) {
  return String(str).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const isHex = ent[1] === 'x' || ent[1] === 'X';
      const code = parseInt(isHex ? ent.slice(2) : ent.slice(1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, ent) ? HTML_ENTITIES[ent] : m;
  });
}

/** 统一换行、去掉不可见脏字符、压缩超长空行 */
function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')   // 零宽字符 / 双向控制符
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]{3,}/g, '  ');
}

module.exports = { decodeBuffer, decodeEntities, normalizeText, mojibakeScore, normalizeName };