import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import {
  DOCUMENTOS_BUCKET,
  MAX_DOCUMENTO_BYTES,
  buildDocumentoPath,
  ensureDocumentosBucket,
} from "@/lib/documentos/storage";

const COLS =
  "id, nombre, descripcion, categoria, archivo_path, archivo_nombre, mime_type, " +
  "tamano_bytes, fecha_vencimiento, dias_aviso_previo, archivado, created_at";

/** GET /api/documentos — lista los documentos de la empresa (no archivados por defecto). */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { supabase, auth } = ctx;

    const incluirArchivados =
      new URL(request.url).searchParams.get("archivados") === "1";

    let query = supabase
      .from("documentos")
      .select(COLS)
      .eq("empresa_id", auth.empresa_id);

    if (!incluirArchivados) query = query.eq("archivado", false);

    const { data, error } = await query
      // Los que vencen primero arriba; los que no vencen, al final.
      .order("fecha_vencimiento", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (error) return NextResponse.json(errorResponse(error.message), { status: 500 });
    return NextResponse.json(successResponse({ documentos: data ?? [] }));
  } catch (err) {
    console.error("[/api/documentos GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar los documentos."), { status: 500 });
  }
}

/**
 * POST /api/documentos — sube un archivo y crea el documento.
 * Body: multipart/form-data con `archivo` + campos del formulario.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { supabase, auth } = ctx;

    const form = await request.formData();
    const archivo = form.get("archivo");
    if (!(archivo instanceof File) || archivo.size === 0) {
      return NextResponse.json(errorResponse("Falta el archivo."), { status: 400 });
    }
    if (archivo.size > MAX_DOCUMENTO_BYTES) {
      return NextResponse.json(
        errorResponse(`El archivo supera el máximo de ${Math.round(MAX_DOCUMENTO_BYTES / 1024 / 1024)} MB.`),
        { status: 400 }
      );
    }

    const nombre = String(form.get("nombre") ?? "").trim() || archivo.name;
    const descripcion = String(form.get("descripcion") ?? "").trim() || null;
    const categoria = String(form.get("categoria") ?? "").trim() || null;

    const vencRaw = String(form.get("fecha_vencimiento") ?? "").trim();
    const fechaVencimiento = /^\d{4}-\d{2}-\d{2}$/.test(vencRaw) ? vencRaw : null;

    const diasRaw = parseInt(String(form.get("dias_aviso_previo") ?? ""), 10);
    const diasAviso = Number.isFinite(diasRaw) ? Math.min(365, Math.max(0, diasRaw)) : 30;

    await ensureDocumentosBucket(supabase);

    const path = buildDocumentoPath(auth.empresa_id, crypto.randomUUID(), archivo.name);
    const bytes = new Uint8Array(await archivo.arrayBuffer());

    const { error: upErr } = await supabase.storage
      .from(DOCUMENTOS_BUCKET)
      .upload(path, bytes, {
        contentType: archivo.type || "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      return NextResponse.json(errorResponse(`No se pudo subir el archivo: ${upErr.message}`), { status: 500 });
    }

    const { data, error } = await supabase
      .from("documentos")
      .insert({
        empresa_id: auth.empresa_id,
        nombre,
        descripcion,
        categoria,
        archivo_path: path,
        archivo_nombre: archivo.name,
        mime_type: archivo.type || null,
        tamano_bytes: archivo.size,
        fecha_vencimiento: fechaVencimiento,
        dias_aviso_previo: diasAviso,
        subido_por: auth.usuarioCatalogId ?? null,
      })
      .select(COLS)
      .single();

    if (error) {
      // Rollback del archivo: si no se pudo guardar la fila, no dejar huérfano.
      await supabase.storage.from(DOCUMENTOS_BUCKET).remove([path]);
      return NextResponse.json(errorResponse(error.message), { status: 500 });
    }

    return NextResponse.json(successResponse({ documento: data }), { status: 201 });
  } catch (err) {
    console.error("[/api/documentos POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo guardar el documento."), { status: 500 });
  }
}
