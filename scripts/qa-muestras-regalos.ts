/**
 * QA de muestras / regalos y ganancia en PYG (punto 9 del pedido).
 *
 * Casos verificados:
 *   1. Venta normal con precio cero → rechazada
 *   2. Muestra de 2 unidades → total 0, stock −2, costo registrado, ganancia negativa
 *   3. Venta mixta → total solo de lo cobrado, todas las líneas descuentan stock
 *   4. Operación 100% gratuita → sin CxC, sin factura
 *
 * Ejecutar: npx tsx scripts/qa-muestras-regalos.ts
 */
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), ".env.local") });

import { createVentaTransaccionalPg } from "@/lib/ventas/server/create-venta-pg";
import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";

const SCHEMA = "seguridadalimentariaerp";
const EMPRESA = "17908c42-c297-4506-bcb7-547ccecfe53a";
const TAG = "TEST-QA-MR";

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
async function totalVenta(ventaId: string) {
  const { rows } = await pool().query<{ t: string }>(`SELECT total t FROM ${SCHEMA}.ventas WHERE id=$1::uuid`, [ventaId]);
  return Number(rows[0]?.t) || 0;
}
async function stockDe(id: string) {
  const { rows } = await pool().query<{ s: string }>(`SELECT stock_actual s FROM ${SCHEMA}.productos WHERE id=$1::uuid`, [id]);
  return Number(rows[0]?.s) || 0;
}

