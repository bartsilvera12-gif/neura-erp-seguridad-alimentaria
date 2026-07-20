import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { DOCUMENTOS_BUCKET, signDocumento } from "@/lib/documentos/storage";

/**
 * GET /api/productos/[id]/documentos/[docId]
 *
 * Devuelve una URL firmada de corta duración para ver o descargar el adjunto.
 * El bucket es privado: no hay URL permanente que se pueda compartir por fuera
 * del sistema.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { id, docId } = await params;

    const { data, error } = await ctx.supabase
      .from("producto_documentos")
      .select("archivo_path, archivo_nombre, mime_type")
      .eq("id", docId)
      .eq("producto_id", id)
      .eq("empresa_id", ctx.auth.empresa_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json(errorResponse("Documento no encontrado."), { status: 404 });

    // `signDocumento` revalida que el path pertenezca a la empresa antes de
    // firmar — defensa en profundidad sobre el filtro del SELECT de arriba.
    const url = await signDocumento(ctx.supabase, ctx.auth.empresa_id, data.archivo_path);
    if (!url) {
      return NextResponse.json(errorResponse("No se pudo generar el enlace."), { status: 500 });
    }
    return NextResponse.json(
      successResponse({ url, nombre: data.archivo_nombre, mime_type: data.mime_type })
    );
  } catch (err) {
    console.error("[/api/productos/[id]/documentos/[docId] GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo abrir el documento."), { status: 500 });
  }
}

/**
 * DELETE /api/productos/[id]/documentos/[docId]
 * Quita el adjunto y borra el archivo del bucket.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { id, docId } = await params;
    const empresaId = ctx.auth.empresa_id;

    const { data, error } = await ctx.supabase
      .from("producto_documentos")
      .select("archivo_path")
      .eq("id", docId)
      .eq("producto_id", id)
      .eq("empresa_id", empresaId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json(errorResponse("Documento no encontrado."), { status: 404 });

    const { error: errDel } = await ctx.supabase
      .from("producto_documentos")
      .delete()
      .eq("id", docId)
      .eq("empresa_id", empresaId);
    if (errDel) throw new Error(errDel.message);

    // El archivo se borra DESPUÉS de la fila. Si esto falla queda un archivo
    // huérfano en el bucket, que es preferible a una fila que apunta a un
    // archivo inexistente (un botón de descarga roto en la ficha).
    const { error: errStorage } = await ctx.supabase.storage
      .from(DOCUMENTOS_BUCKET)
      .remove([data.archivo_path]);
    if (errStorage) {
      console.error("[producto-documentos] archivo huérfano en el bucket:", data.archivo_path, errStorage.message);
    }

    return NextResponse.json(successResponse({ ok: true }));
  } catch (err) {
    console.error("[/api/productos/[id]/documentos/[docId] DELETE]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo eliminar el documento."), { status: 500 });
  }
}
