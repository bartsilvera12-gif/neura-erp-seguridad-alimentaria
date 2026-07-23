"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Upload, Download, Trash2, Loader2, AlertTriangle } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

/** Archivo ya subido al bucket, todavía sin registrar contra una orden. */
export interface AdjuntoPendiente {
  archivo_path: string;
  archivo_nombre: string;
  nombre: string;
  mime_type: string | null;
  tamano_bytes: number;
}

interface AdjuntoGuardado {
  id: string;
  nombre: string;
  archivo_nombre: string;
  mime_type: string | null;
  tamano_bytes: number | null;
  created_at: string;
}

const MAX_BYTES = 25 * 1024 * 1024;

function formatTamano(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Documentación de una orden de compra: proforma, packing list, confirmación
 * del proveedor, despacho.
 *
 * Funciona en DOS momentos, porque la orden se arma antes de existir:
 *
 *  - `numeroOc = null` (orden nueva): el archivo se sube al bucket igual —eso
 *    no necesita que la orden exista— y queda "pendiente" en memoria. El padre
 *    lo recibe por `onPendientesChange` y los registra al guardar la orden.
 *  - `numeroOc` con valor (orden ya creada): sube y registra al instante.
 *
 * La subida va del navegador DIRECTO al Storage con signed URL: no pasa por la
 * función serverless, que limita el body a ~4,5 MB. Se usa PUT nativo y no
 * supabase-js porque `uploadToSignedUrl` manda el header `x-upsert`, que el
 * CORS del Storage self-hosted no permite.
 */
export default function AdjuntosOrdenCompra({
  numeroOc,
  onPendientesChange,
}: {
  numeroOc: string | null;
  onPendientesChange?: (docs: AdjuntoPendiente[]) => void;
}) {
  const [guardados, setGuardados] = useState<AdjuntoGuardado[]>([]);
  const [pendientes, setPendientes] = useState<AdjuntoPendiente[]>([]);
  const [cargando, setCargando] = useState(Boolean(numeroOc));
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [borrandoId, setBorrandoId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // `onPendientesChange` suele venir inline: en las deps del efecto dispararía
  // en cada render del padre.
  const onPendRef = useRef(onPendientesChange);
  onPendRef.current = onPendientesChange;

  const cargar = useCallback(async () => {
    if (!numeroOc) {
      setCargando(false);
      return;
    }
    try {
      const r = await fetchWithSupabaseSession(
        `/api/ordenes-compra/${encodeURIComponent(numeroOc)}/documentos`,
        { cache: "no-store" }
      );
      const j = (await r.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { documentos?: AdjuntoGuardado[] };
      };
      setGuardados(j?.success ? j.data?.documentos ?? [] : []);
    } catch {
      setGuardados([]);
    } finally {
      setCargando(false);
    }
  }, [numeroOc]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  useEffect(() => {
    onPendRef.current?.(pendientes);
  }, [pendientes]);

  async function handleArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    // Se limpia enseguida para que subir el mismo archivo dos veces seguidas
    // vuelva a disparar el onChange.
    if (inputRef.current) inputRef.current.value = "";
    if (!archivo) return;

    if (archivo.size > MAX_BYTES) {
      setError(`El archivo supera los 25 MB (pesa ${formatTamano(archivo.size)}).`);
      return;
    }

    setSubiendo(true);
    setError(null);
    try {
      // 1) URL firmada.
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

      // 2) PUT nativo al Storage.
      const up = await fetch(jUrl.data.uploadUrl, {
        method: "PUT",
        body: archivo,
        headers: { "Content-Type": archivo.type || "application/octet-stream" },
      });
      if (!up.ok) throw new Error(`No se pudo subir el archivo (${up.status}).`);

      const doc: AdjuntoPendiente = {
        archivo_path: jUrl.data.path,
        archivo_nombre: archivo.name,
        nombre: archivo.name,
        mime_type: archivo.type || null,
        tamano_bytes: archivo.size,
      };

      // 3) Si la orden ya existe, se registra ahora. Si no, queda pendiente y
      //    lo registra el padre al guardar.
      if (numeroOc) {
        const rReg = await fetchWithSupabaseSession(
          `/api/ordenes-compra/${encodeURIComponent(numeroOc)}/documentos`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ documentos: [doc] }),
          }
        );
        const jReg = (await rReg.json().catch(() => ({}))) as { success?: boolean; error?: string };
        if (!rReg.ok || !jReg.success) throw new Error(jReg.error ?? "No se pudo adjuntar.");
        await cargar();
      } else {
        setPendientes((prev) => [...prev, doc]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo subir el archivo.");
    } finally {
      setSubiendo(false);
    }
  }

  async function handleAbrir(docId: string) {
    if (!numeroOc) return;
    try {
      const r = await fetchWithSupabaseSession(
        `/api/ordenes-compra/${encodeURIComponent(numeroOc)}/documentos/${docId}`,
        { cache: "no-store" }
      );
      const j = (await r.json().catch(() => ({}))) as { success?: boolean; data?: { url?: string }; error?: string };
      if (!r.ok || !j.success || !j.data?.url) throw new Error(j.error ?? "No se pudo abrir.");
      window.open(j.data.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo abrir el documento.");
    }
  }

  async function handleBorrarGuardado(docId: string, nombre: string) {
    if (!numeroOc) return;
    if (!window.confirm(`¿Eliminar "${nombre}"?`)) return;
    setBorrandoId(docId);
    try {
      const r = await fetchWithSupabaseSession(
        `/api/ordenes-compra/${encodeURIComponent(numeroOc)}/documentos/${docId}`,
        { method: "DELETE" }
      );
      const j = (await r.json().catch(() => ({}))) as { success?: boolean; error?: string };
      if (!r.ok || !j.success) throw new Error(j.error ?? "No se pudo eliminar.");
      setGuardados((prev) => prev.filter((d) => d.id !== docId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar.");
    } finally {
      setBorrandoId(null);
    }
  }

  const vacio = guardados.length === 0 && pendientes.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={subiendo}
          className="inline-flex items-center gap-2 rounded-lg bg-[#4FAEB2] px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#3F8E91] disabled:opacity-50"
        >
          {subiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {subiendo ? "Subiendo…" : "Adjuntar documento"}
        </button>
        <span className="text-xs text-slate-400">
          Proforma, packing list, confirmación del proveedor. Hasta 25 MB.
        </span>
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
      ) : vacio ? (
        <p className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-400">
          Sin documentos adjuntos.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
          {guardados.map((d) => (
            <li key={d.id} className="flex items-center gap-3 bg-white px-3 py-2.5 hover:bg-slate-50/60">
              <FileText className="h-4 w-4 shrink-0 text-[#4FAEB2]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-700">{d.nombre}</p>
                <p className="text-xs text-slate-400">{formatTamano(d.tamano_bytes)}</p>
              </div>
              <button type="button" onClick={() => handleAbrir(d.id)} title="Ver / descargar"
                className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-[#3F8E91]">
                <Download className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => handleBorrarGuardado(d.id, d.nombre)} disabled={borrandoId === d.id}
                title="Eliminar"
                className="shrink-0 rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50">
                {borrandoId === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </button>
            </li>
          ))}

          {/* Subidos pero todavía no asociados: se guardan con la orden. */}
          {pendientes.map((d) => (
            <li key={d.archivo_path} className="flex items-center gap-3 bg-amber-50/40 px-3 py-2.5">
              <FileText className="h-4 w-4 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-700">{d.nombre}</p>
                <p className="text-xs text-amber-600">
                  {formatTamano(d.tamano_bytes)} · se guarda al crear la orden
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPendientes((prev) => prev.filter((x) => x.archivo_path !== d.archivo_path))}
                title="Quitar"
                className="shrink-0 rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
