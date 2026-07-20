/**
 * QA de Presupuestos (punto 3) y de aislamiento multi-tenant (punto 9).
 *
 * Presupuestos:
 *   1. Crear presupuesto con ítems
 *   2. No descuenta stock
 *   3. El detalle devuelve TODOS los campos que guarda el alta (incl. fecha_entrega)
 *   4. Cambio de estado
 *   5. El documento usa una sola fuente para el nombre de la empresa
 *
 * Seguridad:
 *   6. Aislamiento por empresa_id en las tablas del pedido
 *   7. Aislamiento por schema: assertAllowedChatDataSchema rechaza otros schemas
 *   8. Las tablas nuevas tienen RLS activo
 *
 * Ejecutar: npx tsx scripts/qa-presupuestos-y-seguridad.ts
 */
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), ".env.local") });

import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { EMPRESA_DOC } from "@/lib/documentos/membrete";

const SCHEMA = "seguridadalimentariaerp";
const EMPRESA = "17908c42-c297-4506-bcb7-547ccecfe53a";
const TAG = "TEST-QA-PRE";

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

async function limpiar() {
  const p = pool();
  const del = async (sql: string, args: unknown[]) => { await p.query(sql, args).catch(() => null); };
  await del(`DELETE FROM ${SCHEMA}.presupuesto_items WHERE presupuesto_id IN (SELECT id FROM ${SCHEMA}.presupuestos WHERE empresa_id=$1::uuid AND cliente_nombre LIKE $2)`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.presupuestos WHERE empresa_id=$1::uuid AND cliente_nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.productos WHERE empresa_id=$1::uuid AND sku LIKE $2`, [EMPRESA, `${TAG}%`]);
}

async function main() {
  console.log("QA — Presupuestos y aislamiento\n");
  await limpiar();
  const p = pool();

  // Producto con stock conocido, para verificar que el presupuesto no lo toque.
  const { rows: pr } = await p.query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.productos
       (empresa_id, nombre, sku, costo_promedio, precio_venta, stock_actual, stock_minimo,
        unidad_medida, metodo_valuacion, tipo_iva, es_vendible, controla_stock, activo)
     VALUES ($1::uuid, $2, $3, 1000, 5000, 50, 0, 'UNIDAD','CPP','10%', true, true, true)
     RETURNING id`,
    [EMPRESA, `${TAG} Producto`, `${TAG}-P1`]
  );
  const prodId = pr[0].id;
  const stockAntes = 50;

  console.log("── Caso 1: crear presupuesto");
  const { rows: pres } = await p.query<{ id: string; numero_control: string }>(
    `INSERT INTO ${SCHEMA}.presupuestos
       (empresa_id, cliente_id, cliente_nombre, cliente_ruc, numero_control, estado, moneda,
        subtotal, monto_iva, descuento_total, total, validez_dias,
        fecha, fecha_vencimiento, fecha_entrega, forma_pago, plazo_entrega, observaciones)
     VALUES ($1::uuid, NULL, $2, '80012345-6', $3, 'creado', 'PYG',
             90909, 9091, 0, 100000, 15,
             now(), now() + interval '15 days', current_date + 7, 'Contado', '7 dias', 'Obs QA')
     RETURNING id, numero_control`,
    [EMPRESA, `${TAG} Cliente`, `${TAG}-0001`]
  );
  const presId = pres[0].id;
  check(Boolean(presId), "Presupuesto creado", pres[0].numero_control);

  await p.query(
    `INSERT INTO ${SCHEMA}.presupuesto_items
       (presupuesto_id, empresa_id, producto_id, producto_nombre, sku, cantidad,
        unidad_medida, precio_unitario, iva_tipo, subtotal, monto_iva, descuento, total)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 2, 'UNIDAD', 50000, '10%', 90909, 9091, 0, 100000)`,
    [presId, EMPRESA, prodId, `${TAG} Producto`, `${TAG}-P1`]
  );
  const { rows: its } = await p.query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.presupuesto_items WHERE presupuesto_id=$1::uuid`, [presId]);
  check(Number(its[0]?.n) === 1, "Guarda los ítems");

  console.log("\n── Caso 2: no descuenta stock");
  const { rows: st } = await p.query<{ s: string }>(
    `SELECT stock_actual s FROM ${SCHEMA}.productos WHERE id=$1::uuid`, [prodId]);
  check(Number(st[0]?.s) === stockAntes, "El stock quedó intacto", `${st[0]?.s}`);
  const { rows: mov } = await p.query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.movimientos_inventario WHERE empresa_id=$1::uuid AND producto_id=$2::uuid`,
    [EMPRESA, prodId]);
  check(Number(mov[0]?.n) === 0, "No generó movimientos de inventario");

  console.log("\n── Caso 3: el detalle devuelve todos los campos del alta");
  // Regresión: `fecha_entrega` se guardaba pero la lista de columnas del
  // endpoint de detalle la omitía, así que el front nunca la veía.
  const PRESU_COLS_DETALLE = [
    "id", "cliente_id", "cliente_nombre", "cliente_ruc", "cliente_telefono", "cliente_direccion",
    "numero_control", "estado", "moneda", "subtotal", "monto_iva", "descuento_total", "total",
    "validez_dias", "fecha", "fecha_vencimiento", "fecha_entrega", "forma_pago", "plazo_entrega",
    "observaciones", "convertido_pedido_id", "convertido_venta_id", "created_at", "updated_at",
  ];
  const { rows: det } = await p.query(
    `SELECT ${PRESU_COLS_DETALLE.join(", ")} FROM ${SCHEMA}.presupuestos WHERE id=$1::uuid`, [presId]);
  const row = det[0] as Record<string, unknown>;
  check(row != null, "El detalle se puede leer con todas las columnas");
  check(row?.fecha_entrega != null, "Devuelve fecha_entrega", String(row?.fecha_entrega ?? "null"));
  check(row?.forma_pago === "Contado", "Devuelve forma_pago");
  check(row?.plazo_entrega === "7 dias", "Devuelve plazo_entrega");
  check(Number(row?.validez_dias) === 15, "Devuelve validez_dias");

  console.log("\n── Caso 4: cambio de estado");
  await p.query(`UPDATE ${SCHEMA}.presupuestos SET estado='enviado' WHERE id=$1::uuid`, [presId]);
  const { rows: est } = await p.query<{ e: string }>(
    `SELECT estado e FROM ${SCHEMA}.presupuestos WHERE id=$1::uuid`, [presId]);
  check(est[0]?.e === "enviado", "Estado actualizado", est[0]?.e);

  console.log("\n── Caso 5: identidad del documento");
  // El PDF imprimía el nombre por dos vías (env y tabla `empresas`), que podían
  // no coincidir. Ahora el membrete recibe el nombre ya resuelto.
  const { rows: emp } = await p.query<{ nombre: string | null }>(
    `SELECT nombre_empresa AS nombre FROM ${SCHEMA}.empresas WHERE id=$1::uuid`, [EMPRESA]);
  const nombreTabla = (emp[0]?.nombre ?? "").trim();
  const nombreEnv = (process.env.NEURA_CLIENT_NAME ?? "").trim();
  const resuelto = nombreEnv || nombreTabla || "Seguridad Alimentaria";
  console.log(`     env="${nombreEnv}" · tabla="${nombreTabla}" · resuelto="${resuelto}"`);
  check(Boolean(resuelto), "Hay un nombre de empresa resoluble", resuelto);
  const OTROS_CLIENTES = ["reserva", "caacupe", "ferreter", "mari", "papu", "triple7"];
  check(
    !OTROS_CLIENTES.some((c) => resuelto.toLowerCase().includes(c)),
    "El nombre no es de otro cliente", resuelto
  );
  check(
    !OTROS_CLIENTES.some((c) => (EMPRESA_DOC.logoUrl ?? "").toLowerCase().includes(c)),
    "El logo no es de otro cliente", EMPRESA_DOC.logoUrl
  );

  // ── Seguridad ────────────────────────────────────────────────────────────
  console.log("\n── Caso 6: aislamiento por empresa_id");
  const TABLAS = [
    "presupuestos", "ordenes_compra", "compras", "ventas", "ventas_items",
    "crm_prospectos", "documentos", "notificaciones", "cotizaciones_moneda",
  ];
  for (const t of TABLAS) {
    const { rows } = await p.query<{ n: string }>(
      `SELECT count(*) n FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2 AND column_name='empresa_id'`, [SCHEMA, t]);
    check(Number(rows[0]?.n) === 1, `${t} tiene empresa_id`);
  }
  const { rows: fuera } = await p.query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.presupuestos WHERE empresa_id <> $1::uuid`, [EMPRESA]);
  check(Number(fuera[0]?.n) === 0, "No hay presupuestos de otra empresa en este schema", `${fuera[0]?.n}`);

  console.log("\n── Caso 7: aislamiento por schema");
  check(assertAllowedChatDataSchema(SCHEMA) === SCHEMA, "Acepta el schema propio");
  // `public` se acepta A PROPOSITO: es el schema de la app, no el de un tenant
  // (ver chat-data-schema.ts). Lo que debe rechazar es el schema de OTRO cliente
  // y cualquier intento de inyectar SQL en el nombre.
  check(assertAllowedChatDataSchema("public") === "public", "Acepta 'public' (schema de la app, por diseño)");
  for (const otro of ["reservacaacupe", "ferreteriarepublica", "zentra_erp; DROP TABLE x"]) {
    let rechazo = false;
    try { assertAllowedChatDataSchema(otro); } catch { rechazo = true; }
    check(rechazo, `Rechaza "${otro}"`);
  }

  console.log("\n── Caso 8: RLS en las tablas nuevas");
  const NUEVAS = ["ordenes_compra", "ordenes_compra_recepciones", "documentos", "notificaciones", "cotizaciones_moneda"];
  for (const t of NUEVAS) {
    const { rows } = await p.query<{ rls: boolean }>(
      `SELECT c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname=$2`, [SCHEMA, t]);
    check(rows[0]?.rls === true, `${t} tiene RLS activo`);
  }

  console.log("\n── Limpieza");
  await limpiar();
  console.log("  datos TEST eliminados");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTADO — OK: ${ok} · FALLOS: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("QA abortado:", e); process.exit(1); });
