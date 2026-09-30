const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType } = require('docx');

const PORT = 8082;
const WORKSPACE_DIR = '/home/agent/.claude/workspace/project';
const DATA_DIR = path.join(WORKSPACE_DIR, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const LOG_FILE = path.join(WORKSPACE_DIR, 'logs/run.log');
const CLAUDE_TIMEOUT_MS = 60 * 1000; // 60 seconds for Claude ask — if it hangs, fall back to template
const TIMEOUT_MS = 600 * 1000; // 10 minutes for the HTTP request socket

// Ensure directories exist
[DATA_DIR, PROJECTS_DIR, IMAGES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        fs.appendFileSync(LOG_FILE, line);
    } catch (e) {}
    console.log(msg);
}

function getJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

function sendText(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
}

// Project storage helpers
// Project structure:
// projects/{projectId}/meta.json - contains title, createdAt, latestVersion, versions
// projects/{projectId}/v1.html, v2.html, ...
// projects/{projectId}/images/...

function loadMeta(projectId) {
    const metaPath = path.join(PROJECTS_DIR, projectId, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {
        return null;
    }
}

function saveMeta(projectId, meta) {
    const dir = path.join(PROJECTS_DIR, projectId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const metaPath = path.join(dir, 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function listProjects() {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    return fs.readdirSync(PROJECTS_DIR)
        .filter(name => {
            const full = path.join(PROJECTS_DIR, name);
            return fs.statSync(full).isDirectory();
        })
        .map(id => {
            const meta = loadMeta(id);
            if (!meta) return null;
            return {
                id,
                title: meta.title,
                latestVersion: meta.latestVersion,
                versionCount: (meta.versions || []).length,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt
            };
        })
        .filter(Boolean)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getProjectVersion(projectId, version) {
    const filePath = path.join(PROJECTS_DIR, projectId, `v${version}.html`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
}

function saveProjectVersion(projectId, version, content) {
    const filePath = path.join(PROJECTS_DIR, projectId, `v${version}.html`);
    fs.writeFileSync(filePath, content);
}

function imagePath(projectId, imageName) {
    const dir = path.join(PROJECTS_DIR, projectId, 'images');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, imageName);
}

// Helpers for bundling an HTML version + its images into a single zip for
// local download. Images referenced from the HTML are placed under images/<id>
// inside the zip and the HTML's /api/.../images/<id> URLs are rewritten to
// images/<id> so the bundle is self-contained and renders correctly when
// unzipped and opened from a local folder.

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function referencedImageIds(html, projectId) {
    if (!html) return [];
    const re = new RegExp(`/api/projects/${escapeRegExp(projectId)}/images/([^"'<>\\s]+)`, 'g');
    const out = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
        if (!seen.has(m[1])) {
            seen.add(m[1]);
            out.push(m[1]);
        }
    }
    return out;
}

function rewriteImageUrls(html, projectId) {
    if (!html) return html;
    return html.replace(
        new RegExp(`/api/projects/${escapeRegExp(projectId)}/images/([^"'<>\\s]+)`, 'g'),
        (_m, imageId) => `images/${imageId}`
    );
}

// Like rewriteImageUrls but embeds the bytes inline as a data URI. Used
// when we hand the page off to a headless renderer (chromium) so it doesn't
// have to resolve the /api/.../images/<id> URLs at all.
function rewriteImagesToDataUri(html, projectId) {
    if (!html) return html;
    return html.replace(
        new RegExp(`/api/projects/${escapeRegExp(projectId)}/images/([^"'<>\\s]+)`, 'g'),
        (_m, imageId) => {
            const fullPath = imagePath(projectId, imageId);
            if (!fs.existsSync(fullPath)) return `images/${imageId}`;
            const buf = fs.readFileSync(fullPath);
            const ext = path.extname(imageId).slice(1).toLowerCase();
            const mime = ext === 'jpg' ? 'image/jpeg'
                : ext === 'svg' ? 'image/svg+xml'
                : `image/${ext || 'png'}`;
            return `data:${mime};base64,${buf.toString('base64')}`;
        }
    );
}

function collectReferencedImages(html, projectId) {
    const ids = referencedImageIds(html, projectId);
    const dir = path.join(PROJECTS_DIR, projectId, 'images');
    return ids.map(imageId => {
        const fullPath = path.join(dir, imageId);
        let content = Buffer.alloc(0);
        if (fs.existsSync(fullPath)) content = fs.readFileSync(fullPath);
        return { name: `images/${imageId}`, content };
    });
}

// Minimal STORE-only zip writer (no compression). Layout:
//   [Local file header + file data] * N
//   [Central directory header] * N
//   [End of central directory record]
// Works for HTML and image bytes; avoids external deps.
function buildZipBundle(htmlFilename, htmlContent, files) {
    function utf8(s) { return Buffer.from(s, 'utf8'); }

    function crc32(buf) {
        let c, table = [];
        for (let n = 0; n < 256; n++) {
            c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
        let crc = 0xffffffff;
        for (let i = 0; i < buf.length; i++) crc = (table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
        return (crc ^ 0xffffffff) >>> 0;
    }

    function dosTime(d) {
        return ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
    }
    function dosDate(d) {
        return (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    }

    const now = new Date();
    const dTime = dosTime(now);
    const dDate = dosDate(now);

    const all = [{ name: htmlFilename, content: Buffer.from(htmlContent, 'utf8') }].concat(files || []);

    const localChunks = [];
    const centralChunks = [];
    let offset = 0;
    for (const f of all) {
        const nameBuf = utf8(f.name);
        const crc = crc32(f.content);
        const size = f.content.length;

        // Local file header (signature 0x04034b50)
        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(0x04034b50, 0);
        lfh.writeUInt16LE(20, 4);            // version needed
        lfh.writeUInt16LE(0, 6);             // flags
        lfh.writeUInt16LE(0, 8);             // method = stored
        lfh.writeUInt16LE(dTime, 10);
        lfh.writeUInt16LE(dDate, 12);
        lfh.writeUInt32LE(crc, 14);
        lfh.writeUInt32LE(size, 18);         // compressed size
        lfh.writeUInt32LE(size, 22);         // uncompressed size
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(0, 28);            // extra length

        localChunks.push(lfh, nameBuf, f.content);

        // Central directory header (signature 0x02014b50)
        const cdh = Buffer.alloc(46);
        cdh.writeUInt32LE(0x02014b50, 0);
        cdh.writeUInt16LE(20, 4);            // version made by
        cdh.writeUInt16LE(20, 6);            // version needed
        cdh.writeUInt16LE(0, 8);             // flags
        cdh.writeUInt16LE(0, 10);            // method
        cdh.writeUInt16LE(dTime, 12);
        cdh.writeUInt16LE(dDate, 14);
        cdh.writeUInt32LE(crc, 16);
        cdh.writeUInt32LE(size, 20);
        cdh.writeUInt32LE(size, 24);
        cdh.writeUInt16LE(nameBuf.length, 28);
        cdh.writeUInt16LE(0, 30);            // extra
        cdh.writeUInt16LE(0, 32);            // comment
        cdh.writeUInt16LE(0, 34);            // disk
        cdh.writeUInt16LE(0, 36);            // internal attrs
        cdh.writeUInt32LE(0, 38);            // external attrs
        cdh.writeUInt32LE(offset, 42);       // local header offset
        centralChunks.push(cdh, nameBuf);

        offset += lfh.length + nameBuf.length + f.content.length;
    }

    const localBuf = Buffer.concat(localChunks);
    const centralBuf = Buffer.concat(centralChunks);

    // End of central directory (signature 0x06054b50)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);               // disk
    eocd.writeUInt16LE(0, 6);               // disk with start of cd
    eocd.writeUInt16LE(all.length, 8);      // entries on this disk
    eocd.writeUInt16LE(all.length, 10);     // total entries
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(localBuf.length, 16);
    eocd.writeUInt16LE(0, 20);              // comment length

    return Buffer.concat([localBuf, centralBuf, eocd]);
}

// Extract sections from rendered template HTML. Each section is
// { text, imageBytes, imageExt }. imageBytes is null if the image
// can't be loaded.
function parseTemplateSections(html, projectId) {
    const sections = [];
    const re = /<section class="post-item"[^>]*>([\s\S]*?)<\/section>/g;
    let m;
    while ((m = re.exec(html))) {
        const body = m[1];
        const tm = body.match(/<div class="post-text"[^>]*>([\s\S]*?)<\/div>/);
        const im = body.match(/<img class="post-img" src="([^"]+)"[^>]*>/);
        const text = tm ? tm[1].replace(/<[^>]+>/g, '').trim() : '';
        let imageBytes = null, imageExt = null;
        if (im) {
            const src = im[1];
            if (src.startsWith('data:')) {
                const mm = src.match(/^data:image\/(\w+);base64,(.*)$/);
                if (mm) {
                    imageBytes = Buffer.from(mm[2], 'base64');
                    imageExt = mm[1] === 'jpeg' ? 'jpg' : mm[1].toLowerCase();
                }
            } else if (src.startsWith('/api/projects/')) {
                const fname = src.split('/').pop();
                const full = imagePath(projectId, fname);
                if (fs.existsSync(full)) {
                    imageBytes = fs.readFileSync(full);
                    imageExt = path.extname(fname).slice(1).toLowerCase();
                    if (imageExt === 'jpeg') imageExt = 'jpg';
                }
            }
        }
        if (text || imageBytes) sections.push({ text, imageBytes, imageExt });
    }
    return sections;
}

function extractTitle(html) {
    const m = html.match(/<h1[^>]*class="article-title"[^>]*>([\s\S]*?)<\/h1>/);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : '未命名';
}

// Wrap CJK text into lines that fit within `width` using pdfkit's current
// font. pdfkit's built-in word-wrap only breaks on spaces; CJK strings have
// no spaces, so we manually break per-character against the actual
// measured width of the accumulated line.
//
// Bug fix (2025-Q3): the previous greedy per-character wrap left single
// Chinese characters on their own line ("图像检测\n工\n作台..." looks like
// an "abnormal" line break). Two refinements:
//   1. Prefer to break just AFTER Chinese/ASCII punctuation when the
//      punctuation sits in the last 30% of a fit-able run — this keeps
//      compound words like "工作台" intact.
//   2. When only 1-2 characters would remain on the tail line, pull them
//      back into the current line. The current line may exceed `width`
//      by up to two char widths, which is aesthetically much better
//      than a single-char tail.
//
// The caller MUST then render with `doc.text(lines.join('\n'),
// { lineBreak: false })` (no `width` option). If `width` is set, pdfkit
// re-runs its own LineWrapper on the pre-wrapped string and undoes the
// careful break points.
function wrapCjkText(doc, text, width) {
    const lines = [];
    const paragraphs = text.split(/\n/);
    const isBreakOp = (c) => /[，。；！？、：]/.test(c); // break AFTER these
    const minTail = 2; // try to keep at least this many chars on the next line
    for (const para of paragraphs) {
        if (!para) { lines.push(''); continue; }
        const chars = Array.from(para);
        const widths = chars.map(c => doc.widthOfString(c));
        let i = 0;
        while (i < chars.length) {
            // Greedy: find longest prefix that fits within width.
            let maxEnd = i + 1;
            let w = widths[i];
            while (maxEnd < chars.length && (w + widths[maxEnd]) <= width) {
                w += widths[maxEnd];
                maxEnd++;
            }
            // Try to find a punctuation break in the last 30% of [i..maxEnd].
            let end = maxEnd;
            const span = maxEnd - i;
            const lookback = Math.max(2, Math.floor(span * 0.3));
            for (let j = maxEnd - 1; j > i && j >= maxEnd - lookback; j--) {
                if (isBreakOp(chars[j - 1])) { // break AFTER punctuation at j-1
                    end = j;
                    break;
                }
            }
            // If the punctuation-aware end leaves too few chars for the next
            // line, fall back to the greedy break to avoid orphan tails.
            if (chars.length - end < minTail) end = maxEnd;
            lines.push(chars.slice(i, end).join(''));
            i = end;
        }
    }
    return lines;
}

// Render the rendered-template HTML to a PDF file on disk using
// pdfkit. Pure-JS, no external browser binary needed.
//
// Per-section layout rule (locked-in by user request):
//   - Each section's text AND image must live on the SAME page. Never
//     split a section's text+image across two pages — if the text is
//     long, the image shrinks to fit; if it still doesn't fit, the
//     text wraps but the image always stays with its section.
//   - Each section (after section 0) starts on a fresh A4 page.
//   - Section 0 lives on page 1 along with the title.
//   - Final page is a small "— END —" footer.
//
// To guarantee "text+image same page" we:
//   1. Open a new page for every section.
//   2. Layout = text-on-top, image-on-bottom. Compute remaining
//      vertical space after writing the text, then `fit:[w, h]` the
//      image into that exact rectangle. The image is always anchored
//      to the page so pdfkit cannot auto-break it to a new page.
//   3. If the text would itself overflow the page, shrink the image
//      box to its minimum and let pdfkit break the text. The image
//      box is reserved by drawing a thin grey placeholder first; this
//      physically occupies the bottom of the page so the cursor never
//      advances past it.
function renderHtmlToPdf(htmlPath, pdfPath) {
    return new Promise((resolve, reject) => {
        let html;
        try { html = fs.readFileSync(htmlPath, 'utf8'); }
        catch (e) { reject(new Error('cannot read html: ' + e.message)); return; }
        const projectId = path.basename(path.dirname(htmlPath));
        const title = extractTitle(html);
        const sections = parseTemplateSections(html, projectId);

        const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: true, info: { Title: title } });
        const stream = fs.createWriteStream(pdfPath);
        stream.on('error', e => reject(new Error('cannot write pdf: ' + e.message)));
        stream.on('finish', () => resolve());
        doc.pipe(stream);

        const FONT_REG = 'fonts/NotoSansCJKsc-Regular.otf';
        const FONT_BOLD = 'fonts/NotoSansCJKsc-Bold.otf';
        const fontRegPath = path.join(__dirname, FONT_REG);
        const fontBoldPath = path.join(__dirname, FONT_BOLD);
        const hasFont = fs.existsSync(fontRegPath);
        if (hasFont) {
            doc.registerFont('cjk', fontRegPath);
            if (fs.existsSync(fontBoldPath)) doc.registerFont('cjkBold', fontBoldPath);
            doc.font('cjk');
        }

        const margin = doc.page.margins.top; // symmetric A4 margins assumed
        const pageContentWidth = doc.page.width - margin - margin;
        const pageContentHeight = doc.page.height - margin - margin;
        const MIN_IMG_BOX = 80; // never let the image box shrink below this
        const TEXT_GAP = 12;    // vertical gap between text and image box
        const useFont = (size) => {
            if (hasFont) doc.font('cjk'); else doc.font('Helvetica');
            doc.fontSize(size);
            doc.fillColor('black');
        };

        // Page 1 = title + section 0 (text + image together).
        if (sections.length > 0) {
            useFont(20);
            doc.text(title, { align: 'center', width: pageContentWidth });
            doc.moveDown(0.6);
        } else {
            useFont(20);
            doc.text(title, { align: 'center', width: pageContentWidth });
        }

        // For every section: open a fresh page, lay out text then image.
        for (let i = 0; i < sections.length; i++) {
            const sec = sections[i];
            const isFirst = (i === 0);

            // Section 0 shares page 1 with the title (already started).
            if (!isFirst) {
                doc.addPage();
            }

            // Choose text size: smaller for section 0 (shares with title)
            // so the image still fits on the same page; full size for
            // subsequent sections which own the whole page.
            const textSize = isFirst ? 12 : 13;
            const titleReserved = isFirst
                ? (doc.y - margin)   // space already eaten by title block
                : 0;
            const availableForText = pageContentHeight - titleReserved - (sec.imageBytes ? MIN_IMG_BOX + TEXT_GAP : 0);

            // ---- TEXT ----
            let textHeight = 0;
            if (sec.text) {
                useFont(textSize);
                // Measure first so we can pick a smaller font if the text
                // would overflow the available region.
                let chosenSize = textSize;
                let lines;
                while (true) {
                    useFont(chosenSize);
                    const lineGap = chosenSize * 0.4;
                    lines = wrapCjkText(doc, sec.text, pageContentWidth);
                    // pdfkit uses lineHeight = fontSize + lineGap for layout
                    const h = lines.length * (chosenSize + lineGap);
                    if (h <= availableForText || chosenSize <= 9) {
                        textHeight = h;
                        break;
                    }
                    chosenSize -= 1;
                }
                useFont(chosenSize);
                // CRITICAL: pdfkit's doc.text() with `width:` re-runs its own
                // LineWrapper on the input, undoing our punctuation-aware
                // breaks and producing single-char orphan lines like
                // "图像检测\n工\n作台". The reliable fix is to render each
                // pre-wrapped line as a SEPARATE doc.text() call WITHOUT
                // width/lineBreak options. That routes through pdfkit's
                // normal per-call _line() which advances Y properly, while
                // not invoking LineWrapper (no embedded \n in the string).
                for (let li = 0; li < lines.length; li++) {
                    doc.text(lines[li]);
                    if (li < lines.length - 1) {
                        // inter-line gap = lineGap pts (≈ 0.4 * fontSize).
                        doc.moveDown((chosenSize * 0.4) / chosenSize);
                    }
                }
            }

            // ---- IMAGE ----
            if (sec.imageBytes) {
                // Recompute remaining space based on actual cursor position
                // (textHeight is an estimate; cursor position is authoritative).
                const top = doc.y + TEXT_GAP;
                const maxBottom = margin + pageContentHeight;
                let imgBoxHeight = Math.max(maxBottom - top, 0);
                if (imgBoxHeight < MIN_IMG_BOX) {
                    // Text already used the whole page. Reserve a minimum
                    // box anyway so the image still renders on this page
                    // (we can't break to a new page).
                    imgBoxHeight = MIN_IMG_BOX;
                }
                try {
                    doc.image(sec.imageBytes, margin, top, {
                        fit: [pageContentWidth, imgBoxHeight],
                        align: 'center', valign: 'top'
                    });
                } catch (e) {
                    useFont(9);
                    doc.fillColor('red').text('[图片加载失败: ' + e.message + ']');
                    doc.fillColor('black');
                }
            }
        }

        // Final "— END —" page
        doc.addPage();
        useFont(11);
        doc.fillColor('gray');
        doc.text('— END —', { align: 'center' });
        doc.fillColor('black');

        doc.end();
    });
}

// ---------------------------------------------------------------------------
// DOCX export (Word document)
//
// Mirrors the PDF layout intent: title + section 0 on page 1, every following
// section starts on a fresh page, and each section keeps its text directly
// above its image. Built with the `docx` package (pure JS, no browser).
//
// CJK: Word does not embed fonts — it only records a font *name* — so we set
// an East-Asian-safe font family (Microsoft YaHei, present on Windows/WPS and
// substituted elsewhere) on the document defaults and on every run.
// ---------------------------------------------------------------------------

const DOCX_FONT = {
    ascii: 'Microsoft YaHei',
    eastAsia: 'Microsoft YaHei',
    hAnsi: 'Microsoft YaHei',
    cs: 'Microsoft YaHei'
};
const DOCX_MAX_IMG_W = 600; // px (~6.25in @96dpi), fits A4 with 1in margins
const DOCX_MAX_IMG_H = 640; // px, keeps a section's text+image on one page

// docx only accepts these raster types (no webp).
function docxImageType(ext) {
    const e = (ext || '').toLowerCase();
    if (e === 'png') return 'png';
    if (e === 'jpg' || e === 'jpeg') return 'jpg';
    if (e === 'gif') return 'gif';
    if (e === 'bmp') return 'bmp';
    return null;
}

// Intrinsic pixel size of a PNG or JPEG buffer, or null if unknown.
function imageDimensions(buf) {
    try {
        if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) { // PNG IHDR
            return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        }
        if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) { // JPEG
            let o = 2;
            while (o + 9 < buf.length) {
                if (buf[o] !== 0xff) { o++; continue; }
                const marker = buf[o + 1];
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                    o += 2;
                    continue;
                }
                const len = buf.readUInt16BE(o + 2);
                // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC) carry the size
                if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
                }
                o += 2 + len;
            }
        }
    } catch (e) {}
    return null;
}

