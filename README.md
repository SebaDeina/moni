# Moni

Billetera en WhatsApp. Le escribís o le mandás un audio, y te dice tu saldo, qué gastaste en la semana o le manda plata a un contacto. Prototipo para la HackaTwin (7 de noviembre de 2026, Digital House, Buenos Aires).

> Prototipo en Avalanche **Fuji (testnet)**. Solo usa AVAX de prueba y una wallet descartable.

## Arquitectura

```
WhatsApp ─▶ Kapso (o Baileys) ─▶ webhook HTTPS ─▶ Node + Hono
                                                  ├─ agent/     LLM con 4 herramientas cerradas
                                                  ├─ chain/     viem + Avalanche Data API (Fuji, 43113)
                                                  ├─ confirmations.ts  "SI <código>", fuera del modelo
                                                  └─ db/        SQLite: mensajes, agenda, operaciones
```

| Carpeta | Qué hace | Dueño |
|---|---|---|
| `src/whatsapp/` | Recibe y manda mensajes. `kapso.ts` y `baileys.ts` implementan la misma interfaz (`types.ts`). | WhatsApp + LLM |
| `src/agent/` | Loop del LLM, herramientas y transcripción de audios. | WhatsApp + LLM |
| `src/chain/` | Saldo, historial, salidas de la semana y envío de AVAX en Fuji. | Avalanche |
| `src/confirmations.ts` | Códigos de confirmación: vencen a los 2 minutos y se consumen una sola vez. | Compartido |
| `src/db/` | Esquema SQLite. | Compartido |

Cada parte solo habla con las otras a través de las funciones exportadas, así se puede trabajar en paralelo. Las tareas pendientes están marcadas con `TODO(whatsapp)` y `TODO(avalanche)`.

### Herramientas del agente

1. `get_balance()`: saldo de la wallet.
2. `list_transactions({ period })`: historial.
3. `weekly_outflow()`: valor enviado y gas pagado desde el lunes, hora de Buenos Aires, por separado.
4. `propose_native_transfer({ alias, amountAvax })`: prepara la transferencia, **no firma**.

### Seguridad de las transferencias

- El modelo nunca firma. Proponer una transferencia genera un código; el usuario responde `SI <código>` y el backend la ejecuta.
- El código queda atado al remitente y a la operación, vence a los 2 minutos y se consume una sola vez.
- Solo se puede mandar a alias de la agenda precargada. Un alias ambiguo no alcanza para enviar.
- Antes de firmar se chequean saldo y gas. Nonce y hash se guardan antes de transmitir, para que un reintento no mande dos veces.
- Montos siempre en wei con `bigint`.

## Correr en local

Requiere Node 22.13 o más nuevo.

```bash
cp .env.example .env   # completar las claves
npm install
npm run dev            # http://localhost:3000/health
```

Para recibir el webhook de Kapso en local, exponer el puerto con un túnel HTTPS (por ejemplo `cloudflared tunnel --url http://localhost:3000`) y configurar `https://<túnel>/webhooks/kapso` en Kapso.

## Deploy en el VPS

En el VPS hace falta Docker con el plugin `compose`, y un proxy con HTTPS (Caddy) apuntando a `127.0.0.1:3000`.

El script sube el último commit por SSH (no hace falta que el VPS tenga acceso al repo privado) y reconstruye el contenedor.

Primera vez, en el VPS: crear `/opt/moni/.env` a partir de `.env.example`.

Después, desde tu máquina:

```bash
VPS=root@<ip> LLAVE=~/.ssh/<llave> deploy/deploy.sh
```

Ejemplo de bloque de Caddy:

```
moni.<tu-dominio> {
  reverse_proxy 127.0.0.1:3000
}
```

## Qué se construyó durante el evento

Todo el código de este repositorio se escribió el 7 de noviembre de 2026, durante la hackathon. El historial de commits lo muestra.
