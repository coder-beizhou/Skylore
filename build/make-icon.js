'use strict';

/**
 * 生成应用图标（纯 Node，无第三方依赖）。
 *
 * 设计：深蓝渐变圆角方块 + 白色展开的书本（左右页向上倾斜形成 V 形书脊）
 *      + 书签缎带 + 顶部高光。输出 256×256 PNG。
 *
 * 同时输出多尺寸 PNG（16/24/32/48/64/128/256），供 electron-builder 生成 .ico。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build');

/* ---------------- 画布 ---------------- */

function createCanvas(size) {
  const px = Buffer.alloc(size * size * 4);
  const k = size / 256;                       // 以 256 为基准等比缩放

  // ⚠ 必须钳位到 0-255。颜色分量一旦超过 255（例如 259），
  //   Buffer 写入时会按字节回绕成 3，白色页面会莫名其妙变成亮黄色。
  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

  const blend = (x, y, r, g, b, a) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= size || yi >= size) return;
    const i = (yi * size + xi) * 4;
    const sa = Math.max(0, Math.min(1, a / 255));
    const da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) { px[i + 3] = 0; return; }
    px[i] = clamp255((r * sa + px[i] * da * (1 - sa)) / oa);
    px[i + 1] = clamp255((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = clamp255((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = clamp255(oa * 255);
  };

  /** 多边形填充（含 4x4 超采样抗锯齿） */
  const fillPoly = (pts, colorFn) => {
    const xs = pts.map((p) => p[0] * k);
    const ys = pts.map((p) => p[1] * k);
    const minX = Math.max(0, Math.floor(Math.min(...xs)) - 1);
    const maxX = Math.min(size - 1, Math.ceil(Math.max(...xs)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(...ys)) - 1);
    const maxY = Math.min(size - 1, Math.ceil(Math.max(...ys)) + 1);

    const inside = (px2, py2) => {
      let hit = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i][0] * k, yi = pts[i][1] * k;
        const xj = pts[j][0] * k, yj = pts[j][1] * k;
        if ((yi > py2) !== (yj > py2) && px2 < ((xj - xi) * (py2 - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };

    const SS = 3;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let cov = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) cov++;
          }
        }
        if (!cov) continue;
        const c = colorFn(x / k, y / k);
        if (!c) continue;
        blend(x, y, c[0], c[1], c[2], Math.round((c[3] * cov) / (SS * SS)));
      }
    }
  };

  /** 圆角矩形填充 */
  const fillRoundRect = (x0, y0, x1, y1, r, colorFn) => {
    const SS = 3;
    for (let y = Math.floor(y0 * k); y <= Math.ceil(y1 * k); y++) {
      for (let x = Math.floor(x0 * k); x <= Math.ceil(x1 * k); x++) {
        let cov = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const lx = (x + (sx + 0.5) / SS) / k;
            const ly = (y + (sy + 0.5) / SS) / k;
            const cx = Math.min(Math.max(lx, x0 + r), x1 - r);
            const cy = Math.min(Math.max(ly, y0 + r), y1 - r);
            const dx = lx - cx, dy = ly - cy;
            if (dx * dx + dy * dy <= r * r) cov++;
          }
        }
        if (!cov) continue;
        const c = colorFn(x / k, y / k);
        if (!c) continue;
        blend(x, y, c[0], c[1], c[2], Math.round((c[3] * cov) / (SS * SS)));
      }
    }
  };

  return { px, size, blend, fillPoly, fillRoundRect };
}

/* ---------------- 绘制 ---------------- */

