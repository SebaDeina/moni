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

/** "SI 123456", "si 123456", "Sí 123456". La confirmación nunca pasa por el modelo. */
export function parseConfirmation(text: string): string | null {
  const match = text.trim().match(/^s[ií]\s+(\d{6})$/i);
  return match ? match[1] : null;
}
