import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { formatEther } from "viem";
import * as chain from "../chain/index.js";
import { FUJI_CHAIN_ID, config } from "../config.js";
import { addContact, listContacts, removeContact } from "../contacts.js";
import { MAX_TRANSFER, formatAmount, listOperations, prepareTransfer } from "../operations.js";
import { canonicalPhone, maskPhone } from "../phone.js";
import { whatsapp } from "../whatsapp/index.js";
import { createWallet, getWallet } from "../wallets.js";
import { SESSION_TTL_MS, createLoginCode, createSession, deleteSession, sessionPhone, verifyLoginCode } from "./auth.js";

const COOKIE = "moni_session";

type Vars = { Variables: { phone: string } };

/** Lo que la web puede mostrar mientras la parte de Avalanche no esté implementada. */
async function orPending<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof chain.NotImplemented) return null;
    throw err;
  }
}

export function createApi(allowedSenders: Set<string>) {
  const api = new Hono<Vars>();

  // Datos públicos para la landing y la pantalla de login.
  api.get("/public", (c) => {
    const treasury = chain.treasuryAddress();
    return c.json({
      network: { name: "Avalanche Fuji", chainId: FUJI_CHAIN_ID },
      contract: { address: config.MONI_VAULT_ADDRESS, url: chain.explorerAddressUrl(config.MONI_VAULT_ADDRESS) },
      treasury: treasury ? { address: treasury, url: chain.explorerAddressUrl(treasury) } : null,
      whatsapp: config.MONI_WHATSAPP_NUMBER
        ? { display: config.MONI_WHATSAPP_NUMBER, link: `https://wa.me/${config.MONI_WHATSAPP_NUMBER.replace(/\D/g, "")}` }
        : null,
      privateBeta: allowedSenders.size > 0,
    });
  });

  api.post("/auth/request", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { phone?: string };
    const phone = canonicalPhone(body.phone ?? "");
    if (phone.length < 10 || phone.length > 15) return c.json({ error: "Revisá el número: con código de país, por ejemplo 54 11 2345 6789." }, 400);
    if (allowedSenders.size > 0 && !allowedSenders.has(phone)) {
      return c.json({ error: "Ese número no está habilitado en la prueba privada de Moni." }, 403);
    }
    const code = createLoginCode(phone);
    if (!code) return c.json({ error: "Pediste varios códigos seguidos. Esperá unos minutos y probá de nuevo." }, 429);
    try {
      await whatsapp.sendText(phone, `Tu código para entrar a Moni es ${code}. Vence en 5 minutos. Si no lo pediste vos, ignoralo.`);
    } catch (err) {
      console.error("[web] no pude mandar el código por WhatsApp", err);
      return c.json({ error: "No pude mandarte el código por WhatsApp. Probá de nuevo en un rato." }, 502);
    }
    return c.json({ ok: true, sentTo: maskPhone(phone) });
  });

  api.post("/auth/verify", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { phone?: string; code?: string };
    const phone = canonicalPhone(body.phone ?? "");
    const code = (body.code ?? "").replace(/\D/g, "");
    if (code.length !== 6 || !verifyLoginCode(phone, code)) {
      return c.json({ error: "El código no es correcto o ya venció." }, 401);
    }
    setCookie(c, COOKIE, createSession(phone), {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return c.json({ ok: true });
  });

  api.post("/auth/logout", (c) => {
    deleteSession(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Todo lo que sigue necesita sesión.
  api.use("/me/*", requireSession);
  api.use("/me", requireSession);
  api.use("/transfers", requireSession);
  api.use("/contacts", requireSession);
  api.use("/wallet", requireSession);
  api.use("/contacts/*", requireSession);

  api.get("/me", async (c) => {
    const phone = c.get("phone");
    const wallet = getWallet(phone);
    const balances = wallet
      ? await orPending(async () => {
          const [avax, usdc] = await Promise.all([chain.getBalance(wallet.address), chain.getTokenBalance(wallet.address, "USDC")]);
          return { AVAX: formatAmount(avax, "AVAX"), USDC: formatAmount(usdc, "USDC") };
        })
      : null;
    return c.json({
      phone: maskPhone(phone),
      wallet: wallet ? { address: wallet.address, url: wallet.url } : null,
      balances,
      maxTransfer: { AVAX: formatAmount(MAX_TRANSFER.AVAX, "AVAX"), USDC: formatAmount(MAX_TRANSFER.USDC, "USDC") },
      contacts: listContacts(phone).map((c) => ({ ...c, url: chain.explorerAddressUrl(c.address) })),
    });
  });

  api.get("/me/activity", async (c) => {
    const period = c.req.query("period");
    const wallet = getWallet(c.get("phone"));
    const txs = wallet
      ? await orPending(() => chain.listTransactions(wallet.address, period === "today" || period === "month" ? period : "week"))
      : null;
    return c.json({
      operations: listOperations(c.get("phone")),
      transactions:
        txs?.slice(0, 30).map((t) => ({
          direction: t.direction,
          amount: `${formatEther(t.valueWei)} AVAX`,
          gas: `${formatEther(t.gasWei)} AVAX`,
          counterparty: t.counterparty,
          success: t.success,
          timestamp: t.timestamp,
          url: chain.explorerTxUrl(t.hash),
        })) ?? null,
    });
  });

  // Crea la wallet del usuario (una por número) y la fondea con el saldo de bienvenida.
  api.post("/wallet", async (c) => {
    try {
      const result = await createWallet(c.get("phone"));
      return c.json({ ok: true, created: result.created, wallet: result.wallet, funding: result.funding });
    } catch (err) {
      if (err instanceof chain.NotImplemented) return c.json({ error: "Todavía no se pueden crear wallets: falta configurar Moni." }, 503);
      throw err;
    }
  });

  // Agenda propia. Los contactos compartidos (CONTACTS del .env) no se pueden borrar desde acá.
  api.post("/contacts", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { alias?: string; address?: string };
    const result = addContact(c.get("phone"), body.alias ?? "", body.address ?? "");
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json({ ok: true, contact: result.contact });
  });

  api.delete("/contacts/:alias", (c) => {
    if (!removeContact(c.get("phone"), c.req.param("alias"))) {
      return c.json({ error: "Ese contacto no está en tu agenda (o es compartido)." }, 404);
    }
    return c.json({ ok: true });
  });

  // La web propone; la confirmación llega por WhatsApp con "SI <código>", igual que en el chat.
  api.post("/transfers", async (c) => {
    const phone = c.get("phone");
    const body = (await c.req.json().catch(() => ({}))) as { alias?: string; amount?: string; token?: string };
    const prepared = await prepareTransfer(phone, body.alias ?? "", body.amount ?? "", body.token ?? "AVAX");
    if ("error" in prepared) return c.json({ error: prepared.error }, 400);
    try {
      await whatsapp.sendText(
        phone,
        `Pediste desde la web mandarle ${prepared.amount} a ${prepared.alias}. Para confirmar respondé SI ${prepared.code} (vence en 2 minutos). Si no fuiste vos, no respondas.`,
      );
    } catch (err) {
      console.error("[web] no pude mandar la confirmación por WhatsApp", err);
      return c.json({ error: "No pude mandarte la confirmación por WhatsApp. Probá de nuevo." }, 502);
    }
    return c.json({ ok: true, operationId: prepared.operationId, alias: prepared.alias, amount: prepared.amount });
  });

  return api;
}

async function requireSession(c: Context<Vars>, next: () => Promise<void>) {
  const phone = sessionPhone(getCookie(c, COOKIE));
  if (!phone) return c.json({ error: "Tu sesión venció. Entrá de nuevo." }, 401);
  c.set("phone", phone);
  await next();
}
