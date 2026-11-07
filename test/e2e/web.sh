#!/usr/bin/env bash
# Prueba de la web contra el mock: landing, login por WhatsApp, panel y envío confirmado por WhatsApp.
# Uso: npm run e2e:web
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
SECRET=test-secret; APP=http://localhost:3917; MOCK=http://localhost:3998
DB="${TMPDIR:-/tmp}/moni-web-e2e.db"; JAR="${TMPDIR:-/tmp}/moni-web-e2e.cookies"
DB="${DB%.db}-$$.db"; JAR="${JAR}-$$"

node "$HERE/mock.mjs" > "${TMPDIR:-/tmp}/moni-web-mock.log" 2>&1 &
MOCK_PID=$!
( cd "$REPO" && PORT=3917 DATABASE_PATH="$DB" KAPSO_WEBHOOK_SECRET=$SECRET KAPSO_API_KEY=test-key \
  KAPSO_PHONE_NUMBER_ID=999 KAPSO_API_BASE=$MOCK ANTHROPIC_API_KEY=claude-key ANTHROPIC_BASE_URL=$MOCK \
  MONI_WALLET_MASTER_KEY=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff WALLET_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d FUJI_RPC_URL=$MOCK/rpc \
  ALLOWED_SENDERS=541100000000 MONI_WHATSAPP_NUMBER="+56 9 2040 3095" \
  CONTACTS="juan=0x1111111111111111111111111111111111111111,caro=0x2222222222222222222222222222222222222222" \
  npx tsx src/index.ts > "${TMPDIR:-/tmp}/moni-web-app.log" 2>&1 ) &
APP_PID=$!
trap 'kill $APP_PID $MOCK_PID 2>/dev/null; pkill -f "tsx src/index.ts" 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s $APP/health >/dev/null && break; sleep 0.5; done

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
last_wa() { curl -s $MOCK/_sent | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const s=JSON.parse(d).sent.at(-1);console.log((s?.to??"")+" ← "+(s?.text?.body??""))})'; }
j() { curl -s -b "$JAR" -c "$JAR" -H 'content-type: application/json' "$@"; }

echo "1. Landing / → $(code $APP/)   /app → $(code $APP/app)   /assets/app.js → $(code $APP/assets/app.js)   logo → $(code $APP/assets/moni-mark.svg)"
echo "2. /api/public → $(curl -s $APP/api/public)"
echo "3. /api/me sin sesión → $(code $APP/api/me)"
echo "4. Pido código para un número no habilitado → $(j -X POST $APP/api/auth/request -d '{"phone":"54 11 9999 9999"}')"
echo "5. Pido código con el 9 (+54 9 11 0000 0000) → $(j -X POST $APP/api/auth/request -d '{"phone":"+54 9 11 0000 0000"}')"
echo "   WhatsApp: $(last_wa)"
LOGIN=$(curl -s $MOCK/_sent | grep -o 'es [0-9]\{6\}' | tail -1 | cut -d' ' -f2)
echo "6. Código incorrecto → $(j -X POST $APP/api/auth/verify -d '{"phone":"541100000000","code":"000000"}')"
VERIFY=$(printf '{"phone":"541100000000","code":"%s"}' "$LOGIN")
echo "7. Código correcto → $(j -X POST $APP/api/auth/verify -d "$VERIFY")"
echo "8. Reuso el código → $(j -X POST $APP/api/auth/verify -d "$VERIFY")"
echo "8b. /api/me sin wallet → $(j $APP/api/me | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const m=JSON.parse(d);console.log("wallet:",m.wallet,"| saldo:",m.balance)})')"
echo "8c. Creo la wallet → $(j -X POST $APP/api/wallet | cut -c1-230)"
echo "8d. Creo otra vez → $(j -X POST $APP/api/wallet | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const m=JSON.parse(d);console.log("created:",m.created)})')"
echo "9. /api/me → $(j $APP/api/me)"
echo "9a. Agrego a lola → $(j -X POST $APP/api/contacts -d '{"alias":"Lola","address":"0x5555555555555555555555555555555555555555"}')"
echo "9b. Agrego a lola otra vez → $(j -X POST $APP/api/contacts -d '{"alias":"lola","address":"0x5555555555555555555555555555555555555555"}')"
echo "9c. Dirección inválida → $(j -X POST $APP/api/contacts -d '{"alias":"rafa","address":"0x123"}')"
echo "9d. Borro a juan (compartido) → $(j -X DELETE $APP/api/contacts/juan)"
echo "9e. Agenda → $(j $APP/api/me | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).contacts.map(c=>c.alias+(c.shared?"*":"")).join(", ")))')"
echo "9f. Borro a lola → $(j -X DELETE $APP/api/contacts/lola)   agenda: $(j $APP/api/me | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).contacts.map(c=>c.alias).join(", ")))')"
echo "10. Envío a alguien fuera de la agenda → $(j -X POST $APP/api/transfers -d '{"alias":"pedro","amount":"1"}')"
echo "11. Envío por encima del tope → $(j -X POST $APP/api/transfers -d '{"alias":"caro","amount":"50"}')"
echo "12. Envío de 0,5 a caro → $(j -X POST $APP/api/transfers -d '{"alias":"caro","amount":"0,5"}')"
echo "    WhatsApp: $(last_wa)"
CONFIRM=$(curl -s $MOCK/_sent | grep -o 'SI [0-9]\{6\}' | tail -1 | cut -d' ' -f2)
BODY="{\"message\":{\"id\":\"wweb1\",\"type\":\"text\",\"from\":\"5491100000000\",\"text\":{\"body\":\"SI $CONFIRM\"},\"kapso\":{\"direction\":\"inbound\"}},\"phone_number_id\":\"999\"}"
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')
echo "13. Confirmo por WhatsApp desde 549… → $(curl -s -o /dev/null -w '%{http_code}' -X POST $APP/webhooks/kapso -H 'content-type: application/json' -H 'x-webhook-event: whatsapp.message.received' -H "x-webhook-signature: $SIG" --data-binary "$BODY")"
sleep 1.5; echo "    WhatsApp: $(last_wa)"
echo "14. Actividad → $(j "$APP/api/me/activity?period=week")"
echo "15. Salir → $(j -X POST $APP/api/auth/logout)   /api/me después → $(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" $APP/api/me)"
echo "--- errores en el log"; grep -iE "error|warn" "${TMPDIR:-/tmp}/moni-web-app.log" | grep -v ExperimentalWarning | head -5
