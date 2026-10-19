# -*- coding: utf-8 -*-
"""Harness Tools Hub Flask app（19081 对接文档首页 + /api/tools 接口 + /p/<name> 代理）。

独立运行于 19081-hub 容器（宿主机 19081），提供：
  - 首页「工具知识库」：底部工具导航 + iframe 预览 + Docs 查看器
  - Hub 公共接口文档（介绍所有重要功能性接口）
  - 示例工具文档（抽自 tools/obs 项目，作为注册范本）
  - /api/tools 系列注册/查询/注销接口
  - /p/<name> 同源代理（转发到 http://dimond.top:19xxx）
"""
import json
import urllib.request
import urllib.error

from flask import Flask, Response, jsonify, request

from . import registry

# TOOLS_HUB_PORT_DEFAULT: create_tools_hub_app 首页标题展示的 Hub 端口默认值（可被 control 传入实际端口）
# 使用位置：create_tools_hub_app() 参数默认值
TOOLS_HUB_PORT_DEFAULT = 19081

# HUB_API_DOC: 首页展示的 Hub 公共接口文档（Markdown）。
# 介绍 Hub 自身所有重要功能性接口；工具对外调用地址统一 http://dimond.top:19xxx。
# 使用位置：create_tools_hub_app() 首页渲染（hub_index）。
HUB_API_DOC = """# Hub 公共接口文档

Hub 位于 `19081`，是所有工具的统一对接入口。已注册工具通过 `http://dimond.top:19xxx`（xxx 为该容器卡片分配的宿主机端口）对外提供服务。

## 功能性接口

- `GET /api/tools` — 列出所有已注册工具
- `POST /api/tools` — 注册一个工具（完整记录或简化记录）
- `GET /api/tools/{name}` — 查询单个工具详情
- `DELETE /api/tools/{name}` — 注销工具
- `GET /p/{name}/` — 同源代理到该工具的 Web UI（`http://dimond.top:19xxx`）
- `GET /` — 本首页（工具知识库 + 文档）

## 注册格式（POST /api/tools）

完整记录（推荐，供 tools 下项目 / 容器卡片直接注册）：

```json
{
  "name": "obs",
  "display_name": "OBS 图床",
  "description": "文件托管、断点续传、公告板服务",
  "doc_md": "# OBS 图床 ...",
  "port": 19082
}
```

简化记录（供 control 面板根据容器信息派生）：

```json
{
  "container_name": "19082-writer",
  "host_port": 19082,
  "agent_type": "claude",
  "description": "一句话描述"
}
```

## 调用示例

```bash
# 列出所有工具
curl http://dimond.top:19081/api/tools

# 查询单个工具
curl http://dimond.top:19081/api/tools/obs

# 容器卡片之间的调用统一走 http://dimond.top:19xxx
curl http://dimond.top:19xxx/emails/?limit=5
```
"""

