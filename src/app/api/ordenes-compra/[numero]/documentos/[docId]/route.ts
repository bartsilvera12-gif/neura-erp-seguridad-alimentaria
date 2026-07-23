import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { DOCUMENTOS_BUCKET, signDocumento } from "@/lib/documentos/storage";

/**
 * GET /api/ordenes-compra/[numero]/documentos/[docId]
 * URL firmada de corta duración para ver o descargar el adjunto.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ numero: string; docId: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { numero, docId } = await params;

    const { data, error } = await ctx.supabase
      .from("ordenes_compra_documentos")
      .select("archivo_path, archivo_nombre, mime_type")
      .eq("id", docId)
      .eq("numero_oc", decodeURIComponent(numero))
      .eq("empresa_id", ctx.auth.empresa_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json(errorResponse("Documento no encontrado."), { status: 404 });

    const url = await signDocumento(ctx.supabase, ctx.auth.empresa_id, data.archivo_path);
    if (!url) return NextResponse.json(errorResponse("No se pudo generar el enlace."), { status: 500 });

    return NextResponse.json(
      successResponse({ url, nombre: data.archivo_nombre, mime_type: data.mime_type })
    );
  } catch (err) {
    console.error("[/api/ordenes-compra/[numero]/documentos/[docId] GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo abrir el documento."), { status: 500 });
  }
}

/** DELETE — quita el adjunto y borra el archivo del bucket. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ numero: string; docId: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { numero, docId } = await params;
    const empresaId = ctx.auth.empresa_id;

    const { data, error } = await ctx.supabase
      .from("ordenes_compra_documentos")
      .select("archivo_path")
      .eq("id", docId)
      .eq("numero_oc", decodeURIComponent(numero))
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json(errorResponse("Documento no encontrado."), { status: 404 });

    const { error: errDel } = await ctx.supabase
      .from("ordenes_compra_documentos")
      .delete()
      .eq("id", docId)
      .eq("empresa_id", empresaId);
    if (errDel) throw new Error(errDel.message);

    // El archivo se borra DESPUÉS de la fila: un archivo huérfano en el bucket
    // es preferible a una fila que apunte a un archivo inexistente.
    const { error: errStorage } = await ctx.supabase.storage
      .from(DOCUMENTOS_BUCKET)
      .remove([data.archivo_path]);
    if (errStorage) {
      console.error("[oc-documentos] archivo huérfano en el bucket:", data.archivo_path, errStorage.message);
    }

    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    console.error("[/api/ordenes-compra/[numero]/documentos/[docId] DELETE]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo eliminar el documento."), { status: 500 });
  }
}
