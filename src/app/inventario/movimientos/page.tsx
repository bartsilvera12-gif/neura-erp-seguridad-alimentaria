"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowDownLeft,
  ArrowUpRight,
  SlidersHorizontal,
  Search,
  X,
  Plus,
  PackageSearch,
  Layers,
} from "lucide-react";
import { getMovimientos } from "@/lib/inventario/storage";
import { formatFechaHoraAsuncion } from "@/lib/fecha/asuncion";
import { productoMatchesQuery } from "@/lib/productos/token-search";
import type { MovimientoInventario, TipoMovimiento, OrigenMovimiento } from "@/lib/inventario/types";

const origenLabel: Record<OrigenMovimiento, string> = {
  compra: "Compra",
  venta: "Venta",
  ajuste_manual: "Ajuste manual",
  inventario_inicial: "Inventario inicial",
  anulacion_venta: "Anulación de venta",
  anulacion_compra: "Anulación de compra",
  produccion: "Producción",
};

const origenBadge: Record<OrigenMovimiento, string> = {
  compra: "bg-sky-50 text-sky-700",
  venta: "bg-violet-50 text-violet-700",
  ajuste_manual: "bg-slate-100 text-slate-600",
  inventario_inicial: "bg-amber-50 text-amber-700",
  anulacion_venta: "bg-pink-50 text-pink-700",
  anulacion_compra: "bg-rose-50 text-rose-700",
  produccion: "bg-emerald-50 text-emerald-700",
};

/** Cada tipo define ícono, colores y signo — el color acá es semántica, no adorno. */
const TIPO_META: Record<
  TipoMovimiento,
  { label: string; Icon: typeof ArrowDownLeft; chip: string; texto: string; badge: string }
> = {
  ENTRADA: {
    label: "Entrada",
    Icon: ArrowDownLeft,
    chip: "bg-emerald-50 text-emerald-600",
    texto: "text-emerald-600",
    badge: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100",
  },
  SALIDA: {
    label: "Salida",
    Icon: ArrowUpRight,
    chip: "bg-red-50 text-red-600",
    texto: "text-red-600",
    badge: "bg-red-50 text-red-700 ring-1 ring-red-100",
  },
  AJUSTE: {
    label: "Ajuste",
    Icon: SlidersHorizontal,
    chip: "bg-amber-50 text-amber-600",
    texto: "text-amber-600",
    badge: "bg-amber-50 text-amber-700 ring-1 ring-amber-100",
  },
};

function formatGs(valor: number) {
  return `Gs. ${Math.round(valor).toLocaleString("es-PY")}`;
}

/** Del email/nombre del usuario deja algo corto y legible para la fila. */
function nombreCorto(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  if (!s) return "—";
  const local = s.includes("@") ? s.split("@")[0] : s;
  return local.replace(/[._-]+/g, " ");
}

function iniciales(v: string | null | undefined): string {
  const s = nombreCorto(v);
  if (s === "—") return "?";
  const partes = s.split(/\s+/).filter(Boolean);
  return ((partes[0]?.[0] ?? "") + (partes[1]?.[0] ?? "")).toUpperCase() || "?";
}

const inputClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition-shadow duration-150 placeholder:text-slate-400 focus:border-[#4FAEB2] focus:ring-2 focus:ring-[#4FAEB2]/20";
const btnPrimario =
  "inline-flex items-center gap-2 rounded-lg bg-[#4FAEB2] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-[transform,background-color] duration-150 ease-out hover:bg-[#3F8E91] active:scale-[0.97]";
const btnSecundario =
  "inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition-[transform,background-color] duration-150 ease-out hover:bg-slate-50 active:scale-[0.97]";

type FiltroTipo = TipoMovimiento | "";

export default function MovimientosPage() {
  const [todos, setTodos] = useState<MovimientoInventario[]>([]);
  const [cargando, setCargando] = useState(true);

  const [busqueda, setBusqueda] = useState("");
  const [filtroTipo, setFiltroTipo] = useState<FiltroTipo>("");
  const [filtroOrigen, setFiltroOrigen] = useState<OrigenMovimiento | "">("");
  const [fechaDesde, setFechaDesde] = useState("");
  const [fechaHasta, setFechaHasta] = useState("");

  useEffect(() => {
    let cancelled = false;
    getMovimientos()
      .then((data) => { if (!cancelled) setTodos(data); })
      .finally(() => { if (!cancelled) setCargando(false); });
    return () => { cancelled = true; };
  }, []);

  const filtrados = useMemo(() => {
    return todos.filter((m) => {
      // Búsqueda por tokens: palabras en cualquier orden y sin importar acentos.
      if (!productoMatchesQuery(busqueda, m.producto_nombre, m.producto_sku)) return false;
      if (filtroTipo !== "" && m.tipo !== filtroTipo) return false;
      if (filtroOrigen !== "" && m.origen !== filtroOrigen) return false;
      const fechaMov = m.fecha.slice(0, 10);
      if (fechaDesde !== "" && fechaMov < fechaDesde) return false;
      if (fechaHasta !== "" && fechaMov > fechaHasta) return false;
      return true;
    });
  }, [todos, busqueda, filtroTipo, filtroOrigen, fechaDesde, fechaHasta]);

  /** Resumen sobre lo filtrado: acompaña lo que el usuario está mirando. */
  const resumen = useMemo(() => {
    let entradas = 0, salidas = 0, ajustes = 0, valor = 0;
    for (const m of filtrados) {
      const abs = Math.abs(m.cantidad);
      if (m.tipo === "ENTRADA") entradas += abs;
      else if (m.tipo === "SALIDA") salidas += abs;
      else ajustes += 1;
      valor += abs * (m.costo_unitario ?? 0);
    }
    return { entradas, salidas, ajustes, valor };
  }, [filtrados]);

  const hayFiltros = !!(busqueda || filtroTipo || filtroOrigen || fechaDesde || fechaHasta);

  function limpiar() {
    setBusqueda("");
    setFiltroTipo("");
    setFiltroOrigen("");
    setFechaDesde("");
    setFechaHasta("");
  }

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
          <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
            Movimientos de inventario
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Entradas, salidas y ajustes de stock · se generan automáticamente desde Compras y Ventas
          </p>
        </div>

        <Link href="/inventario/movimientos/nuevo" className={btnPrimario}>
          <Plus className="h-4 w-4" />
          Nuevo movimiento
        </Link>
      </div>

      {/* Resumen: además de informar, filtra por tipo */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {([
          { id: "ENTRADA" as const, label: "Entradas", valor: resumen.entradas, sub: "unidades" },
          { id: "SALIDA" as const, label: "Salidas", valor: resumen.salidas, sub: "unidades" },
          { id: "AJUSTE" as const, label: "Ajustes", valor: resumen.ajustes, sub: "movimientos" },
        ]).map((t) => {
          const meta = TIPO_META[t.id];
          const activo = filtroTipo === t.id;
          const Icon = meta.Icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setFiltroTipo(activo ? "" : t.id)}
              aria-pressed={activo}
              className={`group rounded-xl border bg-white p-3.5 text-left shadow-sm transition-[transform,border-color,box-shadow] duration-150 ease-out active:scale-[0.98] ${
                activo ? "border-[#4FAEB2] ring-2 ring-[#4FAEB2]/20" : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                  {t.label}
                </p>
                <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${meta.chip}`}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
              </div>
              <p className={`mt-1 text-2xl font-bold tracking-tight tabular-nums ${meta.texto}`}>
                {t.valor}
              </p>
              <p className="text-[11px] text-slate-400">{t.sub}</p>
            </button>
          );
        })}

        <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Valor movido
            </p>
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#4FAEB2]/12 text-[#3F8E91]">
              <Layers className="h-3.5 w-3.5" />
            </span>
          </div>
          <p className="mt-1 truncate text-2xl font-bold tracking-tight tabular-nums text-slate-900">
            {formatGs(resumen.valor)}
          </p>
          <p className="text-[11px] text-slate-400">cantidad × costo</p>
        </div>
      </div>

      {/* Filtros */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div className="relative lg:col-span-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar por producto o SKU…"
              className={`${inputClass} pl-9`}
            />
          </div>
          <select
            value={filtroTipo}
            onChange={(e) => setFiltroTipo(e.target.value as FiltroTipo)}
            className={inputClass}
          >
            <option value="">Todos los tipos</option>
            <option value="ENTRADA">Entrada</option>
            <option value="SALIDA">Salida</option>
            <option value="AJUSTE">Ajuste</option>
          </select>
          <select
            value={filtroOrigen}
            onChange={(e) => setFiltroOrigen(e.target.value as OrigenMovimiento | "")}
            className={inputClass}
          >
            <option value="">Todos los orígenes</option>
            {(Object.keys(origenLabel) as OrigenMovimiento[]).map((o) => (
              <option key={o} value={o}>{origenLabel[o]}</option>
            ))}
          </select>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3">
          <div className="flex items-center gap-2">
            <label htmlFor="desde" className="text-xs font-medium text-slate-500">Desde</label>
            <input
              id="desde"
              type="date"
              value={fechaDesde}
              onChange={(e) => setFechaDesde(e.target.value)}
              max={fechaHasta || undefined}
              className={`${inputClass} w-auto`}
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="hasta" className="text-xs font-medium text-slate-500">Hasta</label>
            <input
              id="hasta"
              type="date"
              value={fechaHasta}
              onChange={(e) => setFechaHasta(e.target.value)}
              min={fechaDesde || undefined}
              className={`${inputClass} w-auto`}
            />
          </div>

          <span className="ml-auto text-xs text-slate-400">
            {filtrados.length === todos.length
              ? `${todos.length} movimiento${todos.length === 1 ? "" : "s"}`
              : `${filtrados.length} de ${todos.length}`}
          </span>

          {hayFiltros && (
            <button type="button" onClick={limpiar} className={btnSecundario}>
              <X className="h-3.5 w-3.5" />
              Limpiar
            </button>
          )}
        </div>
      </div>

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
                <div className="h-6 w-20 animate-pulse rounded-full bg-slate-100" />
              </div>
            ))}
          </div>
        ) : filtrados.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[#4FAEB2]/10">
              <PackageSearch className="h-5 w-5 text-[#4FAEB2]" />
            </div>
            {hayFiltros ? (
              <>
                <p className="text-sm font-semibold text-slate-900">Sin resultados</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                  Ningún movimiento coincide con los filtros elegidos.
                </p>
                <button type="button" onClick={limpiar} className={`mt-4 ${btnSecundario}`}>
                  Limpiar filtros
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-900">Todavía no hay movimientos</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
                  Se registran solos al comprar o vender. También podés cargar un ajuste manual.
                </p>
                <Link href="/inventario/movimientos/nuevo" className={`mt-4 ${btnPrimario}`}>
                  <Plus className="h-4 w-4" />
                  Nuevo movimiento
                </Link>
              </>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {filtrados.map((m, i) => {
              const meta = TIPO_META[m.tipo];
              const Icon = meta.Icon;
              const signo = m.tipo === "ENTRADA" ? "+" : m.tipo === "SALIDA" ? "−" : m.cantidad >= 0 ? "+" : "−";
              const total = Math.abs(m.cantidad) * (m.costo_unitario ?? 0);
              return (
                <li
                  key={m.id}
                  className="zentra-row-in flex items-center gap-4 px-5 py-3.5 transition-colors duration-150 hover:bg-slate-50/70"
                  style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${meta.chip}`}>
                    <Icon className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="truncate text-sm font-semibold text-slate-900">{m.producto_nombre}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${meta.badge}`}>
                        {meta.label}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${origenBadge[m.origen]}`}>
                        {origenLabel[m.origen]}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-400">
                      <span className="font-mono">{m.producto_sku}</span>
                      {" · "}
                      {formatFechaHoraAsuncion(m.fecha)}
                    </p>
                  </div>

                  {/* Usuario: iniciales para no cargar la fila con el email entero */}
                  <div
                    className="hidden shrink-0 items-center gap-2 lg:flex"
                    title={m.usuario_nombre ?? "Sin usuario"}
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 text-[10px] font-bold text-slate-500">
                      {iniciales(m.usuario_nombre)}
                    </span>
                    <span className="max-w-[120px] truncate text-xs capitalize text-slate-500">
                      {nombreCorto(m.usuario_nombre)}
                    </span>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className={`text-base font-bold tabular-nums ${meta.texto}`}>
                      {signo}{Math.abs(m.cantidad)}
                    </p>
                    <p className="text-[11px] text-slate-400 tabular-nums">
                      {formatGs(m.costo_unitario)} c/u
                    </p>
                  </div>

                  <div className="hidden w-28 shrink-0 text-right md:block">
                    <p className="text-sm font-semibold tabular-nums text-slate-700">{formatGs(total)}</p>
                    <p className="text-[11px] text-slate-400">total</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
