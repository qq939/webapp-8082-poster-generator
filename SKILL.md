---
name: picturetext-web-app-8082
description: 开发、测试、排障与维护容器内 8082 端口 PictureText 图文 Web App（图文对话 + 图库 + /ask/claude + /ask/image）。涉及 server.js 扩展、user_start.sh 启动脚本、日志规范、端到端测试与 Git 提交。
---

# SKILL — PictureText 图文 Web App（8082）开发与运维

## 适用场景

在容器 `19091-picturetext` 内开发 / 维护 `/home/agent/.claude/workspace/project` 这个 8082 Web App 时使用。
覆盖：`server.js` 扩展、`user_start.sh` 维护、图文与文本两条 Claude 链路、日志规范、自动化测试、Git 提交。

## 关键事实

- **端口**：固定 `8082`，`server.js` 必须 `listen(8082, '0.0.0.0')`；宿主机侧 `19091`；卡片间调用统一走 `http://dimond.top:19091`
- **项目目录**：`/home/agent/.claude/workspace/project`
- **Claude 唯一入口**：`run_claude.js`（**禁止直接 spawn `claude`**，否则问答不进 `logs/agent_tui.log`）
- **运行环境**：Node.js v20.20.2（仅内置模块，零 npm 依赖）；`claude` CLI 在 `/usr/local/bin/claude`
- **平台惯例**：全部记载在 `systemreadme.md`；技能索引在 `/agent-config/skills/`

---

## 一、必读：平台四条硬约束

| # | 约束 | 违反后果 |
|---|------|----------|
| 1 | Claude 调用全部走 `run_claude.js` | 问答不进 `agent_tui.log`，面板日志为空 |
| 2 | 必备 `/ask/claude` + `/health`，端口 8082 | 其他容器卡片无法与本容器对话 |
| 3 | 项目根是 git 仓库，每次对话后 commit | 面板版本下拉框显示「非Git项目」 |
| 4 | 图文模式：图片写 `project/tmp.png` + `CLAUDE_IMG=1` | 模型收不到图片 |

`run_claude.js` 必传环境变量：

```javascript
ANTHROPIC_DISABLE_PREFLIGHT: '1',   // 跳过预检（否则出现 "Pre-flight check is taking longer than expected" 告警）
CLAUDE_CAPTURE_STDIO: '1',          // 捕获输出
CLAUDE_MSG: Buffer.from(msg).toString('base64'),
CLAUDE_IMG: '<tmp.png 绝对路径>',    // 可选，非空即触发图文模式
```

---

## 二、代码结构地图

| 文件 | 职责 | 改动时的注意点 |
|------|------|----------------|
| `server.js` | 8082 HTTP 服务：路由 + 静态托管 + 图库 + Claude 调用 | 新增路由写在 `route()` 内；业务逻辑抽成 `async` 函数；错误由顶层 `.catch` 兜底 |
| `public/index.html` | 结构 + 所有元素 `id` | 新增控件必须同时更新 `public/app.js` 的 `$('id')`，否则 `test_ui.js` 报错 |
| `public/style.css` | 主题变量 + 布局 | 深色主题变量集中在 `:root`；移动端断点 `≤760px` |
| `public/app.js` | 交互逻辑 | 所有插入 DOM 的文本都要 `escapeHtml`；接口路径变更需同步 `test_ui.js` 校验 |
| `user_start.sh` | 幂等启动 + 健康自检 | **不要加 `setsid`**（会 fork，`$!` 变成假 PID） |
| `test_api.sh` | 31 项端到端接口测试 | 用 stub 替换 `run_claude.js`，`trap EXIT` 恢复 |
| `test_ui.js` | 11 项前端静态一致性测试 | 无浏览器环境的替代方案 |

---

## 三、启动脚本规范（`user_start.sh`）

1. 路径：`/home/agent/.claude/workspace/project/user_start.sh`，容器启动时由 `start.sh` 自动执行（存在且非空）。
2. 必备要素：
   - **幂等**：先探测 `/health`，为 `OK` 直接退出 —— 避免重复执行把正在服务的进程杀掉。
   - 清理：读 `logs/server.pid` 优雅停止 + `pkill -f "node <项目>/server.js"` 兜底。
   - 拉起：`nohup node server.js >> logs/run.log 2>&1 &` + `disown`，`$!` 写 `logs/server.pid`。
   - 自检：最多 30s 轮询 `/health`，结果写 `logs/start.log`。
   - **不要截断 `run.log`**（`> file`），否则历史排障线索丢失。

```bash
#!/bin/bash
set -u
PROJECT_DIR="/home/agent/.claude/workspace/project"
cd "$PROJECT_DIR" || exit 1
mkdir -p logs uploads
health() { curl -sf --max-time 2 http://127.0.0.1:8082/health 2>/dev/null || true; }
[ "$(health)" = "OK" ] && { echo "already running" >> logs/start.log; exit 0; }
pkill -f "node $PROJECT_DIR/server.js" 2>/dev/null && sleep 1 || true
nohup node "$PROJECT_DIR/server.js" >> logs/run.log 2>&1 &
echo $! > logs/server.pid
disown
```

---

## 四、图文链路（核心业务）

```
浏览器/调用方
  │  POST /ask/image  {prompt, image(dataURL), name}
  ▼
server.js
  ├─ decodeImagePayload()  拆 data URL / 裸 base64
  ├─ saveImage()           清洗文件名 → uploads/<name>（10 MiB 上限 + sha256）
  ├─ copyFile → tmp.png    ← 平台要求：图文模式图片必须落在 project/tmp.png
  └─ callClaude(prompt, {imagePath: TMP_IMG})   CLAUDE_IMG=<tmp.png>
  ▼
run_claude.js（唯一入口）
  ├─ message += "\n\n![image](file:///…/tmp.png)"
  ├─ spawn claude --permission-mode bypassPermissions --continue --print -
  └─ 追加 logs/agent_tui.log
  ▼
返回 {ok:true, answer, image}
```

