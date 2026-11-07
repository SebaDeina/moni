import { isAddress } from "viem";
import { config } from "./config.js";

export type Contact = { alias: string; address: `0x${string}` };

/** Agenda compartida desde CONTACTS ("juan=0xabc...,maria=0xdef..."). */
function loadContacts(): Contact[] {
  const contacts: Contact[] = [];
  for (const entry of (config.CONTACTS ?? "").split(",")) {
    const [alias, address] = entry.split("=").map((s) => s?.trim());
    if (!alias || !address) continue;
    if (!isAddress(address)) {
      console.warn(`[contactos] dirección inválida para "${alias}", la salteo`);
      continue;
    }
    contacts.push({ alias: alias.toLowerCase(), address });
  }
  return contacts;
}

const contacts = loadContacts();

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** Solo coincidencias exactas de alias: un "Juan" ambiguo no alcanza para mandar plata. */
export function findContact(alias: string): Contact | undefined {
  const wanted = normalize(alias);
  return contacts.find((c) => normalize(c.alias) === wanted);
}

export function listAliases(): string[] {
  return contacts.map((c) => c.alias);
}
