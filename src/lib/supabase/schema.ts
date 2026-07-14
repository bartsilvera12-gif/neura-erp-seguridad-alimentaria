import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Instancia dedicada monocliente (Seguridad Alimentaria).
 * Schema único Postgres para catálogo + datos operativos.
 * Modelo: 1 cliente = 1 repositorio = 1 schema = 1 deploy.
 *
 * El default del repo ya es el schema de esta instancia: en el bundle de browser
 * solo se inlinean las `NEXT_PUBLIC_*`, así que sin default propio el cliente
 * caería en el schema de otra instancia.
 */
const INSTANCE_SCHEMA = "seguridadalimentariaerp";

/** Schemas de otras instancias o compartidos: esta app nunca debe resolverlos. */
const FOREIGN_SCHEMAS = new Set(["reservacaacupe", "enlodemari", "zentra_erp", "public"]);

function readEnvSchema(): string {
  if (typeof process === "undefined") return INSTANCE_SCHEMA;
  const raw =
    process.env.NEURA_CLIENT_SCHEMA?.trim() ||
    process.env.APP_DB_SCHEMA?.trim() ||
    process.env.NEXT_PUBLIC_APP_DB_SCHEMA?.trim() ||
    "";
  if (!raw) return INSTANCE_SCHEMA;
  if (FOREIGN_SCHEMAS.has(raw)) {
    throw new Error(
      `[neura] El schema '${raw}' pertenece a otra instancia. Esta app es monocliente y solo opera sobre '${INSTANCE_SCHEMA}'.`,
    );
  }
  return raw;
}

export const NEURA_CLIENT_SCHEMA: string = readEnvSchema();

/** Nombre visible del cliente de esta instancia. */
export const NEURA_CLIENT_NAME: string =
  (typeof process !== "undefined" &&
    (process.env.NEURA_CLIENT_NAME?.trim() || process.env.NEXT_PUBLIC_NEURA_CLIENT_NAME?.trim())) ||
  "Seguridad Alimentaria";

/**
 * Schema Postgres principal de la app.
 * En instancia dedicada equivale a NEURA_CLIENT_SCHEMA.
 * Requiere en Supabase: Settings → API → "Exposed schemas" incluir este schema.
 */
export const SUPABASE_APP_SCHEMA: string = NEURA_CLIENT_SCHEMA;

/**
 * Resolución de schema operativo por empresa.
 * En instancia dedicada monocliente siempre devuelve el schema único; el argumento se ignora.
 * Se mantiene la firma para compatibilidad con callers existentes.
 */
export function resolveEmpresaDataSchema(_dataSchema?: string | null): string {
  return NEURA_CLIENT_SCHEMA;
}

/**
 * Cliente Supabase con cualquier esquema PostgREST.
 * Con @supabase/supabase-js ≥2.99 los genéricos de `SupabaseClient` son varios y condicionales;
 * acotar alguno a `string` o `"public"` rompe la asignación entre instancias (p. ej. Vercel TS).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppSupabaseClient = SupabaseClient<any, any, any, any, any>;

export const supabaseDbSchemaOption = {
  db: { schema: SUPABASE_APP_SCHEMA },
} as const;

/** Cliente service role estándar (API routes, webhooks, jobs). */
export const supabaseServiceRoleClientOptions = {
  auth: { autoRefreshToken: false, persistSession: false },
  ...supabaseDbSchemaOption,
} as const;
