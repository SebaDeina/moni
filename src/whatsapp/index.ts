import { config } from "../config.js";
import { baileys } from "./baileys.js";
import { CONFIRM_BUTTONS, kapso } from "./kapso.js";
import type { WhatsAppProvider } from "./types.js";

export const whatsapp: WhatsAppProvider = config.WHATSAPP_PROVIDER === "baileys" ? baileys : kapso;

export type { IncomingMessage, WhatsAppProvider } from "./types.js";
export { CONFIRM_BUTTONS };

/** Pide confirmación con botones; si el proveedor no los tiene o fallan, con texto. */
export async function askConfirmation(to: string, text: string): Promise<void> {
  if (whatsapp.sendButtons) {
    try {
      await whatsapp.sendButtons(to, text, CONFIRM_BUTTONS);
      return;
    } catch (err) {
      console.warn("[whatsapp] no pude mandar botones, sigo con texto", String(err).slice(0, 160));
    }
  }
  await whatsapp.sendText(to, `${text}\n\nRespondé *sí* para confirmar o *no* para cancelar.`);
}
