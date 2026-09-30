// Generate A4 landscape iPhone 18 Pro commercial poster PDF
// A4 landscape: 842 x 595 pt (1mm = 2.83465 pt)
const fs = require('fs');
const path = require('path');
const http = require('http');
const PDFDocument = require('pdfkit');

const WORKSPACE = '/home/agent/.claude/workspace/project';
const FONT_REG = path.join(WORKSPACE, 'fonts/NotoSansCJKsc-Regular.otf');
const FONT_BOLD = path.join(WORKSPACE, 'fonts/NotoSansCJKsc-Bold.otf');
const OUT_PDF = path.join(WORKSPACE, 'iphone18pro-poster.pdf');
const IMG_URL = 'http://localhost:8082/api/projects/3eeb22a8ecdd/images/f4424f21eebd51aa.jpg';

function fetchImage(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error('image fetch failed: ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  let imgBytes = null;
  try { imgBytes = await fetchImage(IMG_URL); console.log('Image bytes:', imgBytes.length); }
  catch (e) { console.warn('Image fetch failed, continuing without image:', e.message); }

  const doc = new PDFDocument({
    size: [842, 595],   // A4 landscape (width, height in pt)
    margin: 0,
    info: { Title: 'iPhone 18 Pro 现货', Author: 'Apple Style Poster' }
  });
  const stream = fs.createWriteStream(OUT_PDF);
  doc.pipe(stream);

  // Register CJK fonts
  const hasReg = fs.existsSync(FONT_REG);
  const hasBold = fs.existsSync(FONT_BOLD);
  if (hasReg) doc.registerFont('cjk', FONT_REG);
  if (hasBold) doc.registerFont('cjkBold', FONT_BOLD);

  const useFont = (name, size, color = '#000') => {
    doc.font(hasReg ? name : 'Helvetica').fontSize(size).fillColor(color);
  };

  const BLACK_BG = '#0a0a0a';
  const DARK_GRAY = '#1d1d1f';
  const GRAY = '#6e6e73';
  const LIGHT_GRAY = '#d2d2d7';
  const TEXT_DARK = '#1d1d1f';
  const TEXT_MID = '#424245';
  const BLUE = '#06c';
  const WHITE = '#ffffff';

  const W = 842, H = 595;
  const HALF = W / 2;

  // ===== LEFT HALF: dark product showcase =====
  // Background gradient (simulate by drawing two rects blended visually)
  doc.rect(0, 0, HALF, H).fill(BLACK_BG);
  doc.rect(0, 0, HALF, H).fillOpacity(0.5).fill(DARK_GRAY);
  doc.fillOpacity(1);

  // Glow effect (soft white circle in center)
  doc.save();
  doc.circle(HALF / 2, H / 2, 200).fillOpacity(0.06).fill(WHITE);
  doc.fillOpacity(1);
  doc.restore();

  // Product image — fit into left half, keeping aspect
  if (imgBytes) {
    try {
      doc.image(imgBytes, 30, 40, {
        fit: [HALF - 60, H - 80],
        align: 'center',
        valign: 'center'
      });
    } catch (e) {
      console.warn('image embed failed:', e.message);
    }
  }

  // Stock badge (top-left of product side)
  useFont(hasReg ? 'cjk' : 'Helvetica', 10, WHITE);
  doc.fillOpacity(1);
  // green dot
  doc.circle(48, 44, 4).fill('#1a7f37');
  doc.fillColor(WHITE).text('现货在售', 60, 38, { lineBreak: false });

  // ===== RIGHT HALF: white info panel =====
  doc.rect(HALF, 0, HALF, H).fill(WHITE);

  // Eyebrow
  useFont(hasBold ? 'cjkBold' : 'Helvetica', 12, GRAY);
  doc.text('IPHONE 18 PRO', HALF + 50, 70, { characterSpacing: 4, lineBreak: false });

  // Hero title
  useFont(hasBold ? 'cjkBold' : 'Helvetica', 56, TEXT_DARK);
  doc.text('iPhone 18 Pro', HALF + 50, 95, { lineBreak: false });

  // Subtitle
  useFont(hasReg ? 'cjk' : 'Helvetica', 22, TEXT_DARK);
  doc.text('钛金属 · 全新登场', HALF + 50, 165, { characterSpacing: 0.5, lineBreak: false });

  // Divider line
  doc.moveTo(HALF + 50, 215).lineTo(HALF + 50 + 150, 215).strokeColor(LIGHT_GRAY).lineWidth(1).stroke();

  // Description
  useFont(hasReg ? 'cjk' : 'Helvetica', 14, TEXT_MID);
  doc.text('搭载全新 A20芯片，专业级影像系统再次突破。', HALF + 50, 235, { width: HALF - 100, lineBreak: false });
  doc.text('即刻拥有，开启下一段精彩。', HALF + 50, 258, { width: HALF - 100, lineBreak: false });

  // Price grid
  const priceY = 305;
  const cardW = (HALF - 100 - 20) / 2;
  const card1X = HALF + 50;
  const card2X = card1X + cardW + 20;

  // Card 1: 256GB
  doc.moveTo(card1X, priceY).lineTo(card1X + cardW, priceY).strokeColor(LIGHT_GRAY).lineWidth(1).stroke();
  useFont(hasReg ? 'cjk' : 'Helvetica', 11, GRAY);
  doc.text('256GB', card1X, priceY + 8, { lineBreak: false });
  useFont(hasBold ? 'cjkBold' : 'Helvetica', 32, TEXT_DARK);
  doc.text('¥10,798', card1X, priceY + 28, { lineBreak: false });

  // Card 2: 512GB
  doc.moveTo(card2X, priceY).lineTo(card2X + cardW, priceY).strokeColor(LIGHT_GRAY).lineWidth(1).stroke();
  useFont(hasReg ? 'cjk' : 'Helvetica', 11, GRAY);
  doc.text('512GB', card2X, priceY + 8, { lineBreak: false });
  useFont(hasBold ? 'cjkBold' : 'Helvetica', 32, TEXT_DARK);
  doc.text('¥12,798', card2X, priceY + 28, { lineBreak: false });

  // Features list
  const featY = 395;
  useFont(hasReg ? 'cjk' : 'Helvetica', 12, TEXT_MID);
  const feats = ['全新未拆封 · 国行正品', '顺丰当日发货 · 全国联保', '支持以旧换新 · 分期免息'];
  feats.forEach((f, i) => {
    const y = featY + i * 26;
    doc.circle(card1X + 4, y + 6, 2.5).fill(TEXT_DARK);
    doc.fillColor(TEXT_MID).text(f, card1X + 16, y, { lineBreak: false });
  });

  // CTA buttons
  const ctaY = 500;
  // Black pill button
  doc.save();
  doc.roundedRect(card1X, ctaY, 130, 38, 19).fill(TEXT_DARK);
  doc.restore();
  useFont(hasReg ? 'cjk' : 'Helvetica', 13, WHITE);
  doc.text('立即购买  ›', card1X, ctaY + 12, { width: 130, align: 'center', lineBreak: false });

  // Blue link
  useFont(hasReg ? 'cjk' : 'Helvetica', 13, BLUE);
  doc.text('了解更多 →', card1X + 150, ctaY + 12, { lineBreak: false });

  // Stock info (bottom-right of info side)
  useFont(hasReg ? 'cjk' : 'Helvetica', 9, GRAY);
  doc.text('现货有限 · 售完即止', HALF + HALF - 50 - 150, H - 30, { width: 150, align: 'right', lineBreak: false });

  doc.end();

  stream.on('finish', () => {
    const size = fs.statSync(OUT_PDF).size;
    console.log('PDF written:', OUT_PDF, '(' + size + ' bytes)');
  });
  stream.on('error', e => console.error('stream error:', e));
})();