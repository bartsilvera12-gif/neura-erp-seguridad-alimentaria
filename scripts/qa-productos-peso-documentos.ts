/**
 * QA de peso del producto y documentación adjunta.
 *
 * Peso:
 *   1. Conversión g/kg en ambos sentidos (ida y vuelta sin pérdida)
 *   2. Se guarda en gramos sin importar la unidad elegida
 *   3. Constraints: peso negativo o cero rechazado, unidad inválida rechazada
 *   4. Fórmula de flete
 *   5. La unidad comercial (`unidad_medida`) NO se ve afectada
 *
 * Documentación:
 *   6. Adjuntar varios archivos a un producto
 *   7. Un mismo archivo no se registra dos veces
 *   8. Borrar el producto se lleva sus adjuntos (CASCADE)
 *   9. Aislamiento por empresa_id + RLS
 *
 * Ejecutar: npx tsx scripts/qa-productos-peso-documentos.ts
 */
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), ".env.local") });

import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { aGramos, desdeGramos, aKilos, fletePorProducto, formatPeso } from "@/lib/inventario/peso";

const SCHEMA = "seguridadalimentariaerp";
const EMPRESA = "17908c42-c297-4506-bcb7-547ccecfe53a";
const TAG = "TEST-QA-PESO";

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
  await del(`DELETE FROM ${SCHEMA}.productos WHERE empresa_id=$1::uuid AND sku LIKE $2`, [EMPRESA, `${TAG}%`]);
}

