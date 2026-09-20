'use strict';

/**
 * 生成测试用的小说样本文件（真实可读，用于手动验收与端到端测试）。
 * 输出到 test/samples/
 */

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const JSZip = require('jszip');

const OUT = path.join(__dirname, 'samples');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/* ---------------- 1. UTF-8 TXT（标准章节格式） ---------------- */

const ch1 = `第一章 山雨欲来

　　山道弯弯，雾气未散。少年背着半旧的包袱，一步步往上走。

　　他叫林昭，今年十六岁。三日前，他还在山下的镇子里替人写书信，一日挣不过三十文钱。如今却站在这里，要往那传闻中的剑庐去。

　　"喂，前面的，让一让。"

　　身后传来一个清亮的声音。林昭回头，看见一个白衣少女牵着一匹马，正笑吟吟地望着他。马是枣红色的，四蹄雪白，一看便不是凡品。

　　"这条道，只通剑庐。"少女说，"你也是去求剑的？"

　　林昭沉默了一下，点了点头。

　　少女上下打量了他一番，忽然笑出声来："就凭你这身打扮？剑庐的门槛，可比你想的高得多。"`;

const ch2 = `第二章 白衣

　　少女自称姓苏，单名一个晴字。她说自己要去山上的剑庐，已经去过三次了。

　　"三次都没进去？"林昭有些意外。

　　"进是进去了。"苏晴牵着马，慢慢往前走，"只是剑庐的主人说，我心中无剑。"

　　她说这话的时候，语气很轻，仿佛在说别人的事。

　　林昭想了想，问："那你为什么还要去第四次？"

　　苏晴停下脚步，回头看他。山风把她的衣角吹得猎猎作响。

　　"因为我没有别的地方可去了。"

　　这句话说得很淡，林昭却听出了些别的东西。他没有再问。两个人就这样一前一后，沿着山道往上走。雾气在脚边翻涌，像是有生命的东西。`;

const ch3 = `第三章 剑庐

　　剑庐在雪山之巅，终年积雪不化。

　　林昭花了七天七夜才爬到山门之前。他的鞋磨破了，两条腿像灌了铅，可他到底还是站着走到了这里。苏晴比他早到了一天，正坐在石阶上，用手里的树枝在雪地上划着什么。

　　他抬头望着那块写着"剑庐"二字的石匾，忽然觉得，这一趟也许值得。

　　石匾很旧了，边角被风雪磨得圆钝，那两个字的笔锋却依旧凌厉，像是随时会从石头里跳出来。

　　"来了？"苏晴没有抬头。

　　"来了。"

　　"那就进去吧。"她把树枝一扔，站起身来，"我等你很久了。"`;

const ch4 = `第四章 无剑

　　剑庐里面比外面更冷。

　　四壁空空，只有正中央摆着一张矮几，几上放着一柄没有鞘的剑。剑身暗沉，看不出是什么材质。

　　"你们来求剑。"矮几后面坐着一个老人，须发皆白，"可剑庐里，只有这一柄剑。"

　　苏晴上前一步："那就够了。"

　　"不够。"老人摇头，"这柄剑，谁也拔不出来。三十年来，来过的人有两千三百一十七个。"

　　"那第三千一百一十八个呢？"林昭忽然问。

　　老人抬起眼，第一次正眼看他。

　　"你是说，你自己？"`;

const fullText = [ch1, ch2, ch3, ch4].join('\n\n');

fs.writeFileSync(path.join(OUT, '剑庐遗事 - 江城子.txt'), fullText, 'utf8');

/* ---------------- 2. GBK TXT（验证编码嗅探） ---------------- */

