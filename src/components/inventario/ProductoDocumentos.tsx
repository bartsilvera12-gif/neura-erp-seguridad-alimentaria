"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Upload, Download, Trash2, Loader2, AlertTriangle } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

export interface ProductoDocumento {
  id: string;
  nombre: string;
  archivo_nombre: string;
  mime_type: string | null;
  tamano_bytes: number | null;
  created_at: string;
}

const MAX_BYTES = 25 * 1024 * 1024; // mismo límite que el módulo Documentos

function formatTamano(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatFecha(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  } catch {
    return "";
  }
}

/**
 * Documentación adjunta de un producto (fichas técnicas, certificados, planos).
 *
 * Acepta cualquier tipo de archivo, igual que el módulo Documentos: una ficha
 * técnica puede venir en PDF, Word, Excel o una foto del papel.
 *
 * La subida va del navegador DIRECTO al Storage con una signed URL. No pasa por
 * la función serverless porque ahí el body está limitado a ~4,5 MB. Y se usa
 * `fetch` con PUT nativo en vez de supabase-js: `uploadToSignedUrl` manda el
 * header `x-upsert`, que el CORS del Storage self-hosted no permite, y el
 * preflight falla con un "Failed to fetch" que no dice nada.
 *
 * Requiere que el producto ya exista (necesita su id), así que en el alta se
 * muestra deshabilitado hasta guardar.
 */
export default function ProductoDocumentos({ productoId }: { productoId: string | null }) {
  const [docs, setDocs] = useState<ProductoDocumento[]>([]);
  const [cargando, setCargando] = useState(true);
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [borrandoId, setBorrandoId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cargar = useCallback(async () => {
    if (!productoId) {
      setCargando(false);
      return;
    }
    try {
      const r = await fetchWithSupabaseSession(`/api/productos/${productoId}/documentos`, { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { documentos?: ProductoDocumento[] };
      };
      setDocs(j?.success ? j.data?.documentos ?? [] : []);
    } catch {
      setDocs([]);
    } finally {
      setCargando(false);
    }
  }, [productoId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function handleArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    // Se limpia el input enseguida para que subir el MISMO archivo dos veces
    // seguidas vuelva a disparar el onChange.
    if (inputRef.current) inputRef.current.value = "";
    if (!archivo || !productoId) return;

    if (archivo.size > MAX_BYTES) {
      setError(`El archivo supera los 25 MB (pesa ${formatTamano(archivo.size)}).`);
      return;
    }

    setSubiendo(true);
    setError(null);
    try {
      // 1) Pedir la URL firmada de subida.
      const rUrl = await fetchWithSupabaseSession("/api/documentos/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archivo_nombre: archivo.name, tamano_bytes: archivo.size }),
      });
      const jUrl = (await rUrl.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { path?: string; uploadUrl?: string };
        error?: string;
      };
      if (!rUrl.ok || !jUrl.success || !jUrl.data?.uploadUrl || !jUrl.data?.path) {
        throw new Error(jUrl.error ?? "No se pudo preparar la subida.");
      }

      // 2) PUT nativo al Storage. Ver el comentario del encabezado.
      const up = await fetch(jUrl.data.uploadUrl, {
        method: "PUT",
        body: archivo,
        headers: { "Content-Type": archivo.type || "application/octet-stream" },
      });
      if (!up.ok) throw new Error(`No se pudo subir el archivo (${up.status}).`);

      // 3) Registrarlo contra el producto.
      const rReg = await fetchWithSupabaseSession(`/api/productos/${productoId}/documentos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          archivo_path: jUrl.data.path,
          archivo_nombre: archivo.name,
          nombre: archivo.name,
          mime_type: archivo.type || null,
          tamano_bytes: archivo.size,
        }),
      });
      const jReg = (await rReg.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!rReg.ok || !jReg.success) throw new Error(jReg.error ?? "No se pudo adjuntar el documento.");

      await cargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo subir el archivo.");
    } finally {
      setSubiendo(false);
    }
  }

  async function handleAbrir(docId: string) {
    if (!productoId) return;
    try {
      const r = await fetchWithSupabaseSession(`/api/productos/${productoId}/documentos/${docId}`, { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { success?: boolean; data?: { url?: string }; error?: string };
      if (!r.ok || !j.success || !j.data?.url) throw new Error(j.error ?? "No se pudo abrir el documento.");
      window.open(j.data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo abrir el documento.");
    }
  }

  async function handleBorrar(docId: string, nombre: string) {
    if (!productoId) return;
    if (!window.confirm(`¿Eliminar "${nombre}"? No se puede deshacer.`)) return;
    setBorrandoId(docId);
    setError(null);
    try {
      const r = await fetchWithSupabaseSession(`/api/productos/${productoId}/documentos/${docId}`, { method: "DELETE" });
      const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!r.ok || !j.success) throw new Error(j.error ?? "No se pudo eliminar.");
      setDocs((prev) => prev.filter((d) => d.id !== docId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar el documento.");
    } finally {
      setBorrandoId(null);
    }
  }

  if (!productoId) {
    return (
      <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
        Guardá el producto para poder adjuntarle documentación.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={subiendo}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          {subiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {subiendo ? "Subiendo…" : "Adjuntar documento"}
        </button>
        <span className="text-xs text-slate-400">Cualquier tipo de archivo, hasta 25 MB.</span>
        <input ref={inputRef} type="file" onChange={handleArchivo} className="hidden" />
      </div>

      {error && (
        <p className="inline-flex items-start gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}

      {cargando ? (
        <p className="animate-pulse text-sm text-slate-400">Cargando documentación…</p>
      ) : docs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-400">
          Sin documentos adjuntos. Acá va la ficha técnica del producto.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-3 bg-white px-3 py-2.5 hover:bg-slate-50/60">
              <FileText className="h-4 w-4 shrink-0 text-[#4FAEB2]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-700" title={d.archivo_nombre}>
                  {d.nombre}
                </p>
                <p className="text-xs text-slate-400">
                  {formatFecha(d.created_at)}
                  {d.tamano_bytes ? ` · ${formatTamano(d.tamano_bytes)}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleAbrir(d.id)}
                title="Ver / descargar"
                className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-[#3F8E91]"
              >
                <Download className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => handleBorrar(d.id, d.nombre)}
                disabled={borrandoId === d.id}
                title="Eliminar"
                className="shrink-0 rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
              >
                {borrandoId === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
