/**
 * Recepciones de mercadería contra una orden de compra.
 *
 * Separa "ordenar" de "recibir": crear la orden NO toca inventario
 * (ver compras-pg.ts). El stock, el costo promedio y el movimiento ENTRADA se
 * generan acá, una vez por cada entrega física, y SOLO por la cantidad recibida.
 *
 * Garantías:
 *  - Todo dentro de una transacción PG real (BEGIN/COMMIT), igual que compras.
 *  - `SELECT ... FOR UPDATE` sobre las líneas de la orden: dos recepciones
 *    simultáneas se serializan en vez de pisarse.
 *  - Idempotencia por `idempotency_key`: un doble clic o un reintento de red no
 *    duplica stock (devuelve la recepción ya registrada).
 *  - Nunca se recibe más de lo pendiente, ni cantidades <= 0, ni sobre órdenes
 *    anuladas o ya completas.
 *
 * Costo promedio: se recalcula PONDERADO con el stock previo. El flujo viejo de
 * compras pisaba `costo_promedio` con el último costo, lo que con entregas
 * parciales a distinto precio da un costo incorrecto.
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";

function pool() {
  const p = getChatPostgresPool();
  if (!p) throw new Error("Pool no disponible.");
  return p;
}

export class RecepcionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "ORDEN_NO_ENCONTRADA"
      | "ORDEN_ANULADA"
      | "ORDEN_COMPLETA"
      | "CANTIDAD_INVALIDA"
      | "EXCEDE_PENDIENTE"
      | "SIN_ITEMS"
  ) {
    super(message);
    this.name = "RecepcionError";
  }
}

export interface RecepcionItemInput {
  /** Id de la fila de `compras` (una línea de la orden). */
  compra_id: string;
  cantidad_recibida: number;
}

export interface RegistrarRecepcionInput {
  numero_control: string;
  items: RecepcionItemInput[];
  observaciones?: string | null;
  /** Fecha estimada declarada para el saldo que queda pendiente. */
  proxima_entrega_estimada?: string | null;
  idempotency_key?: string | null;
  created_by?: string | null;
  usuario_nombre?: string | null;
}

export interface LineaOrdenEstado {
  compra_id: string;
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  cantidad_recibida: number;
  pendiente: number;
  estado_recepcion: string;
  costo_unitario: number;
  fecha_estimada_llegada: string | null;
}

export interface RecepcionResult {
  recepcion_id: string;
  numero_control: string;
  /** true si la clave de idempotencia ya existía: no se volvió a impactar stock. */
  idempotente: boolean;
  estado_orden: "pendiente" | "parcial" | "completa" | "cancelada";
  lineas: LineaOrdenEstado[];
}

/** Estado de recepción de una orden (todas sus líneas). No modifica nada. */
export async function getEstadoOrden(
  schemaRaw: string,
  empresaId: string,
  numeroControl: string
): Promise<LineaOrdenEstado[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "compras");
  const { rows } = await pool().query<{
    compra_id: string;
    producto_id: string;
    producto_nombre: string;
    cantidad: string;
    cantidad_recibida: string;
    estado_recepcion: string;
    costo_unitario: string;
    fecha_estimada_llegada: string | null;
  }>(
    `SELECT id AS compra_id, producto_id, producto_nombre,
            cantidad, cantidad_recibida, estado_recepcion, costo_unitario,
            fecha_estimada_llegada
       FROM ${tC}
      WHERE empresa_id = $1::uuid AND numero_control = $2
      ORDER BY producto_nombre`,
    [empresaId, numeroControl]
  );
  return rows.map((r) => {
    const cant = Number(r.cantidad) || 0;
    const rec = Number(r.cantidad_recibida) || 0;
    return {
      compra_id: r.compra_id,
      producto_id: r.producto_id,
      producto_nombre: r.producto_nombre,
      cantidad: cant,
      cantidad_recibida: rec,
      pendiente: Math.max(0, cant - rec),
      estado_recepcion: r.estado_recepcion,
      costo_unitario: Number(r.costo_unitario) || 0,
      fecha_estimada_llegada: r.fecha_estimada_llegada,
    };
  });
}

