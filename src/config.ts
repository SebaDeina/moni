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
  KAPSO_API_BASE: z.string().url().default("https://api.kapso.ai"),
  BAILEYS_AUTH_DIR: z.string().default("./data/baileys-auth"),
  // Números que pueden usar el bot, separados por coma (E.164 sin "+"). Vacío = cualquiera.
  ALLOWED_SENDERS: optional,

  // Claude. LLM_API_KEY se acepta como alias de ANTHROPIC_API_KEY. Prefijo MONI_ para no chocar con CLAUDE_* de Claude Code.
  ANTHROPIC_API_KEY: optional,
  LLM_API_KEY: optional,
  MONI_CLAUDE_MODEL: z.string().default("claude-haiku-5-5"),
  MONI_CLAUDE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),

  // Transcripción de audios cuando Kapso no manda la transcripción (speech-to-text de xAI).
  // Sin clave, Moni le pide al usuario que escriba.
  TRANSCRIBE_API_KEY: optional,
  TRANSCRIBE_URL: z.string().url().default("https://api.x.ai/v1/stt"),
  TRANSCRIBE_MODEL: z.string().default("grok-voice-transcribe-2.0"),

  // Agenda compartida: "juan=0xabc...,maria=0xdef..."
  CONTACTS: optional,

  // Web: número de WhatsApp de Moni para los links de la landing (formato libre, se muestra tal cual)
  MONI_WHATSAPP_NUMBER: optional,
  PUBLIC_DIR: z.string().default("./public"),

  // Avalanche Fuji
  FUJI_RPC_URL: z.string().url().default("https://api.avax-test.network/ext/bc/C/rpc"),
  /** Tesorería: fondea las wallets nuevas de los usuarios. */
  WALLET_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  /** Clave (32 bytes en hex) con la que se cifran las claves privadas de las wallets de los usuarios. */
  MONI_WALLET_MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  /** AVAX de bienvenida que la tesorería le manda a cada wallet nueva. */
  WELCOME_AVAX: z.string().regex(/^\d+(\.\d{1,18})?$/).default("0.05"),
  /** 0xGasless: smart account por usuario. Con la clave, el paymaster paga el gas de los envíos. */
  OXGASLESS_API_KEY: optional,
  OXGASLESS_BUNDLER_URL: z.string().url().default("https://bundler.0xgasless.com/43113"),
  OXGASLESS_PAYMASTER_URL: z.string().url().default("https://paymaster.0xgasless.com/v1/43113/rpc"),
  /**
   * Sin clave de 0xGasless: la tesorería le recarga AVAX a la smart account para que pague su gas
   * ("true" o "false"). Así el usuario tampoco paga gas mientras no haya paymaster.
   */
  SPONSOR_GAS: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /** Cada cuánto se revisan los bloques nuevos para avisar depósitos. 0 = no vigilar. */
  DEPOSIT_POLL_MS: z.coerce.number().int().min(0).default(10_000),
  AVALANCHE_DATA_API_KEY: optional,
  /** Contrato MoniVault desplegado en Fuji (contracts/). */
  MONI_VAULT_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0x12162801e91af889e4a147a4c3a9a255bf6629c2"),
});

// "CLAVE=" en un .env llega como "": la tratamos como no configurada.
const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));

export const config = Env.parse(rawEnv);
export type Config = typeof config;

/** Fuji C-Chain. Fijo a propósito: el prototipo no toca mainnet. */
export const FUJI_CHAIN_ID = 43113;
