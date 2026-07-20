/**
 * PG directo para Compras. Mismo patron que productos-pg / proveedores-pg:
 * pool singleton + queries parametrizadas + identifier escape.
 *
 * insertCompra realiza la operacion en transaccion:
 *   1) inserta compra con numero_control generado por secuencia local
 *   2) inserta movimiento ENTRADA (origen=compra) con audit
 *   3) actualiza producto.precio_venta + costo_promedio + stock_actual
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

/**
 * Upsert best-effort de la relación producto↔proveedor en `proveedor_productos`.
 * - Actualiza `costo_habitual` con el último costo_unitario de la compra.
 * - Marca `es_principal=true` SOLO si el producto aún no tiene un proveedor
 *   principal (respeta el índice parcial único un_principal).
 * - NUNCA toca `marca` (se preserva el valor existente; null si es nueva fila).
 * Se ejecuta dentro de un SAVEPOINT: si falla, no aborta la compra.
 */
async function upsertProveedorProducto(
  client: import("pg").PoolClient,
  tPP: string,
  empresaId: string,
  productoId: string,
  proveedorId: string,
  costoHabitual: number
): Promise<void> {
  if (!proveedorId) return; // sin proveedor no hay relación que mantener
  try {
    await client.query("SAVEPOINT sp_pp");
    await client.query(
      `INSERT INTO ${tPP} (empresa_id, producto_id, proveedor_id, costo_habitual, es_principal, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric,
               NOT EXISTS (SELECT 1 FROM ${tPP} pp
                            WHERE pp.empresa_id = $1::uuid AND pp.producto_id = $2::uuid AND pp.es_principal),
               now())
       ON CONFLICT (empresa_id, producto_id, proveedor_id)
       DO UPDATE SET costo_habitual = EXCLUDED.costo_habitual, updated_at = now()`,
      [empresaId, productoId, proveedorId, costoHabitual]
    );
    await client.query("RELEASE SAVEPOINT sp_pp");
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT sp_pp").catch(() => null);
    console.error("[compras-pg] upsert proveedor_productos fallo (best-effort)", {
      empresaId, productoId, proveedorId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

export interface CompraRow {
  id: string;
  empresa_id: string;
  proveedor_id: string;
  proveedor_nombre: string;
  producto_id: string;
  producto_nombre: string;
  cantidad: string | number;
  moneda: string;
  tipo_cambio: string | number;
  costo_unitario_original: string | number;
  costo_unitario: string | number;
  iva_tipo: string;
  subtotal: string | number;
  monto_iva: string | number;
  total: string | number;
  precio_venta: string | number;
  margen_venta: string | number | null;
  tipo_pago: string;
  plazo_dias: number | null;
  nro_timbrado: string;
  numero_control: string;
  estado: string;
  fecha: string;
  fecha_factura: string | null;
  metodo_pago: string | null;
  comprobante_url: string | null;
  comprobante_storage_path: string | null;
  comprobante_nombre: string | null;
  comprobante_mime_type: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  usuario_nombre: string | null;
  anulada_at?: string | null;
  anulacion_motivo?: string | null;
}

const COLS = `
  id, empresa_id, proveedor_id, proveedor_nombre, producto_id, producto_nombre,
  cantidad, moneda, tipo_cambio, costo_unitario_original, costo_unitario,
  iva_tipo, subtotal, monto_iva, total, precio_venta, margen_venta,
  tipo_pago, plazo_dias, nro_timbrado, numero_control, estado, fecha,
  fecha_factura, metodo_pago,
  comprobante_url, comprobante_storage_path, comprobante_nombre, comprobante_mime_type,
  created_at, updated_at, created_by, usuario_nombre,
  cantidad_recibida, estado_recepcion, fecha_estimada_llegada,
  fecha_ultima_recepcion, recepcion_completada_at,
  cotizacion_fuente, cotizacion_fecha, cotizacion_es_manual,
  numero_factura, orden_compra_numero, orden_compra_item_id, observacion
`;

export interface InsertCompraInput {
  proveedor_id: string;
  proveedor_nombre: string;
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  moneda: string;
  tipo_cambio: number;
  costo_unitario_original: number;
  costo_unitario: number;
  iva_tipo: string;
  subtotal: number;
  monto_iva: number;
  total: number;
  precio_venta: number;
  margen_venta: number | null;
  tipo_pago: string;
  plazo_dias: number | null;
  nro_timbrado: string;
  fecha_factura?: string | null;
  metodo_pago?: string | null;
  created_by: string | null;
  usuario_nombre: string | null;
}

export async function listCompras(
  schemaRaw: string,
  empresaId: string
): Promise<CompraRow[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const t = quoteSchemaTable(schema, "compras");
  const { rows } = await pool().query<CompraRow>(
    `SELECT ${COLS} FROM ${t} WHERE empresa_id = $1::uuid ORDER BY fecha DESC LIMIT 500`,
    [empresaId]
  );
  return rows;
}

/** Genera proximo COMP-XXXXXX leyendo el maximo existente. */
async function nextNumeroControl(
  client: import("pg").PoolClient,
  schema: string,
  empresaId: string
): Promise<string> {
  const t = quoteSchemaTable(schema, "compras");
  const { rows } = await client.query<{ maxn: number | null }>(
    `SELECT COALESCE(MAX(
       CASE WHEN numero_control ~ '^COMP-[0-9]+$'
            THEN (substring(numero_control from 6))::int
            ELSE 0 END
     ), 0) AS maxn
     FROM ${t} WHERE empresa_id = $1::uuid`,
    [empresaId]
  );
  const next = Number(rows[0]?.maxn ?? 0) + 1;
  return `COMP-${String(next).padStart(6, "0")}`;
}

export interface CompraResult {
  compra: CompraRow;
  movimiento_id: string | null;
  movimiento_warning: string | null;
}

/** Cabecera compartida por todas las líneas de una compra multiproducto. */
export interface CompraHeaderInput {
  proveedor_id: string;
  proveedor_nombre: string;
  moneda: string;
  tipo_cambio: number;
  tipo_pago: string;
  plazo_dias: number | null;
  /**
   * Timbrado del proveedor. Puede venir vacío: una ORDEN se crea antes de tener
   * la factura. Se completa después (la columna pasó a NULLABLE en la migración
   * 2026-07-16).
   */
  nro_timbrado: string | null;
  /** Fecha estimada de llegada general de la orden (YYYY-MM-DD). */
  fecha_estimada_llegada?: string | null;
  /** Snapshot de la cotización aplicada (solo para moneda extranjera). */
  cotizacion_fuente?: string | null;
  cotizacion_fecha?: string | null;
  cotizacion_es_manual?: boolean;
  /** Fecha del comprobante fiscal del proveedor (YYYY-MM-DD). null si no se cargó. */
  fecha_factura: string | null;
  /** Método: 'efectivo' | 'transferencia' | 'tarjeta'. null si no se especificó. */
  metodo_pago: string | null;
  comprobante_url: string | null;
  comprobante_storage_path: string | null;
  comprobante_nombre: string | null;
  comprobante_mime_type: string | null;
  created_by: string | null;
  usuario_nombre: string | null;
  /** N° de factura del proveedor. Se captura al recibir la mercadería. */
  numero_factura?: string | null;
  /** OC de origen (OC-XXXXXX) cuando la compra nace de una orden. */
  orden_compra_numero?: string | null;
  observacion?: string | null;
}

/** Una línea (producto) de la compra. */
export interface CompraItemInput {
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  costo_unitario_original: number;
  costo_unitario: number;
  iva_tipo: string;
  subtotal: number;
  monto_iva: number;
  total: number;
  precio_venta: number;
  margen_venta: number | null;
  /** Fecha estimada propia de este producto; pisa la general de la cabecera. */
  fecha_estimada_llegada?: string | null;
  /** Línea de `ordenes_compra` que origina esta compra (trazabilidad 1:1). */
  orden_compra_item_id?: string | null;
}

export interface ComprasMultiResult {
  numero_control: string;
  compras: CompraRow[];
  movimiento_warning: string | null;
}

/**
 * Compra MULTIPRODUCTO (modelo plano): N filas en `compras` que comparten un
 * único `numero_control`. Una sola transacción; por cada ítem inserta la fila,
 * el movimiento ENTRADA y actualiza stock + costo_promedio + precio_venta del
 * producto. Requiere que `numero_control` NO sea único (índice no-único).
 *
 * La compra simple es el caso N=1; el endpoint envuelve el body viejo en items=[…].
 */
/**
 * Compra MULTIPRODUCTO — variante transaccional: recibe un `client` en vez de
 * abrir su propia transacción, para que la recepción de una orden de compra
 * pueda meter la compra, el stock y el avance de la OC en un mismo BEGIN/COMMIT.
 *
 * Una COMPRA representa mercadería que YA ingresó: por eso acá sí se genera el
 * movimiento ENTRADA y se suma stock. Lo previo (el pedido al proveedor) vive
 * en `ordenes_compra`, que no toca inventario.
 */
export async function insertComprasConImpactoTx(
  client: import("pg").PoolClient,
  schema: string,
  empresaId: string,
  header: CompraHeaderInput,
  items: CompraItemInput[]
): Promise<ComprasMultiResult> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("La compra no tiene productos.");
  }
  const tC = quoteSchemaTable(schema, "compras");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tP = quoteSchemaTable(schema, "productos");
  const tPP = quoteSchemaTable(schema, "proveedor_productos");

  const insertedRows: CompraRow[] = [];
  const warnings: string[] = [];
  const numero = await nextNumeroControl(client, schema, empresaId);

  for (const it of items) {
    const { rows: compraRows } = await client.query<CompraRow>(
      `INSERT INTO ${tC} (
         empresa_id, proveedor_id, proveedor_nombre, producto_id, producto_nombre,
         cantidad, moneda, tipo_cambio, costo_unitario_original, costo_unitario,
         iva_tipo, subtotal, monto_iva, total, precio_venta, margen_venta,
         tipo_pago, plazo_dias, nro_timbrado, numero_control, estado, fecha,
         fecha_factura, metodo_pago,
         comprobante_url, comprobante_storage_path, comprobante_nombre, comprobante_mime_type,
         created_by, usuario_nombre,
         cantidad_recibida, estado_recepcion,
         cotizacion_fuente, cotizacion_fecha, cotizacion_es_manual,
         numero_factura, orden_compra_numero, orden_compra_item_id, observacion
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5,
         $6::numeric, $7, $8::numeric, $9::numeric, $10::numeric,
         $11, $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16::numeric,
         $17, $18::integer, $19, $20, 'registrada', now(),
         $21::date, $22,
         $23, $24, $25, $26,
         $27::uuid, $28,
         $6::numeric, 'completa',
         $29, $30::timestamptz, $31::boolean,
         $32, $33, $34::uuid, $35
       )
       RETURNING ${COLS}`,
      [
        empresaId, header.proveedor_id, header.proveedor_nombre,
        it.producto_id, it.producto_nombre,
        it.cantidad, header.moneda, header.tipo_cambio,
        it.costo_unitario_original, it.costo_unitario,
        it.iva_tipo, it.subtotal, it.monto_iva, it.total, it.precio_venta, it.margen_venta,
        header.tipo_pago, header.plazo_dias, header.nro_timbrado, numero,
        header.fecha_factura, header.metodo_pago,
        header.comprobante_url, header.comprobante_storage_path,
        header.comprobante_nombre, header.comprobante_mime_type,
        header.created_by, header.usuario_nombre,
        header.cotizacion_fuente ?? null,
        header.cotizacion_fecha ?? null,
        header.cotizacion_es_manual ?? false,
        header.numero_factura ?? null,
        header.orden_compra_numero ?? null,
        it.orden_compra_item_id ?? null,
        header.observacion ?? null,
      ]
    );
    insertedRows.push(compraRows[0]);

    // Movimiento ENTRADA por línea.
    try {
      await client.query(
        `INSERT INTO ${tM} (
           empresa_id, producto_id, producto_nombre, producto_sku,
           tipo, cantidad, costo_unitario, origen, referencia, fecha,
           created_by, usuario_nombre, compra_id
         )
         SELECT $1::uuid, $2::uuid, $3, COALESCE(p.sku, ''),
                'ENTRADA', $4::numeric, $5::numeric, 'compra', $6, now(),
                $7::uuid, $8, $9::uuid
         FROM ${tP} p WHERE p.id = $2::uuid`,
        [empresaId, it.producto_id, it.producto_nombre, it.cantidad,
         it.costo_unitario, numero, header.created_by, header.usuario_nombre,
         compraRows[0].id]
      );
    } catch (movErr) {
      const msg = movErr instanceof Error ? movErr.message : String(movErr);
      console.error("[compras-pg] movimiento ENTRADA fallo", {
        schema, empresaId, numero, producto: it.producto_id, message: msg,
      });
      warnings.push(it.producto_nombre);
    }

    // Stock + costo promedio PONDERADO.
    //
    // El original de FR pisaba `costo_promedio` con el último costo. Con
    // entregas parciales a distinto precio eso da un costo incorrecto, así que
    // acá se pondera contra el stock previo:
    //   nuevo = (stock * costo_actual + recibido * costo_compra) / (stock + recibido)
    // Si el stock previo es <= 0, el costo pasa a ser el de esta entrada.
    //
    // `precio_venta` solo se pisa si la compra trae un precio > 0: para materia
    // prima / insumos sin precio se conserva el actual.
    await client.query(
      `UPDATE ${tP}
          SET costo_promedio = CASE
                WHEN COALESCE(stock_actual, 0) <= 0 THEN $2::numeric
                WHEN COALESCE(stock_actual, 0) + $1::numeric <= 0 THEN $2::numeric
                ELSE ROUND(
                  ((COALESCE(stock_actual,0) * COALESCE(costo_promedio,0)) + ($1::numeric * $2::numeric))
                  / (COALESCE(stock_actual,0) + $1::numeric)
                , 4)
              END,
              stock_actual = COALESCE(stock_actual, 0) + $1::numeric,
              precio_venta = CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE precio_venta END,
              updated_at = now()
        WHERE id = $4::uuid AND empresa_id = $5::uuid`,
      [it.cantidad, it.costo_unitario, it.precio_venta, it.producto_id, empresaId]
    );

    // Relación producto↔proveedor (costo_habitual). No pisa marca.
    await upsertProveedorProducto(
      client, tPP, empresaId, it.producto_id, header.proveedor_id, it.costo_unitario
    );
  }

  return {
    numero_control: numero,
    compras: insertedRows,
    movimiento_warning: warnings.length
      ? `La compra se guardó pero no se registró el movimiento de entrada para: ${warnings.join(", ")}.`
      : null,
  };
}

/** Compra MULTIPRODUCTO con transacción propia. Envuelve a la variante `Tx`. */
export async function insertComprasConImpacto(
  schemaRaw: string,
  empresaId: string,
  header: CompraHeaderInput,
  items: CompraItemInput[]
): Promise<ComprasMultiResult> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const out = await insertComprasConImpactoTx(client, schema, empresaId, header, items);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

export async function insertCompraConImpacto(
  schemaRaw: string,
  empresaId: string,
  d: InsertCompraInput
): Promise<CompraResult> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "compras");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tP = quoteSchemaTable(schema, "productos");
  const tPP = quoteSchemaTable(schema, "proveedor_productos");

  const client = await pool().connect();
  let movimientoId: string | null = null;
  let movimientoWarning: string | null = null;
  try {
    await client.query("BEGIN");

    const numero = await nextNumeroControl(client, schema, empresaId);

    const { rows: compraRows } = await client.query<CompraRow>(
      `INSERT INTO ${tC} (
         empresa_id, proveedor_id, proveedor_nombre, producto_id, producto_nombre,
         cantidad, moneda, tipo_cambio, costo_unitario_original, costo_unitario,
         iva_tipo, subtotal, monto_iva, total, precio_venta, margen_venta,
         tipo_pago, plazo_dias, nro_timbrado, numero_control, estado, fecha,
         fecha_factura, metodo_pago,
         created_by, usuario_nombre
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5,
         $6::numeric, $7, $8::numeric, $9::numeric, $10::numeric,
         $11, $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16::numeric,
         $17, $18::integer, $19, $20, 'registrada', now(),
         $21::date, $22,
         $23::uuid, $24
       )
       RETURNING ${COLS}`,
      [
        empresaId,
        d.proveedor_id,
        d.proveedor_nombre,
        d.producto_id,
        d.producto_nombre,
        d.cantidad,
        d.moneda,
        d.tipo_cambio,
        d.costo_unitario_original,
        d.costo_unitario,
        d.iva_tipo,
        d.subtotal,
        d.monto_iva,
        d.total,
        d.precio_venta,
        d.margen_venta,
        d.tipo_pago,
        d.plazo_dias,
        d.nro_timbrado,
        numero,
        d.fecha_factura ?? null,
        d.metodo_pago ?? null,
        d.created_by,
        d.usuario_nombre,
      ]
    );
    const compra = compraRows[0];

    // Movimiento ENTRADA (origen=compra). Best-effort: si falla, la compra
    // queda registrada pero anunciamos warning.
    try {
      const { rows: movRows } = await client.query<{ id: string }>(
        `INSERT INTO ${tM} (
           empresa_id, producto_id, producto_nombre, producto_sku,
           tipo, cantidad, costo_unitario, origen, referencia, fecha,
           created_by, usuario_nombre
         )
         SELECT $1::uuid, $2::uuid, $3, COALESCE(p.sku, ''),
                'ENTRADA', $4::numeric, $5::numeric, 'compra', $6, now(),
                $7::uuid, $8
         FROM ${tP} p WHERE p.id = $2::uuid
         RETURNING id`,
        [
          empresaId,
          d.producto_id,
          d.producto_nombre,
          d.cantidad,
          d.costo_unitario,
          numero,
          d.created_by,
          d.usuario_nombre,
        ]
      );
      movimientoId = movRows[0]?.id ?? null;
    } catch (movErr) {
      const msg = movErr instanceof Error ? movErr.message : String(movErr);
      console.error("[compras-pg] movimiento ENTRADA fallo", {
        schema, empresaId, numero, message: msg,
        code: (movErr as { code?: string })?.code,
        detail: (movErr as { detail?: string })?.detail,
      });
      movimientoWarning =
        "La compra se guardó pero no se pudo registrar el movimiento de entrada en inventario.";
    }

    // Actualizar producto: stock + costo_promedio siempre; precio_venta solo si > 0
    // (no pisamos el precio de insumos / materia prima con 0).
    await client.query(
      `UPDATE ${tP}
          SET stock_actual = stock_actual + $1::numeric,
              costo_promedio = $2::numeric,
              precio_venta = CASE WHEN $3::numeric > 0 THEN $3::numeric ELSE precio_venta END,
              updated_at = now()
        WHERE id = $4::uuid AND empresa_id = $5::uuid`,
      [d.cantidad, d.costo_unitario, d.precio_venta, d.producto_id, empresaId]
    );

    // Mantener relación producto↔proveedor (costo_habitual). No pisa marca.
    await upsertProveedorProducto(
      client, tPP, empresaId, d.producto_id, d.proveedor_id, d.costo_unitario
    );

    await client.query("COMMIT");
    return { compra, movimiento_id: movimientoId, movimiento_warning: movimientoWarning };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}
