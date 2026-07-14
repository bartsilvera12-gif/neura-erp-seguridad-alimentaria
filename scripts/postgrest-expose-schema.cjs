#!/usr/bin/env node
/**
 * Expone `seguridadalimentariaerp` en PostgREST vía la configuración in-database
 * (`pgrst.db_schemas` en el rol `authenticator`), que es la que gobierna cuando
 * PostgREST corre con db-config habilitado.
 *
 * ESTRICTAMENTE APPEND-ONLY: lee la lista vigente, agrega el schema propio solo si
 * falta y reescribe la lista completa preservando todos los schemas ya expuestos.
 * Nunca reemplaza la lista por una versión previa ni quita schemas de otros clientes.
 *
 * Sin este paso el browser recibe PGRST106 aunque Postgres directo funcione.
 *
 * Uso:
 *   node scripts/postgrest-expose-schema.cjs           # aplica (idempotente)
 *   node scripts/postgrest-expose-schema.cjs --dry-run # solo muestra qué haría
 *
 * Requiere SUPABASE_DB_URL con un rol que pueda hacer ALTER ROLE authenticator.
 */
"use strict";

const { Client } = require("pg");

const TARGET_SCHEMA = "seguridadalimentariaerp";
const KEY = "pgrst.db_schemas=";
const DRY = process.argv.includes("--dry-run");

async function main() {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error("Falta SUPABASE_DB_URL");
    process.exit(1);
  }

  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const { rows } = await c.query(`
      SELECT r.setdatabase, d.datname, r.setconfig
        FROM pg_db_role_setting r
        JOIN pg_roles ro ON ro.oid = r.setrole
        LEFT JOIN pg_database d ON d.oid = r.setdatabase
       WHERE ro.rolname = 'authenticator'
    `);

    let cambios = 0;

    for (const row of rows) {
      const entry = (row.setconfig || []).find((s) => s.startsWith(KEY));
      if (!entry) continue;

      const alcance = row.datname ? `IN DATABASE ${row.datname}` : "";
      const actuales = entry.slice(KEY.length).split(",").filter(Boolean);

      if (actuales.includes(TARGET_SCHEMA)) {
        console.log(`· [${row.datname ?? "todas las db"}] ya expuesto — sin cambios`);
        continue;
      }

      // Append-only: se conserva el orden y la totalidad de la lista vigente.
      const nueva = [...actuales, TARGET_SCHEMA].join(",");
      console.log(
        `· [${row.datname ?? "todas las db"}] ${actuales.length} schemas → ${actuales.length + 1} (append de ${TARGET_SCHEMA})`,
      );

      if (!DRY) {
        await c.query(`ALTER ROLE authenticator ${alcance} SET pgrst.db_schemas = '${nueva}'`);
        cambios++;
      }
    }

    if (!DRY) {
      await c.query(`SELECT pg_notify('pgrst', 'reload config')`);
      await c.query(`SELECT pg_notify('pgrst', 'reload schema')`);
      console.log(`· NOTIFY pgrst reload config + schema (${cambios} fila(s) actualizada(s))`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
