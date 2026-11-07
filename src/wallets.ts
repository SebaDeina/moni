import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  NotImplemented,
  explorerAddressUrl,
  explorerTxUrl,
  deploySmartAccount,
  sendFromTreasury,
  smartAccountAddress,
  waitForTransfer,
  sweepToSmartAccount,
} from "./chain/index.js";
import { config } from "./config.js";
import { db } from "./db/index.js";

/**
 * Una wallet por número de WhatsApp, custodiada por Moni.
 *
 * - La clave privada se genera acá y se guarda cifrada con AES-256-GCM. El número va como dato
 *   autenticado, así una clave cifrada no se puede copiar a la fila de otro usuario.
 * - Esa clave es la dueña (EOA) de una smart account de 0xGasless. La smart account es la
 *   dirección del usuario: ahí está su saldo, y opera sin pagar gas (lo cubre Moni: paymaster de
 *   0xGasless o, sin su clave, recarga desde la tesorería).
 */
export type UserWallet = {
  /** Smart account: la dirección para recibir, consultar y enviar. */
  address: Address;
  /** Dueño de la smart account (firma las userOps). No guarda saldo. */
  owner: Address;
  url: string;
  fundTx: string | null;
  createdAt: number;
};

type Row = {
  address: Address;
  sa_address: Address | null;
  enc_key: string;
  iv: string;
  tag: string;
  fund_tx: string | null;
  sweep_tx: string | null;
  created_at: number;
};

function masterKey(): Buffer {
  if (!config.MONI_WALLET_MASTER_KEY) throw new NotImplemented("MONI_WALLET_MASTER_KEY");
  return Buffer.from(config.MONI_WALLET_MASTER_KEY, "hex");
}

function encrypt(phone: string, privateKey: `0x${string}`) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  cipher.setAAD(Buffer.from(phone));
  const enc = Buffer.concat([cipher.update(privateKey.slice(2), "hex"), cipher.final()]);
  return { enc_key: enc.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

function decrypt(phone: string, row: Row): `0x${string}` {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(row.iv, "hex"));
  decipher.setAAD(Buffer.from(phone));
  decipher.setAuthTag(Buffer.from(row.tag, "hex"));
  const key = Buffer.concat([decipher.update(Buffer.from(row.enc_key, "hex")), decipher.final()]);
  return `0x${key.toString("hex")}`;
}

const getRow = (phone: string) =>
  db
    .prepare("SELECT address, sa_address, enc_key, iv, tag, fund_tx, sweep_tx, created_at FROM wallets WHERE phone = ?")
    .get(phone) as Row | undefined;

/** Solo las wallets que ya tienen smart account cuentan: sin ella, el usuario no puede operar sin gas. */
const toWallet = (row: Row): UserWallet | null =>
  row.sa_address
    ? {
        address: row.sa_address,
        owner: row.address,
        url: explorerAddressUrl(row.sa_address),
        fundTx: row.fund_tx,
        createdAt: row.created_at,
      }
    : null;

export function getWallet(phone: string): UserWallet | null {
  const row = getRow(phone);
  return row ? toWallet(row) : null;
}

/** La cuenta dueña de la smart account del usuario. Solo para operaciones ya confirmadas. */
export function signerFor(phone: string): PrivateKeyAccount {
  const row = getRow(phone);
  if (!row) throw new NoWallet();
  return privateKeyToAccount(decrypt(phone, row));
}

/** El usuario todavía no creó su wallet: el agente y la web le sugieren crearla. */
export class NoWallet extends Error {
  constructor() {
    super("Todavía no tenés wallet. Decime \"crear wallet\" y te la armo.");
  }
}

export type CreatedWallet = {
  wallet: UserWallet;
  created: boolean;
  /** Saldo de bienvenida desde la tesorería: hash, o el motivo por el que no salió. */
  funding: { amount: string; txUrl: string } | { error: string } | null;
};

/** Crea la wallet del número (una sola) y le manda el saldo de bienvenida a su smart account. */
export async function createWallet(phone: string): Promise<CreatedWallet> {
  const existing = getRow(phone);
  if (existing) {
    const wallet = toWallet(existing) ?? (await upgradeWallet(phone, existing));
    return { wallet, created: false, funding: null };
  }

  const privateKey = generatePrivateKey();
  const owner = privateKeyToAccount(privateKey);
  // Antes de guardar: si no podemos calcular la smart account, no dejamos una wallet a medias.
  const saAddress = await smartAccountAddress(owner);
  const inserted = db
    .prepare(
      // sweep_tx 'none': una wallet nueva nunca tuvo saldo en la EOA, no hay nada que mover.
      "INSERT OR IGNORE INTO wallets (phone, address, sa_address, enc_key, iv, tag, sweep_tx, created_at) VALUES (?, ?, ?, ?, ?, ?, 'none', ?)",
    )
    .run(phone, owner.address, saAddress, ...Object.values(encrypt(phone, privateKey)), Date.now());
  // Si dos pedidos llegaron juntos, gana el primero y el segundo ve esa wallet.
  if (inserted.changes === 0) return { wallet: toWallet(getRow(phone)!)!, created: false, funding: null };

  const funding = await fund(phone, saAddress);
  // En segundo plano: desplegar la cuenta ya, así desde el primer envío el gas lo patrocina 0xGasless.
  void deployWallet(phone);
  return { wallet: toWallet(getRow(phone)!)!, created: true, funding };
}

