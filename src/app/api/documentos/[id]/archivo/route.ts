import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { signDocumento } from "@/lib/documentos/storage";

/**
 * GET /api/documentos/[id]/archivo
 *
 * Devuelve una URL firmada (5 min) para ver o descargar el archivo. El bucket
 * es privado: nunca se expone una URL pública.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { supabase, auth } = ctx;
    const { id } = await params;

    const { data: doc, error } = await supabase
      .from("documentos")
      .select("archivo_path, archivo_nombre")
      .eq("id", id)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (error) return NextResponse.json(errorResponse(error.message), { status: 500 });
    if (!doc) return NextResponse.json(errorResponse("Documento no encontrado."), { status: 404 });

    const url = await signDocumento(supabase, auth.empresa_id, doc.archivo_path as string);
    if (!url) {
      return NextResponse.json(errorResponse("No se pudo generar el enlace."), { status: 500 });
    }

    return NextResponse.json(successResponse({ url, nombre: doc.archivo_nombre }));
  } catch (err) {
    console.error("[/api/documentos/[id]/archivo]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo generar el enlace."), { status: 500 });
  }
}
