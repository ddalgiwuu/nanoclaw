#!/bin/bash
# Auto-refresh browser cookies for NanoClaw cron tasks
# Imports cookies from Chrome for domains used by scheduled tasks
# Run by launchd every 6 hours (cookies typically expire in 24h+)

set -euo pipefail

LOG=~/.nanoclaw/logs/cookie-refresh.log
BROWSE=~/.claude/skills/gstack/browse/dist/browse

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

if [ ! -x "$BROWSE" ]; then
  log "ERROR: browse binary not found at $BROWSE"
  exit 1
fi

# Domains needed by NanoClaw scheduled tasks
DOMAINS=(
  "login.n3rvemusic.com"
  "outlook.office.com"
  "outlook.cloud.microsoft"
  "login.microsoftonline.com"
  "naver.com"
)

IMPORTED=0
FAILED=0

for domain in "${DOMAINS[@]}"; do
  OUTPUT=$("$BROWSE" cookie-import-browser chrome --domain "$domain" 2>&1) || true
  if echo "$OUTPUT" | grep -q "Imported"; then
    COUNT=$(echo "$OUTPUT" | grep -o '[0-9]* cookies' | head -1)
    log "OK: $domain ($COUNT)"
    IMPORTED=$((IMPORTED + 1))
  else
    log "SKIP: $domain (no cookies found or error: $OUTPUT)"
    FAILED=$((FAILED + 1))
  fi
done

log "Done: $IMPORTED imported, $FAILED skipped"
