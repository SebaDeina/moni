import { randomUUID } from "node:crypto";
import {
  NotImplemented,
  canAffordSponsored,
  canAffordToken,
  explorerTxUrl,
  formatTokenAmount,
  isToken,
  parseTokenAmount,
  sendTransfer,
  topUpGas,
  treasuryAddress,
  type Token,
} from "./chain/index.js";
import { FUJI_CHAIN_ID, config } from "./config.js";
import { createConfirmation } from "./confirmations.js";
import { findContact, listAliases, type Contact } from "./contacts.js";
import { db } from "./db/index.js";
import { NoWallet, getWallet, signerFor } from "./wallets.js";

/** Tope por transferencia y moneda. Es testnet, pero evita que un error de tipeo vacíe una wallet. */
export const MAX_TRANSFER: Record<Token, bigint> = {
  AVAX: parseTokenAmount("10", "AVAX"),
  USDC: parseTokenAmount("100", "USDC"),
};
export const formatAmount = (units: bigint, token: Token) => `${formatTokenAmount(units, token)} ${token}`;

/** El gas lo paga la tesorería si está activado y configurada. */
const gasSponsored = () => config.SPONSOR_GAS && treasuryAddress() !== null;

export type PreparedTransfer =
  | { code: string; operationId: string; alias: string; address: `0x${string}`; amount: string }
  | { error: string; contactos?: string[] };

/**
 * Valida y deja propuesta una transferencia. Lo usan el agente de WhatsApp y la web, con las
 * mismas reglas: contacto exacto de la agenda, monto en AVAX o USDC, tope y saldo (más el gas).
 */
export async function prepareTransfer(
  sender: string,
  alias: string,
  amountInput: string,
  tokenInput: unknown = "AVAX",
): Promise<PreparedTransfer> {
  const token = typeof tokenInput === "string" ? tokenInput.toUpperCase() : tokenInput;
  if (!isToken(token)) return { error: "Por ahora Moni maneja AVAX y USDC." };
  const wallet = getWallet(sender);
  if (!wallet) return { error: new NoWallet().message };
  const contact = findContact(sender, alias);
  if (!contact) return { error: `No tengo a "${alias}" en la agenda.`, contactos: listAliases(sender) };
  let amount: bigint;
  try {
    amount = parseTokenAmount(amountInput, token);
  } catch {
    return { error: `Monto inválido. Escribilo en ${token}, por ejemplo ${token === "USDC" ? "5" : "0.5"}.` };
  }
  if (amount <= 0n) return { error: "El monto tiene que ser mayor a cero." };
  if (amount > MAX_TRANSFER[token]) return { error: `El máximo por transferencia es ${formatAmount(MAX_TRANSFER[token], token)}.` };
  try {
    if (gasSponsored()) {
      const check = await canAffordSponsored(wallet.address, token, amount, contact.address);
      if (!check.ok) {
        return { error: check.reason === "tesoreria" ? "Moni no tiene saldo para pagar el gas ahora. Probá en un rato." : `No alcanza: tenés menos de ${formatAmount(amount, token)}.` };
      }
    } else if (!(await canAffordToken(wallet.address, token, amount, contact.address))) {
      return { error: token === "AVAX" ? "No alcanza el saldo para ese monto más el gas." : `No alcanza: necesitás ${formatAmount(amount, token)} y un poco de AVAX para el gas.` };
    }
  } catch (err) {
    if (!(err instanceof NotImplemented)) throw err;
  }
  const { operationId, code } = proposeTransfer(sender, contact, amount, token);
  return { code, operationId, alias: contact.alias, address: contact.address, amount: formatAmount(amount, token) };
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
    .prepare("SELECT id, to_alias, amount_wei, token, status, tx_hash, created_at FROM operations WHERE sender = ? ORDER BY created_at DESC LIMIT ?")
    .all(sender, limit) as { id: string; to_alias: string; amount_wei: string; token: Token; status: string; tx_hash: string | null; created_at: number }[];
  return rows.map((r) => ({
    id: r.id,
    alias: r.to_alias,
    amount: formatAmount(BigInt(r.amount_wei), r.token),
    status: r.status,
    txUrl: r.tx_hash ? explorerTxUrl(r.tx_hash) : null,
    createdAt: r.created_at,
  }));
}

/** Deja la transferencia propuesta y devuelve el código que el usuario tiene que confirmar. */
export function proposeTransfer(sender: string, contact: Contact, amount: bigint, token: Token): { operationId: string; code: string } {
  const operationId = randomUUID();
  db.prepare(
    `INSERT INTO operations (id, sender, to_alias, to_address, amount_wei, token, chain_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
  ).run(operationId, sender, contact.alias, contact.address, amount.toString(), token, FUJI_CHAIN_ID, Date.now());
  return { operationId, code: createConfirmation(sender, operationId) };
}

type OperationRow = { id: string; to_alias: string; to_address: `0x${string}`; amount_wei: string; token: Token };

/**
 * Ejecuta una operación ya confirmada con su código. Pasa de 'proposed' a 'confirmed' en un solo
 * UPDATE, así dos confirmaciones simultáneas no pueden mandar dos veces.
 */
export async function executeConfirmedOperation(sender: string, operationId: string): Promise<string> {
  const op = db
    .prepare(
      `UPDATE operations SET status = 'confirmed'
       WHERE id = ? AND sender = ? AND status = 'proposed'
       RETURNING id, to_alias, to_address, amount_wei, token`,
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
    const account = signerFor(sender);
    // Gas patrocinado: si al usuario no le alcanza el AVAX para el gas, la tesorería se lo recarga antes.
    if (gasSponsored()) await topUpGas(account.address, op.token, amount, op.to_address);
    const hash = await sendTransfer({
      account,
      token: op.token,
      to: op.to_address,
      amount,
      onPrepared: ({ nonce, hash }) => {
        preparedHash = hash;
        setStatus("confirmed", { nonce, tx_hash: hash });
      },
    });
    setStatus("sent", { tx_hash: hash });
    const gasNote = gasSponsored() ? " El gas lo pagó Moni." : "";
    return `Listo ✅ Le mandé ${formatAmount(amount, op.token)} a ${op.to_alias}.${gasNote}\n${explorerTxUrl(hash)}`;
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