// Scale (w,h) to fit inside maxW x maxH, preserving aspect ratio.
function fitImageBox(w, h, maxW, maxH) {
    if (!w || !h) return { width: maxW, height: Math.round(maxW * 0.66) };
    const r = Math.min(maxW / w, maxH / h);
    return { width: Math.max(1, Math.round(w * r)), height: Math.max(1, Math.round(h * r)) };
}

// Build a .docx buffer for one version's HTML.
async function buildDocxBuffer(html, projectId) {
    const title = extractTitle(html);
    const sections = parseTemplateSections(html, projectId);

    const children = [
        new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 280 },
            children: [new TextRun({ text: title, bold: true, size: 44, font: DOCX_FONT })]
        })
    ];

    sections.forEach((sec, i) => {
        // Every section after the first starts a new page (matches PDF layout).
        let breakNext = i > 0;

        const blocks = [];
        if (sec.text) {
            for (const para of sec.text.split(/\n+/)) {
                const t = para.trim();
                if (t) blocks.push({ kind: 'text', text: t });
            }
        }
        if (sec.imageBytes) blocks.push({ kind: 'image' });

        for (const b of blocks) {
            const opts = { children: [] };
            if (breakNext) { opts.pageBreakBefore = true; breakNext = false; }

            if (b.kind === 'text') {
                opts.spacing = { after: 180 };
                opts.children = [new TextRun({ text: b.text, size: 24, font: DOCX_FONT })];
            } else {
                const type = docxImageType(sec.imageExt);
                if (!type) {
                    opts.children = [new TextRun({
                        text: `[不支持的图片格式: ${sec.imageExt || '未知'}]`,
                        size: 18, color: '999999', font: DOCX_FONT
                    })];
                } else {
                    const dim = imageDimensions(sec.imageBytes);
                    const box = fitImageBox(dim && dim.width, dim && dim.height, DOCX_MAX_IMG_W, DOCX_MAX_IMG_H);
                    opts.alignment = AlignmentType.CENTER;
                    opts.spacing = { before: 120 };
                    opts.children = [new ImageRun({ type, data: sec.imageBytes, transformation: box })];
                }
            }
            children.push(new Paragraph(opts));
        }
    });

    const doc = new Document({
        creator: 'PictureText',
        title,
        styles: { default: { document: { run: { font: DOCX_FONT } } } },
        sections: [{
            properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
            children
        }]
    });
    return await Packer.toBuffer(doc);
}

