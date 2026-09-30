#!/bin/bash
# ===== PictureText 图文 Web App 启动脚本 =====
# 平台约定（systemreadme.md / skill hermit-paths、hermit-logging）：
#   - 由容器 start.sh 自动执行（存在且非空）
#   - 启动日志 → logs/start.log
#   - Web App 运行日志 → logs/run.log
#   - 端口固定 8082
# 幂等：若 8082 已健康，直接跳过，避免重复拉起把正在服务的进程杀掉。
set -u

PROJECT_DIR="/home/agent/.claude/workspace/project"
LOG_DIR="${PROJECT_DIR}/logs"
START_LOG="${LOG_DIR}/start.log"
RUN_LOG="${LOG_DIR}/run.log"
PID_FILE="${LOG_DIR}/server.pid"
PORT=8082

cd "${PROJECT_DIR}" || exit 1
mkdir -p "${LOG_DIR}" uploads

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${START_LOG}"; }

health() { curl -sf --max-time 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null || true; }

log "===== PictureText 启动检查 (port ${PORT}) ====="

# --- 0. 幂等检查：已在运行则直接返回 ---
if [ "$(health)" = "OK" ]; then
    log "服务已在运行（GET /health -> OK），跳过启动。"
    exit 0
fi

# --- 1. 清理残留进程，避免端口冲突 ---
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

# --- 2. 后台拉起 server.js（nohup + disown 持久化；PID 用 $! 精确记录）---
log "运行日志: ${RUN_LOG}"
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
