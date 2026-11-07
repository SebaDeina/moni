#!/usr/bin/env bash
# Habla con la puerta de Moni en el VPS (necesita tu llave pública autorizada).
# Uso: deploy/moni.sh deploy [sha] | logs [líneas] | status | restart
# Otra llave: MONI_KEY=~/.ssh/otra deploy/moni.sh logs 100
set -euo pipefail
[ $# -ge 1 ] || { sed -n 3p "$0"; exit 2; }
exec ssh ${MONI_KEY:+-i "$MONI_KEY"} "moni-deploy@${MONI_HOST:-moni.nimbodata.com}" "$*"
