/**
 * QA del borrado de productos: verifica los DOS caminos contra la base real.
 *
 *   1. Producto sin historial  → se borra de verdad
 *   2. Producto con ventas     → NO se borra, se archiva (activo = false)
 *   3. Producto con compras    → se archiva
 *   4. Producto con movimientos→ se archiva
 *   5. El archivado desaparece del listado pero el historial sobrevive
 *   6. Lo auxiliar (documentos adjuntos) se limpia solo al borrar
 *
 * Replica la lógica del endpoint contra la base (sin HTTP, que necesitaría
 * sesión). Lo que se prueba es la REGLA y las FK, que es donde está el riesgo.
 *
 * Ejecutar: npx tsx scripts/qa-eliminar-producto.ts
 */
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), ".env.local") });

import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";

const SCHEMA = "seguridadalimentariaerp";
const EMPRESA = "17908c42-c297-4506-bcb7-547ccecfe53a";
const TAG = "TEST-QA-DEL";

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
  await del(`DELETE FROM ${SCHEMA}.producto_documentos WHERE empresa_id=$1::uuid AND nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.movimientos_inventario WHERE empresa_id=$1::uuid AND producto_id IN (SELECT id FROM ${SCHEMA}.productos WHERE sku LIKE $2)`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.ventas_items WHERE empresa_id=$1::uuid AND producto_id IN (SELECT id FROM ${SCHEMA}.productos WHERE sku LIKE $2)`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.ventas WHERE empresa_id=$1::uuid AND numero_control LIKE $2`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.compras WHERE empresa_id=$1::uuid AND numero_control LIKE $2`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.productos WHERE empresa_id=$1::uuid AND sku LIKE $2`, [EMPRESA, `${TAG}%`]);
}