// HTML page renderer
function renderAppShell(tab = 'wizard') {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>图文 HTML 生成器</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<div class="app">
    <header class="topbar">
        <div class="brand">图文 HTML 生成器</div>
        <nav class="tabs">
            <button data-tab="wizard" class="tab-btn ${tab === 'wizard' ? 'active' : ''}">向导</button>
            <button data-tab="library" class="tab-btn ${tab === 'library' ? 'active' : ''}">库</button>
        </nav>
    </header>
    <main id="main">
        <!-- view rendered by JS -->
    </main>
</div>
<script src="/static/app.js"></script>
</body>
</html>`;
}

function renderViewerPage(projectId, version, latestVersion) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>HTML v${version} - ${projectId}</title>
<link rel="stylesheet" href="/static/viewer.css">
</head>
<body class="viewer-body">
<div class="viewer-layout">
    <aside class="sidebar">
        <div class="sidebar-header">
            <h3>修改意见</h3>
            <a href="/library" class="back-link">返回库</a>
        </div>
        <div class="sidebar-info">
            <div>项目: <strong>${escapeHtml(projectId)}</strong></div>
            <div>版本: <strong>v${version}</strong> ${version === latestVersion ? '<span class="badge">最新</span>' : ''}</div>
            ${version !== latestVersion ? `<div class="warn-box" style="margin-top:8px;padding:6px 8px;background:#fff3cd;border:1px solid #ffeeba;border-radius:4px;font-size:12px;color:#856404;">基于旧版本提交修改将丢弃 v${version} 之后的所有版本（reset --hard）</div>` : ''}
        </div>
        <textarea id="feedback-input" placeholder="输入修改意见... 例如：把标题改成红色，图片之间添加更多间距"></textarea>
        <button id="submit-feedback" class="primary-btn">生成下一版本</button>
        <div id="status-box" class="status-box"></div>
        <div class="sidebar-actions">
            <a href="/api/projects/${projectId}/v${version}/download" class="action-btn" download>下载 HTML</a>
            <button id="copy-html-btn" class="action-btn">复制源码</button>
        </div>
        <div class="version-list">
            <h4>历史版本</h4>
            <ul id="version-list"></ul>
        </div>
    </aside>
    <main class="preview-area">
        <iframe id="html-frame" sandbox="allow-same-origin"></iframe>
    </main>
</div>
<script>
window.PROJECT_ID = ${JSON.stringify(projectId)};
window.VERSION = ${version};
window.LATEST = ${latestVersion};
</script>
<script src="/static/viewer.js"></script>
</body>
</html>`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const server = http.createServer(async (req, res) => {
    res.setTimeout(TIMEOUT_MS);

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    try {
        // Static files
        if (req.method === 'GET' && pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderAppShell('wizard'));
            return;
        }
        if (req.method === 'GET' && pathname === '/library') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderAppShell('library'));
            return;
        }
        if (req.method === 'GET' && pathname.startsWith('/static/')) {
            const filePath = path.join(WORKSPACE_DIR, pathname);
            if (!fs.existsSync(filePath)) {
                res.writeHead(404); res.end('Not found'); return;
            }
            const ext = path.extname(filePath);
            const contentType = {
                '.js': 'application/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.html': 'text/html; charset=utf-8',
                '.svg': 'image/svg+xml',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.json': 'application/json'
            }[ext] || 'application/octet-stream';
            const content = fs.readFileSync(filePath);
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
            return;
        }

        // API: list projects (for library tab)
        if (req.method === 'GET' && pathname === '/api/projects') {
            sendJson(res, 200, { projects: listProjects() });
            return;
        }

        // API: get project meta
        if (req.method === 'GET' && pathname.match(/^\/api\/projects\/[^/]+$/)) {
            const projectId = pathname.split('/')[3];
            const meta = loadMeta(projectId);
            if (!meta) { sendJson(res, 404, { error: 'Not found' }); return; }
            sendJson(res, 200, { id: projectId, ...meta });
            return;
        }

        // API: create project (initial)
        if (req.method === 'POST' && pathname === '/api/projects') {
            const body = await getJsonBody(req);
            const projectId = crypto.randomBytes(6).toString('hex');
            const title = (body.title || '未命名').toString();
            const now = Date.now();
            const meta = {
                title,
                createdAt: now,
                updatedAt: now,
                latestVersion: 0,
                versions: [],
                // Wizard state (draft) - so user can resume
                draft: { title, items: [] }
            };
            saveMeta(projectId, meta);
            sendJson(res, 200, { projectId, meta });
            return;
        }

        // API: save wizard draft (autosave)
        if (req.method === 'PUT' && pathname.match(/^\/api\/projects\/[^/]+\/draft$/)) {
            const projectId = pathname.split('/')[3];
            const meta = loadMeta(projectId);
            if (!meta) { sendJson(res, 404, { error: 'Not found' }); return; }
            const body = await getJsonBody(req);
            meta.draft = body.draft;
            meta.updatedAt = Date.now();
            meta.title = (body.draft && body.draft.title) || meta.title;
            // Hoist layoutDirection to the top level so the choice survives
            // even after the draft is cleared on the next finalize.
            if (body.draft && (body.draft.layoutDirection === 'text-first' || body.draft.layoutDirection === 'image-first')) {
                meta.layoutDirection = body.draft.layoutDirection;
            }
            saveMeta(projectId, meta);
            sendJson(res, 200, { ok: true });
            return;
        }

        // API: finalize wizard → generate v1 HTML using template (no AI on v1)
        if (req.method === 'POST' && pathname.match(/^\/api\/projects\/[^/]+\/finalize$/)) {
            const projectId = pathname.split('/')[3];
            const meta = loadMeta(projectId);
            if (!meta) { sendJson(res, 404, { error: 'Not found' }); return; }
            const body = await getJsonBody(req);
            if (!body.draft) { sendJson(res, 400, { error: 'missing draft' }); return; }

            const title = body.draft.title || meta.title;
            const items = (body.draft.items || []).map(it => ({
                ...it,
                src: it.imageId ? `/api/projects/${projectId}/images/${it.imageId}` : null
            }));
            // Layout direction: prefer the explicit draft value, then the persisted
            // meta field. The user-facing spec is "text-first by default".
            // Existing v1/v2/v3 HTML files are not rewritten — they keep the
            // order they were generated with — but any *new* version from a
            // resumed project follows the project-level setting or the
            // text-first default if neither has been recorded.
            const draftDir = body.draft.layoutDirection;
            const storedDir = meta.layoutDirection || (meta.draft && meta.draft.layoutDirection);
            const direction = (draftDir || storedDir) === 'image-first' ? 'image-first' : 'text-first';
            meta.layoutDirection = direction;

            // v1 always uses template — fast, reliable, no AI needed.
            // AI is reserved for v2+ (user feedback in viewer).
            const html = renderTemplateHtml(title, items, direction);

            const finalHtml = ensureHtml(html, title);
            const newVersion = (meta.latestVersion || 0) + 1;
            meta.draft = null;
            meta.latestVersion = newVersion;
            meta.versions = (meta.versions || []).concat([{
                version: newVersion,
                createdAt: Date.now(),
                feedback: '模板初始生成',
                parentVersion: null
            }]);
            meta.updatedAt = Date.now();
            saveMeta(projectId, meta);
            saveProjectVersion(projectId, newVersion, finalHtml);
            sendJson(res, 200, { projectId, version: newVersion, html: finalHtml, usedAi: false });
            return;
        }

        // API: image upload (single)
        if (req.method === 'POST' && pathname.match(/^\/api\/projects\/[^/]+\/images$/)) {
            const projectId = pathname.split('/')[3];
            const meta = loadMeta(projectId);
            if (!meta) { sendJson(res, 404, { error: 'Not found' }); return; }
            const body = await getJsonBody(req);
            // Expect { dataUrl: "data:image/png;base64,..." }
            if (!body.dataUrl || typeof body.dataUrl !== 'string') {
                sendJson(res, 400, { error: 'missing dataUrl' }); return;
            }
            const m = body.dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
            if (!m) { sendJson(res, 400, { error: 'invalid dataUrl' }); return; }
            const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
            const buffer = Buffer.from(m[2], 'base64');
            const imageId = crypto.randomBytes(8).toString('hex') + '.' + ext;
            const fullPath = imagePath(projectId, imageId);
            fs.writeFileSync(fullPath, buffer);
            sendJson(res, 200, { imageId, url: `/api/projects/${projectId}/images/${imageId}` });
            return;
        }

        // API: serve project image
        if (req.method === 'GET' && pathname.match(/^\/api\/projects\/[^/]+\/images\/[^/]+$/)) {
            const parts = pathname.split('/');
            const projectId = parts[3];
            const imageId = parts[5];
            const fullPath = imagePath(projectId, imageId);
            if (!fs.existsSync(fullPath)) { res.writeHead(404); res.end('not found'); return; }
            const ext = path.extname(fullPath).slice(1);
            const contentType = ext === 'jpg' ? 'image/jpeg' : 'image/' + ext;
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(fs.readFileSync(fullPath));
            return;
        }

        // API: download html (zip bundle: html + images/)
        if (req.method === 'GET' && pathname.match(/^\/api\/projects\/[^/]+\/v\d+\/download$/)) {
            const m = pathname.match(/^\/api\/projects\/([^/]+)\/v(\d+)\/download$/);
            const projectId = m[1];
            const version = parseInt(m[2], 10);
            const meta = loadMeta(projectId);
            if (!meta) { res.writeHead(404); res.end('not found'); return; }
            const html = getProjectVersion(projectId, version);
            if (!html) { res.writeHead(404); res.end('version not found'); return; }
            // Package as zip: <title>_v<n>.html + images/<id>.<ext> for each image
            // referenced in the HTML. The HTML's /api/.../images/<id> URLs are
            // rewritten to images/<id> so they resolve naturally when opened locally.
            try {
                const safeTitle = (meta.title || 'page').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
                const htmlFilename = `${safeTitle}_v${version}.html`;
                const images = collectReferencedImages(html, projectId);
                const zip = buildZipBundle(htmlFilename, rewriteImageUrls(html, projectId), images);
                const filename = `${safeTitle}_v${version}.zip`;
                res.writeHead(200, {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
                });
                res.end(zip);
            } catch (e) {
                log(`zip build failed for ${projectId} v${version}: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('zip build failed: ' + e.message);
            }
            return;
        }

        // API: export v<n> as PDF (images inlined as data URIs, then
        // rendered through headless chromium).
        if (req.method === 'GET' && pathname.match(/^\/api\/projects\/[^/]+\/v\d+\/pdf$/)) {
            const m = pathname.match(/^\/api\/projects\/([^/]+)\/v(\d+)\/pdf$/);
            const projectId = m[1];
            const version = parseInt(m[2], 10);
            const meta = loadMeta(projectId);
            if (!meta) { res.writeHead(404); res.end('not found'); return; }
            const html = getProjectVersion(projectId, version);
            if (!html) { res.writeHead(404); res.end('version not found'); return; }
            try {
                const safeTitle = (meta.title || 'page').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
                const inlinedHtml = rewriteImagesToDataUri(html, projectId);
                const cacheDir = path.join(DATA_DIR, 'cache');
                if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
                const tmpName = `pdf-${projectId}-v${version}-${crypto.randomBytes(4).toString('hex')}.html`;
                const tmpHtmlPath = path.join(cacheDir, tmpName);
                const tmpPdfName = tmpName.replace(/\.html$/, '.pdf');
                const tmpPdfPath = path.join(cacheDir, tmpPdfName);
                fs.writeFileSync(tmpHtmlPath, inlinedHtml, 'utf8');
                try {
                    await renderHtmlToPdf(tmpHtmlPath, tmpPdfPath);
                    const pdf = fs.readFileSync(tmpPdfPath);
                    const filename = `${safeTitle}_v${version}.pdf`;
                    res.writeHead(200, {
                        'Content-Type': 'application/pdf',
                        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
                        'Content-Length': pdf.length
                    });
                    res.end(pdf);
                } finally {
                    try { fs.unlinkSync(tmpHtmlPath); } catch (_) {}
                    try { fs.unlinkSync(tmpPdfPath); } catch (_) {}
                }
            } catch (e) {
                log(`pdf build failed for ${projectId} v${version}: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'pdf build failed', detail: e.message }));
            }
            return;
        }

        // API: export v<n> as DOCX (Word document, CJK-friendly, pure JS).
        if (req.method === 'GET' && pathname.match(/^\/api\/projects\/[^/]+\/v\d+\/docx$/)) {
            const m = pathname.match(/^\/api\/projects\/([^/]+)\/v(\d+)\/docx$/);
            const projectId = m[1];
            const version = parseInt(m[2], 10);
            const meta = loadMeta(projectId);
            if (!meta) { res.writeHead(404); res.end('not found'); return; }
            const html = getProjectVersion(projectId, version);
            if (!html) { res.writeHead(404); res.end('version not found'); return; }
            try {
                const safeTitle = (meta.title || 'page').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
                const inlinedHtml = rewriteImagesToDataUri(html, projectId);
                const docx = await buildDocxBuffer(inlinedHtml, projectId);
                const filename = `${safeTitle}_v${version}.docx`;
                res.writeHead(200, {
                    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
                    'Content-Length': docx.length
                });
                res.end(docx);
            } catch (e) {
                log(`docx build failed for ${projectId} v${version}: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'docx build failed', detail: e.message }));
            }
            return;
        }

        // API: get specific version html (raw)
        if (req.method === 'GET' && pathname.match(/^\/api\/projects\/[^/]+\/v\d+$/)) {
            const m = pathname.match(/^\/api\/projects\/([^/]+)\/v(\d+)$/);
            const projectId = m[1];
            const version = parseInt(m[2], 10);
            const meta = loadMeta(projectId);
            if (!meta) { sendJson(res, 404, { error: 'not found' }); return; }
            const html = getProjectVersion(projectId, version);
            if (!html) { sendJson(res, 404, { error: 'version not found' }); return; }
            sendJson(res, 200, { version, latestVersion: meta.latestVersion, html });
            return;
        }

        // API: submit feedback → next version via claude
        if (req.method === 'POST' && pathname.match(/^\/api\/projects\/[^/]+\/feedback$/)) {
            const m = pathname.match(/^\/api\/projects\/([^/]+)\/feedback$/);
            const projectId = m[1];
            const meta = loadMeta(projectId);
            if (!meta) { sendJson(res, 404, { error: 'not found' }); return; }
            const body = await getJsonBody(req);
            const baseVersion = parseInt(body.baseVersion || meta.latestVersion, 10);
            const feedback = (body.feedback || '').toString();
            if (!feedback.trim()) { sendJson(res, 400, { error: 'feedback required' }); return; }
            const baseHtml = getProjectVersion(projectId, baseVersion);
            if (!baseHtml) { sendJson(res, 400, { error: 'base version not found' }); return; }

            // If based on a non-latest version → reset --hard: drop versions > baseVersion
            if (baseVersion < meta.latestVersion) {
                // Delete versions > baseVersion
                for (let v = baseVersion + 1; v <= meta.latestVersion; v++) {
                    const p = path.join(PROJECTS_DIR, projectId, `v${v}.html`);
                    if (fs.existsSync(p)) fs.unlinkSync(p);
                }
            }

            const prompt = buildRevisionPrompt(meta.title, baseVersion, baseHtml, feedback);
            log(`Feedback project ${projectId} from v${baseVersion} - calling claude`);
            let newHtml = null;
            let usedAi = false;
            if (process.env.MOCK_CLAUDE !== '1') {
                try {
                    newHtml = await callClaudeForHtml(prompt);
                    usedAi = true;
                } catch (e) {
                    log(`Claude call failed: ${e.message}; falling back to template`);
                    newHtml = null;
                }
            }
            if (!newHtml) {
                // Template fallback: append a banner noting the requested feedback
                newHtml = applyTemplateFeedback(baseHtml, feedback);
            }
            const ensured = ensureHtml(newHtml, meta.title);

            const newVersion = baseVersion + 1;
            meta.latestVersion = newVersion;
            meta.versions = (meta.versions || []).filter(v => v.version <= baseVersion);
            meta.versions.push({
                version: newVersion,
                createdAt: Date.now(),
                feedback: (usedAi ? '' : '[模板] ') + feedback.slice(0, 100),
                parentVersion: baseVersion
            });
            meta.updatedAt = Date.now();
            saveMeta(projectId, meta);
            saveProjectVersion(projectId, newVersion, ensured);
            sendJson(res, 200, {
                projectId,
                baseVersion,
                newVersion,
                html: ensured,
                reset: baseVersion < meta.latestVersion - 0  // always reset if we just dropped
            });
            return;
        }

        // Viewer page: /p/{projectId} or /p/{projectId}/v{n}
        if (req.method === 'GET' && pathname.startsWith('/p/')) {
            const m = pathname.match(/^\/p\/([^/]+)(?:\/v(\d+))?$/);
            if (m) {
                const projectId = m[1];
                const version = m[2] ? parseInt(m[2], 10) : null;
                const meta = loadMeta(projectId);
                if (!meta) { res.writeHead(404); res.end('project not found'); return; }
                if (meta.latestVersion === 0) {
                    // No HTML generated yet - show wizard redirect
                    res.writeHead(302, { Location: '/' });
                    res.end();
                    return;
                }
                const target = version || meta.latestVersion;
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(renderViewerPage(projectId, target, meta.latestVersion));
                return;
            }
        }

        // Health
        if (req.method === 'GET' && pathname === '/health') {
            sendText(res, 200, 'OK');
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    } catch (e) {
        log(`Error: ${e.stack || e.message}`);
        try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch(_) {}
    }
});

function ensureHtml(content, fallbackTitle) {
    if (!content) return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(fallbackTitle || '')}</title></head><body></body></html>`;
    const trimmed = content.trim();
    if (/^<!DOCTYPE|^<html/i.test(trimmed)) {
        return trimmed;
    }
    // wrap
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(fallbackTitle || '')}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #222; line-height: 1.7; }
  .post-item { margin: 40px 0; }
  .post-item img { max-width: 100%; height: auto; display: block; border-radius: 8px; }
  .post-text { font-size: 16px; margin-top: 12px; white-space: pre-wrap; }
  h1 { text-align: center; font-size: 28px; }
</style>
</head>
<body>
<h1>${escapeHtml(fallbackTitle || '')}</h1>
${trimmed}
</body>
</html>`;
}

function buildV1Prompt(title, items) {
    const itemDescriptions = items.map((it, i) => {
        const imgs = (it.src ? `[图片${i+1}](${it.src})` : '(无图片)');
        return `${i+1}. ${imgs} — 文字: ${it.text || '(无)'}`;
    }).join('\n');

    return `你是HTML图文排版专家。请根据以下信息生成一个完整的、独立的HTML文档（包含 <!DOCTYPE>）。

标题：${title}

内容（按顺序）：
${itemDescriptions}

要求：
1. 完整的HTML5文档，自带 viewport、UTF-8 编码
2. 移动端友好的响应式布局
3. 美观的排版（参考公众号/小红书图文风格），使用内嵌CSS
4. 每张图片独占一段，下方紧跟对应的文字
5. 顶部有标题，底部可选作者/品牌
6. 风格现代化，配色和谐，留白舒服
7. 只输出HTML源码，不要任何解释、注释或 Markdown 代码块包裹`;
}

function buildRevisionPrompt(title, baseVersion, baseHtml, feedback) {
    return `你是HTML编辑助手。基于以下HTML（版本 v${baseVersion}）进行修改。

标题：${title}

修改意见：
${feedback}

现有 HTML 源码：
\`\`\`html
${baseHtml}
\`\`\`

要求：
1. 输出修改后的完整HTML（重新输出整个文档），保持原结构
2. 应用反馈中提到的修改
3. 保持响应式、美观
4. 只输出HTML源码，不要任何解释或 Markdown 代码块包裹`;
}

// ---------- Template-based HTML generator (offline fallback) ----------
// Default layout is "text-first" (文字在上图片在下). Pass `direction:
// 'image-first'` to render the legacy order. New projects opt into the
// default; pre-existing projects with no layoutDirection in meta.json keep
// their original image-first order so we don't re-shuffle v1/v2/v3 pages.
function renderTemplateHtml(title, items, direction = 'text-first') {
    const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    const dir = direction === 'image-first' ? 'image-first' : 'text-first';

    // Each item becomes ONE section (post-item) containing both text and
    // image in the chosen order. Per-page splitting is the renderer's job
    // (see parseTemplatePages), so the HTML stays a single scrollable
    // document but each section carries data-section-index so the PDF
    // builder can split text-vs-image onto separate A4 pages.
    const itemsHtml = items.map((it, i) => {
        const img = it.src ? `<img class="post-img" src="${escapeHtml(it.src)}" alt="">` : '';
        const text = it.text ? `<div class="post-text">${escapeHtml(it.text)}</div>` : '';
        if (!img && !text) return '';
        const ordered = dir === 'image-first' ? `${img}\n            ${text}` : `${text}\n            ${img}`;
        return `<section class="post-item" data-layout="${dir}" data-section-index="${i}">
            ${ordered}
        </section>`;
    }).filter(Boolean).join('\n');

    // Per-direction spacing: image-first keeps margin-top on .post-text;
    // text-first mirrors it to margin-bottom so the image hugs the text.
    const textSpacing = dir === 'image-first'
        ? 'margin-top: 16px;'
        : 'margin-bottom: 16px;';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
    margin: 0;
    background: #fafafa;
    color: #1f2937;
    line-height: 1.75;
    font-size: 16px;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    max-width: 680px;
    margin: 0 auto;
    padding: 40px 20px 60px;
    background: #ffffff;
    min-height: 100vh;
    box-shadow: 0 0 20px rgba(0,0,0,0.04);
  }
  h1.article-title {
    font-size: 26px;
    font-weight: 700;
    text-align: center;
    margin: 0 0 12px 0;
    color: #111827;
    letter-spacing: 0.5px;
  }
  .post-item {
    margin: 32px 0;
    padding-bottom: 16px;
    border-bottom: 1px dashed #e5e7eb;
  }
  .post-item:last-of-type {
    border-bottom: none;
  }
  .post-img {
    width: 100%;
    height: auto;
    display: block;
    border-radius: 8px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.06);
  }
  .post-text {
    ${textSpacing}
    font-size: 16px;
    color: #374151;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .article-footer {
    margin-top: 60px;
    padding-top: 24px;
    border-top: 1px solid #e5e7eb;
    text-align: center;
    color: #9ca3af;
    font-size: 13px;
  }
  @media (max-width: 480px) {
    .page { padding: 24px 16px 40px; }
    h1.article-title { font-size: 22px; }
    .post-item { margin: 24px 0; }
  }
