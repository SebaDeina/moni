/**
 * Prueba de 0xGasless contra Fuji, con una clave descartable.
 *
 *   npx tsx --env-file=.env scripts/gasless-smoke.ts
 *     Patrocinada: una userOp de 0 AVAX que despliega la smart account. No gasta AVAX.
 *     Necesita OXGASLESS_API_KEY (la clave del paymaster).
 *
 *   npx tsx --env-file=.env scripts/gasless-smoke.ts --self-paid
 *     Sin paymaster: prueba todo lo demás (bundler, despliegue, pago por MoniVault, recibo y
 *     actividad). La tesorería le manda 0.01 AVAX a la smart account, que paga su propio gas y le
 *     paga 0.001 AVAX a la tesorería a través de MoniVault. Es lo que hace un envío de Moni, salvo el paymaster.
 */
import { createPublicClient, http, parseEther, toHex } from "viem";
import { avalancheFuji } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as chain from "../src/chain/index.js";
import { sendSponsored, smartAccount, smartAccountAddress } from "../src/chain/gasless.js";

const selfPaid = process.argv.includes("--self-paid");
const owner = privateKeyToAccount(generatePrivateKey());
const sa = await smartAccountAddress(owner);
console.log("dueño (EOA):  ", owner.address);
console.log("smart account:", sa, chain.explorerAddressUrl(sa));

const t0 = Date.now();
const ms = () => `${Date.now() - t0} ms`;

if (!selfPaid) {
  const r = await sendSponsored(owner, [{ to: sa, value: 0n, data: "0x" }], (h) => console.log("userOp aceptada:", h, ms()));
  console.log("tx:", chain.explorerTxUrl(r.txHash), r.success ? "OK" : `FALLÓ ${r.reason}`, ms());
  process.exit(0);
}

const treasury = chain.treasury();
const fundHash = await chain.sendNativeTransfer({ account: treasury, to: sa, amountWei: parseEther("0.01"), onPrepared: () => {} });
console.log("fondeo:", chain.explorerTxUrl(fundHash));
await chain.waitForTransfer(fundHash);
console.log("saldo de la smart account:", chain.formatAvax(await chain.getBalance(sa)), "AVAX", ms());

// Las mismas llamadas que un envío de Moni. El bundler de 0xGasless no estima gas sin paymaster
// (en el flujo patrocinado lo calcula el paymaster), así que acá van límites fijos.
// biome-ignore lint: API interna del SDK, sin tipos en src/types
const account = (await smartAccount(owner)) as any;
const calls = await chain.vaultPaymentCalls(sa, treasury.address, parseEther("0.001"), "Moni smoke");
const rpc = createPublicClient({ chain: avalancheFuji, transport: http(process.env.FUJI_RPC_URL) });
const fees = await rpc.estimateFeesPerGas();
const userOp = {
  sender: sa,
  nonce: toHex(await account.getNonce()),
  initCode: await account.getInitCode(),
  callData: await account.encodeExecuteBatch(calls.map((c) => c.to), calls.map((c) => c.value), calls.map((c) => c.data)),
  callGasLimit: toHex(400_000),
  verificationGasLimit: toHex(600_000),
  preVerificationGas: toHex(100_000),
  maxFeePerGas: toHex(fees.maxFeePerGas * 2n),
  maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas),
  paymasterAndData: "0x",
};
const res = await account.sendUserOp(userOp);
console.log("userOp aceptada:", res.userOpHash, ms());
const receipt = await res.wait();
const ok = String(receipt.success) === "true";
console.log("pago por MoniVault:", chain.explorerTxUrl(receipt.receipt.transactionHash), ok ? "OK" : `FALLÓ ${receipt.reason}`, ms());
const after = await chain.getBalance(sa);
console.log("saldo después:", chain.formatAvax(after), "AVAX | gas pagado por la smart account:", chain.formatAvax(parseEther("0.009") - after), "AVAX");

// El Data API tarda unos segundos en indexar.
await new Promise((ok) => setTimeout(ok, 8_000));
const txs = await chain.listTransactions(sa, "today");
console.log(`actividad de la smart account (${txs.length}):`);
for (const t of txs) console.log(` ${t.direction} ${chain.formatAvax(t.valueWei)} AVAX ${t.direction === "out" ? "→" : "←"} ${t.counterparty} ${t.success ? "ok" : "FALLÓ"}`);
