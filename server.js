// ===== PictureText · 图文 Web App（容器内端口 8082）=====
// 平台规范（systemreadme.md）：
//   核心一：所有 Claude 调用必须走 run_claude.js（保证问答进入 logs/agent_tui.log）
//   核心二：每个容器必备 /ask/claude + /health
//   核心十：图文模式 —— 图片写入 project/tmp.png + CLAUDE_IMG=1
// 无第三方依赖，仅用 Node 内置 http / fs / crypto。
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 8082;
const HOST = '0.0.0.0';
const WORKSPACE_DIR = '/home/agent/.claude/workspace/project';
const PUBLIC_DIR = path.join(WORKSPACE_DIR, 'public');
const UPLOAD_DIR = path.join(WORKSPACE_DIR, 'uploads');
const TMP_IMG = path.join(WORKSPACE_DIR, 'tmp.png');
const LOG_DIR = path.join(WORKSPACE_DIR, 'logs');
const RUN_LOG = path.join(LOG_DIR, 'run.log');

const CLAUDE_TIMEOUT_MS = 3600 * 1000;   // 与 run_claude.js 对齐：1 小时
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 单图 10 MiB

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
};

const SYSTEM_PROMPT =
    '本项目非回合对话模式，对话后必须交付完整代码与交付件，使命必达。禁止中途确认，禁止未完成中断。' +
    '禁止进入plan模式，直接行动，立刻调用工具，只输出结果。优先使用`Glob`/`Grep`工具代替`Read`工具。';

// ---------- 日志 ----------
// user_start.sh 会把 stdout 重定向到 logs/run.log；若如此则不再重复写文件。
let _stdoutIsRunLog = null;
function stdoutIsRunLog() {
    if (_stdoutIsRunLog !== null) return _stdoutIsRunLog;
    try {
        _stdoutIsRunLog = fs.fstatSync(1).ino === fs.statSync(RUN_LOG).ino;
    } catch (_) {
        _stdoutIsRunLog = false;
    }
    return _stdoutIsRunLog;
}

function log(...args) {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
    // stdout 未重定向到 run.log 时，由本进程负责写文件
    if (!stdoutIsRunLog()) {
        try {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            fs.appendFileSync(RUN_LOG, line + '\n');
        } catch (_) { /* 日志失败不影响服务 */ }
    }
    console.log(line);
}

// ---------- 基础工具 ----------
function sendText(res, code, text, extraHeaders) {
    res.writeHead(code, Object.assign({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
    }, extraHeaders || {}));
    res.end(text);
}

function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function readBody(req, limit) {
    const max = limit || MAX_IMAGE_BYTES;
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > max) {
                reject(Object.assign(new Error('Payload too large'), { code: 413 }));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** 文件名清洗：只保留 basename，去掉路径穿越与危险字符 */
function safeName(name) {
    const base = path.basename(String(name || '').replace(/\\/g, '/'));
    const cleaned = base.replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
    return cleaned.slice(0, 120) || `img_${Date.now()}.png`;
}

function extFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('png')) return '.png';
    if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
    if (m.includes('gif')) return '.gif';
    if (m.includes('webp')) return '.webp';
    if (m.includes('bmp')) return '.bmp';
    return '.png';
}

/** 解析 data URL 或裸 base64，返回 { buffer, mime } */
function decodeImagePayload(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const m = s.match(/^data:([\w/+.-]+);base64,(.*)$/s);
    if (m) {
        return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
    }
    return { mime: '', buffer: Buffer.from(s, 'base64') };
}

async function ensureDirs() {
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    await fsp.mkdir(LOG_DIR, { recursive: true });
}

// ---------- Claude 调用（唯一入口 run_claude.js）----------
/**
 * @param {string} message  纯文本消息
 * @param {Object} [opts]
 * @param {string} [opts.imagePath] 若提供则走图文模式（CLAUDE_IMG=1）
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function callClaude(message, opts) {
    const options = opts || {};
    const env = Object.assign({}, process.env, {
        ANTHROPIC_DISABLE_PREFLIGHT: '1',
        CLAUDE_CAPTURE_STDIO: '1',
        CLAUDE_MSG: Buffer.from(message, 'utf8').toString('base64'),
        CLAUDE_PERMISSION_MODE: 'bypassPermissions',
        CLAUDE_SYSTEM_PROMPT: SYSTEM_PROMPT,
    });
    // 图文模式：图片必须已落在 project/tmp.png，run_claude.js 会追加 file:// 引用
    if (options.imagePath) {
        env.CLAUDE_IMG = options.imagePath;
    } else {
        delete env.CLAUDE_IMG;  // 纯文本模式：避免继承父进程残留值
    }

    return new Promise((resolve) => {
        const child = spawn('node', [path.join(WORKSPACE_DIR, 'run_claude.js')], {
            cwd: WORKSPACE_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            env,
        });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            log('[WARN] claude 调用超时，强制结束 pid=' + child.pid);
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000);
        }, CLAUDE_TIMEOUT_MS);

        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: 'spawn error: ' + e.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code: code === null ? -1 : code, stdout, stderr });
        });
    });
}

/**
 * 解析 /ask/claude 的 q 参数（平台规范编码识别）
 *  - 含空格 或 长度 < 50 → URL 解码
 *  - 否则 → base64 解码
 */
