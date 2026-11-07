/**
 * Prueba de humo de src/chain contra Fuji. Solo lectura: no firma ni envía nada.
 * Uso: npx tsx --env-file=.env scripts/chain-smoke.ts 0x<dirección>
 */
import { getAddress } from "viem";
import * as chain from "../src/chain/index.js";

const fmt = (ms: number) => new Date(ms).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

const arg = process.argv[2] ?? chain.treasuryAddress();
if (!arg) throw new Error("Pasá una dirección o configurá WALLET_PRIVATE_KEY");
const address = getAddress(arg);

console.log("dirección:", address);
for (const p of ["today", "week", "month"] as const) console.log(`desde (${p}):`, fmt(chain.periodStart(p)));
console.log("saldo:", chain.formatAvax(await chain.getBalance(address)), "AVAX");

const week = await chain.weeklyOutflow(address);
console.log("semana → enviado:", chain.formatAvax(week.sentWei), "AVAX | gas:", chain.formatAvax(week.gasWei), "AVAX");

const txs = await chain.listTransactions(address, "month");
console.log(`movimientos del mes: ${txs.length}`);
for (const tx of txs.slice(0, 8)) {
  console.log(
    ` ${fmt(tx.timestamp)} ${tx.direction} ${chain.formatAvax(tx.valueWei)} ${tx.direction === "out" ? "→" : "←"} ${tx.counterparty} ${tx.success ? "ok" : "FALLÓ"} ${chain.explorerTxUrl(tx.hash)}`,
  );
}
console.log("¿alcanza para 0.01 AVAX?", (await chain.canSend(address, "AVAX", chain.parseAvax("0.01"))).ok);
