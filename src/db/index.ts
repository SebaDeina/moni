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

  -- Estado chico del servidor (por ejemplo, el último bloque revisado por el vigilante de depósitos).
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Depósitos ya avisados por WhatsApp: un aviso por (transacción, log) aunque se revisen bloques dos veces.
  CREATE TABLE IF NOT EXISTS deposit_notices (
    tx_hash    TEXT NOT NULL,
    log_index  INTEGER NOT NULL,
    phone      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
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

  -- Login de la web al revés: la web muestra un código y el usuario lo manda desde su WhatsApp.
  -- nonce_hash es el hash del valor de la cookie del navegador que lo pidió; phone se completa al llegar el mensaje.
  CREATE TABLE IF NOT EXISTS wa_logins (
    nonce_hash  TEXT PRIMARY KEY,
    code        TEXT NOT NULL,
    phone       TEXT,
    expires_at  INTEGER NOT NULL,
    claimed_at  INTEGER,
    consumed_at INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wa_logins_code ON wa_logins (code, expires_at);

  -- Sesiones de la web. Guardamos el hash del token de la cookie.
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    phone      TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Columnas agregadas después de crear las tablas (las bases existentes no las tienen).
function addColumn(table: string, column: string, type: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn("operations", "token", "TEXT NOT NULL DEFAULT 'AVAX'");
// Smart account (0xGasless) de cada wallet: es la dirección del usuario. `address` queda como su dueño (EOA).
addColumn("wallets", "sa_address", "TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS wallets_sa_address ON wallets (sa_address)");
// Barrido único del saldo que tenía la EOA hacia la smart account.
addColumn("wallets", "sweep_tx", "TEXT");
// Hash de la userOp, conocido antes de que entre en un bloque.
addColumn("operations", "user_op_hash", "TEXT");

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
