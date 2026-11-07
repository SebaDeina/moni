#!/usr/bin/env bash
# Despliega Moni en el VPS: sube el último commit (git archive, sirve con el repo privado)
# y reconstruye el contenedor. El .env del VPS no se toca.
# Primera vez: crear $DIR/.env en el VPS a partir de .env.example.
# Uso: VPS=root@<ip> LLAVE=~/.ssh/<llave> deploy/deploy.sh
set -euo pipefail
: "${VPS:?Falta VPS, por ejemplo root@1.2.3.4}"
LLAVE="${LLAVE:-$HOME/.ssh/id_ed25519}"
DIR="${DIR:-/opt/moni}"
cd "$(dirname "$0")/.."
SSH=(ssh -o ConnectTimeout=20 -i "$LLAVE" "$VPS")

[ -z "$(git status --porcelain)" ] || echo "⚠ Hay cambios sin commitear: se sube el último commit, no tu copia local."

echo "▸ Subiendo $(git rev-parse --short HEAD) a $VPS:$DIR"
"${SSH[@]}" "mkdir -p '$DIR' && find '$DIR' -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} +"
git archive --format=tar HEAD | "${SSH[@]}" "tar -x -C '$DIR'"
"${SSH[@]}" "[ -f '$DIR/.env' ] || { echo 'Falta $DIR/.env: copiá .env.example y completalo'; exit 1; }"

echo "▸ Reconstruyendo el contenedor"
"${SSH[@]}" "cd '$DIR' && docker compose up -d --build && docker compose ps"

echo "▸ Verificando"
"${SSH[@]}" "cd '$DIR'; P=\$(grep -E '^HOST_PORT=' .env | cut -d= -f2); P=\${P:-3000}
  for i in \$(seq 1 30); do curl -fsS http://127.0.0.1:\$P/health && exit 0; sleep 1; done
  docker compose logs --tail 50; exit 1"
echo
echo "Listo."