const gbkText = [
  '第一章 归乡',
  '',
  '　　火车在凌晨三点到站。',
  '',
  '　　陈默拖着行李箱走出车站，冷风一下子灌进领口。他离开这座小城已经十二年了。',
  '',
  '　　站前的路灯还亮着，昏黄的光落在积水里，碎成一片一片。',
  '',
  '　　"师傅，去老城区。"他拦下一辆出租车。',
  '',
  '　　司机从后视镜里看了他一眼："这个点去老城区？那边早拆得差不多了。"',
  '',
  '　　"我知道。"陈默说，"我只是想看看。"',
  '',
  '第二章 旧屋',
  '',
  '　　老城区的确拆了大半。',
  '',
  '　　剩下几栋楼孤零零地立着，窗户大多没了玻璃，在风里发出呜呜的声音。',
  '',
  '　　陈默凭着记忆找到那栋楼。三楼，东边第二户。他站在楼下仰头看了很久。',
  '',
  '　　楼道里的声控灯居然还能亮。他一级一级往上走，脚步声在狭窄的空间里回响。',
  '',
  '　　到了三楼，他停住了。',
  '',
  '　　那扇门上，还贴着他小时候贴的春联——只是已经褪成了灰白色。',
].join('\n');

fs.writeFileSync(path.join(OUT, '归乡记（GBK编码）.txt'), iconv.encode(gbkText, 'gbk'));

/* ---------------- 3. 无章节标记的 TXT（验证兜底切分） ---------------- */

const noChapter = [];
for (let i = 0; i < 260; i++) {
  noChapter.push(`这是第 ${i + 1} 段没有章节标记的连续文本。主角在这一段里做了一些事情，说了一些话，然后继续往前走。`);
  noChapter.push('');
}
fs.writeFileSync(path.join(OUT, '无章节标记测试.txt'), noChapter.join('\n'), 'utf8');

/* ---------------- 4. 真实结构的 EPUB ---------------- */

async function buildEpub() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');

  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  // 封面：用 SVG 转 PNG 也行，这里直接放一个渐变 PNG 占位
  const coverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#1e3a5f"/><stop offset="100%" stop-color="#4a7fb5"/></linearGradient></defs>
<rect width="600" height="800" fill="url(#g)"/>
<rect x="40" y="40" width="520" height="720" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="2"/>
<text x="300" y="360" text-anchor="middle" font-size="72" fill="#fff" font-family="serif">沧海月明</text>
<text x="300" y="440" text-anchor="middle" font-size="30" fill="rgba(255,255,255,.75)" font-family="serif">沈砚秋 著</text>
</svg>`;
  zip.file('OEBPS/images/cover.svg', coverSvg);

  const css = `body { font-family: "Times New Roman", serif; line-height: 2; }
