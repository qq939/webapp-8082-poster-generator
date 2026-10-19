# 图文 HTML 生成器 (Web App on port 8082)

通过向导模式（单标题 + 多段落图循环）生成图文 HTML，并通过 Claude 多轮迭代改进排版。

## 设计要点

| 阶段 | 触发 | 生成方式 | 目的 |
|---|---|---|---|
| **v1** | 向导点 "完成，生成 v1" | **模板即时生成**（无 AI 调用） | 立即产出可下载的初版 HTML，最快最稳 |
| **v2+** | viewer 侧栏输入修改意见 | **Claude 改写**（带 60s 兜底超时） | 基于反馈调优，得到更美观版本 |
| **reset --hard** | 在旧版本上提交反馈 | 删除 `v_(base+1)..v_latest`，再生成 `v_(base+1)` | 用户语义：基于旧版本重新出发 |

> v1 不调 AI 是有意设计：向导阶段用户更需要"立刻看到结果"，调 AI 不仅慢且在当前容器内 `claude` CLI 经常 hang 死。AI 改造只在有具体意见时才有意义（v2+）。

## 端口

监听 `0.0.0.0:8082`。容器内固定端口，宿主机通过 18081-19999 范围映射访问。

## 启动

```bash
./user_start.sh
```

启动脚本会：
1. 清理之前残留的 `node server.js`、`run_claude.js`、`claude --dangerously` 进程
2. 在后台启动 `node server.js`
3. 启动日志写入 `logs/start.log`，运行日志写入 `logs/run.log`

### 环境变量

- `MOCK_CLAUDE`：设为 `1` 时跳过真实 Claude 调用（v2+ feedback 路径直接走模板回退）
  ```bash
  MOCK_CLAUDE=1 ./user_start.sh
  ```
- `FORCE_TEMPLATE`：(已废弃) 早期用于强制 finalize 走模板；现在 v1 默认就模板

## 路径与存储

- 项目根目录：`/home/agent/.claude/workspace/project`
- 项目数据：`data/projects/<projectId>/`
  - `meta.json`：项目元数据（标题、版本列表、draft、更新时间）
  - `v1.html`、`v2.html`...：各版本的完整 HTML
  - `images/<id>.<ext>`：裁剪后上传到服务的图片
- 日志：`logs/start.log`（启动日志）、`logs/run.log`（运行时日志）、`logs/agent_tui.log`（Claude TUI 会话流水，由系统写入）

## API 一览

| Method | Path | 说明 |
|---|---|---|
| GET | `/` | 向导页面（tab 切换：向导 / 库） |
| GET | `/library` | 库页面 |
| GET | `/p/{projectId}` | viewer 页面（默认最新版本） |
| GET | `/p/{projectId}/v{n}` | viewer 页面（指定版本） |
| GET | `/static/*` | 静态资源 |
| GET | `/api/projects` | 列出所有项目 |
| POST | `/api/projects` | 创建项目（首次进入向导调用） |
| GET | `/api/projects/{id}` | 获取项目元数据 |
| PUT | `/api/projects/{id}/draft` | 保存向导草稿（自动调用） |
| POST | `/api/projects/{id}/finalize` | 完成向导 → 模板生成 v1（**永远不调 AI**） |
| POST | `/api/projects/{id}/images` | 上传图片（dataUrl 形式） |
| GET | `/api/projects/{id}/images/{imageId}` | 获取图片二进制 |
| GET | `/api/projects/{id}/v{n}` | 获取指定版本 HTML（JSON） |
| GET | `/api/projects/{id}/v{n}/download` | 下载指定版本 HTML |
| GET | `/api/projects/{id}/v{n}/pdf` | 导出指定版本为 PDF（pdfkit，纯 JS） |
| GET | `/api/projects/{id}/v{n}/docx` | 导出指定版本为 DOCX（docx 包，纯 JS） |
| POST | `/api/projects/{id}/feedback` | 基于指定版本提交反馈，AI 生成下一版本 |

