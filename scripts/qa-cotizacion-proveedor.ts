/**
 * Verifica la cotización automática contra el proveedor REAL configurado.
 *
 * A diferencia de qa-crm-y-monedas (que prueba el modelo y el fallback sin
 * salir a internet), este script pega de verdad al proveedor. Sirve para
 * confirmar que `COTIZACION_API_URL` + `COTIZACION_JSON_PATH` estan bien
 * configurados y que el numero que llega es razonable.
 *
 * Ejecutar: npx tsx scripts/qa-cotizacion-proveedor.ts
 */
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), ".env.local") });

import { getCotizacionVigente } from "@/lib/cotizaciones/server/cotizaciones-pg";

const SCHEMA = "seguridadalimentariaerp";
const EMPRESA = "17908c42-c297-4506-bcb7-547ccecfe53a";

/**
 * Banda de sanidad para el guaraní. No valida el mercado: valida que no se
 * haya leído la clave equivocada del JSON. Un `compra` en vez de un `venta`
 * pasaría igual, pero leer un id, un porcentaje o una fecha no.
 */
const MIN = 4000;
const MAX = 12000;

let ok = 0, fail = 0;
function check(cond: boolean, titulo: string, detalle = "") {
  if (cond) { ok++; console.log(`  OK   ${titulo}${detalle ? ` — ${detalle}` : ""}`); }
  else { fail++; console.log(`  FAIL ${titulo}${detalle ? ` — ${detalle}` : ""}`); }
}

async function main() {
  console.log("QA — Cotización contra el proveedor real\n");
  console.log(`  proveedor: ${process.env.COTIZACION_API_URL || "(sin configurar)"}`);
  console.log(`  ruta JSON: ${process.env.COTIZACION_JSON_PATH || "(default)"}\n`);

  check(Boolean(process.env.COTIZACION_API_URL), "COTIZACION_API_URL está configurada");

  const t0 = Date.now();
  const cot = await getCotizacionVigente(SCHEMA, EMPRESA, "USD", "PYG");
  const ms = Date.now() - t0;

  check(cot != null, "Devuelve una cotización");
  if (!cot) {
    console.log(`\nRESULTADO — OK: ${ok} · FALLOS: ${fail + 1}`);
    process.exit(1);
  }

  console.log(`\n  → ${cot.cotizacion} PYG por USD`);
  console.log(`     fuente: ${cot.fuente} · fecha: ${cot.fecha_cotizacion}`);
  console.log(`     manual: ${cot.es_manual} · fallback: ${cot.es_fallback ?? false} · ${ms} ms\n`);

  check(cot.cotizacion > 1, "NO devuelve 1 (el error que envenena los costos)", String(cot.cotizacion));
  check(cot.cotizacion >= MIN && cot.cotizacion <= MAX,
    `Valor dentro de la banda de sanidad (${MIN}–${MAX})`, String(cot.cotizacion));
  check(cot.es_manual === false, "Viene marcada como automática");
  check(cot.es_fallback !== true, "Vino del proveedor, no del fallback");
  check(ms < 8000, "Responde en tiempo razonable", `${ms} ms`);

  // Segunda llamada: debe salir del cache, sin volver a pegarle al proveedor.
  const t1 = Date.now();
  const cot2 = await getCotizacionVigente(SCHEMA, EMPRESA, "USD", "PYG");
  const ms2 = Date.now() - t1;
  check(cot2?.cotizacion === cot.cotizacion, "La segunda llamada da el mismo valor");
  check(ms2 < 50, "La segunda llamada sale del cache", `${ms2} ms`);

  // Par idéntico: 1 es correcto acá y solo acá.
  const mismo = await getCotizacionVigente(SCHEMA, EMPRESA, "PYG", "PYG");
  check(mismo?.cotizacion === 1, "PYG→PYG devuelve 1 (identidad)");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTADO — OK: ${ok} · FALLOS: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("QA abortado:", e); process.exit(1); });
