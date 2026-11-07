# Moni

Billetera en WhatsApp. Le escribís o le mandás un audio, y te dice tu saldo, qué gastaste en la semana o le manda plata a un contacto. Prototipo para la HackaTwin (7 de noviembre de 2026, Digital House, Buenos Aires).

> Prototipo en Avalanche **Fuji (testnet)**. Solo usa AVAX de prueba y una wallet descartable.

## Arquitectura

```
WhatsApp ─▶ Kapso (o Baileys) ─▶ webhook HTTPS ─▶ Node + Hono
                                                  ├─ agent/     Claude (Haiku 5.5) con 4 herramientas cerradas
                                                  ├─ chain/     viem + Avalanche Data API (Fuji, 43113)
                                                  │             └─ gasless.ts  smart accounts + paymaster de 0xGasless
                                                  ├─ confirmations.ts  confirmar / cancelar, fuera del modelo
                                                  └─ db/        SQLite: mensajes, agenda, operaciones
```

| Carpeta | Qué hace | Dueño |
|---|---|---|
| `src/whatsapp/` | Recibe y manda mensajes. `kapso.ts` y `baileys.ts` implementan la misma interfaz (`types.ts`). | WhatsApp + LLM |
| `src/agent/` | Loop del LLM, herramientas y transcripción de audios. | WhatsApp + LLM |
| `src/chain/` | Saldo, historial, salidas de la semana y envíos sin gas (0xGasless + MoniVault) en Fuji. | Avalanche |
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

- El modelo nunca firma. Proponer una transferencia la deja pendiente; Moni pregunta "¿Confirmás?" con botones de WhatsApp (✅ Confirmar / Cancelar). También se puede responder "sí", "dale", "ok" o "no". El backend ejecuta.
- La confirmación es del remitente (solo desde su WhatsApp), aplica **solo al último pedido pendiente**, vence a los 2 minutos y se consume una sola vez. "No" o Cancelar lo cancela. El formato anterior `SI <código>` sigue funcionando.
- Se manda a un contacto de la agenda (nombre exacto; un nombre ambiguo no alcanza) o a una dirección `0x` completa. El modelo no puede inventar ni completar direcciones.
- Antes de proponer se chequea el saldo (el gas lo cubre Moni). El hash de la userOp se guarda apenas el bundler la acepta, y la operación pasa de `proposed` a `confirmed` en un solo UPDATE, así un reintento no manda dos veces.
- El pago pasa por `MoniVault.pay`: la agenda y el tope semanal los aplica el contrato.
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

## Web

- **Landing**: `https://moni.nimbodata.com` (`public/index.html`).
- **Plataforma**: `https://moni.nimbodata.com/app` (`public/app/index.html` + `public/assets/app.js`). Muestra saldo, wallet, contrato, actividad y agenda.
- **Login con un mensaje**: *Entrar* (en la landing o en `/app`) abre WhatsApp con "Entrar a Moni: 123456" ya escrito (`/api/auth/whatsapp/go`). El usuario lo manda y la página que lo pidió entra sola: la reconoce por una cookie, y el número sale del mensaje de WhatsApp. El código vence en 5 minutos y sirve una sola vez. La respuesta de Moni trae el link a `/app` por si el usuario vuelve al navegador desde el celular. La primera vez (sin wallet), Moni le crea la wallet con el saldo de bienvenida antes de habilitar la web y le contesta con una bienvenida que explica qué puede hacer desde el chat (`src/web/welcome.ts`).
- **Login con código (alternativa)**: el número de WhatsApp y un código de 6 dígitos que llega por WhatsApp (vence en 5 minutos, máximo 3 pedidos cada 10 minutos y 5 intentos).
- **Envíos desde la web**: la web propone y la confirmación llega por WhatsApp con botones, con las mismas reglas que el chat (`prepareTransfer` en `src/operations.ts`).
- **API**: `src/web/api.ts` (`/api/public`, `/api/auth/*`, `/api/me`, `/api/me/activity`, `/api/transfers`).
- Diseño según el brand book (`brand/marca.html`): Azul Moni sobre papel, Geist y Geist Mono, logo generado con la misma grilla.
- Prueba: `npm run e2e:web` (landing, login, panel, envío confirmado por WhatsApp).

Un mismo usuario es el mismo número en WhatsApp y en la web: los celulares argentinos se guardan sin el 9 (`src/phone.ts`).

## Gas sin costo para el usuario (0xGasless)

El usuario nunca necesita AVAX para el gas (`src/chain/gasless.ts`):

