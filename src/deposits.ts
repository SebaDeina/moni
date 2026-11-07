import type { Address } from "viem";
import { explorerTxUrl, findIncoming, latestBlock, treasuryAddress, type Incoming } from "./chain/index.js";
import { config } from "./config.js";
import { listContacts } from "./contacts.js";
import { db } from "./db/index.js";
import { formatAmount } from "./operations.js";

/**
 * Vigila Fuji y avisa por WhatsApp cuando entra AVAX o USDC a la wallet de un usuario.
 * Recuerda el último bloque revisado (tabla kv) y registra cada aviso (deposit_notices), así un
 * reinicio no repite avisos ni se saltea bloques.
 */
const CURSOR_KEY = "deposits.last_block";
/** Si el servidor estuvo caído mucho tiempo, no recorremos más que esto por vuelta. */
const MAX_BLOCKS_PER_TICK = 200n;

type Notify = (phone: string, text: string) => Promise<void>;

function getCursor(): bigint | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(CURSOR_KEY) as { value: string } | undefined;
  return row ? BigInt(row.value) : null;
}

function setCursor(block: bigint) {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    CURSOR_KEY,
    block.toString(),
  );
}

function walletOwners(): Map<string, string> {
  const rows = db.prepare("SELECT phone, address FROM wallets").all() as { phone: string; address: string }[];
  return new Map(rows.map((r) => [r.address.toLowerCase(), r.phone]));
}

function senderName(phone: string, from: Address): string {
  const contact = listContacts(phone).find((c) => c.address.toLowerCase() === from.toLowerCase());
  return contact ? contact.alias : `${from.slice(0, 6)}…${from.slice(-4)}`;
}

/** Revisa los bloques nuevos una vez. Devuelve cuántos avisos mandó. */
export async function checkDeposits(notify: Notify): Promise<number> {
  const owners = walletOwners();
  const latest = await latestBlock();
  const cursor = getCursor();
  // Primera vez: arrancamos desde ahora, sin avisar depósitos viejos.
  if (cursor === null || owners.size === 0) {
    setCursor(latest);
    return 0;
  }
  if (latest <= cursor) return 0;
  const from = cursor + 1n;
  const to = latest - from + 1n > MAX_BLOCKS_PER_TICK ? from + MAX_BLOCKS_PER_TICK - 1n : latest;

  const treasury = treasuryAddress()?.toLowerCase();
  const incoming = await findIncoming([...owners.keys()] as Address[], from, to);
  let sent = 0;
  for (const dep of incoming) {
    const phone = owners.get(dep.to.toLowerCase());
    if (!phone || dep.from.toLowerCase() === treasury) continue; // el saldo de bienvenida ya se avisa al crear la wallet
    if (!claim(dep, phone)) continue;
    await notify(phone, `💸 Te llegaron ${formatAmount(dep.amount, dep.token)} de ${senderName(phone, dep.from)}.\n${explorerTxUrl(dep.hash)}`).catch(
      (err) => console.error("[depósitos] no pude avisar", phone.slice(-4), String(err).slice(0, 200)),
    );
    sent++;
  }
  setCursor(to);
  return sent;
}

/** Registra el aviso; false si ya se había avisado ese depósito. */
function claim(dep: Incoming, phone: string): boolean {
  return (
    db
      .prepare("INSERT OR IGNORE INTO deposit_notices (tx_hash, log_index, phone, created_at) VALUES (?, ?, ?, ?)")
      .run(dep.hash, dep.logIndex, phone, Date.now()).changes === 1
  );
}

/** Arranca la vigilancia periódica. Una vuelta a la vez: si una tarda, la siguiente espera. */
export function startDepositWatcher(notify: Notify) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await checkDeposits(notify);
    } catch (err) {
      console.error("[depósitos] error revisando bloques", String(err).slice(0, 200));
    } finally {
      running = false;
    }
  };
  setInterval(tick, config.DEPOSIT_POLL_MS);
  void tick();
}
