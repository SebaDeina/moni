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

// ---------- Login al revés: la web muestra el código y el usuario lo manda desde WhatsApp ----------

export const WA_LOGIN_TTL_MS = 5 * 60 * 1000;

/** Crea un login pendiente. El nonce va en una cookie del navegador; el código, en el mensaje de WhatsApp. */
export function createWaLogin(): { nonce: string; code: string } {
  const now = Date.now();
  db.prepare("DELETE FROM wa_logins WHERE expires_at < ?").run(now - CODE_WINDOW_MS);
  const nonce = randomBytes(32).toString("hex");
  // Código único entre los vigentes, así un mensaje no puede habilitar dos navegadores.
  let code: string;
  do code = String(randomInt(100000, 1000000));
  while (db.prepare("SELECT 1 FROM wa_logins WHERE code = ? AND expires_at > ?").get(code, now));
  db.prepare("INSERT INTO wa_logins (nonce_hash, code, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    sha256(nonce),
    code,
    now + WA_LOGIN_TTL_MS,
    now,
  );
  return { nonce, code };
}

/** El código existe, está vigente y nadie lo usó todavía. */
export function isWaLoginPending(code: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM wa_logins WHERE code = ? AND phone IS NULL AND expires_at > ?").get(code, Date.now()));
}

/** Llegó "Entrar a Moni: <código>" desde WhatsApp: el login queda a nombre de ese número (una sola vez). */
export function claimWaLogin(phone: string, code: string): boolean {
  const now = Date.now();
  const claimed = db
    .prepare("UPDATE wa_logins SET phone = ?, claimed_at = ? WHERE code = ? AND phone IS NULL AND expires_at > ?")
    .run(phone, now, code, now);
  return claimed.changes === 1;
}

export type WaLoginStatus = { status: "pending"; code: string; expiresAt: number } | { status: "ready"; phone: string } | { status: "expired" };

/** Lo consulta el navegador que pidió el login. Cuando ya llegó el mensaje, lo consume y devuelve el número. */
export function checkWaLogin(nonce: string | undefined): WaLoginStatus {
  if (!nonce) return { status: "expired" };
  const now = Date.now();
  const row = db
    .prepare("SELECT code, phone, expires_at FROM wa_logins WHERE nonce_hash = ? AND consumed_at IS NULL AND expires_at > ?")
    .get(sha256(nonce), now) as { code: string; phone: string | null; expires_at: number } | undefined;
  if (!row) return { status: "expired" };
  if (!row.phone) return { status: "pending", code: row.code, expiresAt: row.expires_at };
  const consumed = db
    .prepare("UPDATE wa_logins SET consumed_at = ? WHERE nonce_hash = ? AND consumed_at IS NULL")
    .run(now, sha256(nonce));
  return consumed.changes === 1 ? { status: "ready", phone: row.phone } : { status: "expired" };
}

/** "Entrar a Moni: 123456" (como lo arma el link de la web), con o sin dos puntos o espacios de más. */
export function parseWaLoginMessage(text: string | undefined): string | null {
  const m = /^\s*entrar\s+a\s+moni\W*(\d{6})\s*$/i.exec(text ?? "");
  return m ? m[1] : null;
}
