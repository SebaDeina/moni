/**
 * Todo lo que toca Avalanche Fuji. Dueño: el dev de Avalanche.
 * El agente y el backend solo usan estas funciones; ninguna otra parte importa viem.
 * Montos siempre en wei (bigint).
 *
 * - Saldo: RPC de Fuji (viem), porque al firmar necesitamos el dato del momento.
 * - Envíos de los usuarios: userOps desde su smart account de 0xGasless, a través de MoniVault (gasless.ts).
 * - Historial y salidas de la semana: Avalanche Data API, que ya trae las transacciones
 *   de la wallet indexadas y filtradas por fecha.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  parseEventLogs,
  parseUnits,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEther,
  type Address,
  type Hash,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { z } from "zod";
import { config, FUJI_CHAIN_ID } from "../config.js";
import { NotImplemented } from "./errors.js";
import { SponsorshipRejected, canSponsor, selfPaidMaxCost, sendUserOp, type Call, type UserOpResult } from "./gasless.js";

export { NotImplemented };
export { canSponsor, smartAccountAddress } from "./gasless.js";

export type Period = "today" | "week" | "month";

export type ChainTx = {
  hash: `0x${string}`;
  direction: "in" | "out";
  counterparty: `0x${string}`;
  valueWei: bigint;
  gasWei: bigint;
  success: boolean;
  timestamp: number;
};

export type WeeklyOutflow = {
  /** Valor enviado en transacciones exitosas. */
  sentWei: bigint;
  /** Gas pagado, incluidas las fallidas. */
  gasWei: bigint;
  /** Lunes 00:00 hora de Buenos Aires, en ms. */
  since: number;
};


// ---------------------------------------------------------------------------
// Clientes

if (avalancheFuji.id !== FUJI_CHAIN_ID) throw new Error("viem no apunta a Fuji");

const transport = http(config.FUJI_RPC_URL, { timeout: 15_000, retryCount: 2 });
const publicClient = createPublicClient({ chain: avalancheFuji, transport });

// La wallet de WALLET_PRIVATE_KEY es la tesorería: fondea con un poco de AVAX las wallets nuevas
// de los usuarios para que puedan pagar el gas. Cada usuario opera con su propia wallet (src/wallets.ts).
let treasuryAccount: PrivateKeyAccount | undefined;
export function treasury(): PrivateKeyAccount {
  if (!config.WALLET_PRIVATE_KEY) throw new NotImplemented("WALLET_PRIVATE_KEY");
  treasuryAccount ??= privateKeyToAccount(config.WALLET_PRIVATE_KEY as `0x${string}`);
  return treasuryAccount;
}

/** Dirección de la tesorería, para mostrar. null si todavía no hay clave configurada. */
export function treasuryAddress(): Address | null {
  return config.WALLET_PRIVATE_KEY ? treasury().address : null;
}

/**
 * El RPC configurado tiene que ser Fuji. Si alguien apunta FUJI_RPC_URL a mainnet,
 * preferimos fallar antes que firmar nada.
 */
let chainChecked = false;
async function assertFuji(): Promise<void> {
  if (chainChecked) return;
  const id = await publicClient.getChainId();
  if (id !== FUJI_CHAIN_ID) throw new Error(`FUJI_RPC_URL apunta a la red ${id}, no a Fuji (${FUJI_CHAIN_ID})`);
  chainChecked = true;
}

// ---------------------------------------------------------------------------
// Fechas en hora de Buenos Aires (UTC-3 fijo; Argentina no usa horario de verano desde 2009)

const BA_OFFSET_MS = -3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Inicio del período en ms, medido en hora de Buenos Aires. */
export function periodStart(period: Period, now = Date.now()): number {
  const local = new Date(now + BA_OFFSET_MS); // sus campos UTC son la hora local de BA
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  let startLocal: number;
  if (period === "today") {
    startLocal = midnight;
  } else if (period === "week") {
    const daysSinceMonday = (local.getUTCDay() + 6) % 7; // domingo = 0 → 6
    startLocal = midnight - daysSinceMonday * DAY_MS;
  } else {
    startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  }
  return startLocal - BA_OFFSET_MS;
}

// ---------------------------------------------------------------------------
// Avalanche Data API

