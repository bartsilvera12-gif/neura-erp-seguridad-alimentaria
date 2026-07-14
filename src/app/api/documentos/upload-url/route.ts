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

/**
 * POST /api/documentos/upload-url
 *
 * Devuelve una URL firmada para que el NAVEGADOR suba el archivo directo a
 * Storage. Es la única forma de soportar archivos grandes: las serverless
 * functions tienen un límite de ~4,5 MB por request, así que un PDF de 15 MB
 * jamás llegaría al backend si lo mandáramos por multipart.
 *
 * El archivo se sube primero; recién después el cliente hace POST /api/documentos
 * con el `path` devuelto acá para crear la fila.
 *
 * Body: { archivo_nombre: string, tamano_bytes: number }
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const { supabase, auth } = ctx;

    const body = (await request.json()) as { archivo_nombre?: string; tamano_bytes?: number };
    const archivoNombre = String(body.archivo_nombre ?? "").trim();
    if (!archivoNombre) {
      return NextResponse.json(errorResponse("Falta el nombre del archivo."), { status: 400 });
    }

    const tamano = Number(body.tamano_bytes ?? 0);
    if (tamano > MAX_DOCUMENTO_BYTES) {
      return NextResponse.json(
        errorResponse(`El archivo supera el máximo de ${Math.round(MAX_DOCUMENTO_BYTES / 1024 / 1024)} MB.`),
        { status: 400 }
      );
    }

    await ensureDocumentosBucket(supabase);

    const path = buildDocumentoPath(auth.empresa_id, crypto.randomUUID(), archivoNombre);
    const { data, error } = await supabase.storage
      .from(DOCUMENTOS_BUCKET)
      .createSignedUploadUrl(path);

    if (error || !data?.token) {
      return NextResponse.json(
        errorResponse(`No se pudo preparar la subida: ${error?.message ?? "sin token"}`),
        { status: 500 }
      );
    }

    return NextResponse.json(
      successResponse({ path, token: data.token, bucket: DOCUMENTOS_BUCKET })
    );
  } catch (err) {
    console.error("[/api/documentos/upload-url]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudo preparar la subida."), { status: 500 });
  }
}