async function fund(phone: string, address: Address): Promise<CreatedWallet["funding"]> {
  const amountWei = parseEther(config.WELCOME_AVAX);
  if (amountWei === 0n) return null;
  try {
    const hash = await sendFromTreasury(address, amountWei, ({ hash }) =>
      db.prepare("UPDATE wallets SET fund_tx = ? WHERE phone = ?").run(hash, phone),
    );
    return { amount: `${config.WELCOME_AVAX} AVAX`, txUrl: explorerTxUrl(hash) };
  } catch (err) {
    console.error("[wallets] no pude fondear la wallet nueva", address, String(err).slice(0, 200));
    return {
      error:
        err instanceof NotImplemented
          ? "La tesorería todavía no está configurada, así que la wallet arranca en 0."
          : "No pude mandarle el saldo inicial; la wallet arranca en 0.",
    };
  }
}

/**
 * Wallet creada antes de 0xGasless: le calcula la smart account y le pasa lo que tenía la EOA (USDC y AVAX).
 * El barrido es de una sola vez y lo paga la propia EOA con su saldo.
 */
async function upgradeWallet(phone: string, row: Row): Promise<UserWallet> {
  const owner = privateKeyToAccount(decrypt(phone, row));
  const saAddress = row.sa_address ?? (await smartAccountAddress(owner));
  db.prepare("UPDATE wallets SET sa_address = ? WHERE phone = ? AND sa_address IS NULL").run(saAddress, phone);
  if (!row.sweep_tx) {
    try {
      const hash = await sweepToSmartAccount(owner, saAddress);
      db.prepare("UPDATE wallets SET sweep_tx = ? WHERE phone = ?").run(hash ?? "none", phone);
      if (hash) console.log(`[wallets] saldo de ${owner.address} pasado a la smart account ${saAddress}: ${explorerTxUrl(hash)}`);
    } catch (err) {
      console.error("[wallets] no pude pasar el saldo a la smart account", owner.address, String(err).slice(0, 200));
    }
  }
  return toWallet(getRow(phone)!)!;
}

/** Al arrancar: pasa a smart account las wallets que todavía no tienen. */
export async function upgradeWallets(): Promise<void> {
  const pending = db.prepare("SELECT phone FROM wallets WHERE sa_address IS NULL OR sweep_tx IS NULL").all() as { phone: string }[];
  for (const { phone } of pending) {
    try {
      await upgradeWallet(phone, getRow(phone)!);
    } catch (err) {
      console.error("[wallets] no pude actualizar la wallet de", phone.slice(-4), String(err).slice(0, 200));
    }
  }
}

/**
 * Despliega la smart account del número si todavía no está desplegada (espera antes el saldo de
 * bienvenida, que paga ese despliegue). No lanza: si falla, el primer envío la despliega igual.
 */
export async function deployWallet(phone: string): Promise<void> {
  try {
    const row = getRow(phone);
    if (!row?.sa_address) return;
    if (row.fund_tx && row.fund_tx.startsWith("0x")) await waitForTransfer(row.fund_tx as `0x${string}`).catch(() => false);
    const hash = await deploySmartAccount(privateKeyToAccount(decrypt(phone, row)), row.sa_address);
    if (hash) console.log(`[wallets] smart account ${row.sa_address} desplegada: ${explorerTxUrl(hash)}`);
  } catch (err) {
    console.error("[wallets] no pude desplegar la smart account de", phone.slice(-4), String(err).slice(0, 200));
  }
}

/** Al arrancar: despliega las smart accounts que todavía no lo están, de a una. */
export async function deployPendingWallets(): Promise<void> {
  migrateContactsToSmartAccounts();
  const rows = db.prepare("SELECT phone FROM wallets WHERE sa_address IS NOT NULL").all() as { phone: string }[];
  for (const { phone } of rows) await deployWallet(phone);
  await resweepOldWallets();
}

/**
 * Si `address` es la wallet vieja (EOA) de un usuario de Moni, devuelve su smart account actual.
 * Así un contacto o una dirección guardada de antes no manda plata a donde Moni ya no mira.
 */
export function currentAddressFor(address: string): `0x${string}` | null {
  const row = db
    .prepare("SELECT sa_address FROM wallets WHERE lower(address) = lower(?) AND sa_address IS NOT NULL")
    .get(address) as { sa_address: `0x${string}` } | undefined;
  return row?.sa_address ?? null;
}

/** Contactos guardados con la wallet vieja de un usuario: pasan a su smart account. */
function migrateContactsToSmartAccounts() {
  const res = db
    .prepare(
      `UPDATE contacts SET address = (SELECT w.sa_address FROM wallets w WHERE lower(w.address) = lower(contacts.address))
       WHERE lower(address) IN (SELECT lower(address) FROM wallets WHERE sa_address IS NOT NULL)`,
    )
    .run();
  if (res.changes) console.log(`[wallets] ${res.changes} contacto(s) apuntaban a una wallet vieja: ahora apuntan a la smart account`);
}

/** Lo que haya llegado a una wallet vieja (USDC o AVAX) se pasa a la smart account de su dueño. */
async function resweepOldWallets() {
  const rows = db.prepare("SELECT phone FROM wallets WHERE sa_address IS NOT NULL").all() as { phone: string }[];
  for (const { phone } of rows) {
    const row = getRow(phone)!;
    try {
      const hash = await sweepToSmartAccount(privateKeyToAccount(decrypt(phone, row)), row.sa_address!);
      if (hash) console.log(`[wallets] saldo nuevo en la wallet vieja ${row.address} pasado a ${row.sa_address}: ${explorerTxUrl(hash)}`);
    } catch (err) {
      console.error("[wallets] no pude barrer la wallet vieja de", phone.slice(-4), String(err).slice(0, 200));
    }
  }
}
