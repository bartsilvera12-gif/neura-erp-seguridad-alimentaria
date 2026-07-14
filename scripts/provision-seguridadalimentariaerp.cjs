#!/usr/bin/env node
/**
 * Provisión del schema `seguridadalimentariaerp` (instancia Seguridad Alimentaria).
 *
 * Clona la ESTRUCTURA del schema molde (`reservacaacupe`) — tablas, constraints,
 * índices, FKs, funciones, triggers, vistas, RLS, policies, grants, realtime —
 * a un schema nuevo, autónomo y VACÍO, reescribiendo toda referencia interna al
 * schema destino. No copia ninguna fila operativa del cliente fuente.
 *
 * Por qué clonar y no replayar `supabase/migrations/`: esas migraciones son
 * historia acumulada con objetos repartidos entre `public` y `zentra_erp`;
 * replayarlas en un schema nuevo es frágil. Clonar la estructura viva y sana es
 * el procedimiento oficial (mismo con el que se creó el schema molde).
 *
 * Seed mínimo (solo lo que la app necesita para arrancar):
 *   - `modulos`          catálogo de producto (no es dato de cliente)
 *   - `empresas`         1 fila nueva de Seguridad Alimentaria (sin datos fiscales)
 *   - `empresa_modulos`  habilitación de módulos, espejando los flags del molde
 *
 * Uso:
 *   node scripts/provision-seguridadalimentariaerp.cjs              # crear/actualizar (idempotente)
 *   node scripts/provision-seguridadalimentariaerp.cjs --verify     # solo verificar
 *   node scripts/provision-seguridadalimentariaerp.cjs --recreate   # DROP CASCADE + reclonar
 *
 * Requiere SUPABASE_DB_URL (superusuario: crea schema, grants y SECURITY DEFINER).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const SOURCE_SCHEMA = "reservacaacupe";
const TARGET_SCHEMA = "seguridadalimentariaerp";
const CLIENT_NAME = "Seguridad Alimentaria";

const CLONER_SQL = path.join(__dirname, "sql", "neura_clone_schema_full.sql");

const argv = process.argv.slice(2);
const VERIFY_ONLY = argv.includes("--verify") || argv.includes("--verify-only");
const RECREATE = argv.includes("--recreate");

function log(...a) {
  console.log(...a);
}

function dbUrl() {
  const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || process.env.DIRECT_URL;
  if (!url) {
    console.error("Falta SUPABASE_DB_URL (conexión directa a Postgres con superusuario).");
    process.exit(1);
  }
  return url;
}

/** El clonador vive en `public` y ya está instalado en la base productiva. Solo se
 *  instala si falta (base nueva); nunca se pisa una versión existente. */
async function ensureCloner(c) {
  const { rows } = await c.query(
    `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'neura_clone_schema_full'`,
  );
  if (rows.length) {
    log("· clonador public.neura_clone_schema_full ya instalado — no se toca `public`");
    return;
  }
  log("· instalando clonador public.neura_clone_schema_full (base nueva)");
  await c.query(fs.readFileSync(CLONER_SQL, "utf8"));
}

async function cloneStructure(c) {
  const { rows } = await c.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [TARGET_SCHEMA]);
  const exists = rows.length > 0;

  if (exists && !RECREATE) {
    log(`· schema ${TARGET_SCHEMA} ya existe — se conserva (usar --recreate para reclonar)`);
    return;
  }
  if (exists && RECREATE) {
    log(`· --recreate: DROP SCHEMA ${TARGET_SCHEMA} CASCADE + reclonado desde ${SOURCE_SCHEMA}`);
  } else {
    log(`· clonando estructura ${SOURCE_SCHEMA} → ${TARGET_SCHEMA} (sin datos)`);
  }

  const res = await c.query(`SELECT public.neura_clone_schema_full($1, $2, $3) AS r`, [
    SOURCE_SCHEMA,
    TARGET_SCHEMA,
    RECREATE,
  ]);
  log("  →", JSON.stringify(res.rows[0].r));
}

/**
 * El clonador habilita RLS en TODAS las tablas, pero el molde deja algunas sin RLS
 * (se acceden solo con service_role, que igual lo bypassea). Dejarlas con RLS y sin
 * policies haría que devuelvan cero filas al browser y rompería esos módulos.
 * Acá se alinea el flag `relrowsecurity` del destino al del molde, tabla por tabla.
 */
