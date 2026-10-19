# SKILL.md - 图文 HTML 生成器能力说明

本文件描述项目的可调用能力，供 Agent 或自动化脚本参考。

## 项目代号
`port-8082-image-html-generator`

## 端口
固定 `8082`。容器内地址 `http://localhost:8082`。

## 启动 / 停止

```bash
# 启动（默认真实 Claude 模式；v1 仍走模板，v2+ 走 Claude）
./user_start.sh

# 启动（Mock 模式：v2+ 反馈也直接走模板回退）
MOCK_CLAUDE=1 ./user_start.sh

# 停止
pkill -9 -f "node server.js"
```

## 核心设计：v1 模板 / v2+ AI

| 阶段 | 路径 | 是否调 AI |
|---|---|---|
| **finalize（v1）** | `POST /api/projects/{id}/finalize` | **永不调 AI**，直接 `renderTemplateHtml()` 输出完整 HTML |
| **feedback（v2+）** | `POST /api/projects/{id}/feedback` | 调 `run_claude.js`（60s 超时，超时回退 `applyTemplateFeedback()`） |

> 容器内 `claude` CLI 经常 hang 死，v1 设计为永远不依赖 AI 是为了保证"完成，生成 v1"立刻可见。

## 能力清单

### 1. 创建图文项目（向导）

通过浏览器 `/` 进入向导：
1. 顶部卡片填写标题（所有段落共用，可随时修改）
2. 点 "+ 添加一段" 进入新段
3. 上传图片（文件 / 拖拽 / 粘贴）
4. 裁剪（缩放 + 拖动选区 + 4 角手柄）
5. 输入对应文字
6. 点 "完成此段 ✓" 标记本段为 done，缩略图序号变绿
7. 重复 2-6 添加更多段，或直接 "完成，生成 v1"
8. 任意时刻可点缩略图条上某个段落卡片，跳回去修改
9. 当前段卡片右上角有红色 × 按钮，确认后删除该段（图片与文字一起删除，后续段落自动前移）

API 等价：
```bash
curl -X POST http://localhost:8082/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"title":"我的图文"}'
# → {"projectId":"...","meta":{...}}
```

### 2. 上传图片到项目

```bash
curl -X POST http://localhost:8082/api/projects/<PID>/images \
  -H 'Content-Type: application/json' \
  -d '{"dataUrl":"data:image/png;base64,..."}'
# → {"imageId":"xxx.png","url":"/api/projects/<PID>/images/xxx.png"}
```

支持的格式：任何浏览器 canvas 能导出的格式（PNG/JPEG/WebP）。

### 3. 完成向导生成 v1（模板即时）

```bash
curl -X POST http://localhost:8082/api/projects/<PID>/finalize \
  -H 'Content-Type: application/json' \
  -d '{
    "draft": {
      "title": "我的图文",
      "items": [
        {"imageId":"xxx.png", "text":"第一段文字"},
        {"imageId":"yyy.png", "text":"第二段文字"}
      ]
    }
  }'
# → {"projectId":"<PID>","version":1,"html":"<!DOCTYPE html>...","usedAi":false}
```

返回典型时间：**< 50ms**（纯模板生成）。

### 4. 查看任意版本

```bash
# JSON 形式
curl http://localhost:8082/api/projects/<PID>/v1
# → {"version":1,"latestVersion":1,"html":"..."}

# HTML 页面（带侧栏）
open http://localhost:8082/p/<PID>
open http://localhost:8082/p/<PID>/v2

# 下载（带 Content-Disposition）
curl -O http://localhost:8082/api/projects/<PID>/v1/download

# 导出 PDF（A4 海报；无需 AI）
curl -O http://localhost:8082/api/projects/<PID>/v1/pdf

# 导出 DOCX（Word 文档；无需 AI）
curl -O http://localhost:8082/api/projects/<PID>/v1/docx
```

### 5. 基于现有版本迭代（AI 改写）

```bash
curl -X POST http://localhost:8082/api/projects/<PID>/feedback \
  -H 'Content-Type: application/json' \
  -d '{"baseVersion":2,"feedback":"标题改成红色，图片间增加间距"}'
# → {"projectId":"<PID>","baseVersion":2,"newVersion":3,"html":"..."}
```

行为：
- 调 `run_claude.js` 走 Claude CLI；**60s 超时**，超时 SIGKILL 子进程 + 进程组
- 超时回退：`applyTemplateFeedback(baseHtml, feedback)` —— 在原 HTML 上方加一条黄色备注显示反馈内容
- 如果 `baseVersion` 不是最新版本 → **删除 `v_(base+1)..v_latest` 的文件**，再生成 `v_(base+1)`（reset --hard 语义）

### 6. 库浏览

