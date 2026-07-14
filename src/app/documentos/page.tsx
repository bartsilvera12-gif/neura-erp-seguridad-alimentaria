"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Trash2, Upload, Download, Pencil, X } from "lucide-react";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { hoyAsuncionYmd } from "@/lib/fecha/asuncion";

interface Documento {
  id: string;
  nombre: string;
  descripcion: string | null;
  categoria: string | null;
  archivo_nombre: string;
  mime_type: string | null;
  tamano_bytes: number | null;
  fecha_vencimiento: string | null;
  dias_aviso_previo: number;
  archivado: boolean;
  created_at: string;
}

/** Días entre hoy (Asunción) y la fecha. Negativo = ya venció. */
function diasHasta(fecha: string): number {
  const hoy = new Date(`${hoyAsuncionYmd()}T00:00:00Z`).getTime();
  const v = new Date(`${fecha}T00:00:00Z`).getTime();
  return Math.round((v - hoy) / 86_400_000);
}

function formatTamano(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Estado de vencimiento: define el badge de la fila. */
function estadoVencimiento(d: Documento): {
  label: string;
  clase: string;
} {
  if (!d.fecha_vencimiento) return { label: "Sin vencimiento", clase: "bg-slate-100 text-slate-600" };
  const dias = diasHasta(d.fecha_vencimiento);
  if (dias < 0) {
    const n = Math.abs(dias);
    return { label: `Vencido hace ${n} día${n === 1 ? "" : "s"}`, clase: "bg-red-50 text-red-700" };
  }
  if (dias === 0) return { label: "Vence hoy", clase: "bg-red-50 text-red-700" };
  if (dias <= d.dias_aviso_previo) {
    return { label: `Vence en ${dias} día${dias === 1 ? "" : "s"}`, clase: "bg-amber-50 text-amber-700" };
  }
  return { label: `Vence en ${dias} días`, clase: "bg-emerald-50 text-emerald-700" };
}

const inputClass =
  "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-[#4FAEB2]";
const labelClass = "block text-sm font-medium text-slate-700 mb-1.5";

export default function DocumentosPage() {
  const [docs, setDocs] = useState<Documento[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [editando, setEditando] = useState<Documento | null>(null);

  // Formulario de alta
  const [archivo, setArchivo] = useState<File | null>(null);
  const [nombre, setNombre] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [categoria, setCategoria] = useState("");
  const [vencimiento, setVencimiento] = useState("");
  const [diasAviso, setDiasAviso] = useState("30");

  const cargar = useCallback(async () => {
    try {
      const res = await fetchWithSupabaseSession("/api/documentos", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "No se pudieron cargar los documentos.");
      setDocs((j.data?.documentos ?? []) as Documento[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al cargar");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function limpiarForm() {
    setArchivo(null);
    setNombre("");
    setDescripcion("");
    setCategoria("");
    setVencimiento("");
    setDiasAviso("30");
  }

  async function handleSubir(e: React.FormEvent) {
    e.preventDefault();
    if (!archivo || subiendo) return;
    setSubiendo(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("archivo", archivo);
      fd.append("nombre", nombre.trim() || archivo.name);
      fd.append("descripcion", descripcion);
      fd.append("categoria", categoria);
      fd.append("fecha_vencimiento", vencimiento);
      fd.append("dias_aviso_previo", diasAviso);

      const res = await fetchWithSupabaseSession("/api/documentos", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "No se pudo subir el documento.");

      limpiarForm();
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al subir");
    } finally {
      setSubiendo(false);
    }
  }

  async function handleDescargar(d: Documento) {
    try {
      const res = await fetchWithSupabaseSession(`/api/documentos/${d.id}/archivo`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j?.success || !j.data?.url) throw new Error(j?.error ?? "No se pudo abrir el archivo.");
      window.open(j.data.url as string, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al abrir el archivo");
    }
  }

  async function handleEliminar(d: Documento) {
    if (!confirm(`¿Eliminar "${d.nombre}"? El archivo se borra definitivamente.`)) return;
    try {
      const res = await fetchWithSupabaseSession(`/api/documentos/${d.id}`, { method: "DELETE" });
      const j = await res.json();
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "No se pudo eliminar.");
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al eliminar");
    }
  }

  async function handleGuardarEdicion(e: React.FormEvent) {
    e.preventDefault();
    if (!editando) return;
    try {
      const res = await fetchWithSupabaseSession(`/api/documentos/${editando.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: editando.nombre,
          descripcion: editando.descripcion ?? "",
          categoria: editando.categoria ?? "",
          fecha_vencimiento: editando.fecha_vencimiento ?? "",
          dias_aviso_previo: editando.dias_aviso_previo,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "No se pudo guardar.");
      setEditando(null);
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]"
            style={{ boxShadow: "0 0 0 3px rgba(79, 174, 178, 0.18)" }}
          />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">
            Zentra · Operaciones
          </p>
        </div>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Documentos</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Archivos con fecha de vencimiento y aviso previo en la campanita
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Alta de documento */}
      <form onSubmit={handleSubir} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="mb-4 text-sm font-semibold text-slate-900">Subir documento</p>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <label className={labelClass} htmlFor="archivo">Archivo</label>
            <input
              id="archivo"
              type="file"
              required
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setArchivo(f);
                if (f && !nombre.trim()) setNombre(f.name.replace(/\.[^.]+$/, ""));
              }}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-[#4FAEB2] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
            />
            <p className="mt-1 text-xs text-slate-400">Cualquier tipo de archivo, hasta 25 MB.</p>
          </div>

          <div>
            <label className={labelClass} htmlFor="nombre">Nombre</label>
            <input
              id="nombre"
              className={inputClass}
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="Ej: Habilitación municipal"
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="categoria">Categoría</label>
            <input
              id="categoria"
              className={inputClass}
              value={categoria}
              onChange={(e) => setCategoria(e.target.value)}
              placeholder="Ej: Certificados"
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="vencimiento">Fecha de vencimiento</label>
            <input
              id="vencimiento"
              type="date"
              className={inputClass}
              value={vencimiento}
              onChange={(e) => setVencimiento(e.target.value)}
            />
            <p className="mt-1 text-xs text-slate-400">Opcional: dejalo vacío si no vence.</p>
          </div>

          <div>
            <label className={labelClass} htmlFor="dias">Avisar días antes</label>
            <input
              id="dias"
              type="number"
              min={0}
              max={365}
              className={inputClass}
              value={diasAviso}
              onChange={(e) => setDiasAviso(e.target.value)}
              disabled={!vencimiento}
            />
            <p className="mt-1 text-xs text-slate-400">
              La campanita avisa desde {diasAviso || "0"} días antes del vencimiento.
            </p>
          </div>

          <div className="md:col-span-2 lg:col-span-3">
            <label className={labelClass} htmlFor="descripcion">Descripción</label>
            <textarea
              id="descripcion"
              rows={2}
              className={inputClass}
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={!archivo || subiendo}
            className="inline-flex items-center gap-2 rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#3F8E91] disabled:opacity-50"
          >
            <Upload className="h-4 w-4" />
            {subiendo ? "Subiendo…" : "Subir documento"}
          </button>
        </div>
      </form>

      {/* Listado */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <EdgeScrollArea>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3 font-semibold">Documento</th>
                <th className="px-4 py-3 font-semibold">Categoría</th>
                <th className="px-4 py-3 font-semibold">Vencimiento</th>
                <th className="px-4 py-3 font-semibold">Aviso</th>
                <th className="px-4 py-3 font-semibold">Tamaño</th>
                <th className="px-4 py-3 font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cargando ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">Cargando…</td>
                </tr>
              ) : docs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">
                    <FileText className="mx-auto mb-2 h-6 w-6 text-slate-300" />
                    Todavía no hay documentos cargados.
                  </td>
                </tr>
              ) : (
                docs.map((d) => {
                  const estado = estadoVencimiento(d);
                  return (
                    <tr key={d.id} className="transition-colors hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900">{d.nombre}</p>
                        <p className="text-xs text-slate-400">{d.archivo_nombre}</p>
                        {d.descripcion && (
                          <p className="mt-0.5 text-xs text-slate-500">{d.descripcion}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{d.categoria ?? "—"}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${estado.clase}`}>
                          {estado.label}
                        </span>
                        {d.fecha_vencimiento && (
                          <p className="mt-0.5 text-xs text-slate-400">{d.fecha_vencimiento}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {d.fecha_vencimiento ? `${d.dias_aviso_previo} días antes` : "—"}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{formatTamano(d.tamano_bytes)}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => handleDescargar(d)}
                            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-[#3F8E91]"
                            title="Ver / descargar"
                          >
                            <Download className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditando(d)}
                            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-[#3F8E91]"
                            title="Editar"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleEliminar(d)}
                            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600"
                            title="Eliminar"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </EdgeScrollArea>
      </div>

      {/* Modal de edición */}
      {editando && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <form
            onSubmit={handleGuardarEdicion}
            className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-2xl"
          >
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-900">Editar documento</p>
              <button
                type="button"
                onClick={() => setEditando(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className={labelClass}>Nombre</label>
                <input
                  className={inputClass}
                  value={editando.nombre}
                  onChange={(e) => setEditando({ ...editando, nombre: e.target.value })}
                />
              </div>
              <div>
                <label className={labelClass}>Categoría</label>
                <input
                  className={inputClass}
                  value={editando.categoria ?? ""}
                  onChange={(e) => setEditando({ ...editando, categoria: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Fecha de vencimiento</label>
                  <input
                    type="date"
                    className={inputClass}
                    value={editando.fecha_vencimiento ?? ""}
                    onChange={(e) => setEditando({ ...editando, fecha_vencimiento: e.target.value || null })}
                  />
                </div>
                <div>
                  <label className={labelClass}>Avisar días antes</label>
                  <input
                    type="number"
                    min={0}
                    max={365}
                    className={inputClass}
                    value={editando.dias_aviso_previo}
                    onChange={(e) =>
                      setEditando({ ...editando, dias_aviso_previo: parseInt(e.target.value, 10) || 0 })
                    }
                    disabled={!editando.fecha_vencimiento}
                  />
                </div>
              </div>
              <div>
                <label className={labelClass}>Descripción</label>
                <textarea
                  rows={2}
                  className={inputClass}
                  value={editando.descripcion ?? ""}
                  onChange={(e) => setEditando({ ...editando, descripcion: e.target.value })}
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditando(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white hover:bg-[#3F8E91]"
              >
                Guardar
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