async function alinearRls(c) {
  const { rows } = await c.query(
    `
    SELECT tc.relname, sc.relrowsecurity AS rls_molde, tc.relrowsecurity AS rls_destino
      FROM pg_class tc
      JOIN pg_namespace tn ON tn.oid = tc.relnamespace AND tn.nspname = $1
      JOIN pg_namespace sn ON sn.nspname = $2
      JOIN pg_class sc ON sc.relnamespace = sn.oid AND sc.relname = tc.relname AND sc.relkind = 'r'
     WHERE tc.relkind = 'r' AND tc.relrowsecurity IS DISTINCT FROM sc.relrowsecurity
     ORDER BY tc.relname
  `,
    [TARGET_SCHEMA, SOURCE_SCHEMA],
  );

  if (!rows.length) {
    log("· RLS: ya alineado con el molde");
    return;
  }
  for (const r of rows) {
    const accion = r.rls_molde ? "ENABLE" : "DISABLE";
    await c.query(`ALTER TABLE ${TARGET_SCHEMA}."${r.relname}" ${accion} ROW LEVEL SECURITY`);
  }
  log(`· RLS: alineado al molde en ${rows.length} tabla(s): ${rows.map((r) => r.relname).join(", ")}`);
}

/**
 * El bloque de grants del clonador otorga a `authenticated` y `service_role`, pero omite `anon`.
 * El molde sí le da a `anon` los mismos privilegios de tabla y EXECUTE sobre las funciones (el
 * acceso real lo gobierna RLS, no el grant). Sin esto PostgREST responde 401 / error 42501 al
 * browser antes de siquiera evaluar las policies.
 */