## 工作流

### 向导流程
1. 顶部卡片填写标题 → 后端创建项目（保存草稿到 `meta.json.draft`）
2. 点 "+ 添加一段" → 上传图片（文件 / 拖拽 / Ctrl+V 粘贴）
3. 裁剪：缩放（10%-400%）+ 拖动选区 + 4 角手柄
4. 配文：上方已显示刚裁剪的图片预览
5. 点 "完成此段 ✓" 标记本段完成（缩略图序号变绿、边框变绿）
6. 继续 "+ 添加一段" 或点 "完成，生成 v1"
7. **finalize 永远走模板生成** → 几毫秒内返回 v1
8. 自动跳转到 `/library`，用户在新生成的卡片上选择：
   - **下载 v1**：直接拿 HTML（无需 AI）
   - **导出 PDF**：服务端 pdfkit 渲成 A4 海报 PDF（无需 AI）
   - **导出 DOCX**：服务端 docx 包渲成 Word 文档（无需 AI）
   - **进入**：跳 viewer → 反馈 → AI 生成 v2/v3

### 迭代流程（v2+）
- viewer 侧栏：textarea 输入修改意见，点提交
- 后端走 `run_claude.js` → `claude --dangerously-skip-permissions --continue --print`
- 60 秒超时：超时则 SIGKILL 子进程，回退到 `applyTemplateFeedback()`（在 v1 HTML 上方加一条黄色备注提示修改意见）
- reset --hard：基于旧版本提交 → 删除 `v_(base+1)..v_latest.html` → 调 AI 生成 `v_(base+1)`

### 下载与导出
- `GET /api/projects/{id}/v{n}/download` 返回带 `Content-Disposition` 头的 HTML 文件，文件名包含标题与版本号（URL 编码 UTF-8）
- `GET /api/projects/{id}/v{n}/pdf` → A4 海报 PDF（pdfkit）。标题 + 首段在第 1 页，之后每段独占一页，段内「文字在上、图片在下」不跨页
- `GET /api/projects/{id}/v{n}/docx` → Word 文档（`docx` 包）。分页规则与 PDF 一致；正文与标题统一指定 `Microsoft YaHei`（`w:eastAsia`）保证中文不乱码

### PDF / DOCX 导出实现要点
- 两者都先 `rewriteImagesToDataUri()` 把图片内联，再交给 `parseTemplateSections()` 解析出 `{ text, imageBytes, imageExt }`
- 中文字体：PDF 用 `fonts/NotoSansCJKsc-{Regular,Bold}.otf`（pdfkit 嵌入）；DOCX 不嵌字体，只写字体名
- CJK 换行：PDF 走 `wrapCjkText()`（标点感知，避免孤字成行）；DOCX 交给 Word 自己排版
- 图片尺寸：DOCX 用 `imageDimensions()` 读 PNG IHDR / JPEG SOF 拿原始像素，再按 `fitImageBox()` 等比缩放到 600×640 以内

## 关键技术点

- **图片裁剪**：纯前端 canvas 计算
  - `<img>` 上叠加可拖拽 div（4 个圆角手柄）
  - 缩放：slider 改变 `transform: scale(...)` 同时保持裁剪中心点稳定
  - 提交时通过 canvas 重新采样原图，生成 jpeg dataUrl 上传
- **缩略图进度条**：每个段落以卡片形式展示状态（绿色序号 / 当前编辑 / 待编辑），点击跳转；当前段卡片右上角有红色 × 删除按钮（二次确认后删除该段）
- **版本管理**：文件型 git-like 结构，文件名 `v{n}.html`，reset 通过删文件实现
- **v1 模板生成**：`renderTemplateHtml(title, items)` 输出完整 HTML（内嵌 CSS、响应式、现代风格），不依赖外部 AI
- **Claude 调用**：`run_claude.js` 通过 `CLAUDE_MSG`（base64）+ 可选 `CLAUDE_IMG`（base64）传递，统一记录到 `logs/agent_tui.log`
- **沙箱 viewer**：`<iframe sandbox="allow-same-origin">` 渲染用户生成的 HTML，避免影响父页面
- **超时保护**：`CLAUDE_TIMEOUT_MS = 60s`，超时 SIGKILL 子进程 + 进程组，确保 wizard 端不会无限等待

