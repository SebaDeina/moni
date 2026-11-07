import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleUserText } from "./agent/index.js";
import { transcribe } from "./agent/transcribe.js";
import { config } from "./config.js";
import { saveIncomingMessage } from "./db/index.js";
import { whatsapp, type IncomingMessage } from "./whatsapp/index.js";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, whatsapp: whatsapp.name }));

const allowedSenders = new Set(
  (config.ALLOWED_SENDERS ?? "").split(",").map((s) => s.replace(/\D/g, "")).filter(Boolean),
);

async function textFromAudio(msg: IncomingMessage): Promise<string> {
  if (msg.audio?.transcript) return msg.audio.transcript;
  const audio = await whatsapp.downloadAudio(msg);
  return transcribe(audio.data, audio.mimeType);
}

async function onMessage(msg: IncomingMessage) {
  const body = msg.kind === "other" ? `[${msg.rawType ?? "otro"}]` : msg.text;
  const stored = saveIncomingMessage({ id: msg.id, sender: msg.from, kind: msg.kind === "audio" ? "audio" : "text", body });
  if (!stored) return; // webhook repetido

  if (allowedSenders.size > 0 && !allowedSenders.has(msg.from)) {
    await whatsapp.sendText(msg.from, "Moni está en prueba privada por ahora. ¡Pronto abrimos!");
    return;
  }

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
      reply = `🎙️ "${heard}"\n\n${await handleUserText(msg.from, heard)}`;
    } else {
      reply = await handleUserText(msg.from, msg.text ?? "");
    }
  } catch (err) {
    console.error("[moni] error respondiendo", msg.id, err);
    reply = "Tuve un problema procesando tu mensaje. Probá de nuevo en un ratito.";
  }
  await whatsapp.sendText(msg.from, reply);
}

await whatsapp.start(app, onMessage);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Moni escuchando en :${info.port} (WhatsApp: ${whatsapp.name})`);
});
