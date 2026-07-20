"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getCompras } from "@/lib/compras/storage";
import ExportExcelButton from "@/components/ui/ExportExcelButton";
import EdgeScrollArea from "@/components/ui/EdgeScrollArea";
import { FancySelect } from "@/components/ui/FancySelect";
import MobileFab from "@/components/ui/MobileFab";
import AnularCompraModal from "./AnularCompraModal";
import RegistrarRecepcionModal from "./RegistrarRecepcionModal";
import type { Compra, TipoPago } from "@/lib/compras/types";

const inputFilterClass =
  "border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:outline-none bg-white";

function formatGs(valor: number) {
  return `Gs. ${Math.round(valor).toLocaleString("es-PY")}`;
}

function formatFecha(iso: string) {
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  } catch {
    return iso;
  }
}

const tipoPagoBadge: Record<TipoPago, string> = {
  contado: "bg-blue-50 text-blue-700",
  credito: "bg-orange-50 text-orange-700",
};

const metodoPagoBadge: Record<string, { label: string; className: string }> = {
  efectivo: { label: "Efectivo", className: "bg-emerald-50 text-emerald-700" },
  transferencia: { label: "Transferencia", className: "bg-indigo-50 text-indigo-700" },
  tarjeta: { label: "Tarjeta", className: "bg-amber-50 text-amber-800" },
};

function formatFechaDate(fecha: string | null | undefined): string {
  if (!fecha) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return fecha;
}

// ── Agrupación por numero_control: 1 compra = N filas ─────────────────────────
type GrupoCompra = {
  numero_control: string;
  proveedor_nombre: string;
  fecha: string;
  fecha_factura: string | null;
  metodo_pago: string | null;
  tipo_pago: TipoPago;
  plazo_dias?: number;
  items: Compra[];
  total: number;
  comprobante: boolean;
  anulada: boolean;
  /** Recepción agregada de la orden (todas sus líneas). */
  estado_recepcion: EstadoRecepcion;
  unidades_pedidas: number;
  unidades_recibidas: number;
  productos_pendientes: number;
  fecha_estimada: string | null;
  fecha_ultima_recepcion: string | null;
};

export type EstadoRecepcion = "pendiente" | "parcial" | "completa" | "cancelada";