**临时图片参数** `?image=<uploads 文件名>` 同样会被 copy 到 `tmp.png`，方便其他容器卡片复用图库图片做图文问答。

---

## 五、编码识别规则（`/ask/claude` 的 `q`）

| 条件 | 处理 |
|------|------|
| `q` 含空白字符 **或** 长度 < 50 | `decodeURIComponent(q)` 当普通文本 |
| 其他 | 按 base64 解码；若解出 `\uFFFD` 替换字符则回退 URL 解码 |

⚠️ **踩坑**：长文本走 base64 时必须对 base64 结果**再做 URL 编码**，否则 `+` 会被 `URLSearchParams` 解析成空格，
触发「含空白 → 当文本」分支，得到乱码。正确写法见 `README.md` 的 curl 示例。

---

## 六、日志规范

| 文件 | 写入方 | 内容 |
|------|--------|------|
| `logs/start.log` | `user_start.sh` | 启停、健康自检结果 |
| `logs/run.log` | `server.js` | 每次 upload / delete / ask 事件 + 启动/退出 |
| `logs/agent_tui.log` | `run_claude.js` | **所有** Claude 问答原文与输出（面板据此下载日志） |
| `logs/commit.txt` | 提交时追加 | `{短hash} {标题}` |
| `logs/agent_tui.summary.md` | 会话结束时更新 | `agent_tui.log` 摘要 + 项目结构 + 最后 3 轮对话 |

---

## 七、测试

```bash
cd /home/agent/.claude/workspace/project
bash test_api.sh      # 31 项：探测 / 图文 / 上传 / 图库 / 安全 / 协议（依赖 python3 做 JSON 断言）
node test_ui.js       # 11 项：id 引用、接口实现、资源存在、端点与端口、平台约束
node tests/smoke.js   # 21 项：纯 Node 冒烟（不依赖 python3，无 stub 也不触发真实 Claude）
```

**为什么测试要 stub `run_claude.js`？**
真实 `/ask/claude` 会 spawn `claude --continue`；由于 `--continue` 续接工作目录下最近一次会话，
在 agent 自己测试自己时会产生**嵌套会话递归**（曾实际发生：嵌套会话重复执行 `user_start.sh` 把在跑的服务杀掉）。
因此测试统一用 stub 隔离，并在 `trap EXIT` 中恢复原文件。

**手工冒烟**

```bash
curl -s http://127.0.0.1:8082/health            # OK
curl -s http://127.0.0.1:8082/api/info
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8082/uploads/..%2f..%2frun_claude.js   # 404
```

---

## 八、排障速查

| 现象 | 原因 | 处置 |
|------|------|------|
| `curl: (7) Connection refused` / `/health` 返回 `000` | 服务未运行或被 kill | `./user_start.sh`，看 `logs/run.log` 尾部 |
| `curl: (52) Empty reply from server` | 处理中途进程被终止（常见：别的实例跑了 `user_start.sh` 执行 `pkill`） | 确认 `user_start.sh` 的**幂等健康检查**生效；`logs/start.log` 会记录「停止旧进程 pid=」 |
| `./user_start.sh: cannot execute: required file not found` | 脚本是 **CRLF** 换行，shebang 解析失败 | `tr -d '\r' < user_start.sh > t && mv t user_start.sh && chmod +x user_start.sh` |
| `./user_start.sh: Permission denied` | 丢可执行位（编辑/`mv` 后常见） | `chmod +x user_start.sh` |
| `logs/server.pid` 里的 PID 是假的 | 用了 `setsid`（fork 后 `$!` 是父进程） | 去掉 `setsid`，用 `nohup ... & echo $!` |
| `/ask/claude` 返回乱码 | base64 未 URL 编码，`+` 变空格 | 见「五、编码识别规则」 |
| 面板「非Git项目」 | 未 `git init` 或未设身份 | `git config --local user.name/user.email` + `git init` |
| `Please tell me who you are` | 无 git 身份 | 同上，用 `--local` |

---

## 九、Git 提交规范

```bash
cd /home/agent/.claude/workspace/project
git config user.name "hermit-agent"          # 容器默认无身份，不设会 commit 失败
git config user.email "agent@hermit.local"
[ -d .git ] || { git init; git add -A; git commit -m "Initial commit"; }

git add -A && git commit -m "描述本次变更"
echo "$(git rev-parse --short HEAD) 描述本次变更" >> logs/commit.txt
```

`.gitignore` 至少包含：`logs/ node_modules/ .DS_Store __pycache__/ *.log .env uploads/ dist/ build/`

---

## 十、扩展指引

- **加一个业务 API**：在 `server.js` 的 `route()` 里加分支 → 抽成 `async function` → 更新 `README.md` 端点表 →
  若前端要调用，在 `app.js` 里 `fetch('/api/xxx')`（`test_ui.js` 会自动校验该端点已在 `server.js` 实现）。
- **让别的容器调用本容器**：注册到 19081 Hub（`POST http://host.docker.internal:19081/api/tools`），
  `name` 用容器名派生（`19091-picturetext` → `picturetext`），`port` 填宿主机端口 `19091`，
  `doc_md` 必须含功能概览 + 端点表 + curl 示例 + `/ask/claude`。
- **改端口**：只改 `server.js` 的 `PORT` 与 `user_start.sh` 的 `PORT`，并同步 `test_api.sh` 的 `B` 变量。
