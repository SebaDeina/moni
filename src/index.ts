import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { handleUserMessage, type Reply } from "./agent/index.js";
import { canTranscribe, transcribe } from "./agent/transcribe.js";
import { config } from "./config.js";
import { saveIncomingMessage } from "./db/index.js";
import { startDepositWatcher } from "./deposits.js";
import { canonicalPhone } from "./phone.js";
import { deployPendingWallets, upgradeWallets } from "./wallets.js";
import { createApi } from "./web/api.js";
import { claimWaLogin, parseWaLoginMessage } from "./web/auth.js";
import { askConfirmation, whatsapp, type IncomingMessage } from "./whatsapp/index.js";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, whatsapp: whatsapp.name }));

const allowedSenders = new Set(
  (config.ALLOWED_SENDERS ?? "").split(",").map(canonicalPhone).filter(Boolean),
);

async function textFromAudio(msg: IncomingMessage): Promise<string> {
  if (msg.audio?.transcript) return msg.audio.transcript;
  if (!canTranscribe()) return "";
  const audio = await whatsapp.downloadAudio(msg);
  return transcribe(audio.data, audio.mimeType);
}

async function onMessage(msg: IncomingMessage) {
  // El número de respuesta es el que manda WhatsApp; la identidad del usuario, la forma canónica (igual que en la web).
  const user = canonicalPhone(msg.from);
  const body = msg.kind === "other" ? `[${msg.rawType ?? "otro"}]` : msg.text;
  const stored = saveIncomingMessage({ id: msg.id, sender: user, kind: msg.kind === "audio" ? "audio" : "text", body });
  if (!stored) return; // webhook repetido

  if (allowedSenders.size > 0 && !allowedSenders.has(user)) {
    await whatsapp.sendText(msg.from, "Moni está en prueba privada por ahora. ¡Pronto abrimos!");
    return;
  }

  // Lo antes posible: el usuario ve el doble check azul y "escribiendo…" mientras pensamos.
  const started = Date.now();
  whatsapp.markReadAndTyping?.(msg).catch((err) => console.warn("[moni] no pude marcar como leído", String(err).slice(0, 160)));

  // "Entrar a Moni: <código>": el mensaje que arma la web para entrar sin tipear el número.
  const loginCode = msg.kind === "text" ? parseWaLoginMessage(msg.text) : null;
  if (loginCode) {
    const ok = claimWaLogin(user, loginCode);
    await whatsapp.sendText(
      msg.from,
      ok
        ? `Listo, ya entraste a Moni en la web ✅ Volvé al navegador o abrí ${config.PUBLIC_URL}/app\n\nOjo: nunca mandes un código de Moni que te haya pasado otra persona.`
        : `Ese código no sirve o ya venció. Pedí uno nuevo en ${config.PUBLIC_URL}/app`,
    );
    return;
  }

  if (msg.kind === "other") {
    await whatsapp.sendText(msg.from, "Por ahora entiendo mensajes de texto y audios.");
    return;
  }

  let reply: Reply;
  try {
    if (msg.kind === "audio") {
      const heard = await textFromAudio(msg);
      if (!heard) {
        await whatsapp.sendText(msg.from, "No llegué a entender el audio. ¿Me lo mandás de nuevo o por escrito?");
        return;
      }
      reply = await handleUserMessage(user, heard);
    } else {
      reply = await handleUserMessage(user, msg.text ?? "");
    }
  } catch (err) {
    console.error("[moni] error respondiendo", msg.id, err);
    reply = { text: "Tuve un problema procesando tu mensaje. Probá de nuevo en un ratito.", confirm: false };
  }
  if (reply.confirm) await askConfirmation(msg.from, reply.text);
  else await whatsapp.sendText(msg.from, reply.text);
  console.log(`[tiempos] ${msg.kind} respondido en ${Date.now() - started} ms`);
}

await whatsapp.start(app, onMessage);

// Wallets de antes de 0xGasless: les calcula la smart account y les pasa el saldo, sin frenar el arranque.
upgradeWallets()
  .then(() => deployPendingWallets())
  .catch((err) => console.error("[wallets] falló la actualización a smart accounts", err));

app.route("/api", createApi(allowedSenders));

// Landing en "/" y plataforma en "/app" (una sola página que maneja sus vistas).
app.get("/app", serveStatic({ path: `${config.PUBLIC_DIR}/app/index.html` }));
app.get("/app/", serveStatic({ path: `${config.PUBLIC_DIR}/app/index.html` }));
app.use("/*", serveStatic({ root: config.PUBLIC_DIR }));

if (config.DEPOSIT_POLL_MS > 0) startDepositWatcher((phone, text) => whatsapp.sendText(phone, text));

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Moni escuchando en :${info.port} (WhatsApp: ${whatsapp.name})`);
});