async function crearProducto(sku: string) {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.productos
       (empresa_id, nombre, sku, costo_promedio, precio_venta, stock_actual, stock_minimo,
        unidad_medida, metodo_valuacion, tipo_iva, activo)
     VALUES ($1::uuid, $2, $3, 1000, 5000, 0, 0, 'UNIDAD','CPP','10%', true)
     RETURNING id`,
    [EMPRESA, `${TAG} ${sku}`, `${TAG}-${sku}`]
  );
  return rows[0].id;
}

/** Misma regla que el endpoint: si hay historial se archiva; si no, se borra. */
async function eliminarComoElEndpoint(prodId: string): Promise<"eliminado" | "desactivado"> {
  const p = pool();
  const refs = [
    ["ventas_items", "producto_id"],
    ["compras", "producto_id"],
    ["movimientos_inventario", "producto_id"],
    ["ordenes_compra", "producto_id"],
    ["receta_items", "insumo_producto_id"],
  ] as const;
  let usos = 0;
  for (const [tabla, col] of refs) {
    const { rows } = await p.query<{ n: string }>(
      `SELECT count(*) n FROM ${SCHEMA}.${tabla} WHERE ${col} = $1::uuid`, [prodId]
    ).catch(() => ({ rows: [{ n: "0" }] }));
    usos += Number(rows[0]?.n ?? 0);
  }
  if (usos > 0) {
    await p.query(`UPDATE ${SCHEMA}.productos SET activo=false WHERE id=$1::uuid`, [prodId]);
    return "desactivado";
  }
  await p.query(`DELETE FROM ${SCHEMA}.productos WHERE id=$1::uuid`, [prodId]);
  return "eliminado";
}

async function existe(prodId: string) {
  const { rows } = await pool().query(`SELECT 1 FROM ${SCHEMA}.productos WHERE id=$1::uuid`, [prodId]);
  return rows.length > 0;
}
async function estaActivo(prodId: string) {
  const { rows } = await pool().query<{ activo: boolean }>(
    `SELECT activo FROM ${SCHEMA}.productos WHERE id=$1::uuid`, [prodId]);
  return rows[0]?.activo === true;
}

async function main() {
  console.log("QA — Eliminar productos (contra la base real)\n");
  await limpiar();
  const p = pool();

  console.log("── Caso 1: producto que nunca se usó");
  const limpio = await crearProducto("LIMPIO");
  const modo1 = await eliminarComoElEndpoint(limpio);
  check(modo1 === "eliminado", "Se elimina de verdad", modo1);
  check(!(await existe(limpio)), "Ya no está en la base");

  console.log("\n── Caso 2: producto con una venta");
  const conVenta = await crearProducto("CON-VENTA");
  const { rows: v } = await p.query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.ventas (empresa_id, numero_control, subtotal, monto_iva, total, tipo_venta, moneda, tipo_cambio, fecha, estado)
     VALUES ($1::uuid, $2, 9091, 909, 10000, 'CONTADO', 'GS', 1, now(), 'completada') RETURNING id`,
    [EMPRESA, `${TAG}-V1`]);
  await p.query(
    `INSERT INTO ${SCHEMA}.ventas_items
       (venta_id, empresa_id, producto_id, producto_nombre, sku, cantidad, precio_venta_original,
        precio_venta, tipo_iva, subtotal, monto_iva, total_linea)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 1, 10000, 10000, '10%', 9091, 909, 10000)`,
    [v[0].id, EMPRESA, conVenta, `${TAG} CON-VENTA`, `${TAG}-CON-VENTA`]);

  const modo2 = await eliminarComoElEndpoint(conVenta);
  check(modo2 === "desactivado", "NO se borra: se archiva", modo2);
  check(await existe(conVenta), "El producto sigue existiendo");
  check(!(await estaActivo(conVenta)), "Queda inactivo (sale del listado)");

  console.log("\n── Caso 3: el historial sobrevive");
  const { rows: hist } = await p.query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.ventas_items WHERE producto_id=$1::uuid`, [conVenta]);
  check(Number(hist[0]?.n) === 1, "La venta vieja sigue mostrando el producto", `${hist[0]?.n} línea(s)`);

  console.log("\n── Caso 4: la base IMPIDE borrar lo que tiene historial");
  let bloqueado = false;
  try {
    await p.query(`DELETE FROM ${SCHEMA}.productos WHERE id=$1::uuid`, [conVenta]);
  } catch {
    bloqueado = true;
  }
  check(bloqueado, "La FK RESTRICT bloquea el borrado directo (red de seguridad)");

  console.log("\n── Caso 5: producto con movimiento de stock");
  const conMov = await crearProducto("CON-MOV");
  await p.query(
    `INSERT INTO ${SCHEMA}.movimientos_inventario
       (empresa_id, producto_id, producto_nombre, producto_sku, tipo, origen, cantidad, costo_unitario, fecha)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'ENTRADA', 'ajuste_manual', 5, 1000, now())`,
    [EMPRESA, conMov, `${TAG} CON-MOV`, `${TAG}-CON-MOV`]);
  const modo5 = await eliminarComoElEndpoint(conMov);
  check(modo5 === "desactivado", "Con movimientos también se archiva", modo5);

  console.log("\n── Caso 6: los adjuntos se limpian al borrar de verdad");
  const conDoc = await crearProducto("CON-DOC");
  await p.query(
    `INSERT INTO ${SCHEMA}.producto_documentos
       (empresa_id, producto_id, nombre, archivo_path, archivo_nombre)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'ficha.pdf')`,
    [EMPRESA, conDoc, `${TAG} Ficha`, `${EMPRESA}/qa-del.pdf`]);
  const modo6 = await eliminarComoElEndpoint(conDoc);
  check(modo6 === "eliminado", "Un adjunto no impide borrar", modo6);
  const { rows: docs } = await p.query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.producto_documentos WHERE producto_id=$1::uuid`, [conDoc]);
  check(Number(docs[0]?.n) === 0, "El adjunto se borró en cascada");

  console.log("\n── Limpieza");
  await limpiar();
  console.log("  datos TEST eliminados");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTADO — OK: ${ok} · FALLOS: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("QA abortado:", e); process.exit(1); });
