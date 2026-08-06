/**
 * Helpers para formato de teléfono Paraguay (0980000000).
 * Formato visual: 0981 100 453
 * Valor guardado: 0981100453 (sin espacios)
 */

/** Extrae solo dígitos, máximo 10. */
function extractDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 10);
}

/**
 * Formatea el número para mostrar en pantalla.
 * Ejemplo: "0981100453" → "0981 100 453"
 */
export function formatTelefonoDisplay(value: string): string {
  const d = extractDigits(value);
  if (d.length <= 4) return d;
  if (d.length <= 7) return `${d.slice(0, 4)} ${d.slice(4)}`;
  return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
}

/**
 * Limpia el número para guardar en base de datos.
 * Ejemplo: "0981 100 453" → "0981100453"
 */
export function cleanTelefono(value: string): string {
  return extractDigits(value);
}

/**
 * Valida formato Paraguay: 10 dígitos, empieza con 09.
 */
export function isValidTelefono(value: string): boolean {
  const cleaned = cleanTelefono(value);
  return cleaned.length === 10 && cleaned.startsWith("09");
}

/**
 * Normaliza lo que el usuario tipea o pega a formato local antes de guardarlo.
 * Acepta el internacional (+595 981 100 453) y lo pasa a 0981100453; con
 * `cleanTelefono` a secas el "595" se comía los dígitos útiles al truncar a 10.
 */
export function normalizeTelefonoInput(value: string): string {
  let d = value.replace(/\D/g, "");
  if (d.startsWith("595")) d = `0${d.slice(3)}`;
  return d.slice(0, 10);
}

/**
 * Validación permisiva para captura de leads: alcanza con que sea un número
 * plausible. Un celular mal tipeado no debe impedir registrar la oportunidad,
 * y los fijos (021…) tienen menos de 10 dígitos.
 */
export function isTelefonoPlausible(value: string): boolean {
  const d = value.replace(/\D/g, "");
  return d.length >= 6 && d.length <= 13;
}