async function crearProducto(sku: string, pesoGramos: number | null, unidad = "kg") {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.productos
       (empresa_id, nombre, sku, costo_promedio, precio_venta, stock_actual, stock_minimo,
        unidad_medida, metodo_valuacion, tipo_iva, peso_gramos, peso_unidad)
     VALUES ($1::uuid, $2, $3, 0, 0, 0, 0, 'UNIDAD', 'CPP', '10%', $4::numeric, $5)
     RETURNING id`,
    [EMPRESA, `${TAG} ${sku}`, sku, pesoGramos, unidad]
  );
  return rows[0].id;
}

async function main() {
  console.log("QA — Peso del producto y documentación adjunta\n");
  await limpiar();
  const p = pool();

  // ── Peso: conversión ──────────────────────────────────────────────────────
  console.log("── Caso 1: conversión g ↔ kg");
  check(aGramos(2.5, "kg") === 2500, "2,5 kg → 2500 g");
  check(aGramos(250, "g") === 250, "250 g → 250 g");
  check(desdeGramos(2500, "kg") === 2.5, "2500 g → 2,5 kg");
  check(desdeGramos(250, "g") === 250, "250 g → 250 g");
  // Ida y vuelta: el valor que ve el usuario no debe cambiar al guardar y releer.
  for (const [v, u] of [[0.5, "kg"], [1.25, "kg"], [750, "g"], [0.001, "kg"]] as const) {
    check(desdeGramos(aGramos(v, u), u) === v, `Ida y vuelta ${v} ${u}`);
  }

  console.log("\n── Caso 2: se guarda en gramos sea cual sea la unidad");
  // Dos productos con el MISMO peso real cargado en unidades distintas deben
  // quedar con el mismo peso_gramos: ese es el punto de guardar canónico.
  const enKg = await crearProducto(`${TAG}-KG`, aGramos(1.5, "kg"), "kg");
  const enG = await crearProducto(`${TAG}-G`, aGramos(1500, "g"), "g");
  const { rows: pesos } = await p.query<{ id: string; peso_gramos: string; peso_unidad: string }>(
    `SELECT id, peso_gramos, peso_unidad FROM ${SCHEMA}.productos WHERE id = ANY($1::uuid[])`,
    [[enKg, enG]]
  );
  const gKg = Number(pesos.find((r) => r.id === enKg)?.peso_gramos);
  const gG = Number(pesos.find((r) => r.id === enG)?.peso_gramos);
  check(gKg === 1500 && gG === 1500, "1,5 kg y 1500 g guardan el mismo valor", `${gKg} / ${gG}`);
  check(
    pesos.find((r) => r.id === enKg)?.peso_unidad === "kg" &&
    pesos.find((r) => r.id === enG)?.peso_unidad === "g",
    "Cada uno conserva su unidad de presentación"
  );

  console.log("\n── Caso 3: constraints");
  let rechazoNegativo = false;
  try { await crearProducto(`${TAG}-NEG`, -100); } catch { rechazoNegativo = true; }
  check(rechazoNegativo, "Rechaza peso negativo");

  let rechazoCero = false;
  try { await crearProducto(`${TAG}-CERO`, 0); } catch { rechazoCero = true; }
  check(rechazoCero, "Rechaza peso cero (para 'sin dato' está NULL)");

  let rechazoUnidad = false;
  try { await crearProducto(`${TAG}-LB`, 500, "lb"); } catch { rechazoUnidad = true; }
  check(rechazoUnidad, "Rechaza una unidad que no sea g o kg");

  const sinPeso = await crearProducto(`${TAG}-NULL`, null);
  check(Boolean(sinPeso), "Acepta producto SIN peso (es opcional)");

  console.log("\n── Caso 4: fórmula de flete");
  check(aKilos(1500) === 1.5, "1500 g = 1,5 kg");
  // 1,5 kg a USD 8/kg = 12
  check(fletePorProducto(1500, 8) === 12, "1,5 kg × 8/kg = 12", String(fletePorProducto(1500, 8)));
  check(fletePorProducto(1500, 8, 10) === 120, "×10 unidades = 120");
  check(fletePorProducto(null, 8) === null, "Sin peso devuelve null, no 0");
  check(fletePorProducto(0, 8) === null, "Peso 0 devuelve null");
  check(fletePorProducto(1500, 0) === 0, "Sin costo por kilo el flete es 0");
  check(formatPeso(1500) === "1,5 kg", "Formatea 1500 g como kg", formatPeso(1500));
  check(formatPeso(250) === "250 g", "Formatea 250 g como g", formatPeso(250));
  check(formatPeso(null) === "—", "Sin peso muestra guion");

  console.log("\n── Caso 5: la unidad comercial no cambia");
  const { rows: um } = await p.query<{ unidad_medida: string }>(
    `SELECT unidad_medida FROM ${SCHEMA}.productos WHERE id=$1::uuid`, [enKg]);
  check(um[0]?.unidad_medida === "UNIDAD", "unidad_medida sigue siendo UNIDAD", um[0]?.unidad_medida);

  // ── Documentación ────────────────────────────────────────────────────────
  console.log("\n── Caso 6: varios adjuntos por producto");
  const insertDoc = (prodId: string, n: number) =>
    p.query(
      `INSERT INTO ${SCHEMA}.producto_documentos
         (empresa_id, producto_id, nombre, archivo_path, archivo_nombre, mime_type, tamano_bytes)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'application/pdf', 12345)`,
      [EMPRESA, prodId, `${TAG} Ficha ${n}`, `${EMPRESA}/qa-${prodId}-${n}.pdf`, `ficha-${n}.pdf`]
    );
  await insertDoc(enKg, 1);
  await insertDoc(enKg, 2);
  await insertDoc(enKg, 3);
  const { rows: cnt } = await p.query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.producto_documentos WHERE producto_id=$1::uuid`, [enKg]);
  check(Number(cnt[0]?.n) === 3, "Acepta varios archivos en un producto", `${cnt[0]?.n}`);

  console.log("\n── Caso 7: no se registra dos veces el mismo archivo");
  let rechazoDuplicado = false;
  try { await insertDoc(enKg, 1); } catch { rechazoDuplicado = true; }
  check(rechazoDuplicado, "El índice único bloquea el doble registro");

  console.log("\n── Caso 8: borrar el producto se lleva sus adjuntos");
  await p.query(`DELETE FROM ${SCHEMA}.productos WHERE id=$1::uuid`, [enKg]);
  const { rows: huerfanos } = await p.query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.producto_documentos WHERE producto_id=$1::uuid`, [enKg]);
  check(Number(huerfanos[0]?.n) === 0, "CASCADE limpió los adjuntos", `${huerfanos[0]?.n}`);

  console.log("\n── Caso 9: aislamiento");
  const { rows: colEmp } = await p.query<{ n: string }>(
    `SELECT count(*) n FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='producto_documentos' AND column_name='empresa_id'`, [SCHEMA]);
  check(Number(colEmp[0]?.n) === 1, "producto_documentos tiene empresa_id");
  const { rows: rls } = await p.query<{ rls: boolean }>(
    `SELECT c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname='producto_documentos'`, [SCHEMA]);
  check(rls[0]?.rls === true, "producto_documentos tiene RLS activo");
  const { rows: ajenos } = await p.query<{ n: string }>(
    `SELECT count(*) n FROM ${SCHEMA}.producto_documentos WHERE empresa_id <> $1::uuid`, [EMPRESA]);
  check(Number(ajenos[0]?.n) === 0, "No hay adjuntos de otra empresa", `${ajenos[0]?.n}`);

  console.log("\n── Limpieza");
  await limpiar();
  console.log("  datos TEST eliminados");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTADO — OK: ${ok} · FALLOS: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("QA abortado:", e); process.exit(1); });
