/**
 * QA REAL de las notificaciones del módulo Documentos.
 *
 * No mira el código: crea documentos de prueba con distintos vencimientos,
 * ejecuta el evaluador contra la base y verifica qué notificaciones nacieron.
 *
 * Casos:
 *   1. Documento vencido → aviso "documento_vencido"
 *   2. Documento que vence hoy → aviso "por vencer"
 *   3. Documento dentro de su ventana de aviso → aviso
 *   4. Documento LEJOS de vencer → NO debe avisar
 *   5. Documento SIN vencimiento → NO debe avisar
 *   6. Documento archivado → NO debe avisar
 *   7. Sin duplicados: correr dos veces no crea la notificación dos veces
 *   8. Respeta `dias_aviso_previo` por documento
 *
 * Ejecutar: npx tsx scripts/qa-notificaciones-documentos.ts
 */
import { config } from "dotenv";
import path from "node:path";
config({ path: path.resolve(process.cwd(), ".env.local") });

import { getChatPostgresPool } from "@/lib/supabase/chat-pg-pool";
import { evaluarDocumentosPorVencer } from "@/lib/notificaciones/server";

const SCHEMA = "seguridadalimentariaerp";
const EMPRESA = "17908c42-c297-4506-bcb7-547ccecfe53a";
const TAG = "TEST-QA-NOTIF";

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
  await del(`DELETE FROM ${SCHEMA}.notificaciones WHERE empresa_id=$1::uuid AND documento_id IN (SELECT id FROM ${SCHEMA}.documentos WHERE nombre LIKE $2)`, [EMPRESA, `${TAG}%`]);
  await del(`DELETE FROM ${SCHEMA}.documentos WHERE empresa_id=$1::uuid AND nombre LIKE $2`, [EMPRESA, `${TAG}%`]);
}

/** Crea un documento con vencimiento relativo a hoy (en días). */
async function crearDoc(
  sufijo: string,
  diasHastaVencer: number | null,
  diasAviso = 30,
  archivado = false
) {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.documentos
       (empresa_id, nombre, archivo_path, archivo_nombre, mime_type, tamano_bytes,
        fecha_vencimiento, dias_aviso_previo, archivado)
     VALUES ($1::uuid, $2, $3, $4, 'application/pdf', 1000,
             CASE WHEN $5::int IS NULL THEN NULL
                  ELSE ((now() AT TIME ZONE 'America/Asuncion')::date + $5::int) END,
             $6::int, $7::boolean)
     RETURNING id`,
    [EMPRESA, `${TAG} ${sufijo}`, `${EMPRESA}/qa-${sufijo}.pdf`, `${sufijo}.pdf`, diasHastaVencer, diasAviso, archivado]
  );
  return rows[0].id;
}

async function notifsDe(docId: string) {
  const { rows } = await pool().query<{ tipo: string; mensaje: string }>(
    `SELECT tipo, mensaje FROM ${SCHEMA}.notificaciones
      WHERE empresa_id=$1::uuid AND documento_id=$2::uuid`,
    [EMPRESA, docId]
  );
  return rows;
}

/**
 * El evaluador tiene un throttle de 60s por empresa (para no barrer en cada
 * request de la campanita). En el QA hay que saltearlo, si no la segunda
 * corrida no haría nada y el resultado seria un falso negativo.
 */
async function evaluarSinThrottle() {
  // El throttle vive en un Map en memoria del módulo; se sortea esperando o
  // reimportando. Acá se fuerza con un import fresco por corrida.
  const mod = await import(`@/lib/notificaciones/server?t=${Date.now()}`);
  return (mod.evaluarDocumentosPorVencer as typeof evaluarDocumentosPorVencer)(SCHEMA, EMPRESA);
}

async function main() {
  console.log("QA — Notificaciones del módulo Documentos (contra la base real)\n");
  await limpiar();

  console.log("── Preparando documentos de prueba");
  const vencido = await crearDoc("Vencido", -5);            // venció hace 5 días
  const venceHoy = await crearDoc("Vence-hoy", 0);          // vence hoy
  const enVentana = await crearDoc("En-ventana", 10, 30);   // vence en 10, avisa con 30
  const lejos = await crearDoc("Lejos", 200, 30);           // vence en 200, avisa con 30
  const sinVenc = await crearDoc("Sin-vencimiento", null);  // sin fecha
  const archivado = await crearDoc("Archivado", 3, 30, true);
  const avisoCorto = await crearDoc("Aviso-corto", 10, 2);  // vence en 10, avisa con 2
  console.log("  7 documentos creados");

  console.log("\n── Ejecutando el evaluador");
  const creadas = await evaluarDocumentosPorVencer(SCHEMA, EMPRESA);
  console.log(`  notificaciones creadas: ${creadas}`);

  console.log("\n── Caso 1: documento vencido");
  const n1 = await notifsDe(vencido);
  check(n1.some((n) => n.tipo === "documento_vencido"), "Avisa que venció", n1[0]?.mensaje?.slice(0, 60));

  console.log("\n── Caso 2: vence hoy");
  const n2 = await notifsDe(venceHoy);
  check(n2.length > 0, "Avisa el día del vencimiento", n2[0]?.mensaje?.slice(0, 60));
  check(
    n2.some((n) => n.tipo === "documento_por_vencer"),
    "Lo trata como 'por vencer', no como vencido (zona Asunción)"
  );

  console.log("\n── Caso 3: dentro de la ventana de aviso");
  const n3 = await notifsDe(enVentana);
  check(n3.length > 0, "Avisa con la anticipación configurada", n3[0]?.mensaje?.slice(0, 60));

  console.log("\n── Caso 4: lejos de vencer");
  check((await notifsDe(lejos)).length === 0, "NO avisa todavía (faltan 200 días)");

  console.log("\n── Caso 5: sin fecha de vencimiento");
  check((await notifsDe(sinVenc)).length === 0, "NO avisa (no vence nunca)");

  console.log("\n── Caso 6: archivado");
  check((await notifsDe(archivado)).length === 0, "NO avisa (está archivado)");

  console.log("\n── Caso 7: respeta los días de aviso de CADA documento");
  check(
    (await notifsDe(avisoCorto)).length === 0,
    "Vence en 10 días pero avisa con 2: todavía no notifica"
  );

  console.log("\n── Caso 8: sin duplicados al re-evaluar");
  const antes = (await notifsDe(vencido)).length;
  const creadas2 = await evaluarSinThrottle();
  const despues = (await notifsDe(vencido)).length;
  check(despues === antes, "Re-evaluar no duplica la notificación", `${antes} → ${despues}`);
  console.log(`     (segunda corrida creó ${creadas2})`);

  console.log("\n── Limpieza");
  await limpiar();
  console.log("  datos TEST eliminados");

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTADO — OK: ${ok} · FALLOS: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("QA abortado:", e); process.exit(1); });
