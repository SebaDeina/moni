import { randomInt, randomUUID } from "node:crypto";
import { getAddress, isAddress } from "viem";
import { config } from "./config.js";
import { db } from "./db/index.js";

/** `shared`: viene de CONTACTS en el .env, la ven todos y no se puede borrar desde la app. */
export type Contact = { alias: string; address: `0x${string}`; shared: boolean };

/** Agenda compartida desde CONTACTS ("juan=0xabc...,maria=0xdef..."). */
function loadShared(): Contact[] {
  const contacts: Contact[] = [];
  for (const entry of (config.CONTACTS ?? "").split(",")) {
    const [alias, address] = entry.split("=").map((s) => s?.trim());
    if (!alias || !address) continue;
    if (!isAddress(address)) {
      console.warn(`[contactos] dirección inválida para "${alias}", la salteo`);
      continue;
    }
    contacts.push({ alias: alias.toLowerCase(), address: getAddress(address), shared: true });
  }
  return contacts;
}

const shared = loadShared();

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** Agenda de un usuario: la suya primero, después la compartida. */
export function listContacts(owner: string): Contact[] {
  const own = db
    .prepare("SELECT alias, address FROM contacts WHERE owner = ? ORDER BY alias")
    .all(owner) as { alias: string; address: `0x${string}` }[];
  return [...own.map((c) => ({ ...c, shared: false })), ...shared];
}

/** Solo coincidencias exactas de alias: un "Juan" ambiguo no alcanza para mandar plata. */
export function findContact(owner: string, alias: string): Contact | undefined {
  const wanted = normalize(alias);
  return listContacts(owner).find((c) => normalize(c.alias) === wanted);
}

export function listAliases(owner: string): string[] {
  return listContacts(owner).map((c) => c.alias);
}

/** Valida un contacto nuevo. Devuelve el error para mostrar, o los datos normalizados. */
export function validateContact(
  owner: string,
  aliasInput: string,
  addressInput: string,
): { error: string } | { alias: string; address: `0x${string}` } {
  const alias = aliasInput.trim().toLowerCase().replace(/\s+/g, " ");
  const address = addressInput.trim();
  if (!/^[\p{L}\p{N} ._-]{1,30}$/u.test(alias)) {
    return { error: "El nombre tiene que tener entre 1 y 30 letras, números o espacios." };
  }
  if (!isAddress(address)) return { error: "La dirección no es válida: tiene que empezar con 0x y tener 40 caracteres hex." };
  if (findContact(owner, alias)) return { error: `Ya tenés a "${alias}" en la agenda.` };
  return { alias, address: getAddress(address) };
}

/** Agrega directo (lo usa la web, donde la sesión ya se validó con un código por WhatsApp). */
export function addContact(owner: string, aliasInput: string, addressInput: string): { error: string } | { contact: Contact } {
  const valid = validateContact(owner, aliasInput, addressInput);
  if ("error" in valid) return valid;
  db.prepare("INSERT INTO contacts (owner, alias, address) VALUES (?, ?, ?)").run(owner, valid.alias, valid.address);
  return { contact: { ...valid, shared: false } };
}

export function removeContact(owner: string, alias: string): boolean {
  const wanted = normalize(alias);
  const own = listContacts(owner).find((c) => !c.shared && normalize(c.alias) === wanted);
  if (!own) return false;
  return db.prepare("DELETE FROM contacts WHERE owner = ? AND alias = ?").run(owner, own.alias).changes === 1;
}

const CONTACT_CODE_TTL_MS = 2 * 60 * 1000;

/** Desde el chat: deja el contacto pendiente hasta que el usuario responda "SI <código>". */
export function proposeContact(
  owner: string,
  aliasInput: string,
  addressInput: string,
): { error: string } | { code: string; alias: string; address: `0x${string}` } {
  const valid = validateContact(owner, aliasInput, addressInput);
  if ("error" in valid) return valid;
  const code = String(randomInt(100000, 1000000));
  const now = Date.now();
  db.prepare(
    "INSERT INTO contact_requests (id, owner, alias, address, code, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(randomUUID(), owner, valid.alias, valid.address, code, now + CONTACT_CODE_TTL_MS, now);
  return { code, ...valid };
}

/**
 * Si el código corresponde a un contacto pendiente, lo agrega y devuelve la respuesta para el
 * usuario. Un solo UPDATE ... RETURNING: dos confirmaciones simultáneas no lo agregan dos veces.
 * Devuelve null si el código no es de un contacto.
 */
export function confirmContact(owner: string, code: string): string | null {
  const now = Date.now();
  const req = db
    .prepare(
      `UPDATE contact_requests SET consumed_at = ?
       WHERE owner = ? AND code = ? AND consumed_at IS NULL AND expires_at > ?
       RETURNING alias, address`,
    )
    .get(now, owner, code, now) as { alias: string; address: string } | undefined;
  if (!req) return null;
  const added = addContact(owner, req.alias, req.address);
  if ("error" in added) return added.error;
  return `Listo, agendé a ${added.contact.alias} (${added.contact.address.slice(0, 6)}…${added.contact.address.slice(-4)}).`;
}