## 项目目录结构

```
/home/agent/.claude/workspace/project/
├── server.js                # 主服务：HTTP 路由 + Claude 编排 + 模板生成 + PDF/DOCX 导出
├── run_claude.js            # 调用 claude CLI 的脚本（系统注入）
├── user_start.sh            # 启动脚本（端口 8082，日志写 logs/start.log）
├── start.sh                 # 容器系统脚本
├── package.json             # 依赖：pdfkit / docx / pdf-parse / fflate
├── fonts/                   # Noto Sans CJK（PDF 中文字体，随仓库携带）
│   ├── NotoSansCJKsc-Regular.otf
│   └── NotoSansCJKsc-Bold.otf
├── tests/
│   ├── pdf-e2e.js           # PDF 导出端到端校验（npm run test:pdf）
│   └── docx-e2e.js          # DOCX 导出端到端校验（npm run test:docx）
├── generate-a4-landscape.cjs # 独立脚本：离线生成 A4 横版海报 PDF 样例
├── static/
│   ├── style.css            # 向导 + 库 tab 样式
│   ├── app.js               # 向导 + 库 tab 前端逻辑
│   ├── viewer.css           # viewer 页面样式
│   └── viewer.js            # viewer 页面逻辑
├── data/                    # 持久化（运行时生成，不入 git）
│   └── projects/<id>/
│       ├── meta.json
│       ├── v1.html, v2.html, ...
│       └── images/
├── logs/                    # 日志（不入 git）
│   ├── start.log            # 启动日志
│   ├── run.log              # 服务运行日志
│   └── agent_tui.log        # Claude TUI 会话流水
├── README.md                # 本文件
├── SKILL.md                 # 给 Agent 的能力说明
├── AGENTS.md                # 工作区行为准则
├── SOUL.md / USER.md / IDENTITY.md / TOOLS.md / HEARTBEAT.md / BOOTSTRAP.md
├── systemreadme.md          # 容器平台约定（路径、日志、端口、API 规范）
├── commit.txt               # commit 流水（每次会话追加）
├── .gitignore               # 排除 logs/、data/、node_modules/ 等
└── test_sync.txt            # 心跳/同步标记
```

## 已知边界

- 单机进程内存储，不支持多用户/分布式
- Claude 调用最长 60 秒超时（v2+ 路径），超时回退模板
- reset --hard 直接删除磁盘文件，**不可恢复**
- 容器内 `claude` CLI 经常 hang 死，所以 v1 设计为永远不调 AI；v2+ 也已有 60s 兜底
- DOCX 不支持 WebP；遇到不支持的图片格式会退化成一行灰色占位文字
- DOCX 只写字体名不嵌字体，最终观感取决于打开文档的机器是否装了 `Microsoft YaHei`

## 测试

```bash
# 离线测试（不调真实 Claude；v2+ 反馈也走模板回退）
MOCK_CLAUDE=1 ./user_start.sh

# 真实模式（v1 仍模板；v2+ 走 AI 路径）
./user_start.sh

# 健康检查
curl http://localhost:8082/health
# → OK

# PDF 导出端到端校验（对库里每个项目的最新版本校验 9 项）
npm run test:pdf

# DOCX 导出端到端校验（校验 MIME/魔数/OOXML 结构/图片内嵌/字体，共 16 项）
npm run test:docx

# 手动下载
curl -o v1.pdf  http://localhost:8082/api/projects/<PID>/v1/pdf
curl -o v1.docx http://localhost:8082/api/projects/<PID>/v1/docx
```
