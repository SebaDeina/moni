import { config } from "../config.js";
import { baileys } from "./baileys.js";
import { kapso } from "./kapso.js";
import type { WhatsAppProvider } from "./types.js";

export const whatsapp: WhatsAppProvider = config.WHATSAPP_PROVIDER === "baileys" ? baileys : kapso;

export type { IncomingMessage, WhatsAppProvider } from "./types.js";
