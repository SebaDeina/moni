import { z } from "zod";

const optional = z.string().min(1).optional();

const Env = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_PATH: z.string().default("./data/moni.db"),

  // WhatsApp
  WHATSAPP_PROVIDER: z.enum(["kapso", "baileys"]).default("kapso"),
  KAPSO_API_KEY: optional,
  KAPSO_PHONE_NUMBER_ID: optional,
  KAPSO_WEBHOOK_SECRET: optional,
  BAILEYS_AUTH_DIR: z.string().default("./data/baileys-auth"),

  // LLM (SDK de OpenAI apuntando a xAI)
  LLM_API_KEY: optional,
  LLM_BASE_URL: z.string().url().default("https://api.x.ai/v1"),
  LLM_MODEL: z.string().default("grok-4.7"),

  // Transcripción de audios
  TRANSCRIBE_API_KEY: optional,

  // Avalanche Fuji
  FUJI_RPC_URL: z.string().url().default("https://api.avax-test.network/ext/bc/C/rpc"),
  WALLET_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  AVALANCHE_DATA_API_KEY: optional,
});

// "CLAVE=" en un .env llega como "": la tratamos como no configurada.
const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));

export const config = Env.parse(rawEnv);
export type Config = typeof config;

/** Fuji C-Chain. Fijo a propósito: el prototipo no toca mainnet. */
export const FUJI_CHAIN_ID = 43113;
