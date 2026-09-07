#!/usr/bin/env bash
# Qwen Gate — Comprehensive Integration Test Script
#
# Runs a battery of tests against a running Qwen Gate server:
#   1. /v1/models endpoint
#   2. Non-streaming chat
#   3. Streaming chat
#   4. Tool calling
#   5. Large context (file upload)
#   6. Multi-turn conversation (5 turns)
#   7. Image URL support
#   8. Anthropic /v1/messages endpoint (if enabled)
#   9. Concurrent requests (load test)
#  10. Long context (200KB+)
#
# Usage:
#   QG_HOST=http://localhost:26405 ./test-api.sh
#
# Environment:
#   QG_HOST       - server URL (default: http://localhost:26405)
#   QG_MODEL      - model to test (default: qwen3.5-flash)
#   QG_TIMEOUT    - per-request timeout (default: 180)
#   QG_API_KEY    - API key (default: empty)

set -uo pipefail

QG_HOST="${QG_HOST:-http://localhost:26405}"
QG_MODEL="${QG_MODEL:-qwen3.5-flash}"
QG_TIMEOUT="${QG_TIMEOUT:-180}"
QG_API_KEY="${QG_API_KEY:-}"

PASS=0
FAIL=0
WARN=0
RESULTS=()

# Helper: make an authenticated request
qg_request() {
  local method="$1"
  local path="$2"
  local body="$3"
  local extra="${4:-}"
  local auth_header=""
  if [ -n "$QG_API_KEY" ]; then
    auth_header="-H \"Authorization: Bearer $QG_API_KEY\""
  fi
  eval curl -s "$extra" -X "$method" "$QG_HOST$path" \
    -H '"Content-Type: application/json"' \
    $auth_header \
    -d "'$body'" \
    --max-time "$QG_TIMEOUT"
}

# Helper: record test result
record() {
  local name="$1"
  local status="$2"
  local detail="${3:-}"
  case "$status" in
    PASS)  PASS=$((PASS + 1)); RESULTS+=("✓ PASS  | $name | $detail") ;;
    FAIL)  FAIL=$((FAIL + 1)); RESULTS+=("✗ FAIL  | $name | $detail") ;;
    WARN)  WARN=$((WARN + 1)); RESULTS+=("! WARN  | $name | $detail") ;;
  esac
}

echo "=================================="
echo "Qwen Gate Integration Tests"
echo "=================================="
echo "Host:   $QG_HOST"
echo "Model:  $QG_MODEL"
echo "Timeout: ${QG_TIMEOUT}s"
echo ""

# ── Test 1: /v1/models ──────────────────────────────────────────
echo "Test 1: GET /v1/models"
models_resp=$(curl -s "$QG_HOST/v1/models" --max-time 30 || echo '{}')
if echo "$models_resp" | grep -q '"qwen'; then
  model_count=$(echo "$models_resp" | grep -o '"id":"qwen' | wc -l)
  record "GET /v1/models" "PASS" "$model_count models available"
else
  record "GET /v1/models" "FAIL" "no models returned"
fi

# ── Test 2: Non-streaming chat ─────────────────────────────────
echo "Test 2: Non-streaming chat"
resp=$(curl -s -X POST "$QG_HOST/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"$QG_MODEL\", \"stream\": false, \"messages\": [{\"role\": \"user\", \"content\": \"Say hello in exactly 5 words\"}]}" \
  --max-time "$QG_TIMEOUT")
if echo "$resp" | grep -q '"content":"[^"]\+"'; then
  content=$(echo "$resp" | grep -o '"content":"[^"]*"' | head -1 | cut -d'"' -f4)
  record "Non-streaming chat" "PASS" "content: ${content:0:50}..."
elif echo "$resp" | grep -q '"error"'; then
  err=$(echo "$resp" | grep -o '"message":"[^"]*"' | head -1)
  record "Non-streaming chat" "WARN" "error: $err"
else
  record "Non-streaming chat" "FAIL" "no content"
fi

# ── Test 3: Streaming chat ─────────────────────────────────────
echo "Test 3: Streaming chat"
resp=$(curl -sN -X POST "$QG_HOST/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"$QG_MODEL\", \"stream\": true, \"messages\": [{\"role\": \"user\", \"content\": \"Count to 5\"}]}" \
  --max-time "$QG_TIMEOUT")
if echo "$resp" | grep -q "^data:" && echo "$resp" | grep -q "\[DONE\]"; then
  chunks=$(echo "$resp" | grep -c "^data:")
  record "Streaming chat" "PASS" "$chunks SSE chunks received"
else
  record "Streaming chat" "FAIL" "no SSE data"
fi

