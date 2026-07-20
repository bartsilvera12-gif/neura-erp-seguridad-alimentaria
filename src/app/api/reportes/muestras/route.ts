import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getReporteMuestras } from "@/lib/reportes/server/reportes-pg";
import { asuncionRangeBoundsUtc } from "@/lib/fechas/asuncion-bounds";

/**
 * GET /api/reportes/muestras?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 *          &tipo=muestra|regalo&producto=&cliente=&usuario=
 *
 * Productos entregados sin cargo. A diferencia del resto de los reportes, que
 * trabajan por mes cerrado, este acepta un rango libre: una campaña de muestras
 * rara vez coincide con el corte del mes.
 *
 * Sin `desde`/`hasta` cae al mes actual (ver `asuncionRangeBoundsUtc`).
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);

    const sp = new URL(request.url).searchParams;
    const ymd = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const { start, end } = asuncionRangeBoundsUtc(ymd(sp.get("desde")), ymd(sp.get("hasta")));

    const txt = (k: string) => {
      const v = sp.get(k);
      return v != null && v.trim() !== "" ? v.trim() : null;
    };
    const tipoRaw = sp.get("tipo");
    const tipo = tipoRaw === "muestra" || tipoRaw === "regalo" ? tipoRaw : null;

    const data = await getReporteMuestras(schema, ctx.auth.empresa_id, {
      desde: start,
      hasta: end,
      tipo,
      producto: txt("producto"),
      cliente: txt("cliente"),
      usuario: txt("usuario"),
    });
    return NextResponse.json(successResponse(data));
  } catch (err) {
    console.error("[/api/reportes/muestras]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cargar el reporte de muestras y regalos."), { status: 500 });
  }
}
