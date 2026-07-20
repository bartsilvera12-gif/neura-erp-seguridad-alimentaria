/**
 * Cotización de moneda (USD → PYG) server-side.
 *
 * Reglas del negocio:
 *  - La consulta al proveedor externo se hace SIEMPRE desde el server (nunca
 *    desde el navegador): la URL y el token viven en variables de entorno.
 *  - Cache en memoria por proceso para no pegarle al proveedor en cada render.
 *  - Fallback en cascada: proveedor → última cotización guardada → error claro.
 *    NUNCA se devuelve 1 como tipo de cambio para USD (eso guardaría una compra
 *    en dólares como si fueran guaraníes).
 *  - Toda cotización aplicada se persiste con fuente y fecha; la carga manual
 *    queda marcada `es_manual` para auditarla.
 *
 * Variables de entorno (todas opcionales):
 *   COTIZACION_API_URL   endpoint que devuelve JSON con la cotización
 *   COTIZACION_API_TOKEN bearer opcional
 *   COTIZACION_JSON_PATH ruta al número dentro del JSON, ej. "venta" o "data.rate"
 *   COTIZACION_TTL_MS    validez del cache (default 30 min)
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

export interface Cotizacion {
  moneda_origen: string;
  moneda_destino: string;
  cotizacion: number;
  fecha_cotizacion: string;
  fuente: string;
  es_manual: boolean;
  /** true si viene de la última guardada porque el proveedor no respondió. */
  es_fallback?: boolean;
}

const TTL_MS = Number(process.env.COTIZACION_TTL_MS) || 30 * 60 * 1000;

type CacheEntry = { valor: Cotizacion; expiraEn: number };
const cache = new Map<string, CacheEntry>();
const cacheKey = (o: string, d: string) => `${o}->${d}`;

/** Lee un número anidado del JSON del proveedor, ej. "data.venta". */
function leerRuta(obj: unknown, ruta: string): number | null {
  const partes = ruta.split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of partes) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  const n = Number(cur);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Consulta al proveedor externo. Devuelve null si no hay config o falla. */
async function consultarProveedor(origen: string, destino: string): Promise<Cotizacion | null> {
  const url = (process.env.COTIZACION_API_URL ?? "").trim();
  if (!url) return null;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = (process.env.COTIZACION_API_TOKEN ?? "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url.replace("{origen}", origen).replace("{destino}", destino), {
      headers,
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const json = (await res.json()) as unknown;
    const ruta = (process.env.COTIZACION_JSON_PATH ?? "").trim();
    const valor = ruta ? leerRuta(json, ruta) : leerRuta(json, "cotizacion") ?? leerRuta(json, "venta");
    if (!valor) return null;

    return {
      moneda_origen: origen,
      moneda_destino: destino,
      cotizacion: valor,
      fecha_cotizacion: new Date().toISOString(),
      fuente: new URL(url).hostname,
      es_manual: false,
    };
  } catch {
    return null;
  }
}

/** Última cotización guardada para esa empresa y par de monedas. */
export async function ultimaCotizacionGuardada(
  schemaRaw: string,
  empresaId: string,
  origen = "USD",
  destino = "PYG"
): Promise<Cotizacion | null> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "cotizaciones_moneda");
  const { rows } = await pool().query<{
    moneda_origen: string; moneda_destino: string; cotizacion: string;
    fecha_cotizacion: string; fuente: string; es_manual: boolean;
  }>(
    `SELECT moneda_origen, moneda_destino, cotizacion, fecha_cotizacion, fuente, es_manual
       FROM ${t}
      WHERE empresa_id = $1::uuid AND moneda_origen = $2 AND moneda_destino = $3
      ORDER BY fecha_cotizacion DESC
      LIMIT 1`,
    [empresaId, origen, destino]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    moneda_origen: r.moneda_origen,
    moneda_destino: r.moneda_destino,
    cotizacion: Number(r.cotizacion),
    fecha_cotizacion: r.fecha_cotizacion,
    fuente: r.fuente,
    es_manual: r.es_manual,
  };
}

/** Persiste una cotización (automática o manual). */
export async function guardarCotizacion(
  schemaRaw: string,
  empresaId: string,
  c: { cotizacion: number; moneda_origen?: string; moneda_destino?: string; fuente: string; es_manual: boolean; created_by?: string | null }
): Promise<void> {
  if (!(c.cotizacion > 0)) throw new Error("La cotización debe ser mayor a cero.");
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "cotizaciones_moneda");
  await pool().query(
    `INSERT INTO ${t} (empresa_id, moneda_origen, moneda_destino, cotizacion, fecha_cotizacion, fuente, es_manual, created_by)
     VALUES ($1::uuid, $2, $3, $4::numeric, now(), $5, $6::boolean, $7::uuid)`,
    [
      empresaId,
      c.moneda_origen ?? "USD",
      c.moneda_destino ?? "PYG",
      c.cotizacion,
      c.fuente,
      c.es_manual,
      c.created_by ?? null,
    ]
  );
  cache.delete(cacheKey(c.moneda_origen ?? "USD", c.moneda_destino ?? "PYG"));
}

/**
 * Cotización vigente: cache → proveedor → última guardada.
 * Devuelve null si no hay ninguna disponible (el front debe pedir carga manual
 * con advertencia; jamás asumir 1).
 */
export async function getCotizacionVigente(
  schemaRaw: string,
  empresaId: string,
  origen = "USD",
  destino = "PYG"
): Promise<Cotizacion | null> {
  if (origen === destino) {
    return { moneda_origen: origen, moneda_destino: destino, cotizacion: 1, fecha_cotizacion: new Date().toISOString(), fuente: "identidad", es_manual: false };
  }

  const key = cacheKey(origen, destino);
  const hit = cache.get(key);
  if (hit && hit.expiraEn > Date.now()) return hit.valor;

  const delProveedor = await consultarProveedor(origen, destino);
  if (delProveedor) {
    cache.set(key, { valor: delProveedor, expiraEn: Date.now() + TTL_MS });
    // Se persiste para tener historial y fallback futuro (best-effort).
    try {
      await guardarCotizacion(schemaRaw, empresaId, {
        cotizacion: delProveedor.cotizacion,
        moneda_origen: origen,
        moneda_destino: destino,
        fuente: delProveedor.fuente,
        es_manual: false,
      });
    } catch (e) {
      console.error("[cotizaciones] no se pudo persistir:", e instanceof Error ? e.message : e);
    }
    return delProveedor;
  }

  // Fallback: la última válida guardada.
  const ultima = await ultimaCotizacionGuardada(schemaRaw, empresaId, origen, destino);
  if (ultima) return { ...ultima, es_fallback: true };

  return null;
}