export interface RecepcionListada {
  id: string;
  numero_control: string;
  fecha_recepcion: string;
  observaciones: string | null;
  proxima_entrega_estimada: string | null;
  usuario_nombre: string | null;
  items: Array<{
    producto_id: string;
    producto_nombre: string | null;
    cantidad_recibida: number;
    costo_unitario_pyg_snapshot: number;
  }>;
}

/** Historial de recepciones de una orden, con su detalle. */
export async function listRecepciones(
  schemaRaw: string,
  empresaId: string,
  numeroControl: string
): Promise<RecepcionListada[]> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tR = quoteSchemaTable(schema, "compras_recepciones");
  const tRI = quoteSchemaTable(schema, "compras_recepciones_items");

  const { rows: cabeceras } = await pool().query<{
    id: string;
    numero_control: string;
    fecha_recepcion: string;
    observaciones: string | null;
    proxima_entrega_estimada: string | null;
    usuario_nombre: string | null;
  }>(
    `SELECT id, numero_control, fecha_recepcion, observaciones,
            proxima_entrega_estimada, usuario_nombre
       FROM ${tR}
      WHERE empresa_id = $1::uuid AND numero_control = $2
      ORDER BY fecha_recepcion DESC`,
    [empresaId, numeroControl]
  );
  if (cabeceras.length === 0) return [];

  const { rows: items } = await pool().query<{
    recepcion_id: string;
    producto_id: string;
    producto_nombre: string | null;
    cantidad_recibida: string;
    costo_unitario_pyg_snapshot: string;
  }>(
    `SELECT recepcion_id, producto_id, producto_nombre,
            cantidad_recibida, costo_unitario_pyg_snapshot
       FROM ${tRI}
      WHERE empresa_id = $1::uuid
        AND recepcion_id = ANY($2::uuid[])`,
    [empresaId, cabeceras.map((c) => c.id)]
  );

  return cabeceras.map((c) => ({
    id: c.id,
    numero_control: c.numero_control,
    fecha_recepcion: c.fecha_recepcion,
    observaciones: c.observaciones,
    proxima_entrega_estimada: c.proxima_entrega_estimada,
    usuario_nombre: c.usuario_nombre,
    items: items
      .filter((i) => i.recepcion_id === c.id)
      .map((i) => ({
        producto_id: i.producto_id,
        producto_nombre: i.producto_nombre,
        cantidad_recibida: Number(i.cantidad_recibida) || 0,
        costo_unitario_pyg_snapshot: Number(i.costo_unitario_pyg_snapshot) || 0,
      })),
  }));
}

/**
 * Registra una recepción (total o parcial) e impacta inventario.
 * Todo o nada: si algo falla, no queda stock ni recepción a medias.
 */