function decodeQuestion(q) {
    const raw = String(q);
    let decoded;
    if (/\s/.test(raw) || raw.length < 50) {
        decoded = decodeURIComponent(raw);
    } else {
        const buf = Buffer.from(raw, 'base64');
        decoded = buf.toString('utf8');
        // base64 解出乱码时回退到 URL 解码
        if (decoded.includes('\uFFFD')) decoded = decodeURIComponent(raw);
    }
    return decoded;
}

// ---------- 静态资源 ----------
async function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');

    try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) throw new Error('not a file');
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': 'no-cache',
        });
        fs.createReadStream(filePath).pipe(res);
    } catch (_) {
        sendText(res, 404, 'Not Found');
    }
}

async function serveUpload(res, pathname) {
    // /uploads/<name>
    const name = safeName(pathname.slice('/uploads/'.length));
    const filePath = path.join(UPLOAD_DIR, name);
    try {
        const stat = await fsp.stat(filePath);
        if (!stat.isFile()) throw new Error('not a file');
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': 'public, max-age=60',
        });
        fs.createReadStream(filePath).pipe(res);
    } catch (_) {
        sendText(res, 404, 'Not Found');
    }
}

// ---------- 业务 API ----------
async function listImages() {
    const names = await fsp.readdir(UPLOAD_DIR);
    const out = [];
    for (const n of names) {
        if (n.startsWith('.')) continue;
        try {
            const st = await fsp.stat(path.join(UPLOAD_DIR, n));
            if (!st.isFile()) continue;
            out.push({
                name: n,
                size: st.size,
                uploaded_at: st.mtime.toISOString(),
                url: '/uploads/' + encodeURIComponent(n),
            });
        } catch (_) { /* 忽略竞态删除 */ }
    }
    out.sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1));
    return out;
}

async function saveImage(buffer, rawName, mime) {
    if (!buffer || !buffer.length) throw Object.assign(new Error('empty image'), { code: 400 });
    if (buffer.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('image too large (max 10 MiB)'), { code: 413 });

    let name = safeName(rawName);
    if (!path.extname(name)) name += extFromMime(mime);
    const filePath = path.join(UPLOAD_DIR, name);
    await fsp.writeFile(filePath, buffer);

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    log(`[upload] ${name} ${buffer.length}B`);
    return { name, size: buffer.length, sha256, url: '/uploads/' + encodeURIComponent(name) };
}

async function deleteImage(name) {
    const safe = safeName(name);
    const filePath = path.join(UPLOAD_DIR, safe);
    await fsp.unlink(filePath);
    log(`[delete] ${safe}`);
    return safe;
}

async function handleAskClaude(req, res, url) {
    const q = url.searchParams.get('q');
    if (!q) return sendText(res, 400, 'Missing q parameter');

    let question;
    try {
        question = decodeQuestion(q);
    } catch (e) {
        return sendText(res, 400, 'Invalid encoding');
    }
    if (!question || !question.trim()) return sendText(res, 400, 'Empty question');

    // 可选图文：?image=<uploads 中的文件名> 或 ?image_url=<绝对路径>
    const imageParam = url.searchParams.get('image');
    let imagePath = null;
    if (imageParam) {
        const safe = safeName(imageParam);
        const p = path.join(UPLOAD_DIR, safe);
        if (fs.existsSync(p)) {
            await fsp.copyFile(p, TMP_IMG);
            imagePath = TMP_IMG;
        }
    }

    log(`[ask/claude] ${question.slice(0, 60).replace(/\n/g, ' ')}${imagePath ? ' (图文)' : ''}`);
    const r = await callClaude(question, { imagePath });
    if (r.code === 0) return sendText(res, 200, r.stdout.trim());
    return sendText(res, 500, r.stderr.trim() || `Exit code: ${r.code}`);
}

