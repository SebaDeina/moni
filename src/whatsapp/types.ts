import type { Hono } from "hono";

export type IncomingMessage = {
  /** Id del mensaje en el proveedor. Sirve para descartar webhooks repetidos. */
  id: string;
  /** Número del remitente en formato E.164 sin "+", por ejemplo "5491122334455". */
  from: string;
  contactName?: string;
  /** "other" cubre stickers, fotos, ubicaciones, etc.: por ahora solo respondemos que no los entendemos. */
  kind: "text" | "audio" | "other";
  text?: string;
  /** Tipo original del proveedor ("image", "sticker"...), para "other". */
  rawType?: string;
  audio?: {
    /** Transcripción que ya trae el proveedor, si la trae. */
    transcript?: string;
    url?: string;
    mimeType?: string;
  };
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
  /** Marca el mensaje como leído y muestra "escribiendo…" mientras preparamos la respuesta. */
  markReadAndTyping?(msg: IncomingMessage): Promise<void>;
  downloadAudio(msg: IncomingMessage): Promise<{ data: Buffer; mimeType: string }>;
}
