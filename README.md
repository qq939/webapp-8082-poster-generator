# PictureText · 图文 Web App（端口 8082）

容器 `19091-picturetext` 的主项目。一个**零第三方依赖**的图文对话应用：把图片和问题一起丢进去，
由平台唯一的 Claude 入口 `run_claude.js` 处理，返回纯文本结果；同时提供图库管理（上传 / 预览 / 复制链接 / 删除 / 再提问）。

- 项目根：`/home/agent/.claude/workspace/project`
- 服务端口：容器内 `8082`（`0.0.0.0`），宿主机侧 `19091`
- 运行环境：Node.js v20+（仅内置模块）；`claude` CLI 位于 `/usr/local/bin/claude`
- 当前版本：`v1.0.0`
- 会话日志摘要：[`logs/agent_tui.summary.md`](logs/agent_tui.summary.md)

---

## 功能概览

- 🖼️ **图文对话**：上传图片 + 提问 → 写入 `tmp.png` → 以 `CLAUDE_IMG` 触发 `run_claude.js` 图文模式 → 返回回答
- 📎 **三种入图方式**：点击选择 / 拖拽到输入框 / `Ctrl+V` 直接粘贴截图
- 💬 **纯文本问答**：不传图时走 `GET /ask/claude?q=...`，自动按平台规则识别 URL 编码与 base64
- 🗂️ **图库管理**：网格列表、按文件名过滤、点击大图预览、复制绝对链接、删除、「用它提问」一键回填
- 📝 **轻量 Markdown 渲染**：围栏代码块 / 行内代码 / 粗体，全部经 HTML 转义（防 XSS）
- 🩺 **实时健康灯**：前端每 30s 轮询 `/health`，左栏状态实时反映服务可用性
- 🔒 **安全**：文件名清洗（拒绝 `..` 与路径穿越）、静态目录前缀白名单、10 MiB 单图上限、`sha256` 指纹
- 🪶 **零依赖**：后端只用 Node 内置 `http/fs/path/crypto/child_process`，无 `npm install`

---

## 快速开始

```bash
cd /home/agent/.claude/workspace/project
chmod +x user_start.sh
./user_start.sh                 # 幂等启动：已在运行则直接跳过，并写 logs/start.log
curl http://localhost:8082/health   # -> OK
```

浏览器打开 <http://localhost:8082/> 即可使用。容器重启时由 `start.sh → user_start.sh` 自动拉起。

---

## API 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/health` | 健康检查，返回纯文本 `OK` |
| GET/POST | `/ask/claude?q=<问题>` | 文本问答（平台必备）。`q` 含空白或长度 < 50 → URL 解码；否则 base64 解码 |
| GET | `/ask/claude?q=<问题>&image=<文件名>` | 用 `uploads/` 中的图片做图文问答 |
| POST | `/ask/image` | 图文问答。JSON：`{"prompt":"...","image":"data:image/png;base64,...","name":"x.png"}` |
| POST | `/api/upload?name=<文件名>` | 上传图片（`Content-Type: image/*`，`--data-binary` 原始二进制） |
| POST | `/api/upload` | 上传图片（JSON：`{"name":"x","mime":"image/png","data":"<base64>"}`，无扩展名时按 mime 自动补） |
| GET | `/api/images` | 图片列表（`name/size/uploaded_at/url`，按时间倒序） |
| DELETE | `/api/images/<文件名>` | 删除图片 |
| GET | `/uploads/<文件名>` | 原图访问 |
| GET | `/api/info` | 应用元信息（版本、图片数、端点清单） |
| GET | `/`、`/style.css`、`/app.js` | Web UI 静态资源 |

统一响应约定：成功 `200`；参数错误 `400`；找不到 `404`；方法不允许 `405`；图片过大 `413`；
Claude 调用失败 `500`（返回 stderr 原文）。JSON 接口失败时返回 `{"ok":false,"error":"..."}`。

### curl 示例