async function alinearGrantsAnon(c) {
  const t = `"${TARGET_SCHEMA}"`;
  await c.query(`GRANT USAGE ON SCHEMA ${t} TO anon`);
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${t} TO anon`);
  await c.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${t} TO anon`);
  await c.query(`GRANT EXECUTE ON ALL ROUTINES IN SCHEMA ${t} TO anon`);
  await c.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${t} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon`,
  );
  log("· grants: `anon` alineado al molde (tablas, secuencias, rutinas)");
}

/**
 * El clonador reescribe el `search_path` del schema origen y de `zentra_erp`, pero no el de
 * otros schemas del linaje de clonación (el molde arrastra `search_path=enlodemari` de una
 * instancia anterior). Los cuerpos quedan calificados con el schema destino, así que hoy no
 * hay fuga; pero un `search_path` apuntando a otro cliente hace que cualquier referencia sin
 * calificar se resuelva contra su schema. Se repunta al schema propio, preservando el resto
 * de la lista (p. ej. `pg_catalog`).
 */
async function alinearSearchPath(c) {
  const AJENOS = ["enlodemari", "zentra_erp", SOURCE_SCHEMA];
  const { rows } = await c.query(
    `SELECT p.oid::regprocedure::text AS firma, cfg
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       , unnest(coalesce(p.proconfig,'{}')) cfg
      WHERE n.nspname = $1 AND cfg LIKE 'search\\_path=%'`,
    [TARGET_SCHEMA],
  );

  const aCorregir = rows.filter((r) => AJENOS.some((s) => r.cfg.includes(s)));
  if (!aCorregir.length) {
    log("· search_path: sin referencias a schemas ajenos");
    return;
  }

  for (const r of aCorregir) {
    const partes = r.cfg
      .slice("search_path=".length)
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    const nuevas = [];
    for (const p of partes) {
      const v = AJENOS.includes(p) ? TARGET_SCHEMA : p;
      if (!nuevas.includes(v)) nuevas.push(v);
    }
    await c.query(
      `ALTER FUNCTION ${r.firma} SET search_path TO ${nuevas.map((s) => `"${s}"`).join(", ")}`,
    );
  }
  log(`· search_path: repuntado al schema propio en ${aCorregir.length} función(es)`);
}

/**
 * Seed mínimo. Todo idempotente.
 * `modulos` conserva los UUID del catálogo de producto para que los slugs y la
 * habilitación por módulo sean consistentes con el resto de las instancias.
 */
async function seedMinimo(c) {
  await c.query("BEGIN");
  try {
    const mod = await c.query(`
      INSERT INTO ${TARGET_SCHEMA}.modulos (id, created_at, nombre, descripcion, slug)
      SELECT id, created_at, nombre, descripcion, slug FROM ${SOURCE_SCHEMA}.modulos
      ON CONFLICT (id) DO NOTHING
    `);
    log(`· modulos (catálogo de producto): +${mod.rowCount}`);

    // Empresa inicial: identidad nueva. Sin RUC, teléfono, email ni dirección:
    // esos datos todavía no fueron provistos y no se inventan ni se heredan.
    const emp = await c.query(
      `
      INSERT INTO ${TARGET_SCHEMA}.empresas
        (id, nombre_empresa, ruc, telefono, email, direccion, pais, plan, estado, gestion_tributaria_clientes)
      SELECT gen_random_uuid(), $1, NULL, NULL, NULL, NULL, 'PARAGUAY', NULL, 'ACTIVA', false
      WHERE NOT EXISTS (SELECT 1 FROM ${TARGET_SCHEMA}.empresas)
      RETURNING id
    `,
      [CLIENT_NAME],
    );
    if (emp.rowCount) log(`· empresas: creada "${CLIENT_NAME}"`);
    else log("· empresas: ya existía — sin cambios");

    // Habilitación de módulos: espeja los flags `activo` del molde para no alterar
    // qué módulos ofrece el ERP.
    const em = await c.query(`
      INSERT INTO ${TARGET_SCHEMA}.empresa_modulos (id, created_at, empresa_id, modulo_id, activo)
      SELECT gen_random_uuid(), now(), e.id, m.id,
             coalesce((SELECT sem.activo
                         FROM ${SOURCE_SCHEMA}.empresa_modulos sem
                        WHERE sem.modulo_id = m.id
                        LIMIT 1), false)
        FROM ${TARGET_SCHEMA}.empresas e
        CROSS JOIN ${TARGET_SCHEMA}.modulos m
       WHERE NOT EXISTS (
         SELECT 1 FROM ${TARGET_SCHEMA}.empresa_modulos x
          WHERE x.empresa_id = e.id AND x.modulo_id = m.id
       )
    `);
    log(`· empresa_modulos: +${em.rowCount}`);

    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}

async function verify(c) {
  const { rows } = await c.query(
    `
    WITH t AS (
      SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind = 'r'
    )
    SELECT jsonb_build_object(
      'tablas',        (SELECT count(*) FROM t),
      'vistas',        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='v'),
      'funciones',     (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1),
      'triggers',      (SELECT count(*) FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT tg.tgisinternal),
      'fks',           (SELECT count(*) FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND co.contype='f'),
      'indices',       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='i'),
      'secuencias',    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='S'),
      'policies',      (SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1),
      'tablas_rls_on', (SELECT count(*) FROM t JOIN pg_class c ON c.oid=t.oid WHERE c.relrowsecurity),
      'realtime',      (SELECT count(*) FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname=$1),
      -- Aislamiento: nada debe colgar del schema molde
      'fks_al_molde',  (SELECT coalesce(jsonb_agg(co.conname),'[]'::jsonb)
                          FROM pg_constraint co
                          JOIN pg_class c  ON c.oid = co.conrelid
                          JOIN pg_namespace n  ON n.oid = c.relnamespace
                          JOIN pg_class ct ON ct.oid = co.confrelid
                          JOIN pg_namespace nt ON nt.oid = ct.relnamespace
                         WHERE n.nspname=$1 AND co.contype='f' AND nt.nspname NOT IN ($1,'auth')),
      'funcs_al_molde',(SELECT coalesce(jsonb_agg(p.proname),'[]'::jsonb)
                          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                         WHERE n.nspname=$1 AND pg_get_functiondef(p.oid) LIKE '%' || $2 || '.%'),
      'policies_al_molde',(SELECT coalesce(jsonb_agg(pol.polname),'[]'::jsonb)
                          FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
                          JOIN pg_namespace n ON n.oid=c.relnamespace
                         WHERE n.nspname=$1
                           AND (coalesce(pg_get_expr(pol.polqual,pol.polrelid),'') LIKE '%' || $2 || '.%'
                             OR coalesce(pg_get_expr(pol.polwithcheck,pol.polrelid),'') LIKE '%' || $2 || '.%')),
      -- search_path de funciones apuntando a schemas de otras instancias
      'searchpath_ajeno',(SELECT coalesce(jsonb_agg(DISTINCT p.proname),'[]'::jsonb)
                          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
                               unnest(coalesce(p.proconfig,'{}')) cfg
                         WHERE n.nspname=$1 AND cfg LIKE 'search\_path=%'
                           AND (cfg LIKE '%enlodemari%' OR cfg LIKE '%zentra_erp%' OR cfg LIKE '%' || $2 || '%'))
    ) AS v
  `,
    [TARGET_SCHEMA, SOURCE_SCHEMA],
  );

  const v = rows[0].v;
  log("\n== Estructura de " + TARGET_SCHEMA + " ==");
  log(JSON.stringify(v, null, 2));

  const fugas = [
    ["FKs al schema molde", v.fks_al_molde],
    ["Funciones que referencian el molde", v.funcs_al_molde],
    ["Policies que referencian el molde", v.policies_al_molde],
    ["Funciones con search_path a otra instancia", v.searchpath_ajeno],
  ].filter(([, arr]) => arr.length > 0);

  const rlsDrift = await c.query(
    `SELECT tc.relname FROM pg_class tc
       JOIN pg_namespace tn ON tn.oid = tc.relnamespace AND tn.nspname = $1
       JOIN pg_namespace sn ON sn.nspname = $2
       JOIN pg_class sc ON sc.relnamespace = sn.oid AND sc.relname = tc.relname AND sc.relkind = 'r'
      WHERE tc.relkind = 'r' AND tc.relrowsecurity IS DISTINCT FROM sc.relrowsecurity`,
    [TARGET_SCHEMA, SOURCE_SCHEMA],
  );
  log(
    "\n== RLS vs molde ==\n  " +
      (rlsDrift.rowCount === 0
        ? "OK — mismo flag de RLS en las 122 tablas"
        : `FALLA — desalineado en: ${rlsDrift.rows.map((r) => r.relname).join(", ")}`),
  );

  // Grants por rol: el destino debe cubrir al menos lo mismo que el molde.
  const grants = await c.query(
    `SELECT table_schema, grantee, count(DISTINCT table_name)::int AS tablas
       FROM information_schema.role_table_grants
      WHERE table_schema IN ($1,$2) AND grantee IN ('anon','authenticated','service_role')
      GROUP BY 1,2`,
    [TARGET_SCHEMA, SOURCE_SCHEMA],
  );
  const g = (sch, role) =>
    grants.rows.find((r) => r.table_schema === sch && r.grantee === role)?.tablas ?? 0;
  const rolesFaltantes = ["anon", "authenticated", "service_role"].filter(
    (r) => g(TARGET_SCHEMA, r) < g(SOURCE_SCHEMA, r),
  );
  log("\n== Grants vs molde ==");
  for (const r of ["anon", "authenticated", "service_role"]) {
    log(`  ${r}: destino=${g(TARGET_SCHEMA, r)} tablas / molde=${g(SOURCE_SCHEMA, r)}`);
  }
  if (rolesFaltantes.length) log(`  FALLA — roles con menos grants que el molde: ${rolesFaltantes}`);
  else log("  OK");

  // Ninguna tabla debe tener datos, salvo el seed mínimo declarado.
  const SEED = new Set(["modulos", "empresas", "empresa_modulos"]);
  const tablas = await c.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relkind='r' ORDER BY 1`,
    [TARGET_SCHEMA],
  );
  const conDatos = [];
  for (const { relname } of tablas.rows) {
    const r = await c.query(`SELECT count(*)::int AS n FROM ${TARGET_SCHEMA}."${relname}"`);
    if (r.rows[0].n > 0) conDatos.push(`${relname}=${r.rows[0].n}`);
  }
  const inesperadas = conDatos.filter((s) => !SEED.has(s.split("=")[0]));

  log("\n== Datos ==");
  log("  tablas con filas: " + (conDatos.join("  ") || "(ninguna)"));
  log("  seed mínimo esperado: modulos, empresas, empresa_modulos");

  log("\n== Aislamiento ==");
  if (!fugas.length) log(`  OK — sin dependencias hacia ${SOURCE_SCHEMA}`);
  else for (const [k, arr] of fugas) log(`  FALLA — ${k}: ${JSON.stringify(arr)}`);

  if (inesperadas.length) log(`  FALLA — datos fuera del seed mínimo: ${inesperadas.join(", ")}`);
  else log("  OK — sin datos productivos");

  const ok =
    !fugas.length &&
    !inesperadas.length &&
    rlsDrift.rowCount === 0 &&
    !rolesFaltantes.length &&
    v.tablas > 0;
  log(`\nRESULTADO: ${ok ? "OK" : "FALLA"}`);
  return ok;
}

async function main() {
  const c = new Client({ connectionString: dbUrl() });
  await c.connect();
  try {
    if (!VERIFY_ONLY) {
      await ensureCloner(c);
      await cloneStructure(c);
      await alinearRls(c);
      await alinearGrantsAnon(c);
      await alinearSearchPath(c);
      await seedMinimo(c);
      await c.query(`SELECT pg_notify('pgrst', 'reload schema')`);
    }
    const ok = await verify(c);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
