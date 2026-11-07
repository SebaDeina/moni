/**
 * Tipos mínimos de @0xgasless/smart-account-sdk 0.0.15, solo lo que usa src/chain/gasless.ts.
 * Los .d.ts del paquete reexportan rutas sin extensión ("./account") y con NodeNext no resuelven;
 * el import "#0xgasless" de package.json usa este archivo para los tipos y el paquete real en runtime.
 */
import type { Hex, LocalAccount, PrivateKeyAccount } from "viem";

export declare class LocalAccountSigner<T extends PrivateKeyAccount | LocalAccount> {
  constructor(inner: T);
  inner: T;
  getAddress(): Promise<`0x${string}`>;
}

export declare enum PaymasterMode {
  ERC20 = "ERC20",
  SPONSORED = "SPONSORED",
}

export interface ValidationModule {
  getAddress(): Hex;
}

export declare function createECDSAOwnershipValidationModule(config: {
  signer: LocalAccountSigner<PrivateKeyAccount>;
  moduleAddress?: Hex;
}): Promise<ValidationModule>;

export type Transaction = { to: string; value?: bigint; data?: string };

export type UserOpReceipt = {
  userOpHash: string;
  success: "true" | "false" | boolean;
  reason: string;
  receipt: { transactionHash: string };
};

export type UserOpResponse = {
  userOpHash: string | null;
  error?: { message: string; code: number };
  wait(confirmations?: number): Promise<UserOpReceipt>;
};

export declare class ZeroXgaslessSmartAccount {
  getAccountAddress(): Promise<`0x${string}`>;
  sendTransaction(
    tx: Transaction | Transaction[],
    options?: { paymasterServiceData?: { mode: PaymasterMode } },
  ): Promise<UserOpResponse>;
}

export declare class Bundler {
  constructor(config: {
    bundlerUrl: string;
    chainId: number;
    /** Cada cuánto consultar el recibo, en ms, por chainId. */
    userOpReceiptIntervals?: Record<number, number>;
    /** Cuánto esperar el recibo como máximo, en ms, por chainId. */
    userOpReceiptMaxDurationIntervals?: Record<number, number>;
  });
}

export declare function createSmartAccountClient(config: {
  signer: LocalAccountSigner<PrivateKeyAccount>;
  bundler?: Bundler;
  bundlerUrl: string;
  paymasterUrl?: string;
  chainId: number;
  rpcUrl?: string;
  factoryAddress?: Hex;
  implementationAddress?: Hex;
  defaultFallbackHandler?: Hex;
  defaultValidationModule?: ValidationModule;
  activeValidationModule?: ValidationModule;
}): Promise<ZeroXgaslessSmartAccount>;
