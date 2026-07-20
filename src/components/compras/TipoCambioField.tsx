"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, AlertTriangle, Check, Pencil } from "lucide-react";
import { fetchWithSupabaseSession } from "@/lib/api/fetch-with-supabase-session";

/** Snapshot que la pantalla debe guardar junto con la compra / orden. */
export interface CotizacionSnapshot {
  tipo_cambio: number;
  cotizacion_fuente: string | null;
  cotizacion_fecha: string | null;
  cotizacion_es_manual: boolean;
}

interface CotizacionApi {
  moneda_origen: string;
  moneda_destino: string;
  cotizacion: number;
  fecha_cotizacion: string;
  fuente: string;
  es_manual: boolean;
  es_fallback?: boolean;
}

function formatFechaHora(iso: string) {
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${d.getFullYear()} ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 " +
  "outline-none transition focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";

/**
 * Campo de tipo de cambio USD → PYG con cotización automática.
 *
 * Consulta `/api/tipo-cambio` al montar (y al pulsar "Actualizar"), muestra la
 * fuente y la fecha, y permite corregir el valor a mano. Una corrección manual
 * queda marcada como tal en el snapshot, para que después se pueda auditar
 * quién usó una cotización distinta a la del proveedor.
 *
 * Si no hay ninguna cotización disponible el campo queda vacío y en modo manual
 * con una advertencia visible: nunca se completa 1 en silencio para una compra
 * en moneda extranjera, porque eso registraría costos en PYG que son en verdad
 * dólares.
 */
export default function TipoCambioField({
  value,
  onChange,
  disabled,
}: {
  value: CotizacionSnapshot;
  onChange: (v: CotizacionSnapshot) => void;
  disabled?: boolean;
}) {
  const [cargando, setCargando] = useState(false);
  const [auto, setAuto] = useState<CotizacionApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState(false);
  // `onChange` suele venir como lambda inline: si entrara en las deps, el
  // efecto de carga inicial se dispararía en cada render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const consultar = useCallback(async (aplicar: boolean) => {
    setCargando(true);
    setError(null);
    try {
      const r = await fetchWithSupabaseSession("/api/tipo-cambio?origen=USD&destino=PYG", { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { success?: boolean; data?: CotizacionApi; error?: string };
      if (!r.ok || !j.success || !j.data) {
        setAuto(null);
        setError(j.error ?? "No hay cotización disponible. Cargala a mano.");
        setEditando(true);
        return;
      }
      setAuto(j.data);
      if (aplicar) {
        onChangeRef.current({
          tipo_cambio: j.data.cotizacion,
          cotizacion_fuente: j.data.fuente,
          cotizacion_fecha: j.data.fecha_cotizacion,
          cotizacion_es_manual: false,
        });
        setEditando(false);
      }
    } catch {
      setAuto(null);
      setError("No se pudo consultar la cotización. Cargala a mano.");
      setEditando(true);
    } finally {
      setCargando(false);
    }
  }, []);

  // Carga inicial: solo aplica el valor si el usuario todavía no puso nada.
  useEffect(() => {
    void consultar(value.tipo_cambio <= 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consultar]);

  const editarManual = (n: number) => {
    onChange({
      tipo_cambio: n,
      // Se conserva la fuente automática como referencia de contra qué se
      // corrigió, pero la marca de manual es la que manda en la auditoría.
      cotizacion_fuente: auto ? `manual (sobre ${auto.fuente})` : "manual",
      cotizacion_fecha: new Date().toISOString(),
      cotizacion_es_manual: true,
    });
  };

  const sinCotizacion = value.tipo_cambio <= 0;

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">
        Tipo de cambio (USD → Gs.) <span className="text-red-500">*</span>
      </label>

      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          step="any"
          value={value.tipo_cambio > 0 ? value.tipo_cambio : ""}
          disabled={disabled || (!editando && !sinCotizacion)}
          onChange={(e) => editarManual(Number(e.target.value) || 0)}
          placeholder="Ej: 7500"
          className={`${inputClass} ${!editando && !sinCotizacion ? "bg-slate-50 text-slate-600" : ""}`}
        />
        {!editando && !sinCotizacion ? (
          <button
            type="button"
            onClick={() => setEditando(true)}
            disabled={disabled}
            title="Corregir a mano"
            className="shrink-0 rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50"
          >
            <Pencil className="h-4 w-4" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void consultar(true)}
          disabled={disabled || cargando}
          title="Volver a consultar la cotización"
          className="shrink-0 rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${cargando ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Estado de la cotización, siempre visible: de dónde salió el número. */}
      <div className="mt-1.5 text-xs">
        {cargando ? (
          <span className="text-slate-400">Consultando cotización…</span>
        ) : error && sinCotizacion ? (
          <span className="inline-flex items-start gap-1 text-amber-600">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            {error}
          </span>
        ) : value.cotizacion_es_manual ? (
          <span className="inline-flex items-center gap-1 text-amber-600">
            <Pencil className="h-3.5 w-3.5" />
            Cotización cargada a mano{auto ? ` · automática: ${auto.cotizacion.toLocaleString("es-PY")}` : ""}
          </span>
        ) : auto ? (
          <span className="inline-flex items-center gap-1 text-emerald-600">
            <Check className="h-3.5 w-3.5" />
            {auto.fuente}
            {auto.es_fallback ? " (última disponible)" : ""} · {formatFechaHora(auto.fecha_cotizacion)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
