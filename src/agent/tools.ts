import type Anthropic from "@anthropic-ai/sdk";

/**
 * Las cuatro herramientas cerradas del agente. Ninguna firma: proponer una transferencia
 * solo genera un código que el usuario confirma por fuera del modelo.
 */
export const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_balance",
    description: "Saldo de AVAX de la wallet del usuario en Fuji.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "list_transactions",
    description: "Historial de transacciones de la wallet.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { period: { type: "string", enum: ["today", "week", "month"] } },
      required: ["period"],
      additionalProperties: false,
    },
  },
  {
    name: "weekly_outflow",
    description:
      "Cuánto salió desde el lunes (hora de Buenos Aires): valor enviado en transacciones exitosas y gas pagado, por separado.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "propose_native_transfer",
    description:
      "Prepara una transferencia de AVAX a un contacto de la agenda. No firma: devuelve un código que el usuario debe responder con 'SI <código>'.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Alias exacto de la agenda." },
        amountAvax: { type: "string", description: "Monto en AVAX como texto decimal, por ejemplo '0.25'." },
      },
      required: ["alias", "amountAvax"],
      additionalProperties: false,
    },
  },
];