```bash
# API
curl http://localhost:8082/api/projects
# → {"projects":[{"id":"...","title":"...","latestVersion":3,...}]}

# UI
open http://localhost:8082/library
```

库页面每个项目卡片：
- 标题 + `v{N}` + 时间
- 「进入」按钮（链接到 `/p/<id>`，即 viewer 最新版本）
- 「下载 v{N}」按钮（链接到 `/api/projects/<id>/v{N}/download`）
- 「导出 PDF」按钮（链接到 `/api/projects/<id>/v{N}/pdf`）
- 「导出 DOCX」按钮（链接到 `/api/projects/<id>/v{N}/docx`）
- 「✏️ 继续编辑」（回到向导）
- 如果 `latestVersion == 0`，显示"未生成"（导出按钮隐藏）

## 错误码与诊断

| 现象 | 排查 |
|---|---|
| `EADDRINUSE: 8082` | `pkill -9 -f "node server.js"` |
| finalize 很久没返回 | v1 应秒回（不可能慢）；如果是 v2+ feedback，看 `logs/run.log` 有没有 Claude 超时 |
| wizard "生成失败" | finalize 抛错；检查 `logs/run.log` 最近的 `Finalize project` 行 |
| 图片 404 | 项目被清空？检查 `data/projects/<PID>/images/` |
| 版本下载 404 | 文件不存在，可能被 reset --hard 删了 |
| library 显示"未生成" | finalize 没成功执行过；检查 meta.json 的 `latestVersion` |
| PDF 导出 500 | 看 `logs/run.log` 的 `pdf build failed`；常见原因是 `fonts/` 里缺 Noto CJK 字体 |
| DOCX 导出 500 | 看 `logs/run.log` 的 `docx build failed`；确认 `node_modules/docx` 已安装 |
| DOCX 里图片变成灰字 | 图片格式是 WebP（docx 不支持），或图片字节损坏 |

## 测试入口

```bash
# 健康检查
curl http://localhost:8082/health

# Mock E2E
MOCK_CLAUDE=1 ./user_start.sh

# 真实模式 E2E
./user_start.sh
curl -X POST http://localhost:8082/api/projects \
  -H 'Content-Type: application/json' \
  -d '{"title":"测试"}'
```

手动 E2E（用 curl 模拟 wizard 完整流程）：
```bash
BASE=http://localhost:8082
PID=$(curl -s -X POST $BASE/api/projects -H 'Content-Type: application/json' \
  -d '{"title":"test"}' | grep -oE '"projectId":"[^"]+"' | cut -d'"' -f4)
# 上传图片
IMG=$(curl -s -X POST $BASE/api/projects/$PID/images -H 'Content-Type: application/json' \
  -d "{\"dataUrl\":\"data:image/png;base64,iVBORw0...\"}" | grep -oE '"imageId":"[^"]+"' | cut -d'"' -f4)
# finalize (v1 模板)
curl -s -X POST $BASE/api/projects/$PID/finalize -H 'Content-Type: application/json' \
  -d "{\"draft\":{\"title\":\"test\",\"items\":[{\"imageId\":\"$IMG\",\"text\":\"段落一\"}]}}"
# 下载
curl -s -o v1.html $BASE/api/projects/$PID/v1/download
curl -s -o v1.pdf  $BASE/api/projects/$PID/v1/pdf
curl -s -o v1.docx $BASE/api/projects/$PID/v1/docx
```

导出端到端校验（对库里每个项目的最新版本逐个校验）：
```bash
npm run test:pdf    # 9 项：HTTP/头/魔数/%%EOF/pdf-parse 抽文字含标题
npm run test:docx   # 16 项：MIME/魔数/zip 结构/OOXML 部件/图片数/eastAsia 字体
```

## 关键依赖

- Node.js 20+
- `claude` CLI（系统已有；v2+ feedback 路径需要）
- `run_claude.js`（系统已有，通过 `CLAUDE_MSG` 环境变量传递 base64 prompt）
- npm 包：`pdfkit`（PDF）、`docx`（DOCX）、`pdf-parse` + `fflate`（测试用）
- `fonts/NotoSansCJKsc-{Regular,Bold}.otf`（PDF 中文渲染必需）

## 修改指南

