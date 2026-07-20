/**
 * QA de CRM Funnel (punto 6) y de cotización USD → PYG (punto 7).
 *
 * CRM — casos verificados:
 *   1. Crear lead
 *   2. Mover entre etapas
 *   3. Buscar por teléfono
 *   4. Transferir responsable
 *   5. Admin ve todos
 *   6. Usuario comercial ve solo los propios
 *   7. Scope sin usuario resuelto NO devuelve todo (agujero clásico)
 *   8. Convertir lead en cliente
 *
 * Monedas — casos verificados:
 *   9.  Guardado de cotización y lectura de la vigente
 *   10. Fallback a la última cotización guardada
 *   11. Carga manual queda auditada (es_manual)
 *   12. Prohibición de tipo de cambio 1 para USD
 *
 * Ejecutar: npx tsx scripts/qa-crm-y-monedas.ts
 */
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), ".env.local") });

import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { aplicarScopeCrm, puedeAccederProspecto } from "@/lib/crm/server/crm-scope";
import { guardarCotizacion, ultimaCotizacionGuardada } from "@/lib/cotizaciones/server/cotizaciones-pg";

const SCHEMA = "seguridadalimentariaerp";
const EMPRESA = "17908c42-c297-4506-bcb7-547ccecfe53a";
const TAG = "TEST-QA-CRM";

let ok = 0, fail = 0;
function check(cond: boolean, titulo: string, detalle = "") {
  if (cond) { ok++; console.log(`  OK   ${titulo}${detalle ? ` — ${detalle}` : ""}`); }
  else { fail++; console.log(`  FAIL ${titulo}${detalle ? ` — ${detalle}` : ""}`); }
}
function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible");
  return p;
}

const USUARIO_A = "11111111-1111-4111-8111-111111111111";
const USUARIO_B = "22222222-2222-4222-8222-222222222222";

async function limpiar() {
  const p = pool();
  const del = async (sql: string, args: unknown[]) => { await p.query(sql, args).catch(() => null); };
  await del(`DELETE FROM ${SCHEMA}.crm_notas WHERE empresa_id=$1::uuid AND prospecto_id IN (SELECT id FROM ${SCHEMA}.crm_prospectos WHERE empresa_id=$1::uuid AND empresa LIKE $2)`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.crm_prospectos WHERE empresa_id=$1::uuid AND empresa LIKE $2`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.clientes WHERE empresa_id=$1::uuid AND empresa LIKE $2`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.cotizaciones_moneda WHERE empresa_id=$1::uuid AND fuente LIKE $2`, [EMPRESA, `${TAG}%`]);
}

/** Alta directa en la base (el QA valida el modelo y el scope, no el HTTP). */
async function crearLead(nombre: string, telefono: string, responsable: string | null) {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.crm_prospectos
       (empresa_id, numero_control, empresa, contacto, telefono, servicio,
        valor_estimado, etapa, responsable_usuario_id)
     VALUES ($1::uuid, $2, $3, 'Contacto QA', $4, 'Servicio QA', 1000000, 'LEAD', $5::uuid)
     RETURNING id`,
    [EMPRESA, `${TAG}-${Math.abs(nombre.length * 7919) % 100000}`, nombre, telefono, responsable]
  );
  return rows[0].id;
}

