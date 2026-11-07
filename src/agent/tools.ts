import type Anthropic from "@anthropic-ai/sdk";

/**
 * Las herramientas cerradas del agente. Ninguna firma ni escribe: proponer una transferencia o un
 * contacto solo genera un código que el usuario confirma por fuera del modelo.
 */
export const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: "create_wallet",
    description:
      "Crea la wallet del usuario en Avalanche Fuji (una por número, una smart account sin gas) y le manda un saldo de bienvenida. Si ya tiene, devuelve la que tiene.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "get_wallet",
    description: "Dirección de la wallet del usuario, para que la comparta. Si no tiene, lo dice.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "get_balance",
    description: "Saldo de la wallet del usuario en Fuji: AVAX y USDC.",
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
      "Cuánto salió desde el lunes (hora de Buenos Aires): valor enviado en transacciones exitosas y gas pagado por el usuario (con Moni es 0: lo cubre Moni).",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "list_contacts",
    description: "Agenda del usuario: nombre y dirección de cada contacto al que se le puede mandar plata.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "propose_add_contact",
    description:
      "Prepara agendar un contacto nuevo (nombre + dirección 0x de Avalanche). No lo agrega: devuelve un código que el usuario debe responder con 'SI <código>'.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Nombre corto para el contacto, por ejemplo 'caro'." },
        address: { type: "string", description: "Dirección 0x de 40 caracteres hex, tal como la escribió el usuario." },
      },
      required: ["alias", "address"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_transfer",
    description:
      "Prepara una transferencia de AVAX o USDC a un contacto de la agenda. No firma: devuelve un código que el usuario debe responder con 'SI <código>'.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Alias exacto de la agenda." },
        amount: { type: "string", description: "Monto como texto decimal, por ejemplo '0.25' o '10'." },
        token: { type: "string", enum: ["AVAX", "USDC"], description: "Moneda. USDC es el dólar digital." },
      },
      required: ["alias", "amount", "token"],
      additionalProperties: false,
    },
  },
];
