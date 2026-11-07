#!/usr/bin/env bash
# Instala (o actualiza) la puerta de deploy de Moni en el VPS. Correr como root.
#   install.sh                     instala scripts, usuario y sudoers
#   install.sh add-key <archivo>   autoriza una llave pública (CI o una persona)
# Revertir: userdel -r moni-deploy; rm /etc/sudoers.d/moni-deploy /usr/local/sbin/moni-*
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
USER_NAME=moni-deploy
KEYS="/home/$USER_NAME/.ssh/authorized_keys"

[ "$(id -u)" = 0 ] || { echo "Correr como root" >&2; exit 1; }

if [ "${1:-}" = add-key ]; then
  key="$(cat "$2")"
  [[ "$key" =~ ^ssh-(ed25519|rsa)\  ]] || { echo "No parece una llave pública SSH" >&2; exit 1; }
  grep -qF "$key" "$KEYS" 2>/dev/null && { echo "Ya estaba autorizada"; exit 0; }
  echo "restrict,command=\"/usr/local/sbin/moni-gate-ssh\" $key" >> "$KEYS"
  echo "Llave autorizada: $(echo "$key" | awk '{print $3}')"
  exit 0
fi

install -o root -g root -m 755 "$HERE/moni-gate" "$HERE/moni-gate-ssh" "$HERE/moni-validate-compose" /usr/local/sbin/

id "$USER_NAME" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/sh "$USER_NAME"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 700 "/home/$USER_NAME/.ssh"
touch "$KEYS"
chown "$USER_NAME:$USER_NAME" "$KEYS"
chmod 600 "$KEYS"

sudoers=$(mktemp)
echo "$USER_NAME ALL=(root) NOPASSWD: /usr/local/sbin/moni-gate" > "$sudoers"
visudo -cf "$sudoers" >/dev/null
install -o root -g root -m 440 "$sudoers" /etc/sudoers.d/moni-deploy
rm -f "$sudoers"

echo "Instalado. Autorizá llaves con: $0 add-key <llave.pub>"
