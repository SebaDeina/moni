#!/usr/bin/env bash
# Despliega Moni en el VPS: actualiza el repo y reconstruye el contenedor.
# Primera vez: crear /opt/moni/.env en el VPS a partir de .env.example.
# Uso: VPS=root@<ip> LLAVE=~/.ssh/<llave> REPO=https://github.com/<usuario>/moni.git deploy/deploy.sh
set -euo pipefail
: "${VPS:?Falta VPS, por ejemplo root@1.2.3.4}"
: "${REPO:?Falta REPO, la URL del repo en GitHub}"
LLAVE="${LLAVE:-$HOME/.ssh/id_ed25519}"
DIR="${DIR:-/opt/moni}"
BRANCH="${BRANCH:-main}"
SSH=(ssh -o ConnectTimeout=20 -i "$LLAVE" "$VPS")

echo "▸ Actualizando el código en $VPS:$DIR"
"${SSH[@]}" "set -e
  if [ ! -d '$DIR/.git' ]; then git clone --branch '$BRANCH' '$REPO' '$DIR'; fi
  cd '$DIR' && git fetch origin '$BRANCH' && git reset --hard 'origin/$BRANCH'
  [ -f .env ] || { echo 'Falta $DIR/.env: copiá .env.example y completalo'; exit 1; }"

echo "▸ Reconstruyendo el contenedor"
"${SSH[@]}" "cd '$DIR' && docker compose up -d --build && docker compose ps"

echo "▸ Verificando"
"${SSH[@]}" "cd '$DIR'; P=\$(grep -E '^HOST_PORT=' .env | cut -d= -f2); P=\${P:-3000}
  for i in \$(seq 1 20); do curl -fsS http://127.0.0.1:\$P/health && exit 0; sleep 1; done
  docker compose logs --tail 50; exit 1"
echo
echo "Listo."
