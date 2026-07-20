/**
 * QA de recepciones parciales (punto 9 del pedido).
 *
 * Ejercita la lógica real contra `seguridadalimentariaerp` con datos TEST-QA
 * que se limpian al final. Verifica los 6 casos pedidos:
 *   1. Orden de 10 → stock no cambia, estado pendiente
 *   2. Recibir 4  → stock +4, parcial, pendiente 6, una sola recepción
 *   3. Recibir 6  → stock +10 total, completa, pendiente 0
 *   4. Recibir 1 más → rechazado
 *   5. Repetir la misma petición (idempotencia) → no duplica stock
 *   6. Compra histórica → completa, sin volver a sumar stock
 *
 * Ejecutar: npx tsx scripts/qa-recepciones.ts
 */
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), ".env.local") });

import { insertComprasConImpacto } from "@/lib/compras/server/compras-pg";
import {
  registrarRecepcion,
  getEstadoOrden,
  listRecepciones,
  RecepcionError,
} from "@/lib/compras/server/recepciones-pg";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";

const SCHEMA = "seguridadalimentariaerp";
const EMPRESA = "17908c42-c297-4506-bcb7-547ccecfe53a";
const TAG = "TEST-QA-REC";

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

async function stockDe(productoId: string): Promise<number> {
  const { rows } = await pool().query<{ stock_actual: string; costo_promedio: string }>(
    `SELECT stock_actual, costo_promedio FROM ${SCHEMA}.productos WHERE id = $1::uuid`,
    [productoId]
  );
  return Number(rows[0]?.stock_actual) || 0;
}
async function costoDe(productoId: string): Promise<number> {
  const { rows } = await pool().query<{ costo_promedio: string }>(
    `SELECT costo_promedio FROM ${SCHEMA}.productos WHERE id = $1::uuid`,
    [productoId]
  );
  return Number(rows[0]?.costo_promedio) || 0;
}
async function movimientosDe(numero: string): Promise<number> {
  const { rows } = await pool().query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.movimientos_inventario
      WHERE empresa_id=$1::uuid AND referencia=$2 AND tipo='ENTRADA'`,
    [EMPRESA, numero]
  );
  return Number(rows[0]?.n) || 0;
}

/** Borra todo rastro de corridas anteriores. Orden inverso a las FKs. */
async function limpiarTest() {
  const p = pool();
  await p.query(`DELETE FROM ${SCHEMA}.compras_recepciones_items WHERE empresa_id=$1::uuid AND compra_id IN (SELECT id FROM ${SCHEMA}.compras WHERE empresa_id=$1::uuid AND usuario_nombre LIKE $2)`, [EMPRESA, `${TAG}%`]);
  await p.query(`DELETE FROM ${SCHEMA}.compras_recepciones WHERE empresa_id=$1::uuid AND (usuario_nombre LIKE $2 OR idempotency_key LIKE $2)`, [EMPRESA, `${TAG}%`]);
  await p.query(`DELETE FROM ${SCHEMA}.movimientos_inventario WHERE empresa_id=$1::uuid AND producto_nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
  await p.query(`DELETE FROM ${SCHEMA}.compras WHERE empresa_id=$1::uuid AND producto_nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
  await p.query(`DELETE FROM ${SCHEMA}.proveedor_productos WHERE empresa_id=$1::uuid AND producto_id IN (SELECT id FROM ${SCHEMA}.productos WHERE empresa_id=$1::uuid AND sku LIKE $2)`, [EMPRESA, `${TAG}%`]);
  await p.query(`DELETE FROM ${SCHEMA}.productos WHERE empresa_id=$1::uuid AND sku LIKE $2`, [EMPRESA, `${TAG}%`]);
  await p.query(`DELETE FROM ${SCHEMA}.proveedores WHERE empresa_id=$1::uuid AND nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
}

async function main() {
  console.log("QA — Órdenes de compra y recepciones parciales\n");

  // ── Preparación: limpieza previa (el script debe ser re-ejecutable) ──────
  await limpiarTest();

  const { rows: prodRows } = await pool().query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.productos
       (empresa_id, nombre, sku, costo_promedio, precio_venta, stock_actual, stock_minimo,
        unidad_medida, metodo_valuacion, tipo_iva, es_vendible, controla_stock, activo)
     VALUES ($1::uuid, $2, $3, 1000, 2000, 0, 0, 'UNIDAD', 'CPP', '10%', true, true, true)
     RETURNING id`,
    [EMPRESA, `${TAG} Producto`, `${TAG}-P1`]
  );
  const productoId = prodRows[0].id;

  const { rows: provRows } = await pool().query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.proveedores (empresa_id, nombre, estado)
     VALUES ($1::uuid, $2, 'activo') RETURNING id`,
    [EMPRESA, `${TAG} Proveedor`]
  );
  const proveedorId = provRows[0].id;

  const stockInicial = await stockDe(productoId);
  console.log(`  (producto ${productoId.slice(0, 8)}… stock inicial ${stockInicial})\n`);

  // ── CASO 1: crear orden de 10 → NO debe tocar stock ──────────────────────
  console.log("── Caso 1: crear orden de 10 unidades");
  const orden = await insertComprasConImpacto(SCHEMA, EMPRESA, {
    proveedor_id: proveedorId,
    proveedor_nombre: `${TAG} Proveedor`,
    moneda: "PYG",
    tipo_cambio: 1,
    tipo_pago: "contado",
    plazo_dias: null,
    nro_timbrado: null,           // orden sin factura todavía
    fecha_factura: null,
    metodo_pago: null,
    comprobante_url: null,
    comprobante_storage_path: null,
    comprobante_nombre: null,
    comprobante_mime_type: null,
    created_by: null,
    usuario_nombre: `${TAG}`,
    fecha_estimada_llegada: "2026-08-01",
  }, [{
    producto_id: productoId,
    producto_nombre: `${TAG} Producto`,
    cantidad: 10,
    costo_unitario_original: 1000,
    costo_unitario: 1000,
    iva_tipo: "10",
    subtotal: 9091,
    monto_iva: 909,
    total: 10000,
    precio_venta: 2000,
    margen_venta: null,
  }]);
  const numero = orden.numero_control;

  check(await stockDe(productoId) === stockInicial, "Crear orden NO aumenta stock",
    `stock sigue en ${await stockDe(productoId)}`);
  check(await movimientosDe(numero) === 0, "Crear orden NO genera movimiento ENTRADA");
  let lineas = await getEstadoOrden(SCHEMA, EMPRESA, numero);
  check(lineas[0]?.estado_recepcion === "pendiente", "Estado inicial 'pendiente'", lineas[0]?.estado_recepcion);
  check(lineas[0]?.pendiente === 10, "Pendiente = 10", String(lineas[0]?.pendiente));
  const compraId = lineas[0].compra_id;

  // ── CASO 2: recibir 4 ────────────────────────────────────────────────────
  console.log("\n── Caso 2: recibir 4 unidades");
  const r1 = await registrarRecepcion(SCHEMA, EMPRESA, {
    numero_control: numero,
    items: [{ compra_id: compraId, cantidad_recibida: 4 }],
    observaciones: "Primera entrega",
    proxima_entrega_estimada: "2026-08-15",
    idempotency_key: `${TAG}-key-1`,
    usuario_nombre: TAG,
  });
  check(await stockDe(productoId) === stockInicial + 4, "Stock aumenta exactamente 4",
    `stock ${await stockDe(productoId)}`);
  check(r1.estado_orden === "parcial", "Estado 'parcial'", r1.estado_orden);
  check(r1.lineas[0].pendiente === 6, "Pendiente = 6", String(r1.lineas[0].pendiente));
  check(await movimientosDe(numero) === 1, "Se creó UN solo movimiento ENTRADA");
  check((await listRecepciones(SCHEMA, EMPRESA, numero)).length === 1, "Se registró UNA sola recepción");

  // ── CASO 5 (idempotencia): repetir la misma petición ─────────────────────
  console.log("\n── Caso 5: repetir la misma petición (idempotencia)");
  const stockAntesRepeticion = await stockDe(productoId);
  const r1bis = await registrarRecepcion(SCHEMA, EMPRESA, {
    numero_control: numero,
    items: [{ compra_id: compraId, cantidad_recibida: 4 }],
    idempotency_key: `${TAG}-key-1`,     // misma clave
    usuario_nombre: TAG,
  });
  check(r1bis.idempotente === true, "Detectada como repetición");
  check(await stockDe(productoId) === stockAntesRepeticion, "NO duplica stock",
    `stock sigue en ${await stockDe(productoId)}`);
  check((await listRecepciones(SCHEMA, EMPRESA, numero)).length === 1, "Sigue habiendo UNA recepción");

  // ── CASO 3: recibir las 6 restantes ──────────────────────────────────────
  console.log("\n── Caso 3: recibir las 6 restantes");
  const r2 = await registrarRecepcion(SCHEMA, EMPRESA, {
    numero_control: numero,
    items: [{ compra_id: compraId, cantidad_recibida: 6 }],
    idempotency_key: `${TAG}-key-2`,
    usuario_nombre: TAG,
  });
  check(await stockDe(productoId) === stockInicial + 10, "Stock total aumentó 10",
    `stock ${await stockDe(productoId)}`);
  check(r2.estado_orden === "completa", "Estado 'completa'", r2.estado_orden);
  check(r2.lineas[0].pendiente === 0, "Pendiente = 0");
  check(await movimientosDe(numero) === 2, "Dos movimientos ENTRADA (uno por entrega)");

  // ── CASO 4: intentar recibir una unidad más ──────────────────────────────
  console.log("\n── Caso 4: intentar recibir 1 unidad extra");
  let rechazado = false, motivo = "";
  try {
    await registrarRecepcion(SCHEMA, EMPRESA, {
      numero_control: numero,
      items: [{ compra_id: compraId, cantidad_recibida: 1 }],
      idempotency_key: `${TAG}-key-3`,
      usuario_nombre: TAG,
    });
  } catch (e) {
    rechazado = e instanceof RecepcionError;
    motivo = e instanceof Error ? e.message : String(e);
  }
  check(rechazado, "Rechaza recibir de más", motivo.slice(0, 70));
  check(await stockDe(productoId) === stockInicial + 10, "Stock intacto tras el rechazo");

  // ── Costo promedio ponderado ─────────────────────────────────────────────
  console.log("\n── Extra: costo promedio ponderado");
  check(await costoDe(productoId) === 1000, "Costo promedio correcto tras 2 entregas al mismo costo",
    `costo ${await costoDe(productoId)}`);

  // ── CASO 6: compra histórica ─────────────────────────────────────────────
  console.log("\n── Caso 6: compras históricas (backfill)");
  const { rows: hist } = await pool().query<{ n: string; pend: string }>(
    `SELECT count(*) n, COALESCE(SUM(cantidad - cantidad_recibida),0) pend
       FROM ${SCHEMA}.compras
      WHERE empresa_id=$1::uuid AND numero_control <> $2 AND estado_recepcion='completa'`,
    [EMPRESA, numero]
  );
  check(Number(hist[0].n) > 0, "Compras históricas marcadas 'completa'", `${hist[0].n} líneas`);
  check(Number(hist[0].pend) === 0, "Sin pendientes en históricas (no re-suman stock)");

  // ── Limpieza ─────────────────────────────────────────────────────────────
  console.log("\n── Limpieza");
  await pool().query(`DELETE FROM ${SCHEMA}.compras_recepciones_items WHERE empresa_id=$1::uuid AND compra_id IN (SELECT id FROM ${SCHEMA}.compras WHERE numero_control=$2)`, [EMPRESA, numero]);
  await pool().query(`DELETE FROM ${SCHEMA}.compras_recepciones WHERE empresa_id=$1::uuid AND numero_control=$2`, [EMPRESA, numero]);
  await pool().query(`DELETE FROM ${SCHEMA}.movimientos_inventario WHERE empresa_id=$1::uuid AND referencia=$2`, [EMPRESA, numero]);
  await pool().query(`DELETE FROM ${SCHEMA}.compras WHERE empresa_id=$1::uuid AND numero_control=$2`, [EMPRESA, numero]);
  await pool().query(`DELETE FROM ${SCHEMA}.proveedor_productos WHERE empresa_id=$1::uuid AND producto_id=$2::uuid`, [EMPRESA, productoId]);
  await pool().query(`DELETE FROM ${SCHEMA}.productos WHERE id=$1::uuid`, [productoId]);
  await pool().query(`DELETE FROM ${SCHEMA}.proveedores WHERE id=$1::uuid`, [proveedorId]);
  console.log("  datos TEST eliminados");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTADO — OK: ${ok} · FALLOS: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("QA abortado:", e); process.exit(1); });
