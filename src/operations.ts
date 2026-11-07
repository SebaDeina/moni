import { randomUUID } from "node:crypto";
import { formatEther } from "viem";
import { NotImplemented, explorerTxUrl, sendNativeTransfer } from "./chain/index.js";
import { FUJI_CHAIN_ID } from "./config.js";
import { createConfirmation } from "./confirmations.js";
import type { Contact } from "./contacts.js";
import { db } from "./db/index.js";

/** Deja la transferencia propuesta y devuelve el código que el usuario tiene que confirmar. */
export function proposeTransfer(sender: string, contact: Contact, amountWei: bigint): { operationId: string; code: string } {
  const operationId = randomUUID();
  db.prepare(
    `INSERT INTO operations (id, sender, to_alias, to_address, amount_wei, chain_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?)`,
  ).run(operationId, sender, contact.alias, contact.address, amountWei.toString(), FUJI_CHAIN_ID, Date.now());
  return { operationId, code: createConfirmation(sender, operationId) };
}

type OperationRow = { id: string; to_alias: string; to_address: `0x${string}`; amount_wei: string };

/**
 * Ejecuta una operación ya confirmada con su código. Pasa de 'proposed' a 'confirmed' en un solo
 * UPDATE, así dos confirmaciones simultáneas no pueden mandar dos veces.
 */
export async function executeConfirmedOperation(sender: string, operationId: string): Promise<string> {
  const op = db
    .prepare(
      `UPDATE operations SET status = 'confirmed'
       WHERE id = ? AND sender = ? AND status = 'proposed'
       RETURNING id, to_alias, to_address, amount_wei`,
    )
    .get(operationId, sender) as OperationRow | undefined;
  if (!op) return "Esa operación ya no está pendiente.";

  const amount = BigInt(op.amount_wei);
  const setStatus = (status: string, fields: { tx_hash?: string; nonce?: number; error?: string } = {}) =>
    db
      .prepare("UPDATE operations SET status = ?, tx_hash = COALESCE(?, tx_hash), nonce = COALESCE(?, nonce), error = ? WHERE id = ?")
      .run(status, fields.tx_hash ?? null, fields.nonce ?? null, fields.error ?? null, op.id);

  let preparedHash: string | undefined;
  try {
    const hash = await sendNativeTransfer({
      to: op.to_address,
      amountWei: amount,
      onPrepared: ({ nonce, hash }) => {
        preparedHash = hash;
        setStatus("confirmed", { nonce, tx_hash: hash });
      },
    });
    setStatus("sent", { tx_hash: hash });
    return `Listo ✅ Le mandé ${formatEther(amount)} AVAX a ${op.to_alias}.\n${explorerTxUrl(hash)}`;
  } catch (err) {
    setStatus("failed", { error: err instanceof Error ? err.message : String(err) });
    if (err instanceof NotImplemented) {
      return "Confirmado, pero las transferencias todavía no están habilitadas en Moni. No se movió plata.";
    }
    console.error("[operaciones] falló el envío", op.id, err);
    // Si ya se firmó, la transacción puede haber salido igual: no prometemos que no se movió plata.
    if (preparedHash) {
      return `Hubo un problema al confirmar el envío. Revisá si salió antes de intentar de nuevo:\n${explorerTxUrl(preparedHash)}`;
    }
    return "No pude enviar la transferencia. No se movió plata; probá de nuevo en un rato.";
  }
}
