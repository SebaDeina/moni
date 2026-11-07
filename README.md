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

## WhatsApp con Kapso

1. En Kapso, el webhook del número apunta a `https://moni.nimbodata.com/webhooks/kapso`, con el evento `whatsapp.message.received` y un `secret_key` igual a `KAPSO_WEBHOOK_SECRET`.
2. Sin `KAPSO_WEBHOOK_SECRET` el webhook responde 503, y con firma inválida responde 401.
3. Los audios usan la transcripción que manda Kapso. Si no viene, Moni baja el audio y lo transcribe con xAI (`grok-voice-transcribe-2.0`).
4. Para probar en local sin claves reales hay un mock de Kapso, del LLM y del STT; ver el historial de este README o pedirlo.

## Producción

Corre en **https://moni.nimbodata.com**, en un VPS compartido con otros servicios.

**El deploy es manual**: un push a `main` no cambia producción hasta que Seba despliega, con `deploy/moni.sh deploy` o con el botón *Run workflow* de la Action `Deploy` en GitHub. El VPS baja `main` con una llave de solo lectura, valida el `docker-compose.yml`, reconstruye el contenedor y chequea `/health`.

Para desarrollar, cada uno prueba en local (`npm run dev`) y hace push a `main`.

### Comandos

Con tu llave pública autorizada en el VPS (pedírsela a Seba):

```bash
deploy/moni.sh status        # commit desplegado y contenedores
deploy/moni.sh logs 200      # últimas líneas de logs
deploy/moni.sh deploy        # redeploy de main sin hacer push
deploy/moni.sh deploy <sha>  # volver a un commit anterior de main
deploy/moni.sh restart       # reiniciar sin reconstruir
```

La llave no da shell: solo acepta esos comandos.

### Qué se puede cambiar desde el repo

El `Dockerfile` y el `docker-compose.yml` son del repo, pero como el VPS es compartido, cada deploy los valida (`deploy/server/moni-validate-compose`). Se permite:

- Servicios nuevos (por ejemplo una base de datos) con `build` dentro del repo o una `image`.
- Volúmenes **con nombre** y `tmpfs`.
- Puertos publicados solo en `127.0.0.1`, dentro del rango **3970-3979**. Caddy publica el 3970 en `moni.nimbodata.com`.
- `env_file: .env`.

No se permite: carpetas del servidor como volumen, `privileged`, `network_mode`, `cap_add`, puertos públicos, archivos fuera del repo, ni `RUN --network`/`--security` en el Dockerfile. Si hace falta algo de eso, se habla con Seba.

### Variables de entorno

El `.env` de producción vive solo en el VPS (`/opt/moni/.env`) y no se toca en los deploys. Para cambiar una variable, pedírselo a Seba. Un commit que incluya un `.env` se rechaza.

### Instalación de la puerta (una sola vez, como root)

Los scripts de `deploy/server/` se instalan a mano en `/usr/local/sbin`; cambiarlos en el repo no cambia el VPS.

```bash
bash deploy/server/install.sh                    # usuario moni-deploy, sudoers, scripts
bash deploy/server/install.sh add-key llave.pub  # autorizar una llave
```

## Qué se construyó durante el evento

Todo el código de este repositorio se escribió el 7 de noviembre de 2026, durante la hackathon. El historial de commits lo muestra.