- Cada wallet opera con una smart account de 0xGasless (`@0xgasless/smart-account-sdk`, EntryPoint v0.6) con los contratos de Fuji: factory `0xF0b3f5146c2725e36d78F5029bc560eDfc67ADe0` y módulo ECDSA `0xcfb0BA514aa398085D63eC70cfEa6EC7f1094E8F`. La firma la clave custodiada por Moni.
- Un envío es **una sola userOp** con las llamadas a MoniVault: para AVAX `depositNative(monto)`; para USDC `approve` + `deposit(USDC, monto)`; después `setContact(destino)` (solo la primera vez) y `pay(token, destino, monto, "Moni")`. Es atómica: si el contrato rechaza el pago, el depósito también se revierte.
- Con `OXGASLESS_API_KEY`, el paymaster de 0xGasless (modo `SPONSORED`) paga el gas y el bundler la manda a la red. La primera userOp además despliega la smart account.
- Sin la clave (respaldo, `SPONSOR_GAS=true`): la smart account paga su propio gas y la tesorería se lo recarga antes de cada envío. Para el usuario es igual: nunca paga gas.
- Los envíos de una smart account se ven en el explorador como transacciones internas. El historial junta las nativas y las internas y, con el evento `Paid` de MoniVault, muestra a la persona del otro lado. Los avisos de depósito también leen `Paid`.

### Bonus 0xGasless: evidencia en Fuji

**Componente:** paymaster ERC-4337 de 0xGasless (modo `SPONSORED`) + smart account por usuario (`@0xgasless/smart-account-sdk`).
**Por qué:** es parte del flujo principal (nivel *Core*). El usuario de Moni nunca necesita AVAX: manda dólares desde WhatsApp y el gas de cada envío lo paga el paymaster.

