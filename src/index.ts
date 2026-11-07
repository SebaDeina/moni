import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { handleUserText } from "./agent/index.js";
import { canTranscribe, transcribe } from "./agent/transcribe.js";
import { config } from "./config.js";
import { saveIncomingMessage } from "./db/index.js";
import { canonicalPhone } from "./phone.js";
import { createApi } from "./web/api.js";
import { whatsapp, type IncomingMessage } from "./whatsapp/index.js";

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

  if (msg.kind === "other") {
    await whatsapp.sendText(msg.from, "Por ahora entiendo mensajes de texto y audios.");
    return;
  }

  let reply: string;
  try {
    if (msg.kind === "audio") {
      const heard = await textFromAudio(msg);
      if (!heard) {
        await whatsapp.sendText(msg.from, "No llegué a entender el audio. ¿Me lo mandás de nuevo o por escrito?");
        return;
      }
      reply = await handleUserText(user, heard);
    } else {
      reply = await handleUserText(user, msg.text ?? "");
    }
  } catch (err) {
    console.error("[moni] error respondiendo", msg.id, err);
    reply = "Tuve un problema procesando tu mensaje. Probá de nuevo en un ratito.";
  }
  await whatsapp.sendText(msg.from, reply);
  console.log(`[tiempos] ${msg.kind} respondido en ${Date.now() - started} ms`);
}

await whatsapp.start(app, onMessage);

app.route("/api", createApi(allowedSenders));

// Landing en "/" y plataforma en "/app" (una sola página que maneja sus vistas).
app.get("/app", serveStatic({ path: `${config.PUBLIC_DIR}/app/index.html` }));
app.get("/app/", serveStatic({ path: `${config.PUBLIC_DIR}/app/index.html` }));
app.use("/*", serveStatic({ root: config.PUBLIC_DIR }));

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Moni escuchando en :${info.port} (WhatsApp: ${whatsapp.name})`);
});
