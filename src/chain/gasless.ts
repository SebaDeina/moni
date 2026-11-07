/**
 * 0xGasless en Fuji: cada usuario opera con una smart account (ERC-4337, EntryPoint v0.6) cuyo
 * dueño es su clave (src/wallets.ts). Con OXGASLESS_API_KEY, el paymaster de 0xGasless paga el gas.
 * Sin la clave, la smart account paga su propio gas y la tesorería se lo recarga antes (index.ts):
 * en los dos casos el usuario nunca necesita AVAX para operar.
 */
import {
  Bundler,
  LocalAccountSigner,
  PaymasterMode,
  createECDSAOwnershipValidationModule,
  createSmartAccountClient,
  type ZeroXgaslessSmartAccount,
} from "#0xgasless";
import { createPublicClient, http, toHex, type Address, type Hex } from "viem";
import { avalancheFuji } from "viem/chains";
import type { PrivateKeyAccount } from "viem/accounts";
import { config, FUJI_CHAIN_ID } from "../config.js";

/**
 * Contratos de 0xGasless en Fuji (los mismos que usa @0xgasless/core). El SDK trae por defecto los
 * de mainnet; sin estos, la dirección contrafactual sale de un factory que en Fuji no existe.
 */
export const FUJI_AA = {
  entryPoint: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
  factory: "0xF0b3f5146c2725e36d78F5029bc560eDfc67ADe0",
  implementation: "0x8aF33bE7af021A6075aeB19b076fC75Bfbd2c5c3",
  fallbackHandler: "0xdA62055b0730d1d0621aD0A446DcD6057a6d951E",
  ecdsaModule: "0xcfb0BA514aa398085D63eC70cfEa6EC7f1094E8F",
} as const;

export type Call = { to: Address; value: bigint; data: Hex };

/** Con clave, el paymaster de 0xGasless patrocina el gas de las userOps. */
export const canSponsor = () => Boolean(config.OXGASLESS_API_KEY);

const paymasterUrl = () =>
  config.OXGASLESS_API_KEY ? `${config.OXGASLESS_PAYMASTER_URL.replace(/\/$/, "")}/${config.OXGASLESS_API_KEY}` : undefined;

const accounts = new Map<Address, Promise<ZeroXgaslessSmartAccount>>();

/** Cliente de la smart account de `owner` (cacheado por dueño). Exportado para scripts/gasless-smoke.ts. */
export function smartAccount(owner: PrivateKeyAccount): Promise<ZeroXgaslessSmartAccount> {
  let account = accounts.get(owner.address);
  if (!account) {
    account = (async () => {
      const signer = new LocalAccountSigner(owner);
      const module = await createECDSAOwnershipValidationModule({ signer, moduleAddress: FUJI_AA.ecdsaModule });
      return createSmartAccountClient({
        signer,
        // Bundler propio: Fuji cierra bloques en ~2 s y el SDK, sin config para 43113, consulta el recibo cada 5 s.
        bundler: new Bundler({
          bundlerUrl: config.OXGASLESS_BUNDLER_URL,
          chainId: FUJI_CHAIN_ID,
          userOpReceiptIntervals: { [FUJI_CHAIN_ID]: 1_000 },
          userOpReceiptMaxDurationIntervals: { [FUJI_CHAIN_ID]: 60_000 },
        }),
        bundlerUrl: config.OXGASLESS_BUNDLER_URL,
        paymasterUrl: paymasterUrl(),
        chainId: FUJI_CHAIN_ID,
        rpcUrl: config.FUJI_RPC_URL,
        factoryAddress: FUJI_AA.factory,
        implementationAddress: FUJI_AA.implementation,
        defaultFallbackHandler: FUJI_AA.fallbackHandler,
        defaultValidationModule: module,
        activeValidationModule: module,
      });
    })();
    account.catch(() => accounts.delete(owner.address));
    accounts.set(owner.address, account);
  }
  return account;
}

/** Dirección de la smart account de `owner`. Es fija: existe antes de desplegarse (la primera userOp la despliega). */
export async function smartAccountAddress(owner: PrivateKeyAccount): Promise<Address> {
  return (await smartAccount(owner)).getAccountAddress();
}

/** El paymaster no patrocinó la userOp y el bundler no la aceptó: no salió nada, se puede reintentar sin paymaster. */
export class SponsorshipRejected extends Error {
  constructor(reason: string) {
    super(`0xGasless no patrocinó la operación: ${reason}`);
  }
}

