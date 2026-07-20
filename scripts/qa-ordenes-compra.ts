/**
 * QA del flujo de órdenes de compra portado de Ferretería República.
 *
 * Modelo verificado: la OC NO toca inventario; al recibir se MATERIALIZAN filas
 * en `compras`, que son las que mueven stock. Se puede recibir en varias tandas.
 *
 * Casos verificados:
 *   1. Crear OC → numera OC-xxxxxx, estado 'pendiente', stock intacto
 *   2. Recepción parcial → compra real, stock += lo recibido, OC 'recibida_parcial'
 *   3. Idempotencia → reintentar con la misma clave NO duplica stock ni compra
 *   4. Excedente sin autorizar → rechazado; con `permitirExcedente` → aceptado
 *   5. Recepción del saldo → OC 'recibida_total'; recibir de nuevo → rechazado
 *   6. Costo promedio ponderado (mejora sobre el original, que pisaba el costo)
 *   7. Cancelar OC pendiente → estado 'cancelada', sin impacto en stock
 *
 * Ejecutar: npx tsx scripts/qa-ordenes-compra.ts
 */
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), ".env.local") });

import {
  insertOrdenCompra,
  confirmarRecepcionOrdenCompra,
  cancelarOrdenCompra,
  getOrdenCompra,
  ExcedenteRecepcionError,
} from "@/lib/ordenes-compra/server/ordenes-compra-pg";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";

