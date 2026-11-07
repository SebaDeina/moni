/**
 * Forma única de un número, para que el mismo usuario sea el mismo en WhatsApp y en la web.
 * WhatsApp puede mandar un celular argentino con el 9 ("549…") o sin él ("54…"): usamos sin 9.
 */
export function canonicalPhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (/^549\d{10}$/.test(digits)) return `54${digits.slice(3)}`;
  return digits;
}

/** "541123664713" → "+54 11 •••• 4713", para mostrar sin exponer el número completo. */
export function maskPhone(phone: string): string {
  if (phone.length < 8) return phone;
  return `+${phone.slice(0, 2)} ${phone.slice(2, 4)} •••• ${phone.slice(-4)}`;
}
