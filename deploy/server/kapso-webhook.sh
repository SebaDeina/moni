#!/usr/bin/env bash
# Registra en Kapso el webhook de Moni, con las claves del .env del VPS (no pasan por ningún chat).
# Correr como root en el VPS: bash deploy/server/kapso-webhook.sh [/opt/moni/.env]
# Docs: https://docs.kapso.ai/docs/whatsapp/receive-messages
set -euo pipefail
ENV_FILE="${1:-/opt/moni/.env}"
get() { grep -E "^$1=" "$ENV_FILE" | cut -d= -f2-; }

KEY=$(get KAPSO_API_KEY); PHONE=$(get KAPSO_PHONE_NUMBER_ID); SECRET=$(get KAPSO_WEBHOOK_SECRET)
for v in KEY PHONE SECRET; do [ -n "${!v}" ] || { echo "Falta $v en $ENV_FILE" >&2; exit 1; }; done

body=$(python3 -c 'import json,sys; print(json.dumps({"whatsapp_webhook": {"url": "https://moni.nimbodata.com/webhooks/kapso", "events": ["whatsapp.message.received"], "secret_key": sys.argv[1]}}))' "$SECRET")

curl -sS -w '\nHTTP %{http_code}\n' -X POST "https://api.kapso.ai/platform/v1/whatsapp/phone_numbers/$PHONE/webhooks" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" --data-binary @- <<<"$body" \
  | python3 -c 'import sys; t=sys.stdin.read(); print(t.replace(sys.argv[1], "***") if sys.argv[1] else t)' "$SECRET"
