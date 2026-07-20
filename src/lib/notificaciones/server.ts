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
/** Órdenes de compra con mercadería pendiente de recibir. */
export const TIPO_ORDEN_PARCIAL = "orden_recepcion_parcial";
export const TIPO_ORDEN_POR_LLEGAR = "orden_por_llegar";
export const TIPO_ORDEN_ATRASADA = "orden_atrasada";
/** Inventario: reposición. */
export const TIPO_STOCK_BAJO = "stock_bajo";
export const TIPO_SIN_STOCK = "sin_stock";

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
  numero_control: string | null;
  producto_id: string | null;
  url: string | null;
  leida: boolean;
  created_at: string;
}

const COLS = "id, tipo, titulo, mensaje, documento_id, numero_control, producto_id, url, leida, created_at";

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

// Throttle propio para el barrido de órdenes.
const ultimaEvalOrdenes = new Map<string, number>();

/**
 * Genera avisos de mercadería pendiente de recibir. Reutiliza la MISMA tabla y
 * la misma campanita que los documentos: no hay un segundo sistema.
 *
 * Tipos que emite:
 *   - `orden_recepcion_parcial`: quedó saldo tras una entrega parcial.
 *   - `orden_por_llegar`: la fecha estimada está dentro de los próximos 3 días.
 *   - `orden_atrasada`: la fecha estimada ya pasó y sigue pendiente.
 *
 * Deja de emitir solo cuando la orden queda `completa` o `cancelada`, porque la
 * consulta filtra por `estado_recepcion IN ('pendiente','parcial')`.
 *
 * Best-effort y throttled: se llama desde el GET de la campanita, igual que los
 * documentos, así no hace falta cron.
 */
export async function evaluarOrdenesPendientes(
  schemaRaw: string,
  empresaId: string
): Promise<number> {
  const now = Date.now();
  const last = ultimaEvalOrdenes.get(empresaId) ?? 0;
  if (now - last < EVAL_THROTTLE_MS) return 0;
  ultimaEvalOrdenes.set(empresaId, now);

  const schema = assertAllowedChatDataSchema(schemaRaw);
  const compras = quoteSchemaTable(schema, "compras");
  const notifs = quoteSchemaTable(schema, "notificaciones");
  const p = pool();
  const hoy = hoyAsuncionYmd();

  // Una fila por ORDEN (no por línea): se agrupa por numero_control.
  const { rows } = await p.query<{
    numero_control: string;
    proveedor_nombre: string;
    productos_pendientes: string;
    unidades_pendientes: string;
    fecha_estimada: string | null;
    dias_para_llegada: string | null;
  }>(
    `SELECT numero_control,
            MIN(proveedor_nombre) AS proveedor_nombre,
            COUNT(*) FILTER (WHERE cantidad - cantidad_recibida > 0) AS productos_pendientes,
            COALESCE(SUM(cantidad - cantidad_recibida), 0) AS unidades_pendientes,
            MIN(fecha_estimada_llegada)::text AS fecha_estimada,
            (MIN(fecha_estimada_llegada) - $2::date) AS dias_para_llegada
       FROM ${compras}
      WHERE empresa_id = $1::uuid
        AND estado_recepcion IN ('pendiente', 'parcial')
        AND anulada_at IS NULL
      GROUP BY numero_control
     HAVING COALESCE(SUM(cantidad - cantidad_recibida), 0) > 0`,
    [empresaId, hoy]
  );
  if (rows.length === 0) return 0;

  let creadas = 0;
  for (const o of rows) {
    const unidades = Number(o.unidades_pendientes) || 0;
    const productos = Number(o.productos_pendientes) || 0;
    const dias = o.dias_para_llegada == null ? null : Number(o.dias_para_llegada);

    let tipo: string | null = null;
    let titulo = "";
    let mensaje = "";

    const detalle = `faltan ${unidades} unidad${unidades === 1 ? "" : "es"} en ${productos} producto${productos === 1 ? "" : "s"}`;

    if (dias != null && dias < 0) {
      tipo = TIPO_ORDEN_ATRASADA;
      titulo = "Entrega atrasada";
      mensaje = `Orden ${o.numero_control} (${o.proveedor_nombre}): ${detalle}. Llegada estimada ${o.fecha_estimada}, atrasada ${Math.abs(dias)} día${Math.abs(dias) === 1 ? "" : "s"}.`;
    } else if (dias != null && dias <= 3) {
      tipo = TIPO_ORDEN_POR_LLEGAR;
      titulo = "Pedido por llegar";
      mensaje = `Orden ${o.numero_control} (${o.proveedor_nombre}): ${detalle}. Llegada estimada: ${o.fecha_estimada}.`;
    } else {
      tipo = TIPO_ORDEN_PARCIAL;
      titulo = "Mercadería pendiente";
      mensaje = o.fecha_estimada
        ? `Orden ${o.numero_control} (${o.proveedor_nombre}): ${detalle}. Llegada estimada: ${o.fecha_estimada}.`
        : `Orden ${o.numero_control} (${o.proveedor_nombre}): ${detalle}. Sin fecha estimada de llegada.`;
    }

    const r = await p.query(
      `INSERT INTO ${notifs} (empresa_id, tipo, titulo, mensaje, numero_control, url)
       VALUES ($1::uuid, $2, $3, $4, $5, $6)
       ON CONFLICT (empresa_id, numero_control, tipo)
         WHERE leida = false AND numero_control IS NOT NULL
       DO NOTHING`,
      [empresaId, tipo, titulo, mensaje, o.numero_control, `/compras?orden=${encodeURIComponent(o.numero_control)}`]
    );
    creadas += r.rowCount ?? 0;
  }
  return creadas;
}

