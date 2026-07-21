"use client";

import { useEffect, useState } from "react";
import {
  ShoppingCart,
  Receipt,
  Boxes,
  Layers,
  TrendingUp,
  Coins,
  Percent,
  Package,
} from "lucide-react";
import PageHeader from "@/components/ui/PageHeader";
import ExportExcelButton from "@/components/ui/ExportExcelButton";
import MesSelector from "@/components/reportes/MesSelector";
import { getVentasReporte } from "@/lib/reportes/storage";
import { mesActualAsuncion } from "@/lib/fechas/asuncion-bounds";
import type { VentasReporte, TipoPrecioReporte } from "@/lib/reportes/types";

function formatGs(v: number) {
  return `Gs. ${Math.round(v).toLocaleString("es-PY")}`;
}
function formatGsCompact(v: number) {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `Gs. ${(v / 1_000_000).toLocaleString("es-PY", { maximumFractionDigits: 1 })} M`;
  if (abs >= 1_000) return `Gs. ${(v / 1_000).toLocaleString("es-PY", { maximumFractionDigits: 0 })} k`;
  return formatGs(v);
}
function formatFecha(iso: string) {
  try {
    const d = new Date(iso);
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  } catch {
    return iso;
  }
}
function formatFechaHora(iso: string | null) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

const TP: { key: TipoPrecioReporte; label: string; dot: string; badge: string }[] = [
  { key: "minorista", label: "Minorista", dot: "bg-slate-400", badge: "bg-slate-100 text-slate-600" },
  { key: "mayorista", label: "Mayorista", dot: "bg-indigo-400", badge: "bg-indigo-100 text-indigo-700" },
  { key: "distribuidor", label: "Distribuidor", dot: "bg-emerald-400", badge: "bg-emerald-100 text-emerald-700" },
  { key: "costo", label: "Al costo", dot: "bg-amber-400", badge: "bg-amber-100 text-amber-700" },
];

type FiltroAnuladas = "todas" | "solo_activas" | "solo_anuladas";

/** Nivel de margen → color. Un margen sano se lee de un vistazo. */
function tonoMargen(m: number): { text: string; bg: string; bar: string } {
  if (m < 0) return { text: "text-rose-600", bg: "bg-rose-50 text-rose-700 ring-rose-200", bar: "bg-rose-400" };
  if (m < 12) return { text: "text-amber-600", bg: "bg-amber-50 text-amber-700 ring-amber-200", bar: "bg-amber-400" };
  if (m < 25) return { text: "text-[#3F8E91]", bg: "bg-[#4FAEB2]/10 text-[#3F8E91] ring-[#4FAEB2]/30", bar: "bg-[#4FAEB2]" };
  return { text: "text-emerald-600", bg: "bg-emerald-50 text-emerald-700 ring-emerald-200", bar: "bg-emerald-500" };
}

