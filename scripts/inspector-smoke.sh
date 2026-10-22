#!/usr/bin/env bash
# Calls every MCP tool through the official MCP Inspector CLI.
#   npm run sim  (other terminal)   then   bash scripts/inspector-smoke.sh
# Against a real deployment:  MCP_URL=https://mcp.example.com/mcp MCP_TOKEN=... bash scripts/inspector-smoke.sh
# (on a real server it places a LIMIT ~300 pips away, amends and cancels it; market steps only run with SMOKE_MARKET=1)
set -euo pipefail
URL="${MCP_URL:-http://127.0.0.1:8788/mcp}"
TOKEN="${MCP_TOKEN:-sim-token-sim-token-sim-token-sim-token}"
RUN="smoke-$(date +%s)"
pass=0; fail=0

call() { # name [k=v ...] -> prints JSON of the first text content, sets $OUT
  local name=$1; shift
  local args=(); for a in "$@"; do args+=(--tool-arg "$a"); done
  local raw
  raw=$(npx -y @modelcontextprotocol/inspector --cli "$URL" --transport http --header "Authorization: Bearer $TOKEN" \
        --method tools/call --tool-name "$name" "${args[@]}" 2>&1) || true
  OUT=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);process.stdout.write((r.isError?"ERR ":"OK  ")+r.content[0].text)}catch{process.stdout.write("ERR "+s.slice(0,300))}})' <<<"$raw")
  printf '%-22s %s\n' "$name" "${OUT:0:220}"
}
expect_ok()  { if [[ $OUT == OK* ]]; then pass=$((pass+1)); else fail=$((fail+1)); echo "   ^ expected OK"; fi; }
expect_err() { if [[ $OUT == ERR* ]]; then pass=$((pass+1)); else fail=$((fail+1)); echo "   ^ expected a rejection"; fi; }
field() { node -e "const o=JSON.parse(process.argv[1].slice(4));console.log($2)" "$OUT"; }

call get_account; expect_ok
call get_symbol_info symbol=EURUSD; expect_ok
BID=$(field x 'o.bid')
call get_candles symbol=EURUSD timeframe=H1 count=5; expect_ok
call get_smc_context symbol=EURUSD; expect_ok
ENTRY=$(node -e "console.log((+process.argv[1]-0.03).toFixed(5))" "$BID")
SL=$(node -e "console.log((+process.argv[1]-0.002).toFixed(5))" "$ENTRY")
TP=$(node -e "console.log((+process.argv[1]+0.004).toFixed(5))" "$ENTRY")
call preview_order symbol=EURUSD side=BUY orderType=LIMIT entry="$ENTRY" stopLoss="$SL" takeProfit="$TP"; expect_ok
call preview_order symbol=EURUSD side=BUY orderType=LIMIT entry="$ENTRY" stopLoss="$SL" takeProfit="$ENTRY"; expect_err
call place_limit_order symbol=EURUSD side=BUY entry="$ENTRY" stopLoss="$SL" takeProfit="$TP" \
  thesis="Inspector smoke test: far limit, amended and cancelled immediately." setup=smoke idempotencyKey="$RUN-place"; expect_ok
ORDER=$(field x 'o.order.orderId')
call get_orders; expect_ok
call amend_order orderId="$ORDER" stopLoss="$(node -e "console.log((+process.argv[1]-0.0025).toFixed(5))" "$ENTRY")" \
  takeProfit="$(node -e "console.log((+process.argv[1]+0.005).toFixed(5))" "$ENTRY")" reason="smoke amend" idempotencyKey="$RUN-amend"; expect_ok
call cancel_order orderId="$ORDER" reason="smoke cleanup" idempotencyKey="$RUN-cancel"; expect_ok

if [[ "$URL" == *127.0.0.1:8788* || "${SMOKE_MARKET:-0}" == 1 ]]; then
  ASK=$(node -e "console.log((+process.argv[1]+0.00008).toFixed(5))" "$BID")
  call place_market_order symbol=EURUSD side=BUY stopLoss="$(node -e "console.log((+process.argv[1]-0.002).toFixed(5))" "$ASK")" \
    takeProfit="$(node -e "console.log((+process.argv[1]+0.004).toFixed(5))" "$ASK")" \
    thesis="Inspector smoke test: market order, managed and closed." setup=smoke idempotencyKey="$RUN-mkt"; expect_ok
  POS=$(field x 'o.position.positionId'); POS_TP=$(field x 'o.position.takeProfit'); POS_ENTRY=$(field x 'o.position.entry')
  call get_positions; expect_ok
  call amend_position_sl_tp positionId="$POS" stopLoss="$(node -e "console.log((+process.argv[1]-0.001).toFixed(5))" "$POS_ENTRY")" \
    takeProfit="$POS_TP" reason="tighten stop" idempotencyKey="$RUN-sltp"; expect_ok
  call close_position positionId="$POS" units=10000 reason="smoke partial close" idempotencyKey="$RUN-part"; expect_ok
  call close_position positionId="$POS" reason="smoke final close" idempotencyKey="$RUN-close"; expect_ok
fi
sleep 1
call get_journal limit=3 includeThesis=false; expect_ok
call get_performance; expect_ok
echo; echo "passed: $pass  failed: $fail"
[[ $fail == 0 ]]
