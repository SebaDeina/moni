#!/usr/bin/env bash
# Prueba de punta a punta de Moni contra un mock de Kapso, el LLM y el STT. Uso: npm run e2e
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SECRET=test-secret; APP=http://localhost:3917; MOCK=http://localhost:3998
rm -f "${TMPDIR:-/tmp}/moni-e2e.db"*

node "$HERE/mock.mjs" > "${TMPDIR:-/tmp}/moni-e2e-mock.log" 2>&1 &
MOCK_PID=$!
( cd "$REPO" && PORT=3917 DATABASE_PATH="${TMPDIR:-/tmp}/moni-e2e.db" KAPSO_WEBHOOK_SECRET=$SECRET KAPSO_API_KEY=test-key \
  KAPSO_PHONE_NUMBER_ID=999 KAPSO_API_BASE=$MOCK ANTHROPIC_API_KEY=claude-key ANTHROPIC_BASE_URL=$MOCK \
  TRANSCRIBE_API_KEY=stt-key TRANSCRIBE_URL=$MOCK/v1/stt CONTACTS="juan=0x1111111111111111111111111111111111111111,maría=0x2222222222222222222222222222222222222222" \
  npx tsx src/index.ts > "${TMPDIR:-/tmp}/moni-e2e-app.log" 2>&1 ) &
APP_PID=$!
trap 'kill $APP_PID $MOCK_PID 2>/dev/null; pkill -f "tsx src/index.ts" 2>/dev/null' EXIT
for i in $(seq 1 20); do curl -s $APP/health >/dev/null && break; sleep 0.5; done

post() { # $1 body, $2 event (opcional), $3 firma (opcional)
  local sig="${3:-$(printf '%s' "$1" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')}"
  curl -s -o /dev/null -w '%{http_code}' -X POST $APP/webhooks/kapso -H 'content-type: application/json' \
    -H "x-webhook-event: ${2:-whatsapp.message.received}" -H "x-webhook-signature: $sig" --data-binary "$1"
}
text_msg() { echo "{\"message\":{\"id\":\"$1\",\"type\":\"text\",\"from\":\"5491100000000\",\"text\":{\"body\":\"$2\"},\"kapso\":{\"direction\":\"inbound\"}},\"conversation\":{\"phone_number\":\"5491100000000\"},\"phone_number_id\":\"999\"}"; }
last_sent() { sleep 1.2; curl -s $MOCK/_sent | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d).sent;console.log(s.length+" | "+(s.at(-1)?.text?.body??"").replace(/\n/g," ⏎ "))})'; }

echo "1. Firma inválida → $(post "$(text_msg w1 hola)" "" deadbeef)"
echo "2. Evento que no es mensaje → $(post '{"message":{}}' whatsapp.message.sent)"
echo "3. Texto 'hola' → $(post "$(text_msg w3 hola)")"; last_sent
echo "4. Mismo webhook repetido → $(post "$(text_msg w3 hola)")"; last_sent
echo "5. 'mandale a juan' → $(post "$(text_msg w5 'mandale 0.1 a juan')")"; last_sent
CODE=$(curl -s $MOCK/_sent | grep -o 'SI [0-9]\{6\}' | tail -1 | cut -d' ' -f2)
echo "6. Confirmo con SI $CODE → $(post "$(text_msg w6 "SI $CODE")")"; last_sent
echo "7. Reuso el mismo código → $(post "$(text_msg w7 "si $CODE")")"; last_sent
echo "8. 'mandale a pedro' (no está en la agenda) → $(post "$(text_msg w8 'mandale 0.1 a pedro')")"; last_sent
echo "9. 'saldo' (chain sin implementar) → $(post "$(text_msg w9 'cuanto saldo tengo')")"; last_sent
AUDIO_T='{"message":{"id":"w10","type":"audio","from":"5491100000000","audio":{"id":"m1"},"kapso":{"direction":"inbound","has_media":true,"transcript":{"text":"hola desde un audio"},"media_url":"http://localhost:3998/media/audio1"}},"phone_number_id":"999"}'
echo "10. Audio con transcripción de Kapso → $(post "$AUDIO_T")"; last_sent
AUDIO_N='{"message":{"id":"w11","type":"audio","from":"5491100000000","audio":{"id":"m2"},"kapso":{"direction":"inbound","has_media":true,"media_url":"http://localhost:3998/media/audio1","media_data":{"content_type":"audio/ogg"}}},"phone_number_id":"999"}'
echo "11. Audio sin transcripción (baja + STT) → $(post "$AUDIO_N")"; last_sent
echo "    STT: $(curl -s $MOCK/_sent | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify(JSON.parse(d).sttCalls)))')"
STICKER='{"message":{"id":"w12","type":"sticker","from":"5491100000000","kapso":{"direction":"inbound"}},"phone_number_id":"999"}'
echo "12. Sticker → $(post "$STICKER")"; last_sent
BATCH="{\"type\":\"whatsapp.message.received\",\"batch\":true,\"data\":[$(text_msg w13 uno),$(text_msg w14 dos)]}"
echo "13. Batch de 2 → $(post "$BATCH")"; sleep 1; last_sent
echo "--- requests a Claude (modelo, beta, fallbacks, effort, roles)"
curl -s $MOCK/_sent | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d).claudeRequests;console.log(r.length+" requests; primera:",JSON.stringify(r[0]));console.log("con historial:",JSON.stringify(r.at(-1).roles))})'
echo "--- operaciones en la base"
sqlite3 "${TMPDIR:-/tmp}/moni-e2e.db" "select to_alias, amount_wei, status, substr(error,1,40) from operations" 2>/dev/null || true
echo "--- errores en el log de la app"
grep -iE "error|warn" "${TMPDIR:-/tmp}/moni-e2e-app.log" | grep -v ExperimentalWarning | head -10