/** Tarjeta métrica compacta con ícono. Local a este reporte (más control visual). */
function Metric({
  icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="group rounded-xl border border-slate-200 bg-white p-4 shadow-sm ring-1 ring-[#4FAEB2]/10 transition-shadow hover:shadow-md">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#4FAEB2]/10 text-[#4FAEB2]">
          {icon}
        </span>
        <p className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</p>
      </div>
      <p className={`mt-2.5 text-xl font-bold tracking-tight tabular-nums ${accent ? "text-[#3F8E91]" : "text-slate-900"}`}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}

function SkeletonReporte() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="h-3 w-2/3 animate-pulse rounded bg-slate-100" />
            <div className="mt-3 h-6 w-1/2 animate-pulse rounded bg-slate-100" />
          </div>
        ))}
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="h-4 w-40 animate-pulse rounded bg-slate-100" />
        <div className="mt-6 h-3 w-full animate-pulse rounded-full bg-slate-100" />
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function VentasReportePage() {
  const [mes, setMes] = useState(mesActualAsuncion());
  const [data, setData] = useState<VentasReporte | null>(null);
  const [cargando, setCargando] = useState(true);
  const [filtroAnuladas, setFiltroAnuladas] = useState<FiltroAnuladas>("todas");

  useEffect(() => {
    let cancel = false;
    setCargando(true);
    getVentasReporte(mes).then((d) => {
      if (!cancel) {
        setData(d);
        setCargando(false);
      }
    });
    return () => {
      cancel = true;
    };
  }, [mes]);

  const rent = data?.rentabilidad;
  // Composición del esfuerzo comercial: de lo generado, qué parte es ganancia y
  // qué parte costo. Base = ganancia + costos (no usa "ingresos con IVA" para no
  // mezclar el IVA, que no es ni ganancia ni costo).
  const compBase = rent ? Math.max(0, rent.gananciaBruta) + rent.costoVendido + rent.costoSinCargo : 0;
  const pct = (v: number) => (compBase > 0 ? (Math.max(0, v) / compBase) * 100 : 0);
  const margenMax = rent
    ? Math.max(1, ...rent.porProducto.map((p) => (p.margen > 0 ? p.margen : 0)))
    : 1;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Zentra · Reportes"
        title="Ventas"
        description="Facturación y operaciones comerciales del período"
        backHref="/reportes"
        backLabel="Reportes"
        actions={
          <div className="flex items-center gap-3">
            <MesSelector mes={mes} onChange={setMes} />
            <ExportExcelButton url={`/api/reportes/ventas/export?mes=${mes}`} />
          </div>
        }
      />

      {cargando ? (
        <SkeletonReporte />
      ) : !data || !rent ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-500 shadow-sm">
          No se pudo cargar el reporte de ventas.
        </div>
      ) : (
        <>
          {/* ── KPIs de cabecera ──────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Metric icon={<ShoppingCart className="h-4 w-4" />} label="Total vendido" value={formatGs(data.totalVendido)} accent hint={`${data.cantidadVentas} ${data.cantidadVentas === 1 ? "venta" : "ventas"}`} />
            <Metric icon={<Receipt className="h-4 w-4" />} label="Ticket promedio" value={formatGs(data.ticketPromedio)} hint="por venta" />
            <Metric icon={<Boxes className="h-4 w-4" />} label="Unidades" value={data.unidadesVendidas.toLocaleString("es-PY")} hint="vendidas" />
            <Metric icon={<Layers className="h-4 w-4" />} label="Ítems / líneas" value={data.cantidadItems.toLocaleString("es-PY")} />
            <Metric icon={<Package className="h-4 w-4" />} label="Productos" value={data.porProducto.length.toLocaleString("es-PY")} hint="distintos" />
          </div>

          {/* ── Rentabilidad ──────────────────────────────────────────────── */}
          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 bg-gradient-to-r from-[#4FAEB2]/[0.06] to-transparent px-6 py-5">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-[#4FAEB2]" />
                <h2 className="text-base font-semibold tracking-tight text-slate-800">Rentabilidad</h2>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Costos congelados al momento de cada venta. Las muestras y regalos restan su costo sin aportar ingreso.
              </p>
            </div>

            <div className="p-6">
              {/* Bloque hero: ganancia + margen, y la barra de composición */}
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_1.4fr] lg:items-center">
                <div className="rounded-xl bg-gradient-to-br from-[#4FAEB2]/10 to-[#4FAEB2]/[0.03] p-5 ring-1 ring-[#4FAEB2]/15">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#3F8E91]/70">Ganancia bruta</p>
                  <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums text-[#3F8E91]">
                    {formatGs(rent.gananciaBruta)}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${tonoMargen(rent.margenBruto).bg}`}>
                      <Percent className="h-3 w-3" />
                      {rent.margenBruto.toFixed(1)}% de margen
                    </span>
                  </div>
                </div>

                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                    Composición de lo generado
                  </p>
                  {compBase > 0 ? (
                    <>
                      <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <div className="bg-[#4FAEB2] transition-[width] duration-500" style={{ width: `${pct(rent.gananciaBruta)}%` }} title="Ganancia" />
                        <div className="bg-slate-300 transition-[width] duration-500" style={{ width: `${pct(rent.costoVendido)}%` }} title="Costo vendido" />
                        <div className="bg-amber-300 transition-[width] duration-500" style={{ width: `${pct(rent.costoSinCargo)}%` }} title="Costo sin cargo" />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
                        <Leyenda dot="bg-[#4FAEB2]" label="Ganancia" value={formatGs(rent.gananciaBruta)} />
                        <Leyenda dot="bg-slate-300" label="Costo vendido" value={formatGs(rent.costoVendido)} />
                        {rent.costoSinCargo > 0 && (
                          <Leyenda dot="bg-amber-300" label="Costo sin cargo" value={formatGs(rent.costoSinCargo)} />
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-slate-400">Sin datos de rentabilidad en el período.</p>
                  )}
                </div>
              </div>

              {/* Sub-métricas */}
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Metric icon={<ShoppingCart className="h-4 w-4" />} label="Ingresos" value={formatGs(rent.ingresos)} hint="facturado, con IVA" />
                <Metric icon={<Package className="h-4 w-4" />} label="Costo vendido" value={formatGs(rent.costoVendido)} hint="mercadería facturada" />
                <Metric icon={<Coins className="h-4 w-4" />} label="Costo sin cargo" value={formatGs(rent.costoSinCargo)} hint="muestras y regalos" />
              </div>

              {/* Rentabilidad por producto con barras de margen */}
              {rent.porProducto.length > 0 && (
                <div className="mt-8">
                  <h3 className="mb-3 text-sm font-semibold text-slate-700">Rentabilidad por producto</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-sm">
                      <thead>
                        <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-400">
                          <th className="pb-2 font-medium">Producto</th>
                          <th className="pb-2 text-right font-medium">Cant.</th>
                          <th className="pb-2 text-right font-medium">Ingresos</th>
                          <th className="pb-2 text-right font-medium">Costo</th>
                          <th className="pb-2 text-right font-medium">Ganancia</th>
                          <th className="pb-2 pl-4 font-medium">Margen</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {rent.porProducto.map((r) => {
                          const tono = tonoMargen(r.margen);
                          const ancho = r.margen > 0 ? Math.min(100, (r.margen / margenMax) * 100) : 0;
                          return (
                            <tr key={r.producto_nombre} className="transition-colors hover:bg-slate-50/70">
                              <td className="py-2.5 pr-3 font-medium text-slate-700">{r.producto_nombre}</td>
                              <td className="py-2.5 text-right tabular-nums text-slate-500">{r.cantidad.toLocaleString("es-PY")}</td>
                              <td className="py-2.5 pl-3 text-right tabular-nums text-slate-500">{formatGsCompact(r.ingresos)}</td>
                              <td className="py-2.5 pl-3 text-right tabular-nums text-slate-500">{formatGsCompact(r.costo)}</td>
                              <td className={`py-2.5 pl-3 text-right tabular-nums font-semibold ${r.ganancia < 0 ? "text-rose-600" : "text-slate-800"}`}>
                                {formatGsCompact(r.ganancia)}
                              </td>
                              <td className="py-2.5 pl-4">
                                <div className="flex items-center gap-2">
                                  <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-slate-100">
                                    <div className={`h-full rounded-full ${tono.bar}`} style={{ width: `${ancho}%` }} />
                                  </div>
                                  <span className={`w-14 shrink-0 text-right text-xs font-semibold tabular-nums ${tono.text}`}>
                                    {r.margen.toFixed(1)}%
                                  </span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ── Por tipo de precio ────────────────────────────────────────── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-base font-semibold tracking-tight text-slate-800">Por tipo de precio</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {TP.map(({ key, label, dot, badge }) => (
                <div key={key} className="rounded-xl border border-slate-200 p-4 transition-shadow hover:shadow-sm">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                    {label}
                  </span>
                  <p className="mt-2 text-lg font-bold tabular-nums tracking-tight text-slate-800">{formatGs(data.porTipoPrecio[key].total)}</p>
                  <p className="text-xs text-slate-400">
                    {data.porTipoPrecio[key].items} {data.porTipoPrecio[key].items === 1 ? "ítem" : "ítems"}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* ── Detalle de ventas ─────────────────────────────────────────── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold tracking-tight text-slate-800">Ventas del mes</h2>
              <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs font-medium">
                {(
                  [
                    { key: "todas", label: "Todas" },
                    { key: "solo_activas", label: "Solo activas" },
                    { key: "solo_anuladas", label: "Solo anuladas" },
                  ] as { key: FiltroAnuladas; label: string }[]
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setFiltroAnuladas(opt.key)}
                    className={`rounded-md px-3 py-1.5 transition-colors ${
                      filtroAnuladas === opt.key
                        ? "bg-white text-slate-800 shadow-sm ring-1 ring-slate-200"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            {(() => {
              const ventasFiltradas = data.ventas.filter((v) => {
                if (filtroAnuladas === "solo_activas") return v.estado !== "anulada";
                if (filtroAnuladas === "solo_anuladas") return v.estado === "anulada";
                return true;
              });
              if (data.ventas.length === 0) {
                return <p className="py-4 text-center text-sm text-slate-400">No hay ventas en el período.</p>;
              }
              if (ventasFiltradas.length === 0) {
                return (
                  <p className="py-4 text-center text-sm text-slate-400">
                    {filtroAnuladas === "solo_anuladas"
                      ? "No hay ventas anuladas en el período."
                      : "No hay ventas activas en el período."}
                  </p>
                );
              }
              return (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-400">
                        <th className="py-2.5 pr-4 font-medium">Fecha</th>
                        <th className="py-2.5 pr-4 font-medium">N° Venta</th>
                        <th className="py-2.5 pr-4 font-medium">Cliente</th>
                        <th className="py-2.5 pr-4 font-medium">Pago</th>
                        <th className="py-2.5 pr-4 text-right font-medium">Ítems</th>
                        <th className="py-2.5 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ventasFiltradas.map((v) => {
                        const anulada = v.estado === "anulada";
                        return (
                          <tr key={v.id} className={`border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50/70 ${anulada ? "text-slate-400" : ""}`}>
                            <td className="py-3 pr-4 text-xs tabular-nums">{formatFecha(v.fecha)}</td>
                            <td className={`py-3 pr-4 font-mono text-xs ${anulada ? "line-through" : "text-slate-500"}`}>{v.numero_control}</td>
                            <td className="py-3 pr-4">
                              <div className="flex items-center gap-2">
                                <span className={anulada ? "line-through" : "text-slate-700"}>{v.cliente ?? "—"}</span>
                                {anulada && (
                                  <span className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-700 ring-1 ring-rose-200">
                                    Anulada
                                  </span>
                                )}
                              </div>
                              {anulada && (
                                <div className="mt-1 text-[11px] leading-snug text-rose-700/80">
                                  {v.productos_resumen && (
                                    <div><span className="font-semibold">Productos:</span> {v.productos_resumen}</div>
                                  )}
                                  {v.anulacion_motivo && (
                                    <div><span className="font-semibold">Motivo:</span> {v.anulacion_motivo}</div>
                                  )}
                                  <div className="text-slate-500">
                                    {v.anulada_at ? formatFechaHora(v.anulada_at) : "—"}
                                    {v.anulada_por_email ? ` · ${v.anulada_por_email}` : ""}
                                  </div>
                                </div>
                              )}
                            </td>
                            <td className="py-3 pr-4 capitalize">{v.metodo_pago ?? "—"}</td>
                            <td className="py-3 pr-4 text-right tabular-nums">{v.items_count}</td>
                            <td className={`py-3 text-right font-semibold tabular-nums ${anulada ? "line-through" : "text-slate-800"}`}>{formatGs(v.total)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </section>

          {/* ── Total por producto ────────────────────────────────────────── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-base font-semibold tracking-tight text-slate-800">Total por producto</h2>
            {data.porProducto.length === 0 ? (
              <p className="py-4 text-center text-sm text-slate-400">Sin datos.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-400">
                      <th className="py-2.5 pr-4 font-medium">Producto</th>
                      <th className="py-2.5 pr-4 text-right font-medium">Cantidad</th>
                      <th className="py-2.5 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.porProducto.map((p, i) => (
                      <tr key={i} className="border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50/70">
                        <td className="py-2.5 pr-4 font-medium text-slate-700">{p.producto_nombre}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums text-slate-500">{p.cantidad}</td>
                        <td className="py-2.5 text-right font-semibold tabular-nums text-slate-800">{formatGs(p.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Leyenda({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-sm ${dot}`} />
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold tabular-nums text-slate-700">{value}</span>
    </span>
  );
}