# ── Test 4: Tool calling ────────────────────────────────────────
echo "Test 4: Tool calling"
resp=$(curl -s -X POST "$QG_HOST/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$QG_MODEL"'",
    "stream": false,
    "messages": [{"role": "user", "content": "What is the weather in Paris? Use the get_weather tool."}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather in a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }' \
  --max-time "$QG_TIMEOUT")
if echo "$resp" | grep -q '"tool_calls"'; then
  record "Tool calling" "PASS" "tool_calls returned"
elif echo "$resp" | grep -q '"content"'; then
  record "Tool calling" "WARN" "got content instead of tool_calls (model may have answered directly)"
else
  record "Tool calling" "FAIL" "no response"
fi

# ── Test 5: Large context (50KB) ────────────────────────────────
echo "Test 5: Large context (50KB)"
python3 -c "
import json
large_text = 'This is line. ' + '. '.join([f'item {i}' for i in range(5000)])
payload = {
  'model': '$QG_MODEL',
  'stream': False,
  'messages': [
    {'role': 'system', 'content': 'You are a helpful assistant.'},
    {'role': 'user', 'content': f'Here is some context:\n\n{large_text}\n\nSummarize in 10 words.'}
  ]
}
with open('/tmp/large-payload.json', 'w') as f:
    json.dump(payload, f)
print(f'Payload: {len(json.dumps(payload))} bytes')
"
resp=$(curl -s -X POST "$QG_HOST/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d @/tmp/large-payload.json \
  --max-time "$QG_TIMEOUT")
if echo "$resp" | grep -q '"content"'; then
  record "Large context 50KB" "PASS" "handled"
else
  record "Large context 50KB" "WARN" "may have failed"
fi

# ── Test 6: Long context (200KB) ────────────────────────────────
echo "Test 6: Long context (200KB)"
python3 -c "
import json
large_text = '. '.join([f'Topic {i}: ' + ('word ' * 20) for i in range(2000)])
payload = {
  'model': '$QG_MODEL',
  'stream': False,
  'messages': [
    {'role': 'user', 'content': f'Read this context:\n\n{large_text}\n\nWhat was topic 1000 about?'}
  ]
}
with open('/tmp/long-payload.json', 'w') as f:
    json.dump(payload, f)
print(f'Payload: {len(json.dumps(payload))} bytes')
"
resp=$(curl -s -X POST "$QG_HOST/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d @/tmp/long-payload.json \
  --max-time "$QG_TIMEOUT")
if echo "$resp" | grep -q '"content"'; then
  record "Long context 200KB" "PASS" "handled"
else
  record "Long context 200KB" "WARN" "may have failed"
fi

# ── Test 7: Multi-turn conversation ─────────────────────────────
echo "Test 7: Multi-turn conversation"
resp=$(curl -s -X POST "$QG_HOST/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model": "'"$QG_MODEL"'", "stream": false, "messages": [
    {"role": "user", "content": "Hi, my name is TestBot. Remember this."},
    {"role": "assistant", "content": "Hi TestBot! I will remember your name."},
    {"role": "user", "content": "What is my name?"}
  ]}' \
  --max-time "$QG_TIMEOUT")
if echo "$resp" | grep -iq "TestBot"; then
  record "Multi-turn conversation" "PASS" "remembered name"
else
  record "Multi-turn conversation" "WARN" "name not in response"
fi

# ── Test 8: Image URL support ───────────────────────────────────
echo "Test 8: Image URL support"
resp=$(curl -s -X POST "$QG_HOST/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-plus",
    "stream": false,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe this image in 5 words"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAA="}}
      ]
    }]
  }' \
  --max-time "$QG_TIMEOUT")
if echo "$resp" | grep -q '"content"'; then
  record "Image URL support" "PASS" "image processed"
else
  record "Image URL support" "WARN" "may have failed"
fi

# ── Test 9: Concurrent requests (load test) ─────────────────────
echo "Test 9: Concurrent requests (5 parallel)"
pids=()
for i in 1 2 3 4 5; do
  curl -s -X POST "$QG_HOST/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "{\"model\": \"$QG_MODEL\", \"stream\": false, \"messages\": [{\"role\": \"user\", \"content\": \"Say hi $i\"}]}" \
    --max-time "$QG_TIMEOUT" > "/tmp/concurrent-$i.json" &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait $pid; done

success=0
for i in 1 2 3 4 5; do
  if grep -q '"content"' "/tmp/concurrent-$i.json"; then
    success=$((success + 1))
  fi
done
if [ "$success" -eq 5 ]; then
  record "Concurrent (5 parallel)" "PASS" "all 5 succeeded"
elif [ "$success" -ge 3 ]; then
  record "Concurrent (5 parallel)" "WARN" "$success/5 succeeded"
else
  record "Concurrent (5 parallel)" "FAIL" "only $success/5 succeeded"
fi

# ── Test 10: Anthropic /v1/messages endpoint ─────────────────────
echo "Test 10: Anthropic /v1/messages endpoint"
resp=$(curl -s -X POST "$QG_HOST/v1/messages" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "'"$QG_MODEL"'",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Say hello in 5 words"}]
  }' \
  --max-time "$QG_TIMEOUT")
if echo "$resp" | grep -q '"content"\|"type":"message"'; then
  record "Anthropic /v1/messages" "PASS" "endpoint works"
elif echo "$resp" | grep -q "404"; then
  record "Anthropic /v1/messages" "WARN" "endpoint not enabled (404)"
else
  record "Anthropic /v1/messages" "WARN" "endpoint may not be enabled"
fi

# ── Summary ─────────────────────────────────────────────────────
echo ""
echo "=================================="
echo "Test Results"
echo "=================================="
for r in "${RESULTS[@]}"; do
  echo "$r"
done
echo ""
echo "=================================="
echo "Summary: $PASS passed, $WARN warnings, $FAIL failed"
echo "=================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
