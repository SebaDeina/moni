import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });

export const db = new DatabaseSync(config.DATABASE_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  -- Cada mensaje entrante, una sola vez: el id del proveedor evita procesar dos veces un webhook repetido.
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    sender      TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('text', 'audio')),
    body        TEXT,
    received_at INTEGER NOT NULL
  );

  -- Agenda precargada: el agente solo puede mandar a alias que existen acá.
  CREATE TABLE IF NOT EXISTS contacts (
    owner   TEXT NOT NULL,
    alias   TEXT NOT NULL,
    address TEXT NOT NULL,
    PRIMARY KEY (owner, alias)
  );

  -- Transferencias propuestas y su estado. Montos en wei como texto (bigint), nunca float.
  CREATE TABLE IF NOT EXISTS operations (
    id         TEXT PRIMARY KEY,
    sender     TEXT NOT NULL,
    to_alias   TEXT NOT NULL,
    to_address TEXT NOT NULL,
    amount_wei TEXT NOT NULL,
    chain_id   INTEGER NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'sent', 'failed', 'expired')),
    nonce      INTEGER,
    tx_hash    TEXT,
    error      TEXT,
    created_at INTEGER NOT NULL
  );

  -- Una wallet por número. La clave privada va cifrada (AES-256-GCM con MONI_WALLET_MASTER_KEY).
  CREATE TABLE IF NOT EXISTS wallets (
    phone      TEXT PRIMARY KEY,
    address    TEXT NOT NULL UNIQUE,
    enc_key    TEXT NOT NULL,
    iv         TEXT NOT NULL,
    tag        TEXT NOT NULL,
    fund_tx    TEXT,
    created_at INTEGER NOT NULL
  );

  -- Contactos pedidos por chat, pendientes de "SI <código>" (mismas reglas que las transferencias).
  CREATE TABLE IF NOT EXISTS contact_requests (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    alias       TEXT NOT NULL,
    address     TEXT NOT NULL,
    code        TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at  INTEGER NOT NULL
  );

  -- Códigos "SI <código>": vencen a los 2 minutos y se consumen una sola vez.
  CREATE TABLE IF NOT EXISTS confirmations (
    code         TEXT NOT NULL,
    sender       TEXT NOT NULL,
    operation_id TEXT NOT NULL REFERENCES operations(id),
    expires_at   INTEGER NOT NULL,
    consumed_at  INTEGER,
    PRIMARY KEY (sender, code)
  );

  -- Login de la web: código de 6 dígitos por WhatsApp. Guardamos el hash, no el código.
  CREATE TABLE IF NOT EXISTS auth_codes (
    phone       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    consumed_at INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_codes_phone ON auth_codes (phone, created_at);

  -- Sesiones de la web. Guardamos el hash del token de la cookie.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    phone      TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

/** Guarda el mensaje. Devuelve false si ya lo habíamos recibido (webhook repetido). */
export function saveIncomingMessage(m: {
  id: string;
  sender: string;
  kind: "text" | "audio";
  body?: string;
}): boolean {
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO messages (id, sender, kind, body, received_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(m.id, m.sender, m.kind, m.body ?? null, Date.now());
  return result.changes === 1;
}