# _HUB_PAGE_TEMPLATE: 首页 HTML 模板（非 f-string，动态值用占位符替换注入，避免 JS 大括号冲突）。
# 使用位置：create_tools_hub_app() 的 hub_index()。
_HUB_PAGE_TEMPLATE = r"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Tools 知识库 __TOOLS_HUB_PORT__</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: #0f1419; color: #e6e6e6; }
body { display: flex; flex-direction: column; height: 100vh; padding-top: 46px; padding-bottom: 50px; }
.top-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 200; display: flex; align-items: center; gap: 12px; padding: 8px 14px; height: 46px; background: #1a1f29; border-bottom: 1px solid #2a2f3a; }
.top-bar .title { font-weight: 600; font-size: 14px; color: #fff; }
.top-bar .badge { display: inline-block; padding: 2px 8px; margin-left: 8px; background: #3b82f6; color: #fff; font-size: 11px; border-radius: 4px; font-weight: 500; }
.top-bar .current { margin-left: auto; font-size: 12px; color: #9ca3af; font-family: ui-monospace, Menlo, monospace; }
.top-bar .current strong { color: #60a5fa; }
.top-bar .actions { display: flex; gap: 6px; margin-left: 12px; }
.top-bar button { background: #2a2f3a; color: #e6e6e6; border: 1px solid #3a3f4a; padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer; }
.top-bar button:hover { background: #3a3f4a; }
.docs { flex: 0 0 auto; max-height: 40vh; overflow-y: auto; padding: 14px 18px; border-bottom: 1px solid #2a2f3a; }
.doc-card { margin-bottom: 14px; border: 1px solid rgba(255,255,255,0.14); border-radius: 12px; padding: 14px; background: linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03)); }
.doc-card h2 { font-size: 14px; margin-bottom: 10px; color: #fff; }
.doc-body { color: #d1d5db; font-size: 13px; line-height: 1.6; }
.doc-body h1 { font-size: 16px; margin: 12px 0 8px; color: #f0f0f0; }
.doc-body h2 { font-size: 14px; margin: 14px 0 8px; color: #e0e0e0; }
.doc-body h3 { font-size: 13px; margin: 12px 0 6px; color: #ccc; }
.doc-body p { margin: 6px 0; }
.doc-body code { background: #2a2f3a; padding: 2px 6px; border-radius: 3px; color: #60a5fa; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
.doc-body pre { background: #0f1419; padding: 12px 16px; border-radius: 6px; overflow-x: auto; margin: 10px 0; }
.doc-body pre code { background: none; padding: 0; }
.doc-body table { border-collapse: collapse; width: 100%; margin: 10px 0; }
.doc-body th, .doc-body td { border: 1px solid #2a2f3a; padding: 6px 10px; text-align: left; }
.doc-body th { background: #2a2f3a; color: #ccc; font-weight: 500; }
.doc-body ul, .doc-body ol { padding-left: 22px; margin: 6px 0; }
.doc-body li { margin: 3px 0; }
.frame-wrap { flex: 1 1 auto; position: relative; min-height: 0; overflow: hidden; }
iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; display: none; }
iframe.active { display: block; }
.welcome { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; color: #9ca3af; text-align: center; padding: 24px; }
.welcome h1 { color: #e6e6e6; font-size: 22px; font-weight: 500; }
.welcome p { font-size: 14px; max-width: 520px; line-height: 1.6; }
.welcome code { background: #2a2f3a; padding: 2px 6px; border-radius: 4px; color: #60a5fa; font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
.doc-viewer { position: absolute; inset: 0; overflow-y: auto; padding: 20px 28px; background: #1a1f29; color: #d1d5db; font-size: 14px; line-height: 1.7; display: none; }
.doc-viewer.active { display: block; }
.bottom-bar { position: fixed; bottom: 0; left: 0; right: 0; z-index: 200; background: #1a1f29; border-top: 1px solid #2a2f3a; padding: 8px 14px; }
.bottom-bar-inner { display: flex; align-items: center; gap: 10px; overflow-x: auto; }
.bottom-bar .label { font-size: 12px; color: #9ca3af; flex-shrink: 0; font-weight: 500; }
.pills { display: flex; gap: 6px; flex-wrap: nowrap; }
.pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: #2a2f3a; border: 1px solid #3a3f4a; border-radius: 999px; font-size: 12px; color: #d1d5db; cursor: pointer; white-space: nowrap; }
.pill:hover { background: #3a3f4a; }
.pill.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
.pill .dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; flex-shrink: 0; }
.pill .port { font-size: 10px; opacity: .7; font-family: ui-monospace, Menlo, monospace; }
.empty-hint { color: #6b7280; font-size: 12px; padding: 4px 0; }
</style>
</head>
<body>
<div class="top-bar">
  <div class="title">Tools 知识库 <span class="badge">19081-19999</span></div>
  <div class="current" id="currentTarget">选择一个工具查看</div>
  <div class="actions">
    <button id="btnDoc" type="button">Docs</button>
    <button id="btnReload" type="button">Reload</button>
  </div>
</div>

<div class="docs">
  <section class="doc-card">
    <h2>Hub 公共接口文档</h2>
    <div class="doc-body" id="hubApiDoc"></div>
  </section>
  <section class="doc-card">
    <h2>示例工具：OBS 图床（注册范本）</h2>
    <div class="doc-body" id="exampleDoc"></div>
  </section>
</div>

<div class="frame-wrap">
  <iframe id="frame" title="tool ui" allow="clipboard-read; clipboard-write"></iframe>
  <div class="welcome" id="welcome">
    <h1>Tools 知识库</h1>
    <p>选择一个工具查看其功能和文档。端口范围 <code>19081-19999</code> 为 Harness 工具类（MCP 服务器）保留端口。</p>
    <p>当前注册的工具显示在底部标签栏中，点击加载工具的 Web 界面，点击 <code>Docs</code> 按钮查看工具文档。</p>
  </div>
  <div class="doc-viewer" id="docViewer"></div>
</div>

<div class="bottom-bar">
  <div class="bottom-bar-inner">
    <span class="label">Tools:</span>
    <div class="pills" id="pills"><span class="empty-hint">loading...</span></div>
  </div>
</div>

<script>
const API = '/api/tools';
const HUB_API_DOC = __HUB_API_DOC__;
const EXAMPLE_DOC = __EXAMPLE_DOC__;
let current = null;
let showDoc = false;

function renderMarkdown(md) {
  if (!md) return '<p>暂无文档</p>';
  let html = (md || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^\|(.+)\|$/gm, function(line) {
      const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
      const isSep = cells.every(c => /^[-:]+$/.test(c));
      if (isSep) return '<!--sep-->';
      return '<tr>' + cells.map(c => '<td>' + c + '</td>').join('') + '</tr>';
    })
    .replace(/(<tr>[\s\S]*?<\/tr>)\n<!--sep-->\n(<tr>[\s\S]*?<\/tr>(?:\n<tr>[\s\S]*?<\/tr>)*)/g, '<table><thead>$1</thead><tbody>$2</tbody></table>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, m => '<ul>' + m + '</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';
  return html.replace(/<p><\/p>/g, '').replace(/<ul>\s*<\/ul>/g, '').replace(/<table>\s*<\/table>/g, '');
}

async function load() {
  try {
    const res = await fetch(API);
    const data = await res.json();
    render(data.items || []);
  } catch (e) {
    document.getElementById('pills').innerHTML = '<span class="empty-hint">failed to load: ' + e.message + '</span>';
  }
}

function render(items) {
  const wrap = document.getElementById('pills');
  if (!items.length) {
    wrap.innerHTML = '<span class="empty-hint">没有注册的工具</span>';
    return;
  }
  wrap.innerHTML = '';
  items.sort((a, b) => (a.port || 0) - (b.port || 0));
  items.forEach(it => {
    const pill = document.createElement('div');
    pill.className = 'pill' + (current && current.name === it.name ? ' active' : '');
    pill.dataset.name = it.name;
    pill.innerHTML = '<span class="dot"></span><span>' + (it.display_name || it.name) + '</span><span class="port">:' + (it.port || '?') + '</span>';
    pill.onclick = () => select(it);
    wrap.appendChild(pill);
  });
}

function select(item) {
  current = item;
  showDoc = false;
  updateDocButton();
  const frame = document.getElementById('frame');
  const welcome = document.getElementById('welcome');
  const docViewer = document.getElementById('docViewer');
  docViewer.classList.remove('active');
  frame.classList.remove('active');
  welcome.style.display = 'flex';
  document.getElementById('currentTarget').innerHTML = '<strong>' + (item.display_name || item.name) + '</strong> &rarr; :' + (item.port || '?') + ' | ' + (item.description || '');
  document.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p.dataset.name === item.name));
  if (item.port) {
    welcome.style.display = 'none';
    frame.classList.add('active');
    frame.src = 'http://dimond.top:' + item.port + '/';
  } else {
    welcome.querySelector('h1').textContent = '该工具未记录宿主机端口';
    welcome.querySelector('p').textContent = '请先在 Control 面板容器卡片上勾选「注册」，由 control 写入宿主机端口后即可预览。';
  }
}

function showDocumentation() {
  if (!current) return;
  if (!current.doc_md) { alert('该工具没有提供文档'); return; }
  showDoc = true;
  updateDocButton();
  const frame = document.getElementById('frame');
  frame.classList.remove('active');
  document.getElementById('welcome').style.display = 'none';
  const docViewer = document.getElementById('docViewer');
  docViewer.classList.add('active');
  docViewer.innerHTML = renderMarkdown(current.doc_md);
}

function updateDocButton() {
  const btn = document.getElementById('btnDoc');
  btn.textContent = showDoc ? 'Docs (ON)' : 'Docs';
}

document.getElementById('btnReload').onclick = () => {
  if (showDoc && current) showDocumentation();
  else if (current && current.port) { const f = document.getElementById('frame'); f.src = f.src; }
};
document.getElementById('btnDoc').onclick = () => {
  if (showDoc) { showDoc = false; updateDocButton(); select(current); }
  else showDocumentation();
};

// 初始化：渲染公共接口文档 + 示例工具文档
document.getElementById('hubApiDoc').innerHTML = renderMarkdown(HUB_API_DOC);
document.getElementById('exampleDoc').innerHTML = renderMarkdown(EXAMPLE_DOC);

load();
setInterval(load, 10000);
</script>
</body>
</html>"""


def create_tools_hub_app(tools_hub_port=TOOLS_HUB_PORT_DEFAULT):
    """19081 工具 Hub（对接文档）：首页展示工具知识库、公共接口文档、示例工具文档，并提供 /api/tools 与 /p/<name> 代理。"""
    hub = Flask("harness_tools_hub")
    hub.config["JSON_AS_ASCII"] = False

    @hub.get("/api/tools")
    def hub_list():
        return jsonify({"items": registry.list_tools_file()})

    @hub.post("/api/tools")
    def hub_register():
        body = request.get_json(silent=True) or {}
        try:
            record = registry.normalize_tool_payload(body)
            if not isinstance(record, dict):
                return jsonify({"error": "invalid payload"}), 400
            record = registry.register_tool_file(record)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        return jsonify(record), 200

    @hub.get("/api/tools/<name>")
    def hub_get(name):
        record = registry.get_tool_file(name)
        if record is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(record)

    @hub.delete("/api/tools/<name>")
    def hub_delete(name):
        removed = registry.unregister_tool_file(name)
        return jsonify({"ok": True, "removed": bool(removed)})

    @hub.route("/p/<path:path>")
    def hub_proxy(path):
        """同源代理：把 /p/<name>/... 转发到该工具的 http://dimond.top:<port>/..."""
        name = path.split("/", 1)[0]
        tool = registry.get_tool_file(name)
        if tool is None:
            return jsonify({"error": "tool not found"}), 404
        port = tool.get("port")
        if port in (None, ""):
            return jsonify({"error": "tool port unknown"}), 404
        rest = ("/" + path.split("/", 1)[1]) if "/" in path else "/"
        qs = request.query_string.decode("utf-8")
        target = "http://dimond.top:%s%s" % (port, rest)
        if qs:
            target += "?" + qs
        try:
            req = urllib.request.Request(target, method=request.method, data=request.get_data() or None)
            for k, v in request.headers.items():
                if k.lower() in ("host", "connection", "content-length", "transfer-encoding", "content-encoding", "accept-encoding"):
                    continue
                req.add_header(k, v)
            resp = urllib.request.urlopen(req, timeout=30)
            body = resp.read()
            status = resp.status
            headers = {}
            for k, v in resp.headers.items():
                if k.lower() in ("connection", "transfer-encoding", "content-length", "content-encoding"):
                    continue
                headers[k] = v
        except urllib.error.HTTPError as e:
            return Response(e.read(), status=e.code, headers={"Content-Type": "text/plain; charset=utf-8"})
        except Exception as e:
            return jsonify({"error": "proxy error: %s" % e}), 502
        return Response(body, status=status, headers=headers)

    @hub.get("/")
    def hub_index():
        page = (
            _HUB_PAGE_TEMPLATE
            .replace("__TOOLS_HUB_PORT__", str(tools_hub_port))
            .replace("__HUB_API_DOC__", json.dumps(HUB_API_DOC, ensure_ascii=False))
            .replace("__EXAMPLE_DOC__", json.dumps(registry.EXAMPLE_TOOL.get("doc_md", ""), ensure_ascii=False))
        )
        return page, 200, {"Content-Type": "text/html; charset=utf-8"}

    return hub


def run_hub(tools_hub_port=TOOLS_HUB_PORT_DEFAULT, host="0.0.0.0", port=8082):
    """启动 Hub 服务（阻塞），监听 8082。供 control 进程内线程或独立运行调用。"""
    from werkzeug.serving import make_server

    hub_app = create_tools_hub_app(tools_hub_port)
    server = make_server(host, port, hub_app, threaded=True)
    print("[tools-hub] listening on %d" % port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    run_hub()
