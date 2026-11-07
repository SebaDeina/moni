import type Anthropic from "@anthropic-ai/sdk";
import { formatEther, parseEther } from "viem";
import * as chain from "../chain/index.js";
import { consumeConfirmation, parseConfirmation } from "../confirmations.js";
import { findContact, listAliases } from "../contacts.js";
import { executeConfirmedOperation, proposeTransfer } from "../operations.js";
import { config } from "../config.js";
import { MODEL, claude } from "./llm.js";
import { tools } from "./tools.js";

type Message = Anthropic.Beta.BetaMessageParam;

const MAX_TOOL_ROUNDS = 5;
/** Modelos que aceptan `fallbacks: "default"` en la API de Claude. */
const SUPPORTS_FALLBACK = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(MODEL);
const HISTORY_TURNS = 10;
const HISTORY_TTL_MS = 30 * 60 * 1000;
/** Tope por transferencia. Es testnet, pero evita que un error de tipeo vacíe la wallet de la demo. */
const MAX_TRANSFER_WEI = parseEther("10");

const SYSTEM_PROMPT = `Sos Moni, una billetera que se usa por WhatsApp. Hablás en castellano rioplatense, con mensajes cortos y claros, como en un chat.

La wallet es de prueba: AVAX en la red Avalanche Fuji (testnet). Decilo si alguien pregunta por plata real.

Reglas:
- Usá solo las herramientas para saldos, movimientos y transferencias. Nunca inventes montos, direcciones ni hashes.
- Para mandar plata, usá propose_native_transfer con el alias exacto de la agenda y el monto en AVAX. Si el contacto no existe o es ambiguo, preguntá; mostrá los contactos disponibles.
- Vos nunca enviás plata: propose_native_transfer devuelve un código y el usuario confirma respondiendo "SI <código>". Decíselo con el código exacto y aclaralo: vence en 2 minutos.
- Si piden algo en pesos o dólares, explicá que por ahora Moni opera en AVAX y pedí el monto en AVAX.
- Si una herramienta dice que algo todavía no está disponible, decilo tal cual, sin inventar el resultado.
- "Qué gasté" son dos cosas separadas: lo enviado en transacciones exitosas y el gas pagado (incluidas las fallidas).`;

const histories = new Map<string, { messages: Message[]; updatedAt: number }>();

function getHistory(sender: string): Message[] {
  const h = histories.get(sender);
  if (!h || Date.now() - h.updatedAt > HISTORY_TTL_MS) return [];
  return h.messages;
}

/** Guardamos solo pares de texto (usuario, respuesta final): sin herramientas ni bloques de razonamiento. */
function saveHistory(sender: string, turns: Message[]) {
  histories.set(sender, { messages: turns.slice(-HISTORY_TURNS * 2), updatedAt: Date.now() });
}

const avax = (wei: bigint) => `${formatEther(wei)} AVAX`;

async function runTool(sender: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case "get_balance":
        return { balance: avax(await chain.getBalance()) };

      case "list_transactions": {
        const period = args.period === "today" || args.period === "month" ? args.period : "week";
        const txs = await chain.listTransactions(period);
        return txs.slice(0, 20).map((t) => ({
          direccion: t.direction === "in" ? "entrada" : "salida",
          monto: avax(t.valueWei),
          gas: avax(t.gasWei),
          contraparte: t.counterparty,
          exitosa: t.success,
          fecha: new Date(t.timestamp).toISOString(),
          link: chain.explorerTxUrl(t.hash),
        }));
      }

      case "weekly_outflow": {
        const w = await chain.weeklyOutflow();
        return { enviado: avax(w.sentWei), gas: avax(w.gasWei), desde: new Date(w.since).toISOString() };
      }

      case "propose_native_transfer": {
        const alias = String(args.alias ?? "");
        const amountText = String(args.amountAvax ?? "").replace(",", ".");
        const contact = findContact(alias);
        if (!contact) return { error: `No tengo a "${alias}" en la agenda.`, contactos: listAliases() };
        if (!/^\d+(\.\d{1,18})?$/.test(amountText)) return { error: "Monto inválido. Pedí el monto en AVAX, por ejemplo 0.5." };
        const amountWei = parseEther(amountText);
        if (amountWei <= 0n) return { error: "El monto tiene que ser mayor a cero." };
        if (amountWei > MAX_TRANSFER_WEI) return { error: `El máximo por transferencia es ${avax(MAX_TRANSFER_WEI)}.` };
        try {
          if (!(await chain.canAfford(amountWei, contact.address))) {
            return { error: "No alcanza el saldo para ese monto más el gas." };
          }
        } catch (err) {
          if (!(err instanceof chain.NotImplemented)) throw err;
        }
        const { code } = proposeTransfer(sender, contact, amountWei);
        return { codigo: code, destino: contact.alias, direccion: contact.address, monto: avax(amountWei), vence_en: "2 minutos" };
      }

      default:
        return { error: `Herramienta desconocida: ${name}` };
    }
  } catch (err) {
    if (err instanceof chain.NotImplemented) return { error: "Esta función todavía no está disponible en Moni." };
    console.error(`[agente] falló ${name}`, err);
    return { error: "Hubo un error consultando la red. Probá de nuevo en un rato." };
  }
}

/** Recibe el texto del usuario (o la transcripción de su audio) y devuelve la respuesta. */
export async function handleUserText(sender: string, text: string): Promise<string> {
  // La confirmación la resuelve el backend, nunca el modelo.
  const code = parseConfirmation(text);
  if (code) {
    const operationId = consumeConfirmation(sender, code);
    if (!operationId) return "Ese código no es válido o ya venció. Pedime la transferencia de nuevo.";
    return executeConfirmedOperation(sender, operationId);
  }

  const history = getHistory(sender);
  const messages: Message[] = [...history, { role: "user", content: text }];
  const finish = (answer: string) => {
    saveHistory(sender, [...history, { role: "user", content: text }, { role: "assistant", content: answer }]);
    return answer;
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await claude.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
      cache_control: { type: "ephemeral" },
      output_config: { effort: config.MONI_CLAUDE_EFFORT },
      // Si el modelo declina por una política de seguridad, la API reintenta con otro modelo.
      // Solo algunos modelos lo aceptan (Haiku no).
      ...(SUPPORTS_FALLBACK ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });

    if (response.stop_reason === "refusal") return finish("Con eso no te puedo ayudar.");
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const answer = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      return finish(answer || "No te entendí, ¿me lo decís de otra forma?");
    }

    // El turno completo vuelve tal cual (incluye los bloques de razonamiento), y todos los resultados juntos.
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of toolUses) {
      const result = await runTool(sender, call.name, (call.input ?? {}) as Record<string, unknown>);
      const isError = typeof result === "object" && result !== null && "error" in result;
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result), is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }

  return "Me trabé procesando eso. ¿Lo probamos de nuevo?";
}