```bash
# 健康检查
curl http://localhost:8082/health

# 文本问答（普通字符串）
curl "http://localhost:8082/ask/claude?q=你好，请介绍一下自己"

# 文本问答（长内容用 base64，且必须再做 URL 编码，避免 '+' 被解析成空格）
Q=$(printf '请总结这张图的用途' | base64 -w0)
curl "http://localhost:8082/ask/claude?q=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$Q")"

# 上传图片
curl -X POST --data-binary @cat.png "http://localhost:8082/api/upload?name=cat.png"

# 图文问答（上传后再提问）
curl "http://localhost:8082/ask/claude?q=$(python3 -c "import urllib.parse;print(urllib.parse.quote('描述 这张图'))")&image=cat.png"

# 图文问答（一步到位）
B=$(base64 -w0 cat.png)
curl -X POST -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"提取图中所有文字\",\"image\":\"data:image/png;base64,$B\",\"name\":\"cat.png\"}" \
  http://localhost:8082/ask/image

# 图库
curl http://localhost:8082/api/images
curl -X DELETE http://localhost:8082/api/images/cat.png
```

---

## 测试

```bash
cd /home/agent/.claude/workspace/project
bash test_api.sh      # 端到端接口测试（31 项，PASS=31 FAIL=0）
node test_ui.js       # 前端静态一致性测试（11 项，PASS=11 FAIL=0）
node tests/smoke.js   # 纯 Node 冒烟测试（21 项，21 通过 / 0 失败，无需 python3）
```

`test_api.sh` 会在测试期间用 stub 临时替换 `run_claude.js`（隔离真实 Claude 调用，避免嵌套会话），
并用 `trap EXIT` 保证任何情况下恢复原文件。

> 容器内没有浏览器/Playwright，因此 UI 采用静态交叉校验（id 引用、接口实现、资源存在性、必备端点与端口）替代点击测试。

---

## 目录结构

```
project/
├── server.js                后端（8082，零依赖）
├── public/
│   ├── index.html           三栏布局：左导航 + 对话/图库主区
│   ├── style.css            深色主题、响应式
│   └── app.js               对话渲染、图片入图、图库交互
├── user_start.sh            启动脚本（幂等；日志 → logs/start.log）
├── test_api.sh              接口测试（31 项）
├── test_ui.js               前端静态测试（11 项）
├── tests/smoke.js           纯 Node 冒烟测试（21 项）
├── README.md / SKILL.md     文档
├── logs/                    agent_tui.log · start.log · run.log · commit.txt
├── uploads/                 运行时图库（git 忽略）
├── tmp.png                  图文模式中转图（git 忽略）
└── tools/                   平台工具集（email / github / hub / obs / obs-video）
```

---

## 部署与运维

- **启动**：`./user_start.sh`（幂等：`/health` 为 `OK` 时直接跳过，不会杀掉正在服务的进程）
- **日志**：
  - `logs/start.log` —— 启动脚本日志
  - `logs/run.log` —— 应用运行日志
  - `logs/agent_tui.log` —— Claude 会话日志（由 `run_claude.js` 写入）
- **停止**：`kill "$(cat logs/server.pid)"`（服务收到 SIGTERM 会优雅退出）
- **Git**：每次对话后 `git add -A && git commit`，并把短 hash + 标题追加到 `logs/commit.txt`

---

## 设计约束（来自 `systemreadme.md`）

1. 所有 Claude 调用**必须**经 `run_claude.js`，不得直接调 `claude` CLI——否则问答不进 `agent_tui.log`。
2. 必须提供 `/ask/claude` 与 `/health`，内部端口固定 `8082`。
3. 项目根必须是 git 仓库，且每次对话后提交。
4. 图片走 `project/tmp.png` + `CLAUDE_IMG`，不使用 base64 内联给模型。
5. 注册到 19081 Hub 时需自报真实接口（含 `/ask/claude`）。

---

## 版本历史

| 版本 | 变更 |
|------|------|
| v1.0.0 | 首次交付：图文对话 + 图库 + `/ask/image` + 零依赖后端 + 幂等启动脚本 + 42 项自动化测试 |
