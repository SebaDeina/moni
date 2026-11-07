import type { Hono } from "hono";

export type IncomingMessage = {
  /** Id del mensaje en el proveedor. Sirve para descartar webhooks repetidos. */
  id: string;
  /** Número del remitente en formato E.164 sin "+", por ejemplo "5491122334455". */
  from: string;
  kind: "text" | "audio";
  text?: string;
  /** Lo que cada proveedor necesite para bajar el audio después. */
  audioRef?: unknown;
};

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/**
 * Lo que el resto del backend necesita de WhatsApp. Kapso y Baileys implementan esto;
 * el agente no sabe cuál está activo.
 */
export interface WhatsAppProvider {
  readonly name: string;
  /** Kapso monta su webhook en `app`; Baileys abre el socket. */
  start(app: Hono, onMessage: MessageHandler): Promise<void>;
  sendText(to: string, text: string): Promise<void>;
  downloadAudio(msg: IncomingMessage): Promise<{ data: Buffer; mimeType: string }>;
}
