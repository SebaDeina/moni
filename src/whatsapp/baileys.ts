import type { WhatsAppProvider } from "./types.js";

/**
 * Alternativa no oficial (WhatsApp Web). Solo con un número descartable.
 * La sesión vive en BAILEYS_AUTH_DIR, que en el VPS es un volumen persistente.
 * Dueño: dev de WhatsApp + LLM.
 */
export const baileys: WhatsAppProvider = {
  name: "baileys",

  async start() {
    // TODO(whatsapp): `npm i baileys`, abrir el socket con useMultiFileAuthState(config.BAILEYS_AUTH_DIR),
    // mostrar el QR en los logs y llamar a onMessage por cada mensaje de texto o audio.
    throw new Error("baileys.start no implementado");
  },

  async sendText() {
    throw new Error("baileys.sendText no implementado");
  },

  async downloadAudio() {
    throw new Error("baileys.downloadAudio no implementado");
  },
};
