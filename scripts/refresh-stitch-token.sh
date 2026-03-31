#!/bin/bash
# Refresh Google Stitch MCP token in Claude Code config
# Token expires every ~1 hour, this runs every 50 minutes

PROJECT_ID="spartan-lacing-485211-s0"
CONFIG_FILE="$HOME/.claude.json"

TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "$(date): Failed to get access token" >&2
  exit 1
fi

MCP_URL="https://stitch.googleapis.com/v1beta/projects/${PROJECT_ID}/locations/global/mcpServers/stitch:streamableHttp"

# Update the token in claude.json using jq
if command -v jq &>/dev/null; then
  jq --arg token "Bearer $TOKEN" --arg url "$MCP_URL" \
    '.mcpServers.stitch.headers.Authorization = $token' \
    "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
  echo "$(date): Stitch token refreshed"
else
  # Fallback: re-add via claude CLI
  claude mcp add stitch --transport http "$MCP_URL" \
    --header "Authorization: Bearer $TOKEN" -s user 2>/dev/null
  echo "$(date): Stitch token refreshed (via claude mcp add)"
fi