const DATA_API = `https://glacier-api.avax.network/v1/chains/${FUJI_CHAIN_ID}`;
const PAGE_SIZE = 100;
/** Tope de páginas por consulta, para que una wallet con mucho movimiento no cuelgue la respuesta. */
const MAX_PAGES = 10;

const NativeTx = z.object({
  txHash: z.string(),
  txStatus: z.string(),
  gasUsed: z.string(),
  gasPrice: z.string(),
  blockTimestamp: z.number(),
  from: z.object({ address: z.string() }),
  to: z.object({ address: z.string() }).optional(),
  value: z.string(),
});
const NativeTxPage = z.object({
  transactions: z.array(NativeTx),
  nextPageToken: z.string().optional(),
});

async function dataApi(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${DATA_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.AVALANCHE_DATA_API_KEY) headers["x-glacier-api-key"] = config.AVALANCHE_DATA_API_KEY;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Data API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const InternalTx = z.object({
  txHash: z.string(),
  blockTimestamp: z.number(),
  from: z.object({ address: z.string() }),
  to: z.object({ address: z.string() }),
  value: z.string(),
  isReverted: z.boolean(),
});
const InternalTxPage = z.object({
  transactions: z.array(InternalTx),
  nextPageToken: z.string().optional(),
});

/** Recorre las páginas de un listado del Data API desde `sinceMs`. */
async function paged<T>(path: string, sinceMs: number, parse: (body: unknown) => { transactions: T[]; nextPageToken?: string }) {
  const out: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      pageSize: String(PAGE_SIZE),
      startTimestamp: String(Math.floor(sinceMs / 1000)),
      endTimestamp: String(Math.floor(Date.now() / 1000)),
    };
    if (pageToken) params.pageToken = pageToken;
    const body = parse(await dataApi(path, params));
    out.push(...body.transactions);
    pageToken = body.nextPageToken;
    if (!pageToken || body.transactions.length === 0) return out;
  }
  console.warn(`[chain] historial cortado en ${MAX_PAGES * PAGE_SIZE} transacciones (${path})`);
  return out;
}

/**
 * Movimientos de AVAX de `address` desde `sinceMs`, del más nuevo al más viejo.
 *
 * Una smart account casi nunca es `from` de una transacción (la manda el bundler al EntryPoint),
 * así que sus envíos y cobros aparecen como transacciones internas. Juntamos las nativas (por
 * ejemplo, el saldo de bienvenida) con las internas que mueven valor. Los pagos por MoniVault se
 * ven como "smart account → bóveda" y "bóveda → destinatario": con el evento Paid del recibo
 * mostramos a la persona del otro lado en lugar de la bóveda.
 */
