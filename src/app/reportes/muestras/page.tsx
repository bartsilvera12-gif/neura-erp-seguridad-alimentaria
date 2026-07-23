"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PageHeader from "@/components/ui/PageHeader";
import StatCard from "@/components/ui/StatCard";
import { Gift, FlaskConical, RotateCcw } from "lucide-react";
import { getMuestrasReporte } from "@/lib/reportes/storage";
import type { MuestrasReporte, MuestraAgrupado } from "@/lib/reportes/types";

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
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
/** YYYY-MM-DD de hoy y del primer día del mes, en Asunción. */
function hoyYmd() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Asuncion" });
}
function inicioMesYmd() {
  return `${hoyYmd().slice(0, 7)}-01`;
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 " +
  "outline-none transition focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";

const TIPO_META = {
  muestra: { label: "Muestra", badge: "bg-sky-100 text-sky-700", Icon: FlaskConical },
  regalo: { label: "Regalo", badge: "bg-violet-100 text-violet-700", Icon: Gift },
} as const;

/** Tabla compacta de un corte (por producto / cliente / usuario). */
function TablaCorte({
  titulo,
  filas,
  etiquetaClave,
  vacio,
}: {
  titulo: string;
  filas: MuestraAgrupado[];
  etiquetaClave: string;
  vacio: string;
}) {
  const top = filas.slice(0, 10);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="mb-4 text-base font-semibold text-slate-800">{titulo}</h2>
      {top.length === 0 ? (
        <p className="text-sm text-slate-400">{vacio}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="pb-2 font-medium">{etiquetaClave}</th>
                <th className="pb-2 text-right font-medium">Unidades</th>
                <th className="pb-2 text-right font-medium">Costo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {top.map((r) => (
                <tr key={r.clave}>
                  <td className="py-2 pr-3 text-slate-700">{r.clave}</td>
                  <td className="py-2 text-right tabular-nums text-slate-700">
                    {r.cantidad.toLocaleString("es-PY")}
                  </td>
                  <td className="py-2 text-right tabular-nums text-slate-700">{formatGs(r.costo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filas.length > top.length && (
            <p className="mt-3 text-xs text-slate-400">
              Mostrando los 10 primeros de {filas.length}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function MuestrasReportePage() {
  const [desde, setDesde] = useState(inicioMesYmd);
  const [hasta, setHasta] = useState(hoyYmd);
  const [tipo, setTipo] = useState("");
  const [producto, setProducto] = useState("");
  const [cliente, setCliente] = useState("");
  const [usuario, setUsuario] = useState("");
  const [data, setData] = useState<MuestrasReporte | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let cancel = false;
    setCargando(true);
    getMuestrasReporte({ desde, hasta, tipo, producto, cliente, usuario }).then((d) => {
      if (!cancel) {
        setData(d);
        setCargando(false);
      }
    });
    return () => {
      cancel = true;
    };
  }, [desde, hasta, tipo, producto, cliente, usuario]);

  const limpiar = useCallback(() => {
    setDesde(inicioMesYmd());
    setHasta(hoyYmd());
    setTipo("");
    setProducto("");
    setCliente("");
    setUsuario("");
  }, []);

  const hayFiltros = useMemo(
    () => Boolean(tipo || producto || cliente || usuario),
    [tipo, producto, cliente, usuario]
  );

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Zentra · Reportes"
        title="Muestras y regalos"
        description="Productos entregados sin cargo y su impacto real en la ganancia"
        backHref="/reportes"
        backLabel="Reportes"
      />

      {/* ── Filtros ─────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Desde</label>
            <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Hasta</label>
            <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Tipo</label>
            <select value={tipo} onChange={(e) => setTipo(e.target.value)} className={inputClass}>
              <option value="">Todos</option>
              <option value="muestra">Muestra</option>
              <option value="regalo">Regalo</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Producto</label>
            <select value={producto} onChange={(e) => setProducto(e.target.value)} className={inputClass}>
              <option value="">Todos</option>
              {(data?.opciones.productos ?? []).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Cliente</label>
            <select value={cliente} onChange={(e) => setCliente(e.target.value)} className={inputClass}>
              <option value="">Todos</option>
              {(data?.opciones.clientes ?? []).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Responsable</label>
            <select value={usuario} onChange={(e) => setUsuario(e.target.value)} className={inputClass}>
              <option value="">Todos</option>
              {(data?.opciones.usuarios ?? []).map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
        </div>
        {hayFiltros && (
          <button
            type="button"
            onClick={limpiar}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Limpiar filtros
          </button>
        )}
      </div>

      {cargando ? (
        <p className="animate-pulse text-slate-500">Cargando…</p>
      ) : !data ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-slate-500 shadow-sm">
          No se pudo cargar el reporte de muestras y regalos.
        </div>
      ) : data.lineasTotal === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center shadow-sm">
          <Gift className="mx-auto h-10 w-10 text-slate-300" />
          <p className="mt-3 font-medium text-slate-600">No hay entregas sin cargo en el período</p>
          <p className="mt-1 text-sm text-slate-400">
            Las muestras y regalos se cargan desde Caja, eligiendo el tipo de salida en la línea.
          </p>
        </div>
      ) : (
        <>
          {/* ── Totales ─────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard compact label="Unidades entregadas" value={data.unidadesTotal.toLocaleString("es-PY")} hint={`${data.lineasTotal} ${data.lineasTotal === 1 ? "entrega" : "entregas"}`} />
            <StatCard compact label="Costo entregado" value={formatGs(data.costoTotal)} accent hint="impacto real en la ganancia" />
            <StatCard compact label="Valor comercial" value={formatGs(data.valorComercialTotal)} hint="lo que habría facturado" />
            <StatCard compact label="Impacto en ganancia" value={`− ${formatGs(data.costoTotal)}`} hint="ingreso cero, costo real" />
          </div>

          {/* ── Muestra vs regalo ───────────────────────────────────────── */}
          <div className="grid gap-3 sm:grid-cols-2">
            {(["muestra", "regalo"] as const).map((t) => {
              const meta = TIPO_META[t];
              const d = data.porTipo[t];
              return (
                <div key={t} className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.badge}`}>
                      <meta.Icon className="h-3.5 w-3.5" />
                      {meta.label}
                    </span>
                  </div>
                  <p className="mt-3 text-2xl font-bold tabular-nums text-slate-800">
                    {d.cantidad.toLocaleString("es-PY")}
                    <span className="ml-1.5 text-sm font-normal text-slate-400">unidades</span>
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    Costo {formatGs(d.costo)} · Valor comercial {formatGs(d.valorComercial)}
                  </p>
                </div>
              );
            })}
          </div>

          {/* ── Cortes ──────────────────────────────────────────────────── */}
          <div className="grid gap-4 lg:grid-cols-3">
            <TablaCorte titulo="Productos más entregados" filas={data.porProducto} etiquetaClave="Producto" vacio="Sin datos." />
            <TablaCorte titulo="Clientes que más recibieron" filas={data.porCliente} etiquetaClave="Cliente" vacio="Sin datos." />
            <TablaCorte titulo="Por responsable" filas={data.porUsuario} etiquetaClave="Usuario" vacio="Sin datos." />
          </div>

          {/* ── Detalle ─────────────────────────────────────────────────── */}
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-base font-semibold text-slate-800">
              Detalle por operación
              <span className="ml-2 text-sm font-normal text-slate-400">{data.detalle.length}</span>
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="pb-2 font-medium">Fecha</th>
                    <th className="pb-2 font-medium">N°</th>
                    <th className="pb-2 font-medium">Tipo</th>
                    <th className="pb-2 font-medium">Producto</th>
                    <th className="pb-2 font-medium">Cliente</th>
                    <th className="pb-2 font-medium">Responsable</th>
                    <th className="pb-2 font-medium">Motivo</th>
                    <th className="pb-2 text-right font-medium">Cant.</th>
                    <th className="pb-2 text-right font-medium">Costo unit.</th>
                    <th className="pb-2 text-right font-medium">Costo total</th>
                    <th className="pb-2 text-right font-medium">Valor comercial</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.detalle.map((r, i) => {
                    const meta = TIPO_META[r.tipo_salida];
                    return (
                      <tr key={`${r.venta_id}-${r.producto_id ?? i}-${i}`} className="hover:bg-slate-50/60">
                        <td className="py-2 pr-3 whitespace-nowrap text-slate-500">{formatFechaHora(r.fecha)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap font-medium text-slate-700">{r.numero_control ?? "—"}</td>
                        <td className="py-2 pr-3">
                          <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.badge}`}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-slate-700">{r.producto_nombre}</td>
                        <td className="py-2 pr-3 text-slate-600">{r.cliente ?? "—"}</td>
                        <td className="py-2 pr-3 text-slate-600">{r.usuario ?? "—"}</td>
                        <td className="py-2 pr-3 max-w-[220px] truncate text-slate-500" title={r.motivo ?? ""}>
                          {r.motivo ?? "—"}
                        </td>
                        <td className="py-2 text-right tabular-nums text-slate-700">{r.cantidad.toLocaleString("es-PY")}</td>
                        <td className="py-2 pl-3 text-right tabular-nums text-slate-600">{formatGs(r.costo_unitario)}</td>
                        <td className="py-2 pl-3 text-right tabular-nums font-medium text-slate-800">{formatGs(r.costo_total)}</td>
                        <td className="py-2 pl-3 text-right tabular-nums text-slate-400">{formatGs(r.valor_comercial)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-slate-400">
              Los costos son el valor congelado al momento de la entrega, no el costo actual del producto.
              El valor comercial usa el precio de lista de hoy y es solo una referencia: no es un ingreso.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
