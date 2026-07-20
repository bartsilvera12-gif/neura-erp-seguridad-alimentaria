import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { getOrdenCompra } from "@/lib/ordenes-compra/server/ordenes-compra-pg";

/** GET /api/ordenes-compra/[numero] — líneas de una OC por numero_oc. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ numero: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { numero } = await params;
    const schema = await fetchDataSchemaForEmpresaId(ctx.auth.empresa_id);
    const ordenes = await getOrdenCompra(schema, ctx.auth.empresa_id, decodeURIComponent(numero));
    if (ordenes.length === 0)
      return NextResponse.json(errorResponse("Orden de compra no encontrada."), { status: 404 });
    return NextResponse.json(successResponse({ ordenes }));
  } catch (err) {
    console.error("[/api/ordenes-compra/[numero] GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cargar la orden de compra."), { status: 500 });
  }
}