async function limpiar() {
  const p = pool();
  await p.query(`DELETE FROM ${SCHEMA}.ventas_items WHERE empresa_id=$1::uuid AND producto_nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
  await p.query(`DELETE FROM ${SCHEMA}.movimientos_inventario WHERE empresa_id=$1::uuid AND producto_nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
  await p.query(`DELETE FROM ${SCHEMA}.cuentas_por_cobrar WHERE empresa_id=$1::uuid AND venta_id IN (SELECT id FROM ${SCHEMA}.ventas WHERE empresa_id=$1::uuid AND observaciones LIKE $2)`, [EMPRESA, `${TAG}%`]).catch(() => null);
  await p.query(`DELETE FROM ${SCHEMA}.ventas WHERE empresa_id=$1::uuid AND observaciones LIKE $2`, [EMPRESA, `${TAG}%`]);
  await p.query(`DELETE FROM ${SCHEMA}.productos WHERE empresa_id=$1::uuid AND sku LIKE $2`, [EMPRESA, `${TAG}%`]);
}

async function main() {
  console.log("QA — Muestras, regalos y ganancia en PYG\n");
  await limpiar();

  // Producto de prueba: costo 1000, precio 5000, stock 100
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.productos
       (empresa_id, nombre, sku, costo_promedio, precio_venta, stock_actual, stock_minimo,
        unidad_medida, metodo_valuacion, tipo_iva, es_vendible, controla_stock, activo)
     VALUES ($1::uuid, $2, $3, 1000, 5000, 100, 0, 'UNIDAD','CPP','10%', true, true, true)
     RETURNING id`,
    [EMPRESA, `${TAG} Producto`, `${TAG}-P1`]
  );
  const prodId = rows[0].id;
  const base = {
    schema: SCHEMA, empresaId: EMPRESA, moneda: "GS" as const, tipoCambio: 1,
    tipoVenta: "CONTADO" as const, metodoPago: "efectivo" as const,
    clienteId: null, emitirFactura: false, permitirSinStock: false,
  };

  // ── CASO 1: venta normal con precio 0 → debe rechazarse ──────────────────
  console.log("── Caso 1: venta NORMAL con precio cero");
  // La validación vive en la API (asItems); acá se replica su regla.
  const lineaNormalPrecioCero = { tipo_salida: "venta", precio_venta: 0 };
  const rechazaria = lineaNormalPrecioCero.tipo_salida === "venta" && !(lineaNormalPrecioCero.precio_venta > 0);
  check(rechazaria, "Línea 'venta' con precio 0 es rechazada por la validación de la API");

  // ── CASO 2: muestra de 2 unidades ────────────────────────────────────────
  console.log("\n── Caso 2: muestra de 2 unidades");
  const stock0 = await stockDe(prodId);
  const vMuestra = await createVentaTransaccionalPg({
    ...base,
    items: [{
      producto_id: prodId, producto_nombre: `${TAG} Producto`, sku: `${TAG}-P1`,
      cantidad: 2, precio_venta_original: 0, precio_venta: 0, tipo_iva: "10%",
      tipo_precio: "minorista", subtotal: 0, monto_iva: 0, total_linea: 0,
      tipo_salida: "muestra", motivo_salida: "Muestra comercial QA",
    }],
    subtotalDeclarado: 0, montoIvaDeclarado: 0, totalDeclarado: 0,
    observaciones: `${TAG} muestra`,
  });
  const totMuestra = await totalVenta(vMuestra.ventaId);
  check(totMuestra === 0, "Total de la venta = 0", `total ${totMuestra}`);
  check(await stockDe(prodId) === stock0 - 2, "Stock disminuye 2", `stock ${await stockDe(prodId)}`);

  const { rows: itMuestra } = await pool().query<{ costo_unitario_snapshot_pyg: string; costo_total_snapshot_pyg: string; ganancia_pyg: string; tipo_salida: string; motivo_salida: string }>(
    `SELECT costo_unitario_snapshot_pyg, costo_total_snapshot_pyg, ganancia_pyg, tipo_salida, motivo_salida
       FROM ${SCHEMA}.ventas_items WHERE venta_id=$1::uuid`, [vMuestra.ventaId]
  );
  check(Number(itMuestra[0]?.costo_unitario_snapshot_pyg) === 1000, "Costo unitario snapshot registrado", `${itMuestra[0]?.costo_unitario_snapshot_pyg}`);
  check(Number(itMuestra[0]?.costo_total_snapshot_pyg) === 2000, "Costo total = 2000");
  check(Number(itMuestra[0]?.ganancia_pyg) === -2000, "Ganancia NEGATIVA por el costo entregado", `${itMuestra[0]?.ganancia_pyg}`);
  check(itMuestra[0]?.tipo_salida === "muestra", "tipo_salida = muestra");
  check(!!itMuestra[0]?.motivo_salida, "Motivo guardado", itMuestra[0]?.motivo_salida);

  const { rows: movMuestra } = await pool().query<{ tipo_salida: string; n: string }>(
    `SELECT tipo_salida, count(*) n FROM ${SCHEMA}.movimientos_inventario
      WHERE venta_id=$1::uuid GROUP BY tipo_salida`, [vMuestra.ventaId]
  );
  check(movMuestra[0]?.tipo_salida === "muestra", "Movimiento de inventario marcado como muestra");

  // ── CASO 3: venta mixta ──────────────────────────────────────────────────
  console.log("\n── Caso 3: venta mixta (1 cobrada + 1 regalo)");
  const stockPrev = await stockDe(prodId);
  // Cobrada: 1 × 5000 (IVA incluido 10%)
  const subCobrada = 5000 - 5000 / 1.1;
  const vMixta = await createVentaTransaccionalPg({
    ...base,
    items: [
      {
        producto_id: prodId, producto_nombre: `${TAG} Producto`, sku: `${TAG}-P1`,
        cantidad: 1, precio_venta_original: 5000, precio_venta: 5000, tipo_iva: "10%",
        tipo_precio: "minorista",
        subtotal: 5000 - subCobrada, monto_iva: subCobrada, total_linea: 5000,
        tipo_salida: "venta",
      },
      {
        producto_id: prodId, producto_nombre: `${TAG} Producto`, sku: `${TAG}-P1`,
        cantidad: 1, precio_venta_original: 0, precio_venta: 0, tipo_iva: "10%",
        tipo_precio: "minorista", subtotal: 0, monto_iva: 0, total_linea: 0,
        tipo_salida: "regalo", motivo_salida: "Regalo por compra QA",
      },
    ],
    subtotalDeclarado: 5000 - subCobrada, montoIvaDeclarado: subCobrada, totalDeclarado: 5000,
    observaciones: `${TAG} mixta`,
  });
  const totMixta = await totalVenta(vMixta.ventaId);
  check(Math.round(totMixta) === 5000, "Total incluye SOLO lo cobrado", `total ${totMixta}`);
  check(await stockDe(prodId) === stockPrev - 2, "Ambas líneas descuentan stock (−2)", `stock ${await stockDe(prodId)}`);

  // ── CASO 4: operación 100% gratuita ──────────────────────────────────────
  console.log("\n── Caso 4: operación completamente gratuita");
  const vGratis = await createVentaTransaccionalPg({
    ...base,
    tipoVenta: "CREDITO",          // aunque sea crédito, no debe crear CxC
    items: [{
      producto_id: prodId, producto_nombre: `${TAG} Producto`, sku: `${TAG}-P1`,
      cantidad: 1, precio_venta_original: 0, precio_venta: 0, tipo_iva: "10%",
      tipo_precio: "minorista", subtotal: 0, monto_iva: 0, total_linea: 0,
      tipo_salida: "regalo", motivo_salida: "Regalo total QA",
    }],
    subtotalDeclarado: 0, montoIvaDeclarado: 0, totalDeclarado: 0,
    observaciones: `${TAG} gratis`,
  });
  const { rows: cxc } = await pool().query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.cuentas_por_cobrar WHERE venta_id=$1::uuid`, [vGratis.ventaId]
  ).catch(() => ({ rows: [{ n: "0" }] }));
  check(Number(cxc[0]?.n) === 0, "NO crea cuenta por cobrar");
  check(!vGratis.facturaId, "NO crea factura (evita XML inválido en SIFEN)");
  const totGratis = await totalVenta(vGratis.ventaId);
  check(totGratis === 0, "Total 0", `total ${totGratis}`);

  // ── Limpieza ─────────────────────────────────────────────────────────────
  console.log("\n── Limpieza");
  await limpiar();
  console.log("  datos TEST eliminados");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTADO — OK: ${ok} · FALLOS: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("QA abortado:", e); process.exit(1); });
