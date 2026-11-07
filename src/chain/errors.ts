/**
 * Falta configuración para operar (por ejemplo, WALLET_PRIVATE_KEY). El agente y la web lo
 * muestran como "todavía no disponible" en lugar de un error.
 */
export class NotImplemented extends Error {
  constructor(what: string) {
    super(`chain: falta configurar ${what}`);
  }
}
