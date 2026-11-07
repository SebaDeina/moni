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
| `contracts/` | Contrato `MoniVault` (Foundry): bóveda con agenda, tope semanal y verificación KUMPLY. | Avalanche |

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

## Contrato: MoniVault

Bóveda on-chain de Moni (`contracts/src/MoniVault.sol`). Cada usuario guarda AVAX o tokens ERC-20 (USDC) y paga solo a contactos de su agenda, con un tope semanal que cumple el contrato, no el backend: aunque el agente o el servidor se equivoquen, no sale más de lo permitido.

- `pay(token, to, amount, memo)`: paga a un contacto, dentro del tope, y emite `Paid` con el memo.
- `setContact`, `setWeeklyLimit` (0 = sin tope), `setRequireVerifiedRecipients` (solo destinatarios con KYC de KUMPLY, nivel 2 o 3).
- Las semanas empiezan el lunes 00:00 hora de Buenos Aires, igual que `weekly_outflow`.
- `address(0)` representa AVAX.

| Red | Dirección | Verificado |
|---|---|---|
| Fuji (43113) | [`0x12162801e91af889e4a147a4c3a9a255bf6629c2`](https://testnet.snowtrace.io/address/0x12162801e91af889e4a147a4c3a9a255bf6629c2) | ✅ Snowtrace |

Usa el AttestationStore de KUMPLY en Fuji (`0xa3Bc5564A18e107807aF41fF2a5215Db050b22dD`). Las atestaciones de Fuji son de demo, sin verificación de identidad real.

```bash
cd contracts
forge install foundry-rs/forge-std --no-git   # una sola vez
forge test
# Desplegar y verificar en Fuji (clave con AVAX de prueba):
forge script script/DeployMoniVault.s.sol --rpc-url fuji --private-key $DEPLOYER_KEY --broadcast --verify
```

## Correr en local

Requiere Node 22.13 o más nuevo.

```bash
cp .env.example .env   # completar las claves
npm install
npm run dev            # http://localhost:3000/health
```

Para recibir el webhook de Kapso en local, exponer el puerto con un túnel HTTPS (por ejemplo `cloudflared tunnel --url http://localhost:3000`) y configurar `https://<túnel>/webhooks/kapso` en Kapso.

## Producción

Corre en **https://moni.nimbodata.com**, en un VPS compartido con otros servicios.

**Cada push a `main` se despliega solo** (`.github/workflows/deploy.yml`). El VPS baja el commit con una llave de solo lectura, valida el `docker-compose.yml`, reconstruye el contenedor y chequea `/health`.

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
