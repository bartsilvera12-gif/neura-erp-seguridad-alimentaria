import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  registrarRecepcion,
  listRecepciones,
  getEstadoOrden,
  resolverEstadoOrden,
  RecepcionError,
  type RecepcionItemInput,
} from "@/lib/compras/server/recepciones-pg";

/**
 * GET /api/compras/[numero_control]/recepciones
 *
 * Historial de recepciones de la orden + estado actual de cada línea
 * (pedido / recibido / pendiente), para pintar el modal y el listado.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ numero_control: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { numero_control } = await params;
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);

    const [recepciones, lineas] = await Promise.all([
      listRecepciones(schema, ctx.auth.empresa_id, numero_control),
      getEstadoOrden(schema, ctx.auth.empresa_id, numero_control),
    ]);

    if (lineas.length === 0) {
      return NextResponse.json(errorResponse("Orden no encontrada."), { status: 404 });
    }

    return NextResponse.json(
      successResponse({
        numero_control,
        estado_orden: resolverEstadoOrden(lineas),
        lineas,
        recepciones,
      })
    );
  } catch (err) {
    console.error("[/api/compras/[numero_control]/recepciones GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar las recepciones."), { status: 500 });
  }
}

/**
 * POST /api/compras/[numero_control]/recepciones
 *
 * Registra una entrega (total o parcial). Impacta stock, costo promedio y
 * movimientos SOLO por lo recibido, dentro de una transacción.
 *
 * Body: { items: [{ compra_id, cantidad_recibida }], observaciones?,
 *         proxima_entrega_estimada?, idempotency_key? }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ numero_control: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { numero_control } = await params;
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items: RecepcionItemInput[] = [];
    for (const r of rawItems as Record<string, unknown>[]) {
      const compraId = String(r.compra_id ?? "").trim();
      const cant = Number(r.cantidad_recibida);
      if (!compraId) continue;
      if (!Number.isFinite(cant) || cant <= 0) continue;
      items.push({ compra_id: compraId, cantidad_recibida: cant });
    }
    if (items.length === 0) {
      return NextResponse.json(
        errorResponse("Indicá al menos un producto con cantidad recibida mayor a cero."),
        { status: 400 }
      );
    }

    const vencRaw = String(body.proxima_entrega_estimada ?? "").trim();
    const proximaEntrega = /^\d{4}-\d{2}-\d{2}$/.test(vencRaw) ? vencRaw : null;

    const resultado = await registrarRecepcion(schema, ctx.auth.empresa_id, {
      numero_control,
      items,
      observaciones: String(body.observaciones ?? "").trim() || null,
      proxima_entrega_estimada: proximaEntrega,
      idempotency_key: String(body.idempotency_key ?? "").trim() || null,
      created_by: ctx.auth.usuarioCatalogId ?? null,
      usuario_nombre: ctx.auth.user?.email ?? null,
    });

    return NextResponse.json(successResponse(resultado), { status: resultado.idempotente ? 200 : 201 });
  } catch (err) {
    if (err instanceof RecepcionError) {
      const status =
        err.code === "ORDEN_NO_ENCONTRADA" ? 404 :
        err.code === "ORDEN_ANULADA" || err.code === "ORDEN_COMPLETA" ? 409 :
        400;
      return NextResponse.json(errorResponse(err.message), { status });
    }
    console.error("[/api/compras/[numero_control]/recepciones POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo registrar la recepción."), { status: 500 });
  }
}
