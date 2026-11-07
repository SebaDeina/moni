import { randomUUID } from "node:crypto";
import { formatEther, parseEther } from "viem";
import { NotImplemented, canAfford, explorerTxUrl, sendNativeTransfer } from "./chain/index.js";
import { FUJI_CHAIN_ID } from "./config.js";
import { createConfirmation } from "./confirmations.js";
import { findContact, listAliases, type Contact } from "./contacts.js";
import { db } from "./db/index.js";
import { NoWallet, getWallet, signerFor } from "./wallets.js";

/** Tope por transferencia. Es testnet, pero evita que un error de tipeo vacíe la wallet de la demo. */
export const MAX_TRANSFER_WEI = parseEther("10");

export type PreparedTransfer =
  | { code: string; operationId: string; alias: string; address: `0x${string}`; amount: string }
  | { error: string; contactos?: string[] };

/**
 * Valida y deja propuesta una transferencia. Lo usan el agente de WhatsApp y la web, con las
 * mismas reglas: contacto exacto de la agenda, monto en AVAX, tope y saldo.
 */
export async function prepareTransfer(sender: string, alias: string, amountInput: string): Promise<PreparedTransfer> {
  const amountText = amountInput.trim().replace(",", ".");
  const wallet = getWallet(sender);
  if (!wallet) return { error: new NoWallet().message };
  const contact = findContact(sender, alias);
  if (!contact) return { error: `No tengo a "${alias}" en la agenda.`, contactos: listAliases(sender) };
  if (!/^\d+(\.\d{1,18})?$/.test(amountText)) return { error: "Monto inválido. Escribilo en AVAX, por ejemplo 0.5." };
  const amountWei = parseEther(amountText);
  if (amountWei <= 0n) return { error: "El monto tiene que ser mayor a cero." };
  if (amountWei > MAX_TRANSFER_WEI) return { error: `El máximo por transferencia es ${formatEther(MAX_TRANSFER_WEI)} AVAX.` };
  try {
    if (!(await canAfford(wallet.address, amountWei, contact.address))) return { error: "No alcanza el saldo para ese monto más el gas." };
  } catch (err) {
    if (!(err instanceof NotImplemented)) throw err;
  }
  const { operationId, code } = proposeTransfer(sender, contact, amountWei);
  return { code, operationId, alias: contact.alias, address: contact.address, amount: `${formatEther(amountWei)} AVAX` };
}

export type OperationSummary = {
  id: string;
  alias: string;
  amount: string;
  status: string;
  txUrl: string | null;
  createdAt: number;
};

/** Últimas operaciones de un usuario, para la web. */
export function listOperations(sender: string, limit = 20): OperationSummary[] {
  const rows = db
    .prepare("SELECT id, to_alias, amount_wei, status, tx_hash, created_at FROM operations WHERE sender = ? ORDER BY created_at DESC LIMIT ?")
    .all(sender, limit) as { id: string; to_alias: string; amount_wei: string; status: string; tx_hash: string | null; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    alias: r.to_alias,
    amount: `${formatEther(BigInt(r.amount_wei))} AVAX`,
    status: r.status,
    txUrl: r.tx_hash ? explorerTxUrl(r.tx_hash) : null,
    createdAt: r.created_at,
  }));
}

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
      account: signerFor(sender),
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
    if (err instanceof NoWallet) return err.message;
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
