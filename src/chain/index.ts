/**
 * Todo lo que toca Avalanche Fuji. Dueño: el dev de Avalanche.
 * El agente y el backend solo usan estas funciones; ninguna otra parte importa viem.
 * Montos siempre en wei (bigint).
 */

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

class NotImplemented extends Error {
  constructor(fn: string) {
    super(`chain.${fn} no implementado`);
  }
}

/** Saldo de AVAX de la wallet de la demo. */
export async function getBalance(): Promise<bigint> {
  // TODO(avalanche): viem publicClient en Fuji (config.FUJI_RPC_URL) o Avalanche Data API.
  throw new NotImplemented("getBalance");
}

/** Historial de la wallet, paginado por el Data API. */
export async function listTransactions(period: Period): Promise<ChainTx[]> {
  void period;
  throw new NotImplemented("listTransactions");
}

/** Salidas y gas desde el lunes, hora de Buenos Aires. */
export async function weeklyOutflow(): Promise<WeeklyOutflow> {
  throw new NotImplemented("weeklyOutflow");
}

/** Chequea que alcance el saldo para monto + gas antes de proponer o firmar. */
export async function canAfford(amountWei: bigint, to: `0x${string}`): Promise<boolean> {
  void amountWei;
  void to;
  throw new NotImplemented("canAfford");
}

/**
 * Firma y transmite. Debe guardar nonce y hash (vía `onPrepared`) ANTES de transmitir,
 * para que un timeout o un reintento no manden dos veces.
 */
export async function sendNativeTransfer(args: {
  to: `0x${string}`;
  amountWei: bigint;
  onPrepared: (p: { nonce: number; hash: `0x${string}` }) => void;
}): Promise<`0x${string}`> {
  void args;
  throw new NotImplemented("sendNativeTransfer");
}

export const explorerTxUrl = (hash: string) => `https://testnet.snowtrace.io/tx/${hash}`;