async function handleAskImage(req, res) {
    let body;
    try {
        body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    } catch (_) {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
    }

    const prompt = String(body.prompt || '').trim() || '请描述这张图片的内容。';
    let image;
    try {
        image = decodeImagePayload(body.image);
    } catch (_) {
        image = null;
    }
    if (!image || !image.buffer.length) {
        return sendJson(res, 400, { ok: false, error: 'missing or invalid image (base64 / data URL)' });
    }

    let saved;
    try {
        saved = await saveImage(image.buffer, body.name || `image_${Date.now()}`, image.mime);
        // 图文模式要求图片落在 project/tmp.png
        await fsp.copyFile(path.join(UPLOAD_DIR, saved.name), TMP_IMG);
    } catch (e) {
        return sendJson(res, e.code || 500, { ok: false, error: e.message });
    }

    log(`[ask/image] ${prompt.slice(0, 60).replace(/\n/g, ' ')} <- ${saved.name}`);
    const r = await callClaude(prompt, { imagePath: TMP_IMG });
    if (r.code !== 0) {
        return sendJson(res, 500, {
            ok: false,
            error: r.stderr.trim() || `Exit code: ${r.code}`,
            image: saved,
        });
    }
    return sendJson(res, 200, { ok: true, answer: r.stdout.trim(), image: saved });
}

async function handleUpload(req, res, url) {
    const ctype = String(req.headers['content-type'] || '');
    try {
        if (ctype.includes('application/json')) {
            const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
            const img = decodeImagePayload(body.data || body.image);
            if (!img || !img.buffer.length) throw Object.assign(new Error('missing data'), { code: 400 });
            const saved = await saveImage(img.buffer, body.name || `image_${Date.now()}`, body.mime || img.mime);
            return sendJson(res, 200, { ok: true, image: saved });
        }
        // 原始二进制：POST /api/upload?name=cat.png --data-binary @cat.png
        const buf = await readBody(req);
        const name = url.searchParams.get('name') || `image_${Date.now()}`;
        const saved = await saveImage(buf, name, ctype);
        return sendJson(res, 200, { ok: true, image: saved });
    } catch (e) {
        return sendJson(res, e.code || 500, { ok: false, error: e.message });
    }
}

async function route(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    // --- 平台必备 ---
    if (p === '/health') return sendText(res, 200, 'OK');

    if ((req.method === 'GET' || req.method === 'POST') && p === '/ask/claude') {
        return handleAskClaude(req, res, url);
    }

    if (req.method === 'POST' && p === '/ask/image') return handleAskImage(req, res);

    // --- 图库 API ---
    if (req.method === 'POST' && p === '/api/upload') return handleUpload(req, res, url);

    if (req.method === 'GET' && p === '/api/images') {
        const images = await listImages();
        return sendJson(res, 200, { ok: true, count: images.length, images });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/images/')) {
        try {
            const name = await deleteImage(p.slice('/api/images/'.length));
            return sendJson(res, 200, { ok: true, deleted: name });
        } catch (e) {
            return sendJson(res, 404, { ok: false, error: 'image not found: ' + e.message });
        }
    }

    if (req.method === 'GET' && p.startsWith('/uploads/')) return serveUpload(res, p);

    // --- 元信息 ---
    if (req.method === 'GET' && p === '/api/info') {
        const images = await listImages();
        return sendJson(res, 200, {
            ok: true,
            app: 'picturetext',
            port: PORT,
            version: '1.0.0',
            image_count: images.length,
            endpoints: ['/health', '/ask/claude', '/ask/image', '/api/upload', '/api/images', '/uploads/<name>'],
        });
    }

    if (req.method === 'GET' && p === '/logs/run.log') {
        try {
            const txt = await fsp.readFile(RUN_LOG, 'utf8');
            return sendText(res, 200, txt.split('\n').slice(-200).join('\n'));
        } catch (_) {
            return sendText(res, 200, '(empty)');
        }
    }

    // --- 静态前端 ---
    if (req.method === 'GET') return serveStatic(req, res, p);

    return sendText(res, 405, 'Method Not Allowed');
}

const server = http.createServer((req, res) => {
    res.setTimeout(CLAUDE_TIMEOUT_MS + 60000, () => {
        sendText(res, 504, 'Request timeout');
    });
    route(req, res).catch((e) => {
        log('[ERROR]', e && e.stack ? e.stack : String(e));
        if (!res.headersSent) sendJson(res, e.code || 500, { ok: false, error: e.message });
        else res.end();
    });
});

ensureDirs().then(() => {
    server.listen(PORT, HOST, () => {
        log(`PictureText 图文 Web App listening on http://${HOST}:${PORT}`);
    });
});

process.on('SIGTERM', () => { log('SIGTERM, shutting down'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { log('SIGINT, shutting down'); server.close(() => process.exit(0)); });
