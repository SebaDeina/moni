import { NotImplemented } from "../chain/index.js";
import { config } from "../config.js";
import { createWallet, getWallet } from "../wallets.js";
import { claimWaLogin, isWaLoginPending } from "./auth.js";

const CHAT_GUIDE = `Desde este chat podés escribirme o mandarme un audio para:
• Ver tu saldo: "¿cuánto tengo?"
• Ver tus gastos: "¿cuánto gasté esta semana?"
• Mandar plata: "mandale 5 dólares a Caro"
• Agendar a alguien: "agendá a Caro: 0x…"
• Recibir plata: "¿cuál es mi dirección?"

Nada sale de tu wallet sin que lo confirmes.`;

const WARNING = "Ojo: nunca mandes un código de Moni que te haya pasado otra persona.";

/**
 * Llegó "Entrar a Moni: <código>". La primera vez (sin wallet) se la creamos antes de habilitar la web,
 * así el panel ya abre con saldo, y la respuesta es una bienvenida con lo que se puede hacer desde el chat.
 */
export async function replyToWaLogin(phone: string, code: string): Promise<string> {
  const web = `${config.PUBLIC_URL}/app`;
  if (!isWaLoginPending(code)) return `Ese código no sirve o ya venció. Pedí uno nuevo en ${web}`;

  let walletLine: string | null = null;
  if (!getWallet(phone)) {
    try {
      const { created, funding } = await createWallet(phone);
      if (created) {
        walletLine =
          funding && "amount" in funding
            ? `Te creé tu wallet y te regalé ${funding.amount.replace(".", ",")} de prueba para arrancar. El gas lo paga Moni.`
            : "Te creé tu wallet. El gas de tus envíos lo paga Moni.";
      }
    } catch (err) {
      // Sin wallet igual se puede entrar: el panel ofrece crearla.
      if (!(err instanceof NotImplemented)) console.error("[web] no pude crear la wallet en el primer login", err);
    }
  }

  if (!claimWaLogin(phone, code)) return `Ese código no sirve o ya venció. Pedí uno nuevo en ${web}`;
  if (!walletLine) return `Listo, ya entraste a Moni en la web ✅ Volvé al navegador o abrí ${web}\n\n${WARNING}`;
  return `¡Bienvenido a Moni! 👋 Ya entraste a la web: volvé al navegador o abrí ${web}\n\n${walletLine}\n\n${CHAT_GUIDE}\n\n${WARNING}`;
}