export const RECEPCION_META: Record<EstadoRecepcion, { label: string; badge: string }> = {
  pendiente: { label: "Pendiente", badge: "bg-slate-100 text-slate-600" },
  parcial: { label: "Parcial", badge: "bg-amber-50 text-amber-700 ring-1 ring-amber-100" },
  completa: { label: "Completa", badge: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100" },
  cancelada: { label: "Cancelada", badge: "bg-red-50 text-red-700 ring-1 ring-red-100" },
};

/** Estado de la ORDEN a partir del de sus líneas. */
function estadoOrdenDesdeLineas(items: Compra[]): EstadoRecepcion {
  if (items.length === 0) return "pendiente";
  const est = items.map((i) => (i.estado_recepcion ?? "pendiente") as EstadoRecepcion);
  if (est.every((e) => e === "cancelada")) return "cancelada";
  if (est.every((e) => e === "completa")) return "completa";
  if (est.some((e) => e === "parcial" || e === "completa")) return "parcial";
  return "pendiente";
}

function agrupar(rows: Compra[]): GrupoCompra[] {
  const map = new Map<string, GrupoCompra>();
  for (const c of rows) {
    const key = c.numero_control || c.id;
    let g = map.get(key);
    if (!g) {
      g = {
        numero_control: c.numero_control,
        proveedor_nombre: c.proveedor_nombre,
        fecha: c.fecha,
        fecha_factura: c.fecha_factura ?? null,
        metodo_pago: c.metodo_pago ?? null,
        tipo_pago: c.tipo_pago,
        plazo_dias: c.plazo_dias,
        items: [],
        total: 0,
        comprobante: false,
        anulada: c.estado === "anulada",
        estado_recepcion: "pendiente",
        unidades_pedidas: 0,
        unidades_recibidas: 0,
        productos_pendientes: 0,
        fecha_estimada: null,
        fecha_ultima_recepcion: null,
      };
      map.set(key, g);
    }
    g.items.push(c);
    g.total += Number(c.total) || 0;
    if (c.comprobante_storage_path) g.comprobante = true;
    if (c.estado === "anulada") g.anulada = true;

    // Progreso de recepción.
    const pedida = Number(c.cantidad) || 0;
    const recibida = Number(c.cantidad_recibida ?? 0) || 0;
    g.unidades_pedidas += pedida;
    g.unidades_recibidas += recibida;
    if (pedida - recibida > 0) g.productos_pendientes += 1;
    // La fecha estimada más próxima manda.
    if (c.fecha_estimada_llegada) {
      g.fecha_estimada =
        g.fecha_estimada && g.fecha_estimada < c.fecha_estimada_llegada
          ? g.fecha_estimada
          : c.fecha_estimada_llegada;
    }
    if (c.fecha_ultima_recepcion) {
      g.fecha_ultima_recepcion =
        g.fecha_ultima_recepcion && g.fecha_ultima_recepcion > c.fecha_ultima_recepcion
          ? g.fecha_ultima_recepcion
          : c.fecha_ultima_recepcion;
    }
  }
  for (const g of map.values()) g.estado_recepcion = estadoOrdenDesdeLineas(g.items);
  return [...map.values()].sort(
    (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime()
  );
}

function resumenProductos(items: Compra[]): string {
  if (items.length === 0) return "—";
  if (items.length === 1) return items[0].producto_nombre;
  return `${items[0].producto_nombre} + ${items.length - 1} más`;
}

export default function ComprasPage() {
  const [todas, setTodas] = useState<Compra[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [filtroTipoPago, setFiltroTipoPago] = useState<TipoPago | "">("");
  const [expandidos, setExpandidos] = useState<Set<string>>(new Set());
  const [anularTarget, setAnularTarget] = useState<{ numero: string; proveedor: string } | null>(null);
  const [filtroRecepcion, setFiltroRecepcion] = useState<EstadoRecepcion | "">("");
  const [recepcionTarget, setRecepcionTarget] = useState<string | null>(null);

  async function recargar() {
    const data = await getCompras();
    setTodas(data);
  }

  useEffect(() => {
    let cancel = false;
    getCompras().then((data) => {
      if (cancel) return;
      setTodas(data);
    });
    return () => { cancel = true; };
  }, []);

  const grupos = useMemo(() => agrupar(todas), [todas]);

  const filtrados = useMemo(() => {
    const texto = busqueda.toLowerCase().trim();
    return grupos.filter((g) => {
      const coincideTexto =
        texto === "" ||
        g.proveedor_nombre.toLowerCase().includes(texto) ||
        g.numero_control.toLowerCase().includes(texto) ||
        g.items.some((i) => i.producto_nombre.toLowerCase().includes(texto));
      const coincideTipoPago = filtroTipoPago === "" || g.tipo_pago === filtroTipoPago;
      if (filtroRecepcion !== "" && g.estado_recepcion !== filtroRecepcion) return false;
      return coincideTexto && coincideTipoPago;
    });
  }, [grupos, busqueda, filtroTipoPago, filtroRecepcion]);

  const hayFiltros = busqueda || filtroTipoPago || filtroRecepcion;

  function toggle(numero: string) {
    setExpandidos((prev) => {
      const next = new Set(prev);
      if (next.has(numero)) next.delete(numero);
      else next.add(numero);
      return next;
    });
  }

  return (
    <div className="space-y-8">

      <div>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[#4FAEB2]"
            style={{ boxShadow: "0 0 0 3px rgba(79, 174, 178, 0.18)" }} />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#4FAEB2]">Zentra · Adquisiciones</p>
        </div>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Compras</h1>
        <p className="mt-0.5 text-xs text-slate-500">Registro de órdenes de compra a proveedores</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm ring-1 ring-[#4FAEB2]/15 sm:p-5 lg:p-6">

        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Órdenes de compra</h2>
          <div className="flex items-center gap-3">
            <ExportExcelButton url="/api/compras/export" />
            <Link href="/compras/nueva"
              className="rounded-lg bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-[#4FAEB2]/25 transition-colors hover:bg-[#3F8E91] active:scale-95">
              + Nueva compra
            </Link>
          </div>
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap items-center gap-3 mb-5 pb-5 border-b border-gray-100">
          <input type="text" placeholder="Buscar por proveedor, producto o N° control..."
            value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
            className={`${inputFilterClass} min-w-0 flex-1 sm:min-w-72`} />
          <FancySelect value={filtroTipoPago} onChange={(v) => setFiltroTipoPago(v as TipoPago | "")}
            ariaLabel="Filtrar por tipo de pago" className="w-44" size="sm"
            options={[
              { value: "", label: "Todos los pagos" },
              { value: "contado", label: "Contado" },
              { value: "credito", label: "Crédito" },
            ]} />
          <FancySelect value={filtroRecepcion} onChange={(v) => setFiltroRecepcion(v as EstadoRecepcion | "")}
            ariaLabel="Filtrar por estado de recepción" className="w-48" size="sm"
            options={[
              { value: "", label: "Toda recepción" },
              { value: "pendiente", label: "Pendientes" },
              { value: "parcial", label: "Parciales" },
              { value: "completa", label: "Completas" },
              { value: "cancelada", label: "Canceladas" },
            ]} />
          {hayFiltros && (
            <button onClick={() => { setBusqueda(""); setFiltroTipoPago(""); setFiltroRecepcion(""); }}
              className="text-sm text-gray-400 hover:text-gray-600 transition-colors px-2">
              Limpiar filtros
            </button>
          )}
          <span className="ml-auto text-sm text-gray-400">
            {filtrados.length} de {grupos.length} compras
          </span>
        </div>

        {/* Tabla agrupada por compra */}
        <EdgeScrollArea>
          <table className="w-full min-w-[960px] lg:min-w-0 text-left text-sm">
            <thead>
              <tr className="border-b text-gray-500">
                <th className="py-3 pr-4 font-medium">N° Control</th>
                <th className="py-3 pr-4 font-medium">Proveedor</th>
                <th className="py-3 pr-4 font-medium">Productos</th>
                <th className="py-3 pr-4 font-medium text-right">Ítems</th>
                <th className="py-3 pr-4 font-medium">Recepción</th>
                <th className="py-3 pr-4 font-medium text-right">Total</th>
                <th className="hidden py-3 pr-4 font-medium lg:table-cell">Pago</th>
                <th className="hidden py-3 pr-4 font-medium lg:table-cell">Método</th>
                <th className="py-3 pr-4 font-medium">Fecha</th>
                <th className="hidden py-3 pr-4 font-medium lg:table-cell">Fecha factura</th>
                <th className="py-3 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody>
              {filtrados.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-12 text-center text-gray-400">
                    {grupos.length === 0 ? "No hay compras registradas" : "Ninguna compra coincide con los filtros"}
                  </td>
                </tr>
              ) : (
                filtrados.map((g) => {
                  const abierto = expandidos.has(g.numero_control);
                  const multi = g.items.length > 1;
                  return (
                    <FragmentRow key={g.numero_control}>
                      <tr
                        className={`border-b border-slate-200 transition-colors hover:bg-[#4FAEB2]/[0.04] ${multi ? "cursor-pointer" : ""} ${g.anulada ? "opacity-60" : ""}`}
                        onClick={() => multi && toggle(g.numero_control)}
                      >
                        <td className={`py-4 pr-4 font-mono text-xs ${g.anulada ? "line-through text-gray-400" : "text-gray-500"}`}>
                          {multi && <span className="mr-1 inline-block text-gray-400">{abierto ? "▾" : "▸"}</span>}
                          {g.numero_control}
                        </td>
                        <td className="py-4 pr-4 font-medium text-gray-800">
                          <div className="flex items-center gap-2">
                            <span className={g.anulada ? "line-through" : ""}>{g.proveedor_nombre}</span>
                            {g.anulada && (
                              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold bg-rose-50 text-rose-700 ring-1 ring-rose-200">
                                Anulada
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-4 pr-4 text-gray-600">
                          <div>{resumenProductos(g.items)}</div>
                          {g.comprobante && (
                            <a
                              href={`/api/compras/comprobante?numero_control=${encodeURIComponent(g.numero_control)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-[#4FAEB2] hover:text-[#3F8E91] hover:underline"
                            >
                              📎 Ver comprobante
                            </a>
                          )}
                        </td>
                        <td className="py-4 pr-4 text-right tabular-nums text-gray-700">{g.items.length}</td>
                        <td className="py-4 pr-4">
                          <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${RECEPCION_META[g.estado_recepcion].badge}`}>
                            {RECEPCION_META[g.estado_recepcion].label}
                          </span>
                          {g.estado_recepcion !== "cancelada" && (
                            <p className="mt-1 text-[11px] tabular-nums text-slate-400">
                              {g.unidades_recibidas} de {g.unidades_pedidas} u
                              {g.productos_pendientes > 0 && ` · ${g.productos_pendientes} pend.`}
                            </p>
                          )}
                          {g.fecha_estimada && g.estado_recepcion !== "completa" && (
                            <p className="text-[11px] text-slate-400">Estimada: {formatFechaDate(g.fecha_estimada)}</p>
                          )}
                          {g.fecha_ultima_recepcion && (
                            <p className="text-[11px] text-slate-400">Últ. recepción: {formatFechaDate(g.fecha_ultima_recepcion.slice(0, 10))}</p>
                          )}
                        </td>
                        <td className={`py-4 pr-4 text-right tabular-nums font-semibold ${g.anulada ? "line-through text-gray-500" : "text-gray-800"}`}>{formatGs(g.total)}</td>
                        <td className="hidden py-4 pr-4 lg:table-cell">
                          <span className={`px-2 py-1 rounded-full text-xs font-semibold ${g.tipo_pago ? tipoPagoBadge[g.tipo_pago] : "bg-gray-100 text-gray-500"}`}>
                            {g.tipo_pago === "contado" ? "Contado" : g.tipo_pago === "credito" ? `Crédito ${g.plazo_dias ?? ""}d` : "—"}
                          </span>
                        </td>
                        <td className="hidden py-4 pr-4 lg:table-cell">
                          {g.metodo_pago && metodoPagoBadge[g.metodo_pago] ? (
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-semibold ${metodoPagoBadge[g.metodo_pago].className}`}
                            >
                              {metodoPagoBadge[g.metodo_pago].label}
                            </span>
                          ) : (
                            <span className="text-gray-400 text-xs">—</span>
                          )}
                        </td>
                        <td className="py-4 pr-4 text-gray-500 text-xs tabular-nums">{formatFecha(g.fecha)}</td>
                        <td className="hidden py-4 pr-4 text-gray-500 text-xs tabular-nums lg:table-cell">
                          {formatFechaDate(g.fecha_factura)}
                        </td>
                        <td className="py-4 text-right">
                          {!g.anulada && g.estado_recepcion !== "completa" && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRecepcionTarget(g.numero_control);
                              }}
                              className="mr-2 inline-flex items-center justify-center rounded-md bg-[#4FAEB2] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#3F8E91]"
                              title="Registrar la mercadería recibida de esta orden"
                            >
                              Registrar recepción
                            </button>
                          )}
                          {!g.anulada && g.estado_recepcion !== "pendiente" && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRecepcionTarget(g.numero_control);
                              }}
                              className="mr-2 inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
                              title="Ver el historial de recepciones"
                            >
                              Ver recepciones
                            </button>
                          )}
                          {!g.anulada && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAnularTarget({ numero: g.numero_control, proveedor: g.proveedor_nombre });
                              }}
                              className="inline-flex items-center justify-center rounded-md border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 transition-colors"
                              title="Anular esta compra (reintegra stock en reverso)"
                            >
                              Anular
                            </button>
                          )}
                        </td>
                      </tr>

                      {abierto && multi && g.items.map((it) => (
                        <tr key={it.id} className="border-b border-slate-100 bg-slate-50/50 text-xs">
                          <td className="py-2 pr-4" />
                          <td className="py-2 pr-4" />
                          <td className="py-2 pr-4 text-gray-700">
                            <span className="font-medium">{it.producto_nombre}</span>
                            <span className="ml-2 font-mono text-gray-400">{formatGs(it.costo_unitario)}/u</span>
                          </td>
                          <td className="py-2 pr-4 text-right tabular-nums text-gray-600">{it.cantidad}</td>
                          <td className="py-2 pr-4 text-right tabular-nums text-gray-700">{formatGs(it.total)}</td>
                          <td className="hidden lg:table-cell" />
                          <td className="hidden lg:table-cell" />
                          <td />
                          <td className="hidden lg:table-cell" />
                          <td />
                        </tr>
                      ))}
                    </FragmentRow>
                  );
                })
              )}
            </tbody>
          </table>
        </EdgeScrollArea>

      </div>

      <MobileFab href="/compras/nueva" label="Nueva compra" />

      {recepcionTarget && (
        <RegistrarRecepcionModal
          numeroControl={recepcionTarget}
          open={!!recepcionTarget}
          onClose={() => setRecepcionTarget(null)}
          onRecepcionRegistrada={() => { void recargar(); }}
        />
      )}

      {anularTarget && (
        <AnularCompraModal
          numeroControl={anularTarget.numero}
          proveedorNombre={anularTarget.proveedor}
          onClose={() => setAnularTarget(null)}
          onAnulada={() => {
            setAnularTarget(null);
            void recargar();
          }}
        />
      )}
    </div>
  );
}

/** Wrapper para agrupar fila principal + filas de detalle sin <div> en <tbody>. */
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
