/**
 * Prueba de humo de src/chain contra Fuji. Solo lectura: no firma ni envía nada.
 * Uso: WALLET_PRIVATE_KEY=0x... npx tsx scripts/chain-smoke.ts
 */
import * as chain from "../src/chain/index.js";

const fmt = (ms: number) => new Date(ms).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

console.log("wallet:", chain.walletAddress());
for (const p of ["today", "week", "month"] as const) console.log(`desde (${p}):`, fmt(chain.periodStart(p)));
console.log("saldo:", chain.formatAvax(await chain.getBalance()), "AVAX");

const week = await chain.weeklyOutflow();
console.log("semana → enviado:", chain.formatAvax(week.sentWei), "AVAX | gas:", chain.formatAvax(week.gasWei), "AVAX");

const txs = await chain.listTransactions("month");
console.log(`transacciones del mes: ${txs.length}`);
for (const tx of txs.slice(0, 5)) {
  console.log(` ${fmt(tx.timestamp)} ${tx.direction} ${chain.formatAvax(tx.valueWei)} ${tx.success ? "ok" : "FALLÓ"} ${chain.explorerTxUrl(tx.hash)}`);
}

const to = "0x000000000000000000000000000000000000dEaD";
console.log("¿alcanza para 0.01 AVAX?", await chain.canAfford(chain.parseAvax("0.01"), to));

// Parseo del historial contra una dirección con movimiento: `npx tsx scripts/chain-smoke.ts 0x...`
const other = process.argv[2] as `0x${string}` | undefined;
if (other) {
  const recent = await chain.listTransactionsOf(other, Date.now() - 10 * 60 * 1000);
  console.log(`\n${other}: ${recent.length} transacciones en 10 min`);
  for (const tx of recent.slice(0, 3)) console.log(" ", tx);
}
