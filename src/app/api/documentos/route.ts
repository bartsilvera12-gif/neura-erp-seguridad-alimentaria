import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { DOCUMENTOS_BUCKET, documentoPathEsDeEmpresa } from "@/lib/documentos/storage";

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
 * POST /api/documentos — crea el documento para un archivo YA subido a Storage.
 *
 * El archivo no pasa por acá: el navegador lo sube directo con la URL firmada
 * de /api/documentos/upload-url (las serverless functions cortan el body a
 * ~4,5 MB, así que un PDF de 15 MB nunca llegaría). Este endpoint solo guarda
 * los metadatos y el `path` que devolvió aquel.
 *
 * Body JSON: { archivo_path, archivo_nombre, mime_type, tamano_bytes, nombre,
 *              descripcion, categoria, fecha_vencimiento, dias_aviso_previo }
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { supabase, auth } = ctx;

    const body = (await request.json()) as Record<string, unknown>;

    const archivoPath = String(body.archivo_path ?? "").trim();
    const archivoNombre = String(body.archivo_nombre ?? "").trim();
    if (!archivoPath || !archivoNombre) {
      return NextResponse.json(errorResponse("Falta el archivo."), { status: 400 });
    }
    // El path lo emitió upload-url para ESTA empresa; si no coincide, alguien lo
    // manipuló para escribir metadatos sobre el archivo de otro tenant.
    if (!documentoPathEsDeEmpresa(archivoPath, auth.empresa_id)) {
      return NextResponse.json(errorResponse(API_ERRORS.FORBIDDEN), { status: 403 });
    }

    const nombre = String(body.nombre ?? "").trim() || archivoNombre;
    const descripcion = String(body.descripcion ?? "").trim() || null;
    const categoria = String(body.categoria ?? "").trim() || null;
    const mimeType = String(body.mime_type ?? "").trim() || null;

    const tamanoNum = Number(body.tamano_bytes ?? 0);
    const tamano = Number.isFinite(tamanoNum) && tamanoNum > 0 ? Math.round(tamanoNum) : null;

    const vencRaw = String(body.fecha_vencimiento ?? "").trim();
    const fechaVencimiento = /^\d{4}-\d{2}-\d{2}$/.test(vencRaw) ? vencRaw : null;

    const diasRaw = parseInt(String(body.dias_aviso_previo ?? ""), 10);
    const diasAviso = Number.isFinite(diasRaw) ? Math.min(365, Math.max(0, diasRaw)) : 30;

    const { data, error } = await supabase
      .from("documentos")
      .insert({
        empresa_id: auth.empresa_id,
        nombre,
        descripcion,
        categoria,
        archivo_path: archivoPath,
        archivo_nombre: archivoNombre,
        mime_type: mimeType,
        tamano_bytes: tamano,
        fecha_vencimiento: fechaVencimiento,
        dias_aviso_previo: diasAviso,
        subido_por: auth.usuarioCatalogId ?? null,
      })
      .select(COLS)
      .single();

    if (error) {
      // Si no se pudo guardar la fila, borrar el archivo: sin fila que lo
      // referencie quedaría huérfano en Storage para siempre.
      await supabase.storage.from(DOCUMENTOS_BUCKET).remove([archivoPath]);
      return NextResponse.json(errorResponse(error.message), { status: 500 });
    }

    return NextResponse.json(successResponse({ documento: data }), { status: 201 });
  } catch (err) {
    console.error("[/api/documentos POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo guardar el documento."), { status: 500 });
  }
}
