/**
 * Notificaciones (campanita). PG directo sobre el schema de la empresa.
 *
 * Origen actual: vencimiento de documentos. La evaluación se dispara desde el
 * GET de la campanita (throttled en memoria), así que no hace falta cron: si
 * alguien tiene el ERP abierto, los avisos se generan solos.
 *
 * Dedupe: índice único parcial (empresa, documento, tipo) WHERE leida = false,
 * más INSERT ... ON CONFLICT DO NOTHING. Si el usuario marca la notificación
 * como leída y el documento sigue por vencer, una próxima evaluación puede
 * volver a generarla (criterio seguro: mejor recordar de más que de menos).
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import { hoyAsuncionYmd } from "@/lib/fecha/asuncion";

export const TIPO_DOC_POR_VENCER = "documento_por_vencer";
export const TIPO_DOC_VENCIDO = "documento_vencido";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

export interface NotificacionRow {
  id: string;
  tipo: string;
  titulo: string;
  mensaje: string;
  documento_id: string | null;
  url: string | null;
  leida: boolean;
  created_at: string;
}

const COLS = "id, tipo, titulo, mensaje, documento_id, url, leida, created_at";

export async function listNotificaciones(
  schemaRaw: string,
  empresaId: string,
  limit = 30
): Promise<{ notificaciones: NotificacionRow[]; no_leidas: number }> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "notificaciones");
  const p = pool();
  const listQ = p.query<NotificacionRow>(
    `SELECT ${COLS} FROM ${t} WHERE empresa_id = $1::uuid ORDER BY leida ASC, created_at DESC LIMIT $2`,
    [empresaId, limit]
  );
  const cntQ = p.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${t} WHERE empresa_id = $1::uuid AND leida = false`,
    [empresaId]
  );
  const [list, cnt] = await Promise.all([listQ, cntQ]);
  return { notificaciones: list.rows, no_leidas: Number(cnt.rows[0]?.n ?? 0) };
}

export async function marcarLeida(schemaRaw: string, empresaId: string, id: string): Promise<void> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "notificaciones");
  await pool().query(
    `UPDATE ${t} SET leida = true, updated_at = now() WHERE empresa_id = $1::uuid AND id = $2::uuid`,
    [empresaId, id]
  );
}

export async function marcarTodasLeidas(schemaRaw: string, empresaId: string): Promise<void> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "notificaciones");
  await pool().query(
    `UPDATE ${t} SET leida = true, updated_at = now() WHERE empresa_id = $1::uuid AND leida = false`,
    [empresaId]
  );
}

// Throttle en memoria del proceso: evita rebarrer los documentos en cada poll.
const ultimaEval = new Map<string, number>();
const EVAL_THROTTLE_MS = 60_000;

interface DocVencimientoRow {
  id: string;
  nombre: string;
  fecha_vencimiento: string;
  dias_restantes: number;
}

/**
 * Genera notificaciones para documentos vencidos o por vencer.
 *
 * - `documento_vencido`: la fecha de vencimiento ya pasó.
 * - `documento_por_vencer`: faltan <= `dias_aviso_previo` días (el valor que el
 *   usuario configuró por documento).
 *
 * Best-effort y throttled: pensada para llamarse desde el GET de la campanita.
 * Devuelve cuántas notificaciones nuevas creó.
 */
export async function evaluarDocumentosPorVencer(
  schemaRaw: string,
  empresaId: string
): Promise<number> {
  const now = Date.now();
  const last = ultimaEval.get(empresaId) ?? 0;
  if (now - last < EVAL_THROTTLE_MS) return 0;
  ultimaEval.set(empresaId, now);

  const schema = assertAllowedChatDataSchema(schemaRaw);
  const docs = quoteSchemaTable(schema, "documentos");
  const notifs = quoteSchemaTable(schema, "notificaciones");
  const p = pool();

  // `hoy` se calcula en zona Asunción (no UTC): un documento que vence hoy no
  // debe aparecer como vencido por el corrimiento horario del servidor.
  const hoy = hoyAsuncionYmd();

  const { rows } = await p.query<DocVencimientoRow>(
    `SELECT id, nombre, fecha_vencimiento::text AS fecha_vencimiento,
            (fecha_vencimiento - $2::date) AS dias_restantes
       FROM ${docs}
      WHERE empresa_id = $1::uuid
        AND archivado = false
        AND fecha_vencimiento IS NOT NULL
        AND (fecha_vencimiento - $2::date) <= dias_aviso_previo`,
    [empresaId, hoy]
  );
  if (rows.length === 0) return 0;

  let creadas = 0;
  for (const d of rows) {
    const dias = Number(d.dias_restantes);
    const vencido = dias < 0;
    const tipo = vencido ? TIPO_DOC_VENCIDO : TIPO_DOC_POR_VENCER;

    const titulo = vencido ? "Documento vencido" : "Documento por vencer";
    const mensaje = vencido
      ? `${d.nombre}: venció el ${d.fecha_vencimiento} (hace ${Math.abs(dias)} día${Math.abs(dias) === 1 ? "" : "s"}).`
      : dias === 0
        ? `${d.nombre}: vence hoy (${d.fecha_vencimiento}).`
        : `${d.nombre}: vence el ${d.fecha_vencimiento}, en ${dias} día${dias === 1 ? "" : "s"}.`;

    const r = await p.query(
      `INSERT INTO ${notifs} (empresa_id, tipo, titulo, mensaje, documento_id, url)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6)
       ON CONFLICT (empresa_id, documento_id, tipo)
         WHERE leida = false AND documento_id IS NOT NULL
       DO NOTHING`,
      [empresaId, tipo, titulo, mensaje, d.id, "/documentos"]
    );
    creadas += r.rowCount ?? 0;
  }
  return creadas;
}
