import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleUserText, transcribe } from "./agent/index.js";
import { config } from "./config.js";
import { saveIncomingMessage } from "./db/index.js";
import { whatsapp, type IncomingMessage } from "./whatsapp/index.js";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, whatsapp: whatsapp.name }));

async function onMessage(msg: IncomingMessage) {
  if (!saveIncomingMessage({ id: msg.id, sender: msg.from, kind: msg.kind, body: msg.text })) {
    return; // webhook repetido
  }

  let text = msg.text ?? "";
  if (msg.kind === "audio") {
    const audio = await whatsapp.downloadAudio(msg);
    text = await transcribe(audio.data, audio.mimeType);
  }

  const reply = await handleUserText(msg.from, text);
  await whatsapp.sendText(msg.from, reply);
}

await whatsapp.start(app, onMessage);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Moni escuchando en :${info.port} (WhatsApp: ${whatsapp.name})`);
});
