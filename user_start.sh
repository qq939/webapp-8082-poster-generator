#!/bin/bash
# ===== 图文 HTML 生成器 · 启动脚本（端口 8082）=====
# 平台约定（systemreadme.md / skill hermit-paths、hermit-logging）：
#   - 由容器 start.sh 自动执行（存在且非空）
#   - 启动日志 → logs/start.log；应用日志 → logs/run.log
#   - 端口固定 8082
#
# ⚠️ 安全约束：**不要** kill `run_claude.js` / `claude` 进程 ——
#    容器内 agent 会话本身就挂在 `run_claude.js` 上，误杀会导致面板失联。
#    本脚本只清理本项目的 `node server.js`。
set -u

PROJECT_DIR="/home/agent/.claude/workspace/project"
LOG_DIR="${PROJECT_DIR}/logs"
START_LOG="${LOG_DIR}/start.log"
RUN_LOG="${LOG_DIR}/run.log"
PID_FILE="${LOG_DIR}/server.pid"
PORT=8082

cd "${PROJECT_DIR}" || exit 1
mkdir -p "${LOG_DIR}" data/projects

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${START_LOG}"; }
health() { curl -sf --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null || true; }

log "===== 图文 HTML 生成器 启动检查 (port ${PORT}, MOCK_CLAUDE=${MOCK_CLAUDE:-0}) ====="

# --- 0. 幂等：已在运行则直接返回（避免把正在服务的进程杀掉）---
if [ "$(health)" = "OK" ]; then
    log "服务已在运行（GET /health -> OK），跳过启动。"
    exit 0
fi

# --- 1. 清理残留的本项目 server.js ---
if [ -f "${PID_FILE}" ]; then
    OLD_PID="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [ -n "${OLD_PID}" ] && kill -0 "${OLD_PID}" 2>/dev/null; then
        log "停止旧进程 pid=${OLD_PID}"
        kill "${OLD_PID}" 2>/dev/null || true
        sleep 1
        kill -9 "${OLD_PID}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
fi
pkill -f "node ${PROJECT_DIR}/server.js" 2>/dev/null && sleep 1 || true

# --- 2. 后台拉起 server.js ---
export MOCK_CLAUDE="${MOCK_CLAUDE:-0}"
log "运行日志: ${RUN_LOG}（MOCK_CLAUDE=${MOCK_CLAUDE}）"
nohup node "${PROJECT_DIR}/server.js" >> "${RUN_LOG}" 2>&1 &
NODE_PID=$!
disown "${NODE_PID}" 2>/dev/null || true
echo "${NODE_PID}" > "${PID_FILE}"
log "已启动 server.js pid=${NODE_PID}"

# --- 3. /health 自检 ---
HEALTH=""
for i in $(seq 1 30); do
    HEALTH="$(health)"
    if [ "${HEALTH}" = "OK" ]; then break; fi
    sleep 1
done

if [ "${HEALTH}" = "OK" ]; then
    log "健康检查通过: GET /health -> OK (${i}s)"
    log "Web UI: http://localhost:${PORT}/"
else
    log "健康检查失败（30s 超时），最近日志："
    tail -n 20 "${RUN_LOG}" 2>/dev/null | sed 's/^/    /' | tee -a "${START_LOG}"
fi

log "===== 启动脚本结束（服务在后台持续运行）====="
exit 0