</style>
</head>
<body>
<article class="page">
    <h1 class="article-title">${escapeHtml(title)}</h1>
    ${itemsHtml}
    <footer class="article-footer">— END —</footer>
</article>
</body>
</html>`;
}

// apply feedback as a visible note (offline fallback when claude fails)
function applyTemplateFeedback(baseHtml, feedback) {
    const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    const note = `<div style="margin:24px 0;padding:14px 18px;background:#fffbeb;border:1px solid #fcd34d;border-left:4px solid #f59e0b;border-radius:6px;color:#92400e;font-size:14px;line-height:1.6;">
  <div style="font-weight:600;margin-bottom:6px;">修改意见记录</div>
  <div style="white-space:pre-wrap;">${escapeHtml(feedback)}</div>
  <div style="margin-top:8px;font-size:12px;color:#a16207;">（Claude API 暂不可用，此版本由模板生成，仅追加了意见记录以标识修改历史。）</div>
</div>`;
    // Inject the note before </body>
    if (/<\/body>/i.test(baseHtml)) {
        return baseHtml.replace(/<\/body>/i, note + '\n</body>');
    }
    return baseHtml + '\n' + note;
}

// call claude using run_claude.js
async function callClaudeForHtml(prompt) {
    // Test mode: skip real claude call if MOCK_CLAUDE=1
    if (process.env.MOCK_CLAUDE === '1') {
        const t = (prompt.match(/标题：([^\n]+)/) || [])[1] || 'Sample';
        const items = [...prompt.matchAll(/(\d+)\. (.*?) — 文字: (.*)/g)];
        const itemHtml = items.map(m => {
            const src = (m[2].match(/\]\(([^)]+)\)/) || [])[1] || '';
            const txt = m[3];
            return `<section class="post-item"><img src="${src}" alt=""><div class="post-text">${txt}</div></section>`;
        }).join('\n');
        const vMatch = prompt.match(/版本 v(\d+)/);
        const isRevision = !!vMatch;
        const note = isRevision ? `<p style="color:#888;font-size:12px">(mock revision from v${vMatch[1]})</p>` : '';
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t}</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #222; line-height: 1.7; }
h1 { text-align: center; }
.post-item { margin: 30px 0; }
.post-item img { max-width: 100%; height: auto; display: block; border-radius: 8px; }
.post-text { margin-top: 12px; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>${t}</h1>
${note}
${itemHtml}
</body>
</html>`;
    }
    return new Promise((resolve, reject) => {
        const msgB64 = Buffer.from(prompt).toString('base64');
        const child = spawn('node', [path.join(WORKSPACE_DIR, 'run_claude.js')], {
            cwd: WORKSPACE_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ANTHROPIC_DISABLE_PREFLIGHT: '1',
                CLAUDE_CAPTURE_STDIO: '1',
                CLAUDE_MSG: msgB64
            }
        });

        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) {}
            try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {}
            log(`Claude ask timed out after ${CLAUDE_TIMEOUT_MS}ms; falling back to template`);
            reject(new Error('Claude ask timed out'));
        }, CLAUDE_TIMEOUT_MS);

        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });
        child.on('close', code => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(stderr || `claude exit ${code}`));
            }
        });
        child.on('error', err => { clearTimeout(timeout); reject(err); });
    });
}

server.listen(PORT, '0.0.0.0', () => {
    log(`Server running on port ${PORT}`);
});
