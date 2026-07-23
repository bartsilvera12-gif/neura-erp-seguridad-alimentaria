import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { documentoPathEsDeEmpresa } from "@/lib/documentos/storage";

const DOC_COLS =
  "id, numero_oc, nombre, archivo_path, archivo_nombre, mime_type, tamano_bytes, created_at";

/** GET /api/ordenes-compra/[numero]/documentos — adjuntos de la orden. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ numero: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { numero } = await params;

    const { data, error } = await ctx.supabase
      .from("ordenes_compra_documentos")
      .select(DOC_COLS)
      .eq("empresa_id", ctx.auth.empresa_id)
      .eq("numero_oc", decodeURIComponent(numero))
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    return NextResponse.json(successResponse({ documentos: data ?? [] }));
  } catch (err) {
    console.error("[/api/ordenes-compra/[numero]/documentos GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cargar la documentación."), { status: 500 });
  }
}

/**
 * POST /api/ordenes-compra/[numero]/documentos
 *
 * Registra archivos YA subidos al bucket (el navegador los sube directo con la
 * signed URL de `/api/documentos/upload-url`). Acepta uno o varios de una vez:
 * al crear la orden se registran en lote los que se fueron adjuntando mientras
 * se armaba el pedido.
 *
 * Body: { documentos: [{ archivo_path, archivo_nombre, nombre?, mime_type?, tamano_bytes? }] }
 *       (también acepta un único documento suelto en la raíz)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ numero: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { numero } = await params;
    const numeroOc = decodeURIComponent(numero);
    const empresaId = ctx.auth.empresa_id;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const lista = Array.isArray(body.documentos)
      ? (body.documentos as Record<string, unknown>[])
      : [body];

    const filas: Record<string, unknown>[] = [];
    for (const d of lista) {
      const archivoPath = typeof d.archivo_path === "string" ? d.archivo_path.trim() : "";
      const archivoNombre = typeof d.archivo_nombre === "string" ? d.archivo_nombre.trim() : "";
      if (!archivoPath || !archivoNombre) continue;
      // El path lo propone el cliente: sin esta validación se podría registrar
      // (y después leer) un archivo de otra empresa.
      if (!documentoPathEsDeEmpresa(archivoPath, empresaId)) {
        return NextResponse.json(errorResponse("Archivo inválido."), { status: 400 });
      }
      filas.push({
        empresa_id: empresaId,
        numero_oc: numeroOc,
        nombre:
          typeof d.nombre === "string" && d.nombre.trim()
            ? d.nombre.trim().slice(0, 200)
            : archivoNombre.slice(0, 200),
        archivo_path: archivoPath,
        archivo_nombre: archivoNombre.slice(0, 300),
        mime_type: typeof d.mime_type === "string" ? d.mime_type.slice(0, 150) : null,
        tamano_bytes: Number(d.tamano_bytes) || null,
        subido_por: ctx.auth.usuarioCatalogId ?? null,
      });
    }

    if (filas.length === 0) {
      return NextResponse.json(errorResponse("No hay archivos para adjuntar."), { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from("ordenes_compra_documentos")
      .insert(filas)
      .select(DOC_COLS);

    if (error) {
      if (/duplicate key|unique/i.test(error.message)) {
        return NextResponse.json(errorResponse("Ese archivo ya está adjunto."), { status: 409 });
      }
      throw new Error(error.message);
    }

    return NextResponse.json(successResponse({ documentos: data ?? [] }), { status: 201 });
  } catch (err) {
    console.error("[/api/ordenes-compra/[numero]/documentos POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo adjuntar la documentación."), { status: 500 });
  }
}