/**
 * Límites fijos para las userOps sin paymaster: el bundler de 0xGasless no estima gas en ese modo.
 * Holgados para el caso más pesado (desplegar la cuenta + approve + deposit + setContact + pay).
 * Lo que no se usa no se cobra; la cuenta solo necesita tener el máximo como prefondeo.
 */
const SELF_PAID_GAS = { callGasLimit: 600_000n, verificationGasLimit: 600_000n, preVerificationGas: 100_000n };

const rpc = createPublicClient({ chain: avalancheFuji, transport: http(config.FUJI_RPC_URL) });

/** Precio de gas: el que pide el bundler (si no, el de la red con margen). */
async function gasPrice(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  try {
    const res = await fetch(config.OXGASLESS_BUNDLER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skandha_getGasPrice", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
    if (body.result) return { maxFeePerGas: BigInt(body.result.maxFeePerGas), maxPriorityFeePerGas: BigInt(body.result.maxPriorityFeePerGas) };
  } catch {
    // seguimos con el precio de la red
  }
  const fees = await rpc.estimateFeesPerGas();
  return { maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
}

/** Sin paymaster: armamos la userOp con límites fijos, la firma el dueño y la cuenta paga su gas. */
async function sendSelfPaid(account: ZeroXgaslessSmartAccount, calls: Call[]) {
  // biome-ignore lint: métodos internos del SDK que no están en src/types (los usa también scripts/gasless-smoke.ts)
  const a = account as any;
  const price = await gasPrice();
  const userOp = {
    sender: await account.getAccountAddress(),
    nonce: toHex(await a.getNonce()),
    initCode: await a.getInitCode(),
    callData: await a.encodeExecuteBatch(
      calls.map((c) => c.to),
      calls.map((c) => c.value),
      calls.map((c) => c.data),
    ),
    callGasLimit: toHex(SELF_PAID_GAS.callGasLimit),
    verificationGasLimit: toHex(SELF_PAID_GAS.verificationGasLimit),
    preVerificationGas: toHex(SELF_PAID_GAS.preVerificationGas),
    maxFeePerGas: toHex(price.maxFeePerGas),
    maxPriorityFeePerGas: toHex(price.maxPriorityFeePerGas),
    paymasterAndData: "0x",
  };
  return a.sendUserOp(userOp) as ReturnType<typeof account.sendTransaction>;
}

/** Prefondeo máximo de una userOp sin paymaster: lo que la cuenta tiene que tener para que la acepten. */
export async function selfPaidMaxCost(): Promise<bigint> {
  const { maxFeePerGas } = await gasPrice();
  return (SELF_PAID_GAS.callGasLimit + SELF_PAID_GAS.verificationGasLimit + SELF_PAID_GAS.preVerificationGas) * maxFeePerGas;
}

export type UserOpResult = { userOpHash: Hex; txHash: Hex; success: boolean; reason?: string; sponsored: boolean };

/**
 * Manda `calls` en una sola userOp: patrocinada por el paymaster si hay clave, o pagada por la
 * propia smart account si no. `onSubmitted` recibe el hash de la userOp apenas el bundler la
 * acepta, para registrarlo antes de esperar el bloque.
 */
export async function sendUserOp(
  owner: PrivateKeyAccount,
  calls: Call[],
  onSubmitted?: (userOpHash: Hex) => void,
  { sponsored = canSponsor() }: { sponsored?: boolean } = {},
): Promise<UserOpResult> {
  const account = await smartAccount(owner);
  let res: Awaited<ReturnType<typeof account.sendTransaction>>;
  try {
    res = sponsored
      ? await account.sendTransaction(calls, { paymasterServiceData: { mode: PaymasterMode.SPONSORED } })
      : await sendSelfPaid(account, calls);
  } catch (err) {
    // Antes de que el bundler la acepte no salió nada: con paymaster, el que llama puede reintentar sin él.
    if (sponsored) throw new SponsorshipRejected(String((err as Error)?.message ?? err).slice(0, 200));
    throw err;
  }
  if (res.error || !res.userOpHash) {
    const reason = res.error?.message ?? "sin hash";
    if (sponsored) throw new SponsorshipRejected(reason);
    throw new Error(`0xGasless rechazó la operación: ${reason}`);
  }
  const userOpHash = res.userOpHash as Hex;
  onSubmitted?.(userOpHash);

  const receipt = await res.wait();
  const success = String(receipt.success) === "true";
  return {
    userOpHash,
    txHash: receipt.receipt.transactionHash as Hex,
    success,
    reason: success ? undefined : receipt.reason,
    sponsored,
  };
}
