#!/usr/bin/env bash
# Replay body.json with fresh session identifiers; do not reuse captured session metadata.
set -euo pipefail
: "${SHAREDCHAT_API_KEY:?set SHAREDCHAT_API_KEY}"
BASE="${SHAREDCHAT_BASE:-https://new.sharedchat.cc/codex/v1}"
SESSION_ID="${SESSION_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}"
TURN_ID="${TURN_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}"
INSTALL_ID="${SHAREDCHAT_INSTALL_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}"
CONTEXT_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
WINDOW_ID="${SESSION_ID}:0"
TURN_METADATA="$(SESSION_ID="$SESSION_ID" TURN_ID="$TURN_ID" INSTALL_ID="$INSTALL_ID" WINDOW_ID="$WINDOW_ID" CONTEXT_ID="$CONTEXT_ID" python3 -c 'import json,os,time; print(json.dumps({"installation_id":os.environ["INSTALL_ID"],"session_id":os.environ["SESSION_ID"],"thread_id":os.environ["SESSION_ID"],"agent_name":"codex-replay","turn_id":os.environ["TURN_ID"],"window_id":os.environ["WINDOW_ID"],"window_number":0,"context_window_id":os.environ["CONTEXT_ID"],"request_kind":"turn","root_turn_id":os.environ["TURN_ID"],"thread_source":"user","turn_trigger":"exec","sandbox":"none","sandbox_mode":"danger-full-access","auto_review_enabled":False,"node_repl_auto_review_required":False,"node_repl_disabled":False,"turn_started_at_unix_ms":int(time.time()*1000),"analytics_enabled":False,"model":os.environ.get("SHAREDCHAT_MODEL","gpt-5.6-sol"),"reasoning_effort":"low"},separators=(",",":")))' )"
curl -sS -m 120 -o out2.txt -w '%{http_code}\n' "${BASE%/}/responses" \
  -H 'x-codex-beta-features: remote_compaction_v2' \
  -H "x-codex-window-id: ${WINDOW_ID}" \
  -H "x-codex-turn-metadata: ${TURN_METADATA}" \
  -H 'x-openai-internal-codex-responses-lite: true' \
  -H "x-client-request-id: ${SESSION_ID}" \
  -H "session-id: ${SESSION_ID}" \
  -H "thread-id: ${SESSION_ID}" \
  -H 'accept: text/event-stream' \
  -H 'content-type: application/json' \
  -H "authorization: Bearer ${SHAREDCHAT_API_KEY}" \
  -H 'originator: codex_exec' \
  -H 'user-agent: codex_exec/0.162.1 (Linux; aarch64) dumb (codex_exec; 0.162.1)' \
  --data-binary @body.json