- 修改 HTTP 路由 + 模板生成 + Claude 编排：`server.js`
- 修改向导 UI（缩略图进度条、上传裁剪、完成流程）：`static/app.js` + `static/style.css`
- 修改 viewer（侧栏、版本列表、反馈提交）：`static/viewer.js` + `static/viewer.css`
- 修改 Claude prompt：`server.js` 的 `buildRevisionPrompt`
- 修改 v1 模板样式：`server.js` 的 `renderTemplateHtml(title, items)`
- 修改 feedback 兜底模板：`server.js` 的 `applyTemplateFeedback(baseHtml, feedback)`
- 修改超时：`server.js` 的 `CLAUDE_TIMEOUT_MS`
- 修改 PDF 排版：`server.js` 的 `renderHtmlToPdf` / `wrapCjkText`
- 修改 DOCX 排版：`server.js` 的 `buildDocxBuffer`（字体走 `DOCX_FONT`，图片尺寸走 `fitImageBox` + `DOCX_MAX_IMG_W/H`）
- 修改 DOCX 图片尺寸探测：`server.js` 的 `imageDimensions`（PNG IHDR / JPEG SOF）

## 反模式（不要做）

- 不要把 `data/`、`logs/` 提交到 git（已有 `.gitignore`）
- 不要在 viewer 中以 `document.write` 之外的方式渲染用户生成的 HTML（避免 XSS 影响父页面，已用 `iframe sandbox` 隔离）
- 不要在 finalize 路径里调 Claude（v1 设计为永远模板）
- 不要把 MOCK_CLAUDE 留作生产默认（README 强调仅用于测试/离线）
- 不要改 `latestVersion` 时不递增（v2+ 会盖掉历史；如要"重置"请走 reset --hard 路径）
- 不要直接删 `data/projects/<id>` 整个目录来"清空项目"，会留下垃圾；用 reset --hard 删文件即可
- 不要把 `fonts/` 从仓库移除（PDF 中文渲染强依赖 NotoSansCJKsc）
- 不要在 DOCX 导出里保留 `/api/projects/.../images/...` 形式的 `<img src>`；必须先 `rewriteImagesToDataUri()`，否则 `parseTemplateSections()` 拿不到图片字节
- 不要给 DOCX 塞 WebP（`docx` 的 `ImageRun` 只认 png/jpg/gif/bmp）

## Agent TUI 日志摘要（logs/agent_tui.log）

来源：宿主机会话期间所有 prompt 与 Claude 响应都记录到这里，便于复盘项目演进。

主要节点：
1. **07:06** 首次问候
2. **07:14 / 07:23** 用户提出 web app 完整需求（向导 + 库 + 多版本 + reset --hard + 下载）
3. **07:29–07:35** 多次"你是HTML图文排版专家"调用（前版本 v1 调 Claude 的 prompt 模板）
4. **08:27 / 08:36** Wizard UI 改版为"单标题 + 段落循环 + 缩略图进度条"
5. **11:08** 用户要求库卡片提供"直接下载"入口（不再只"进入"）
6. **11:18** 用户报告"完成生成 v1 但库显示未生成" —— 真实 Claude hang 死的 bug
7. **11:24** 用户确认设计："v1 先套模板；v2/v3 才调 AI" —— 永久固化在 server.js 中
8. **11:31** 用户要求完成 v1 后跳转到库页面（下载/反馈入口） —— `app.js` finalize 改为 `window.location.href='/library'`
9. **（前一段会话）** 从 OBS 拉取 `webapp-8082-poster-generator` 仓库代码部署到项目根，保留平台文件（user_start.sh / systemreadme.md / logs 约定），新增 PDF 导出（chromium → pdfkit）、文字在上版式、库卡片导出 PDF、分页布局与 CJK 换行修复
10. **（本次会话）** 部署校验通过后，新增「导出 DOCX」：`docx` 包渲染 + `w:eastAsia` 中文字体 + PNG/JPEG 尺寸探测，并补 `npm run test:docx` 端到端校验

## 最近几轮对话摘要

### Turn A（11:18 起）：Bug —— 点完成没保存
- 用户反馈：「按照流程点击完成生成 v1，但是实际上进入库里面显示的是未生成。也就是你没有保存。」
- 根因：
  - 真实 `claude` CLI 在容器内 hang 死，子进程变 zombie
  - 原 `CLAUDE_TIMEOUT_MS = 600s`（10 分钟）过长，wizard fetch 早超时
  - 还有第二个 bug：每次 finalize 把 `latestVersion` 写死成 1，覆盖历史
- 修复（commit `5e00c08`）：
  - 新增 `CLAUDE_TIMEOUT_MS = 60s`，超时 SIGKILL 子进程 + 进程组
  - finalize 支持 `body.useTemplate=true` 与 `FORCE_TEMPLATE=1` 环境变量
  - finalize 改为版本递增（`latestVersion + 1`），`versions` 数组用 `concat` 追加
  - 前端 `serializeItems()` 不再要求 `status === 'done'`
- 验证：v1 29ms 返回；同项目二次 finalize 产生 v2.html，v1.html 完整保留