function drawIcon(size) {
  const cv = createCanvas(size);
  const k = size / 256;

  /* 1. 底色：圆角方块 + 对角线渐变（靛蓝 → 天蓝） */
  cv.fillRoundRect(8, 8, 248, 248, 54, (x, y) => {
    const t = Math.min(1, Math.max(0, (x / 256) * 0.42 + (y / 256) * 0.58));
    // 平滑渐变曲线，避免中间发灰
    const e = t * t * (3 - 2 * t);
    return [
      Math.round(28 + e * 66),
      Math.round(46 + e * 92),
      Math.round(104 + e * 84),
      255,
    ];
  });

  /* 2. 顶部高光，让图标有体积感 */
  cv.fillRoundRect(8, 8, 248, 100, 54, (x, y) => {
    const t = Math.max(0, 1 - (y - 8) / 92);
    return [255, 255, 255, Math.round(20 * t * t)];
  });

  /* 3. 书本阴影（让书"压"在背景上） */
  cv.fillPoly(
    [[40, 128], [128, 106], [216, 128], [216, 206], [128, 210], [40, 206]],
    () => [0, 0, 0, 46]
  );

  /* 4. 左页：向上倾斜的书页（关键：不是矩形，要读出"打开的书"） */
  const leftPage = [[48, 116], [124, 98], [124, 192], [48, 202]];
  cv.fillPoly(leftPage, (x, y) => {
    // 页面自身有轻微明暗变化，模拟纸张受光
    const t = (x - 48) / 76;
    const v = 244 + t * 11;
    return [Math.round(v), Math.round(v + 1), Math.round(v + 6), 255];
  });

  /* 5. 右页 */
  const rightPage = [[132, 98], [208, 116], [208, 202], [132, 192]];
  cv.fillPoly(rightPage, (x, y) => {
    const t = (208 - x) / 76;
    const v = 236 + t * 12;
    return [Math.round(v), Math.round(v + 1), Math.round(v + 6), 255];
  });

  /* 6. 书脊中缝：深色阴影，分隔左右页 */
  cv.fillPoly([[124, 98], [132, 98], [132, 192], [124, 192]], () => [22, 38, 82, 210]);

  /* 7. 页码线：每页若干条细横线，强化"文字"意象 */
  for (let i = 0; i < 5; i++) {
    const y = 126 + i * 15;
    // 左页：随页面上沿倾斜
    const dyL = (116 - 98) * 0;   // 页面倾斜体现在 y 起点
    cv.fillPoly([[60, y - 2 + (y - 98) * 0.06], [112, y - 2 + (y - 98) * 0.06],
                 [112, y + 1 + (y - 98) * 0.06], [60, y + 1 + (y - 98) * 0.06]],
      () => [70, 96, 150, 60]);
    cv.fillPoly([[144, y - 2 + (y - 98) * 0.06], [196, y - 2 + (y - 98) * 0.06],
                 [196, y + 1 + (y - 98) * 0.06], [144, y + 1 + (y - 98) * 0.06]],
      () => [70, 96, 150, 60]);
  }
  // 左右页各留一行"短行"，更像真实排版
  cv.fillPoly([[60, 126 + 5 * 15 - 2], [92, 126 + 5 * 15 - 2], [92, 126 + 5 * 15 + 1], [60, 126 + 5 * 15 + 1]],
    () => [70, 96, 150, 60]);
  cv.fillPoly([[164, 126 + 5 * 15 - 2], [196, 126 + 5 * 15 - 2], [196, 126 + 5 * 15 + 1], [164, 126 + 5 * 15 + 1]],
    () => [70, 96, 150, 60]);

  /* 8. 书签缎带：从右页顶端垂下的金色条，点睛之笔 */
  cv.fillPoly([[168, 92], [184, 98], [186, 158], [176, 146], [168, 156]], () => [246, 186, 76, 255]);
  cv.fillPoly([[172, 98], [180, 101], [181, 148], [176, 141], [172, 146]], () => [255, 214, 130, 190]);

  /* 9. 底部厚度：书的纸叠层 */
  cv.fillPoly([[48, 202], [124, 192], [208, 202], [208, 208], [124, 199], [48, 208]],
    () => [214, 222, 240, 235]);

  return cv;
}

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const cr = Buffer.alloc(4);
  cr.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, cr]);
}

function encodePng(cv) {
  const { px, size } = cv;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;                    // filter: none
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- ICO 编码（多尺寸打包） ---------------- */

function encodeIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  const blobs = [];
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;   // 256 用 0 表示
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);           // color planes
    e.writeUInt16LE(32, 6);          // bpp
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

/* ---------------- 执行 ---------------- */

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const size of sizes) {
  const png = encodePng(drawIcon(size));
  pngs.push({ size, png });
  // 只把主尺寸单独存盘，其余仅用于 ico
  if (size === 256) fs.writeFileSync(path.join(OUT, 'icon.png'), png);
}

fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco(pngs));

console.log('图标生成完成：');
console.log('  build/icon.png  ' + fs.statSync(path.join(OUT, 'icon.png')).size + ' bytes (256×256)');
console.log('  build/icon.ico  ' + fs.statSync(path.join(OUT, 'icon.ico')).size + ' bytes (' + sizes.join('/') + ')');

/* ---------------- 许可文件（NSIS 安装界面用） ---------------- */

const license = `苍穹 · Firmament Reader
本地桌面小说阅读器

本软件完全离线运行：
  · 不联网、不上传任何数据
  · 无账号、无广告、无推荐
  · 你的书籍文件与阅读记录全部保存在本机

内置字体授权：
  · 马善政毛笔楷书（Ma Shan Zheng）— SIL Open Font License 1.1
  · 龙藏体（Long Cang）— SIL Open Font License 1.1
  · 站酷快乐体（ZCOOL KuaiLe）— SIL Open Font License 1.1
  完整授权文本见安装目录 resources/app.asar 内的 src/renderer/assets/fonts/LICENSE-*.txt

点击"下一步"即表示你已阅读并同意上述说明。
`;
fs.writeFileSync(path.join(OUT, 'license.txt'), license, 'utf8');
console.log('  build/license.txt  ' + Buffer.byteLength(license) + ' bytes');