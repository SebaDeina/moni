import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

/** Cliente de Claude. Toma la clave de ANTHROPIC_API_KEY (o LLM_API_KEY) y, en las pruebas, la URL de ANTHROPIC_BASE_URL. */
export const claude = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY ?? config.LLM_API_KEY });

export const MODEL = config.MONI_CLAUDE_MODEL;
