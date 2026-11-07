import { config } from "../config.js";

/**
 * Pasa un audio de WhatsApp (ogg/opus) a texto con el speech-to-text de xAI.
 * Solo se usa cuando Kapso no manda la transcripción en el webhook.
 * https://docs.x.ai/developers/model-capabilities/audio/speech-to-text
 */
export const canTranscribe = () => Boolean(config.TRANSCRIBE_API_KEY);

export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  const apiKey = config.TRANSCRIBE_API_KEY;
  if (!apiKey) throw new Error("Falta TRANSCRIBE_API_KEY para transcribir audios");

  const form = new FormData();
  form.append("model", config.TRANSCRIBE_MODEL);
  form.append("language", "es");
  // xAI ignora los campos que vienen después del archivo: el archivo va último.
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), "audio.ogg");

  const res = await fetch(config.TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`La transcripción respondió ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { text?: string };
  return (body.text ?? "").trim();
}
