import { randomUUID } from "node:crypto";
import { getAddress, isAddress } from "viem";
import {
  NotImplemented,
  canSend,
  explorerTxUrl,
  formatTokenAmount,
  isToken,
  parseTokenAmount,
  sendViaVault,
  type Token,
} from "./chain/index.js";
import { FUJI_CHAIN_ID } from "./config.js";
import { createConfirmation } from "./confirmations.js";
import { findContact, listAliases, type Contact } from "./contacts.js";
import { db } from "./db/index.js";
import { NoWallet, currentAddressFor, getWallet, signerFor } from "./wallets.js";

/** Tope por transferencia y moneda. Es testnet, pero evita que un error de tipeo vacíe una wallet. */
export const MAX_TRANSFER: Record<Token, bigint> = {
  AVAX: parseTokenAmount("10", "AVAX"),
  USDC: parseTokenAmount("100", "USDC"),
};
export const formatAmount = (units: bigint, token: Token) => `${formatTokenAmount(units, token)} ${token}`;

export type PreparedTransfer =
  | { code: string; operationId: string; alias: string; address: `0x${string}`; amount: string }
  | { error: string; contactos?: string[] };

/**
 * Valida y deja propuesta una transferencia. Lo usan el agente de WhatsApp y la web, con las
 * mismas reglas: contacto exacto de la agenda (o una dirección 0x completa), monto en AVAX o USDC, tope y saldo.
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
  // Una dirección 0x completa se puede usar directo, sin agendarla.
  const target = alias.trim();
  const contact: Contact | undefined = isAddress(target)
    ? { alias: `${getAddress(target).slice(0, 6)}…${getAddress(target).slice(-4)}`, address: getAddress(target), shared: false }
    : findContact(sender, target);
  // Una dirección vieja (EOA) de un usuario de Moni: mandamos a su smart account, que es la que Moni mira.
  const current = contact && currentAddressFor(contact.address);
  if (contact && current) contact.address = current;
  if (!contact) {
    return target.toLowerCase().startsWith("0x")
      ? { error: "Esa dirección no es válida: tiene que ser 0x seguido de 40 caracteres." }
      : { error: `No tengo a "${alias}" en la agenda.`, contactos: listAliases(sender) };
  }
  let amount: bigint;
  try {
    amount = parseTokenAmount(amountInput, token);
  } catch {
    return { error: `Monto inválido. Escribilo en ${token}, por ejemplo ${token === "USDC" ? "5" : "0.5"}.` };
  }
  if (amount <= 0n) return { error: "El monto tiene que ser mayor a cero." };
  if (amount > MAX_TRANSFER[token]) return { error: `El máximo por transferencia es ${formatAmount(MAX_TRANSFER[token], token)}.` };
  try {
    // El gas lo cubre Moni (paymaster de 0xGasless o tesorería): alcanza con tener lo que se manda.
    const check = await canSend(wallet.address, token, amount);
    if (!check.ok) {
      return { error: check.reason === "gas" ? "Moni no puede cubrir el gas ahora. Probá en un rato." : `No alcanza: tenés menos de ${formatAmount(amount, token)}.` };
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
  const setStatus = (status: string, fields: { tx_hash?: string; user_op_hash?: string; error?: string } = {}) =>
    db
      .prepare(
        "UPDATE operations SET status = ?, tx_hash = COALESCE(?, tx_hash), user_op_hash = COALESCE(?, user_op_hash), error = ? WHERE id = ?",
      )
      .run(status, fields.tx_hash ?? null, fields.user_op_hash ?? null, fields.error ?? null, op.id);

  const wallet = getWallet(sender);
  let submitted = false;
  try {
    if (!wallet) throw new NoWallet();
    // Una sola userOp desde la smart account: depósito en MoniVault + (agenda) + pago al contacto.
    const { txHash } = await sendViaVault({
      owner: signerFor(sender),
      from: wallet.address,
      token: op.token,
      to: op.to_address,
      amount,
      memo: "Moni",
      onSubmitted: (userOpHash) => {
        submitted = true;
        setStatus("confirmed", { user_op_hash: userOpHash });
      },
    });
    setStatus("sent", { tx_hash: txHash });
    return `Listo ✅ Le mandé ${formatAmount(amount, op.token)} a ${op.to_alias}. El gas lo pagó Moni.\n${explorerTxUrl(txHash)}`;
  } catch (err) {
    setStatus("failed", { error: err instanceof Error ? err.message : String(err) });
    if (err instanceof NoWallet) return err.message;
    if (err instanceof NotImplemented) {
      return "Confirmado, pero las transferencias todavía no están habilitadas en Moni. No se movió plata.";
    }
    console.error("[operaciones] falló el envío", op.id, err);
    // Si el bundler ya la aceptó, puede entrar igual: no prometemos que no se movió plata.
    if (submitted && wallet) {
      return `Hubo un problema al confirmar el envío. Revisá si salió antes de intentar de nuevo:\n${wallet.url}`;
    }
    return "No pude enviar la transferencia. No se movió plata; probá de nuevo en un rato.";
  }
}
