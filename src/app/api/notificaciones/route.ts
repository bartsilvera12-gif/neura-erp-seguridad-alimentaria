import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  listNotificaciones,
  evaluarDocumentosPorVencer,
  evaluarOrdenesPendientes,
  evaluarStockBajo,
} from "@/lib/notificaciones/server";

/**
 * GET /api/notificaciones
 *
 * Devuelve las notificaciones de la empresa + contador de no leídas. De paso
 * evalúa (throttled, best-effort) los documentos vencidos o por vencer: así la
 * campanita se mantiene al día sin necesidad de un cron.
 *
 * Resiliente: cualquier fallo devuelve una lista vacía en vez de romper el
 * header, que se renderiza en todas las pantallas.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);

    // Dos orígenes, una sola campanita. Cada evaluador tiene su propio throttle
    // y es best-effort: si uno falla, el otro y el listado siguen andando.
    try {
      await evaluarDocumentosPorVencer(schema, ctx.auth.empresa_id);
    } catch (e) {
      console.error("[/api/notificaciones] evaluar documentos:", e instanceof Error ? e.message : e);
    }
    try {
      await evaluarOrdenesPendientes(schema, ctx.auth.empresa_id);
    } catch (e) {
      console.error("[/api/notificaciones] evaluar órdenes:", e instanceof Error ? e.message : e);
    }
    try {
      await evaluarStockBajo(schema, ctx.auth.empresa_id);
    } catch (e) {
      console.error("[/api/notificaciones] evaluar stock:", e instanceof Error ? e.message : e);
    }

    try {
      const data = await listNotificaciones(schema, ctx.auth.empresa_id);
      return NextResponse.json(successResponse(data));
    } catch (e) {
      console.error("[/api/notificaciones] list:", e instanceof Error ? e.message : e);
      return NextResponse.json(successResponse({ notificaciones: [], no_leidas: 0 }));
    }
  } catch (err) {
    console.error("[/api/notificaciones]", err instanceof Error ? err.message : err);
    return NextResponse.json(successResponse({ notificaciones: [], no_leidas: 0 }));
  }
}
