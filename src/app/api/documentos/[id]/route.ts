import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { DOCUMENTOS_BUCKET, documentoPathEsDeEmpresa } from "@/lib/documentos/storage";

const COLS =
  "id, nombre, descripcion, categoria, archivo_path, archivo_nombre, mime_type, " +
  "tamano_bytes, fecha_vencimiento, dias_aviso_previo, archivado, created_at";

/**
 * PATCH /api/documentos/[id] — edita metadatos: nombre, descripción, categoría,
 * fecha de vencimiento, días de aviso previo y archivado. No reemplaza el archivo.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { supabase, auth } = ctx;
    const { id } = await params;

    const body = (await request.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if (typeof body.nombre === "string" && body.nombre.trim()) patch.nombre = body.nombre.trim();
    if ("descripcion" in body) patch.descripcion = String(body.descripcion ?? "").trim() || null;
    if ("categoria" in body) patch.categoria = String(body.categoria ?? "").trim() || null;

    if ("fecha_vencimiento" in body) {
      const v = String(body.fecha_vencimiento ?? "").trim();
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        return NextResponse.json(errorResponse("Fecha de vencimiento inválida."), { status: 400 });
      }
      patch.fecha_vencimiento = v || null;
    }

    if ("dias_aviso_previo" in body) {
      const n = parseInt(String(body.dias_aviso_previo), 10);
      if (!Number.isFinite(n) || n < 0 || n > 365) {
        return NextResponse.json(
          errorResponse("Los días de aviso deben estar entre 0 y 365."),
          { status: 400 }
        );
      }
      patch.dias_aviso_previo = n;
    }

    if ("archivado" in body) patch.archivado = body.archivado === true;

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(errorResponse("Nada para actualizar."), { status: 400 });
    }

    const { data, error } = await supabase
      .from("documentos")
      .update(patch)
      .eq("id", id)
      .eq("empresa_id", auth.empresa_id)
      .select(COLS)
      .single();

    if (error) return NextResponse.json(errorResponse(error.message), { status: 500 });
    if (!data) return NextResponse.json(errorResponse("Documento no encontrado."), { status: 404 });

    return NextResponse.json(successResponse({ documento: data }));
  } catch (err) {
    console.error("[/api/documentos/[id] PATCH]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo actualizar el documento."), { status: 500 });
  }
}

/**
 * DELETE /api/documentos/[id] — borra el documento y su archivo en Storage.
 * Las notificaciones asociadas caen por el ON DELETE CASCADE de la FK.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { supabase, auth } = ctx;
    const { id } = await params;

    const { data: doc, error: findErr } = await supabase
      .from("documentos")
      .select("id, archivo_path")
      .eq("id", id)
      .eq("empresa_id", auth.empresa_id)
      .maybeSingle();

    if (findErr) return NextResponse.json(errorResponse(findErr.message), { status: 500 });
    if (!doc) return NextResponse.json(errorResponse("Documento no encontrado."), { status: 404 });

    const { error: delErr } = await supabase
      .from("documentos")
      .delete()
      .eq("id", id)
      .eq("empresa_id", auth.empresa_id);
    if (delErr) return NextResponse.json(errorResponse(delErr.message), { status: 500 });

    // El archivo se borra después de la fila: si esto falla, queda un huérfano
    // en Storage pero el documento ya no existe para el usuario (best-effort).
    const path = String(doc.archivo_path ?? "");
    if (path && documentoPathEsDeEmpresa(path, auth.empresa_id)) {
      const { error: rmErr } = await supabase.storage.from(DOCUMENTOS_BUCKET).remove([path]);
      if (rmErr) console.error("[/api/documentos/[id] DELETE] storage:", rmErr.message);
    }

    return NextResponse.json(successResponse({ eliminado: true }));
  } catch (err) {
    console.error("[/api/documentos/[id] DELETE]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo eliminar el documento."), { status: 500 });
  }
}
