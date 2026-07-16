/**
 * Helpers de fecha calendario en zona horaria de Paraguay (America/Asuncion).
 *
 * Por qué: el server de prod corre en UTC. Usar `new Date()` /
 * `toISOString().slice(0,10)` para "hoy" o como default de formularios hace que,
 * después de ~21:00 PY (medianoche UTC), las fechas salten al día UTC siguiente
 * y las métricas/resúmenes "de hoy" dejen de reflejar ventas/gastos del día PY.
 *
 * Estos helpers usan `Intl` con `timeZone: America/Asuncion`, así que son
 * correctos sin importar el TZ del runtime (server o browser) y sin hardcodear
 * el offset (UTC-3/UTC-4).
 */

export const APP_TIMEZONE = "America/Asuncion";

/** Fecha calendario de Paraguay como `YYYY-MM-DD` (apta para <input type="date"> y comparación). */
export function hoyAsuncionYmd(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: APP_TIMEZONE });
}

/** `YYYY-MM-DD` (en Paraguay) del instante representado por `value` (ISO/Date). */
export function asuncionYmd(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: APP_TIMEZONE });
}

/** ¿`iso` cae en el mismo día calendario (Paraguay) que `now`? */
export function esMismoDiaAsuncion(iso: string, now: Date = new Date()): boolean {
  const a = asuncionYmd(iso);
  return a !== "" && a === hoyAsuncionYmd(now);
}

/**
 * Fecha y hora "DD/MM/YYYY HH:mm" en zona Paraguay, para documentos imprimibles
 * (tickets, recibos, notas). El server corre en UTC: sin esto un ticket emitido
 * a las 16:55 PY se imprime "19:55". `formatToParts` evita variaciones de locale.
 */
export function formatFechaHoraAsuncion(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value ?? "");
  const parts = new Intl.DateTimeFormat("es-PY", {
    timeZone: APP_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}
