import { config } from "../config.js";
import type { WhatsAppProvider } from "./types.js";

/** WhatsApp Cloud API vía Kapso. Dueño: dev de WhatsApp + LLM. */
export const kapso: WhatsAppProvider = {
  name: "kapso",

  async start(app, onMessage) {
    app.post("/webhooks/kapso", async (c) => {
      // TODO(whatsapp): validar la firma con KAPSO_WEBHOOK_SECRET antes de leer el body.
      const payload = await c.req.json();

      // TODO(whatsapp): mapear el payload de Kapso a IncomingMessage (texto y audio).
      const messages: Parameters<typeof onMessage>[0][] = [];
      void payload;

      // Respondemos rápido; el procesamiento sigue aparte para no hacer reintentar al webhook.
      for (const msg of messages) {
        onMessage(msg).catch((err) => console.error("[kapso] error procesando", msg.id, err));
      }
      return c.json({ ok: true });
    });
  },

  async sendText(to, text) {
    if (!config.KAPSO_API_KEY) throw new Error("Falta KAPSO_API_KEY");
    // TODO(whatsapp): POST a la API de Kapso con KAPSO_PHONE_NUMBER_ID.
    console.log(`[kapso] → ${to}: ${text}`);
  },

  async downloadAudio() {
    // TODO(whatsapp): bajar el media del mensaje con su id.
    throw new Error("kapso.downloadAudio no implementado");
  },
};
