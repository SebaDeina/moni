import OpenAI from "openai";
import { config } from "../config.js";

/** Cliente compatible con OpenAI. Por defecto apunta a xAI; cambiar LLM_BASE_URL para otro proveedor. */
export const llm = new OpenAI({
  apiKey: config.LLM_API_KEY ?? "missing",
  baseURL: config.LLM_BASE_URL,
});

export const MODEL = config.LLM_MODEL;
