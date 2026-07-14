/**
 * Storage helpers para el módulo Documentos.
 *
 * Bucket: `seguridadalimentaria-documentos` (privado — los documentos pueden
 * ser certificados, habilitaciones o contratos).
 * Path:   `{empresa_id}/{uuid}.{ext}`
 *
 * Aislamiento por tenant: el primer segmento del path es `empresa_id` y los
 * endpoints validan el `empresa_id` del usuario antes de leer/escribir.
 *
 * A diferencia de otros módulos (comprobantes, imágenes de producto) acá se
 * acepta CUALQUIER tipo de archivo: el módulo es un repositorio general.
 */
import type { AppSupabaseClient } from "@/lib/supabase/schema";

export const DOCUMENTOS_BUCKET = "seguridadalimentaria-documentos";

export const MAX_DOCUMENTO_BYTES = 25 * 1024 * 1024; // 25 MB

let bucketEnsured = false;

/** Crea el bucket privado si no existe. Idempotente. */
export async function ensureDocumentosBucket(supabase: AppSupabaseClient): Promise<void> {
  if (bucketEnsured) return;
  try {
    const { data: existing } = await supabase.storage.getBucket(DOCUMENTOS_BUCKET);
    if (existing) {
      bucketEnsured = true;
      return;
    }
  } catch {
    // fallthrough — intentar crear
  }
  const { error } = await supabase.storage.createBucket(DOCUMENTOS_BUCKET, {
    public: false,
    fileSizeLimit: MAX_DOCUMENTO_BYTES,
  });
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(`No se pudo crear el bucket: ${error.message}`);
  }
  bucketEnsured = true;
}

/** Extensión del nombre original (sin punto). Vacía si no tiene. */
function extDe(nombreArchivo: string): string {
  const i = nombreArchivo.lastIndexOf(".");
  if (i < 0 || i === nombreArchivo.length - 1) return "";
  return nombreArchivo
    .slice(i + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);
}

/** Path nuevo para un documento de la empresa. `uuid` debe venir de crypto.randomUUID(). */
export function buildDocumentoPath(empresaId: string, uuid: string, nombreArchivo: string): string {
  const ext = extDe(nombreArchivo);
  return ext ? `${empresaId}/${uuid}.${ext}` : `${empresaId}/${uuid}`;
}

/** El path pertenece a la empresa (defensa ante paths manipulados). */
export function documentoPathEsDeEmpresa(path: string, empresaId: string): boolean {
  return path.startsWith(`${empresaId}/`);
}

/**
 * URL firmada para descargar/ver el documento. `null` si el path no pertenece
 * a la empresa o si Storage falla.
 */
export async function signDocumento(
  supabase: AppSupabaseClient,
  empresaId: string,
  path: string | null | undefined,
  expiresInSeconds = 300
): Promise<string | null> {
  const p = (path ?? "").trim();
  if (!p || !documentoPathEsDeEmpresa(p, empresaId)) return null;
  const { data, error } = await supabase.storage
    .from(DOCUMENTOS_BUCKET)
    .createSignedUrl(p, expiresInSeconds);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
