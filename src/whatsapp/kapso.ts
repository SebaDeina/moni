import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import type { IncomingMessage, WhatsAppProvider } from "./types.js";

/**
 * WhatsApp Cloud API vía Kapso.
 * Webhook: https://docs.kapso.ai/docs/platform/webhooks/message-events
 * Envío:   https://docs.kapso.ai/api/meta/whatsapp/messages/send-a-message
 */
const GRAPH_VERSION = "v24.0";

/** HMAC-SHA256 en hex del body crudo, en el header X-Webhook-Signature. */
export function verifyKapsoSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const received = Buffer.from(signature.trim());
  return expected.length === received.length && timingSafeEqual(expected, received);
}

type KapsoMessagePayload = {
  message?: {
    id?: string;
    type?: string;
    from?: string;
    text?: { body?: string };
    interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
    kapso?: {
      direction?: string;
      transcript?: { text?: string };
      media_url?: string;
      media_data?: { url?: string; content_type?: string };
    };
  };
  conversation?: { phone_number?: string; contact_name?: string };
};

/** Ids de los botones que manda Moni y el texto equivalente. */
export const CONFIRM_BUTTONS = [
  { id: "moni_confirm", title: "✅ Confirmar" },
  { id: "moni_cancel", title: "Cancelar" },
];
const BUTTON_TEXT: Record<string, string> = { moni_confirm: "sí", moni_cancel: "no" };

/** Pasa un whatsapp.message.received (con o sin buffering) a nuestros mensajes. */
export function parseKapsoWebhook(body: unknown): IncomingMessage[] {
  const envelope = body as { batch?: boolean; data?: KapsoMessagePayload[] };
  const items: KapsoMessagePayload[] = envelope?.batch ? (envelope.data ?? []) : [body as KapsoMessagePayload];

  const messages: IncomingMessage[] = [];
  for (const item of items) {
    const m = item?.message;
    if (!m?.id || m.kapso?.direction === "outbound") continue;
    const from = m.from ?? item.conversation?.phone_number;
    if (!from) continue;

    const base = { id: m.id, from, contactName: item.conversation?.contact_name };
    if (m.type === "interactive" && m.interactive?.button_reply) {
      // Botones de Moni: los traducimos a la respuesta que entiende el agente ("sí" / "no").
      const { id, title } = m.interactive.button_reply;
      messages.push({ ...base, kind: "text", text: BUTTON_TEXT[id ?? ""] ?? title ?? "" });
    } else if (m.type === "text") {
      messages.push({ ...base, kind: "text", text: m.text?.body ?? "" });
    } else if (m.type === "audio") {
      messages.push({
        ...base,
        kind: "audio",
        audio: {
          transcript: m.kapso?.transcript?.text || undefined,
          url: m.kapso?.media_url ?? m.kapso?.media_data?.url,
          mimeType: m.kapso?.media_data?.content_type,
        },
      });
    } else {
      messages.push({ ...base, kind: "other", rawType: m.type });
    }
  }
  return messages;
}

async function postMessage(body: Record<string, unknown>): Promise<void> {
  if (!config.KAPSO_API_KEY || !config.KAPSO_PHONE_NUMBER_ID) {
    throw new Error("Faltan KAPSO_API_KEY o KAPSO_PHONE_NUMBER_ID");
  }
  const res = await fetch(`${config.KAPSO_API_BASE}/meta/whatsapp/${GRAPH_VERSION}/${config.KAPSO_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { "X-API-Key": config.KAPSO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Kapso respondió ${res.status}: ${await res.text()}`);
}

export const kapso: WhatsAppProvider = {
  name: "kapso",

  async start(app, onMessage) {
    app.post("/webhooks/kapso", async (c) => {
      if (!config.KAPSO_WEBHOOK_SECRET) {
        console.error("[kapso] falta KAPSO_WEBHOOK_SECRET: rechazo el webhook");
        return c.json({ error: "webhook no configurado" }, 503);
      }
      const raw = await c.req.text();
      if (!verifyKapsoSignature(raw, c.req.header("x-webhook-signature"), config.KAPSO_WEBHOOK_SECRET)) {
        return c.json({ error: "firma inválida" }, 401);
      }

      const event = c.req.header("x-webhook-event");
      if (event !== "whatsapp.message.received") return c.json({ ok: true, ignored: event });

      let messages: IncomingMessage[];
      try {
        messages = parseKapsoWebhook(JSON.parse(raw));
      } catch {
        return c.json({ error: "JSON inválido" }, 400);
      }

      // Kapso pide 200 en menos de 10 s: respondemos ya y procesamos aparte.
      for (const msg of messages) {
        onMessage(msg).catch((err) => console.error("[kapso] error procesando", msg.id, err));
      }
      return c.json({ ok: true, received: messages.length });
    });
  },

  async sendText(to, text) {
    await postMessage({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: text } });
  },

  async sendButtons(to, text, buttons) {
    await postMessage({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: text.slice(0, 1024) },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
      },
    });
  },

  // https://docs.kapso.ai/docs/whatsapp/send-messages/mark-read
  async markReadAndTyping(msg) {
    await postMessage({ messaging_product: "whatsapp", status: "read", message_id: msg.id, typing_indicator: { type: "text" } });
  },

  async downloadAudio(msg) {
    const url = msg.audio?.url;
    if (!url) throw new Error("El audio no trae URL para descargarlo");
    // Los links de Kapso necesitan la API key; los del CDN de WhatsApp no.
    const kapsoHost = new URL(config.KAPSO_API_BASE).hostname;
    const headers: Record<string, string> =
      new URL(url).hostname === kapsoHost && config.KAPSO_API_KEY ? { "X-API-Key": config.KAPSO_API_KEY } : {};
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`No pude bajar el audio (${res.status})`);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      mimeType: msg.audio?.mimeType ?? res.headers.get("content-type") ?? "audio/ogg",
    };
  },
};