export async function registrarRecepcion(
  schemaRaw: string,
  empresaId: string,
  input: RegistrarRecepcionInput
): Promise<RecepcionResult> {
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tC = quoteSchemaTable(schema, "compras");
  const tR = quoteSchemaTable(schema, "compras_recepciones");
  const tRI = quoteSchemaTable(schema, "compras_recepciones_items");
  const tM = quoteSchemaTable(schema, "movimientos_inventario");
  const tP = quoteSchemaTable(schema, "productos");

  const itemsPedidos = (input.items ?? []).filter((i) => Number(i.cantidad_recibida) > 0);
  if (itemsPedidos.length === 0) {
    throw new RecepcionError("Indicá al menos un producto con cantidad recibida.", "SIN_ITEMS");
  }
  for (const it of itemsPedidos) {
    const n = Number(it.cantidad_recibida);
    if (!Number.isFinite(n) || n <= 0) {
      throw new RecepcionError("Las cantidades recibidas deben ser mayores a cero.", "CANTIDAD_INVALIDA");
    }
  }

  const client = await pool().connect();
  try {
    await client.query("BEGIN");

    // Idempotencia: si la clave ya fue usada, devolvemos lo que ya se registró
    // sin volver a tocar stock.
    if (input.idempotency_key) {
      const { rows: yaExiste } = await client.query<{ id: string }>(
        `SELECT id FROM ${tR}
          WHERE empresa_id = $1::uuid AND idempotency_key = $2
          LIMIT 1`,
        [empresaId, input.idempotency_key]
      );
      if (yaExiste[0]) {
        await client.query("COMMIT");
        const lineas = await getEstadoOrden(schemaRaw, empresaId, input.numero_control);
        return {
          recepcion_id: yaExiste[0].id,
          numero_control: input.numero_control,
          idempotente: true,
          estado_orden: resolverEstadoOrden(lineas),
          lineas,
        };
      }
    }

    // Bloqueo de las líneas de la orden: serializa recepciones concurrentes.
    const { rows: lineasOrden } = await client.query<{
      id: string;
      producto_id: string;
      producto_nombre: string;
      cantidad: string;
      cantidad_recibida: string;
      costo_unitario: string;
      estado_recepcion: string;
      anulada_at: string | null;
    }>(
      `SELECT id, producto_id, producto_nombre, cantidad, cantidad_recibida,
              costo_unitario, estado_recepcion, anulada_at
         FROM ${tC}
        WHERE empresa_id = $1::uuid AND numero_control = $2
        FOR UPDATE`,
      [empresaId, input.numero_control]
    );

    if (lineasOrden.length === 0) {
      throw new RecepcionError(`No se encontró la orden ${input.numero_control}.`, "ORDEN_NO_ENCONTRADA");
    }
    if (lineasOrden.some((l) => l.anulada_at !== null || l.estado_recepcion === "cancelada")) {
      throw new RecepcionError("La orden está anulada: no admite recepciones.", "ORDEN_ANULADA");
    }
    if (lineasOrden.every((l) => l.estado_recepcion === "completa")) {
      throw new RecepcionError("La orden ya fue recibida por completo.", "ORDEN_COMPLETA");
    }

    const porId = new Map(lineasOrden.map((l) => [l.id, l]));

    // Validación previa: ninguna línea puede exceder su pendiente.
    for (const it of itemsPedidos) {
      const linea = porId.get(it.compra_id);
      if (!linea) {
        throw new RecepcionError("Uno de los productos no pertenece a esta orden.", "ORDEN_NO_ENCONTRADA");
      }
      const pendiente = (Number(linea.cantidad) || 0) - (Number(linea.cantidad_recibida) || 0);
      if (Number(it.cantidad_recibida) > pendiente + 1e-9) {
        throw new RecepcionError(
          `No se puede recibir ${it.cantidad_recibida} de "${linea.producto_nombre}": quedan ${pendiente} pendientes.`,
          "EXCEDE_PENDIENTE"
        );
      }
    }

    // Cabecera de la recepción.
    const { rows: recRows } = await client.query<{ id: string }>(
      `INSERT INTO ${tR} (
         empresa_id, numero_control, fecha_recepcion, observaciones,
         proxima_entrega_estimada, created_by, usuario_nombre, idempotency_key
       ) VALUES ($1::uuid, $2, now(), $3, $4::date, $5::uuid, $6, $7)
       RETURNING id`,
      [
        empresaId,
        input.numero_control,
        input.observaciones ?? null,
        input.proxima_entrega_estimada ?? null,
        input.created_by ?? null,
        input.usuario_nombre ?? null,
        input.idempotency_key ?? null,
      ]
    );
    const recepcionId = recRows[0].id;

    for (const it of itemsPedidos) {
      const linea = porId.get(it.compra_id)!;
      const cantidad = Number(it.cantidad_recibida);
      const costoPyg = Number(linea.costo_unitario) || 0;

      // 1) Movimiento ENTRADA solo por lo recibido.
      const { rows: movRows } = await client.query<{ id: string }>(
        `INSERT INTO ${tM} (
           empresa_id, producto_id, producto_nombre, producto_sku,
           tipo, cantidad, costo_unitario, origen, referencia, fecha,
           created_by, usuario_nombre, compra_id, recepcion_id
         )
         SELECT $1::uuid, $2::uuid, $3, COALESCE(p.sku, ''),
                'ENTRADA', $4::numeric, $5::numeric, 'compra', $6, now(),
                $7::uuid, $8, $9::uuid, $10::uuid
           FROM ${tP} p
          WHERE p.id = $2::uuid AND p.empresa_id = $1::uuid
         RETURNING id`,
        [
          empresaId, linea.producto_id, linea.producto_nombre, cantidad, costoPyg,
          input.numero_control, input.created_by ?? null, input.usuario_nombre ?? null,
          linea.id, recepcionId,
        ]
      );

      // 2) Detalle de la recepción (con snapshot del costo en PYG).
      await client.query(
        `INSERT INTO ${tRI} (
           empresa_id, recepcion_id, compra_id, producto_id, producto_nombre,
           cantidad_recibida, costo_unitario_pyg_snapshot, movimiento_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, $7::numeric, $8::uuid)`,
        [
          empresaId, recepcionId, linea.id, linea.producto_id, linea.producto_nombre,
          cantidad, costoPyg, movRows[0]?.id ?? null,
        ]
      );

      // 3) Stock + costo promedio PONDERADO (no pisar con el último costo).
      //    nuevo_costo = (stock_actual * costo_actual + recibido * costo_orden)
      //                  / (stock_actual + recibido)
      //    Si el stock previo es <= 0, el costo pasa a ser el de esta entrada.
      await client.query(
        `UPDATE ${tP}
            SET costo_promedio = CASE
                  WHEN COALESCE(stock_actual, 0) + $1::numeric <= 0 THEN $2::numeric
                  WHEN COALESCE(stock_actual, 0) <= 0 THEN $2::numeric
                  ELSE ROUND(
                    ((COALESCE(stock_actual,0) * COALESCE(costo_promedio,0)) + ($1::numeric * $2::numeric))
                    / (COALESCE(stock_actual,0) + $1::numeric)
                  , 4)
                END,
                stock_actual = COALESCE(stock_actual, 0) + $1::numeric,
                updated_at = now()
          WHERE id = $3::uuid AND empresa_id = $4::uuid`,
        [cantidad, costoPyg, linea.producto_id, empresaId]
      );

      // 4) Avance de la línea de la orden.
      await client.query(
        `UPDATE ${tC}
            SET cantidad_recibida = cantidad_recibida + $1::numeric,
                estado_recepcion = CASE
                  WHEN cantidad_recibida + $1::numeric >= cantidad THEN 'completa'
                  ELSE 'parcial'
                END,
                recepcion_completada_at = CASE
                  WHEN cantidad_recibida + $1::numeric >= cantidad THEN now()
                  ELSE recepcion_completada_at
                END,
                fecha_ultima_recepcion = now(),
                fecha_estimada_llegada = CASE
                  WHEN cantidad_recibida + $1::numeric >= cantidad THEN fecha_estimada_llegada
                  ELSE COALESCE($2::date, fecha_estimada_llegada)
                END,
                updated_at = now()
          WHERE id = $3::uuid AND empresa_id = $4::uuid`,
        [cantidad, input.proxima_entrega_estimada ?? null, linea.id, empresaId]
      );
    }

    await client.query("COMMIT");

    const lineas = await getEstadoOrden(schemaRaw, empresaId, input.numero_control);
    return {
      recepcion_id: recepcionId,
      numero_control: input.numero_control,
      idempotente: false,
      estado_orden: resolverEstadoOrden(lineas),
      lineas,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

/** Estado agregado de la orden a partir del estado de sus líneas. */
export function resolverEstadoOrden(
  lineas: Array<{ estado_recepcion: string; cantidad_recibida: number; pendiente: number }>
): "pendiente" | "parcial" | "completa" | "cancelada" {
  if (lineas.length === 0) return "pendiente";
  if (lineas.every((l) => l.estado_recepcion === "cancelada")) return "cancelada";
  if (lineas.every((l) => l.pendiente <= 0)) return "completa";
  if (lineas.some((l) => l.cantidad_recibida > 0)) return "parcial";
  return "pendiente";
}
