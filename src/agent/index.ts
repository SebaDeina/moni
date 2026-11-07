import { consumeConfirmation, parseConfirmation } from "../confirmations.js";
import { tools } from "./tools.js";

/**
 * Recibe el texto del usuario (o la transcripción de su audio) y devuelve la respuesta.
 * Dueño: dev de WhatsApp + LLM.
 */
export async function handleUserText(sender: string, text: string): Promise<string> {
  // La confirmación la resuelve el backend, nunca el modelo.
  const code = parseConfirmation(text);
  if (code) {
    const operationId = consumeConfirmation(sender, code);
    if (!operationId) return "Ese código no es válido o ya venció. Pedime la transferencia de nuevo.";
    // TODO: ejecutar la operación con chain.sendNativeTransfer y responder con el link al explorer.
    return `Confirmado. Enviando la operación ${operationId}…`;
  }

  // TODO(whatsapp): loop acotado con llm.chat.completions.create({ model: MODEL, messages, tools }),
  // como máximo ~5 vueltas, ejecutando cada tool call contra chain/ y la agenda.
  void tools;
  return "Hola, soy Moni. Todavía estoy en construcción.";
}

/** Pasa un audio de WhatsApp a texto. Dueño: dev de WhatsApp + LLM. */
export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  void audio;
  void mimeType;
  // TODO(whatsapp): elegir proveedor de speech-to-text y usar TRANSCRIBE_API_KEY.
  throw new Error("transcribe no implementado");
}
