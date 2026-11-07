/**
 * Todo lo que toca Avalanche Fuji. Dueño: el dev de Avalanche.
 * El agente y el backend solo usan estas funciones; ninguna otra parte importa viem.
 * Montos siempre en wei (bigint).
 *
 * - Saldo y gas: RPC de Fuji (viem), porque al firmar necesitamos el dato del momento.
 * - Historial y salidas de la semana: Avalanche Data API, que ya trae las transacciones
 *   de la wallet indexadas y filtradas por fecha.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  parseAbi,
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

/**
 * Falta configuración para operar (por ejemplo, WALLET_PRIVATE_KEY). El agente y la web lo
 * muestran como "todavía no disponible" en lugar de un error.
 */
export class NotImplemented extends Error {
  constructor(what: string) {
    super(`chain: falta configurar ${what}`);
  }
}

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

/**
 * Transacciones nativas de `address` desde `sinceMs`, de la más nueva a la más vieja.
 * Solo lectura; exportada para poder probar contra cualquier dirección de Fuji.
 */
export async function listTransactionsOf(address: Address, sinceMs: number): Promise<ChainTx[]> {
  const me = getAddress(address);
  const out: ChainTx[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      pageSize: String(PAGE_SIZE),
      startTimestamp: String(Math.floor(sinceMs / 1000)),
      endTimestamp: String(Math.floor(Date.now() / 1000)),
    };
    if (pageToken) params.pageToken = pageToken;

    const body = NativeTxPage.parse(await dataApi(`/addresses/${me}/transactions:listNative`, params));
    for (const tx of body.transactions) out.push(toChainTx(tx, me));

    pageToken = body.nextPageToken;
    if (!pageToken || body.transactions.length === 0) return out;
  }
  console.warn(`[chain] historial cortado en ${MAX_PAGES * PAGE_SIZE} transacciones`);
  return out;
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

/** Costo máximo de gas de una transferencia: límite estimado por el precio máximo que aceptaríamos pagar. */
async function maxGasCost(from: Address, amountWei: bigint, to: Address): Promise<bigint> {
  const [gas, fees] = await Promise.all([
    publicClient.estimateGas({ account: from, to, value: amountWei }),
    publicClient.estimateFeesPerGas(),
  ]);
  return gas * fees.maxFeePerGas;
}

/** Chequea que alcance el saldo para monto + gas antes de proponer o firmar. */
export async function canAfford(from: Address, amountWei: bigint, to: `0x${string}`): Promise<boolean> {
  if (amountWei <= 0n) return false;
  const balance = await getBalance(from);
  if (balance < amountWei) return false; // ni siquiera alcanza el monto: no hace falta estimar gas
  return balance >= amountWei + (await maxGasCost(from, amountWei, to));
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

/** Alcanza el saldo del token, y el AVAX para el gas. */
export async function canAffordToken(from: Address, token: Token, amount: bigint, to: Address): Promise<boolean> {
  const tokenAddress = TOKENS[token].address;
  if (!tokenAddress) return canAfford(from, amount, to);
  if (amount <= 0n) return false;
  if ((await getTokenBalance(from, token)) < amount) return false;
  const [gas, fees, avax] = await Promise.all([
    publicClient.estimateContractGas({ account: from, address: tokenAddress, abi: erc20, functionName: "transfer", args: [to, amount] }),
    publicClient.estimateFeesPerGas(),
    getBalance(from),
  ]);
  return avax >= gas * fees.maxFeePerGas;
}

/** Envía AVAX o un token. Mismas garantías que sendNativeTransfer (hash guardado antes de transmitir). */
export async function sendTransfer(args: {
  account: PrivateKeyAccount;
  token: Token;
  to: `0x${string}`;
  amount: bigint;
  onPrepared: (p: { nonce: number; hash: `0x${string}` }) => void;
}): Promise<`0x${string}`> {
  const tokenAddress = TOKENS[args.token].address;
  if (!tokenAddress) {
    return sendNativeTransfer({ account: args.account, to: args.to, amountWei: args.amount, onPrepared: args.onPrepared });
  }
  if (!isAddress(args.to)) throw new Error(`Dirección inválida: ${args.to}`);
  if (args.amount <= 0n) throw new Error("El monto tiene que ser mayor a cero");
  const data = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [getAddress(args.to), args.amount] });
  return signAndSend({ account: args.account, to: tokenAddress, data, onPrepared: args.onPrepared });
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
