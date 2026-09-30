#!/usr/bin/env node
/**
 * PictureText 端到端冒烟测试（无第三方依赖）
 *   node tests/smoke.js [baseUrl]
 * 覆盖：静态资源、/health、图库 API 往返、路径穿越防护、
 *       /ask/claude 参数校验、前端 DOM id 与 app.js 引用一致性。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE = process.argv[2] || 'http://127.0.0.1:8082';
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

async function check(name, fn) {
    try {
        await fn();
        pass++;
        console.log('  ✓ ' + name);
    } catch (e) {
        fail++;
        failures.push(name + ' -> ' + e.message);
        console.log('  ✗ ' + name + ' -> ' + e.message);
    }
}

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4EIwDiqkL4KAc0kBQfNl0G6AAAAAElFTkSuQmCC',
    'base64'
);

async function main() {
    console.log('PictureText smoke test @ ' + BASE);

    // ---------- 1. 平台必备接口 ----------
    console.log('\n[1] 平台必备接口');
    await check('GET /health -> 200 OK', async () => {
        const r = await fetch(BASE + '/health');
        assert.strictEqual(r.status, 200);
        assert.strictEqual((await r.text()).trim(), 'OK');
    });

    await check('GET /ask/claude 缺 q -> 400', async () => {
        const r = await fetch(BASE + '/ask/claude');
        assert.strictEqual(r.status, 400);
    });

    await check('GET /ask/claude?q= 空 -> 400', async () => {
        const r = await fetch(BASE + '/ask/claude?q=');
        assert.strictEqual(r.status, 400);
    });

    // ---------- 2. 静态前端 ----------
    console.log('\n[2] 静态前端');
    for (const [p, needle] of [['/', 'PictureText'], ['/style.css', '.composer'], ['/app.js', '/ask/image']]) {
        await check(`GET ${p} 含关键字`, async () => {
            const r = await fetch(BASE + p);
            assert.strictEqual(r.status, 200);
            assert.ok((await r.text()).includes(needle), `缺少 "${needle}"`);
        });
    }

    await check('未知路径 -> 404', async () => {
        const r = await fetch(BASE + '/definitely-not-here.txt');
        assert.strictEqual(r.status, 404);
    });

    // ---------- 3. 路径穿越防护 ----------
    console.log('\n[3] 安全');
    await check('静态目录穿越被拒', async () => {
        const r = await fetch(BASE + '/../../etc/passwd');
        assert.ok(r.status === 404 || r.status === 403, 'status=' + r.status);
    });
    await check('uploads 目录穿越被拒', async () => {
        const r = await fetch(BASE + '/uploads/..%2f..%2fserver.js');
        assert.strictEqual(r.status, 404);
    });

    // ---------- 4. 图库 API 往返 ----------
    console.log('\n[4] 图库 API');
    let uploaded = null;
    await check('POST /api/upload 原始二进制', async () => {
        const r = await fetch(BASE + '/api/upload?name=smoke.png', {
            method: 'POST',
            headers: { 'Content-Type': 'image/png' },
            body: PNG,
        });
        const d = await r.json();
        assert.ok(d.ok, JSON.stringify(d));
        assert.strictEqual(d.image.size, PNG.length);
        assert.ok(/^[0-9a-f]{64}$/.test(d.image.sha256));
        uploaded = d.image.name;
    });

    await check('POST /api/upload JSON base64 且补扩展名', async () => {
        const r = await fetch(BASE + '/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'smokejson', mime: 'image/png', data: PNG.toString('base64') }),
        });
        const d = await r.json();
        assert.ok(d.ok, JSON.stringify(d));
        assert.ok(d.image.name.endsWith('.png'));
        await fetch(BASE + '/api/images/' + encodeURIComponent(d.image.name), { method: 'DELETE' });
    });

    await check('恶意文件名被清洗（无目录穿越）', async () => {
        const r = await fetch(BASE + '/api/upload?name=' + encodeURIComponent('../../evil;1.png'), {
            method: 'POST',
            headers: { 'Content-Type': 'image/png' },
            body: PNG,
        });
        const d = await r.json();
        assert.ok(d.ok);
        assert.ok(!d.image.name.includes('/') && !d.image.name.includes('..'), d.image.name);
        await fetch(BASE + '/api/images/' + encodeURIComponent(d.image.name), { method: 'DELETE' });
    });

    await check('空 body -> 400', async () => {
        const r = await fetch(BASE + '/api/upload?name=empty.png', { method: 'POST', body: '' });
        assert.strictEqual(r.status, 400);
    });

    await check('GET /api/images 列表包含刚上传的图', async () => {
        const d = await (await fetch(BASE + '/api/images')).json();
        assert.ok(d.ok);
        assert.ok(d.images.some((i) => i.name === uploaded), JSON.stringify(d.images));
    });

    await check('GET /uploads/<name> 取回图片', async () => {
        const r = await fetch(BASE + '/uploads/' + encodeURIComponent(uploaded));
        assert.strictEqual(r.status, 200);
        assert.ok((r.headers.get('content-type') || '').includes('image/png'));
        assert.strictEqual((await r.arrayBuffer()).byteLength, PNG.length);
    });

    await check('DELETE /api/images/<name> 生效', async () => {
        const r = await fetch(BASE + '/api/images/' + encodeURIComponent(uploaded), { method: 'DELETE' });
        assert.strictEqual(r.status, 200);
        const r2 = await fetch(BASE + '/uploads/' + encodeURIComponent(uploaded));
        assert.strictEqual(r2.status, 404);
    });

    await check('DELETE 不存在的图片 -> 404', async () => {
        const r = await fetch(BASE + '/api/images/ghost-xyz.png', { method: 'DELETE' });
        assert.strictEqual(r.status, 404);
    });

    await check('POST /ask/image 缺图 -> 400', async () => {
        const r = await fetch(BASE + '/ask/image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'hi' }),
        });
        assert.strictEqual(r.status, 400);
    });

    await check('GET /api/info 含端口与端点表', async () => {
        const d = await (await fetch(BASE + '/api/info')).json();
        assert.strictEqual(d.port, 8082);
        assert.ok(d.endpoints.includes('/ask/claude'));
    });

    // ---------- 5. 前端一致性（无需浏览器）----------
    console.log('\n[5] 前端一致性');
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const usedIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

    await check('app.js 引用的每个 id 都存在于 index.html', async () => {
        const missing = [...usedIds].filter((id) => !htmlIds.has(id));
        assert.deepStrictEqual(missing, [], '缺失 id: ' + missing.join(', '));
    });

    await check('index.html 中的 .tab 均有 data-tab', async () => {
        const tabs = [...html.matchAll(/class="tab(?:\s[^"]*)?"[^>]*/g)].map((m) => m[0]);
        assert.ok(tabs.length >= 2, 'tab 数量=' + tabs.length);
        assert.ok(tabs.every((t) => t.includes('data-tab=')), 'tab 缺少 data-tab');
    });

    console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
    if (fail) {
        console.log('失败项:');
        failures.forEach((f) => console.log('  - ' + f));
        process.exit(1);
    }
}

main().catch((e) => {
    console.error('smoke test 运行异常:', e);
    process.exit(2);
});
