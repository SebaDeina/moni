import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { NotImplemented, explorerAddressUrl, explorerTxUrl, sendFromTreasury } from "./chain/index.js";
import { config } from "./config.js";
import { db } from "./db/index.js";

/**
 * Una wallet por número de WhatsApp, custodiada por Moni: la clave privada se genera acá y se
 * guarda cifrada con AES-256-GCM. El número va como dato autenticado, así una clave cifrada
 * no se puede copiar a la fila de otro usuario.
 */
export type UserWallet = { address: Address; url: string; fundTx: string | null; createdAt: number };

type Row = { address: Address; enc_key: string; iv: string; tag: string; fund_tx: string | null; created_at: number };

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
  db.prepare("SELECT address, enc_key, iv, tag, fund_tx, created_at FROM wallets WHERE phone = ?").get(phone) as Row | undefined;

const toWallet = (row: Row): UserWallet => ({
  address: row.address,
  url: explorerAddressUrl(row.address),
  fundTx: row.fund_tx,
  createdAt: row.created_at,
});

export function getWallet(phone: string): UserWallet | null {
  const row = getRow(phone);
  return row ? toWallet(row) : null;
}

/** La cuenta con la que firma el usuario. Solo para operaciones ya confirmadas. */
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
  /** Fondeo inicial desde la tesorería: hash, o el motivo por el que no salió. */
  funding: { amount: string; txUrl: string } | { error: string } | null;
};

/** Crea la wallet del número (una sola) y le manda el saldo de bienvenida para el gas. */
export async function createWallet(phone: string): Promise<CreatedWallet> {
  const existing = getRow(phone);
  if (existing) return { wallet: toWallet(existing), created: false, funding: null };

  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const inserted = db
    .prepare("INSERT OR IGNORE INTO wallets (phone, address, enc_key, iv, tag, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(phone, address, ...Object.values(encrypt(phone, privateKey)), Date.now());
  // Si dos pedidos llegaron juntos, gana el primero y el segundo ve esa wallet.
  if (inserted.changes === 0) return { wallet: toWallet(getRow(phone)!), created: false, funding: null };

  const funding = await fund(phone, address);
  return { wallet: toWallet(getRow(phone)!), created: true, funding };
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
