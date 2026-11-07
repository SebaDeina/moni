import { randomInt } from "node:crypto";
import { db } from "./db/index.js";

const TTL_MS = 2 * 60 * 1000;

/** Crea el código que el usuario tiene que responder ("SI 482913") para firmar una operación. */
export function createConfirmation(sender: string, operationId: string): string {
  const code = String(randomInt(100000, 1000000));
  db.prepare(
    "INSERT INTO confirmations (code, sender, operation_id, expires_at) VALUES (?, ?, ?, ?)",
  ).run(code, sender, operationId, Date.now() + TTL_MS);
  return code;
}

/**
 * Consume el código de forma atómica: solo una llamada gana, y solo si es del mismo remitente
 * y no venció. Devuelve el id de la operación o null.
 */
export function consumeConfirmation(sender: string, code: string): string | null {
  const now = Date.now();
  const row = db
    .prepare(
      `UPDATE confirmations SET consumed_at = ?
       WHERE sender = ? AND code = ? AND consumed_at IS NULL AND expires_at > ?
       RETURNING operation_id`,
    )
    .get(now, sender, code, now) as { operation_id: string } | undefined;
  return row?.operation_id ?? null;
}

/** "SI 123456", "si 123456", "Sí 123456" (formato anterior, sigue andando). La confirmación nunca pasa por el modelo. */
export function parseConfirmation(text: string): string | null {
  const match = text.trim().match(/^s[ií]\s+(\d{6})$/i);
  return match ? match[1] : null;
}

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[!¡.?¿,]/g, "").trim();

const YES = new Set(["si", "sí", "dale", "ok", "okey", "oka", "confirmo", "confirmar", "confirmado", "listo", "de una", "mandalo", "manda", "👍", "✅", "si dale", "si confirmo", "dale si"]);
const NO = new Set(["no", "cancelar", "cancela", "cancelo", "nada", "mejor no", "no gracias", "❌"]);

/** Respuesta corta de confirmación o cancelación ("sí", "dale", "no", botón). Null si es otra cosa. */
export function parseYesNo(text: string): "yes" | "no" | null {
  const t = normalize(text);
  if (YES.has(t)) return "yes";
  if (NO.has(t)) return "no";
  return null;
}

export type Pending =
  | { kind: "operation"; code: string; operationId: string; expiresAt: number }
  | { kind: "contact"; code: string; expiresAt: number };

/** El último pedido pendiente del usuario (envío o contacto), si no venció. "Sí" confirma solo ese. */
export function latestPending(sender: string): Pending | null {
  const now = Date.now();
  const op = db
    .prepare(
      "SELECT code, operation_id, expires_at FROM confirmations WHERE sender = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
    )
    .get(sender, now) as { code: string; operation_id: string; expires_at: number } | undefined;
  const contact = db
    .prepare(
      "SELECT code, expires_at FROM contact_requests WHERE owner = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
    )
    .get(sender, now) as { code: string; expires_at: number } | undefined;
  if (op && (!contact || op.expires_at >= contact.expires_at)) {
    return { kind: "operation", code: op.code, operationId: op.operation_id, expiresAt: op.expires_at };
  }
  return contact ? { kind: "contact", code: contact.code, expiresAt: contact.expires_at } : null;
}

/** Cancela un pedido pendiente: lo marca consumido para que ya no se pueda confirmar. */
export function cancelPending(sender: string, pending: Pending): boolean {
  const now = Date.now();
  if (pending.kind === "operation") {
    const done = db
      .prepare("UPDATE confirmations SET consumed_at = ? WHERE sender = ? AND code = ? AND consumed_at IS NULL")
      .run(now, sender, pending.code).changes === 1;
    if (done) db.prepare("UPDATE operations SET status = 'expired' WHERE id = ? AND status = 'proposed'").run(pending.operationId);
    return done;
  }
  return db
    .prepare("UPDATE contact_requests SET consumed_at = ? WHERE owner = ? AND code = ? AND consumed_at IS NULL")
    .run(now, sender, pending.code).changes === 1;
}
