"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FileText,
  FileSpreadsheet,
  FileImage,
  File as FileIcon,
  Trash2,
  Upload,
  Download,
  Pencil,
  X,
  Plus,
  Search,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Infinity as InfinityIcon,
} from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";
import { hoyAsuncionYmd } from "@/lib/fecha/asuncion";
import { productoMatchesQuery } from "@/lib/productos/token-search";

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

/** Fecha legible: 2026-07-17 → 17 jul 2026. */
function formatFecha(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${d} ${meses[(m ?? 1) - 1]} ${y}`;
}

type Estado = "vencido" | "por_vencer" | "vigente" | "sin_vencimiento";

/** El estado manda: define el filtro, el badge y el color de toda la fila. */
function estadoDe(d: Documento): Estado {
  if (!d.fecha_vencimiento) return "sin_vencimiento";
  const dias = diasHasta(d.fecha_vencimiento);
  if (dias < 0) return "vencido";
  if (dias <= d.dias_aviso_previo) return "por_vencer";
  return "vigente";
}

function textoEstado(d: Documento): string {
  if (!d.fecha_vencimiento) return "Sin vencimiento";
  const dias = diasHasta(d.fecha_vencimiento);
  if (dias < 0) {
    const n = Math.abs(dias);
    return `Vencido hace ${n} día${n === 1 ? "" : "s"}`;
  }
  if (dias === 0) return "Vence hoy";
  return `Vence en ${dias} día${dias === 1 ? "" : "s"}`;
}

const ESTILO_ESTADO: Record<Estado, { badge: string; icono: string }> = {
  vencido: { badge: "bg-red-50 text-red-700 ring-1 ring-red-100", icono: "bg-red-50 text-red-600" },
  por_vencer: { badge: "bg-amber-50 text-amber-700 ring-1 ring-amber-100", icono: "bg-amber-50 text-amber-600" },
  vigente: { badge: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100", icono: "bg-emerald-50 text-emerald-600" },
  sin_vencimiento: { badge: "bg-slate-100 text-slate-500", icono: "bg-slate-100 text-slate-400" },
};

/** Ícono según el tipo de archivo: reconocer un PDF de un Excel de un ojo. */
function IconoArchivo({ mime, nombre }: { mime: string | null; nombre: string }) {
  const ext = nombre.split(".").pop()?.toLowerCase() ?? "";
  const m = mime ?? "";
  if (m.startsWith("image/")) return <FileImage className="h-4 w-4" />;
  if (m.includes("pdf") || ext === "pdf") return <FileText className="h-4 w-4" />;
  if (m.includes("sheet") || ["xlsx", "xls", "csv"].includes(ext)) {
    return <FileSpreadsheet className="h-4 w-4" />;
  }
  return <FileIcon className="h-4 w-4" />;
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition-shadow duration-150 placeholder:text-slate-400 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";
const labelClass = "mb-1.5 block text-sm font-medium text-slate-700";
const btnPrimario =
  "inline-flex items-center gap-2 rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-[transform,background-color] duration-150 ease-out hover:bg-[#3F8E91] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50";
const btnSecundario =
  "inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-[transform,background-color] duration-150 ease-out hover:bg-slate-50 active:scale-[0.97]";
const btnIcono =
  "rounded-lg p-2 text-slate-400 transition-[transform,color,background-color] duration-150 ease-out hover:bg-slate-100 hover:text-[#3F8E91] active:scale-[0.94]";

const FILTROS: { id: Estado | "todos"; label: string; icono: React.ReactNode }[] = [
  { id: "todos", label: "Todos", icono: <FileText className="h-4 w-4" /> },
  { id: "vencido", label: "Vencidos", icono: <AlertTriangle className="h-4 w-4" /> },
  { id: "por_vencer", label: "Por vencer", icono: <Clock className="h-4 w-4" /> },
  { id: "vigente", label: "Vigentes", icono: <CheckCircle2 className="h-4 w-4" /> },
  { id: "sin_vencimiento", label: "Sin vencimiento", icono: <InfinityIcon className="h-4 w-4" /> },
];

export default function DocumentosPage() {
  const [docs, setDocs] = useState<Documento[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [editando, setEditando] = useState<Documento | null>(null);
  const [modalAlta, setModalAlta] = useState(false);

  const [busqueda, setBusqueda] = useState("");
  const [filtro, setFiltro] = useState<Estado | "todos">("todos");

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

  const conteos = useMemo(() => {
    const c: Record<Estado | "todos", number> = {
      todos: docs.length,
      vencido: 0,
      por_vencer: 0,
      vigente: 0,
      sin_vencimiento: 0,
    };
    for (const d of docs) c[estadoDe(d)]++;
    return c;
  }, [docs]);

  const filtrados = useMemo(() => {
    return docs.filter((d) => {
      if (filtro !== "todos" && estadoDe(d) !== filtro) return false;
      // Búsqueda por tokens: cada palabra en cualquier orden.
      return productoMatchesQuery(busqueda, d.nombre, d.categoria, d.descripcion, d.archivo_nombre);
    });
  }, [docs, filtro, busqueda]);

  function limpiarForm() {
    setArchivo(null);
    setNombre("");
    setDescripcion("");
    setCategoria("");
    setVencimiento("");
    setDiasAviso("30");
  }

  /**
   * Subida en tres pasos: el servidor firma la URL, el navegador manda el
   * archivo DIRECTO a Storage con un PUT nativo, y recién ahí se crea la fila.
   * No se usa supabase-js para el PUT: manda `x-upsert`, header que el CORS del
   * Storage no permite, y el preflight falla con "Failed to fetch".
   */
  async function handleSubir(e: React.FormEvent) {
    e.preventDefault();
    if (!archivo || subiendo) return;
    setSubiendo(true);
    setError(null);
    try {
      const resUrl = await fetchWithSupabaseSession("/api/documentos/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archivo_nombre: archivo.name, tamano_bytes: archivo.size }),
      });
      const jUrl = await resUrl.json();
      if (!resUrl.ok || !jUrl?.success) throw new Error(jUrl?.error ?? "No se pudo preparar la subida.");
      const { path, uploadUrl } = jUrl.data as { path: string; uploadUrl: string };

      const up = await fetch(uploadUrl, {
        method: "PUT",
        body: archivo,
        headers: { "Content-Type": archivo.type || "application/octet-stream" },
      });
      if (!up.ok) throw new Error(`No se pudo subir el archivo (${up.status}).`);

      const res = await fetchWithSupabaseSession("/api/documentos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          archivo_path: path,
          archivo_nombre: archivo.name,
          mime_type: archivo.type || null,
          tamano_bytes: archivo.size,
          nombre: nombre.trim() || archivo.name,
          descripcion,
          categoria,
          fecha_vencimiento: vencimiento,
          dias_aviso_previo: diasAviso,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "No se pudo guardar el documento.");

      limpiarForm();
      setModalAlta(false);
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

  const hayDocs = docs.length > 0;
  const hayFiltro = busqueda.trim() !== "" || filtro !== "todos";

  return (
    <div className="space-y-6">
      {/* Encabezado */}
      <div className="flex flex-wrap items-end justify-between gap-3">
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

        <button type="button" onClick={() => { limpiarForm(); setError(null); setModalAlta(true); }} className={btnPrimario}>
          <Plus className="h-4 w-4" />
          Nuevo documento
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Resumen: además de informar, filtra. Un vencido en rojo se ve de lejos. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {FILTROS.map((f) => {
          const activo = filtro === f.id;
          const n = conteos[f.id];
          const urgente = (f.id === "vencido" || f.id === "por_vencer") && n > 0;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => setFiltro(f.id)}
              aria-pressed={activo}
              className={`rounded-xl border bg-white p-3.5 text-left shadow-sm transition-[transform,border-color,box-shadow] duration-150 ease-out active:scale-[0.98] ${
                activo
                  ? "border-[#4FAEB2] ring-2 ring-[#4FAEB2]/20"
                  : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  {f.label}
                </p>
                <span
                  className={
                    urgente
                      ? f.id === "vencido"
                        ? "text-red-500"
                        : "text-amber-500"
                      : activo
                        ? "text-[#4FAEB2]"
                        : "text-slate-300"
                  }
                >
                  {f.icono}
                </span>
              </div>
              <p
                className={`mt-1 text-2xl font-bold tracking-tight ${
                  urgente ? (f.id === "vencido" ? "text-red-600" : "text-amber-600") : "text-slate-900"
                }`}
              >
                {n}
              </p>
            </button>
          );
        })}
      </div>

      {/* Buscador */}
      {hayDocs && (
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre, categoría o descripción…"
            className={`${inputClass} pl-9`}
          />
        </div>
      )}

      {/* Listado */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {cargando ? (
          <div className="divide-y divide-slate-100">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-4">
                <div className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-slate-100" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-1/3 animate-pulse rounded bg-slate-100" />
                  <div className="h-2.5 w-1/5 animate-pulse rounded bg-slate-50" />
                </div>
                <div className="h-6 w-24 animate-pulse rounded-full bg-slate-100" />
              </div>
            ))}
          </div>
        ) : filtrados.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[#4FAEB2]/10">
              {hayFiltro ? (
                <Search className="h-5 w-5 text-[#4FAEB2]" />
              ) : (
                <FileText className="h-5 w-5 text-[#4FAEB2]" />
              )}
            </div>
            {hayFiltro ? (
              <>
                <p className="text-sm font-semibold text-slate-900">Sin resultados</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                  Ningún documento coincide con la búsqueda o el filtro elegido.
                </p>
                <button
                  type="button"
                  onClick={() => { setBusqueda(""); setFiltro("todos"); }}
                  className={`mt-4 ${btnSecundario}`}
                >
                  Limpiar filtros
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-900">Todavía no hay documentos</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                  Subí certificados, habilitaciones o contratos. Poneles fecha de vencimiento y la
                  campanita te avisa antes de que caduquen.
                </p>
                <button
                  type="button"
                  onClick={() => { limpiarForm(); setModalAlta(true); }}
                  className={`mt-4 ${btnPrimario}`}
                >
                  <Plus className="h-4 w-4" />
                  Subir el primero
                </button>
              </>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {filtrados.map((d, i) => {
              const estado = estadoDe(d);
              const estilo = ESTILO_ESTADO[estado];
              return (
                <li
                  key={d.id}
                  className="zentra-row-in group flex items-center gap-4 px-5 py-4 transition-colors duration-150 hover:bg-slate-50/70"
                  // Stagger corto: cascada natural, sin hacer sentir lenta la carga.
                  style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${estilo.icono}`}>
                    <IconoArchivo mime={d.mime_type} nombre={d.archivo_nombre} />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="truncate text-sm font-semibold text-slate-900">{d.nombre}</p>
                      {d.categoria && (
                        <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                          {d.categoria}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-400">
                      {d.archivo_nombre} · {formatTamano(d.tamano_bytes)}
                      {d.descripcion ? ` · ${d.descripcion}` : ""}
                    </p>
                  </div>

                  <div className="hidden shrink-0 text-right sm:block">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${estilo.badge}`}>
                      {textoEstado(d)}
                    </span>
                    <p className="mt-1 text-[11px] text-slate-400">
                      {d.fecha_vencimiento
                        ? `${formatFecha(d.fecha_vencimiento)} · avisa ${d.dias_aviso_previo} días antes`
                        : "No caduca"}
                    </p>
                  </div>

                  {/* Acciones: discretas hasta el hover, siempre visibles en touch. */}
                  <div className="flex shrink-0 gap-0.5 opacity-100 transition-opacity duration-150 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                    <button type="button" onClick={() => handleDescargar(d)} className={btnIcono} title="Ver o descargar">
                      <Download className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => setEditando(d)} className={btnIcono} title="Editar">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEliminar(d)}
                      className={`${btnIcono} hover:bg-red-50 hover:text-red-600`}
                      title="Eliminar"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Modal de alta */}
      {modalAlta && (
        <div className="zentra-overlay-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 py-10 backdrop-blur-[2px]">
          <form onSubmit={handleSubir} className="zentra-modal-in w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900">Nuevo documento</p>
                <p className="mt-0.5 text-xs text-slate-500">Cualquier tipo de archivo, hasta 25 MB.</p>
              </div>
              <button type="button" onClick={() => setModalAlta(false)} className={btnIcono}>
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
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
                  className="w-full cursor-pointer rounded-lg border border-dashed border-slate-300 bg-slate-50/50 px-3 py-3 text-sm transition-colors duration-150 hover:border-[#4FAEB2] file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-[#4FAEB2] file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
                />
              </div>

              <div>
                <label className={labelClass} htmlFor="nombre">Nombre</label>
                <input id="nombre" className={inputClass} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej: Habilitación municipal" />
              </div>

              <div>
                <label className={labelClass} htmlFor="categoria">Categoría</label>
                <input id="categoria" className={inputClass} value={categoria} onChange={(e) => setCategoria(e.target.value)} placeholder="Ej: Certificados" />
              </div>

              <div>
                <label className={labelClass} htmlFor="vencimiento">Fecha de vencimiento</label>
                <input id="vencimiento" type="date" className={inputClass} value={vencimiento} onChange={(e) => setVencimiento(e.target.value)} />
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
                  {vencimiento
                    ? `La campanita avisa desde ${diasAviso || "0"} días antes.`
                    : "Se habilita al poner una fecha."}
                </p>
              </div>

              <div className="md:col-span-2">
                <label className={labelClass} htmlFor="descripcion">Descripción</label>
                <textarea id="descripcion" rows={2} className={inputClass} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setModalAlta(false)} className={btnSecundario}>
                Cancelar
              </button>
              <button type="submit" disabled={!archivo || subiendo} className={btnPrimario}>
                <Upload className="h-4 w-4" />
                {subiendo ? "Subiendo…" : "Subir documento"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal de edición */}
      {editando && (
        <div className="zentra-overlay-in fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-[2px]">
          <form onSubmit={handleGuardarEdicion} className="zentra-modal-in w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-900">Editar documento</p>
              <button type="button" onClick={() => setEditando(null)} className={btnIcono}>
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className={labelClass}>Nombre</label>
                <input className={inputClass} value={editando.nombre} onChange={(e) => setEditando({ ...editando, nombre: e.target.value })} />
              </div>
              <div>
                <label className={labelClass}>Categoría</label>
                <input className={inputClass} value={editando.categoria ?? ""} onChange={(e) => setEditando({ ...editando, categoria: e.target.value })} />
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
                    onChange={(e) => setEditando({ ...editando, dias_aviso_previo: parseInt(e.target.value, 10) || 0 })}
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
              <button type="button" onClick={() => setEditando(null)} className={btnSecundario}>
                Cancelar
              </button>
              <button type="submit" className={btnPrimario}>Guardar</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
