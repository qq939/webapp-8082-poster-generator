#!/usr/bin/env node
/* ===== 前端静态一致性自测 =====
 * 无浏览器环境（容器内没有 playwright/chromium），因此用静态交叉校验替代点击测试：
 *   1. app.js 里 getElementById() 引用的每个 id，必须存在于 index.html
 *   2. index.html 里每个 id，必须被 app.js 引用（无死代码）
 *   3. app.js 请求的接口路径必须在 server.js 中实现
 *   4. index.html 引用的静态资源文件必须存在
 * 用法: node test_ui.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
const chk = (name, ok, detail) => {
  if (ok) { console.log('PASS  ' + name); pass++; }
  else { console.log('FAIL  ' + name + (detail ? '  ' + detail : '')); fail++; }
};

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set([...js.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)]
  .map((m) => m[1] || m[2]));

// 1. JS 引用的 id 在 HTML 中存在
const missing = [...jsIds].filter((id) => !htmlIds.has(id));
chk('app.js 引用的 id 均存在于 index.html', missing.length === 0, missing.join(', '));

// 2. HTML 的 id 都被用到（排除纯锚点/容器）
const unused = [...htmlIds].filter((id) => !jsIds.has(id) && !['panel-chat', 'panel-gallery'].includes(id));
chk('index.html 无未使用的 id', unused.length === 0, unused.join(', '));

// 3. app.js 调用的接口在 server.js 中实现
const endpoints = [...new Set([...js.matchAll(/fetch\('(\/api\/[^'?]+)/g)].map((m) => m[1]))];
const missingEp = endpoints.filter((e) => !server.includes(`'${e}'`) && !server.includes(`"${e}"`) && !server.includes(e));
chk('app.js 调用的接口均在 server.js 实现', missingEp.length === 0, missingEp.join(', '));

// 4. 静态资源存在
const assets = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1])
  .filter((a) => !a.startsWith('//'));
const missingAsset = assets.filter((a) => !fs.existsSync(path.join(ROOT, 'public', a)));
chk('index.html 引用的静态资源均存在', missingAsset.length === 0, missingAsset.join(', '));

// 5. 关键选择器在 CSS 中定义
const selectors = ['.messages', '.composer', '.msg', '.card', '.gallery', '.toast', '.lightbox', '.typing'];
const missingSel = selectors.filter((s) => !css.includes(s));
chk('关键 CSS 选择器均已定义', missingSel.length === 0, missingSel.join(', '));

// 6. server.js 必备端点与端口
chk('server.js 监听 8082', /PORT\s*=\s*8082/.test(server) && /server\.listen\(PORT/.test(server));
chk('server.js 提供 /health -> OK', server.includes("'/health'") && server.includes("sendText(res, 200, 'OK')"));
chk('server.js 提供 /ask/claude', server.includes("'/ask/claude'"));
chk('server.js 经 run_claude.js 调用（不直连 claude CLI）',
  server.includes("'run_claude.js'") && !/spawn\(\s*'claude'/.test(server));
chk('server.js 图文模式使用 tmp.png + CLAUDE_IMG',
  server.includes('tmp.png') && server.includes('CLAUDE_IMG'));
chk('server.js 必带 ANTHROPIC_DISABLE_PREFLIGHT / CLAUDE_CAPTURE_STDIO',
  server.includes("ANTHROPIC_DISABLE_PREFLIGHT: '1'") && server.includes("CLAUDE_CAPTURE_STDIO: '1'"));

console.log(`\n===== 结果: PASS=${pass} FAIL=${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