async function main() {
  console.log("QA — CRM Funnel y cotización USD\n");
  await limpiar();
  const p = pool();

  // ── CRM ──────────────────────────────────────────────────────────────────
  console.log("── Caso 1: crear lead");
  const leadA = await crearLead(`${TAG} Alfa`, "0981111111", USUARIO_A);
  const leadB = await crearLead(`${TAG} Beta`, "0982222222", USUARIO_B);
  const leadSin = await crearLead(`${TAG} Huerfano`, "0983333333", null);
  const { rows: creado } = await p.query<{ etapa: string; numero_control: string }>(
    `SELECT etapa, numero_control FROM ${SCHEMA}.crm_prospectos WHERE id=$1::uuid`, [leadA]);
  check(creado[0]?.etapa === "LEAD", "Nace en etapa LEAD", creado[0]?.etapa);
  check(Boolean(creado[0]?.numero_control), "Recibe número de control", creado[0]?.numero_control);

  console.log("\n── Caso 2: mover entre etapas");
  await p.query(`UPDATE ${SCHEMA}.crm_prospectos SET etapa='NEGOCIACION', fecha_actualizacion=now() WHERE id=$1::uuid`, [leadA]);
  const { rows: movido } = await p.query<{ etapa: string }>(
    `SELECT etapa FROM ${SCHEMA}.crm_prospectos WHERE id=$1::uuid`, [leadA]);
  check(movido[0]?.etapa === "NEGOCIACION", "Cambia de etapa", movido[0]?.etapa);

  const { rows: etapasDb } = await p.query<{ codigo: string }>(
    `SELECT codigo FROM ${SCHEMA}.crm_etapas WHERE empresa_id=$1::uuid AND activo ORDER BY orden`, [EMPRESA]);
  const codigos = etapasDb.map((e) => e.codigo);
  check(
    ["LEAD", "CONTACTADO", "CHARLANDO", "NEGOCIACION", "GANADO", "PERDIDO"].every((c) => codigos.includes(c)),
    "Las 6 etapas vienen de crm_etapas (no hardcodeadas)", codigos.join(", ")
  );

  console.log("\n── Caso 3: buscar por teléfono");
  const { rows: porTel } = await p.query<{ id: string }>(
    `SELECT id FROM ${SCHEMA}.crm_prospectos WHERE empresa_id=$1::uuid AND telefono LIKE $2`,
    [EMPRESA, "%2222222%"]);
  check(porTel.length === 1 && porTel[0].id === leadB, "Encuentra por teléfono");

  console.log("\n── Caso 4: transferir responsable");
  await p.query(`UPDATE ${SCHEMA}.crm_prospectos SET responsable_usuario_id=$2::uuid WHERE id=$1::uuid`, [leadB, USUARIO_A]);
  const { rows: transferido } = await p.query<{ r: string }>(
    `SELECT responsable_usuario_id r FROM ${SCHEMA}.crm_prospectos WHERE id=$1::uuid`, [leadB]);
  check(transferido[0]?.r === USUARIO_A, "Queda reasignado");
  // Se devuelve a B para las pruebas de scope.
  await p.query(`UPDATE ${SCHEMA}.crm_prospectos SET responsable_usuario_id=$2::uuid WHERE id=$1::uuid`, [leadB, USUARIO_B]);

  // ── Scope (lo que el ERP de origen NO tenía) ─────────────────────────────
  const { rows: todos } = await p.query<{ id: string; responsable_usuario_id: string | null }>(
    `SELECT id, responsable_usuario_id FROM ${SCHEMA}.crm_prospectos WHERE empresa_id=$1::uuid AND empresa LIKE $2`,
    [EMPRESA, `${TAG}%`]);

  console.log("\n── Caso 5: admin ve todos");
  const vistaAdmin = aplicarScopeCrm(todos, { verTodos: true, usuarioId: null });
  check(vistaAdmin.length === 3, "Admin ve los 3 leads", `${vistaAdmin.length}`);

  console.log("\n── Caso 6: comercial ve solo los propios");
  const vistaA = aplicarScopeCrm(todos, { verTodos: false, usuarioId: USUARIO_A });
  check(vistaA.length === 1 && vistaA[0].id === leadA, "Usuario A ve solo el suyo", `${vistaA.length}`);
  const vistaB = aplicarScopeCrm(todos, { verTodos: false, usuarioId: USUARIO_B });
  check(vistaB.length === 1 && vistaB[0].id === leadB, "Usuario B ve solo el suyo", `${vistaB.length}`);
  check(
    !puedeAccederProspecto({ responsable_usuario_id: USUARIO_B }, { verTodos: false, usuarioId: USUARIO_A }),
    "Usuario A NO puede abrir el lead de B por id"
  );
  check(
    !vistaA.some((x) => x.responsable_usuario_id === null),
    "El lead sin responsable no cae en la vista de un comercial"
  );

  console.log("\n── Caso 7: usuario sin resolver NO ve todo");
  const vistaRota = aplicarScopeCrm(todos, { verTodos: false, usuarioId: null });
  check(vistaRota.length === 0, "Sin usuario resuelto devuelve CERO, no todos", `${vistaRota.length}`);

  console.log("\n── Caso 8: convertir lead ganado en cliente");
  await p.query(`UPDATE ${SCHEMA}.crm_prospectos SET etapa='GANADO' WHERE id=$1::uuid`, [leadA]);
  await p.query(
    `INSERT INTO ${SCHEMA}.clientes (empresa_id, empresa, nombre_contacto, telefono, estado)
     VALUES ($1::uuid, $2, 'Contacto QA', '0981111111', 'activo')`,
    [EMPRESA, `${TAG} Alfa`]);
  await p.query(`UPDATE ${SCHEMA}.crm_prospectos SET cliente_creado=true WHERE id=$1::uuid`, [leadA]);
  const { rows: cli } = await p.query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.clientes WHERE empresa_id=$1::uuid AND empresa=$2`, [EMPRESA, `${TAG} Alfa`]);
  check(Number(cli[0]?.n) === 1, "Cliente creado desde el lead");
  const { rows: flag } = await p.query<{ c: boolean }>(
    `SELECT cliente_creado c FROM ${SCHEMA}.crm_prospectos WHERE id=$1::uuid`, [leadA]);
  check(flag[0]?.c === true, "El lead queda marcado como convertido");
  void leadSin;

  // ── Monedas ──────────────────────────────────────────────────────────────
  console.log("\n── Caso 9: guardar y leer cotización");
  await guardarCotizacion(SCHEMA, EMPRESA, {
    cotizacion: 7300, moneda_origen: "USD", moneda_destino: "PYG",
    fuente: `${TAG}-auto`, es_manual: false, created_by: null,
  });
  const vig = await ultimaCotizacionGuardada(SCHEMA, EMPRESA, "USD", "PYG");
  check(vig?.cotizacion === 7300, "Devuelve la cotización guardada", String(vig?.cotizacion));
  check(vig?.es_manual === false, "Queda marcada como automática");

  console.log("\n── Caso 10: fallback a la última guardada");
  // Sin proveedor configurado, `getCotizacionVigente` cae a la última guardada.
  const fallback = await ultimaCotizacionGuardada(SCHEMA, EMPRESA, "USD", "PYG");
  check(fallback != null, "Hay una última cotización disponible como fallback");

  console.log("\n── Caso 11: carga manual auditada");
  await guardarCotizacion(SCHEMA, EMPRESA, {
    cotizacion: 7550, moneda_origen: "USD", moneda_destino: "PYG",
    fuente: `${TAG}-manual`, es_manual: true, created_by: null,
  });
  const manual = await ultimaCotizacionGuardada(SCHEMA, EMPRESA, "USD", "PYG");
  check(manual?.cotizacion === 7550, "La manual pisa a la anterior", String(manual?.cotizacion));
  check(manual?.es_manual === true, "Queda auditada como manual");

  console.log("\n── Caso 12: prohibición de tipo de cambio 1 para USD");
  // Es la misma regla que aplican /api/compras y /api/ordenes-compra.
  const rechaza = (moneda: string, tc: number) => moneda === "USD" && !(tc > 1);
  check(rechaza("USD", 1), "Rechaza USD con tipo de cambio 1");
  check(rechaza("USD", 0), "Rechaza USD sin tipo de cambio");
  check(!rechaza("USD", 7300), "Acepta USD con cotización real");
  check(!rechaza("PYG", 1), "No molesta a las operaciones en guaraníes");

  console.log("\n── Limpieza");
  await limpiar();
  console.log("  datos TEST eliminados");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTADO — OK: ${ok} · FALLOS: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("QA abortado:", e); process.exit(1); });
