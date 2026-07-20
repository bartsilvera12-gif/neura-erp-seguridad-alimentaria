import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import { documentoPathEsDeEmpresa } from "@/lib/documentos/storage";

const DOC_COLS =
  "id, producto_id, nombre, archivo_path, archivo_nombre, mime_type, tamano_bytes, created_at";

/** Confirma que el producto existe y es de esta empresa. */
async function productoDeLaEmpresa(
  supabase: Awaited<ReturnType<typeof getTenantSupabaseFromAuth>>,
  empresaId: string,
  productoId: string
): Promise<boolean> {
  if (!supabase) return false;
  const { data } = await supabase.supabase
    .from("productos")
    .select("id")
    .eq("id", productoId)
    .eq("empresa_id", empresaId)
    .maybeSingle();
  return Boolean(data);
}

/**
 * GET /api/productos/[id]/documentos
 * Adjuntos del producto (fichas técnicas y demás documentación).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { id } = await params;
    const empresaId = ctx.auth.empresa_id;

    const { data, error } = await ctx.supabase
      .from("producto_documentos")
      .select(DOC_COLS)
      .eq("empresa_id", empresaId)
      .eq("producto_id", id)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    return NextResponse.json(successResponse({ documentos: data ?? [] }));
  } catch (err) {
    console.error("[/api/productos/[id]/documentos GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo cargar la documentación."), { status: 500 });
  }
}

/**
 * POST /api/productos/[id]/documentos
 *
 * Registra un archivo YA subido al bucket. El archivo viaja del navegador
 * directo al Storage con una signed URL (`/api/documentos/upload-url`), no por
 * acá: pasarlo por la función serverless lo limitaría a ~4,5 MB y una ficha
 * técnica con planos los supera fácil.
 *
 * Body: { archivo_path, archivo_nombre, nombre?, mime_type?, tamano_bytes? }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { id } = await params;
    const empresaId = ctx.auth.empresa_id;

    if (!(await productoDeLaEmpresa(ctx, empresaId, id))) {
      return NextResponse.json(errorResponse("Producto no encontrado."), { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const archivoPath = typeof body.archivo_path === "string" ? body.archivo_path.trim() : "";
    const archivoNombre = typeof body.archivo_nombre === "string" ? body.archivo_nombre.trim() : "";
    if (!archivoPath || !archivoNombre) {
      return NextResponse.json(errorResponse("Falta el archivo."), { status: 400 });
    }
    // El path lo propone el cliente: sin esta validación se podría registrar un
    // archivo de otra empresa y leerlo con la signed URL de este endpoint.
    if (!documentoPathEsDeEmpresa(archivoPath, empresaId)) {
      return NextResponse.json(errorResponse("Archivo inválido."), { status: 400 });
    }

    const nombre =
      typeof body.nombre === "string" && body.nombre.trim()
        ? body.nombre.trim().slice(0, 200)
        : archivoNombre.slice(0, 200);

    const { data, error } = await ctx.supabase
      .from("producto_documentos")
      .insert({
        empresa_id: empresaId,
        producto_id: id,
        nombre,
        archivo_path: archivoPath,
        archivo_nombre: archivoNombre.slice(0, 300),
        mime_type: typeof body.mime_type === "string" ? body.mime_type.slice(0, 150) : null,
        tamano_bytes: Number(body.tamano_bytes) || null,
        subido_por: ctx.auth.usuarioCatalogId ?? null,
      })
      .select(DOC_COLS)
      .single();

    if (error) {
      // Índice único por (empresa, path): el mismo archivo ya estaba registrado.
      if (/duplicate key|unique/i.test(error.message)) {
        return NextResponse.json(errorResponse("Ese archivo ya está adjunto."), { status: 409 });
      }
      throw new Error(error.message);
    }

    return NextResponse.json(successResponse({ documento: data }), { status: 201 });
  } catch (err) {
    console.error("[/api/productos/[id]/documentos POST]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo adjuntar el documento."), { status: 500 });
  }
}
