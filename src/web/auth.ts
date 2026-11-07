import { createHash, randomBytes, randomInt } from "node:crypto";
import { db } from "../db/index.js";

const CODE_TTL_MS = 5 * 60 * 1000;
const CODES_PER_WINDOW = 3;
const CODE_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Genera un código de login. Devuelve null si ya se pidieron demasiados en los últimos 10 minutos. */
export function createLoginCode(phone: string): string | null {
  const now = Date.now();
  const recent = db
    .prepare("SELECT COUNT(*) AS n FROM auth_codes WHERE phone = ? AND created_at > ?")
    .get(phone, now - CODE_WINDOW_MS) as { n: number };
  if (recent.n >= CODES_PER_WINDOW) return null;

  const code = String(randomInt(100000, 1000000));
  db.prepare("INSERT INTO auth_codes (phone, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    phone,
    sha256(`${phone}:${code}`),
    now + CODE_TTL_MS,
    now,
  );
  return code;
}

/** Verifica el último código vigente del número. Cada intento fallido cuenta; a los 5 se invalida. */
export function verifyLoginCode(phone: string, code: string): boolean {
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT rowid AS id, code_hash, attempts FROM auth_codes
       WHERE phone = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(phone, now) as { id: number; code_hash: string; attempts: number } | undefined;
  if (!row || row.attempts >= MAX_ATTEMPTS) return false;

  if (row.code_hash !== sha256(`${phone}:${code}`)) {
    db.prepare("UPDATE auth_codes SET attempts = attempts + 1 WHERE rowid = ?").run(row.id);
    return false;
  }
  const consumed = db
    .prepare("UPDATE auth_codes SET consumed_at = ? WHERE rowid = ? AND consumed_at IS NULL")
    .run(now, row.id);
  return consumed.changes === 1;
}

export function createSession(phone: string): string {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (token_hash, phone, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    sha256(token),
    phone,
    now + SESSION_TTL_MS,
    now,
  );
  return token;
}

export function sessionPhone(token: string | undefined): string | null {
  if (!token) return null;
  const row = db
    .prepare("SELECT phone FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .get(sha256(token), Date.now()) as { phone: string } | undefined;
  return row?.phone ?? null;
}

export function deleteSession(token: string | undefined) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}
