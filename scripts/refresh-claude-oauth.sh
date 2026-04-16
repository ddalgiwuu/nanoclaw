#!/bin/bash
# Auto-refresh Claude OAuth token before it expires
# Runs claude CLI which triggers internal token refresh and updates Keychain

TOKEN_INFO=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
if [ -z "$TOKEN_INFO" ]; then
  echo "$(date): No credentials in Keychain"
  exit 1
fi

EXPIRES_AT=$(echo "$TOKEN_INFO" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('claudeAiOauth',{}).get('expiresAt',0))" 2>/dev/null)
NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
REMAINING_MS=$((EXPIRES_AT - NOW_MS))
REMAINING_MIN=$((REMAINING_MS / 60000))

# Only refresh if less than 2 hours remaining
if [ "$REMAINING_MIN" -gt 120 ]; then
  echo "$(date): Token still valid (${REMAINING_MIN}m remaining), skipping"
  exit 0
fi

echo "$(date): Token expiring in ${REMAINING_MIN}m, refreshing..."

# Running any claude command triggers internal OAuth refresh
OUTPUT=$(echo "ok" | claude --print -p "reply ok" 2>&1)
CLAUDE_EXIT=$?

# Check Keychain state after claude call
NEW_EXPIRES=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('claudeAiOauth',{}).get('expiresAt',0))" 2>/dev/null)
NEW_REMAINING=$((($NEW_EXPIRES - $(python3 -c "import time; print(int(time.time()*1000))")) / 60000))

# Detect auth failure: exit code non-zero, OR output contains 401/auth error, OR new token still expired
if [ $CLAUDE_EXIT -ne 0 ] \
   || echo "$OUTPUT" | grep -qiE "401|authentication_error|Invalid authentication|Failed to authenticate" \
   || [ "$NEW_REMAINING" -le 0 ]; then
  echo "$(date): Refresh FAILED (exit=$CLAUDE_EXIT, new_remaining=${NEW_REMAINING}m)"
  echo "$(date): Output: $(echo "$OUTPUT" | head -c 300)"
  echo "$(date): ACTION REQUIRED: Run 'claude auth login' to re-authenticate"
  # Send a Discord alert via NanoClaw alerts channel
  ALERT_MSG="🚨 Claude OAuth refresh failed at $(date). Run 'claude auth login' in terminal to fix."
  echo "$ALERT_MSG" > /Users/ryan/.nanoclaw/runtime/auth-failure-alert.txt 2>/dev/null || true
  exit 1
fi

if true; then
  echo "$(date): Token refreshed (new expiry: ${NEW_REMAINING}m)"

  # Restart NanoClaw to pick up new token
  # Get PIDs before restart to ensure clean shutdown (prevent duplicate instances)
  OLD_CLAUDE_PID=$(launchctl list com.nanoclaw-discord-claude 2>/dev/null | grep '"PID"' | grep -o '[0-9]*')
  OLD_CODEX_PID=$(launchctl list com.nanoclaw-discord-codex 2>/dev/null | grep '"PID"' | grep -o '[0-9]*')

  launchctl kickstart -k gui/$(id -u)/com.nanoclaw-discord-claude 2>/dev/null
  launchctl kickstart -k gui/$(id -u)/com.nanoclaw-discord-codex 2>/dev/null

  # Wait for old processes to fully exit (up to 10s)
  for i in $(seq 1 20); do
    STILL_RUNNING=0
    [ -n "$OLD_CLAUDE_PID" ] && kill -0 "$OLD_CLAUDE_PID" 2>/dev/null && STILL_RUNNING=1
    [ -n "$OLD_CODEX_PID" ] && kill -0 "$OLD_CODEX_PID" 2>/dev/null && STILL_RUNNING=1
    [ "$STILL_RUNNING" -eq 0 ] && break
    sleep 0.5
  done

  # Force kill if still hanging
  [ -n "$OLD_CLAUDE_PID" ] && kill -0 "$OLD_CLAUDE_PID" 2>/dev/null && kill -9 "$OLD_CLAUDE_PID" 2>/dev/null && echo "$(date): Force-killed stale Claude process $OLD_CLAUDE_PID"
  [ -n "$OLD_CODEX_PID" ] && kill -0 "$OLD_CODEX_PID" 2>/dev/null && kill -9 "$OLD_CODEX_PID" 2>/dev/null && echo "$(date): Force-killed stale Codex process $OLD_CODEX_PID"

  echo "$(date): NanoClaw restarted with new token"
else
  echo "$(date): Refresh failed: $OUTPUT"
  exit 1
fi
