import type Anthropic from "@anthropic-ai/sdk";
import { formatEther } from "viem";
import * as chain from "../chain/index.js";
import { consumeConfirmation, parseConfirmation } from "../confirmations.js";
import { confirmContact, listContacts, proposeContact } from "../contacts.js";
import { executeConfirmedOperation, prepareTransfer } from "../operations.js";
import { NoWallet, createWallet, getWallet } from "../wallets.js";
import { config } from "../config.js";
import { MODEL, claude } from "./llm.js";
import { tools } from "./tools.js";

type Message = Anthropic.Beta.BetaMessageParam;

const MAX_TOOL_ROUNDS = 5;
/** Modelos que aceptan `fallbacks: "default"` en la API de Claude. */
const SUPPORTS_FALLBACK = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/.test(MODEL);
const HISTORY_TURNS = 10;
const HISTORY_TTL_MS = 30 * 60 * 1000;

const SYSTEM_PROMPT = `Sos Moni, una billetera que se usa por WhatsApp. Hablás en castellano rioplatense.

Cómo escribís:
- Respuestas cortas: una o dos frases, como un mensaje de chat. El número primero, la razón después si hace falta.
- Sin saludos largos, sin repetir lo que dijo el usuario y sin ofrecer menús ni preguntas al final ("¿querés que…?"), salvo que necesites un dato para seguir.
- La wallet es de prueba (AVAX en Avalanche Fuji, testnet). Aclaralo solo si preguntan por plata real.
- Si el pedido es claro, hacelo directo: para un envío, el "SI <código>" ya es la confirmación, no pidas confirmar dos veces. Preguntá solo si falta un dato o es ambiguo (monto, moneda o contacto).

Reglas:
- Usá solo las herramientas para saldos, movimientos y transferencias. Nunca inventes montos, direcciones ni hashes.
- Moni maneja dos monedas: AVAX y USDC (dólar digital). "Dólares", "usd", "dolarcitos" son USDC. El gas siempre se paga en AVAX.
- Para mandar plata, usá propose_transfer con el alias exacto de la agenda, el monto y la moneda. Si el contacto no existe o es ambiguo, preguntá; mostrá los contactos disponibles.
- Vos nunca enviás plata: propose_transfer devuelve un código y el usuario confirma respondiendo "SI <código>". Decíselo en una línea con el código exacto (vence en 2 minutos).
- Para agendar a alguien, usá propose_add_contact con el nombre y la dirección 0x que te pasaron, y pedí el mismo "SI <código>". Nunca inventes ni completes una dirección: si falta o está incompleta, pedila.
- Para saber a quién se le puede mandar, usá list_contacts.
- Cada número tiene su propia wallet. Si el usuario todavía no tiene, ofrecele crearla; si te lo pide ("crear wallet", "quiero una billetera"), usá create_wallet. Para "¿cuál es mi dirección?", usá get_wallet: mostrá la dirección completa para que la pueda copiar y compartir.
- Si piden algo en pesos, explicá que por ahora Moni opera en AVAX y USDC, y pedí el monto en una de esas.
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

/** Para mostrar: como mucho 4 decimales ("0.4999999998" → "0.5 AVAX"). Lo exacto queda en el explorer. */
const avax = (wei: bigint) => {
  const n = Number(formatEther(wei));
  return `${n > 0 && n < 0.0001 ? "< 0.0001" : Number(n.toFixed(4))} AVAX`;
};

/** La wallet del usuario para consultar; si no tiene, NoWallet (el modelo le sugiere crearla). */
function walletOf(sender: string) {
  const wallet = getWallet(sender);
  if (!wallet) throw new NoWallet();
  return wallet;
}

async function runTool(sender: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case "create_wallet": {
        const { wallet, created, funding } = await createWallet(sender);
        return {
          nueva: created,
          direccion: wallet.address,
          link: wallet.url,
          saldo_inicial: funding && "amount" in funding ? `${funding.amount} (${funding.txUrl})` : undefined,
          aviso: funding && "error" in funding ? funding.error : undefined,
        };
      }

      case "get_wallet": {
        const wallet = getWallet(sender);
        return wallet ? { direccion: wallet.address, link: wallet.url } : { error: new NoWallet().message };
      }

      case "get_balance": {
        const address = walletOf(sender).address;
        const [avaxWei, usdc] = await Promise.all([chain.getBalance(address), chain.getTokenBalance(address, "USDC")]);
        return { AVAX: avax(avaxWei), USDC: `${Number(Number(chain.formatTokenAmount(usdc, "USDC")).toFixed(2))} USDC` };
      }

      case "list_transactions": {
        const period = args.period === "today" || args.period === "month" ? args.period : "week";
        const txs = await chain.listTransactions(walletOf(sender).address, period);
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
        const w = await chain.weeklyOutflow(walletOf(sender).address);
        return { enviado: avax(w.sentWei), gas: avax(w.gasWei), desde: new Date(w.since).toISOString() };
      }

      case "list_contacts":
        return listContacts(sender).map((c) => ({ nombre: c.alias, direccion: c.address, compartido: c.shared }));

      case "propose_add_contact": {
        const proposed = proposeContact(sender, String(args.alias ?? ""), String(args.address ?? ""));
        if ("error" in proposed) return proposed;
        return { codigo: proposed.code, nombre: proposed.alias, direccion: proposed.address, vence_en: "2 minutos" };
      }

      case "propose_transfer": {
        const prepared = await prepareTransfer(sender, String(args.alias ?? ""), String(args.amount ?? ""), args.token);
        if ("error" in prepared) return prepared;
        return { codigo: prepared.code, destino: prepared.alias, direccion: prepared.address, monto: prepared.amount, vence_en: "2 minutos" };
      }

      default:
        return { error: `Herramienta desconocida: ${name}` };
    }
  } catch (err) {
    if (err instanceof NoWallet) return { error: err.message };
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
    if (operationId) return executeConfirmedOperation(sender, operationId);
    const contactReply = confirmContact(sender, code);
    if (contactReply) return contactReply;
    return "Ese código no es válido o ya venció. Pedímelo de nuevo.";
  }

  const history = getHistory(sender);
  const messages: Message[] = [...history, { role: "user", content: text }];
  const finish = (answer: string) => {
    saveHistory(sender, [...history, { role: "user", content: text }, { role: "assistant", content: answer }]);
    return answer;
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const llmStarted = Date.now();
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

    console.log(
      `[tiempos] claude vuelta ${round + 1}: ${Date.now() - llmStarted} ms (${response.stop_reason}, entrada ${response.usage.input_tokens}, cache ${response.usage.cache_read_input_tokens ?? 0}, salida ${response.usage.output_tokens})`,
    );
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
      const toolStarted = Date.now();
      const result = await runTool(sender, call.name, (call.input ?? {}) as Record<string, unknown>);
      console.log(`[tiempos] herramienta ${call.name}: ${Date.now() - toolStarted} ms`);
      const isError = typeof result === "object" && result !== null && "error" in result;
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(result), is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }

  return "Me trabé procesando eso. ¿Lo probamos de nuevo?";
}
