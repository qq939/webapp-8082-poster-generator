#!/bin/bash
# ===== PictureText 8082 端到端接口测试 =====
# 用法: bash test_api.sh
# 说明: 测试期间会用 stub 临时替换 run_claude.js（隔离真实 Claude 调用），
#       结束后必定恢复原文件（trap EXIT 保证异常退出也会恢复）。
set -u
cd "$(dirname "$0")" || exit 1

B=http://127.0.0.1:8082
PASS=0; FAIL=0
chk() { # chk <名称> <期望> <实际>
  if [ "$2" = "$3" ]; then echo "PASS  $1"; PASS=$((PASS+1));
  else echo "FAIL  $1  期望[$2] 实际[$3]"; FAIL=$((FAIL+1)); fi
}

if ! curl -sf --max-time 3 "$B/health" > /dev/null; then
  echo "服务未运行，请先执行 ./user_start.sh"; exit 1
fi

cp run_claude.js /tmp/run_claude.js.real
restore() { cp /tmp/run_claude.js.real run_claude.js; rm -f uploads/t1.png uploads/t2.png uploads/dot.png; }
trap restore EXIT

cat > run_claude.js <<'STUB'
const msg = Buffer.from(process.env.CLAUDE_MSG || '', 'base64').toString('utf8');
console.log('STUB_OK img=' + (process.env.CLAUDE_IMG || 'none') +
  ' preflight=' + process.env.ANTHROPIC_DISABLE_PREFLIGHT +
  ' capture=' + process.env.CLAUDE_CAPTURE_STDIO + ' msg=' + msg);
if (msg.indexOf('__FAIL__') >= 0) { console.error('STUB_FAIL'); process.exit(3); }
process.exit(0);
STUB

enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
IMG=$(mktemp /tmp/pt_XXXX.png)
node -e "require('fs').writeFileSync(process.argv[1],Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4EIwDiqkL4KAc0kBQfNl0G6AAAAAElFTkSuQmCC','base64'))" "$IMG"
B64IMG=$(base64 -w0 "$IMG")

# --- /ask/claude：文本（含空格 -> URL 解码分支）---
chk "ask/claude 文本(URL解码)" \
  "STUB_OK img=none preflight=1 capture=1 msg=你好 世界" \
  "$(curl -s "$B/ask/claude?q=$(enc '你好 世界')")"

# --- /ask/claude：文本（长且无空格 -> base64 分支）---
LONG='请用一句话说明这张图片的用途，并给出三个可行的改进建议，谢谢配合。'
chk "ask/claude 文本(base64)" \
  "STUB_OK img=none preflight=1 capture=1 msg=$LONG" \
  "$(curl -s "$B/ask/claude?q=$(enc "$(printf '%s' "$LONG" | base64 -w0)")")"

# --- /ask/claude：图文（?image=<uploads 文件名>）---
curl -s -X POST --data-binary @"$IMG" -H 'Content-Type: image/png' "$B/api/upload?name=dot.png" > /dev/null
chk "ask/claude 图文(?image=)" \
  "STUB_OK img=/home/agent/.claude/workspace/project/tmp.png preflight=1 capture=1 msg=描述 这张图" \
  "$(curl -s "$B/ask/claude?q=$(enc '描述 这张图')&image=dot.png")"
chk "图文模式已写 tmp.png" "yes" "$([ -s tmp.png ] && echo yes || echo no)"

# --- /ask/claude：失败 -> 500 ---
FMSG='__FAIL__ 触发错误：这是一个用于验证错误路径的较长消息，必须超过五十个字符才能进入 base64 解码分支哦。'
chk "ask/claude 失败 -> 500" "500" \
  "$(curl -s -o /tmp/pt_fail.txt -w '%{http_code}' "$B/ask/claude?q=$(enc "$(printf '%s' "$FMSG" | base64 -w0)")")"
chk "ask/claude 失败 body" "STUB_FAIL" "$(cat /tmp/pt_fail.txt)"

# --- /ask/claude：参数校验 ---
chk "ask/claude 缺 q -> 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' "$B/ask/claude")"
chk "ask/claude 空 q -> 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' "$B/ask/claude?q=")"

# --- /ask/image ---
R=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"看图\",\"image\":\"data:image/png;base64,$B64IMG\",\"name\":\"demo.png\"}" "$B/ask/image")
chk "ask/image ok" "true" "$(printf '%s' "$R" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["ok"]).lower())')"
chk "ask/image answer" \
  "STUB_OK img=/home/agent/.claude/workspace/project/tmp.png preflight=1 capture=1 msg=看图" \
  "$(printf '%s' "$R" | python3 -c 'import json,sys;print(json.load(sys.stdin)["answer"])')"
chk "ask/image 无图 -> 400" "400" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"prompt":"x"}' "$B/ask/image")"
chk "ask/image 非法 JSON -> 400" "400" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{bad' "$B/ask/image")"

# --- 基础端点 ---
chk "health" "OK" "$(curl -s "$B/health")"
chk "info.app" "picturetext" "$(curl -s "$B/api/info" | python3 -c 'import json,sys;print(json.load(sys.stdin)["app"])')"

# --- 图库 API ---
chk "upload 原始二进制" "true" \
  "$(curl -s -X POST --data-binary @"$IMG" "$B/api/upload?name=t1.png" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["ok"]).lower())')"
chk "upload JSON base64(补扩展名)" "t2.png" \
  "$(curl -s -X POST -H 'Content-Type: application/json' -d "{\"name\":\"t2\",\"mime\":\"image/png\",\"data\":\"$B64IMG\"}" "$B/api/upload" | python3 -c 'import json,sys;print(json.load(sys.stdin)["image"]["name"])')"
chk "upload 空 body -> 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary '' "$B/api/upload?name=z.png")"
chk "upload 恶意文件名被清洗" "evil_rm_-rf.png" \
  "$(curl -s -X POST --data-binary @"$IMG" "$B/api/upload?name=..%2f..%2fevil%3Brm%20-rf.png" | python3 -c 'import json,sys;print(json.load(sys.stdin)["image"]["name"])')"
chk "images 列表 ok" "true" "$(curl -s "$B/api/images" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["ok"]).lower())')"
chk "取图 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$B/uploads/t1.png")"
chk "取图 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$B/uploads/none.png")"
chk "删除 200" "true" "$(curl -s -X DELETE "$B/api/images/t1.png" | python3 -c 'import json,sys;print(str(json.load(sys.stdin)["ok"]).lower())')"
chk "删除不存在 -> 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$B/api/images/t1.png")"

# --- 静态前端 ---
chk "首页 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$B/")"
chk "首页含标题" "yes" "$(curl -s "$B/" | grep -q 'PictureText' && echo yes || echo no)"
chk "style.css 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$B/style.css")"
chk "app.js 200" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$B/app.js")"

# --- 安全 / 协议 ---
chk "未知路径 -> 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$B/nonexistent")"
chk "路径穿越 -> 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$B/uploads/..%2f..%2frun_claude.js")"
chk "静态穿越 -> 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$B/..%2f..%2frun_claude.js")"
chk "非法方法 -> 405" "405" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$B/api/images")"

rm -f "$IMG"
echo
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" = "0" ]