### Turn B（11:24 起）：固化设计 —— v1 永远模板，v2+ 才调 AI
- 用户反馈：「完成，生成 v1 先套一个模板就行了，不用 ai 生成了。我们 v2、v3 会在 html 预览里面给 ai 意见，此时再生成更美观的版本比较合适。」
- 实现（commit `f17d22b`）：
  - `server.js` finalize 路径去掉 Claude 调用，永远 `renderTemplateHtml(title, items)`
  - finalize 响应 `usedAi: false` 永远
  - 前端 finalize body 移除 `useTemplate` 标志
- 行为固化：
  - v1 finalize：纯模板，0ms 返回（容器环境无 Claude 也能用）
  - v2+ feedback：仍调 Claude（60s 超时兜底）
- 验证：v1 0–29ms 返回；feedback 后 v2 meta.feedback = 用户原文，parentVersion=1

### Turn C（11:31 起）：完成 → 跳库页面（下载 / 反馈入口）
- 用户反馈：「点击完成，生成 v1，就要跳转到对应的库页面，页面可以直接下载也可以提意见让 ai 修改生成 v2v3 等等。要求是套模板，v1 不用 ai 介入。」
- 设计：wizard 完成后落库页（而非 viewer），库卡片已有"进入 + 下载 v{N}"双入口：
  - **下载 v1**：直接拿 HTML（v1 模板产出，无需 AI）
  - **进入**：进入 viewer → 在侧栏提交意见 → AI 生成 v2/v3
- 实现（commit `0ae842f`）：
  - `static/app.js` finalize 成功后的 `setTimeout` 改为 `window.location.href = '/library'`
  - toast 文案改为"v1 生成成功，正在跳到库…"
  - 不再直接进 viewer（避免用户每次都被推到 viewer）
- 验证（curl E2E）：
  - finalize 23ms 返回，`usedAi:false`
  - `/library` 项目卡片渲染含"进入 / 下载 v1"
  - `/api/projects/<id>/v1/download` HTTP 200, 2284 字节
  - `/p/<id>` 包含 `feedback-input` + `submit-feedback`（viewer 反馈表单）
  - 提交反馈后 v2 产生，`latestVersion:2, count:2`

> 三轮需求串联起来最终形成当前架构：**v1 = 模板即时（库页落点） → v2+ = AI 改写（viewer 反馈）**。

### Turn D（前一次会话）：拉仓库 + PDF 导出

- 需求：「拉取 `webapp-8082-poster-generator` 仓库代码，部署到项目根（保留平台文件）并启动，验证原有 PDF 海报功能」
- 落地：仓库代码覆盖到项目根（`server.js` / `static/` / `run_claude.js` / `start.sh`），平台文件（`user_start.sh`、`systemreadme.md`、`AGENTS.md` 等）保留
- PDF 侧历史修复（见 `commit.txt`）：
  - `b2bf06f` 从 headless chromium 切到 pdfkit（修复"下载成 .txt"）
  - `1070c3c` 去掉 chromium 默认页脚（URL/页码/日期）
  - `3fdec44` 分页布局：标题 + 首段合一，之后每段独占一页
  - `f498bce` 段内图文强制同页
  - `30c5be8` CJK 标点感知换行，消除孤字成行
- 依赖：`pdfkit`、`pdf-parse`；字体 `fonts/NotoSansCJKsc-{Regular,Bold}.otf` 随仓库携带

### Turn E（本次会话）：新增「导出 DOCX」

- 需求：在原有 PDF 海报功能之上，新增「下载为 DOCX」
- 实现：
  - `server.js` 新增 `GET /api/projects/{id}/v{n}/docx`
  - `buildDocxBuffer()` 复用 `parseTemplateSections()`，分页规则与 PDF 对齐（标题 + 首段在第 1 页，之后每段 `pageBreakBefore`）
  - 中文字体：`DOCX_FONT` 统一写 `Microsoft YaHei` 的 `w:ascii / w:eastAsia / w:hAnsi / w:cs`
  - 图片尺寸：`imageDimensions()` 解 PNG IHDR 与 JPEG SOF 原始像素，`fitImageBox()` 等比缩放进 600×640
  - WebP 等 docx 不支持的格式 → 退化为灰色占位文字，不报错
  - 前端 `static/app.js` 库卡片加「导出 DOCX」按钮
  - 新增 `tests/docx-e2e.js` + `npm run test:docx`（16 项校验）
- 验证：
  - `npm run test:pdf` → 1/1 PASS（9/9 项）
  - `npm run test:docx` → 3/3 PASS（各 16/16 项），含中文标题、2 张图内嵌、`w:eastAsia` 存在、`.jpg`/`.png` 两种媒体类型均正确声明
  - 未知项目 / 未知版本 → 404；PDF 路径未受影响（200）
