import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getCotizacionVigente, guardarCotizacion } from "@/lib/cotizaciones/server/cotizaciones-pg";

/**
 * GET /api/tipo-cambio?origen=USD&destino=PYG
 *
 * Cotización vigente (cache → proveedor → última guardada). Si no hay ninguna
 * disponible devuelve 404 con un mensaje claro: el front debe pedir carga
 * manual y advertir. Nunca se responde 1 para un par distinto de monedas.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);

    const url = new URL(request.url);
    const origen = (url.searchParams.get("origen") ?? "USD").toUpperCase();
    const destino = (url.searchParams.get("destino") ?? "PYG").toUpperCase();

    const cot = await getCotizacionVigente(schema, ctx.auth.empresa_id, origen, destino);
    if (!cot) {
      return NextResponse.json(
        errorResponse(
          "No hay cotización disponible. Cargala manualmente para continuar (no se puede asumir 1 para una compra en moneda extranjera)."
        ),
        { status: 404 }
      );
    }
    return NextResponse.json(successResponse(cot));
  } catch (err) {
    console.error("[/api/tipo-cambio GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo obtener la cotización."), { status: 500 });
  }
}

/**
 * POST /api/tipo-cambio — carga manual auditada.
 * Body: { cotizacion: number, origen?, destino? }
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const valor = Number(body.cotizacion);
    if (!Number.isFinite(valor) || valor <= 0) {
      return NextResponse.json(errorResponse("La cotización debe ser un número mayor a cero."), { status: 400 });
    }

    const origen = String(body.origen ?? "USD").toUpperCase();
    const destino = String(body.destino ?? "PYG").toUpperCase();

    await guardarCotizacion(schema, ctx.auth.empresa_id, {
      cotizacion: valor,
      moneda_origen: origen,
      moneda_destino: destino,
      fuente: "manual",
      es_manual: true,
      created_by: ctx.auth.usuarioCatalogId ?? null,
    });

    return NextResponse.json(
      successResponse({
        moneda_origen: origen,
        moneda_destino: destino,
        cotizacion: valor,
        fuente: "manual",
        es_manual: true,
        fecha_cotizacion: new Date().toISOString(),
      }),
      { status: 201 }
    );
  } catch (err) {
    console.error("[/api/tipo-cambio POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo guardar la cotización."), { status: 500 });
  }
}
