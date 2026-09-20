/**
 * 段落可读性增强。
 *
 * 中文网文有几个排版通病，直接渲染会显得廉价：
 *   1. 对话行被首行缩进 2 字符 —— 纸书排版里对话不该缩进
 *   2. 超长段落（整段几百字）不拆分 —— 阅读疲劳
 *   3. 连续的「」引号段落挤在一起
 *   4. 章节内的分隔线（****、-----）被当成正文
 *
 * 这些都是在不改变原文一个字的前提下做「呈现层」优化。
 */

export class Paragraphs {
  constructor(settings) {
    this.settings = settings || {};
  }

  apply(root) {
    if (!root) return;
    const paras = root.querySelectorAll('p');
    if (!paras.length) return;

    const dialogIndent = this.settings.dialogNoIndent !== false;
    const splitLong = this.settings.splitLongParagraph !== false;
    const maxLen = this.settings.longParagraphLimit || 220;
    const decorateSep = this.settings.decorateSeparator !== false;

    let prevHadTrailingQuote = false;

    paras.forEach((p, i) => {
      // 跳过章节标题与导航
      if (p.closest('.chapter-nav') || p.classList.contains('chapter-heading')) return;

      const raw = p.textContent || '';
      const text = raw.trim();
      if (!text) { p.style.display = 'none'; return; }

      // 1. 分隔符段落
      if (decorateSep && this.isSeparator(text)) {
        p.classList.add('para-sep');
        p.setAttribute('data-sep', '· · ·');
        p.textContent = '';
        return;
      }

      // 2. 对话行不缩进
      if (dialogIndent && this.isDialog(text)) {
        p.classList.add('para-dialog');
      }

      // 3. 紧跟对话后的说明句也不缩进（形如「他说。」然后直接接）
      if (dialogIndent && prevHadTrailingQuote && text.length < 60 && !this.isDialog(text)) {
        // 保守起见不动，避免误伤正文
      }
      prevHadTrailingQuote = /[」』”"]$/.test(text);

      // 4. 超长段落拆分
      if (splitLong && text.length > maxLen && !p.classList.contains('para-dialog')) {
        this.splitParagraph(p, text, maxLen);
      }
    });
  }

  isSeparator(text) {
    const t = text.replace(/\s/g, '');
    if (t.length < 3 || t.length > 24) return false;
    // 常见分隔符：*** --- === ◆◆◆ ＊＊＊
    if (/^[*＊\-—_=＝~～·・.。•▪▫◆◇★☆※#＃+＋]{3,}$/.test(t)) return true;
    if (/^[※☆★◆◇]{1,6}$/.test(t)) return true;
    return false;
  }

  isDialog(text) {
    // 以成对引号开头，或以破折号开头（西式对话）
    if (/^[「『“"『]/.test(text)) return true;
    if (/^[—–-]{1,2}\s*[^\s]/.test(text) && text.length < 120) return true;
    return false;
  }

  /**
   * 长段落拆分：优先在句末标点处断开，保证语义完整。
   * 拆成 2-3 段，避免拆得过碎。
   */
  splitParagraph(p, text, maxLen) {
    const target = Math.ceil(text.length / Math.ceil(text.length / maxLen));
    if (target < 60) return;

    const chunks = [];
    let rest = text;
    while (rest.length > target * 1.5) {
      // 在 target 附近找句末标点
      const window = rest.slice(target - 30, target + 60);
      let cut = -1;
      const m = /[。！？…”」』](?=[^。！？…”」』]*$)/.exec(window);
      if (m) {
        cut = target - 30 + m.index + m[0].length;
      } else {
        const m2 = /[，；、]/.exec(window);
        if (m2) cut = target - 30 + m2.index + m2[0].length;
      }
      if (cut <= 20 || cut >= rest.length - 20) break;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) chunks.push(rest);
    if (chunks.length < 2) return;

    // 用原段落的标签替换为多个段落
    const frag = document.createDocumentFragment();
    chunks.forEach((c, idx) => {
      const np = document.createElement('p');
      np.textContent = c;
      np.className = p.className || '';
      if (idx > 0) np.classList.add('para-cont');
      frag.appendChild(np);
    });
    p.parentNode.replaceChild(frag, p);
  }
}