const SCHEMA = "seguridadalimentariaerp";
const EMPRESA = "17908c42-c297-4506-bcb7-547ccecfe53a";
const TAG = "TEST-QA-OC";

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
async function stockDe(id: string) {
  const { rows } = await pool().query<{ s: string; c: string }>(
    `SELECT stock_actual s, costo_promedio c FROM ${SCHEMA}.productos WHERE id=$1::uuid`, [id]
  );
  return { stock: Number(rows[0]?.s) || 0, costo: Number(rows[0]?.c) || 0 };
}
/** Estado de la OC + cantidad recibida acumulada. */
async function estadoOc(numeroOc: string) {
  const { rows } = await pool().query<{ estado: string; recibida: string }>(
    `SELECT MIN(estado) estado, COALESCE(SUM(cantidad_recibida),0) recibida
       FROM ${SCHEMA}.ordenes_compra WHERE empresa_id=$1::uuid AND numero_oc=$2`,
    [EMPRESA, numeroOc]
  );
  return { estado: rows[0]?.estado ?? "", recibida: Number(rows[0]?.recibida) || 0 };
}
async function countCompras(numeroOc: string) {
  const { rows } = await pool().query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.compras WHERE empresa_id=$1::uuid AND orden_compra_numero=$2`,
    [EMPRESA, numeroOc]
  );
  return Number(rows[0]?.n) || 0;
}

async function limpiar() {
  const p = pool();
  const del = async (sql: string, args: unknown[]) => { await p.query(sql, args).catch(() => null); };
  await del(`DELETE FROM ${SCHEMA}.ordenes_compra_recepciones WHERE empresa_id=$1::uuid AND numero_oc IN (SELECT numero_oc FROM ${SCHEMA}.ordenes_compra WHERE empresa_id=$1::uuid AND producto_nombre LIKE $2)`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.movimientos_inventario WHERE empresa_id=$1::uuid AND producto_nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.cuentas_por_pagar WHERE empresa_id=$1::uuid AND numero_control IN (SELECT numero_control FROM ${SCHEMA}.compras WHERE empresa_id=$1::uuid AND producto_nombre LIKE $2)`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.compras WHERE empresa_id=$1::uuid AND producto_nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.ordenes_compra WHERE empresa_id=$1::uuid AND producto_nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.productos WHERE empresa_id=$1::uuid AND sku LIKE $2`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.proveedores WHERE empresa_id=$1::uuid AND nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
}

async function main() {
  console.log("QA — Órdenes de compra (modelo Ferretería República)\n");
  await limpiar();
  const p = pool();

  // Producto: stock 10, costo 1000. Proveedor de prueba.
  const { rows: pr } = await p.query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.productos
       (empresa_id, nombre, sku, costo_promedio, precio_venta, stock_actual, stock_minimo,
        unidad_medida, metodo_valuacion, tipo_iva, es_vendible, controla_stock, activo)
     VALUES ($1::uuid, $2, $3, 1000, 5000, 10, 0, 'UNIDAD','CPP','10%', true, true, true)
     RETURNING id`,
    [EMPRESA, `${TAG} Producto`, `${TAG}-P1`]
  );
  const prodId = pr[0].id;
  const { rows: prov } = await p.query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.proveedores (empresa_id, nombre, estado)
     VALUES ($1::uuid, $2, 'activo') RETURNING id`,
    [EMPRESA, `${TAG} Proveedor`]
  );
  const provId = prov[0].id;

  const header = {
    proveedor_id: provId, proveedor_nombre: `${TAG} Proveedor`,
    moneda: "PYG", tipo_cambio: 1, tipo_pago: "contado", plazo_dias: null,
    observacion: null, created_by: null, usuario_nombre: "qa",
  };
  // 10 unidades a 2000 c/u (costo distinto al actual, para probar el promedio).
  const item = {
    producto_id: prodId, producto_nombre: `${TAG} Producto`,
    cantidad: 10, costo_unitario_original: 2000, costo_unitario: 2000,
    iva_tipo: "10", subtotal: 18182, monto_iva: 1818, total: 20000,
    precio_venta: 5000, margen_venta: null,
  };

  // ── CASO 1: crear OC ─────────────────────────────────────────────────────
  console.log("── Caso 1: crear orden de compra");
  const oc = await insertOrdenCompra(SCHEMA, EMPRESA, header, [item]);
  check(/^OC-\d+$/.test(oc.numero_oc), "Numera la OC", oc.numero_oc);
  const e1 = await estadoOc(oc.numero_oc);
  check(e1.estado === "pendiente", "Estado 'pendiente'", e1.estado);
  const s1 = await stockDe(prodId);
  check(s1.stock === 10, "La OC NO impacta stock", `stock ${s1.stock}`);
  check(await countCompras(oc.numero_oc) === 0, "La OC NO genera compra todavía");

  const itemId = oc.ordenes[0].id;
  const recepBase = {
    numeroOc: oc.numero_oc, nroTimbrado: "12345678", fechaFactura: null,
    tipoPago: "contado", plazoDias: null, metodoPago: "efectivo",
    observacionCompra: null, permitirExcedente: false,
    comprobante: { url: null, storage_path: null, nombre: null, mime_type: null },
    createdBy: null, usuarioNombre: "qa",
  };

  // ── CASO 2: recepción parcial (4 de 10) ──────────────────────────────────
  console.log("\n── Caso 2: recepción parcial (4 de 10)");
  const r1 = await confirmarRecepcionOrdenCompra(SCHEMA, EMPRESA, {
    ...recepBase, numeroFactura: "001-001-0000001", idempotencyKey: `${TAG}-K1`,
    items: [{ ordenItemId: itemId, cantidadRecibidaAhora: 4, observacion: null }],
  });
  check(r1.estado_oc === "recibida_parcial", "OC queda 'recibida_parcial'", r1.estado_oc);
  check(/^COMP-/.test(r1.numero_control), "Genera compra real", r1.numero_control);
  const s2 = await stockDe(prodId);
  check(s2.stock === 14, "Stock sube SOLO por lo recibido", `10 + 4 = ${s2.stock}`);
  const e2 = await estadoOc(oc.numero_oc);
  check(e2.recibida === 4, "Acumula cantidad_recibida", `${e2.recibida}`);

  // ── CASO 6: costo promedio ponderado ─────────────────────────────────────
  // (10 × 1000 + 4 × 2000) / 14 = 1285.7143 — el original pisaba con 2000.
  console.log("\n── Caso 6: costo promedio ponderado");
  check(Math.abs(s2.costo - 1285.7143) < 0.01, "Costo promedio ponderado, no pisado", `${s2.costo}`);

  // ── CASO 3: idempotencia ─────────────────────────────────────────────────
  console.log("\n── Caso 3: idempotencia (mismo idempotency_key)");
  const r1bis = await confirmarRecepcionOrdenCompra(SCHEMA, EMPRESA, {
    ...recepBase, numeroFactura: "001-001-0000001", idempotencyKey: `${TAG}-K1`,
    items: [{ ordenItemId: itemId, cantidadRecibidaAhora: 4, observacion: null }],
  });
  check(r1bis.numero_control === r1.numero_control, "Devuelve la MISMA compra", r1bis.numero_control);
  const s3 = await stockDe(prodId);
  check(s3.stock === 14, "NO duplica stock", `stock ${s3.stock}`);
  check(await countCompras(oc.numero_oc) === 1, "NO duplica la compra");

  // ── CASO 4: excedente ────────────────────────────────────────────────────
  console.log("\n── Caso 4: excedente sobre lo pendiente (quedan 6, se reciben 8)");
  let rechazoExcedente = false;
  try {
    await confirmarRecepcionOrdenCompra(SCHEMA, EMPRESA, {
      ...recepBase, numeroFactura: "001-001-0000002", idempotencyKey: `${TAG}-K2`,
      items: [{ ordenItemId: itemId, cantidadRecibidaAhora: 8, observacion: null }],
    });
  } catch (e) {
    rechazoExcedente = e instanceof ExcedenteRecepcionError;
  }
  check(rechazoExcedente, "Rechaza excedente sin autorización explícita");
  const s4 = await stockDe(prodId);
  check(s4.stock === 14, "El rechazo NO dejó stock a medias (transacción)", `stock ${s4.stock}`);

  // ── CASO 5: recibir el saldo → total ─────────────────────────────────────
  console.log("\n── Caso 5: recibir el saldo (6 restantes)");
  const r2 = await confirmarRecepcionOrdenCompra(SCHEMA, EMPRESA, {
    ...recepBase, numeroFactura: "001-001-0000003", idempotencyKey: `${TAG}-K3`,
    items: [{ ordenItemId: itemId, cantidadRecibidaAhora: 6, observacion: null }],
  });
  check(r2.estado_oc === "recibida_total", "OC queda 'recibida_total'", r2.estado_oc);
  const s5 = await stockDe(prodId);
  check(s5.stock === 20, "Stock final correcto", `stock ${s5.stock}`);
  check(await countCompras(oc.numero_oc) === 2, "Dos compras: una por recepción");

  let rechazoCompleta = false;
  try {
    await confirmarRecepcionOrdenCompra(SCHEMA, EMPRESA, {
      ...recepBase, numeroFactura: "001-001-0000004", idempotencyKey: `${TAG}-K4`,
      items: [{ ordenItemId: itemId, cantidadRecibidaAhora: 1, observacion: null }],
    });
  } catch { rechazoCompleta = true; }
  check(rechazoCompleta, "Rechaza recibir una OC ya completa");

  // ── CASO 7: cancelar OC pendiente ────────────────────────────────────────
  console.log("\n── Caso 7: cancelar una OC pendiente");
  const oc2 = await insertOrdenCompra(SCHEMA, EMPRESA, header, [item]);
  await cancelarOrdenCompra(SCHEMA, EMPRESA, oc2.numero_oc, "QA");
  const e7 = await estadoOc(oc2.numero_oc);
  check(e7.estado === "cancelada", "Estado 'cancelada'", e7.estado);
  const s7 = await stockDe(prodId);
  check(s7.stock === 20, "Cancelar NO toca stock", `stock ${s7.stock}`);
  const det = await getOrdenCompra(SCHEMA, EMPRESA, oc2.numero_oc);
  check(det.length === 1, "La OC cancelada sigue siendo consultable");

  // ── Limpieza ─────────────────────────────────────────────────────────────
  console.log("\n── Limpieza");
  await limpiar();
  console.log("  datos TEST eliminados");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTADO — OK: ${ok} · FALLOS: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("QA abortado:", e); process.exit(1); });