p { text-indent: 2em; margin: 0 0 1em 0; color: #333; font-size: 18px; }
h1 { font-size: 1.6em; color: #1e3a5f; text-align: center; }
.intro { font-style: italic; color: #888; }`;

  zip.file('OEBPS/styles/main.css', css);

  const chapter = (num, title, paras) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <meta charset="utf-8"/>
  <title>${title}</title>
  <link rel="stylesheet" type="text/css" href="../styles/main.css"/>
</head>
<body>
  <h1>第${num}章　${title}</h1>
  ${paras.map((p, i) => `<p${i === 0 ? ' class="intro"' : ''} style="margin-top:${i === 0 ? '20px' : '0'}">${p}</p>`).join('\n  ')}
</body>
</html>`;

  zip.file('OEBPS/text/ch01.xhtml', chapter('一', '潮生', [
    '海面上浮着一层薄薄的月光，像是谁把银子碾碎了撒下去。',
    '沈砚秋坐在礁石上，已经很久没有动过。潮水一遍遍漫上他的靴子，又退下去，如此往复，仿佛一种不知疲倦的仪式。',
    '他手里捏着一封信，信纸已经被海风浸得发软，上面的字迹却依然清楚。那是三个月前寄来的，寄信人已经不在了。',
    '&ldquo;你若是看到了这封信，我大概已经不在了。&rdquo;信上这样写着。',
    '他没有哭。只是把信重新折好，放进胸前的口袋里，然后站起身，朝海里走去。',
  ]));

  zip.file('OEBPS/text/ch02.xhtml', chapter('二', '归舟', [
    '船是靠岸的第三天才来的。',
    '码头上的雾很大，沈砚秋站在栈桥尽头，看着那艘船一点点从雾里显出来，像是从另一个世界驶来。',
    '船老大跳下来系缆绳，抬眼看见他，愣了一下：&ldquo;你在这儿站了三天？&rdquo;',
    '&ldquo;我在等人。&rdquo;',
    '&ldquo;等人？&rdquo;船老大笑了，&ldquo;这趟船上就七个客人，都是做买卖的，没一个像是你要等的人。&rdquo;',
    '沈砚秋没有说话。他知道自己在等的人不会来。可他还是站在这里，因为除此之外，他不知道自己还能做什么。',
  ]));

  zip.file('OEBPS/text/ch03.xhtml', chapter('三', '月明', [
    '那一夜月亮很圆。',
    '沈砚秋坐在甲板上，听船底切开海水的声音。船老大拎着一壶酒过来，挨着他坐下。',
    '&ldquo;想什么呢？&rdquo;',
    '&ldquo;想一个人。&rdquo;',
    '船老大给他倒了一碗酒：&ldquo;想人是最没用的。想得再狠，人也不会回来。&rdquo;',
    '&ldquo;我知道。&rdquo;沈砚秋接过酒，喝了一口，辛辣的味道从喉咙一直烧到胃里。',
    '&ldquo;那你为什么还要想？&rdquo;',
    '沈砚秋沉默了很久，久到船老大以为他不会回答了。',
    '然后他说：&ldquo;因为如果连我都不想了，那她就真的不在了。&rdquo;',
  ]));

  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
      <li><a href="text/ch01.xhtml">第一章　潮生</a></li>
      <li><a href="text/ch02.xhtml">第二章　归舟</a></li>
      <li><a href="text/ch03.xhtml">第三章　月明</a></li>
    </ol>
  </nav>
</body>
</html>`);

  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:firmament-test-001"/></head>
  <docTitle><text>沧海月明</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1">
      <navLabel><text>第一章　潮生</text></navLabel>
      <content src="text/ch01.xhtml"/>
    </navPoint>
    <navPoint id="n2" playOrder="2">
      <navLabel><text>第二章　归舟</text></navLabel>
      <content src="text/ch02.xhtml"/>
    </navPoint>
    <navPoint id="n3" playOrder="3">
      <navLabel><text>第三章　月明</text></navLabel>
      <content src="text/ch03.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`);

  zip.file('OEBPS/package.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookId">urn:uuid:firmament-test-001</dc:identifier>
    <dc:title>沧海月明</dc:title>
    <dc:creator>沈砚秋</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>苍穹测试出版社</dc:publisher>
    <dc:date>2026-01-01</dc:date>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles/main.css" media-type="text/css"/>
    <item id="cover-image" href="images/cover.svg" media-type="image/svg+xml" properties="cover-image"/>
    <item id="ch01" href="text/ch01.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch02" href="text/ch02.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch03" href="text/ch03.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch01"/>
    <itemref idref="ch02"/>
    <itemref idref="ch03"/>
  </spine>
</package>`);

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(path.join(OUT, '沧海月明.epub'), buf);
}

/* ---------------- 5. 大文件压力样本 ---------------- */

function buildBigTxt() {
  const parts = [];
  for (let c = 1; c <= 300; c++) {
    parts.push(`第${c}章 第${c}节的故事`);
    parts.push('');
    for (let p = 0; p < 12; p++) {
      parts.push(`　　这是第${c}章的第${p + 1}段正文内容。主角在这里遇到了一些事情，说了一些话，然后又继续往前走。为了测试大文件下的解析与分页性能，这一段被有意写长了一些，包含足够多的字符。`);
      parts.push('');
    }
  }
  fs.writeFileSync(path.join(OUT, '大文件压力测试（300章）.txt'), parts.join('\n'), 'utf8');
  return parts.join('\n').length;
}

buildEpub().then(() => {
  const bigLen = buildBigTxt();
  const files = fs.readdirSync(OUT);
  console.log('已生成测试样本：');
  files.forEach((f) => {
    const st = fs.statSync(path.join(OUT, f));
    console.log(`  ${f}  ——  ${(st.size / 1024).toFixed(1)} KB`);
  });
  console.log(`\n大文件样本正文约 ${bigLen} 字符`);
}).catch((err) => {
  console.error('生成 EPUB 失败：', err);
  process.exit(1);
});