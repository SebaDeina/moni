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
import type { Address, Hex } from "viem";
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
    res = await account.sendTransaction(calls, sponsored ? { paymasterServiceData: { mode: PaymasterMode.SPONSORED } } : undefined);
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