// Throttle propio para el barrido de stock.
const ultimaEvalStock = new Map<string, number>();

/**
 * Genera avisos de reposición de inventario. Misma tabla y misma campanita que
 * documentos y órdenes: un solo sistema de notificaciones.
 *
 * Tipos que emite:
 *   - `sin_stock`:   el producto quedó en 0 (o negativo).
 *   - `stock_bajo`:  stock por debajo o igual al mínimo configurado.
 *
 * Solo mira productos activos que controlan stock y tienen un mínimo definido
 * (`stock_minimo > 0`): sin un mínimo cargado no hay umbral contra el cual
 * avisar, y avisaríamos de todo el catálogo. Los productos recién cargados con
 * mínimo 0 no generan ruido.
 *
 * Best-effort y throttled, igual que el resto: se dispara desde el GET de la
 * campanita, sin cron.
 */
export async function evaluarStockBajo(
  schemaRaw: string,
  empresaId: string
): Promise<number> {
  const now = Date.now();
  const last = ultimaEvalStock.get(empresaId) ?? 0;
  if (now - last < EVAL_THROTTLE_MS) return 0;
  ultimaEvalStock.set(empresaId, now);

  const schema = assertAllowedChatDataSchema(schemaRaw);
  const productos = quoteSchemaTable(schema, "productos");
  const notifs = quoteSchemaTable(schema, "notificaciones");
  const p = pool();

  const { rows } = await p.query<{
    id: string;
    nombre: string;
    sku: string;
    stock_actual: string;
    stock_minimo: string;
    unidad_medida: string | null;
  }>(
    `SELECT id, nombre, sku, stock_actual, stock_minimo, unidad_medida
       FROM ${productos}
      WHERE empresa_id = $1::uuid
        AND activo = true
        AND controla_stock = true
        AND stock_minimo > 0
        AND stock_actual <= stock_minimo
      ORDER BY stock_actual ASC
      LIMIT 50`,
    [empresaId]
  );
  if (rows.length === 0) return 0;

  let creadas = 0;
  for (const prod of rows) {
    const stock = Number(prod.stock_actual) || 0;
    const minimo = Number(prod.stock_minimo) || 0;
    const unidad = (prod.unidad_medida ?? "").trim();
    const agotado = stock <= 0;

    const tipo = agotado ? TIPO_SIN_STOCK : TIPO_STOCK_BAJO;
    const titulo = agotado ? "Producto sin stock" : "Stock bajo";
    const mensaje = agotado
      ? `${prod.nombre} (${prod.sku}) se quedó sin stock. Mínimo: ${minimo}${unidad ? ` ${unidad}` : ""}.`
      : `${prod.nombre} (${prod.sku}): quedan ${stock}${unidad ? ` ${unidad}` : ""}, por debajo del mínimo de ${minimo}. Conviene reponer.`;

    const r = await p.query(
      `INSERT INTO ${notifs} (empresa_id, tipo, titulo, mensaje, producto_id, url)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6)
       ON CONFLICT (empresa_id, producto_id, tipo)
         WHERE leida = false AND producto_id IS NOT NULL
       DO NOTHING`,
      [empresaId, tipo, titulo, mensaje, prod.id, `/inventario/${prod.id}/editar`]
    );
    creadas += r.rowCount ?? 0;
  }
  return creadas;
}
