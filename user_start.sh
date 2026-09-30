#!/bin/bash
cd /home/agent/.claude/workspace/project
mkdir -p logs

# Kill any existing server on 8082
for pid in $(ps auxf | grep "node server.js" | grep -v grep | awk '{print $2}'); do
    kill -9 "$pid" 2>/dev/null
done
# Also kill orphan run_claude.js and claude processes from prior sessions
for pid in $(ps auxf | grep "run_claude.js" | grep -v grep | awk '{print $2}'); do
    kill -9 "$pid" 2>/dev/null
done
for pid in $(ps auxf | grep "claude --dangerously" | grep -v grep | awk '{print $2}'); do
    kill -9 "$pid" 2>/dev/null
done

echo "[$(date)] Starting server on 8082 (MOCK_CLAUDE=${MOCK_CLAUDE:-0})..." >> logs/start.log
export MOCK_CLAUDE=${MOCK_CLAUDE:-0}
nohup env MOCK_CLAUDE=$MOCK_CLAUDE node server.js >> logs/run.log 2>&1 &
echo $! > /tmp/webapp.pid
echo "[$(date)] Started with PID $(cat /tmp/webapp.pid)" >> logs/start.log