- **Envío real de Moni patrocinado** (1 USDC por MoniVault, 7/11 16:44): [tx `0x0051…6a8e`](https://testnet.snowtrace.io/tx/0x00514ac9c6b4b81dda7b526a3bfad63e07f1262482c08f0e3fe4316b5d756a8e). En el recibo, el evento `UserOperationEvent` del EntryPoint muestra el paymaster `0xC68dAd686FCae526db286d84E1fC8aDDc7B2FE98` (gas pagado: 0,0005 AVAX, por 0xGasless) y MoniVault emite `Paid(…, 1 USDC, memo "Moni")`.
- **Primera userOp de una cuenta nueva (con despliegue), patrocinada:** [tx `0x5263…81ae`](https://testnet.snowtrace.io/tx/0x52630885971ff4441af39d9c67dc17a47a01916f54c2c3466cdbc6d33dac81ae).
- Si el paymaster no patrocina (por ejemplo, sin créditos: devuelve `AA33`), Moni manda la misma userOp sin paymaster y la tesorería le recarga el gas a la cuenta; el usuario tampoco paga. Las cuentas se despliegan al crearse, así el paymaster patrocina desde el primer envío.

Variables: `OXGASLESS_API_KEY` (la clave del paymaster de Fuji), y opcionales `OXGASLESS_BUNDLER_URL` y `OXGASLESS_PAYMASTER_URL`. Pruebas contra Fuji (`scripts/gasless-smoke.ts`):

- `--self-paid`: el mismo envío de Moni pero sin paymaster (la smart account paga su gas). Prueba bundler, despliegue de la cuenta, pago por MoniVault y lectura de la actividad. Corrida del 7/11: [despliegue + depósito + `setContact` + `pay` en una userOp](https://testnet.snowtrace.io/tx/0x5ad4f48dc7efd9ecf529b2f2a0275707c87d5f21fda307afd7dbc16ade469324), desde la smart account [`0xf26D…97C3`](https://testnet.snowtrace.io/address/0xf26D273ce87d1cC117299B02c830b0d22a2397C3).
- Sin flag: userOp patrocinada por el paymaster. Necesita `OXGASLESS_API_KEY`.

## Por qué Avalanche

### Finalidad en 1 o 2 segundos

- En Avalanche, un bloque aceptado por los validadores ya no se revierte: tarda 1 o 2 segundos y no hay una confirmación provisoria antes de la definitiva.
- Cuando Moni contesta "Listo ✅", el pago ya es irreversible.
- En las L2 de Ethereum, como Base o Arbitrum, la confirmación rápida la da un único servidor, el sequencer, que opera una empresa. La confirmación definitiva llega recién cuando Ethereum finaliza el lote, unos 15 minutos después.
- Si el sequencer se cae, esa red se detiene. En Avalanche no hay un operador único del que dependa.
- El bundler de 0xGasless puede demorar un envío, pero no revertirlo. Además, se puede reemplazar por otro, porque ERC-4337 es un estándar.
- En las pruebas en Fuji, un envío completo tardó entre 6 y 12 segundos.

### Una red propia con reglas a medida (Avalanche L1)

- Moni puede tener su propia blockchain compatible con Ethereum, con sus propios validadores.
- Las reglas se definen al configurar la red, no hace falta programar un nodo:
  - `TxAllowList`: solo pueden transaccionar las cuentas verificadas con KUMPLY.
  - `ContractDeployerAllowList`: controla quién despliega contratos.
  - `FeeManager`: fees fijos y predecibles.
  - Gas en un token propio, por ejemplo una stablecoin.
- La verificación KUMPLY pasa del contrato a la red misma.
- La red sigue conectada con la C-Chain y con otros L1 por mensajería nativa (Avalanche Interchain Messaging).
- Hacer esto en otra red implica construir y operar la infraestructura por separado; en Avalanche es configuración.
- **Estado:** todavía no está implementado. Es el próximo paso después del prototipo.

## Agenda

Cada usuario tiene su agenda (tabla `contacts`, por número). Además está la agenda compartida de `CONTACTS` en el `.env`, que ven todos y no se puede borrar desde la app.

- **Web**: en la tarjeta *Agenda* de `/app` se agrega (nombre + dirección 0x) y se borra.
- **Chat**: "agendá a Caro: 0x…". Moni propone el contacto y se agrega cuando el usuario confirma con el botón o "sí" (vence en 2 minutos, un solo uso), igual que un envío.
- Solo se puede mandar plata a contactos de la agenda, por su nombre exacto.

## Usuarios

Mientras usemos el sandbox de Kapso, sumar a alguien son dos pasos:

1. En Kapso → WhatsApp → Sandbox → *Sessions* → *Add session*: cargar su número y que mande el código de activación desde su WhatsApp.
2. En el VPS, agregar su número a `ALLOWED_SENDERS` (sin "+", separado por coma) y reiniciar el contenedor.

## Wallets

Cada número tiene su propia wallet en Fuji, custodiada por Moni (`src/wallets.ts`):

- Se crea desde WhatsApp ("crear wallet") o con el botón *Crear mi wallet* de la web. Una sola por número.
- La clave privada se genera en el servidor y se guarda cifrada (AES-256-GCM) con `MONI_WALLET_MASTER_KEY`, que vive solo en el VPS. El número va como dato autenticado del cifrado.
- Esa clave es la dueña de una **smart account de 0xGasless** (ERC-4337). La smart account es la dirección del usuario: ahí está su saldo, y desde ahí envía sin pagar gas.
- La wallet de `WALLET_PRIVATE_KEY` es la **tesorería**: al crear una wallet le manda `WELCOME_AVAX` (0,05 por defecto) a la smart account, como saldo de bienvenida.
- Las wallets creadas antes de 0xGasless se actualizan solas al arrancar: se les calcula la smart account y la EOA le pasa su saldo (USDC y AVAX, una sola vez).
- Monedas: **AVAX** y **USDC** (el USDC de Circle en Fuji, `0x5425890298aed601595a70AB815c96711a31Bc65`, 6 decimales). "Dólares" en el chat es USDC. El gas siempre se paga en AVAX. Topes por envío: 10 AVAX y 100 USDC.
- USDC de prueba: [faucet.circle.com](https://faucet.circle.com), red *Avalanche Fuji*, con la dirección de la wallet.
- Saldo, movimientos, gastos de la semana y envíos usan la wallet de quien escribe. El historial de la red muestra movimientos en AVAX; los envíos en USDC hechos con Moni aparecen como operaciones. "¿Cuál es mi dirección?" la devuelve para compartirla.

## Agente (Claude)

El agente usa el SDK oficial de Anthropic (`@anthropic-ai/sdk`) con `claude-haiku-5-5`, effort `low` y un loop propio de herramientas (máximo 5 vueltas): para un chat con 4 herramientas alcanza, y es rápido y barato. Con Opus 5.5, Opus 5, Sonnet 5.5 o Fable 5.1 se activa además el fallback del servidor (`fallbacks: "default"`), que reintenta con otro modelo si el pedido se declina por una política de seguridad. Se configura con `ANTHROPIC_API_KEY`, `MONI_CLAUDE_MODEL` y `MONI_CLAUDE_EFFORT`.

Si en tu terminal está definida `ANTHROPIC_BASE_URL` (por ejemplo, por otra herramienta), el SDK la usa: sacala antes de correr `npm run dev`.

## WhatsApp con Kapso

1. En Kapso, el webhook del número apunta a `https://moni.nimbodata.com/webhooks/kapso`, con el evento `whatsapp.message.received` y un `secret_key` igual a `KAPSO_WEBHOOK_SECRET`.
2. Sin `KAPSO_WEBHOOK_SECRET` el webhook responde 503, y con firma inválida responde 401.
3. Los audios usan la transcripción que manda Kapso. Si no viene y hay `TRANSCRIBE_API_KEY`, Moni baja el audio y lo transcribe con xAI (`grok-voice-transcribe-2.0`); si no, pide que lo escriban.
4. Para probar en local sin claves reales: `npm run e2e`. Levanta un mock de Kapso, del LLM y del STT y recorre 13 casos (firma, duplicados, transferencia con código, audios, stickers, batch).

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