export async function listTransactionsOf(address: Address, sinceMs: number): Promise<ChainTx[]> {
  const me = getAddress(address);
  const [native, internal] = await Promise.all([
    paged(`/addresses/${me}/transactions:listNative`, sinceMs, (b) => NativeTxPage.parse(b)),
    paged(`/addresses/${me}/transactions:listInternals`, sinceMs, (b) => InternalTxPage.parse(b)),
  ]);

  // Llamadas entrantes sin valor (por ejemplo, del EntryPoint) no son movimientos del usuario.
  const out = native.map((tx) => toChainTx(tx, me)).filter((t) => t.direction === "out" || t.valueWei > 0n);
  const seen = new Set(out.map((t) => `${t.hash}:${t.direction}`));
  for (const tx of internal) {
    if (BigInt(tx.value) === 0n) continue;
    const from = getAddress(tx.from.address);
    const to = getAddress(tx.to.address);
    if (from !== me && to !== me) continue;
    const t: ChainTx = {
      hash: tx.txHash as Hash,
      direction: from === me ? "out" : "in",
      counterparty: from === me ? to : from,
      valueWei: BigInt(tx.value),
      gasWei: 0n, // lo pagó el paymaster
      success: !tx.isReverted,
      timestamp: tx.blockTimestamp * 1000,
    };
    const key = `${t.hash}:${t.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }

  await resolveVaultCounterparties(out, me);
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

const VAULT_ABI = parseAbi([
  "function depositNative() payable",
  "function setContact(address contact, bool allowed)",
  "function pay(address token, address to, uint256 amount, string memo)",
  "function isContact(address user, address contact) view returns (bool)",
  "event Paid(address indexed from, address indexed to, address indexed token, uint256 amount, uint256 week, string memo)",
]);
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";
/** Tope de recibos que leemos por consulta para resolver pagos de la bóveda. */
const MAX_RECEIPTS = 25;
/** Los recibos no cambian: cacheamos el pago (de, a) de cada transacción. */
const paidCache = new Map<Hash, { from: Address; to: Address }[]>();

async function paidEvents(hash: Hash) {
  let paid = paidCache.get(hash);
  if (!paid) {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const vault = getAddress(config.MONI_VAULT_ADDRESS);
    paid = parseEventLogs({ abi: VAULT_ABI, eventName: "Paid", logs: receipt.logs })
      .filter((l) => getAddress(l.address) === vault)
      .map((l) => ({ from: getAddress(l.args.from), to: getAddress(l.args.to) }));
    paidCache.set(hash, paid);
  }
  return paid;
}

async function resolveVaultCounterparties(txs: ChainTx[], me: Address) {
  const vault = getAddress(config.MONI_VAULT_ADDRESS);
  const viaVault = txs.filter((t) => t.counterparty === vault).slice(0, MAX_RECEIPTS);
  await Promise.all(
    viaVault.map(async (t) => {
      try {
        const paid = await paidEvents(t.hash);
        const mine = paid.find((p) => (t.direction === "out" ? p.from === me : p.to === me));
        if (mine) t.counterparty = t.direction === "out" ? mine.to : mine.from;
      } catch (err) {
        console.warn("[chain] no pude leer el recibo", t.hash, String(err).slice(0, 120));
      }
    }),
  );
}

function toChainTx(tx: z.infer<typeof NativeTx>, me: Address): ChainTx {
  const from = getAddress(tx.from.address);
  const to = tx.to ? getAddress(tx.to.address) : from; // sin `to`: creación de contrato
  const outgoing = from === me;
  return {
    hash: tx.txHash as Hash,
    direction: outgoing ? "out" : "in",
    counterparty: outgoing ? to : from,
    valueWei: BigInt(tx.value),
    // El gas lo paga quien envía. gasPrice del Data API es el precio efectivo (coincide con el recibo).
    gasWei: outgoing ? BigInt(tx.gasUsed) * BigInt(tx.gasPrice) : 0n,
    success: tx.txStatus === "1",
    timestamp: tx.blockTimestamp * 1000,
  };
}

// ---------------------------------------------------------------------------
// API del módulo

/** Saldo de AVAX de una wallet. */
export async function getBalance(address: Address): Promise<bigint> {
  return publicClient.getBalance({ address });
}

/** Historial de una wallet, paginado por el Data API. */
export async function listTransactions(address: Address, period: Period): Promise<ChainTx[]> {
  return listTransactionsOf(address, periodStart(period));
}

/** Salidas y gas de una wallet desde el lunes, hora de Buenos Aires. */
export async function weeklyOutflow(address: Address): Promise<WeeklyOutflow> {
  const since = periodStart("week");
  const txs = await listTransactionsOf(address, since);
  let sentWei = 0n;
  let gasWei = 0n;
  for (const tx of txs) {
    if (tx.direction !== "out") continue;
    gasWei += tx.gasWei; // también las fallidas: el gas se paga igual
    if (tx.success) sentWei += tx.valueWei;
  }
  return { sentWei, gasWei, since };
}

/**
 * Firma y transmite. Debe guardar nonce y hash (vía `onPrepared`) ANTES de transmitir,
 * para que un timeout o un reintento no manden dos veces.
 */
export async function sendNativeTransfer(args: {
  /** Quién firma: la wallet del usuario, o la tesorería al fondear una wallet nueva. */
  account: PrivateKeyAccount;
  to: `0x${string}`;
  amountWei: bigint;
  onPrepared: (p: { nonce: number; hash: `0x${string}` }) => void;
}): Promise<`0x${string}`> {
  if (!isAddress(args.to)) throw new Error(`Dirección inválida: ${args.to}`);
  if (args.amountWei <= 0n) throw new Error("El monto tiene que ser mayor a cero");
  return signAndSend({ account: args.account, to: args.to, value: args.amountWei, onPrepared: args.onPrepared });
}

/** Firma localmente, avisa nonce y hash por `onPrepared` y recién después transmite. */
async function signAndSend(args: {
  account: PrivateKeyAccount;
  to: `0x${string}`;
  value?: bigint;
  data?: `0x${string}`;
  onPrepared: (p: { nonce: number; hash: `0x${string}` }) => void;
}): Promise<`0x${string}`> {
  await assertFuji();

  const signer = args.account;
  const walletClient = createWalletClient({ account: signer, chain: avalancheFuji, transport });

  const nonce = await publicClient.getTransactionCount({ address: signer.address, blockTag: "pending" });
  const request = await walletClient.prepareTransactionRequest({
    to: getAddress(args.to),
    value: args.value ?? 0n,
    data: args.data,
    nonce,
  });
  if (request.chainId !== FUJI_CHAIN_ID) throw new Error(`chainId inesperado: ${request.chainId}`);

  // Firmamos localmente para conocer el hash antes de transmitir.
  const serializedTransaction = await walletClient.signTransaction(request);
  const hash = keccak256(serializedTransaction);
  args.onPrepared({ nonce, hash });

  try {
    await publicClient.sendRawTransaction({ serializedTransaction });
  } catch (err) {
    // Si el nodo ya la tenía (reintento de la misma firma), la transferencia sigue siendo esta.
    if (!/already known/i.test(String(err))) throw err;
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Tokens: AVAX nativo y USDC de Circle en Fuji (ERC-20, 6 decimales). El gas siempre se paga en AVAX.

export type Token = "AVAX" | "USDC";
export const TOKENS: Record<Token, { decimals: number; address: Address | null }> = {
  AVAX: { decimals: 18, address: null },
  USDC: { decimals: 6, address: "0x5425890298aed601595a70AB815c96711a31Bc65" },
};
export const isToken = (t: unknown): t is Token => t === "AVAX" || t === "USDC";

const erc20 = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/** Monto en unidades mínimas del token ("12,5" USDC → 12500000). Lanza si no es un monto válido. */
export function parseTokenAmount(amount: string, token: Token): bigint {
  const clean = amount.trim().replace(",", ".");
  const { decimals } = TOKENS[token];
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(clean)) throw new Error(`Monto inválido: ${amount}`);
  return parseUnits(clean, decimals);
}

export const formatTokenAmount = (units: bigint, token: Token) => formatUnits(units, TOKENS[token].decimals);

export async function getTokenBalance(address: Address, token: Token): Promise<bigint> {
  const tokenAddress = TOKENS[token].address;
  if (!tokenAddress) return getBalance(address);
  return publicClient.readContract({ address: tokenAddress, abi: erc20, functionName: "balanceOf", args: [address] });
}


// La tesorería firma de a una transacción por vez: dos envíos simultáneos pedirían el mismo nonce.
let treasuryQueue: Promise<unknown> = Promise.resolve();
function serializeTreasury<T>(fn: () => Promise<T>): Promise<T> {
  const run = treasuryQueue.then(fn, fn);
  treasuryQueue = run.catch(() => undefined);
  return run;
}

/** AVAX desde la tesorería (saldo de bienvenida, recargas de gas). */
export function sendFromTreasury(to: Address, amountWei: bigint, onPrepared: (p: { nonce: number; hash: `0x${string}` }) => void = () => {}) {
  return serializeTreasury(() => sendNativeTransfer({ account: treasury(), to, amountWei, onPrepared }));
}

// ---------------------------------------------------------------------------
// Envíos de los usuarios: smart account → MoniVault, en una sola userOp

/** AVAX que dejamos en la smart account para pagar su propio gas cuando no hay paymaster. */
const USEROP_GAS_RESERVE = parseUnits("0.01", 18);

const VAULT_TOKEN_ABI = parseAbi([
  "function deposit(address token, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/**
 * Las llamadas a MoniVault de un pago: depositar el monto (USDC necesita approve antes), agendar al
 * destinatario en el contrato (solo si todavía no está) y pagarle. Van juntas en una userOp, así
 * son atómicas: si `pay` revierte (por ejemplo, por el tope semanal), el depósito también.
 */
export async function vaultPaymentCalls(from: Address, toInput: `0x${string}`, token: Token, amount: bigint, memo: string): Promise<Call[]> {
  const vault = getAddress(config.MONI_VAULT_ADDRESS);
  const to = getAddress(toInput);
  const tokenAddress = TOKENS[token].address;
  const known = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "isContact", args: [from, to] });
  const calls: Call[] = tokenAddress
    ? [
        { to: tokenAddress, value: 0n, data: encodeFunctionData({ abi: VAULT_TOKEN_ABI, functionName: "approve", args: [vault, amount] }) },
        { to: vault, value: 0n, data: encodeFunctionData({ abi: VAULT_TOKEN_ABI, functionName: "deposit", args: [tokenAddress, amount] }) },
      ]
    : [{ to: vault, value: amount, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "depositNative" }) }];
  if (!known) calls.push({ to: vault, value: 0n, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "setContact", args: [to, true] }) });
  calls.push({
    to: vault,
    value: 0n,
    data: encodeFunctionData({ abi: VAULT_ABI, functionName: "pay", args: [tokenAddress ?? NATIVE_TOKEN, to, amount, memo] }),
  });
  return calls;
}

/** La smart account ya está desplegada (tiene código). */
export async function isDeployed(address: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address });
  return Boolean(code && code !== "0x");
}

/**
 * Despliega la smart account con una userOp vacía que paga ella misma (la tesorería le recarga el
 * gas si hace falta). El paymaster de 0xGasless en Fuji rechaza la primera userOp de una cuenta
 * (AA33: no le alcanza el gas para desplegarla); ya desplegada, patrocina sin problemas.
 */
export async function deploySmartAccount(owner: PrivateKeyAccount, address: Address): Promise<Hash | null> {
  if (await isDeployed(address)) return null;
  await topUpForUserOp(address, "USDC", 0n); // USDC: solo el gas, sin monto en AVAX
  const result = await sendUserOp(owner, [{ to: address, value: 0n, data: "0x" }], undefined, { sponsored: false });
  if (!result.success) throw new Error(`No se pudo desplegar la cuenta: ${result.reason ?? "revirtió"}`);
  return result.txHash;
}

/** Gas cubierto por Moni: paymaster de 0xGasless o, si no hay clave, recarga desde la tesorería. */
const gasCovered = () => canSponsor() || (config.SPONSOR_GAS && treasuryAddress() !== null);

/** Alcanza para enviar: el usuario solo necesita lo que manda; el gas lo cubre Moni. */
export async function canSend(from: Address, token: Token, amount: bigint): Promise<{ ok: boolean; reason?: "saldo" | "gas" }> {
  if (amount <= 0n) return { ok: false, reason: "saldo" };
  if ((await getTokenBalance(from, token)) < amount) return { ok: false, reason: "saldo" };
  if (canSponsor() && !(config.SPONSOR_GAS && treasuryAddress() !== null)) return { ok: true };
  if (!gasCovered()) {
    // Sin paymaster ni recarga: la smart account paga su gas con su propio AVAX.
    const need = USEROP_GAS_RESERVE + (TOKENS[token].address ? 0n : amount);
    return (await getBalance(from)) >= need ? { ok: true } : { ok: false, reason: "gas" };
  }
  return (await getBalance(treasury().address)) >= USEROP_GAS_RESERVE ? { ok: true } : { ok: false, reason: "gas" };
}

/** Sin paymaster: la tesorería le deja a la smart account el AVAX para su gas (y espera la confirmación). */
async function topUpForUserOp(from: Address, token: Token, amount: bigint): Promise<void> {
  if (!config.SPONSOR_GAS || treasuryAddress() === null) return;
  // El EntryPoint exige que la cuenta cubra el máximo posible (límites × precio), con margen.
  const maxCost = await selfPaidMaxCost();
  const reserve = maxCost * 3n / 2n > USEROP_GAS_RESERVE ? maxCost * 3n / 2n : USEROP_GAS_RESERVE;
  const need = reserve + (TOKENS[token].address ? 0n : amount);
  const balance = await getBalance(from);
  if (balance >= need) return;
  const hash = await sendFromTreasury(from, need - balance);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
  if (receipt.status !== "success") throw new Error("La recarga de gas no se confirmó");
}

/**
 * Paga desde la smart account del usuario a través de MoniVault, en una sola userOp: deposita el
 * monto, agenda al destinatario en el contrato si hace falta y paga. El gas lo cubre Moni.
 */
export async function sendViaVault(args: {
  owner: PrivateKeyAccount;
  /** Smart account del usuario (la que paga). */
  from: Address;
  token: Token;
  to: `0x${string}`;
  amount: bigint;
  memo: string;
  onSubmitted: (userOpHash: Hash) => void;
}): Promise<UserOpResult> {
  if (!isAddress(args.to)) throw new Error(`Dirección inválida: ${args.to}`);
  if (args.amount <= 0n) throw new Error("El monto tiene que ser mayor a cero");
  await assertFuji();
  const calls = await vaultPaymentCalls(args.from, args.to, args.token, args.amount, args.memo);
  let result: UserOpResult | null = null;
  // Una cuenta sin desplegar no la patrocina el paymaster de Fuji: ese primer envío va por el respaldo (y la despliega).
  if (canSponsor() && (await isDeployed(args.from))) {
    try {
      result = await sendUserOp(args.owner, calls, args.onSubmitted, { sponsored: true });
    } catch (err) {
      // Si 0xGasless no la patrocina, no salió nada: la mandamos con la tesorería pagando el gas.
      if (!(err instanceof SponsorshipRejected)) throw err;
      console.warn("[chain] paymaster rechazó, sigo con la tesorería:", err.message);
    }
  }
  if (!result) {
    await topUpForUserOp(args.from, args.token, args.amount);
    result = await sendUserOp(args.owner, calls, args.onSubmitted, { sponsored: false });
  }
  if (!result.success) throw new Error(`La operación revirtió en la cadena${result.reason ? `: ${result.reason}` : ""}`);
  return result;
}

/**
 * Pasa todo lo que tenía una wallet común (EOA) a otra dirección: primero el USDC, después el AVAX,
 * pagando el gas con ese mismo saldo. Lo usamos una vez por usuario para mover lo que tenían las
 * wallets de antes de 0xGasless a su smart account. Devuelve el último hash, o null si no había nada.
 */
export async function sweepToSmartAccount(account: PrivateKeyAccount, to: Address): Promise<Hash | null> {
  await assertFuji();
  const walletClient = createWalletClient({ account, chain: avalancheFuji, transport });
  let last: Hash | null = null;

  const usdc = await getTokenBalance(account.address, "USDC");
  if (usdc > 0n) {
    // Si la wallet vieja no tiene AVAX para el gas del transfer, la tesorería le manda lo justo.
    const [gas, fees, avax] = await Promise.all([
      publicClient.estimateContractGas({ account: account.address, address: TOKENS.USDC.address!, abi: erc20, functionName: "transfer", args: [getAddress(to), usdc] }),
      publicClient.estimateFeesPerGas(),
      getBalance(account.address),
    ]);
    const needed = gas * fees.maxFeePerGas * 2n;
    if (avax < needed && treasuryAddress() !== null) {
      const topUp = await sendFromTreasury(account.address, needed - avax);
      await publicClient.waitForTransactionReceipt({ hash: topUp, timeout: 30_000 });
    }
    last = await walletClient.writeContract({ address: TOKENS.USDC.address!, abi: erc20, functionName: "transfer", args: [getAddress(to), usdc] });
    await publicClient.waitForTransactionReceipt({ hash: last, timeout: 30_000 });
  }

  const [balance, fees] = await Promise.all([getBalance(account.address), publicClient.estimateFeesPerGas()]);
  const gas = 21_000n;
  const maxFeePerGas = fees.maxFeePerGas * 2n; // margen: lo que no se usa, queda en la wallet
  const value = balance - gas * maxFeePerGas;
  if (value <= 0n) return last;
  return walletClient.sendTransaction({ to: getAddress(to), value, gas, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
}

// ---------------------------------------------------------------------------
// Depósitos entrantes (para avisar por WhatsApp)

export type Incoming = {
  hash: `0x${string}`;
  /** Índice del log para USDC; -1 para AVAX nativo. Junto con el hash identifica el depósito. */
  logIndex: number;
  token: Token;
  from: Address;
  to: Address;
  amount: bigint;
  blockNumber: bigint;
};

const transferEvent = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"])[0];
const paidEvent = parseAbi([
  "event Paid(address indexed from, address indexed to, address indexed token, uint256 amount, uint256 week, string memo)",
])[0];

export async function latestBlock(): Promise<bigint> {
  // Sin el cache de viem (4 s por defecto): el vigilante necesita el bloque de este momento.
  return publicClient.getBlockNumber({ cacheTime: 0 });
}

/**
 * AVAX y USDC que entraron a alguna de `wallets` entre `fromBlock` y `toBlock` (inclusive).
 * USDC sale de los eventos Transfer; AVAX, de recorrer las transacciones de cada bloque.
 */
export async function findIncoming(wallets: Address[], fromBlock: bigint, toBlock: bigint): Promise<Incoming[]> {
  if (wallets.length === 0 || fromBlock > toBlock) return [];
  const mine = new Set(wallets.map((w) => w.toLowerCase()));
  const out: Incoming[] = [];

  const logs = await publicClient.getLogs({
    address: TOKENS.USDC.address!,
    event: transferEvent,
    args: { to: wallets },
    fromBlock,
    toBlock,
  });
  const vault = getAddress(config.MONI_VAULT_ADDRESS);
  for (const log of logs) {
    if (!log.args.to || !mine.has(log.args.to.toLowerCase()) || !log.args.value) continue;
    // Los pagos por MoniVault se avisan con el evento Paid (que dice quién pagó), no con el Transfer de la bóveda.
    if (log.args.from && getAddress(log.args.from) === vault) continue;
    out.push({
      hash: log.transactionHash,
      logIndex: log.logIndex,
      token: "USDC",
      from: getAddress(log.args.from!),
      to: getAddress(log.args.to),
      amount: log.args.value,
      blockNumber: log.blockNumber,
    });
  }

  // Pagos por MoniVault (AVAX o USDC): la bóveda le transfiere al destinatario dentro de la transacción.
  const paid = await publicClient.getLogs({ address: vault, event: paidEvent, args: { to: wallets }, fromBlock, toBlock });
  for (const log of paid) {
    if (!log.args.to || !mine.has(log.args.to.toLowerCase()) || !log.args.amount) continue;
    out.push({
      hash: log.transactionHash,
      logIndex: log.logIndex,
      token: log.args.token && getAddress(log.args.token) === getAddress(TOKENS.USDC.address!) ? "USDC" : "AVAX",
      from: getAddress(log.args.from!),
      to: getAddress(log.args.to),
      amount: log.args.amount,
      blockNumber: log.blockNumber,
    });
  }

  for (let n = fromBlock; n <= toBlock; n++) {
    const block = await publicClient.getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of block.transactions) {
      if (!tx.to || tx.value === 0n || !mine.has(tx.to.toLowerCase())) continue;
      const receipt = await publicClient.getTransactionReceipt({ hash: tx.hash });
      if (receipt.status !== "success") continue;
      out.push({ hash: tx.hash, logIndex: -1, token: "AVAX", from: getAddress(tx.from), to: getAddress(tx.to), amount: tx.value, blockNumber: n });
    }
  }
  return out;
}

/** Espera a que la transacción entre en un bloque. Devuelve si fue exitosa. */
export async function waitForTransfer(hash: `0x${string}`, timeoutMs = 30_000): Promise<boolean> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  return receipt.status === "success";
}

/** Pasa AVAX en texto decimal ("0.25") a wei. Lanza si el texto no es un monto válido. */
export function parseAvax(amount: string): bigint {
  const clean = amount.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,18})?$/.test(clean)) throw new Error(`Monto inválido: ${amount}`);
  return parseEther(clean);
}

/** Wei a AVAX en texto, para mostrar. */
export const formatAvax = (wei: bigint) => formatEther(wei);

export const explorerTxUrl = (hash: string) => `https://testnet.snowtrace.io/tx/${hash}`;
export const explorerAddressUrl = (address: string) => `https://testnet.snowtrace.io/address/${address}`;
